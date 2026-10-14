/** Presentation of persisted server outcomes. Missing grounding is not proof
 * of a clarification, successful resolution, or successful handoff. */
export function widgetResponseStatus(metadata: Record<string, unknown>): string {
  const route = typeof metadata.response_route === "string" ? metadata.response_route : "";
  if (metadata.degraded === true || metadata.generation_success === false ||
    route === "terminal_failure_recovery") return "technical recovery";
  if (metadata.grounded === true) return "grounded";
  if (["natural_greeting", "natural_small_talk", "natural_ai_identity"].includes(route)) {
    return "conversation";
  }
  if (route.includes("clarification")) return "clarification";
  return "response";
}
