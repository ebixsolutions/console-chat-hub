import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute(
  '/_authenticated/console/conversations/$id',
)({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/_authenticated/console/conversations/$id"!</div>
}
