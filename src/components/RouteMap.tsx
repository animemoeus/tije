import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ExpressionSpecification,
  GeoJSONSource,
  Map as MlMap,
  Marker,
} from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
// maplibre resolves its worker next to its own module, which breaks once Vite
// pre-bundles it; let Vite bundle the worker and hand maplibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { API, DEFAULT_TYPES } from '#/api'
import { DiscussionEmbed } from 'disqus-react'
import { BusInfo } from './BusInfo'

const WS = API.replace(/^http/, 'ws')

type Route = {
  route_code: string
  route_name: string
  route_color: string
  route_text_color: string
  directions: Array<{
    trip_id: string | null
    headsign: string | null
    path: Array<[number, number]>
  }>
}
type RouteType = { type: string; routes: number }
type Stop = {
  stop_id: string
  name: string
  lat: number
  lon: number
  type: string
  routes: Array<string>
}
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
// Bus stops show up from this zoom; there are thousands of them. BRT haltes
// are few, so they show at every zoom.
const BUS_STOP_ZOOM = 14
// Stop names appear from this zoom; BRT halte names from HALTE_LABEL_ZOOM.
const STOP_LABEL_ZOOM = 15
const HALTE_LABEL_ZOOM = 13
// Transjakarta blue (--accent in light mode) for BRT haltes and the open stop.
const HALTE_COLOR = '#0057b8'
// The user's dot and accuracy circle, Google Maps blue.
const USER_COLOR = '#1a73e8'
// Metres per pixel at zoom 0 on the equator, for maplibre's 512 px tiles.
const M_PER_PX_Z0 = 78271.517
// The route code fades in over the last half zoom level before LABEL_ZOOM[1].
const LABEL_FADE = [LABEL_ZOOM[1] - 0.5, LABEL_ZOOM[1]]
// How long the glow around a bus lasts after it reports a new GPS position.
const PING_MS = 1200
// How buses glide between reports, after the bus layer of transit.oyenza.com.
// A glide lasts one report interval of that bus (averaged, held between the
// min and max), so it arrives about when the next report does. Until a bus has
// an interval, it uses GLIDE_MS.
const GLIDE_MS = 3000
const GLIDE_MIN_MS = 1000
const GLIDE_MAX_MS = 5000
// Report gaps outside this range (ms) don't count towards the interval.
const GAP_RANGE = [400, 20000]
// A move farther than JUMP_M, or farther than 250 m at over JUMP_SPEED m/s,
// jumps instead of gliding: a new route snap or a bus back in the feed.
const JUMP_M = 1500
const JUMP_SPEED = 35
// A bus within SNAP_M of its route line glides along the line, so it takes
// the bends instead of cutting across them.
const SNAP_M = 40
// The heading arrow turns towards where the bus is going with this time
// constant (ms), so it swings round instead of snapping.
const TURN_MS = 150
// Opacity of the glow when it starts; it fades to 0 from there.
const PING_OPACITY = 1
// Outer share of the glow's radius that fades out; inside it the colour is solid.
const PING_BLUR = 0.6
// Speech bubble for the discussion tab and button.
const CHAT_ICON = 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z'

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

type Vec = [number, number]
/**
 * A bus moving along `path` ([lon, lat], from where it was drawn to its new
 * position) over `ms` from `t0`. `len` is the distance in metres from the
 * start to each point, `k` the cos(latitude) that scales longitude to metres,
 * `iv` the bus's averaged report interval, `h` the heading drawn and `moved`
 * whether it has ever glided.
 */
type Glide = {
  path: Array<Vec>
  len: Array<number>
  k: number
  t0: number
  ms: number
  iv: number
  h: number
  moved: boolean
}

const M_PER_DEG = 111320

/** Distance in metres between two [lon, lat] points `k` = cos(latitude) apart. */
function metres(a: Vec, b: Vec, k: number) {
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * M_PER_DEG
}

/**
 * The point of `line` ([lon, lat]) nearest to `p`: the segment it's on, how
 * far along the line that is and how far `p` is off it, in metres.
 */
function project(line: Array<Vec>, p: Vec, k: number) {
  let best = { i: 0, along: 0, off: Infinity }
  let run = 0
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = [line[i][0] * k, line[i][1]]
    const [dx, dy] = [line[i + 1][0] * k - ax, line[i + 1][1] - ay]
    const l2 = dx * dx + dy * dy
    const u = l2
      ? Math.min(1, Math.max(0, ((p[0] * k - ax) * dx + (p[1] - ay) * dy) / l2))
      : 0
    const off = Math.hypot(p[0] * k - ax - u * dx, p[1] - ay - u * dy)
    const seg = Math.sqrt(l2)
    if (off < best.off) best = { i, along: run + u * seg, off }
    run += seg
  }
  return {
    i: best.i,
    along: best.along * M_PER_DEG,
    off: best.off * M_PER_DEG,
  }
}

/**
 * The way from `at` to `to`: along the route `line` when both sit on it and
 * `to` is a believable distance ahead, otherwise straight.
 */
function glidePath(at: Vec, to: Vec, line: Array<Vec> | null, k: number) {
  if (line && line.length > 1) {
    const a = project(line, at, k)
    const b = project(line, to, k)
    const ahead = b.along - a.along
    if (
      a.off < SNAP_M &&
      b.off < SNAP_M &&
      ahead >= -10 &&
      ahead <= 3 * metres(at, to, k) + 120
    )
      return [at, ...line.slice(a.i + 1, b.i + 1), to]
  }
  return [at, to]
}

