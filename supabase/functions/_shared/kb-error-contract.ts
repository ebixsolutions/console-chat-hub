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

// Preserve the existing 12s RAG allowance. Admission has its own equal ceiling;
// Inbox has three such finite phase allowances including preliminary scope and
// optional ranking. The client adds only a 2s response-delivery margin.
export const KB_ADMISSION_TIMEOUT_MS = 12000;
export const KB_PROXY_EXECUTION_BUDGET_MS = 3 * KB_ADMISSION_TIMEOUT_MS;
export const KB_PROXY_CLIENT_TIMEOUT_MS = KB_PROXY_EXECUTION_BUDGET_MS + 2000;

/** Request-local cancellation only; no retries, dispatch, logging or authority. */
export function createKBRequestBudget(milliseconds: number, parent?: AbortSignal) {
  const controller = new AbortController();
  let deadline = Date.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout>;
  const abort = () => controller.abort(new DOMException("KB execution deadline", "AbortError"));
  const fromParent = () => controller.abort(parent?.reason);
  const reset = (ms: number) => {
    clearTimeout(timer); deadline = Date.now() + ms;
    timer = setTimeout(abort, ms);
  };
  reset(milliseconds);
  if (parent?.aborted) fromParent(); else parent?.addEventListener("abort", fromParent, {once:true});
  const check = () => { if (Date.now() >= deadline) abort(); controller.signal.throwIfAborted(); };
  return { signal: controller.signal, reset, check,
    async run<T>(action: ()=>PromiseLike<T>): Promise<T> {
      check();
      return await new Promise<T>((resolve,reject)=>{
        const onAbort = () => { cleanup(); reject(controller.signal.reason ?? new DOMException("KB cancelled","AbortError")); };
        const cleanup = () => controller.signal.removeEventListener("abort",onAbort);
        controller.signal.addEventListener("abort",onAbort,{once:true});
        Promise.resolve().then(()=>{check();return action();}).then(value=>{cleanup();try{check();resolve(value);}catch(error){reject(error);}},error=>{cleanup();reject(error);});
      });
    },
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort",fromParent); },
  };
}
