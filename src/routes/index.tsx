import { useEffect, useRef } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { DEFAULT_TYPES } from '#/api'
import { RouteMap } from '../components/RouteMap'

// Types shown when the URL has no ?type.
const DEFAULT_TYPE = DEFAULT_TYPES.join(',')
// localStorage key of the last filter, so the map reopens the way it was left.
const SAVED = 'tije.filter'

type Search = { type?: string; rute?: string; halte?: 'off' }

/** A search value as text; the router turns `?rute=9` into the number 9. */
function text(v: unknown) {
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined
}

/** Keeps the known filter keys from a parsed URL or a saved filter. */
function toSearch(s: Record<string, unknown>): Search {
  return {
    type: text(s.type),
    rute: text(s.rute),
    halte: s.halte === 'off' ? 'off' : undefined,
  }
}

/** The filter saved by an earlier visit, or null when there is none. */
function savedSearch(): Search | null {
  try {
    const s = toSearch(JSON.parse(localStorage.getItem(SAVED) ?? '{}'))
    return s.type || s.rute || s.halte ? s : null
  } catch {
    // Storage can be blocked or hold junk; the default filter is fine then.
    return null
  }
}

export const Route = createFileRoute('/')({
  // ?type=BRT,Mikrotrans lists the types; no param means DEFAULT_TYPE and
  // 'all' is the explicit "all routes" choice. ?rute=1,9 narrows the map to
  // those routes, and ?halte=off hides the stops.
  validateSearch: toSearch,
  component: App,
})

/**
 * The map page. The filter lives in the URL, so a link shares it, and in
 * localStorage, so opening the app without one brings the last filter back.
 */
function App() {
  const search = Route.useSearch()
  const { type = DEFAULT_TYPE, rute = '', halte } = search
  const navigate = Route.useNavigate()
  const restored = useRef(false)

  useEffect(() => {
    if (!restored.current) {
      restored.current = true
      const saved =
        !search.type && !search.rute && !search.halte && savedSearch()
      if (saved) {
        navigate({ search: saved, replace: true })
        return
      }
    }
    try {
      localStorage.setItem(SAVED, JSON.stringify(search))
    } catch {
      // Not saved; the URL still holds the filter for this visit.
    }
  }, [search])

  /** Changes part of the filter, keeping the rest. */
  const set = (patch: Search) =>
    navigate({ search: (s) => ({ ...s, ...patch }), replace: true })

  return (
    <main className="h-dvh">
      <RouteMap
        types={type === 'all' ? [] : type.split(',').filter(Boolean)}
        onTypesChange={(t) => {
          const joined = t.join(',')
          set({ type: joined === DEFAULT_TYPE ? undefined : joined || 'all' })
        }}
        routes={rute.split(',').filter(Boolean)}
        onRoutesChange={(r) => set({ rute: r.join(',') || undefined })}
        showStops={halte !== 'off'}
        onShowStopsChange={(on) => set({ halte: on ? undefined : 'off' })}
      />
    </main>
  )
}
