import { buildVertexEndpoint } from "./vertex-generation-config.ts";
import { uatFetch, UatDenied, trustedDispatchScope } from "./uat-execution-contract.ts";
/** Shared pre-dispatch model boundary. No scoped fail-open path. */
export type AccountingRpc = {
  from?: (table: string)=>any;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: any; error: any }>;
};
export class ModelAccountingError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ModelAccountingError";
  }
}
export interface ModelAttempt {
  companyId: string | null;
  legacyAuthority?: object;
  conversationId: string | null;
  operationId: string;
  provider: string;
  purpose: string;
  slot: string;
  attempt: number;
  request: string;
}
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function accountedModelFetch(
  db: AccountingRpc,
  meta: ModelAttempt,
  url: string,
  init: RequestInit,
  upstream: typeof fetch = fetch,
  onDispatch?: () => void,
): Promise<Response> {
  let mode: "legacy" | "uat" | "authenticated_preview";
  try {
    mode = await trustedDispatchScope(db, meta.companyId, meta.conversationId, meta.legacyAuthority);
    if (mode === "uat") return await uatFetch(db, {...meta, operationId: `${meta.slot}:${meta.operationId}`}, url, init, upstream, onDispatch);
  } catch (e) {
    if (e instanceof UatDenied) throw new ModelAccountingError(e.code);
    // A failed provider transport is not an admission denial. Unknown outcomes
    // have already been durably paused by uatFetch before this error returns.
    throw e;
  }
  if (mode === "authenticated_preview") {
    // Explicit original-account paid permission, not synthetic admission and
    // never ordinary traffic reclassification. Existing provider only, bounded
    // original retry/output controls; no new ledger or inferred UAT balance.
    const model=Deno.env.get("LLM_MODEL_"+meta.purpose.toUpperCase())?.trim();
    const project=Deno.env.get("GOOGLE_PROJECT_ID")?.trim(),region=Deno.env.get("GOOGLE_REGION")?.trim();
    if(Deno.env.get("LLM_PROVIDER")?.trim().toLowerCase()!=="vertex" || meta.provider!=="vertex" ||
      !["generation","assist","evaluation"].includes(meta.purpose) || !model || !project || !region ||
      !Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")?.trim() || url!==buildVertexEndpoint(project,region,model) ||
      init.method!=="POST" || String(init.body)!==meta.request || !Number.isInteger(meta.attempt) || meta.attempt<1 || meta.attempt>3)
      throw new ModelAccountingError("ORIGINAL_PREVIEW_PROVIDER_DENIED");
    const body=JSON.parse(meta.request);
    if(new TextEncoder().encode(meta.request).length>256000 || !Number.isInteger(body.generationConfig?.maxOutputTokens) ||
      body.generationConfig.maxOutputTokens<1 || body.generationConfig.maxOutputTokens>8192)
      throw new ModelAccountingError("ORIGINAL_PREVIEW_PROVIDER_DENIED");
    onDispatch?.();
    return await upstream(url,{...init,redirect:"error"});
  }
  // Established authenticated Production path: preserve exact provider request/response.
  // Permanent Guard is deferred; no new endpoint, provider, credential or tenant scope.
  onDispatch?.();
  return await upstream(url, init);
}

/** Historical deferred Guard contract. No six-Function runtime caller uses this API. */
export async function deferredAccountedModelFetch(
  db: AccountingRpc, meta: ModelAttempt, url: string, init: RequestInit,
  upstream: typeof fetch = fetch, onDispatch?: ()=>void,
): Promise<Response> {
  // Request hash is durable; provider payload/secrets/customer text are not stored.
  const identity = await sha256(
    JSON.stringify([meta.operationId, meta.slot, meta.attempt, meta.provider]),
  );
  let reservation: any;
  try {
    const result = await db.rpc("c3_reserve_model_attempt", {
      p_company_id: meta.companyId,
      p_conversation_id: meta.conversationId,
      p_identity: identity,
      p_operation_id: meta.operationId,
      p_provider: meta.provider,
      p_purpose: meta.purpose,
      p_request_sha256: await sha256(
        JSON.stringify([url, init.method ?? "GET", meta.request]),
      ),
    });
    if (
      result.error || !result.data || typeof result.data.scoped !== "boolean" ||
      typeof result.data.dispatch !== "boolean"
    ) {
      throw new Error("reservation_failed");
    }
    reservation = result.data;
    if (!reservation.dispatch) {
      throw new ModelAccountingError("MODEL_ATTEMPT_ALREADY_RESERVED");
    }
    if (
      reservation.scoped &&
      (!reservation.run_id || reservation.state !== "reserved")
    ) throw new Error("invalid_receipt");
  } catch (e) {
    if (e instanceof ModelAccountingError) throw e;
    throw new ModelAccountingError("MODEL_ACCOUNTING_DENIED");
  }
  const finalize = async (state: "response" | "unknown", status: number) => {
    if (!reservation.scoped) return;
    try {
      const result = await db.rpc("c3_finalize_model_attempt", {
        p_company_id: meta.companyId,
        p_run_id: reservation.run_id,
        p_identity: identity,
        p_state: state,
        p_http_status: status,
      });
      if (result.error || result.data?.state !== state) {
        throw new Error("finalize_failed");
      }
    } catch {
      throw new ModelAccountingError(
        "MODEL_ACCOUNTING_FINALIZATION_UNAVAILABLE",
      );
    }
  };
  let response: Response;
  try {
    onDispatch?.();
    response = await upstream(url, { ...init, redirect: "error" });
  } catch (e) {
    await finalize("unknown", 0);
    throw e;
  }
  await finalize("response", response.status);
  return response;
}
