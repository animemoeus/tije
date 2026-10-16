import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MlMap,
} from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
// maplibre resolves its worker next to its own module, which breaks once Vite
// pre-bundles it; let Vite bundle the worker and hand maplibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { API } from '#/api'
import { BusInfo } from './BusInfo'

const WS = API.replace(/^http/, 'ws')

// Route types shown until the user picks others, in the API's /route-types order.
export const DEFAULT_TYPES = ['BRT', 'Angkutan Umum Integrasi']

type Route = {
  route_code: string
  route_name: string
  route_color: string
  directions: Array<{
    trip_id: string | null
    headsign: string | null
    path: Array<[number, number]>
  }>
}
type RouteType = { type: string; routes: number }
type Bus = {
  bus_body_no: string
  route_code: string
  trip_id: string | null
  trip_headsign: string
  route_color: string
  route_text_color: string
  type: string
  latitude: number
  longitude: number
  bearing: number
  next_stop_name: string
}

// Heading arrows fade in between these zooms. Measured on 3,564 live buses
// within 20 km (bus stacks at pools and haltes merged): at zoom 14 nearby
// buses sit ~22 px apart, so the 20 px circles stop overlapping, and at 14.5
// they're ~31 px apart, enough room for an arrow between two buses. Further
// out the arrows would only pile up on top of each other.
const ARROW_ZOOM = [14, 14.5]
// Same measurement: at 13 buses are ~11 px apart, so full circles would pile
// up. Below LABEL_ZOOM[0] buses are small dots; they grow to full circles by
// LABEL_ZOOM[1], where the circles separate, and the route code fades in over
// the last half zoom level.
const LABEL_ZOOM = [13, 14]
// Route lines stay faint so the buses on top stand out.
const ROUTE_OPACITY = 0.25
// While a bus is selected, everything except it and its route ahead fades to
// these.
const DIM_ROUTE_OPACITY = 0.08
const DIM_BUS_OPACITY = 0.15
// The route code fades in over the last half zoom level before LABEL_ZOOM[1].
const LABEL_FADE = [LABEL_ZOOM[1] - 0.5, LABEL_ZOOM[1]]
// How long the glow around a bus lasts after it reports a new GPS position.
const PING_MS = 1200
// Opacity of the glow when it starts; it fades to 0 from there.
const PING_OPACITY = 1
// Outer share of the glow's radius that fades out; inside it the colour is solid.
const PING_BLUR = 0.6

/**
 * Paint for the ping glows at time `now` (performance.now()): each glow grows
 * out of its bus and fades over PING_MS from the moment in its `t0`.
 */
function pingPaint(now: number) {
  const p: ExpressionSpecification = [
    'min',
    1,
    ['/', ['-', now, ['get', 't0']], PING_MS],
  ]
  return {
    radius: [
      'interpolate',
      ['linear'],
      ['zoom'],
      10,
      ['+', 2.5, ['*', p, 8]],
      LABEL_ZOOM[1],
      ['+', ['get', 'radius'], ['*', p, 16]],
    ] as ExpressionSpecification,
    opacity: ['*', PING_OPACITY, ['-', 1, p]] as ExpressionSpecification,
  }
}

/** Opacity going from 0 at zoom `from` to `full` at zoom `to`. */
function fadeIn(
  [from, to]: Array<number>,
  full: number | ExpressionSpecification = 1,
): ExpressionSpecification {
  return ['interpolate', ['linear'], ['zoom'], from, 0, to, full]
}

/**
 * Label, text size and circle radius (px) for a bus marker, so the label fits
 * inside the circle. Every Mikrotrans code starts with "JAK.", so the marker
 * drops it (JAK.43B shows as 43B); the full code stays in the popup. Bold
 * text is about 0.6em wide per character.
 */
function markerSize(code: string) {
  const label = code.replace(/^JAK\./, '')
  const textSize = label.length <= 3 ? 11 : 9
  const radius = Math.max(10, label.length * textSize * 0.3 + 4)
  return { label, textSize, radius }
}

