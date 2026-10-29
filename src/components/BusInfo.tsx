import { useEffect, useId, useRef, useState } from 'react'
import { API } from '#/api'

// A `bus` event from GET /buses/{bus_body_no}, only the fields shown here.
// The API also sends speed, timestamp and estimated_time_next_stops, but
// they are often 0.
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
}

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
 * Card with the latest details of one bus, kept current by the API's event
 * stream while it stays open. Closes with the × button or Esc.
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
  // Date.now() of the last `bus` event, and a clock that moves the age along.
  const [seenAt, setSeenAt] = useState(0)
  const [now, setNow] = useState(0)

  useEffect(() => {
    setBus(null)
    setStatus('loading')
    // A `bus` event comes right away and again each time the bus changes.
    const es = new EventSource(`${API}/buses/${encodeURIComponent(busNo)}`)
    es.addEventListener('bus', (e) => {
      setBus(JSON.parse(e.data) as BusDetail)
      setSeenAt(Date.now())
      setStatus('done')
    })
    // The stream ends after `gone`; close it so EventSource doesn't reconnect.
    es.addEventListener('gone', () => {
      setStatus('gone')
      es.close()
    })
    // While CONNECTING, EventSource is retrying by itself.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setStatus('error')
    }
    return () => es.close()
  }, [busNo, attempt])

  useEffect(() => {
    if (status !== 'done') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status])

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
  const color = `#${bus?.route_color || '5f6368'}`
  const hasStops = !!bus && !!(bus.prev_stop_name || bus.next_stop_name)

  return (
    <section
      ref={card}
      role="dialog"
      aria-labelledby={titleId}
      // On phones a bottom sheet resting on the tab bar; on desktop a card top left.
      className="sheet-up absolute inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 max-h-[60dvh] overflow-y-auto rounded-t-[28px] bg-[var(--surface)] px-5 pb-5 pt-5 text-[var(--ink)] shadow-[0_-2px_12px_rgb(60_64_67/0.18)] md:inset-x-auto md:bottom-auto md:left-6 md:top-6 md:w-96 md:rounded-2xl md:p-5 md:shadow-[var(--shadow)] md:[animation:rise-in_300ms_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none"
    >
      <div className="flex items-start gap-3">
        {bus?.route_code && (
          <span
            className="flex h-9 min-w-10 shrink-0 items-center justify-center rounded-lg px-2.5 text-base font-bold tabular-nums"
            style={{
              background: color,
              color: `#${bus.route_text_color || 'ffffff'}`,
            }}
          >
            {bus.route_code}
          </span>
        )}
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 id={titleId} className="m-0 text-lg font-bold leading-snug">
            {bus?.route_name || `Bus ${busNo}`}
          </h2>
          {/* Shown even when it repeats the route name, so "Pluit" alone
              never leaves the direction unclear. */}
          {bus?.trip_headsign && (
            <p className="m-0 mt-0.5 text-sm text-[var(--ink-soft)]">
              Menuju {bus.trip_headsign}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Tutup informasi bus"
          className={`-mr-1.5 -mt-1 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--ink-soft)] transition-colors duration-150 hover:bg-[var(--field)] hover:text-[var(--ink)] ${focus}`}
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

      <div aria-live="polite" className="mt-4">
        {status === 'loading' && (
          <div
            aria-label="Memuat informasi bus…"
            className="flex flex-col gap-3"
          >
            <span className="h-5 w-3/4 animate-pulse rounded-md bg-[var(--field)] motion-reduce:animate-none" />
            <span className="h-5 w-1/2 animate-pulse rounded-md bg-[var(--field)] motion-reduce:animate-none" />
          </div>
        )}
        {status === 'gone' && (
          <p className="fade-in m-0">
            Bus ini sudah tidak terlacak. Mungkin sudah selesai beroperasi.
          </p>
        )}
        {status === 'error' && (
          <div role="alert" className="fade-in flex flex-col items-start gap-3">
            <p className="m-0">Gagal memuat informasi bus.</p>
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className={`h-10 cursor-pointer rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--accent-ink)] transition-[filter,scale] duration-150 hover:brightness-110 active:scale-95 ${focus}`}
            >
              Coba lagi
            </button>
          </div>
        )}
        {status === 'done' && bus && (
          <div className="fade-in">
            {/* Where the bus is between two haltes, drawn as a strip of
                the route in its own colour, like Citymapper's line view. */}
            {hasStops && (
              <ol aria-label="Posisi bus" className="m-0 list-none p-0">
                <li className="relative flex min-h-9 items-start gap-3 pb-2">
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-[9px] top-3 w-1 opacity-40"
                    style={{ background: color }}
                  />
                  {/* Each marker sits in a 22px column centred on the rail. */}
                  <span
                    aria-hidden="true"
                    className="relative flex w-[22px] shrink-0 justify-center pt-1"
                  >
                    <span className="h-3 w-3 rounded-full border-2 border-[var(--line)] bg-[var(--surface)]" />
                  </span>
                  <span className="text-sm text-[var(--ink-soft)]">
                    <span className="sr-only">Halte sebelumnya: </span>
                    {bus.prev_stop_name ?? 'Halte sebelumnya tidak diketahui'}
                  </span>
                </li>
                <li className="relative flex min-h-11 items-center gap-3 pb-2">
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-[9px] top-0 w-1"
                    style={{ background: color }}
                  />
                  <span
                    aria-hidden="true"
                    className="relative h-[22px] w-[22px] shrink-0 rounded-full border-[3px] border-white shadow-[0_1px_3px_rgb(60_64_67/0.4)]"
                    style={{ background: color }}
                  />
                  <span className="text-sm font-semibold">
                    Bus di sini
                    {!!bus.estimated_distance_next_stops && (
                      <span className="font-normal text-[var(--ink-soft)]">
                        {' '}
                        ·{' '}
                        <span className="tabular-nums">
                          {formatDistance(bus.estimated_distance_next_stops)}
                        </span>{' '}
                        ke halte berikutnya
                      </span>
                    )}
                  </span>
                </li>
                <li className="relative flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="absolute left-[9px] top-0 h-2 w-1"
                    style={{ background: color }}
                  />
                  <span
                    aria-hidden="true"
                    className="relative flex w-[22px] shrink-0 justify-center pt-1"
                  >
                    <span
                      className="h-4 w-4 rounded-full border-[3px] bg-[var(--surface)]"
                      style={{ borderColor: color }}
                    />
                  </span>
                  <span>
                    <span className="block text-xs font-semibold text-[var(--ink-soft)]">
                      Halte berikutnya
                    </span>
                    <span className="block text-base font-bold leading-snug">
                      {bus.next_stop_name ?? 'Tidak diketahui'}
                    </span>
                  </span>
                </li>
              </ol>
            )}
            <p
              className={`m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--ink-soft)] ${hasStops ? 'mt-4 border-t border-[var(--line)] pt-3' : ''}`}
            >
              <span>
                <span className="font-semibold text-[var(--ink)]">
                  Bus {bus.bus_body_no}
                </span>
                {bus.type && ` · ${bus.type}`}
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 rounded-full bg-[#1e8e3e]"
                />
                Diperbarui {formatAge(Math.max(0, now - seenAt) / 1000)}
              </span>
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
