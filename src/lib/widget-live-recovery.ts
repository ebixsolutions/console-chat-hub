/** Only these wrapper responses are known to occur before visitor persistence.
 * Everything else remains an unknown delivery until authoritative readback. */
export function isBusinessAdmissionFailure(value: unknown): boolean {
  const v = value as {success?: boolean; retryable?: boolean; error?: string} | null;
  return v?.success === false && v.retryable === false &&
    ["live_ai_execution_unavailable", "live_ai_conversation_not_authorized", "original_preview_new_conversation_required", "original_preview_actor_denied"].includes(v.error ?? "");
}

type ReadMessage = {id: string; role: string; metadata?: Record<string, unknown> | null};
export function deliveryConfirmedByReadback(rows: ReadMessage[], clientId: string, humanControl: boolean): boolean {
  const visitor = rows.find(row => row.role === "visitor" && row.metadata?.client_message_id === clientId);
  if (!visitor) return false;
  // Human-controlled visitors do not need an AI response. AI delivery requires
  // an actual final reply bound to this visitor, never an unrelated old reply.
  return humanControl || rows.some(row => row.role === "assistant" &&
    row.metadata?.source_message_id === visitor.id && row.metadata?.is_thinking !== true);
}
