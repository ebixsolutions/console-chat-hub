import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
/**
 * PR-6B — Singapore KB publish finalizer + live RAG read-back.
 *
 * Publication is accepted locally only after:
 * 1. publish status completed
 * 2. KBDocument published/live/indexed
 * 3. source hash exact
 * 4. active_version_id present
 * 5. training_sync_status synced
 * 6. current production RAG contract selects same document and returns
 *    authoritative full_content evidence
 * 7. returned full_content proves the NEW trained content is actually indexed,
 *    not merely an older vector from the same document
 *
 * No tenant/company is accepted from caller input.
 */
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import {
  resolveSingaporeControlCredential,
  resolveSingaporeCredential,
  singaporeCredentialHeaders,
  type KBCredentialConfig,
  type KBCredentialScope,
} from "../_shared/kb-auth.ts";
import {
  parseStringMap,
  resolveKBEndpoint,
} from "../_shared/kb-client.ts";
import { parseAggregationResponse } from "../_shared/kb-aggregation-response.ts";

const CONTRACT = "PR6B_SINGAPORE_KB_FINALIZE_V4";
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
  const a = new TextEncoder().encode(aText), b = new TextEncoder().encode(bText);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function credentialConfig(): KBCredentialConfig | null {
  const endpoint = resolveKBEndpoint();
  return endpoint
    ? {
        signingSecret: endpoint.signingSecret,
        jwtTtlSec: endpoint.jwtTtlSec,
        defaultToken: endpoint.defaultToken,
        tenantTokens: endpoint.tenantTokens,
        tenantApiKeys: endpoint.tenantApiKeys,
        apiKeyHeaderMode: endpoint.apiKeyHeaderMode,
      }
    : null;
}
function singaporeCompanyId(tenantId: string): number | null {
  if (!/^[1-9]\d*$/.test(tenantId)) return null;
  const n = Number(tenantId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizeVerificationText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function verificationWindows(value: string): string[] {
  const normalized = normalizeVerificationText(value);
  if (!normalized) return [];

  // Prefer bounded natural-language windows. Very short windows produce false
  // positives; very long windows are likely to cross a chunk boundary.
  const words = normalized.split(" ").filter(Boolean);
  const windows: string[] = [];
  for (let size = Math.min(8, words.length); size >= 4; size -= 1) {
    for (let i = 0; i + size <= words.length; i += 1) {
      const candidate = words.slice(i, i + size).join(" ");
      if (candidate.length >= 24) windows.push(candidate);
      if (windows.length >= 24) return windows;
    }
    if (windows.length > 0) break;
  }

  if (windows.length === 0 && normalized.length >= 24) {
    windows.push(normalized.slice(0, Math.min(120, normalized.length)));
  }
  return windows;
}

function newContentEvidenceMatches(
  newContent: string,
  evidenceContents: string[],
): boolean {
  const evidence = normalizeVerificationText(evidenceContents.join("\n"));
  if (!evidence) return false;

  const windows = verificationWindows(newContent);
  if (windows.length === 0) return false;
  return windows.some((window) => evidence.includes(window));
}

type ResolvedCredential = Extract<Awaited<ReturnType<typeof resolveSingaporeCredential>>, { ok: true }>;

async function kbFetch(
  base: string,
  path: string,
  credential: ResolvedCredential,
  cfg: KBCredentialConfig,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...singaporeCredentialHeaders(credential, cfg),
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const expected = text(Deno.env.get("TRAINING_KB_SYNC_INTERNAL_TOKEN"));
  const actual = text(req.headers.get("X-Training-KB-Sync-Token"));
  if (!expected || !actual || !constantTimeEqual(expected, actual)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const supabaseUrl = text(Deno.env.get("SUPABASE_URL"));
  let serviceRole = "";
  try { serviceRole = text(getSupabaseAdminKey()); } catch {}
  const endpoint = resolveKBEndpoint();
  const authCfg = credentialConfig();
  const tenantMap = parseStringMap(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON"));
  if (!supabaseUrl || !serviceRole || !endpoint || !authCfg || !tenantMap) {
    return json({ ok: false, error: "runtime_config_missing" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRole);
  const { data: claim, error: claimError } = await admin.rpc("claim_pr6b_kb_finalize_tx", {});
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
  const newContent = typeof kbUpdate.new_raw_content === "string" ? kbUpdate.new_raw_content : "";
  const verificationQuery = text(kbUpdate.verification_query);

  async function finish(outcome: "pending" | "published" | "failed", error: string | null) {
    const { data, error: rpcError } = await admin.rpc("finish_pr6b_kb_finalize_tx", {
      p_publish_state_id: publishStateId,
      p_outcome: outcome,
      p_error: error,
    });
    if (rpcError) throw new Error("finalize_state_commit_failed");
    return data;
  }

  if (!publishStateId || !evaluationId || !companyId || !documentId || !operationId) {
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
  const upstreamCompanyId = singaporeCompanyId(tenantId);
  if (upstreamCompanyId === null) {
    await finish("failed", "kb_company_id_invalid");
    return json({ ok: false, error: "kb_company_id_invalid" }, 409);
  }

  const scope: KBCredentialScope = {
    mode: "canonical",
    aiCompanyId: companyId,
    singaporeTenantId: tenantId,
  };
  const controlCredential = await resolveSingaporeControlCredential(scope, authCfg);
  if (!controlCredential.ok) {
    await finish("failed", controlCredential.error_code.toLowerCase());
    return json({ ok: false, error: controlCredential.error_code.toLowerCase() }, 409);
  }

  let statusResponse: Response;
  try {
    statusResponse = await kbFetch(
      endpoint.baseUrl, "/api/functions/kbPublishGetStatus", controlCredential, authCfg,
      { method: "POST", body: JSON.stringify({ operation_id: operationId }) },
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
    return json({ ok: false, error: `kb_publish_${operationStatus}`, operation_id: operationId }, 409);
  }
  if (operationStatus !== SUCCESS) {
    await finish("pending", null);
    return json({
      ok: true, contract: CONTRACT, processed: 1,
      state: "pending", operation_status: operationStatus,
    });
  }

  const documentResponse = await kbFetch(
    endpoint.baseUrl,
    `/api/entities/KBDocument/${encodeURIComponent(documentId)}`,
    controlCredential,
    authCfg,
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

  // Defense in depth: the returned document must still belong to the exact
  // server-mapped Singapore tenant used for credentials/RAG.
  if (String(document.company_id ?? "") !== String(tenantId)) {
    await finish("failed", "kb_document_tenant_mismatch");
    return json({ ok: false, error: "kb_document_tenant_mismatch" }, 409);
  }

  if (text(document.training_sync_status) !== "synced") {
    const syncResponse = await kbFetch(
      endpoint.baseUrl,
      `/api/entities/KBDocument/${encodeURIComponent(documentId)}`,
      controlCredential,
      authCfg,
      { method: "PATCH", body: JSON.stringify({ training_sync_status: "synced" }) },
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

  // Read-back uses the data-plane credential deliberately. Control-plane JWT
  // is never substituted for the tenant RAG key unless no RAG key is configured.
  const ragCredential = await resolveSingaporeCredential(scope, authCfg);
  if (!ragCredential.ok) {
    await finish("pending", ragCredential.error_code.toLowerCase());
    return json({ ok: true, contract: CONTRACT, processed: 1, state: "pending" });
  }

  const ragResponse = await kbFetch(
    endpoint.baseUrl,
    "/api/v1/rag/context-search",
    ragCredential,
    authCfg,
    {
      method: "POST",
      body: JSON.stringify({
        query: verificationQuery,
        company_id: upstreamCompanyId,
        candidate_top_k: 12,
        max_documents: 1,
        max_summary_chunks: 1,
        max_full_content_chunks: 3,
        score_threshold: 0.05,
      }),
    },
  );
  if (!ragResponse.ok) {
    await finish("pending", `kb_rag_http_${ragResponse.status}`);
    return json({ ok: true, contract: CONTRACT, processed: 1, state: "pending" });
  }

  let ragJson: unknown;
  try {
    ragJson = await ragResponse.json();
  } catch {
    await finish("failed", "kb_rag_invalid_json");
    return json({ ok: false, error: "kb_rag_invalid_json" }, 409);
  }

  const parsed = parseAggregationResponse(ragJson);
  const selectedSameDocument =
    parsed.ok && parsed.contextFound && parsed.selectedDocumentId === documentId;
  const sameDocumentEvidence =
    parsed.ok && parsed.contextFound
      ? parsed.llmContext.full_content_evidence
          .filter((item) => item.document_id === documentId)
          .map((item) => item.content)
      : [];
  const hasFullContent = sameDocumentEvidence.length > 0;

  if (!selectedSameDocument || !hasFullContent) {
    await finish("failed", "kb_rag_readback_failed");
    return json({
      ok: false,
      error: "kb_rag_readback_failed",
      evaluation_id: evaluationId,
      document_id: documentId,
    }, 409);
  }

  /*
   * Critical closed-loop proof:
   * "same document" is insufficient because stale production vectors from the
   * previous document version can satisfy that check. Require returned
   * authoritative full_content to contain a bounded window from NEW raw content.
   * This proves the learned version is actually visible to the live RAG path.
   */
  if (!newContentEvidenceMatches(newContent, sameDocumentEvidence)) {
    await finish("pending", "kb_rag_new_content_not_visible");
    return json({
      ok: true,
      contract: CONTRACT,
      processed: 1,
      state: "pending",
      reason: "kb_rag_new_content_not_visible",
      evaluation_id: evaluationId,
      document_id: documentId,
    });
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
    rag_new_content_verified: true,
  });
});
