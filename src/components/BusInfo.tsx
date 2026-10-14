import { useEffect, useId, useRef, useState } from 'react'
import { API } from '#/api'

// GET /buses/{bus_body_no}, only the fields shown here. The API also sends
// speed, timestamp and estimated_time_next_stops, but they are always 0.
type BusDetail = {
  bus_body_no: string
  route_code: string | null
  route_name: string | null
  trip_headsign: string | null
  route_color: string | null
  route_text_color: string | null
  type: string | null
  prev_stop_name: string | null
  next_stop_name: string | null
  estimated_distance_next_stops: number | null
  age_seconds: number
}

// The API only knows a bus while its area is tracked; keep the card fresh.
const REFRESH_MS = 5000

/** Metres as "845 m", or "1,2 km" from 1 km up. */
function formatDistance(m: number) {
  return m < 1000
    ? `${Math.round(m)} m`
    : `${(m / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} km`
}

/** Seconds since the last update, in words. */
function formatAge(s: number) {
  if (s < 5) return 'baru saja'
  if (s < 60) return `${Math.round(s)} detik lalu`
  return `${Math.round(s / 60)} menit lalu`
}

/**
 * Card with the latest details of one bus, fetched from the API and refreshed
 * while it stays open. Closes with the × button or Esc.
 */
export function BusInfo({
  busNo,
  onClose,
}: {
  busNo: string
  onClose: () => void
}) {
  const titleId = useId()
  const [bus, setBus] = useState<BusDetail | null>(null)
  const [status, setStatus] = useState<'loading' | 'done' | 'gone' | 'error'>(
    'loading',
  )
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    setBus(null)
    setStatus('loading')
    const load = () => {
      fetch(`${API}/buses/${encodeURIComponent(busNo)}`, {
        signal: ctrl.signal,
      })
        .then((r) => {
          if (r.status === 404) {
            setStatus('gone')
            return
          }
          if (!r.ok) throw r
          return (r.json() as Promise<BusDetail>).then((d) => {
            setBus(d)
            setStatus('done')
            timer = setTimeout(load, REFRESH_MS)
          })
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setStatus('error')
        })
    }
    load()
    return () => {
      ctrl.abort()
      clearTimeout(timer)
    }
  }, [busNo, attempt])

  const card = useRef<HTMLElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    // Clicks outside the card close it. The map is left out: a drag there
    // still ends in a click, so RouteMap closes the card on map clicks
    // through maplibre, which tells a click from a drag.
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element
      if (!card.current?.contains(t) && !t.closest('.maplibregl-map')) onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('click', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('click', onClick)
    }
  }, [onClose])

  const focus =
    'outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'
  const stops =
    bus && (bus.prev_stop_name || bus.next_stop_name)
      ? `${bus.prev_stop_name ?? '—'} → ${bus.next_stop_name ?? '—'}`
      : null

  return (
    <section
      ref={card}
      role="dialog"
      aria-labelledby={titleId}
      className="rise-in absolute inset-x-4 bottom-4 z-10 bg-[var(--surface)] p-4 text-[var(--ink)] shadow-lg md:inset-x-auto md:bottom-auto md:left-4 md:top-4 md:w-80"
    >
      <div className="flex items-start gap-3">
        {bus?.route_code && (
          <span
            className="shrink-0 rounded-full px-2.5 py-1 text-sm font-extrabold leading-none"
            style={{
              background: `#${bus.route_color || '555555'}`,
              color: `#${bus.route_text_color || 'ffffff'}`,
            }}
          >
            {bus.route_code}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="m-0 text-lg font-extrabold leading-tight">
            {bus?.route_name || `Bus ${busNo}`}
          </h2>
          {/* Many routes are named after their destination; skip the repeat. */}
          {bus?.trip_headsign && bus.trip_headsign !== bus.route_name && (
            <p className="m-0 mt-1 text-sm text-[var(--ink-soft)]">
              Menuju {bus.trip_headsign}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup informasi bus"
          className={`-m-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center text-2xl leading-none text-[var(--ink-soft)] transition-colors duration-150 hover:text-[var(--ink)] ${focus}`}
        >
          ×
        </button>
      </div>

      <div aria-live="polite" className="mt-4">
        {status === 'loading' && (
          <p className="m-0 flex items-center gap-3">
            <span
              aria-hidden="true"
              className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--field)] border-t-[var(--accent)] motion-reduce:animate-none"
            />
            <span className="font-semibold">Memuat informasi bus…</span>
          </p>
        )}
        {status === 'gone' && (
          <p className="m-0">Bus ini sudah tidak terlacak.</p>
        )}
        {status === 'error' && (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="m-0">Gagal memuat informasi bus.</p>
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className={`h-11 cursor-pointer bg-[var(--accent)] px-5 font-bold text-[var(--accent-ink)] transition-transform duration-150 hover:brightness-110 active:scale-95 ${focus}`}
            >
              Coba lagi
            </button>
          </div>
        )}
        {status === 'done' && bus && (
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-[var(--ink-soft)]">Nomor bus</dt>
            <dd className="m-0 font-semibold">{bus.bus_body_no}</dd>
            {bus.type && (
              <>
                <dt className="text-[var(--ink-soft)]">Layanan</dt>
                <dd className="m-0 font-semibold">{bus.type}</dd>
              </>
            )}
            {stops && (
              <>
                <dt className="text-[var(--ink-soft)]">Halte</dt>
                <dd className="m-0 font-semibold">{stops}</dd>
              </>
            )}
            {!!bus.estimated_distance_next_stops && (
              <>
                <dt className="text-[var(--ink-soft)]">Ke halte berikutnya</dt>
                <dd className="m-0 font-semibold tabular-nums">
                  {formatDistance(bus.estimated_distance_next_stops)}
                </dd>
              </>
            )}
            <dt className="text-[var(--ink-soft)]">Diperbarui</dt>
            <dd className="m-0 font-semibold">{formatAge(bus.age_seconds)}</dd>
          </dl>
        )}
      </div>
    </section>
  )
}
