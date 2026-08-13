/**
 * PR-6B — Singapore KB publish finalizer + live RAG read-back.
 *
 * Final publication is accepted locally only after ALL gates pass:
 * 1. Singapore publish operation status === completed
 * 2. KBDocument is published + live-console available + production indexed
 * 3. source content_hash equals SHA-256(new_raw_content)
 * 4. active_version_id is non-empty
 * 5. training_sync_status is patched to synced and verified
 * 6. production RAG selects the same document and exposes full_content evidence
 *
 * No tenant is accepted from the caller.
 */
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const CONTRACT = "PR6B_SINGAPORE_KB_FINALIZE_V1";
const SUCCESS = "completed";
const FAILURE = new Set(["failed", "cancelled", "cancellation_failed"]);

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function constantTimeEqual(aText: string, bText: string): boolean {
  const a = new TextEncoder().encode(aText);
  const b = new TextEncoder().encode(bText);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function parseMap(raw: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || !value.trim()) return null;
      result[key] = value.trim();
    }
    return result;
  } catch {
    return null;
  }
}
function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64json(value: Record<string, unknown>): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function mintJwt(
  secret: string,
  companyId: string,
  tenantId: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64json({ alg: "HS256", typ: "JWT" });
  const payload = b64json({
    sub: `ai-chatbot:${companyId}`,
    tenant_id: tenantId,
    role: "service",
    iat: now,
    exp: now + 300,
  });
  const input = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}
