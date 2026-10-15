import { createFileRoute } from '@tanstack/react-router'
import { RouteMap } from '../components/RouteMap'

// Route type shown when the URL has no ?type.
const DEFAULT_TYPE = 'BRT'

export const Route = createFileRoute('/')({
  // ?type=BRT,Mikrotrans lists the types; no param means DEFAULT_TYPE and
  // 'all' is the explicit "all routes" choice.
  validateSearch: (search): { type?: string } => ({
    type: typeof search.type === 'string' ? search.type : undefined,
  }),
  component: App,
})

/** The map page; keeps the chosen route types in the URL. */
function App() {
  const { type = DEFAULT_TYPE } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <main className="h-dvh">
      <RouteMap
        types={type === 'all' ? [] : type.split(',').filter(Boolean)}
        onTypesChange={(t) => {
          const joined = t.join(',')
          navigate({
            search: {
              type: joined === DEFAULT_TYPE ? undefined : joined || 'all',
            },
            replace: true,
          })
        }}
      />
    </main>
  )
}
