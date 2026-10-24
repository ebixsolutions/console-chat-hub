export const C3_WIDGET_RUNTIME_CONTRACT = "c3-widget-control-v2";

export function widgetRuntimeBlockReason(data: any, actorId: string | undefined): string | null {
  if (data?.runtime_contract !== C3_WIDGET_RUNTIME_CONTRACT) return "backend_runtime_contract_unverified";
  if (!actorId || data.actor_id !== actorId) return "authenticated_actor_mismatch";
  if (typeof data.execution_ready !== "boolean" || typeof data.remote_ready !== "boolean") return "readiness_contract_unverified";
  return null;
}
export function verifiedWidgetRuntime(data: any, actorId: string | undefined): boolean {
  return widgetRuntimeBlockReason(data,actorId) === null;
}

/** Reasons describe observed client state, never successful delivery or permission grants. */
export function widgetSendBlockReason(state: {
  actorScoped: boolean; closed: boolean; pending: boolean; inFlight: boolean;
  scopeReady: boolean; runtimeReady: boolean; runtimeReason?: string | null; conversationId: string | null;
  conversationVerified: boolean; input: string;
}): string | null {
  if (!state.actorScoped) return "actor_or_channel_unverified";
  if (state.pending) return "previous_delivery_unresolved";
  if (state.closed) return "conversation_resolved";
  if (state.inFlight) return "send_in_flight";
  if (!state.scopeReady) return "scope_not_verified";
  if (!state.runtimeReady) return state.runtimeReason || "backend_runtime_contract_unverified";
  if (state.conversationId && !state.conversationVerified) return "conversation_not_verified";
  if (!state.input.trim()) return "draft_empty";
  return null;
}