function resolveBase(): string | null {
  const direct = text(Deno.env.get("KB_SINGAPORE_BASE_URL"));
  if (direct) return direct.replace(/\/+$/, "");
  const rag = text(Deno.env.get("KB_RAG_ENDPOINT"));
  if (!rag) return null;
  return rag
    .replace(/\/api\/v1\/rag\/context-search\/?$/, "")
    .replace(/\/+$/, "");
}
async function kbFetch(
  base: string,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const expected = text(Deno.env.get("TRAINING_KB_SYNC_INTERNAL_TOKEN"));
  const actual = text(req.headers.get("X-Training-KB-Sync-Token"));
  if (!expected || !actual || !constantTimeEqual(expected, actual)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const supabaseUrl = text(Deno.env.get("SUPABASE_URL"));
  const serviceRole = text(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const base = resolveBase();
  const jwtSecret = text(Deno.env.get("KB_SINGAPORE_JWT_SECRET"));
  const tenantMap = parseMap(text(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON")));
  if (!supabaseUrl || !serviceRole || !base || !jwtSecret || !tenantMap) {
    return json({ ok: false, error: "runtime_config_missing" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRole);
  const { data: claim, error: claimError } = await admin.rpc(
    "claim_pr6b_kb_finalize_tx",
    {},
  );
  if (claimError) return json({ ok: false, error: "claim_failed" }, 500);

  const state = claim as Record<string, unknown> | null;
  if (!state || state.result === "none") {
    return json({ ok: true, contract: CONTRACT, processed: 0 });
  }
  if (state.result !== "claimed") {
    return json({ ok: false, error: String(state.result ?? "claim_invalid") }, 409);
  }

  const publishStateId = text(state.publish_state_id);
  const evaluationId = text(state.evaluation_id);
  const companyId = text(state.company_id);
  const documentId = text(state.document_id);
  const operationId = text(state.operation_id);
  const improved = (state.improved_result ?? {}) as Record<string, unknown>;
  const kbUpdate = (improved.kb_update ?? {}) as Record<string, unknown>;
  const newContent =
    typeof kbUpdate.new_raw_content === "string" ? kbUpdate.new_raw_content : "";
  const verificationQuery = text(kbUpdate.verification_query);

  async function finish(
    outcome: "pending" | "published" | "failed",
    error: string | null,
  ) {
    const { data, error: rpcError } = await admin.rpc(
      "finish_pr6b_kb_finalize_tx",
      {
        p_publish_state_id: publishStateId,
        p_outcome: outcome,
        p_error: error,
      },
    );
    if (rpcError) throw new Error("finalize_state_commit_failed");
    return data;
  }

  if (
    !publishStateId ||
    !evaluationId ||
    !companyId ||
    !documentId ||
    !operationId
  ) {
    await finish("failed", "finalize_claim_invalid");
    return json({ ok: false, error: "finalize_claim_invalid" }, 409);
  }
  if (!newContent.trim() || !verificationQuery || verificationQuery.length > 500) {
    await finish("failed", "kb_verification_contract_invalid");
    return json({ ok: false, error: "kb_verification_contract_invalid" }, 409);
  }

  const tenantId = tenantMap[companyId];
  if (!tenantId) {
    await finish("failed", "kb_tenant_mapping_unresolved");
    return json({ ok: false, error: "kb_tenant_mapping_unresolved" }, 409);
  }
  const token = await mintJwt(jwtSecret, companyId, tenantId);

  // Gate 1: authoritative Singapore operation terminal status.
  let statusResponse: Response;
  try {
    statusResponse = await kbFetch(
      base,
      "/api/functions/kbPublishGetStatus",
      token,
      {
        method: "POST",
        body: JSON.stringify({ operation_id: operationId }),
      },
    );
  } catch {
    await finish("pending", "kb_status_unreachable");
    return json({ ok: true, contract: CONTRACT, processed: 1, state: "pending" });
  }
  if (!statusResponse.ok) {
    await finish("pending", `kb_status_http_${statusResponse.status}`);
    return json({ ok: true, contract: CONTRACT, processed: 1, state: "pending" });
  }

  const statusJson = await statusResponse.json() as Record<string, unknown>;
  const operation = (statusJson.operation ?? {}) as Record<string, unknown>;
  const operationStatus = text(operation.status);
  if (FAILURE.has(operationStatus)) {
    await finish("failed", `kb_publish_${operationStatus}`);
    return json({
      ok: false,
      error: `kb_publish_${operationStatus}`,
      operation_id: operationId,
    }, 409);
  }
  if (operationStatus !== SUCCESS) {
    await finish("pending", null);
    return json({
      ok: true,
      contract: CONTRACT,
      processed: 1,
      state: "pending",
      operation_status: operationStatus,
    });
  }

  // Gates 2-4: document activation / exact source hash.
  const documentResponse = await kbFetch(
    base,
    `/api/entities/KBDocument/${encodeURIComponent(documentId)}`,
    token,
  );
  if (!documentResponse.ok) {
    await finish("pending", `kb_document_http_${documentResponse.status}`);
    return json({ ok: true, contract: CONTRACT, processed: 1, state: "pending" });
  }
  const document = await documentResponse.json() as Record<string, unknown>;
  const expectedNewHash = await sha256Hex(newContent);
  if (
    text(document.status) !== "published" ||
    document.available_to_live_console !== true ||
    text(document.production_vector_status) !== "indexed" ||
    !text(document.active_version_id) ||
    text(document.content_hash) !== expectedNewHash
  ) {
    await finish("failed", "kb_activation_verification_failed");
    return json({ ok: false, error: "kb_activation_verification_failed" }, 409);
  }

  // Gate 5: acknowledge training synchronization only after activation is real.
  if (text(document.training_sync_status) !== "synced") {
    const syncResponse = await kbFetch(
      base,
      `/api/entities/KBDocument/${encodeURIComponent(documentId)}`,
      token,
      {
        method: "PATCH",
        body: JSON.stringify({ training_sync_status: "synced" }),
      },
    );
    if (!syncResponse.ok) {
      await finish("pending", `kb_training_sync_http_${syncResponse.status}`);
      return json({ ok: true, contract: CONTRACT, processed: 1, state: "pending" });
    }
    const synchronized = await syncResponse.json() as Record<string, unknown>;
    if (text(synchronized.training_sync_status) !== "synced") {
      await finish("failed", "kb_training_sync_verify_failed");
      return json({ ok: false, error: "kb_training_sync_verify_failed" }, 409);
    }
  }

  // Gate 6: production RAG read-back. The explicit training verification query
  // must select the same document and return at least one full_content citation.
  const ragResponse = await kbFetch(
    base,
    "/api/v1/rag/context-search",
    token,
    {
      method: "POST",
      body: JSON.stringify({
        query: verificationQuery,
        top_k: 12,
        score_threshold: 0.05,
        max_documents: 1,
        max_summary: 1,
        max_full_chunks: 3,
      }),
    },
  );
  if (!ragResponse.ok) {
    await finish("pending", `kb_rag_http_${ragResponse.status}`);
    return json({ ok: true, contract: CONTRACT, processed: 1, state: "pending" });
  }
  const rag = await ragResponse.json() as Record<string, unknown>;
  const documents = Array.isArray(rag.documents)
    ? rag.documents as Array<Record<string, unknown>>
    : [];
  const citations = Array.isArray(rag.citations)
    ? rag.citations as Array<Record<string, unknown>>
    : [];
  const selectedSameDocument =
    rag.has_context === true &&
    documents.some((item) => text(item.document_id) === documentId);
  const hasFullContent = citations.some(
    (item) =>
      text(item.document_id) === documentId &&
      text(item.chunk_type) === "full_content",
  );

  if (!selectedSameDocument || !hasFullContent) {
    await finish("failed", "kb_rag_readback_failed");
    return json({
      ok: false,
      error: "kb_rag_readback_failed",
      evaluation_id: evaluationId,
      document_id: documentId,
    }, 409);
  }

  await finish("published", null);
  return json({
    ok: true,
    contract: CONTRACT,
    processed: 1,
    state: "published",
    evaluation_id: evaluationId,
    document_id: documentId,
    operation_id: operationId,
  });
});
