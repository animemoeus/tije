import { useEffect, useMemo, useRef, useState } from 'react'
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
// maplibre resolves its worker next to its own module, which breaks once Vite
// pre-bundles it; let Vite bundle the worker and hand maplibre the URL.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

const API = import.meta.env.VITE_API_URL ?? 'http://transjakarta-api.animemoe.us'
const WS = API.replace(/^http/, 'ws')
// The API caps the live bus radius at 20 km.
const MAX_RADIUS_KM = 20

type Route = {
  route_code: string
  route_name: string
  route_color: string
  directions: Array<{ path: Array<[number, number]> }>
}
type RouteType = { type: string; routes: number }
type Bus = {
  bus_body_no: string
  route_code: string
  trip_headsign: string
  route_color: string
  type: string
  latitude: number
  longitude: number
  bearing: number
  next_stop_name: string
}

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
        bearing: b.bearing,
        color: `#${b.route_color || '555555'}`,
      },
      geometry: {
        type: 'Point' as const,
        coordinates: [b.longitude, b.latitude],
      },
    })),
  }
}

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

// Box around every path point, widened by `km` on each side, as [[w, s], [e, n]].
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

// White arrow pointing north, drawn at 2x; the map rotates it by bearing.
function headingArrow() {
  const size = 24
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.moveTo(12, 3)
  ctx.lineTo(19, 19)
  ctx.lineTo(12, 15)
  ctx.lineTo(5, 19)
  ctx.closePath()
  ctx.fill()
  return ctx.getImageData(0, 0, size, size)
}

// Live bus feed for the whole map area: centred on it, reaching its corners.
function busFeedUrl([[w, s], [e, n]]: [[number, number], [number, number]]) {
  const lat = (s + n) / 2
  const lon = (w + e) / 2
  const dy = ((n - s) / 2) * KM_PER_DEG
  const dx = ((e - w) / 2) * KM_PER_DEG * Math.cos((lat * Math.PI) / 180)
  const radius = Math.min(MAX_RADIUS_KM, Math.ceil(Math.hypot(dx, dy)))
  return `${WS}/ws?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&radius_km=${radius}`
}

