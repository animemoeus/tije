import { createFileRoute } from '@tanstack/react-router'
import { RouteMap } from '../components/RouteMap'

export const Route = createFileRoute('/')({
  // No param means BRT; 'all' is the explicit "all routes" choice.
  validateSearch: (search): { type?: string } => ({
    type: typeof search.type === 'string' ? search.type : undefined,
  }),
  component: App,
})

function App() {
  const { type = 'BRT' } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <main className="h-dvh">
      <RouteMap
        type={type === 'all' ? '' : type}
        onTypeChange={(t) =>
          navigate({
            search: { type: t === 'BRT' ? undefined : t || 'all' },
            replace: true,
          })
        }
      />
    </main>
  )
}
