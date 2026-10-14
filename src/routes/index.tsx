import { createFileRoute } from '@tanstack/react-router'
import { RouteMap } from '../components/RouteMap'

// Route type shown when the URL has no ?type.
const DEFAULT_TYPE = 'BRT'

export const Route = createFileRoute('/')({
  // No param means DEFAULT_TYPE; 'all' is the explicit "all routes" choice.
  validateSearch: (search): { type?: string } => ({
    type: typeof search.type === 'string' ? search.type : undefined,
  }),
  component: App,
})

function App() {
  const { type = DEFAULT_TYPE } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <main className="h-dvh">
      <RouteMap
        type={type === 'all' ? '' : type}
        onTypeChange={(t) =>
          navigate({
            search: { type: t === DEFAULT_TYPE ? undefined : t || 'all' },
            replace: true,
          })
        }
      />
    </main>
  )
}
