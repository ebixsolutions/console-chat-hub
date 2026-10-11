import {
  type AccountingRpc,
  ModelAccountingError,
} from "./model-attempt-accounting.ts";
export function remoteAccountingSecret(
  credential: { kind: string; value: string },
  cfg: { signingSecret?: string },
): string {
  return credential.kind === "jwt"
    ? (cfg.signingSecret ?? credential.value)
    : credential.value;
}
export interface RemoteScope {
  company: string;
  tenant: string;
  operation: string;
  expires: number;
  nonce: string;
  service?: "kb" | "coach_sync";
}
const encoder = new TextEncoder();
export async function signRemote(
  value: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
export async function verifyRemote(
  value: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(signature.match(/../g)!.map((v) => parseInt(v, 16))),
    encoder.encode(value),
  );
}
/** A retrieval HTTP request is not an attempt. Unknown downstream coverage denies before retrieval. */
export async function prepareRemoteRetrieval(
  company: string | null,
  tenant: string,
  credential: string,
  endpoint: string,
  upstream: typeof fetch = fetch,
  signal?: AbortSignal,
  service: "kb" | "coach_sync" = "kb",
): Promise<Record<string, string>> {
  // The bounded synthetic scope alone requires the new remote contract; other tenants retain their accepted authority.
  if (company !== "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec") return {};
  const scope: RemoteScope = {
    company,
    tenant,
    operation: `${service}:${crypto.randomUUID()}`,
    expires: Math.floor(Date.now() / 1000) + 60,
    nonce: crypto.randomUUID(),
    service,
  };
  const payload = JSON.stringify(scope);
  const signature = await signRemote(payload, credential);
  let response: Response;
  try {
    response = await upstream(
      `${endpoint.replace(/\/$/, "")}/model-accounting-contract`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          "x-c3-accounting-scope": payload,
          "x-c3-accounting-signature": signature,
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
          : AbortSignal.timeout(5000),
      },
    );
  } catch {
    throw new ModelAccountingError("KB_DOWNSTREAM_ACCOUNTING_UNAVAILABLE");
  }
  if (!response.ok) {
    throw new ModelAccountingError("KB_DOWNSTREAM_ACCOUNTING_UNPROVEN");
  }
  const text = await response.text();
  if (
    !await verifyRemote(
      text,
      response.headers.get("x-c3-accounting-signature") ?? "",
      credential,
    )
  ) throw new ModelAccountingError("KB_DOWNSTREAM_ACCOUNTING_UNPROVEN");
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ModelAccountingError("KB_DOWNSTREAM_ACCOUNTING_UNPROVEN");
  }
  if (
    body.protocol !== "c3-shared-attempt-v1" || body.nonce !== scope.nonce ||
    body.company !== company || body.tenant !== tenant ||
    body.expires !== scope.expires ||
    !["retrieval_only", "shared_atomic_attempts"].includes(body.mode) ||
    !/^[a-f0-9]{64}$/.test(body.runtime_sha256 ?? "")
  ) {
    throw new ModelAccountingError("KB_DOWNSTREAM_ACCOUNTING_UNPROVEN");
  }
  return {
    "x-c3-accounting-scope": payload,
    "x-c3-accounting-signature": signature,
    "x-c3-accounting-mode": body.mode,
  };
}
export async function remoteAccountingAction(
  db: AccountingRpc,
  scope: RemoteScope,
  body: Record<string, any>,
) {
  if (
    !Number.isInteger(scope.expires) ||
    scope.company !== "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec" ||
    scope.expires < Math.floor(Date.now() / 1000) ||
    scope.expires > Math.floor(Date.now() / 1000) + 65
  ) {
    throw new ModelAccountingError("REMOTE_SCOPE_DENIED");
  }
  if (
    typeof body.identity !== "string" || !/^[a-f0-9]{64}$/.test(body.identity)
  ) throw new ModelAccountingError("REMOTE_IDENTITY_INVALID");
  // Signed operation prefix prevents a remote caller finalizing another operation's reservation.
  const identity = `${scope.operation}:${body.identity}`;
  let result;
  if (body.action === "reserve") {
    result = await db.rpc("c3_reserve_model_attempt", {
      p_company_id: scope.company,
      p_conversation_id: null,
      p_identity: identity,
      p_operation_id: scope.operation,
      p_provider: `${scope.service ?? "kb"}:${
        String(body.provider ?? "").slice(0, 100)
      }`,
      p_purpose: `${scope.service ?? "kb"}_downstream`,
      p_request_sha256: body.request_sha256,
      p_run_id: "a0a8c36e-42b5-4d9f-bbee-095ddc731520",
    });
  } else if (body.action === "finalize") {
    result = await db.rpc("c3_finalize_model_attempt", {
      p_company_id: scope.company,
      p_run_id: "a0a8c36e-42b5-4d9f-bbee-095ddc731520",
      p_identity: identity,
      p_state: body.state,
      p_http_status: body.http_status,
    });
  } else throw new ModelAccountingError("REMOTE_ACTION_DENIED");
  if (result.error || !result.data) {
    throw new ModelAccountingError("REMOTE_ACCOUNTING_DENIED");
  }
  return result.data;
}
