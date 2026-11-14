/** Existing server-side eligibility RPC is the single evaluation scope authority. */
export interface EvaluationScopeRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}
export async function verifyEvaluationEligibility(admin: EvaluationScopeRpc, conversationId: string): Promise<string | null> {
  try {
    const scope = await admin.rpc("ce_conversation_evaluable_v1", { p_conversation_id: conversationId });
    if (scope.error || typeof scope.data !== "boolean") return "EVALUATION_SCOPE_UNAVAILABLE";
    return scope.data ? null : "EVALUATION_SCOPE_EXCLUDED";
  } catch { return "EVALUATION_SCOPE_UNAVAILABLE"; }
}
