import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/")({
  beforeLoad: () => {
    throw redirect({ to: "/console/conversations" });
  },
  component: () => null,
});
