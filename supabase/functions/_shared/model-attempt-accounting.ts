/** Shared pre-dispatch model boundary. No scoped fail-open path. */
export type AccountingRpc = {
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