/** One point per bus, with what the bus layers and the popup read. */
function busesToGeoJSON(buses: Array<Bus>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: buses.map((b) => ({
      type: 'Feature' as const,
      properties: {
        code: b.route_code,
        headsign: b.trip_headsign,
        no: b.bus_body_no,
        next: b.next_stop_name,
        color: `#${b.route_color || '555555'}`,
        textColor: `#${b.route_text_color || 'ffffff'}`,
        bearing: b.bearing,
        ...markerSize(b.route_code),
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [b.longitude, b.latitude],
      },
    })),
  }
}

/** One line per route direction, with the API's [lat, lon] flipped to [lon, lat]. */
function toGeoJSON(routes: Array<Route>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: routes.flatMap((r) =>
      r.directions.map((d) => ({
        type: 'Feature' as const,
        properties: {
          code: r.route_code,
          name: r.route_name,
          color: `#${r.route_color || '555555'}`,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: d.path.map(([lat, lon]) => [lon, lat]),
        },
      })),
    ),
  }
}

const KM_PER_DEG = 111.32

/**
 * The part of a bus's route still ahead of it, as [lon, lat] from the bus to
 * the end of its direction. The direction is the one with the bus's trip_id;
 * short trips have their own trip_id, so then the one with its headsign, and
 * failing that the one passing closest to the bus.
 */
function pathAhead(bus: Bus, routes: Array<Route>): Array<[number, number]> {
  const dirs =
    routes.find((r) => r.route_code === bus.route_code)?.directions ?? []
  // ponytail: plain degree distance to the nearest path point; fine at
  // Jakarta's latitude. A loop that runs the same road twice can be cut at
  // the wrong pass; next_stops would pick the right one.
  const nearest = (path: Array<[number, number]>) => {
    let best = { i: -1, d: Infinity }
    path.forEach(([lat, lon], i) => {
      const d = (lat - bus.latitude) ** 2 + (lon - bus.longitude) ** 2
      if (d < best.d) best = { i, d }
    })
    return best
  }
  const dir =
    dirs.find((d) => bus.trip_id && d.trip_id === bus.trip_id) ??
    dirs.find((d) => bus.trip_headsign && d.headsign === bus.trip_headsign) ??
    dirs.reduce<(typeof dirs)[number] | undefined>(
      (a, d) => (!a || nearest(d.path).d < nearest(a.path).d ? d : a),
      undefined,
    )
  if (!dir) return []
  const { i } = nearest(dir.path)
  return [
    [bus.longitude, bus.latitude],
    ...dir.path.slice(i + 1).map(([lat, lon]): [number, number] => [lon, lat]),
  ]
}

/** Box around every path point, widened by `km` on each side, as [[w, s], [e, n]]. */
function boundsAround(
  routes: Array<Route>,
  km: number,
): [[number, number], [number, number]] | null {
  const pts = routes.flatMap((r) => r.directions.flatMap((d) => d.path))
  if (!pts.length) return null
  const lats = pts.map(([lat]) => lat)
  const lons = pts.map(([, lon]) => lon)
  const [s, n] = [Math.min(...lats), Math.max(...lats)]
  const [w, e] = [Math.min(...lons), Math.max(...lons)]
  const dLat = km / KM_PER_DEG
  const dLon = km / (KM_PER_DEG * Math.cos((((s + n) / 2) * Math.PI) / 180))
  return [
    [w - dLon, s - dLat],
    [e + dLon, n + dLat],
  ]
}

/**
 * Chevron pointing north in the route colour with a white rim, drawn at 2x;
 * the map rotates it by bearing.
 */
function headingArrow(color: string) {
  const size = 24
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.beginPath()
  ctx.moveTo(6, 15)
  ctx.lineTo(12, 8)
  ctx.lineTo(18, 15)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 7
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  ctx.lineWidth = 3.5
  ctx.strokeStyle = color
  ctx.stroke()
  return ctx.getImageData(0, 0, size, size)
}

/**
 * Map of the routes of the chosen types with their live buses, and the side
 * panel that picks the types. An empty `types` means every route.
 */
