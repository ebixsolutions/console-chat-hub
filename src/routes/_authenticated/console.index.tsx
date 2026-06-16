import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/")({
  component: () => (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">Overview</h1>
      <p className="text-muted-foreground">Welcome to your support console.</p>
    </div>
  ),
});
