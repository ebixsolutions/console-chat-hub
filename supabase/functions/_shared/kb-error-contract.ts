/** Closed UI/API failure families. Never display arbitrary provider/error text. */
export type KBErrorFamily = "denied" | "not_configured" | "service_failure" | "validation_failure";
export function kbErrorFamily(body: unknown, status = 0): KBErrorFamily {
  const b = body && typeof body === "object" ? body as Record<string, any> : {};
  const code = String(b.detail ?? b.error_code ?? b.error ?? "");
  const failure = String(b.failure?.code ?? "");
  const stage = String(b.failure?.stage ?? "");
  if (/^(?:unauthorized|forbidden(?:_tenant(?:_role)?)?|not_a_member|company_inactive)$/.test(code) ||
    /^(?:INBOX_(?:AUTHORITY|SYNTHETIC_SCOPE|PAID_SCOPE|REPLAY)_DENIED|UAT_AUTHORIZATION_DENIED)$/.test(failure) || /^KB_HTTP_(?:401|403)$/.test(code) || status === 401) return "denied";
  if (/^(?:kb_(?:config_missing|tenant_.*|preactivation_.*)|INBOX_CONVERSATION_REQUIRED)$/.test(code) ||
    /^(?:UAT_REMOTE_BOUND_UNVERIFIED|ORIGINAL_PREVIEW_(?:PROVIDER_DENIED|AUTHORIZATION_REQUIRED)|INBOX_CONVERSATION_REQUIRED)$/.test(failure) || stage === "config" || stage === "admission") return "not_configured";
  if (stage === "decode" || stage === "canonical_validation" || /^KB_(?:RAG_|INVALID_JSON|AUTH_TENANT_MISMATCH)/.test(code) || b.error === "kb_response_invalid") return "validation_failure";
  if (status === 403) return "denied";
  return "service_failure";
}

export async function knowledgeFailureState(data: unknown, error: unknown): Promise<KBErrorFamily | null> {
  let body = data;
  const response = error && typeof error === "object" && "context" in error ? (error as {context?:unknown}).context : null;
  const status = response instanceof Response ? response.status : 0;
  if (response instanceof Response) {
    try { body = await response.clone().json(); } catch { /* no unsafe/raw body display */ }
  }
  if (!error && body && typeof body === "object" && (body as any).success === true) return null;
  return kbErrorFamily(body, status);
}