export function RouteMap({
  types,
  onTypesChange,
}: {
  types: Array<string>
  onTypesChange: (types: Array<string>) => void
}) {
  // Effects depend on this string; the array is new on every render.
  const typeKey = types.join(',')
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const data = useRef(toGeoJSON([]))
  const routesRef = useRef<Array<Route>>([])
  const busData = useRef(busesToGeoJSON([]))
  // Body number -> performance.now() of its last new GPS report.
  const pings = useRef(new Map<string, number>())
  const pingFrame = useRef(0)
  // Start of the newest ring; the animation runs until it has faded.
  const pingLast = useRef(0)
  const [ready, setReady] = useState(false)
  const [typeList, setTypeList] = useState<Array<RouteType>>([])
  const [status, setStatus] = useState<'loading' | 'error' | 'done'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [count, setCount] = useState(0)
  const [routeCodes, setRouteCodes] = useState<Set<string>>(new Set())
  const [buses, setBuses] = useState<Array<Bus>>([])
  const [feed, setFeed] = useState<'connecting' | 'open' | 'closed'>(
    'connecting',
  )
  const [selectedBus, setSelectedBus] = useState<string | null>(null)
  // Phone tab bar: 'map' leaves the map clear, the others open their sheet.
  const [tab, setTab] = useState<'map' | 'filter' | 'info'>('map')
  // The server sends only the buses of the routes drawn. Sorted so the same
  // routes give the same URL and don't reconnect; no routes means no feed,
  // since a feed without ?routes would send every bus.
  const feedUrl = useMemo(() => {
    const codes = [...routeCodes].sort().join(',')
    return codes ? `${WS}/ws?routes=${encodeURIComponent(codes)}` : ''
  }, [routeCodes])

  // A new route filter may hide the selected bus, so close its card.
  useEffect(() => setSelectedBus(null), [typeKey])

  useEffect(() => {
    let cancelled = false
    void import('maplibre-gl').then(({ Map, Popup, setWorkerUrl }) => {
      if (cancelled || !container.current) return
      setWorkerUrl(workerUrl)
      const m = new Map({
        container: container.current,
        style: 'https://tiles.openfreemap.org/styles/positron',
        center: [106.8456, -6.2088],
        zoom: 11,
        attributionControl: false,
        // Keep north up: there's no compass to reset rotation, and the
        // heading arrows are placed for an unrotated map.
        dragRotate: false,
        pitchWithRotate: false,
      })
      m.touchZoomRotate.disableRotation()
      // Draw the arrow for each route colour the first time a bus needs it.
      // A resolver, since a styleimagemissing listener can't supply the image
      // for the request that fired it (maplibre then warns it's missing).
      m.setMissingStyleImageResolver((id) => {
        if (!id.startsWith('arrow-') || m.hasImage(id)) return
        m.addImage(id, headingArrow(id.slice('arrow-'.length)), {
          pixelRatio: 2,
        })
      })
      m.on('load', () => {
        // Positron is grey; give water and greenery their natural colours.
        m.setPaintProperty('water', 'fill-color', '#c4dbe7')
        m.setPaintProperty('waterway', 'line-color', '#c4dbe7')
        m.setPaintProperty('park', 'fill-color', '#dce8d5')
        m.setPaintProperty('landcover_wood', 'fill-color', '#cde0c4')
        m.addLayer(
          {
            id: 'landcover_grass',
            type: 'fill',
            source: 'openmaptiles',
            'source-layer': 'landcover',
            filter: [
              'in',
              ['get', 'class'],
              ['literal', ['grass', 'farmland']],
            ],
            paint: { 'fill-color': '#e2ecd8' },
          },
          'water',
        )
        m.addSource('routes', { type: 'geojson', data: data.current })
        m.addLayer({
          id: 'routes',
          type: 'line',
          source: 'routes',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 3,
            'line-opacity': ROUTE_OPACITY,
            // Lines cross-fade when the route filter changes.
            'line-opacity-transition': {
              duration: matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 0
                : 400,
            },
          },
        })
        // The selected bus's route from where it is to where it's going.
        m.addSource('focus', { type: 'geojson', data: toGeoJSON([]) })
        m.addLayer({
          id: 'route-ahead',
          type: 'line',
          source: 'focus',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 5 },
        })
        // A glow in the route colour that grows and fades around a bus when
        // it reports a new position: solid near the bus, fading to clear at
        // the edge (PING_BLUR), so it has no hard rim. It sits under the
        // buses so it seems to come out of them.
        m.addSource('pings', { type: 'geojson', data: busesToGeoJSON([]) })
        m.addLayer({
          id: 'bus-ping',
          type: 'circle',
          source: 'pings',
          paint: {
            'circle-color': ['get', 'color'],
            'circle-blur': PING_BLUR,
          },
        })
        m.addSource('buses', { type: 'geojson', data: busData.current })
        // Each bus is a circle in the route colour with its route code.
        // Zoomed out, buses are too close for that (see LABEL_ZOOM), so
        // they shrink to small dots and the code is hidden.
        m.addLayer({
          id: 'buses',
          type: 'circle',
          source: 'buses',
          paint: {
            'circle-radius': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              2.5,
              LABEL_ZOOM[0],
              5,
              LABEL_ZOOM[1],
              ['get', 'radius'],
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              10,
              0.75,
              LABEL_ZOOM[1],
              2,
            ],
            'circle-stroke-color': '#ffffff',
          },
        })
        m.addLayer({
          id: 'bus-label',
          type: 'symbol',
          source: 'buses',
          // Text waits until the circle is almost big enough to hold it.
          minzoom: LABEL_ZOOM[1] - 0.5,
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['get', 'textSize'],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': ['get', 'textColor'],
            'text-opacity': fadeIn(LABEL_FADE),
          },
        })
        m.addLayer({
          id: 'bus-heading',
          type: 'symbol',
          source: 'buses',
          minzoom: ARROW_ZOOM[0],
          layout: {
            'icon-image': ['concat', 'arrow-', ['get', 'color']],
            'icon-rotate': ['get', 'bearing'],
            'icon-rotation-alignment': 'map',
            // Just outside the circle, straight "up" from the bus; the map
            // turns it with icon-rotate. Built from a number because
            // maplibre turns array properties into JSON strings.
            'icon-offset': [
              'interpolate',
              ['linear'],
              ['+', ['get', 'radius'], 5],
              0,
              ['literal', [0, 0]],
              100,
              ['literal', [0, -100]],
            ],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
          paint: {
            'icon-opacity': fadeIn(ARROW_ZOOM),
          },
        })
        setReady(true)
      })
      const popup = (
        at: Parameters<InstanceType<typeof Popup>['setLngLat']>[0],
        title: string,
        body: string,
      ) => {
        const el = document.createElement('div')
        el.innerHTML = '<strong></strong><span></span>'
        el.querySelector('strong')!.textContent = title
        el.querySelector('span')!.textContent = body
        new Popup({ closeButton: false, maxWidth: '260px' })
          .setLngLat(at)
          .setDOMContent(el)
          .addTo(m)
      }
      m.on('click', 'routes', (e) => {
        // A click on a bus over a route belongs to the bus card only.
        if (m.queryRenderedFeatures(e.point, { layers: ['buses'] }).length)
          return
        const p = e.features?.[0]?.properties
        if (p) popup(e.lngLat, String(p.code), String(p.name))
      })
      m.on('click', 'buses', (e) => {
        const p = e.features?.[0]?.properties
        if (p) setSelectedBus(String(p.no))
      })
      // A click on the map closes an open sheet, and away from any bus
      // also the bus card.
      m.on('click', (e) => {
        setTab('map')
        if (!m.queryRenderedFeatures(e.point, { layers: ['buses'] }).length)
          setSelectedBus(null)
      })
      for (const layer of ['routes', 'buses']) {
        m.on(
          'mouseenter',
          layer,
          () => (m.getCanvas().style.cursor = 'pointer'),
        )
        m.on('mouseleave', layer, () => (m.getCanvas().style.cursor = ''))
      }
      map.current = m
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(pingFrame.current)
      map.current?.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    if (!feedUrl) return
    let ws: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const connect = () => {
      // Buses by body number for this connection only, so a reconnect
      // starts clean from the server's first snapshot.
      const fleet = new Map<string, Bus>()
      setFeed('connecting')
      ws = new WebSocket(feedUrl)
      ws.onopen = () => setFeed('open')
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as {
          type: string
          buses?: Array<Bus>
          upsert?: Array<Partial<Bus> & { bus_body_no: string }>
          remove?: Array<string>
        }
        if (msg.type === 'snapshot' && msg.buses) {
          // The first message of each connection.
          fleet.clear()
          for (const b of msg.buses) fleet.set(b.bus_body_no, b)
        } else if (msg.type === 'delta') {
          for (const no of msg.remove ?? []) fleet.delete(no)
          // New buses come whole; known ones only with the fields that changed.
          // latitude/longitude can move when the route snap changes;
          // raw_* change only when the bus itself reports a new position.
          for (const u of msg.upsert ?? []) {
            if (
              fleet.has(u.bus_body_no) &&
              ('raw_latitude' in u || 'raw_longitude' in u)
            )
              pings.current.set(u.bus_body_no, performance.now())
            fleet.set(u.bus_body_no, {
              ...fleet.get(u.bus_body_no),
              ...u,
            } as Bus)
          }
        } else return
        setBuses([...fleet.values()])
      }
      ws.onclose = () => {
        setFeed('closed')
        if (!closed) retry = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      ws?.close()
    }
  }, [feedUrl])

  // Only buses on the routes currently drawn.
  const shownBuses = useMemo(
    () => buses.filter((b) => routeCodes.has(b.route_code)),
    [buses, routeCodes],
  )

  useEffect(() => {
    busData.current = busesToGeoJSON(shownBuses)
    map.current?.getSource<GeoJSONSource>('buses')?.setData(busData.current)

    // Rings follow their bus, so they're rebuilt with every feed message.
    const m = map.current
    if (!m || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const now = performance.now()
    for (const [no, t0] of pings.current) {
      if (now - t0 >= PING_MS) pings.current.delete(no)
      else pingLast.current = Math.max(pingLast.current, t0)
    }
    const rings = busesToGeoJSON(
      shownBuses.filter((b) => pings.current.has(b.bus_body_no)),
    )
    for (const f of rings.features)
      f.properties!.t0 = pings.current.get(f.properties!.no)
    m.getSource<GeoJSONSource>('pings')?.setData(rings)
    if (!rings.features.length || pingFrame.current) return
    // Animate only while a ring is still growing, so an idle map stays idle.
    const tick = (t: number) => {
      const { radius, opacity } = pingPaint(t)
      m.setPaintProperty('bus-ping', 'circle-radius', radius)
      m.setPaintProperty('bus-ping', 'circle-opacity', opacity)
      pingFrame.current =
        t - pingLast.current < PING_MS ? requestAnimationFrame(tick) : 0
    }
    pingFrame.current = requestAnimationFrame(tick)
  }, [shownBuses])

  const focusBus = shownBuses.find((b) => b.bus_body_no === selectedBus)
  const focusPath = useMemo(
    () => (focusBus ? pathAhead(focusBus, routesRef.current) : []),
    [focusBus],
  )
  // Read by the camera effect, which runs only when the selection changes.
  const focusRef = useRef({ bus: focusBus, path: focusPath })
  focusRef.current = { bus: focusBus, path: focusPath }

  // Draw the route ahead of the selected bus; it shortens as the bus moves.
  useEffect(() => {
    map.current?.getSource<GeoJSONSource>('focus')?.setData({
      type: 'FeatureCollection',
      features:
        focusBus && focusPath.length > 1
          ? [
              {
                type: 'Feature',
                properties: { color: `#${focusBus.route_color || '555555'}` },
                geometry: { type: 'LineString', coordinates: focusPath },
              },
            ]
          : [],
    })
  }, [focusBus, focusPath])

  // Fade every other route and bus while one is selected, and bring the bus
  // and the rest of its trip into view.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const on: ExpressionSpecification = ['==', ['get', 'no'], selectedBus ?? '']
    const dim: number | ExpressionSpecification = selectedBus
      ? ['case', on, 1, DIM_BUS_OPACITY]
      : 1
    m.setPaintProperty(
      'routes',
      'line-opacity',
      selectedBus ? DIM_ROUTE_OPACITY : ROUTE_OPACITY,
    )
    m.setPaintProperty('buses', 'circle-opacity', dim)
    m.setFilter('bus-ping', selectedBus ? on : null)
    m.setPaintProperty('buses', 'circle-stroke-opacity', dim)
    m.setPaintProperty('bus-label', 'text-opacity', fadeIn(LABEL_FADE, dim))
    m.setPaintProperty('bus-heading', 'icon-opacity', fadeIn(ARROW_ZOOM, dim))
    // The selected bus is drawn last, on top of the others.
    const top: ExpressionSpecification | undefined = selectedBus
      ? ['case', on, 1, 0]
      : undefined
    m.setLayoutProperty('buses', 'circle-sort-key', top)
    m.setLayoutProperty('bus-label', 'symbol-sort-key', top)
    m.setLayoutProperty('bus-heading', 'symbol-sort-key', top)

    const { bus, path } = focusRef.current
    if (!bus) return
    // Keep clear of the BusInfo card: top left on desktop, bottom on phones.
    const desktop = matchMedia('(min-width: 768px)').matches
    const padding = desktop
      ? { top: 60, right: 60, bottom: 60, left: 380 }
      : { top: 40, right: 40, bottom: innerHeight * 0.45 + 56, left: 40 }
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : 600
    if (path.length > 1) {
      const lons = path.map(([lon]) => lon)
      const lats = path.map(([, lat]) => lat)
      m.fitBounds(
        [
          [Math.min(...lons), Math.min(...lats)],
          [Math.max(...lons), Math.max(...lats)],
        ],
        { padding, duration, maxZoom: 16 },
      )
    } else {
      m.easeTo({ center: [bus.longitude, bus.latitude], padding, duration })
    }
  }, [selectedBus, ready])

  useEffect(() => {
    fetch(`${API}/route-types`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d: { types: Array<RouteType> }) =>
        setTypeList(d.types.filter((t) => t.routes > 0)),
      )
      .catch(() => {})
  }, [attempt])

  useEffect(() => {
    if (!ready) return
    const ctrl = new AbortController()
    setStatus('loading')
    // Fade the old lines out while the new ones load.
    map.current?.setPaintProperty('routes', 'line-opacity', 0)
    const qs = typeKey ? `?type=${encodeURIComponent(typeKey)}` : ''
    fetch(`${API}/routes${qs}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d: { routes: Array<Route> }) => {
        data.current = toGeoJSON(d.routes)
        routesRef.current = d.routes
        const m = map.current
        m?.getSource<GeoJSONSource>('routes')?.setData(data.current)
        m?.setPaintProperty('routes', 'line-opacity', ROUTE_OPACITY)
        // Keep the map within 5 km of the routes shown instead of the world.
        const b = boundsAround(d.routes, 5)
        if (m && b) {
          m.setMaxBounds(b)
          m.fitBounds(b, { padding: 0, duration: 600 })
        }
        setCount(d.routes.length)
        setRouteCodes(new Set(d.routes.map((r) => r.route_code)))
        setStatus('done')
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus('error')
      })
    return () => ctrl.abort()
  }, [ready, typeKey, attempt])

  const focus =
    'outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'
  // Types whose routes are on the map; none chosen means all of them.
  const shown = types.length ? types : typeList.map((t) => t.type)
  const allShown = typeList.every((t) => shown.includes(t.type))
  /** Adds or drops one type; picking every type is the same as "all". */
  const toggleType = (t: string) => {
    const next = shown.includes(t)
      ? shown.filter((s) => s !== t)
      : typeList.map((x) => x.type).filter((x) => x === t || shown.includes(x))
    onTypesChange(next.length === typeList.length ? [] : next)
  }
  /** Hides a panel section on phones unless tab `t` is open. */
  const onTab = (t: typeof tab) => (tab === t ? '' : 'max-md:hidden')
  const chip = `flex min-h-11 cursor-pointer select-none items-center px-3 text-sm font-semibold transition-colors duration-150 bg-[var(--field)] text-[var(--ink)] hover:bg-[var(--ground)] has-[:checked]:bg-[var(--accent)] has-[:checked]:text-[var(--accent-ink)] has-[:disabled]:cursor-default has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent)]`

  return (
    <div className="relative h-full md:flex">
      {/* On phones the panel is a bottom sheet over a full-screen map that
          opens from the tab bar, one section per tab. */}
      <aside
        className={`rise-in sheet-up stagger absolute inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-10 flex max-h-[70dvh] flex-col gap-4 overflow-y-auto rounded-t-2xl bg-[var(--surface)] px-4 pb-5 pt-2 shadow-[0_-8px_24px_rgb(0_0_0/0.12)] md:static md:max-h-none md:w-80 md:shrink-0 md:gap-8 md:rounded-none md:p-6 md:shadow-none ${tab === 'map' ? 'max-md:hidden' : ''}`}
      >
        <div
          aria-hidden="true"
          className="mx-auto h-1 w-10 shrink-0 rounded-full bg-[var(--field)] md:hidden"
        />
        <h1 className="m-0 text-4xl font-extrabold leading-none tracking-tight max-md:hidden">
          Rute Transjakarta
        </h1>

        <fieldset className={`m-0 border-0 p-0 ${onTab('filter')}`}>
          <legend className="mb-3 text-base font-bold md:mb-2 md:text-sm md:font-medium md:text-[var(--ink-soft)]">
            Filter rute
          </legend>
          {/* Native checkboxes inside chips: they wrap to fit the small
              phone panel, and keyboard and screen readers work as usual. */}
          <div className="flex flex-wrap gap-2">
            <label className={chip}>
              <input
                type="checkbox"
                className="sr-only"
                checked={allShown}
                // Unticking "all" goes back to the default selection.
                onChange={() => onTypesChange(allShown ? DEFAULT_TYPES : [])}
              />
              Semua rute
            </label>
            {typeList.map((t) => {
              const on = shown.includes(t.type)
              return (
                <label key={t.type} className={chip}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    // The last ticked type stays; an empty choice would mean all.
                    disabled={on && shown.length === 1}
                    onChange={() => toggleType(t.type)}
                  />
                  {t.type}
                  <span className="ml-1.5 font-normal tabular-nums opacity-75">
                    {t.routes}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <div aria-live="polite" className={onTab('info')}>
          {status === 'error' ? (
            <div
              role="alert"
              className="fade-in flex flex-col items-start gap-3"
            >
              <p className="m-0">
                Gagal memuat rute. Pastikan tije-api berjalan di{' '}
                <code>{API}</code>.
              </p>
              <button
                type="button"
                onClick={() => setAttempt((a) => a + 1)}
                className={`h-12 cursor-pointer bg-[var(--accent)] px-5 font-bold text-[var(--accent-ink)] transition-transform duration-150 hover:brightness-110 active:scale-95 ${focus}`}
              >
                Coba lagi
              </button>
            </div>
          ) : (
            <>
              <p className="m-0 flex items-center gap-3">
                {status === 'loading' ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--field)] border-t-[var(--accent)] motion-reduce:animate-none"
                    />
                    <span className="font-semibold">Memuat rute…</span>
                  </>
                ) : (
                  <span
                    key={count}
                    className="fade-in flex items-baseline gap-2"
                  >
                    <span className="text-5xl font-extrabold leading-none tracking-tighter tabular-nums md:text-7xl">
                      {count}
                    </span>
                    <span className="font-semibold">rute di peta</span>
                  </span>
                )}
              </p>
              <p className="mb-0 mt-3 text-sm text-[var(--ink-soft)]">
                {status === 'done' && count === 0
                  ? 'Tidak ada rute untuk jenis ini. Pilih jenis lain.'
                  : 'Klik garis atau bus di peta untuk melihat detailnya.'}
              </p>
              <p className="mb-0 mt-5 text-base font-semibold">
                {feed === 'open'
                  ? `${shownBuses.length} bus aktif di rute ini`
                  : 'Menunggu data bus…'}
              </p>
            </>
          )}
        </div>
        <footer className={`flex flex-col gap-2 md:mt-auto ${onTab('info')}`}>
          <p className="m-0 text-[11px] leading-snug text-[var(--ink-soft)] [&_a]:text-[var(--ink-soft)] [&_a]:underline-offset-2 [&_a:hover]:text-[var(--ink)]">
            <a
              target="_blank"
              rel="noopener noreferrer"
              href="https://maplibre.org/"
            >
              MapLibre
            </a>{' '}
            ·{' '}
            <a
              target="_blank"
              rel="noopener noreferrer"
              href="https://openfreemap.org/"
            >
              OpenFreeMap
            </a>{' '}
            ·{' '}
            <a
              target="_blank"
              rel="noopener noreferrer"
              href="https://www.openmaptiles.org/"
            >
              ©&nbsp;OpenMapTiles
            </a>{' '}
            · Data dari{' '}
            <a
              target="_blank"
              rel="noopener noreferrer"
              href="https://www.openstreetmap.org/copyright"
            >
              OpenStreetMap
            </a>
          </p>
        </footer>
      </aside>

      {/* The fade sits here, not on the map container: maplibre adds its own
          classes there, and a changing className would wipe them. */}
      <div
        className={`relative h-full transition-opacity duration-500 motion-reduce:transition-none md:min-w-0 md:flex-1 ${ready ? 'opacity-100' : 'opacity-0'}`}
      >
        <div
          ref={container}
          // maplibre sets position: relative on its container, so size it
          // with h-full rather than absolute inset-0.
          className="h-full w-full"
          role="region"
          aria-label="Peta rute Transjakarta"
        />
        {selectedBus && (
          <BusInfo busNo={selectedBus} onClose={() => setSelectedBus(null)} />
        )}
      </div>

      {/* Phone status pill under the notch; the full status is in the Info tab. */}
      <div
        aria-hidden={status !== 'error'}
        className="fade-in absolute left-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-10 flex min-h-10 items-center gap-2 rounded-full bg-[var(--surface)] py-1 pl-4 pr-1.5 text-sm font-semibold shadow-md md:hidden"
      >
        {status === 'error' ? (
          <>
            <span>Gagal memuat rute</span>
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className={`h-8 cursor-pointer rounded-full bg-[var(--accent)] px-3 font-bold text-[var(--accent-ink)] active:scale-95 ${focus}`}
            >
              Coba lagi
            </button>
          </>
        ) : status === 'loading' ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--field)] border-t-[var(--accent)] motion-reduce:animate-none" />
            <span className="pr-2.5">Memuat rute…</span>
          </>
        ) : (
          <span className="pr-2.5 tabular-nums">
            {feed === 'open' && `${shownBuses.length} bus · `}
            <span className="text-[var(--ink-soft)]">{count} rute</span>
          </span>
        )}
      </div>

      {/* Live feed status, top right on every screen size. */}
      <p
        aria-live="polite"
        className="fade-in absolute right-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-10 m-0 flex min-h-10 items-center gap-2 rounded-full bg-[var(--surface)] px-4 text-sm font-semibold shadow-md"
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${
            feed === 'open'
              ? 'bg-emerald-500'
              : feed === 'closed'
                ? 'bg-red-500'
                : 'animate-pulse bg-amber-500 motion-reduce:animate-none'
          }`}
        />
        <span className="sr-only">Data bus: </span>
        <span>
          {feed === 'open'
            ? 'Terhubung'
            : feed === 'closed'
              ? 'Menyambung ulang…'
              : 'Menyambungkan…'}
        </span>
      </p>

      <nav
        role="tablist"
        aria-label="Menu"
        className="absolute inset-x-0 bottom-0 z-30 flex select-none border-t border-[var(--field)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {(
          [
            [
              'map',
              'Peta',
              'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
            ],
            ['filter', 'Rute', 'M4 6h16M7 12h10m-7 6h4'],
            [
              'info',
              'Info',
              'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v6m0-9.5v.5',
            ],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            // Tapping the open tab again closes its sheet. BusInfo closes
            // itself on any tap outside it, so tabs never sit under a card.
            onClick={() => setTab(tab === id ? 'map' : id)}
            className={`flex h-14 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 text-[11px] font-semibold transition-colors duration-150 ${tab === id ? 'text-[var(--accent)]' : 'text-[var(--ink-soft)]'} ${focus}`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={tab === id ? 2.25 : 1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={icon} />
            </svg>
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}