export function RouteMap({
  type,
  onTypeChange,
}: {
  type: string
  onTypeChange: (type: string) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<MlMap | null>(null)
  const data = useRef(toGeoJSON([]))
  const busData = useRef(busesToGeoJSON([]))
  const [ready, setReady] = useState(false)
  const [types, setTypes] = useState<Array<RouteType>>([])
  const [status, setStatus] = useState<'loading' | 'error' | 'done'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [count, setCount] = useState(0)
  const [routeCodes, setRouteCodes] = useState<Set<string>>(new Set())
  const [buses, setBuses] = useState<Array<Bus>>([])
  const [live, setLive] = useState(false)
  const [feedUrl, setFeedUrl] = useState('')

  useEffect(() => {
    let cancelled = false
    void import('maplibre-gl').then(
      ({ Map, NavigationControl, Popup, setWorkerUrl }) => {
        if (cancelled || !container.current) return
        setWorkerUrl(workerUrl)
        const m = new Map({
          container: container.current,
          style: 'https://tiles.openfreemap.org/styles/positron',
          center: [106.8456, -6.2088],
          zoom: 11,
          attributionControl: false,
        })
        m.addControl(new NavigationControl({ showCompass: false }), 'top-right')
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
              'line-opacity': 0.25,
            },
          })
          m.addSource('buses', { type: 'geojson', data: busData.current })
          m.addLayer({
            id: 'buses',
            type: 'circle',
            source: 'buses',
            paint: {
              'circle-radius': 9,
              'circle-color': ['get', 'color'],
              'circle-stroke-width': 2,
              'circle-stroke-color': '#ffffff',
            },
          })
          m.addImage('heading', headingArrow(), { pixelRatio: 2 })
          m.addLayer({
            id: 'bus-heading',
            type: 'symbol',
            source: 'buses',
            layout: {
              'icon-image': 'heading',
              'icon-rotate': ['get', 'bearing'],
              'icon-rotation-alignment': 'map',
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
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
          const p = e.features?.[0]?.properties
          if (p) popup(e.lngLat, String(p.code), String(p.name))
        })
        m.on('click', 'buses', (e) => {
          const p = e.features?.[0]?.properties
          if (!p) return
          // Buses sit on top of routes; don't also open the route popup.
          e.originalEvent.stopPropagation()
          popup(
            e.lngLat,
            `${p.code} · ${p.headsign}`,
            `${p.no} · berikutnya ${p.next}`,
          )
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
      },
    )
    return () => {
      cancelled = true
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
      ws = new WebSocket(feedUrl)
      ws.onopen = () => setLive(true)
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as {
          type: string
          buses?: Array<Bus>
        }
        if (msg.type === 'snapshot' && msg.buses) setBuses(msg.buses)
      }
      ws.onclose = () => {
        setLive(false)
        if (!closed) retry = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      ws?.close()
      setLive(false)
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
  }, [shownBuses])

  useEffect(() => {
    fetch(`${API}/route-types`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d: { types: Array<RouteType> }) =>
        setTypes(d.types.filter((t) => t.routes > 0)),
      )
      .catch(() => {})
  }, [attempt])

  useEffect(() => {
    if (!ready) return
    const ctrl = new AbortController()
    setStatus('loading')
    const qs = type ? `?type=${encodeURIComponent(type)}` : ''
    fetch(`${API}/routes${qs}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((d: { routes: Array<Route> }) => {
        data.current = toGeoJSON(d.routes)
        const m = map.current
        m?.getSource<GeoJSONSource>('routes')?.setData(data.current)
        // Keep the map within 5 km of the routes shown instead of the world.
        const b = boundsAround(d.routes, 5)
        if (m && b) {
          m.setMaxBounds(b)
          m.fitBounds(b, { padding: 0, duration: 600 })
          setFeedUrl(busFeedUrl(b))
        }
        setCount(d.routes.length)
        setRouteCodes(new Set(d.routes.map((r) => r.route_code)))
        setStatus('done')
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus('error')
      })
    return () => ctrl.abort()
  }, [ready, type, attempt])

  const focus =
    'outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside className="rise-in flex shrink-0 flex-col gap-5 bg-[var(--surface)] p-4 md:w-80 md:gap-8 md:overflow-y-auto md:p-6">
        <h1 className="m-0 text-2xl font-extrabold leading-none tracking-tight md:text-4xl">
          Rute Transjakarta
        </h1>

        <div>
          <label
            htmlFor="route-type"
            className="mb-2 block text-sm font-medium text-[var(--ink-soft)]"
          >
            Filter rute
          </label>
          <select
            id="route-type"
            value={type}
            onChange={(e) => onTypeChange(e.target.value)}
            className={`h-12 w-full cursor-pointer bg-[var(--field)] px-3 text-base font-semibold text-[var(--ink)] transition-colors duration-150 hover:bg-[var(--ground)] ${focus}`}
          >
            <option value="">Semua rute</option>
            {types.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type} ({t.routes})
              </option>
            ))}
          </select>
        </div>

        <div aria-live="polite">
          {status === 'error' ? (
            <div role="alert" className="flex flex-col items-start gap-3">
              <p className="m-0">
                Gagal memuat rute. Pastikan transjakarta-api berjalan di{' '}
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
                  <span className="flex items-baseline gap-2">
                    <span className="text-5xl font-extrabold leading-none tracking-tighter tabular-nums md:text-7xl">
                      {count}
                    </span>
                    <span className="font-semibold">rute di peta</span>
                  </span>
                )}
              </p>
              <p className="mb-0 mt-3 hidden text-sm text-[var(--ink-soft)] md:block">
                {status === 'done' && count === 0
                  ? 'Tidak ada rute untuk jenis ini. Pilih jenis lain.'
                  : 'Klik garis atau bus di peta untuk melihat detailnya.'}
              </p>
              <p className="mb-0 mt-5 font-semibold">
                {live
                  ? `${shownBuses.length} bus aktif di area peta`
                  : 'Menyambungkan data bus…'}
              </p>
            </>
          )}
        </div>
        <footer className="md:mt-auto">
          <p className="m-0 text-sm text-[var(--ink-soft)] [&_a]:text-[var(--ink-soft)] [&_a]:underline-offset-2 [&_a:hover]:text-[var(--ink)]">
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

      <div
        ref={container}
        className="min-h-0 flex-1"
        role="region"
        aria-label="Peta rute Transjakarta"
      />
    </div>
  )
}
