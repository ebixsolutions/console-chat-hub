import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
/**
 * PR-6B — SU CoachAI improved result -> Singapore KB publish saga.
 *
 * PRODUCT-READY LEARNING SAFETY:
 * A "trained" decision alone is NOT permission to mutate the production KB.
 * Production KB sync additionally requires an explicit verified correction
 * approval embedded in improved_result.kb_update.approval.
 *
 * Required approval contract:
 * {
 *   status: "approved",
 *   source: "su_coachai_verified_correction",
 *   approved_by: <non-empty opaque actor id>,
 *   approved_at: <ISO timestamp>
 * }
 *
 * Tenant and document identity remain server-derived and content-hash guarded.
 */
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import {
  resolveSingaporeControlCredential,
  singaporeCredentialHeaders,
  type KBCredentialConfig,
  type KBCredentialScope,
} from "../_shared/kb-auth.ts";
import { parseStringMap, resolveKBEndpoint } from "../_shared/kb-client.ts";

const WORKER_CONTRACT = "PR6B_SINGAPORE_KB_SYNC_V4";
const MAX_CONTENT_BYTES = 512 * 1024;
const APPROVAL_SOURCE = "su_coachai_verified_correction";

function response(body: Record<string, unknown>, status = 200): Response {
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
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function nextMinor(current: string): string | null {
  if (!/^\d+\.\d+$/.test(current)) return null;
  const [maj, min] = current.split(".").map(Number);
  return `${maj}.${min + 1}`;
}
function validIsoTimestamp(value: string): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}
function approvedKbUpdate(kb: Record<string, unknown>): boolean {
  const approval =
    kb.approval && typeof kb.approval === "object" && !Array.isArray(kb.approval)
      ? kb.approval as Record<string, unknown>
      : null;
  if (!approval) return false;

  const approvedBy = text(approval.approved_by);
  const approvedAt = text(approval.approved_at);

  return (
    text(approval.status) === "approved" &&
    text(approval.source) === APPROVAL_SOURCE &&
    approvedBy.length > 0 &&
    approvedBy.length <= 200 &&
    validIsoTimestamp(approvedAt)
  );
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

async function kbFetch(
  base: string,
  path: string,
  credential: Extract<Awaited<ReturnType<typeof resolveSingaporeControlCredential>>, { ok: true }>,
  cfg: KBCredentialConfig,
  init: RequestInit = {},
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...singaporeCredentialHeaders(credential, cfg),
        ...(init.headers || {}),
      },
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ ok: false, error: "method_not_allowed" }, 405);

  const expected = text(Deno.env.get("TRAINING_KB_SYNC_INTERNAL_TOKEN"));
  const actual = text(req.headers.get("X-Training-KB-Sync-Token"));
  if (!expected || !actual || !constantTimeEqual(expected, actual)) {
    return response({ ok: false, error: "unauthorized" }, 401);
  }

  const supabaseUrl = text(Deno.env.get("SUPABASE_URL"));
  let serviceRole = "";
  try { serviceRole = text(getSupabaseAdminKey()); } catch {}
  const endpoint = resolveKBEndpoint();
  const authCfg = credentialConfig();
  const tenantMap = parseStringMap(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON"));
  if (!supabaseUrl || !serviceRole || !endpoint || !authCfg || !tenantMap) {
    return response({ ok: false, error: "runtime_config_missing" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRole);
  const { data: claim, error: claimErr } = await admin.rpc("claim_pr6b_kb_sync_tx", {});
  if (claimErr) return response({ ok: false, error: "claim_failed" }, 500);

  const c = claim as Record<string, unknown> | null;
  if (!c || c.result === "none") {
    return response({ ok: true, contract: WORKER_CONTRACT, processed: 0 });
  }
  if (c.result !== "claimed") {
    return response({ ok: false, error: String(c.result || "claim_invalid") }, 409);
  }

  const linkId = String(c.training_link_id);
  const evaluationId = String(c.evaluation_id);
  const companyId = String(c.company_id);
  const improved = (c.improved_result || {}) as Record<string, unknown>;
  const decision = text((c.payload as Record<string, unknown> | undefined)?.decision);
  const kb = (improved.kb_update || {}) as Record<string, unknown>;
  const documentId = text(kb.document_id);
  const expectedHash = text(kb.expected_content_hash);
  const newContent = typeof kb.new_raw_content === "string" ? kb.new_raw_content : "";
  const verificationQuery = text(kb.verification_query);
  const changeSummary = text(kb.change_summary) || `SU CoachAI verified correction ${evaluationId}`;

  async function fail(code: string, remoteRef: string | null = null) {
    await admin.rpc("finish_pr6b_kb_sync_tx", {
      p_training_link_id: linkId,
      p_success: false,
      p_remote_ref: remoteRef,
      p_error: code,
    });
    return response({ ok: false, error: code, evaluation_id: evaluationId }, 409);
  }

  if (decision !== "trained") return fail("training_decision_not_trained");

  // Defense in depth: SQL claim filters approval, and worker verifies again
  // before the first Singapore KB mutation.
  if (!approvedKbUpdate(kb)) return fail("kb_update_not_verified_approved");

  if (
    !documentId || !/^[0-9a-fA-F-]{8,64}$/.test(documentId) ||
    !/^[0-9a-f]{64}$/i.test(expectedHash)
  ) return fail("kb_update_contract_invalid");

  if (
    !newContent.trim() ||
    new TextEncoder().encode(newContent).byteLength > MAX_CONTENT_BYTES
  ) return fail("kb_update_content_invalid");

  if (!verificationQuery || verificationQuery.length > 500) {
    return fail("kb_verification_query_invalid");
  }

  const tenantId = tenantMap[companyId];
  if (!tenantId) return fail("kb_tenant_mapping_unresolved");

  const scope: KBCredentialScope = {
    mode: "canonical",
    aiCompanyId: companyId,
    singaporeTenantId: tenantId,
  };
  const credential = await resolveSingaporeControlCredential(scope, authCfg);
  if (!credential.ok) return fail(credential.error_code.toLowerCase());

  let docResp: Response;
  try {
    docResp = await kbFetch(
      endpoint.baseUrl,
      `/api/entities/KBDocument/${encodeURIComponent(documentId)}`,
      credential,
      authCfg,
    );
  } catch {
    return fail("kb_unreachable");
  }

  if (!docResp.ok) return fail(`kb_document_http_${docResp.status}`);
  const doc = await docResp.json() as Record<string, unknown>;

  // Tenant isolation is enforced twice: credential scope and returned document.
  if (String(doc.company_id ?? "") !== String(tenantId)) {
    return fail("kb_document_tenant_mismatch");
  }

  const currentHash = text(doc.content_hash);
  if (currentHash !== expectedHash) return fail("kb_expected_content_hash_mismatch");

  const currentVersion = text(doc.version) || "1.0";
  const nextVersion = nextMinor(currentVersion);
  if (!nextVersion) return fail("kb_version_invalid");

  const newHash = await sha256Hex(newContent);
  if (newHash === expectedHash) return fail("kb_update_no_change");

  const approval = kb.approval as Record<string, unknown>;
  const snapshotId = `aitr_${(await sha256Hex(evaluationId + ":" + documentId)).slice(0, 40)}`;
  const snapshotBody = {
    id: snapshotId,
    document_id: documentId,
    version: currentVersion,
    version_type: "minor",
    change_type: "ai_training_merge",
    change_summary: changeSummary,
    raw_content_snapshot: String(doc.raw_content || "").slice(0, 10000),
    content_hash: expectedHash,
    changed_by_app: "ai_training",
    related_training_case_id: evaluationId,
    review_status: "approved",
    approval_source: APPROVAL_SOURCE,
    approved_by: text(approval.approved_by),
    approved_at: text(approval.approved_at),
    vector_status: "not_generated",
    company_id: doc.company_id,
  };

  const snap = await kbFetch(endpoint.baseUrl, "/api/entities/KBDocumentVersion", credential, authCfg, {
    method: "POST",
    body: JSON.stringify(snapshotBody),
  });

  if (!snap.ok && snap.status !== 409 && snap.status !== 422) {
    return fail(`kb_version_snapshot_http_${snap.status}`);
  }

  if (!snap.ok) {
    const existing = await kbFetch(
      endpoint.baseUrl,
      `/api/entities/KBDocumentVersion/${encodeURIComponent(snapshotId)}`,
      credential,
      authCfg,
    );
    if (!existing.ok) return fail("kb_version_snapshot_conflict");
    const ev = await existing.json() as Record<string, unknown>;
    if (
      text(ev.document_id) !== documentId ||
      text(ev.related_training_case_id) !== evaluationId ||
      text(ev.content_hash) !== expectedHash ||
      text(ev.review_status) !== "approved" ||
      text(ev.approval_source) !== APPROVAL_SOURCE
    ) return fail("kb_version_snapshot_conflict");
  }

  const patchBody = {
    raw_content: newContent,
    content_hash: newHash,
    version: nextVersion,
    updated_by_app: "ai_training",
    training_sync_status: "pending_sync",
    production_vector_status: "not_indexed",
    staging_vector_status: "not_indexed",
  };

  const patch = await kbFetch(
    endpoint.baseUrl,
    `/api/entities/KBDocument/${encodeURIComponent(documentId)}`,
    credential,
    authCfg,
    { method: "PATCH", body: JSON.stringify(patchBody) },
  );
  if (!patch.ok) return fail(`kb_document_patch_http_${patch.status}`);

  const patched = await patch.json() as Record<string, unknown>;
  if (text(patched.content_hash) !== newHash || text(patched.version) !== nextVersion) {
    return fail("kb_document_patch_verify_failed");
  }

  const idem = `pr6b_${evaluationId.replace(/-/g, "")}`;
  const start = await kbFetch(
    endpoint.baseUrl,
    "/api/functions/kbPublishStart",
    credential,
    authCfg,
    {
      method: "POST",
      body: JSON.stringify({
        document_ids: [documentId],
        idempotency_key: idem,
      }),
    },
  );
  if (!start.ok) return fail(`kb_publish_start_http_${start.status}`);

  const startJson = await start.json() as Record<string, unknown>;
  const operation = (startJson.operation || {}) as Record<string, unknown>;
  const operationId = text(operation.id);
  if (!operationId) return fail("kb_publish_operation_missing");

  await admin.rpc("finish_pr6b_kb_sync_tx", {
    p_training_link_id: linkId,
    p_success: true,
    p_remote_ref: operationId,
    p_error: null,
  });

  return response({
    ok: true,
    contract: WORKER_CONTRACT,
    processed: 1,
    evaluation_id: evaluationId,
    document_id: documentId,
    operation_id: operationId,
    state: "publish_started",
    approval: {
      status: "approved",
      source: APPROVAL_SOURCE,
    },
  });
});