/**
 * Where a glide is at time `t` (performance.now()) and its heading there in
 * degrees, null once it has arrived. It moves at a steady pace: easing each
 * stretch would make the bus slow to a stop at every report and then rush.
 */
function glideAt(g: Glide, t: number): { at: Vec; heading: number | null } {
  const { path, len, k } = g
  const total = len[len.length - 1]
  const p = g.ms ? Math.min(1, Math.max(0, (t - g.t0) / g.ms)) : 1
  if (p >= 1 || total < 1.5) return { at: path[path.length - 1], heading: null }
  const d = p * total
  let i = 1
  while (i < len.length - 1 && len[i] < d) i++
  const [a, b] = [path[i - 1], path[i]]
  const u = len[i] > len[i - 1] ? (d - len[i - 1]) / (len[i] - len[i - 1]) : 1
  const heading = (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI
  return {
    at: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u],
    heading: (heading + 360) % 360,
  }
}

/** A glide along `path`, with the distances `glideAt` walks. */
function makeGlide(
  path: Array<Vec>,
  k: number,
  rest: Omit<Glide, 'path' | 'len' | 'k'>,
): Glide {
  const len = [0]
  for (let i = 1; i < path.length; i++)
    len.push(len[i - 1] + metres(path[i - 1], path[i], k))
  return { path, len, k, ...rest }
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

/** One point per stop; `halte` marks the BRT haltes, the rest are bus stops. */
function stopsToGeoJSON(stops: Array<Stop>): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: stops.map((s) => ({
      type: 'Feature' as const,
      properties: {
        name: s.name,
        routes: s.routes.join(','),
        halte: s.type === 'halte',
      },
      geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
    })),
  }
}

/** Popup content with a bold title over one line of text. */
function textCard(title: string, body: string) {
  const el = document.createElement('div')
  el.innerHTML = '<strong></strong><span></span>'
  el.querySelector('strong')!.textContent = title
  el.querySelector('span')!.textContent = body
  return el
}

/**
 * Popup content for a stop: what kind it is and how many routes stop there,
 * its name, and one chip per route code in that route's colours. Built with
 * textContent so API values never become markup.
 */
function stopCard(
  name: string,
  halte: boolean,
  codes: Array<string>,
  routes: Array<Route>,
) {
  const el = document.createElement('div')
  const kind = document.createElement('small')
  kind.className = 'stop-kind'
  kind.textContent = `${halte ? 'Halte BRT' : 'Halte bus'} · ${codes.length} rute`
  const title = document.createElement('strong')
  title.textContent = name
  const chips = document.createElement('ul')
  chips.className = 'stop-routes'
  chips.setAttribute('aria-label', 'Rute yang berhenti di sini')
  // Natural order, so 2 comes before 10 and 1A sits next to 1.
  const sorted = [...codes].sort((a, b) =>
    a.localeCompare(b, 'id', { numeric: true }),
  )
  for (const code of sorted) {
    const r = routes.find((x) => x.route_code === code)
    const chip = document.createElement('li')
    chip.textContent = code
    if (r) chip.title = r.route_name
    chip.style.background = `#${r?.route_color || '555555'}`
    chip.style.color = `#${r?.route_text_color || 'ffffff'}`
    chips.append(chip)
  }
  el.append(kind, title, chips)
  return el
}

const KM_PER_DEG = 111.32

/**
 * The part of a bus's route still ahead of it, as [lon, lat] from the bus to
 * the end of its direction (see busDirection).
 */
function pathAhead(bus: Bus, routes: Array<Route>): Array<[number, number]> {
  const dir = busDirection(bus, routes)
  if (!dir) return []
  const { i } = nearestPoint(dir.path, bus)
  return [
    [bus.longitude, bus.latitude],
    ...dir.path.slice(i + 1).map(([lat, lon]): [number, number] => [lon, lat]),
  ]
}

/**
 * The index of the point of `path` ([lat, lon]) nearest to the bus, and its
 * squared distance in degrees.
 */
function nearestPoint(path: Array<[number, number]>, bus: Bus) {
  // ponytail: plain degree distance to the nearest path point; fine at
  // Jakarta's latitude. A loop that runs the same road twice can be cut at
  // the wrong pass; next_stops would pick the right one.
  let best = { i: -1, d: Infinity }
  path.forEach(([lat, lon], i) => {
    const d = (lat - bus.latitude) ** 2 + (lon - bus.longitude) ** 2
    if (d < best.d) best = { i, d }
  })
  return best
}

/**
 * The direction of its route a bus is driving: the one with the bus's
 * trip_id; short trips have their own trip_id, so then the one with its
 * headsign, and failing that the one passing closest to the bus.
 */
