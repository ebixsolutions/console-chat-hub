/** Presentation of persisted server outcomes. Missing grounding is not proof
 * of a clarification, successful resolution, or successful handoff. */
export function widgetResponseStatus(metadata: Record<string, unknown>): string {
  const route = typeof metadata.response_route === "string" ? metadata.response_route : "";
  if (metadata.degraded === true || metadata.generation_success === false ||
    route === "terminal_failure_recovery") {
    const failure = metadata.execution_failure;
    if (failure && typeof failure === "object" && "stage" in failure &&
      ["admission", "config"].includes(String(failure.stage))) return "execution unavailable";
    return "technical recovery";
  }
  if (metadata.grounded === true) return "grounded";
  if (["natural_greeting", "natural_small_talk", "natural_ai_identity", "natural_presence"].includes(route)) {
    return "conversation";
  }
  if (route.includes("clarification")) return "clarification";
  return "response";
}


/** Only a server-persisted Assistant outcome can offer a customer-initiated
 * human-support action. Message text, visitor/agent metadata and a generic
 * handoff keyword never create this option. The click still uses original R1. */
export function hasTrustedHumanSupportOffer(
  role: string, metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (role !== "assistant" || !metadata ||
      metadata.response_route !== "grounding_recovery_clarification" ||
      metadata.handoff_required !== false) return false;
  const action = metadata.human_support_offer;
  return !!action && typeof action === "object" && !Array.isArray(action) &&
    Object.keys(action).length === 3 &&
    (action as Record<string, unknown>).version === 1 &&
    (action as Record<string, unknown>).type === "request_human_support" &&
    (action as Record<string, unknown>).reason === "unverified_current_fact";
}
