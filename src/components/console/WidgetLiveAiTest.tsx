import { Navigate } from "@tanstack/react-router";

/** Legacy URL shares the original role/tenant/readiness and delivery guards. */
export function WidgetLiveAiTest() {
  return <Navigate to="/console/widget-preview" replace />;
}