function busDirection(bus: Bus, routes: Array<Route>) {
  const dirs =
    routes.find((r) => r.route_code === bus.route_code)?.directions ?? []
  const nearest = (path: Array<[number, number]>) => nearestPoint(path, bus)
  return (
    dirs.find((d) => bus.trip_id && d.trip_id === bus.trip_id) ??
    dirs.find((d) => bus.trip_headsign && d.headsign === bus.trip_headsign) ??
    dirs.reduce<(typeof dirs)[number] | undefined>(
      (a, d) => (!a || nearest(d.path).d < nearest(a.path).d ? d : a),
      undefined,
    )
  )
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
  // Body number -> the glide from where it was drawn to its latest position.
  const glides = useRef(new Map<string, Glide>())
  // The running animation frame for glides and rings, 0 when idle.
  const frame = useRef(0)
  // Time of the last frame drawn, for turning the heading arrows.
  const lastFrame = useRef(0)
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
  const [showStops, setShowStops] = useState(true)
  // Phone tab bar: 'map' leaves the map clear, the others open their sheet.
  const [tab, setTab] = useState<'map' | 'filter' | 'info' | 'chat'>('map')
  // The sheet's last tab, still shown while the sheet slides away to the map.
  const [sheet, setSheet] = useState<'filter' | 'info' | 'chat'>('filter')
  // Disqus loads only once someone opens the discussion, never during SSR.
  const [chat, setChat] = useState(false)
  // Disqus allows one thread per page, so it mounts in one place: a floating
  // card from md up, the bottom sheet below.
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 48rem)')
    const sync = () => setWide(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  // The user's own location: its pin, whether a fix is on the way, and a
  // short message when it can't be shown.
  // Like Google Maps: 'searching' until the first fix, then 'follow' keeps
  // the map on the user until they drag it ('free'); the button recentres.
  const userPin = useRef<Marker | null>(null)
  const watchId = useRef<number | null>(null)
  const lastFix = useRef<[number, number] | null>(null)
  const locMode = useRef<'off' | 'searching' | 'follow' | 'free'>('off')
  const [loc, setLoc] = useState(locMode.current)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [notice])
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
        // Routes and stops go under the basemap's labels so place names
        // stay readable; the buses stay on top of everything.
        const labels = m.getStyle().layers.find((l) => l.type === 'symbol')?.id
        m.addSource('routes', { type: 'geojson', data: data.current })
        m.addLayer(
          {
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
          },
          labels,
        )
        // The selected bus's route from where it is to where it's going.
        m.addSource('focus', { type: 'geojson', data: toGeoJSON([]) })
        m.addLayer(
          {
            id: 'route-ahead',
            type: 'line',
            source: 'focus',
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': ['get', 'color'], 'line-width': 5 },
          },
          labels,
        )
        // Stops; the "Halte" chip shows or hides them.
        m.addSource('stops', { type: 'geojson', data: stopsToGeoJSON([]) })
        const halte = (
          yes: number | string,
          no: number | string,
        ): ExpressionSpecification => ['case', ['get', 'halte'], yes, no]
        m.addLayer(
          {
            id: 'stops',
            type: 'circle',
            source: 'stops',
            filter: ['any', ['get', 'halte'], ['>=', ['zoom'], BUS_STOP_ZOOM]],
            layout: { visibility: 'none' },
            paint: {
              'circle-radius': [
                'interpolate',
                ['linear'],
                ['zoom'],
                11,
                halte(2.5, 2),
                16,
                halte(7, 4),
              ],
              // Zoomed out, haltes are hollow so the live buses are the only
              // coloured dots. From HALTE_LABEL_ZOOM they turn filled blue and
              // bigger; bus stops stay small and hollow, so the two differ in
              // size and fill, not hue alone.
              'circle-color': [
                'step',
                ['zoom'],
                '#ffffff',
                HALTE_LABEL_ZOOM,
                halte(HALTE_COLOR, '#ffffff'),
              ],
              'circle-stroke-color': [
                'step',
                ['zoom'],
                halte('#5f6368', '#6b7280'),
                HALTE_LABEL_ZOOM,
                halte('#ffffff', '#6b7280'),
              ],
              'circle-stroke-width': [
                'step',
                ['zoom'],
                1.25,
                HALTE_LABEL_ZOOM,
                halte(2, 1.25),
              ],
            },
          },
          labels,
        )
        // The dots are only a few pixels wide; this invisible ring around
        // each one takes the clicks, so a fingertip can hit it.
        m.addLayer({
          id: 'stops-hit',
          type: 'circle',
          source: 'stops',
          filter: ['any', ['get', 'halte'], ['>=', ['zoom'], BUS_STOP_ZOOM]],
          layout: { visibility: 'none' },
          paint: { 'circle-radius': 14, 'circle-opacity': 0 },
        })
        // A ring around the stop whose popup is open.
        m.addSource('stop-focus', { type: 'geojson', data: toGeoJSON([]) })
        m.addLayer({
          id: 'stop-focus',
          type: 'circle',
          source: 'stop-focus',
          paint: {
            'circle-radius': 12,
            'circle-color': HALTE_COLOR,
            'circle-opacity': 0.15,
            'circle-stroke-color': HALTE_COLOR,
            'circle-stroke-width': 2,
          },
        })
        m.addLayer({
          id: 'stop-label',
          type: 'symbol',
          source: 'stops',
          minzoom: HALTE_LABEL_ZOOM,
          filter: ['any', ['get', 'halte'], ['>=', ['zoom'], STOP_LABEL_ZOOM]],
          layout: {
            visibility: 'none',
            'text-field': ['get', 'name'],
            'text-font': [
              'case',
              ['get', 'halte'],
              ['literal', ['Noto Sans Bold']],
              ['literal', ['Noto Sans Regular']],
            ],
            'text-size': halte(12, 11),
            'text-max-width': 8,
            // Try below the dot first, then the other sides, before giving up.
            'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
            'text-radial-offset': 0.8,
            // Haltes win when names collide.
            'symbol-sort-key': halte(0, 1),
          },
          paint: {
            'text-color': halte('#0d1b2a', '#4a5866'),
            'text-halo-color': '#ffffff',
            'text-halo-width': 1.5,
          },
        })
        // How far off the user's location may be, drawn under the buses.
        m.addSource('user-accuracy', { type: 'geojson', data: toGeoJSON([]) })
        m.addLayer({
          id: 'user-accuracy',
          type: 'circle',
          source: 'user-accuracy',
          paint: {
            'circle-color': USER_COLOR,
            'circle-opacity': 0.12,
            'circle-stroke-color': USER_COLOR,
            'circle-stroke-opacity': 0.3,
            'circle-stroke-width': 1,
            'circle-pitch-alignment': 'map',
          },
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
              11,
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
      /** Opens a popup with `el` at `at` and returns it. */
      const popup = (
        at: Parameters<InstanceType<typeof Popup>['setLngLat']>[0],
        el: HTMLElement,
        offset = 0,
      ) =>
        new Popup({ closeButton: false, maxWidth: '260px', offset })
          .setLngLat(at)
          .setDOMContent(el)
          .addTo(m)
      m.on('click', 'routes', (e) => {
        // A click on a bus or stop over a route goes to the bus or stop.
        if (
          m.queryRenderedFeatures(e.point, { layers: ['buses', 'stops-hit'] })
            .length
        )
          return
        const p = e.features?.[0]?.properties
        if (p) popup(e.lngLat, textCard(String(p.code), String(p.name)))
      })
      let stopPopup: InstanceType<typeof Popup> | null = null
      m.on('click', 'stops-hit', (e) => {
        if (m.queryRenderedFeatures(e.point, { layers: ['buses'] }).length)
          return
        const f = e.features?.[0]
        if (f?.geometry.type !== 'Point') return
        // Pinned to the stop itself rather than where the tap landed, with
        // a ring on the stop until the popup closes.
        const at = f.geometry.coordinates as [number, number]
        const focus = m.getSource<GeoJSONSource>('stop-focus')
        focus?.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: at },
        })
        const opened = popup(
          at,
          stopCard(
            String(f.properties.name),
            Boolean(f.properties.halte),
            String(f.properties.routes).split(',').filter(Boolean),
            routesRef.current,
          ),
          14,
        )
        stopPopup = opened
        // The previous popup closes after this handler runs when another
        // stop is tapped, so only the latest one clears the ring.
        opened.on('close', () => {
          if (stopPopup === opened) focus?.setData(toGeoJSON([]))
        })
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
      for (const layer of ['routes', 'stops-hit', 'buses']) {
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
      cancelAnimationFrame(frame.current)
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
    const m = map.current
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    const now = performance.now()
    busData.current = busesToGeoJSON(shownBuses)
    // Each bus glides from where it's drawn now to its new position, along
    // its route line when it's on one. Far or implausibly fast moves jump.
    const seen = new Set<string>()
    busData.current.features.forEach((f, idx) => {
      const bus = shownBuses[idx]
      const no = bus.bus_body_no
      const to: Vec = [bus.longitude, bus.latitude]
      const k = Math.cos((bus.latitude * Math.PI) / 180)
      const g = glides.current.get(no)
      seen.add(no)
      const last = g?.path[g.path.length - 1]
      if (!g || last![0] !== to[0] || last![1] !== to[1]) {
        const at = g ? glideAt(g, now).at : to
        const gap = g ? now - g.t0 : 0
        const iv =
          gap >= GAP_RANGE[0] && gap <= GAP_RANGE[1]
            ? g!.iv
              ? g!.iv * 0.65 + gap * 0.35
              : gap
            : (g?.iv ?? 0)
        const d = metres(at, to, k)
        const jump =
          still ||
          d > JUMP_M ||
          (d > 250 && d / Math.max(1, gap / 1000) > JUMP_SPEED)
        const dir = jump ? undefined : busDirection(bus, routesRef.current)
        const line = dir?.path.map(([lat, lon]): Vec => [lon, lat]) ?? null
        glides.current.set(
          no,
          makeGlide(jump ? [to] : glidePath(at, to, line, k), k, {
            t0: now,
            ms: jump
              ? 0
              : Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, iv || GLIDE_MS)),
            iv,
            h: g?.h ?? bus.bearing,
            moved: (g?.moved ?? false) || (!jump && d > 3),
          }),
        )
      }
      // Start from where it's drawn, so nothing flashes at the new spot.
      const g2 = glides.current.get(no)!
      ;(f.geometry as Point).coordinates = glideAt(g2, now).at
      f.properties!.bearing = g2.h
    })
    for (const no of glides.current.keys())
      if (!seen.has(no)) glides.current.delete(no)
    for (const [no, t0] of pings.current)
      if (now - t0 >= PING_MS || still) pings.current.delete(no)
    // Rings share their bus's geometry, so they glide along with it.
    const rings: FeatureCollection = {
      type: 'FeatureCollection',
      features: busData.current.features
        .filter((f) => pings.current.has(String(f.properties!.no)))
        .map((f) => ({
          ...f,
          properties: {
            ...f.properties,
            t0: pings.current.get(f.properties!.no),
          },
        })),
    }
    m?.getSource<GeoJSONSource>('pings')?.setData(rings)
    // The new frame loop reads this message's rings, so drop the old one.
    cancelAnimationFrame(frame.current)
    if (!m) return
    // ponytail: setData on every frame resends all buses to the worker; fine
    // for a few hundred, throttle or use updateData if "all" (~3,900) lags.
    /** Draws one frame and keeps going while a bus or a ring still moves. */
    function draw(t: number) {
      let busy = false
      const turn =
        1 - Math.exp(-Math.min(1000, t - lastFrame.current) / TURN_MS)
      lastFrame.current = t
      busData.current.features.forEach((f, idx) => {
        const g = glides.current.get(String(f.properties!.no))
        if (!g) return
        const { at, heading } = glideAt(g, t)
        ;(f.geometry as Point).coordinates = at
        // Point where the bus is going while it moves; once it stops, keep
        // that heading, or the reported one if it has never moved.
        const aim = heading ?? (g.moved ? g.h : shownBuses[idx].bearing)
        const diff = ((aim - g.h + 540) % 360) - 180
        g.h = still ? aim : (g.h + diff * turn + 360) % 360
        f.properties!.bearing = g.h
        busy ||= heading !== null || Math.abs(diff) > 0.5
      })
      const mm = map.current
      mm?.getSource<GeoJSONSource>('buses')?.setData(busData.current)
      if (mm && rings.features.length) {
        mm.getSource<GeoJSONSource>('pings')?.setData(rings)
        const { radius, opacity } = pingPaint(t)
        mm.setPaintProperty('bus-ping', 'circle-radius', radius)
        mm.setPaintProperty('bus-ping', 'circle-opacity', opacity)
        busy ||= [...pings.current.values()].some((t0) => t - t0 < PING_MS)
      }
      frame.current = busy && mm ? requestAnimationFrame(draw) : 0
    }
    frame.current = requestAnimationFrame(draw)
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
    m.setPaintProperty(
      'stops',
      'circle-opacity',
      selectedBus ? DIM_BUS_OPACITY : 1,
    )
    m.setPaintProperty(
      'stops',
      'circle-stroke-opacity',
      selectedBus ? DIM_BUS_OPACITY : 1,
    )
    m.setPaintProperty(
      'stop-label',
      'text-opacity',
      selectedBus ? DIM_BUS_OPACITY : 1,
    )
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
    if (locMode.current === 'follow') setLocMode('free')
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

  // Stops of the chosen types, shown unless the "Halte" chip is unticked.
  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    const visibility = showStops ? 'visible' : 'none'
    m.setLayoutProperty('stops', 'visibility', visibility)
    m.setLayoutProperty('stops-hit', 'visibility', visibility)
    m.setLayoutProperty('stop-label', 'visibility', visibility)
    if (!showStops) return
    const ctrl = new AbortController()
    const qs = typeKey ? `?type=${encodeURIComponent(typeKey)}` : ''
    fetch(`${API}/stops${qs}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d: { stops: Array<Stop> }) =>
        map.current
          ?.getSource<GeoJSONSource>('stops')
          ?.setData(stopsToGeoJSON(d.stops)),
      )
      .catch(() => {
        if (!ctrl.signal.aborted) setNotice('Gagal memuat halte.')
      })
    return () => ctrl.abort()
  }, [ready, typeKey, showStops, attempt])

  const focus =
    'outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'
  /** The Disqus thread; called only in the browser, since it reads window. */
  const discussion = () => (
    <DiscussionEmbed
      shortname="transjakarta"
      config={{
        // One thread for the whole map, whatever ?type is set.
        url: `${window.location.origin}/`,
        identifier: 'peta-rute',
        title: 'Rute Transjakarta',
        language: 'id',
      }}
    />
  )
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
  const onTab = (t: typeof sheet) => (sheet === t ? '' : 'max-md:hidden')

  useEffect(() => {
    const m = map.current
    if (!m || !ready) return
    // Dragging the map lets go of the user, as in Google Maps; zooming doesn't.
    const letGo = () => {
      if (locMode.current === 'follow') {
        locMode.current = 'free'
        setLoc('free')
      }
    }
    m.on('dragstart', letGo)
    return () => {
      m.off('dragstart', letGo)
    }
  }, [ready])

  useEffect(
    () => () => {
      if (watchId.current !== null)
        navigator.geolocation.clearWatch(watchId.current)
    },
    [],
  )

  /** Sets the locate mode in the ref the callbacks read and in state. */
  const setLocMode = (mode: typeof locMode.current) => {
    locMode.current = mode
    setLoc(mode)
  }

  /** Stops watching the user's position and takes the dot off the map. */
  const stopLocating = () => {
    if (watchId.current !== null)
      navigator.geolocation.clearWatch(watchId.current)
    watchId.current = null
    lastFix.current = null
    userPin.current?.remove()
    userPin.current = null
    map.current
      ?.getSource<GeoJSONSource>('user-accuracy')
      ?.setData(toGeoJSON([]))
    setLocMode('off')
  }

  /**
   * Moves the dot and accuracy circle to a new fix. The first fix flies the
   * map there; later ones keep it centred while following. A fix outside the
   * map's bounds (the routes shown plus 5 km) stops locating with a message.
   */
  const onFix = async ({ coords }: GeolocationPosition) => {
    const m = map.current
    if (!m || watchId.current === null) return
    const at: [number, number] = [coords.longitude, coords.latitude]
    if (m.getMaxBounds()?.contains(at) === false) {
      stopLocating()
      setNotice('Lokasi Anda di luar jangkauan rute yang ditampilkan.')
      return
    }
    lastFix.current = at
    if (!userPin.current) {
      const { Marker } = await import('maplibre-gl')
      const el = document.createElement('div')
      el.className = 'user-pin'
      el.setAttribute('role', 'img')
      el.setAttribute('aria-label', 'Lokasi Anda')
      userPin.current = new Marker({ element: el })
    }
    userPin.current.setLngLat(at).addTo(m)
    userPin.current.getElement().classList.remove('user-pin-stale')
    m.getSource<GeoJSONSource>('user-accuracy')?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: at },
    })
    // Metres to pixels: one pixel covers M_PER_PX_Z0 * cos(lat) metres at
    // zoom 0 and half that with each zoom level.
    const r0 =
      coords.accuracy /
      (M_PER_PX_Z0 * Math.cos((coords.latitude * Math.PI) / 180))
    m.setPaintProperty('user-accuracy', 'circle-radius', [
      'interpolate',
      ['exponential', 2],
      ['zoom'],
      0,
      r0,
      22,
      r0 * 2 ** 22,
    ])
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0
      : undefined
    if (locMode.current === 'searching') {
      setLocMode('follow')
      // Close enough to see the buses with their heading arrows.
      m.flyTo({ center: at, zoom: Math.max(m.getZoom(), 16), duration })
    } else if (locMode.current === 'follow') {
      m.easeTo({ center: at, duration: duration ?? 500 })
    }
  }

  /** A refused lookup stops locating; a lost signal greys the dot out. */
  const onFixError = (err: GeolocationPositionError) => {
    if (err.code === err.PERMISSION_DENIED) {
      stopLocating()
      setNotice(
        'Akses lokasi ditolak. Izinkan lokasi untuk situs ini di pengaturan browser.',
      )
    } else if (locMode.current === 'searching') {
      stopLocating()
      setNotice('Lokasi Anda tidak bisa ditemukan. Coba lagi sebentar lagi.')
    } else {
      userPin.current?.getElement().classList.add('user-pin-stale')
    }
  }

  /**
   * The locate button. The first tap asks the browser for the location and
   * starts following it; after the user drags the map away, a tap brings
   * the map back to them.
   */
  const locate = () => {
    if (locMode.current === 'off') {
      if (!('geolocation' in navigator)) {
        setNotice('Perangkat ini tidak mendukung lokasi.')
        return
      }
      setNotice(null)
      setLocMode('searching')
      watchId.current = navigator.geolocation.watchPosition(
        (pos) => void onFix(pos),
        onFixError,
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
      )
    } else if (lastFix.current) {
      setLocMode('follow')
      map.current?.easeTo({
        center: lastFix.current,
        zoom: Math.max(map.current.getZoom(), 16),
      })
    }
  }

  // Filter chips, Google Maps style: outlined when off, tinted with a tick
  // when on. The native checkbox inside keeps keyboards and screen readers.
  const chip = `inline-flex h-11 cursor-pointer select-none items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--surface)] px-4 text-sm font-semibold text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--field)] has-[:checked]:border-transparent has-[:checked]:bg-[var(--accent-soft)] has-[:checked]:text-[var(--accent-on-soft)] has-[:disabled]:cursor-default md:h-9 md:px-3 has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--accent)]`
  const tick = (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="-ml-1 hidden h-4 w-4 peer-checked:block"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 12 5 5 9-10" />
    </svg>
  )
  const busCount = shownBuses.length.toLocaleString('id-ID')
  // The live feed's state, at the end of the floating top bar.
  const liveState = (
    <p
      aria-live="polite"
      className="m-0 flex shrink-0 items-center gap-2 text-sm font-semibold"
    >
      <span
        aria-hidden="true"
        className={`h-2 w-2 shrink-0 rounded-full ${
          feed === 'open'
            ? 'bg-[#1e8e3e]'
            : feed === 'closed'
              ? 'bg-[#d93025]'
              : 'animate-pulse bg-[#f29900] motion-reduce:animate-none'
        }`}
      />
      <span className="sr-only">Data bus: </span>
      {feed === 'open'
        ? 'Terhubung'
        : feed === 'closed'
          ? 'Menyambung ulang…'
          : 'Menyambungkan…'}
    </p>
  )
  const retry = (
    <button
      type="button"
      onClick={() => setAttempt((a) => a + 1)}
      className={`h-10 shrink-0 cursor-pointer rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-ink)] transition-[filter,scale] duration-150 hover:brightness-110 active:scale-95 ${focus}`}
    >
      Coba lagi
    </button>
  )

  return (
    <div className="relative h-full md:flex">
      {/* On phones the panel is a bottom sheet over a full-screen map that
          opens from the tab bar, one section per tab. */}
      <aside
        className={`absolute inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-10 flex max-h-[70dvh] flex-col gap-6 overflow-y-auto rounded-t-[28px] bg-[var(--surface)] px-5 pb-6 pt-6 shadow-[0_-2px_12px_rgb(60_64_67/0.18)] md:static md:max-h-none md:w-96 md:shrink-0 md:gap-7 md:rounded-none md:border-r md:border-[var(--line)] md:p-6 md:shadow-none max-md:transition-[translate,visibility] motion-reduce:transition-none ${
          // Slides down behind the tab bar, then hides so it can't take focus.
          tab === 'map'
            ? 'max-md:invisible max-md:translate-y-full max-md:duration-200 max-md:ease-in'
            : 'max-md:duration-300 max-md:ease-[cubic-bezier(0.16,1,0.3,1)]'
        }`}
      >
        <header className="max-md:hidden">
          <h1 className="m-0 text-xl font-bold leading-tight">Tije</h1>
          <p className="m-0 text-sm text-[var(--ink-soft)]">
            Bus Transjakarta, langsung di peta
          </p>
        </header>

        <fieldset className={`m-0 border-0 p-0 ${onTab('filter')}`}>
          <legend className="mb-3 text-base font-bold">Jenis rute</legend>
          <div className="flex flex-wrap gap-2">
            <label className={chip}>
              <input
                type="checkbox"
                className="peer sr-only"
                checked={allShown}
                // Unticking "all" goes back to the default selection.
                onChange={() => onTypesChange(allShown ? DEFAULT_TYPES : [])}
              />
              {tick}
              Semua
            </label>
            {typeList.map((t) => {
              const on = shown.includes(t.type)
              return (
                <label key={t.type} className={chip}>
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={on}
                    // The last ticked type stays; an empty choice would mean all.
                    disabled={on && shown.length === 1}
                    onChange={() => toggleType(t.type)}
                  />
                  {tick}
                  {t.type}
                  <span className="font-medium tabular-nums opacity-70">
                    {t.routes}
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <fieldset className={`m-0 border-0 p-0 ${onTab('filter')}`}>
          <legend className="mb-3 text-base font-bold">Lapisan peta</legend>
          <label className={chip}>
            <input
              type="checkbox"
              className="peer sr-only"
              checked={showStops}
              onChange={() => setShowStops((v) => !v)}
            />
            {tick}
            Halte
          </label>
        </fieldset>

        <section aria-label="Ringkasan" className={onTab('info')}>
          {status === 'error' ? (
            <div className="fade-in flex flex-col items-start gap-3">
              <p className="m-0">
                Gagal memuat rute dari <code>{API}</code>. Periksa koneksi, lalu
                coba lagi.
              </p>
              {retry}
            </div>
          ) : status === 'loading' ? (
            <div aria-label="Memuat rute…" className="flex flex-col gap-2.5">
              <span className="h-6 w-48 animate-pulse rounded-md bg-[var(--field)] motion-reduce:animate-none" />
              <span className="h-4 w-full animate-pulse rounded-md bg-[var(--field)] motion-reduce:animate-none" />
            </div>
          ) : (
            <div className="fade-in">
              <p className="m-0 text-lg font-bold tabular-nums">
                {feed === 'open'
                  ? `${busCount} bus aktif di ${count} rute`
                  : `${count} rute di peta`}
              </p>
              <p className="mb-0 mt-1 text-sm text-[var(--ink-soft)]">
                {count === 0
                  ? 'Tidak ada rute untuk jenis ini. Pilih jenis lain.'
                  : 'Pilih bus, garis rute, atau halte di peta untuk melihat detailnya.'}
              </p>
            </div>
          )}
        </section>

        <section aria-label="Diskusi" className={`md:hidden ${onTab('chat')}`}>
          <h2 className="m-0 text-base font-bold">Diskusi</h2>
          {chat && !wide && <div className="mt-3 min-h-40">{discussion()}</div>}
        </section>

        <footer
          className={`flex flex-col gap-3 border-t border-[var(--line)] pt-5 md:mt-auto ${onTab('info')}`}
        >
          <p className="m-0 text-sm leading-snug text-[var(--ink-soft)]">
            Dibuat oleh{' '}
            <span className="font-semibold text-[var(--ink)]">
              Arter Tendean
            </span>
            . Bukan aplikasi resmi Transjakarta, dan tanpa dana APBN. Saran atau
            laporan:{' '}
            <a href="mailto:arter@tije.info" className="font-semibold">
              arter@tije.info
            </a>
          </p>
          <p className="m-0 text-xs leading-relaxed text-[var(--ink-soft)] [&_a]:text-[var(--ink-soft)] [&_a:hover]:text-[var(--ink)]">
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

      {/* Floating top bar: what's on the map and the feed state. Across the
          top under the notch on phones, top right of the map from md up. */}
      <div className="fade-in absolute inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-10 flex min-h-12 items-center gap-3 rounded-full bg-[var(--surface)] py-1.5 pl-5 pr-4 shadow-[var(--shadow)] md:inset-x-auto md:right-6 md:top-6">
        {status === 'error' ? (
          <>
            <span role="alert" className="min-w-0 flex-1 text-sm font-semibold">
              Gagal memuat rute
            </span>
            <span className="-mr-2.5">{retry}</span>
          </>
        ) : (
          <>
            <p
              aria-hidden="true"
              className="m-0 min-w-0 flex-1 truncate text-[15px] font-semibold tabular-nums"
            >
              {status === 'loading' ? (
                <span className="text-[var(--ink-soft)]">Memuat rute…</span>
              ) : (
                <>
                  {feed === 'open' && `${busCount} bus · `}
                  <span className="text-[var(--ink-soft)]">{count} rute</span>
                </>
              )}
            </p>
            {liveState}
          </>
        )}
      </div>

      {/* Desktop zoom, Google Maps style: one rounded column of + and −.
          Phones pinch instead. */}
      <div className="absolute bottom-[5.25rem] right-6 z-[5] flex flex-col overflow-hidden rounded-full bg-[var(--surface)] shadow-[var(--shadow)] max-md:hidden">
        {(
          [
            ['Perbesar', 'M12 5v14M5 12h14', 1],
            ['Perkecil', 'M5 12h14', -1],
          ] as const
        ).map(([label, icon, step]) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            onClick={() =>
              step > 0 ? map.current?.zoomIn() : map.current?.zoomOut()
            }
            className={`flex h-12 w-12 cursor-pointer items-center justify-center text-[var(--ink-soft)] transition-colors duration-150 hover:bg-[var(--field)] hover:text-[var(--ink)] ${focus} focus-visible:-outline-offset-3`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            >
              <path d={icon} />
            </svg>
          </button>
        ))}
      </div>

      {/* Locate button, bottom right; on phones it sits above the tab bar and
          slips under an open sheet or bus card. */}
      <button
        type="button"
        onClick={locate}
        aria-label={
          loc === 'free' ? 'Kembali ke lokasi saya' : 'Tampilkan lokasi saya'
        }
        aria-pressed={loc === 'follow'}
        className={`absolute bottom-[calc(4rem+env(safe-area-inset-bottom)+1rem)] right-3 z-[5] flex h-12 w-12 cursor-pointer items-center justify-center rounded-full bg-[var(--surface)] shadow-[var(--shadow)] transition-[scale,background-color] duration-150 hover:bg-[var(--field)] active:scale-95 md:bottom-6 md:right-6 ${loc === 'off' ? 'text-[var(--ink-soft)]' : 'text-[var(--accent)]'} ${focus}`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className={`h-6 w-6 ${loc === 'searching' ? 'animate-pulse motion-reduce:animate-none' : ''}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="7" />
          {/* Filled while the map follows the user, hollow otherwise. */}
          <circle
            cx="12"
            cy="12"
            r="3"
            fill={loc === 'follow' ? 'currentColor' : 'none'}
          />
          <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
        </svg>
      </button>

      {/* Desktop discussion: a button left of the locate button and a card
          floating on the right side of the map. */}
      <button
        type="button"
        onClick={() => setChat((c) => !c)}
        aria-label={chat ? 'Tutup diskusi' : 'Buka diskusi'}
        aria-expanded={chat && wide}
        aria-controls="diskusi"
        className={`absolute bottom-6 right-[5.25rem] z-[5] flex h-12 w-12 cursor-pointer items-center justify-center rounded-full shadow-[var(--shadow)] transition-[scale,background-color] duration-150 active:scale-95 max-md:hidden ${chat ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : 'bg-[var(--surface)] text-[var(--ink-soft)] hover:bg-[var(--field)]'} ${focus}`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={CHAT_ICON} />
        </svg>
      </button>
      {chat && wide && (
        <div
          id="diskusi"
          role="dialog"
          aria-label="Diskusi"
          onKeyDown={(e) => e.key === 'Escape' && setChat(false)}
          className="fade-in absolute bottom-[5.5rem] right-6 top-[5.25rem] z-20 flex w-[min(26rem,calc(100%-3rem))] flex-col rounded-2xl bg-[var(--surface)] shadow-[var(--shadow)]"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] py-2 pl-5 pr-2">
            <h2 className="m-0 text-base font-bold">Diskusi</h2>
            <button
              type="button"
              onClick={() => setChat(false)}
              aria-label="Tutup diskusi"
              className={`flex h-11 w-11 cursor-pointer items-center justify-center rounded-full text-[var(--ink-soft)] hover:bg-[var(--field)] ${focus}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-3">
            {discussion()}
          </div>
        </div>
      )}

      {/* Snackbar, centred above the locate button. */}
      <p
        role="status"
        className="pointer-events-none absolute inset-x-3 bottom-[calc(4rem+env(safe-area-inset-bottom)+4.5rem)] z-20 m-0 flex justify-center md:bottom-24 md:left-auto md:right-6 md:max-w-sm md:justify-end"
      >
        {notice && (
          <span className="fade-in rounded-lg bg-[#303134] px-4 py-3 text-sm font-medium text-white shadow-[var(--shadow)]">
            {notice}
          </span>
        )}
      </p>

      <nav
        aria-label="Menu"
        className="absolute inset-x-0 bottom-0 z-30 flex select-none border-t border-[var(--line)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {(
          [
            [
              'map',
              'Peta',
              'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
            ],
            ['filter', 'Rute', 'M4 6h16M7 12h10m-7 6h4'],
            ['chat', 'Diskusi', CHAT_ICON],
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
            aria-pressed={tab === id}
            // Tapping the open tab again closes its sheet. BusInfo closes
            // itself on any tap outside it, so tabs never sit under a card.
            onClick={() => {
              setTab(tab === id ? 'map' : id)
              if (id !== 'map') setSheet(id)
              if (id === 'chat') setChat(true)
            }}
            className={`group flex h-16 flex-1 cursor-pointer flex-col items-center justify-center gap-1 text-xs font-semibold transition-colors duration-150 ${tab === id ? 'text-[var(--ink)]' : 'text-[var(--ink-soft)]'} outline-none`}
          >
            {/* Material-style pill behind the active tab's icon; it also
                carries the focus ring. */}
            <span
              className={`flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-200 group-focus-visible:outline-3 group-focus-visible:outline-[var(--accent)] ${tab === id ? 'bg-[var(--accent-soft)] text-[var(--accent-on-soft)]' : ''}`}
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
            </span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}
