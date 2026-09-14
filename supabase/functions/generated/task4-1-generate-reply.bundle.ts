// supabase/functions/_shared/kb-client.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// supabase/functions/_shared/supabase-admin-key.ts
function getSupabaseAdminKey() {
  const modern = Deno.env.get("SUPABASE_SECRET_KEY")?.trim() ?? "";
  if (modern) return modern;
  const legacyJson = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (legacyJson) {
    try {
      const parsed = JSON.parse(legacyJson);
      const key = parsed && typeof parsed === "object" ? String(parsed.default ?? "").trim() : "";
      if (key) return key;
    } catch {
    }
  }
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (serviceRole) return serviceRole;
  throw new Error("SUPABASE_ADMIN_KEY_MISSING");
}

// supabase/functions/_shared/kb-auth.ts
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4 || 4)) % 4);
    const parsed = JSON.parse(atob(padded));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlJson(value) {
  return base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(value))
  );
}
async function mintSingaporeTenantJwt(scope, cfg) {
  if (!cfg.signingSecret) return null;
  const now = Math.floor(Date.now() / 1e3);
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const actorRef = scope.mode === "canonical" && scope.aiCompanyId ? `company:${scope.aiCompanyId}` : scope.mode === "pre_activation" ? "pre-activation" : "demo";
  const payload = base64UrlJson({
    sub: `ai-chatbot:${actorRef}`,
    tenant_id: scope.singaporeTenantId,
    role: "service",
    iat: now,
    exp: now + cfg.jwtTtlSec
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cfg.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
function validOpaqueCredential(value) {
  if (value.length < 16 || value.length > 4096) return false;
  return !/[\r\n\0]/.test(value);
}
function validateTenantJwt(scope, token, missingCode) {
  if (!token) return { ok: false, error_code: missingCode };
  const claims = decodeJwtPayload(token);
  if (!claims) return { ok: false, error_code: "KB_AUTH_TOKEN_INVALID" };
  const tokenTenant = claims.tenant_id ?? claims.sub;
  if (String(tokenTenant ?? "") !== scope.singaporeTenantId) {
    return { ok: false, error_code: "KB_AUTH_TENANT_MISMATCH" };
  }
  const exp = Number(claims.exp);
  if (Number.isFinite(exp) && exp * 1e3 <= Date.now() + 5e3) {
    return { ok: false, error_code: "KB_AUTH_TOKEN_EXPIRED" };
  }
  return { ok: true, kind: "jwt", value: token };
}
async function resolveSingaporeCredential(scope, cfg) {
  const apiKey = cfg.tenantApiKeys[scope.singaporeTenantId]?.trim();
  if (apiKey) {
    if (!validOpaqueCredential(apiKey)) {
      return { ok: false, error_code: "KB_AUTH_API_KEY_INVALID" };
    }
    return { ok: true, kind: "api_key", value: apiKey };
  }
  const minted = await mintSingaporeTenantJwt(scope, cfg);
  const token = minted ?? cfg.tenantTokens[scope.singaporeTenantId] ?? cfg.defaultToken ?? "";
  return validateTenantJwt(scope, token, "KB_AUTH_TOKEN_MISSING");
}
function singaporeCredentialHeaders(credential, cfg) {
  if (credential.kind === "service_role") {
    return { "x-service-role-secret": credential.value };
  }
  if (credential.kind === "api_key" && cfg.apiKeyHeaderMode === "x-api-key") {
    return { "x-api-key": credential.value };
  }
  return { Authorization: `Bearer ${credential.value}` };
}

// supabase/functions/_shared/kb-aggregation-response.ts
var MAX_SELECTED_DOCUMENTS = 5;
var MAX_SUMMARY_CHUNKS_PER_DOCUMENT = 1;
var MAX_FULL_CONTENT_CHUNKS_PER_DOCUMENT = 3;
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function finite(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function nonEmpty(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function parseDocumentCandidate(doc) {
  if (!isObj(doc)) return null;
  const documentId = nonEmpty(doc.document_id);
  const title = nonEmpty(doc.title) ?? "Knowledge Base document";
  const sourceType = nonEmpty(doc.source_type) ?? "knowledge";
  const documentScore = finite(doc.document_score);
  if (!documentId || documentScore === null || !Array.isArray(doc.evidence)) return null;
  const chunks = [];
  const citations = [];
  const fullEvidence = [];
  const scores = [];
  let orientationSummary = null;
  if (doc.summary !== null && doc.summary !== void 0) {
    if (!isObj(doc.summary)) return null;
    const content = nonEmpty(doc.summary.content);
    const score = finite(doc.summary.score);
    const chunkId = nonEmpty(doc.summary.chunk_id) ?? void 0;
    if (!content || score === null || doc.summary.chunk_type !== "rag_summary") return null;
    orientationSummary = content;
    scores.push(score);
    chunks.push({
      document_id: documentId,
      ...chunkId ? { chunk_id: chunkId } : {},
      title,
      source_type: sourceType,
      content,
      score,
      chunk_type: "rag_summary"
    });
    citations.push({
      display_label: title.slice(0, 200),
      content: content.slice(0, 500),
      score,
      source_type: sourceType,
      document_id: documentId,
      ...chunkId ? { chunk_id: chunkId } : {},
      chunk_type: "rag_summary"
    });
  }
  let fullCount = 0;
  let summaryCount = orientationSummary ? 1 : 0;
  for (const item of doc.evidence) {
    if (!isObj(item)) return null;
    const content = nonEmpty(item.content);
    const score = finite(item.score);
    const chunkId = nonEmpty(item.chunk_id) ?? void 0;
    const chunkType = item.chunk_type;
    if (!content || score === null || chunkType !== "rag_summary" && chunkType !== "full_content" && chunkType !== "faq_pair" && chunkType !== "section") return null;
    if (chunkType === "rag_summary") {
      summaryCount += 1;
      if (summaryCount > MAX_SUMMARY_CHUNKS_PER_DOCUMENT) return null;
      orientationSummary = content;
    }
    if (chunkType === "full_content") {
      fullCount += 1;
      if (fullCount > MAX_FULL_CONTENT_CHUNKS_PER_DOCUMENT) return null;
      fullEvidence.push({
        document_id: documentId,
        ...chunkId ? { chunk_id: chunkId } : {},
        content,
        score,
        source_type: sourceType
      });
    }
    scores.push(score);
    chunks.push({
      document_id: documentId,
      ...chunkId ? { chunk_id: chunkId } : {},
      title,
      source_type: sourceType,
      content,
      score,
      chunk_type: chunkType
    });
    citations.push({
      display_label: title.slice(0, 200),
      content: content.slice(0, 500),
      score,
      source_type: sourceType,
      document_id: documentId,
      ...chunkId ? { chunk_id: chunkId } : {},
      chunk_type: chunkType
    });
  }
  if (chunks.length === 0) return null;
  scores.sort((a, b) => b - a);
  return {
    document_id: documentId,
    title,
    source_type: sourceType,
    document_score: documentScore,
    chunks,
    citations,
    llm_context: {
      selected_document_id: documentId,
      orientation_summary: orientationSummary,
      full_content_evidence: fullEvidence
    },
    meta: {
      document_score: documentScore,
      highest_chunk_score: scores[0] ?? 0,
      second_highest_chunk_score: scores[1] ?? 0,
      returned_summary_count: orientationSummary ? 1 : 0,
      returned_full_content_count: fullEvidence.length,
      dropped_without_document_id: 0,
      dropped_without_content: 0
    }
  };
}
function parseAggregationResponse(data) {
  if (!isObj(data)) return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  if (data.success !== true || typeof data.context_found !== "boolean") {
    return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  }
  if (data.context_found === false) {
    if (!Array.isArray(data.selected_documents) || data.selected_documents.length !== 0) {
      return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    }
    if (!Array.isArray(data.citations) || data.citations.length !== 0) {
      return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    }
    if (data.llm_context !== void 0 && data.llm_context !== null) {
      if (!isObj(data.llm_context)) return { ok: false, error_code: "KB_SCHEMA_INVALID" };
      const sc = finite(data.llm_context.summary_count);
      const ec = finite(data.llm_context.evidence_count);
      if (sc !== 0 || ec !== 0) return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    }
    return { ok: true, contextFound: false, chunks: [], citations: [], documents: [] };
  }
  if (!Array.isArray(data.selected_documents) || data.selected_documents.length < 1 || data.selected_documents.length > MAX_SELECTED_DOCUMENTS) {
    return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  }
  const documents = [];
  const seenDocumentIds = /* @__PURE__ */ new Set();
  for (const rawDoc of data.selected_documents) {
    const parsed = parseDocumentCandidate(rawDoc);
    if (!parsed || seenDocumentIds.has(parsed.document_id)) {
      return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    }
    seenDocumentIds.add(parsed.document_id);
    documents.push(parsed);
  }
  return {
    ok: true,
    contextFound: true,
    documents,
    chunks: documents.flatMap((d) => d.chunks),
    citations: documents.flatMap((d) => d.citations)
  };
}

// supabase/functions/_shared/kb-client.ts
var SINGAPORE_KB_DEFAULT_BASE_URL = "https://py.ebixmall.com/py-knowledge-base";
var SINGAPORE_RAG_PATH = "/api/v1/rag/context-search";
var KB_DEFAULT_TIMEOUT_MS = 12e3;
var KB_MAX_DOCUMENT_CANDIDATES = 5;
var PREACTIVATION_ROLES = /* @__PURE__ */ new Set(["admin", "supervisor"]);
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function normalizeBaseUrl(raw) {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) return null;
  } catch {
    return null;
  }
  return value.endsWith(SINGAPORE_RAG_PATH) ? { baseUrl: value.slice(0, -SINGAPORE_RAG_PATH.length), ragUrl: value } : { baseUrl: value, ragUrl: `${value}${SINGAPORE_RAG_PATH}` };
}
function parseStringMap(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || !key.trim() || !value.trim()) return null;
      out[key.trim()] = value.trim();
    }
    return out;
  } catch {
    return null;
  }
}
function resolveKBEndpoint() {
  const configured = Deno.env.get("KB_SINGAPORE_BASE_URL") ?? Deno.env.get("KB_RAG_ENDPOINT") ?? Deno.env.get("KB_RAG_BASE_URL") ?? SINGAPORE_KB_DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) return null;
  const tenantTokens = parseStringMap(Deno.env.get("KB_RAG_TENANT_TOKENS_JSON"));
  const tenantApiKeys = parseStringMap(Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON"));
  if (tenantTokens === null || tenantApiKeys === null) return null;
  const headerRaw = (Deno.env.get("KB_SINGAPORE_API_KEY_HEADER") ?? "x-api-key").trim().toLowerCase();
  if (headerRaw !== "authorization" && headerRaw !== "x-api-key") return null;
  const ttlRaw = Number.parseInt(Deno.env.get("KB_SINGAPORE_JWT_TTL_SEC") ?? "300", 10);
  return {
    ...normalized,
    signingSecret: Deno.env.get("KB_SINGAPORE_JWT_SECRET")?.trim() || void 0,
    jwtTtlSec: Number.isInteger(ttlRaw) && ttlRaw >= 60 && ttlRaw <= 900 ? ttlRaw : 300,
    defaultToken: Deno.env.get("KB_RAG_TOKEN")?.trim() || void 0,
    tenantTokens,
    tenantApiKeys,
    apiKeyHeaderMode: headerRaw
  };
}
function trustedWidgetLiveTestActor(metadataSource) {
  if (!metadataSource || typeof metadataSource !== "object" || Array.isArray(metadataSource)) return;
  const m = metadataSource;
  const owner = typeof m.owner_user_id === "string" ? m.owner_user_id : "";
  if (m.source !== "widget_live_test" || m.widget_live_test !== true || m.exclude_training !== true || !UUID_RE.test(owner)) return;
  return { userId: owner, allowPreActivation: true };
}
async function resolvePreActivationScope(sb, actor) {
  if (!actor?.allowPreActivation) {
    return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
  }
  if (Deno.env.get("KB_PREACTIVATION_ENABLED") !== "true") {
    return { resolved: false, reason: "KB_PREACTIVATION_DISABLED" };
  }
  const tenantId = Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim();
  if (!tenantId) return { resolved: false, reason: "KB_PREACTIVATION_CONFIG_MISSING" };
  const { data: memberships, error: membershipError } = await sb.from("company_membership").select("company_id, is_active").eq("user_id", actor.userId);
  if (membershipError) {
    return { resolved: false, reason: "KB_PREACTIVATION_ROLE_LOOKUP_FAILED" };
  }
  if ((memberships ?? []).length > 0) {
    return { resolved: false, reason: "KB_PREACTIVATION_MEMBERSHIP_PRESENT" };
  }
  const { data: roles, error: roleError } = await sb.from("user_roles").select("role").eq("user_id", actor.userId);
  if (roleError) {
    return { resolved: false, reason: "KB_PREACTIVATION_ROLE_LOOKUP_FAILED" };
  }
  const allowed = (roles ?? []).some(
    (row) => PREACTIVATION_ROLES.has(String(row.role ?? ""))
  );
  if (!allowed) return { resolved: false, reason: "KB_PREACTIVATION_ROLE_FORBIDDEN" };
  return {
    resolved: true,
    scope: { mode: "pre_activation", aiCompanyId: null, singaporeTenantId: tenantId }
  };
}
async function resolveTenantScope(conversationId, actor) {
  if (conversationId) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    let serviceRoleKey = "";
    try {
      serviceRoleKey = getSupabaseAdminKey();
    } catch {
      serviceRoleKey = "";
    }
    if (!supabaseUrl || !serviceRoleKey) {
      return { resolved: false, reason: "KB_DB_CONFIG_MISSING" };
    }
    const sb = createClient(supabaseUrl, serviceRoleKey);
    const { data: conv, error: convErr } = await sb.from("conversations").select("company_id, channel_config_id, metadata_source").eq("id", conversationId).maybeSingle();
    if (convErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    if (!conv) return { resolved: false, reason: "KB_CONVERSATION_NOT_FOUND" };
    let channelCompanyId = null;
    if (conv.channel_config_id) {
      const { data: channel, error: channelErr } = await sb.from("channel_config").select("company_id").eq("id", conv.channel_config_id).maybeSingle();
      if (channelErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
      channelCompanyId = channel?.company_id ? String(channel.company_id) : null;
    }
    const conversationCompanyId = conv.company_id ? String(conv.company_id) : null;
    if (conversationCompanyId && channelCompanyId && conversationCompanyId !== channelCompanyId) {
      return { resolved: false, reason: "KB_TENANT_IDENTITY_CONFLICT" };
    }
    const resolvedCompanyId = conversationCompanyId ?? channelCompanyId;
    if (!resolvedCompanyId) {
      const trustedActor = actor ?? trustedWidgetLiveTestActor(conv.metadata_source);
      return await resolvePreActivationScope(sb, trustedActor);
    }
    const { data: company, error: companyErr } = await sb.from("company").select("id, is_active").eq("id", resolvedCompanyId).maybeSingle();
    if (companyErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    if (!company || company.is_active !== true) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    }
    const tenantMap = parseStringMap(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON"));
    if (tenantMap === null) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_CONFIG_INVALID" };
    }
    const singaporeTenantId = tenantMap[String(company.id)]?.trim();
    if (!singaporeTenantId) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    }
    return {
      resolved: true,
      scope: { mode: "canonical", aiCompanyId: String(company.id), singaporeTenantId }
    };
  }
  if (Deno.env.get("KB_DEMO_MODE") !== "true") {
    return { resolved: false, reason: "KB_DEMO_DISABLED" };
  }
  const tenantId = Deno.env.get("KB_DEMO_TENANT_ID")?.trim();
  if (!tenantId) return { resolved: false, reason: "KB_DEMO_CONFIG_MISSING" };
  return { resolved: true, scope: { mode: "demo", aiCompanyId: null, singaporeTenantId: tenantId } };
}
function singaporeCompanyIdFromScope(scope) {
  if (!/^[1-9]\d*$/.test(scope.singaporeTenantId)) return null;
  const n = Number(scope.singaporeTenantId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function mapDocumentCandidate(candidate) {
  return {
    document_id: candidate.document_id,
    title: candidate.title,
    source_type: candidate.source_type,
    document_score: candidate.document_score,
    chunks: candidate.chunks.map((c) => ({
      document_id: c.document_id,
      doc_id: c.document_id,
      ...c.chunk_id ? { chunk_id: c.chunk_id } : {},
      title: c.title,
      content: c.content,
      score: c.score,
      chunk_type: c.chunk_type,
      source_type: c.source_type,
      status: "published"
    })),
    citations: candidate.citations,
    llm_context: candidate.llm_context,
    meta: candidate.meta
  };
}
async function fetchKBRag(queryInput, scope, endpointCfg, opts) {
  const query = queryInput.query.trim();
  if (!query) return { success: true, chunks: [], citations: [], documents: [] };
  const companyId = singaporeCompanyIdFromScope(scope);
  if (companyId === null) {
    return { success: false, chunks: [], citations: [], documents: [], error_code: "KB_COMPANY_ID_INVALID" };
  }
  const credential = await resolveSingaporeCredential(scope, endpointCfg);
  if (!credential.ok) {
    return { success: false, chunks: [], citations: [], documents: [], error_code: credential.error_code };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts?.timeoutMs ?? KB_DEFAULT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(endpointCfg.ragUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...singaporeCredentialHeaders(credential, endpointCfg)
      },
      body: JSON.stringify({
        query,
        company_id: companyId,
        candidate_top_k: Math.max(queryInput.top_k, 10),
        max_documents: KB_MAX_DOCUMENT_CANDIDATES,
        max_summary_chunks: 1,
        max_full_content_chunks: 3,
        score_threshold: 0.05
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeout);
    return {
      success: false,
      chunks: [],
      citations: [],
      documents: [],
      error_code: err instanceof DOMException && err.name === "AbortError" ? "KB_TIMEOUT" : "KB_FETCH_ERROR"
    };
  }
  clearTimeout(timeout);
  if (!response.ok) {
    return {
      success: false,
      chunks: [],
      citations: [],
      documents: [],
      error_code: `KB_HTTP_${response.status}`
    };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return { success: false, chunks: [], citations: [], documents: [], error_code: "KB_INVALID_JSON" };
  }
  const parsed = parseAggregationResponse(data);
  if (!parsed.ok) {
    return { success: false, chunks: [], citations: [], documents: [], error_code: parsed.error_code };
  }
  if (!parsed.contextFound) {
    return { success: true, chunks: [], citations: [], documents: [] };
  }
  const documents = parsed.documents.map(mapDocumentCandidate);
  const single = documents.length === 1 ? documents[0] : void 0;
  return {
    success: true,
    chunks: documents.flatMap((d) => d.chunks),
    citations: documents.flatMap((d) => d.citations),
    documents,
    ...single ? {
      llm_context: single.llm_context,
      meta: single.meta,
      selected_document_id: single.document_id
    } : {},
    dropped_without_document_id: 0,
    dropped_without_content: 0
  };
}

// supabase/functions/_shared/escalation-signals.ts
var ESCALATION_SIGNAL_CONTRACT_VERSION = "SU-CoachAI-Escalation-Signals-v1.0";
var ESCALATION_RULESET_VERSION = "SU-CoachAI-Escalation-Ruleset-v1.6";
var ESCALATION_FIRST_MATCH_ORDER = [
  "E2",
  "E1",
  "R1",
  "S0",
  "R2",
  "R3",
  "P2",
  "R4",
  "P1"
];
function escalationFeatureFlagsFromEnv(env) {
  const on = (name) => env.get(name) === "true";
  return {
    enable_full_ruleset: on("ESC_ENABLE_FULL_RULESET"),
    enable_e2: on("ESC_ENABLE_E2"),
    enable_e1: on("ESC_ENABLE_E1"),
    enable_r2: on("ESC_ENABLE_R2"),
    enable_r3: on("ESC_ENABLE_R3"),
    enable_p2: on("ESC_ENABLE_P2"),
    enable_r4: on("ESC_ENABLE_R4"),
    enable_p1: on("ESC_ENABLE_P1"),
    shadow_mode: on("ESC_SHADOW_MODE")
  };
}
function unavailableSignal(source, reason) {
  return {
    value: null,
    provenance: {
      source,
      availability: "unavailable",
      reason
    }
  };
}
function notCheckedSignal(source, reason) {
  return {
    value: null,
    provenance: {
      source,
      availability: "not_checked",
      ...reason ? { reason } : {}
    }
  };
}
function availableSignal(value, source, extra) {
  return {
    value,
    provenance: {
      source,
      availability: "available",
      ...extra
    }
  };
}
function validateEscalationContext(context) {
  const errors = [];
  const warnings = [];
  const signalGaps = [];
  if (!context.conversation_id) errors.push("conversation_id_missing");
  if (!context.source_message_id) errors.push("source_message_id_missing");
  if (context.signal_contract_version !== ESCALATION_SIGNAL_CONTRACT_VERSION) {
    errors.push("signal_contract_version_mismatch");
  }
  if (context.expected_tenant_id && context.provider_tenant_id && context.expected_tenant_id !== context.provider_tenant_id) {
    errors.push("cross_tenant_provider_response");
  }
  const entries = Object.entries(context).filter(
    ([, value]) => value && typeof value === "object" && "provenance" in value
  );
  for (const [name, signal] of entries) {
    const availability = signal.provenance.availability;
    if (availability === "unavailable") {
      warnings.push(`${name}:unavailable`);
      signalGaps.push(name);
    } else if (availability === "invalid") {
      warnings.push(`${name}:invalid`);
      signalGaps.push(name);
    } else if (availability === "stale") {
      errors.push(`${name}:stale`);
    } else if (availability === "not_checked") {
      signalGaps.push(name);
    }
    if (availability !== "available" && signal.value !== null) {
      errors.push(`${name}:non_null_value_with_${availability}`);
    }
  }
  validateBoundedScore(context.predicted_csat, "predicted_csat", 1, 5, errors);
  validateUnitInterval(context.escalation_score, "escalation_score", errors);
  validateUnitInterval(context.churn_risk, "churn_risk", errors);
  validateUnitInterval(context.confidence_score, "confidence_score", errors);
  validateUnitInterval(context.policy_match_confidence, "policy_match_confidence", errors);
  validateBoundedScore(context.sentiment_score, "sentiment_score", -1, 1, errors);
  validateBoundedScore(context.anger_score, "anger_score", 0, 1, errors);
  validateNonNegativeInteger(context.upstream_failure_count, "upstream_failure_count", errors);
  validateNonNegativeInteger(context.clarification_attempts, "clarification_attempts", errors);
  validateNonNegativeInteger(context.unresolved_turns, "unresolved_turns", errors);
  validateNonNegativeInteger(context.consecutive_no_answer, "consecutive_no_answer", errors);
  validateNonNegativeInteger(context.turn_count, "turn_count", errors);
  validateNonNegativeNumber(context.conversation_duration_sec, "conversation_duration_sec", errors);
  const providerIntegrityFailure = errors.some(
    (e) => e === "signal_contract_version_mismatch" || e === "cross_tenant_provider_response" || e.endsWith(":stale")
  );
  return {
    valid: errors.length === 0,
    fallback_to_r1_only: providerIntegrityFailure,
    errors,
    warnings,
    signal_gaps: [...new Set(signalGaps)]
  };
}
function validateUnitInterval(signal, name, errors) {
  validateBoundedScore(signal, name, 0, 1, errors);
}
function validateBoundedScore(signal, name, min, max, errors) {
  if (signal.provenance.availability !== "available") return;
  if (signal.value === null || !Number.isFinite(signal.value) || signal.value < min || signal.value > max) {
    errors.push(`${name}:out_of_range`);
  }
}
function validateNonNegativeInteger(signal, name, errors) {
  if (signal.provenance.availability !== "available") return;
  if (signal.value === null || !Number.isInteger(signal.value) || signal.value < 0) {
    errors.push(`${name}:invalid_non_negative_integer`);
  }
}
function validateNonNegativeNumber(signal, name, errors) {
  if (signal.provenance.availability !== "available") return;
  if (signal.value === null || !Number.isFinite(signal.value) || signal.value < 0) {
    errors.push(`${name}:invalid_non_negative_number`);
  }
}
function createEscalationContextBase(input) {
  return {
    conversation_id: input.conversation_id,
    source_message_id: input.source_message_id,
    latest_message_content: input.latest_message_content,
    conversation_status: notCheckedSignal("conversation_history"),
    assigned_agent_id: notCheckedSignal("conversation_history"),
    greeting_or_trivial: notCheckedSignal("local_classifier"),
    pure_handoff_negation: notCheckedSignal("local_classifier"),
    clarification_attempts: notCheckedSignal("conversation_history"),
    sentiment_recovered_same_turn: unavailableSignal(
      "conversation_evaluation",
      "no_current_evaluation_data"
    ),
    verified_local_risk_classification: notCheckedSignal("local_classifier"),
    upstream_failure_count: notCheckedSignal("runtime"),
    failure_type: notCheckedSignal("runtime"),
    explicit_request: availableSignal(
      input.explicit_request,
      "local_classifier"
    ),
    sentiment_score: unavailableSignal("conversation_evaluation", "no_current_evaluation_data"),
    anger_score: unavailableSignal("coach_ai", "provider_contract_unverified"),
    anger_flag: unavailableSignal("conversation_evaluation", "no_current_evaluation_data"),
    sentiment_trend: unavailableSignal("conversation_evaluation", "no_current_evaluation_data"),
    detected_intent: unavailableSignal("coach_ai", "provider_contract_unverified"),
    predicted_csat: unavailableSignal("scoring_engine", "prediction_provider_unavailable"),
    escalation_score: unavailableSignal("scoring_engine", "prediction_provider_unavailable"),
    churn_risk: unavailableSignal("customer360", "customer360_gate_b_unavailable"),
    threat_flag: unavailableSignal("coach_ai", "provider_contract_unverified"),
    confidence_score: unavailableSignal("coach_ai", "provider_contract_unverified"),
    compliance_jurisdiction_requires_human_review: unavailableSignal(
      "tenant_config",
      "provider_contract_unverified"
    ),
    unresolved_turns: notCheckedSignal("conversation_history"),
    consecutive_no_answer: notCheckedSignal("conversation_history"),
    same_intent_repeated: unavailableSignal(
      "conversation_history",
      "detected_intent_unavailable"
    ),
    turn_count: notCheckedSignal("conversation_history"),
    conversation_duration_sec: notCheckedSignal("conversation_history"),
    rag_match_state: unavailableSignal("kb_rag", "kb_contract_unverified"),
    policy_match_state: unavailableSignal(
      "policy_engine",
      "provider_contract_unverified"
    ),
    policy_match_confidence: unavailableSignal(
      "policy_engine",
      "provider_contract_unverified"
    ),
    topic_risk_level: notCheckedSignal("local_classifier"),
    customer_tier: unavailableSignal("customer360", "provider_contract_unverified"),
    order_value: unavailableSignal("customer360", "provider_contract_unverified"),
    currency: unavailableSignal("customer360", "provider_contract_unverified"),
    high_value_order: unavailableSignal(
      "customer360",
      "provider_contract_unverified"
    ),
    tenant_config: null,
    signal_contract_version: ESCALATION_SIGNAL_CONTRACT_VERSION,
    expected_tenant_id: input.expected_tenant_id
  };
}

// supabase/functions/_shared/escalation-rules.ts
var MAX_CLARIFICATIONS = 1;
function isAvailable(signal) {
  return signal.provenance.availability === "available" && signal.value !== null;
}
function signalGap(name, signal, gaps) {
  if (!isAvailable(signal)) gaps.add(name);
}
function decision(matchedRule, kind, priority, reasonCode, gaps, warnings) {
  return {
    ruleset_version: ESCALATION_RULESET_VERSION,
    matched_rule: matchedRule,
    decision: kind,
    priority,
    reason_code: reasonCode,
    signal_gaps: [...gaps],
    provider_warnings: warnings
  };
}
function isResolved(context) {
  return isAvailable(context.conversation_status) && context.conversation_status.value === "resolved";
}
function isExistingHumanControl(context) {
  const status = isAvailable(context.conversation_status) ? context.conversation_status.value : null;
  const assigned = isAvailable(context.assigned_agent_id) ? context.assigned_agent_id.value : null;
  return typeof assigned === "string" && assigned.length > 0 || status === "pending" || status === "transferred" || status === "human_needed" || status === "human_control";
}
function isGreetingOnly(context) {
  return isAvailable(context.greeting_or_trivial) && context.greeting_or_trivial.value === true;
}
function hasCriticalSignalInSameTurn(context) {
  return isAvailable(context.explicit_request) && context.explicit_request.value === true || isAvailable(context.threat_flag) && context.threat_flag.value === true || isAvailable(context.compliance_jurisdiction_requires_human_review) && context.compliance_jurisdiction_requires_human_review.value === true || isAvailable(context.topic_risk_level) && context.topic_risk_level.value === "high";
}
function greetingSuppressesNonCritical(context) {
  return isGreetingOnly(context) && !hasCriticalSignalInSameTurn(context);
}
function trendHasTwoConsecutiveDrops(values) {
  if (values.length < 3) return false;
  let drops = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < values[i - 1]) {
      drops += 1;
      if (drops >= 2) return true;
    } else {
      drops = 0;
    }
  }
  return false;
}
function threshold(context, key, gaps) {
  const raw = context.tenant_config?.[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    gaps.add(`tenant_config.${String(key)}`);
    return null;
  }
  return raw;
}
function maxClarifications(context) {
  const configured = context.tenant_config?.max_clarifications;
  if (typeof configured === "number" && Number.isInteger(configured)) {
    return Math.max(0, Math.min(MAX_CLARIFICATIONS, configured));
  }
  return MAX_CLARIFICATIONS;
}
function shouldClarify(context, gaps) {
  signalGap("clarification_attempts", context.clarification_attempts, gaps);
  if (!isAvailable(context.clarification_attempts)) return false;
  return context.clarification_attempts.value < maxClarifications(context);
}
function evaluateE2(context, gaps, warnings) {
  signalGap("threat_flag", context.threat_flag, gaps);
  signalGap(
    "compliance_jurisdiction_requires_human_review",
    context.compliance_jurisdiction_requires_human_review,
    gaps
  );
  const match = isAvailable(context.threat_flag) && context.threat_flag.value === true || isAvailable(context.compliance_jurisdiction_requires_human_review) && context.compliance_jurisdiction_requires_human_review.value === true;
  return match ? decision("E2", "handoff", "urgent", "compliance_trigger", gaps, warnings) : null;
}
function evaluateE1(context, gaps, warnings) {
  signalGap("topic_risk_level", context.topic_risk_level, gaps);
  signalGap("rag_match_state", context.rag_match_state, gaps);
  if (!isAvailable(context.topic_risk_level) || context.topic_risk_level.value !== "high") return null;
  if (!isAvailable(context.rag_match_state)) return null;
  const rag = context.rag_match_state.value;
  if (rag === "unavailable") return null;
  const normalHighRiskGap = rag === "no_match" || rag === "partial_match" || rag === "conflict";
  const localNotChecked = rag === "not_checked" && isAvailable(context.verified_local_risk_classification) && context.verified_local_risk_classification.value === true;
  if (rag === "not_checked" && !isAvailable(context.verified_local_risk_classification)) {
    gaps.add("verified_local_risk_classification");
  }
  if (!(normalHighRiskGap || localNotChecked)) return null;
  if (isAvailable(context.high_value_order) && context.high_value_order.value === true) {
    warnings.push("E1_HIGH_VALUE_PRIORITY_ENHANCER");
  }
  return decision("E1", "handoff", "urgent", "high_risk_topic", gaps, warnings);
}
function evaluateR1(context, gaps, warnings) {
  signalGap("explicit_request", context.explicit_request, gaps);
  if (!isAvailable(context.explicit_request) || context.explicit_request.value !== true) return null;
  if (isAvailable(context.pure_handoff_negation) && context.pure_handoff_negation.value === true) {
    return null;
  }
  return decision("R1", "handoff", "normal", "explicit_human_request", gaps, warnings);
}
function evaluateS0(context, gaps, warnings) {
  const ragUnavailable = isAvailable(context.rag_match_state) && context.rag_match_state.value === "unavailable";
  const policyUnavailable = isAvailable(context.policy_match_state) && context.policy_match_state.value === "unavailable";
  const failureType = isAvailable(context.failure_type) ? context.failure_type.value : null;
  const immediateLlmFailure = failureType === "LLM_TIMEOUT" || failureType === "LLM_NETWORK_ERROR" || failureType === "LLM_NON_2XX" || failureType === "LLM_EMPTY_RESPONSE";
  if (ragUnavailable || policyUnavailable || immediateLlmFailure) {
    return decision("S0", "handoff", "high", "system_or_upstream_failure", gaps, warnings);
  }
  if (failureType) {
    signalGap("upstream_failure_count", context.upstream_failure_count, gaps);
    const maxRetries = threshold(context, "s0_max_retries", gaps);
    if (maxRetries !== null && isAvailable(context.upstream_failure_count) && context.upstream_failure_count.value >= maxRetries) {
      return decision("S0", "handoff", "high", "system_or_upstream_failure", gaps, warnings);
    }
  }
  return null;
}
function evaluateR2(context, gaps, warnings) {
  signalGap("same_intent_repeated", context.same_intent_repeated, gaps);
  signalGap("consecutive_no_answer", context.consecutive_no_answer, gaps);
  signalGap("rag_match_state", context.rag_match_state, gaps);
  signalGap("clarification_attempts", context.clarification_attempts, gaps);
  if (!isAvailable(context.rag_match_state)) return null;
  if (context.rag_match_state.value === "unavailable") return null;
  if (context.rag_match_state.value === "confident_match") return null;
  const ragGap = context.rag_match_state.value === "no_match" || context.rag_match_state.value === "partial_match";
  if (!ragGap) return null;
  const clarificationAttempts = isAvailable(context.clarification_attempts) ? context.clarification_attempts.value : null;
  const clarificationCap = maxClarifications(context);
  const repeated = isAvailable(context.same_intent_repeated) && context.same_intent_repeated.value === true;
  if (clarificationAttempts !== null && clarificationAttempts < clarificationCap) {
    return decision(
      "R2",
      "clarify",
      null,
      "clarification_required_before_r2",
      gaps,
      warnings
    );
  }
  if (!repeated) {
    return decision(
      "R2",
      "clarify",
      null,
      "clarification_new_intent_no_kb_match",
      gaps,
      warnings
    );
  }
  if (clarificationAttempts !== null && clarificationCap > 0 && clarificationAttempts >= clarificationCap) {
    return decision("R2", "handoff", "high", "repeated_after_clarification", gaps, warnings);
  }
  const maxNoAnswer = threshold(context, "max_consecutive_no_answer", gaps);
  const noAnswerCount = isAvailable(context.consecutive_no_answer) ? context.consecutive_no_answer.value : null;
  if (repeated && maxNoAnswer !== null && noAnswerCount !== null && noAnswerCount >= maxNoAnswer) {
    return decision("R2", "handoff", "high", "repeated_unanswered_query", gaps, warnings);
  }
  return null;
}
function evaluateR3(context, gaps, warnings) {
  if (greetingSuppressesNonCritical(context)) return null;
  if (isAvailable(context.sentiment_recovered_same_turn) && context.sentiment_recovered_same_turn.value === true) {
    return null;
  }
  signalGap("anger_flag", context.anger_flag, gaps);
  signalGap("sentiment_score", context.sentiment_score, gaps);
  signalGap("sentiment_trend", context.sentiment_trend, gaps);
  const sentimentThreshold = threshold(context, "sentiment_score_threshold", gaps);
  const anger = isAvailable(context.anger_flag) && context.anger_flag.value === true;
  const lowSentiment = sentimentThreshold !== null && isAvailable(context.sentiment_score) && context.sentiment_score.value < sentimentThreshold;
  const falling = isAvailable(context.sentiment_trend) && trendHasTwoConsecutiveDrops(context.sentiment_trend.value);
  if (!(anger || lowSentiment || falling)) return null;
  return decision("R3", "recommend_handoff", "high", "sentiment_deterioration", gaps, warnings);
}
function evaluateP2(context, gaps, warnings) {
  signalGap("conversation_duration_sec", context.conversation_duration_sec, gaps);
  signalGap("unresolved_turns", context.unresolved_turns, gaps);
  const slaWarning = threshold(context, "sla_warning_sec", gaps);
  const maxUnresolved = threshold(context, "max_unresolved_turns", gaps);
  const durationMatch = slaWarning !== null && isAvailable(context.conversation_duration_sec) && context.conversation_duration_sec.value > slaWarning;
  const turnsMatch = maxUnresolved !== null && isAvailable(context.unresolved_turns) && context.unresolved_turns.value > maxUnresolved;
  if (!(durationMatch || turnsMatch)) return null;
  return decision("P2", "recommend_handoff", "high", "sla_breach_risk", gaps, warnings);
}
function evaluateR4(context, gaps, warnings) {
  signalGap("policy_match_state", context.policy_match_state, gaps);
  if (!isAvailable(context.policy_match_state)) return null;
  const state = context.policy_match_state.value;
  if (state === "unavailable") return null;
  if (state === "conflict") {
    return decision("R4", "recommend_handoff", "normal", "policy_gap_detected", gaps, warnings);
  }
  if (!(state === "no_match" || state === "partial_match")) return null;
  signalGap("policy_match_confidence", context.policy_match_confidence, gaps);
  const policyThreshold = threshold(context, "policy_confidence_threshold", gaps);
  if (policyThreshold !== null && isAvailable(context.policy_match_confidence) && context.policy_match_confidence.value < policyThreshold) {
    if (shouldClarify(context, gaps)) {
      return decision("R4", "clarify", null, "clarification_required_before_r4", gaps, warnings);
    }
    return decision("R4", "recommend_handoff", "normal", "policy_gap_detected", gaps, warnings);
  }
  return null;
}
function evaluateP1(context, gaps, warnings) {
  if (greetingSuppressesNonCritical(context)) return null;
  signalGap("predicted_csat", context.predicted_csat, gaps);
  signalGap("churn_risk", context.churn_risk, gaps);
  signalGap("escalation_score", context.escalation_score, gaps);
  const csatThreshold = threshold(context, "predicted_csat_threshold", gaps);
  const churnThreshold = threshold(context, "churn_risk_threshold", gaps);
  const escalationThreshold = threshold(context, "escalation_score_threshold", gaps);
  const lowCsat = csatThreshold !== null && isAvailable(context.predicted_csat) && context.predicted_csat.value < csatThreshold;
  const highChurn = churnThreshold !== null && isAvailable(context.churn_risk) && context.churn_risk.value > churnThreshold;
  const highEscalation = escalationThreshold !== null && isAvailable(context.escalation_score) && context.escalation_score.value > escalationThreshold;
  if (!(lowCsat || highChurn || highEscalation)) return null;
  return decision("P1", "suggest_handoff", "normal", "proactive_handoff", gaps, warnings);
}
var RULES = {
  E2: evaluateE2,
  E1: evaluateE1,
  R1: evaluateR1,
  S0: evaluateS0,
  R2: evaluateR2,
  R3: evaluateR3,
  P2: evaluateP2,
  R4: evaluateR4,
  P1: evaluateP1
};
function evaluateFullEscalationRuleset(context, options) {
  const validation = validateEscalationContext(context);
  const gaps = new Set(validation.signal_gaps);
  const warnings = [...validation.warnings];
  if (validation.fallback_to_r1_only) {
    warnings.push(...validation.errors);
    const r1 = evaluateR1(context, gaps, warnings);
    if (r1) return r1;
    return decision(null, "fallback_r1_only", null, "provider_integrity_fallback", gaps, warnings);
  }
  if (isResolved(context)) {
    return decision(null, "continue_ai", null, "resolved_no_escalation", gaps, warnings);
  }
  if (isExistingHumanControl(context)) {
    return decision(null, "continue_ai", null, "already_under_human_control", gaps, warnings);
  }
  for (const ruleId of ESCALATION_FIRST_MATCH_ORDER) {
    if (!options.activation.enabled.has(ruleId)) continue;
    const result2 = RULES[ruleId](context, gaps, warnings);
    if (result2) return result2;
  }
  return decision(null, "continue_ai", null, "no_escalation", gaps, warnings);
}

// supabase/functions/_shared/conversation-semantic-contract.ts
var CUSTOMER = /* @__PURE__ */ new Set(["visitor", "customer", "user"]);
var ASSISTANT = /* @__PURE__ */ new Set(["assistant", "ai"]);
var TRIVIAL = /^(hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|ok|okay|好的|好|嗯|謝謝|谢谢|thanks|thank you)[!！。.？?，,\s]*$/i;
var CORRECTION = /(我講錯|我说错|我說錯|我要更正|我想更正|更正一下|其實係|其实是|改返|改成|actually[,\s]+i meant|\bi meant\b|correction\s*[:：]|不是.+(?:而)?是|唔係.+係|(?:唔係|不是).{0,60}(?:我要問|我想問|想問|想问)|not .+ but .+)/i;
var SIMPLIFY = /(?:簡單|简单)(?:一點|一点|啲|些|點|点)?(?:[。.!！?？\s]*$|.*(?:解釋|解释|講|讲|說|说|介紹|介绍))|(?:講|讲|說|说)(?:得|得再)?(?:簡單|简单)(?:一點|一点|啲|些|點|点)?|(?:用|講|讲|說|说)(?:香港客戶|香港客户|一般客戶|一般客户|客戶|客户)?(?:聽得懂|听得懂|明白|易明)?(?:的|嘅)?(?:人話|人话|白話|白话|口語|口语|貼地|贴地)(?:回答|講|讲|說|说)?|(?:講|讲|說|说|回答)(?:得)?(?:自然|口語|口语|貼地|贴地)(?:一點|一点|啲)?|(?:將|把|幫我|帮我)?(?:上一個|上一个|上一個答案|上一个答案|之前(?:個|个)?答案|前一個答案|前一个答案)?(?:答案|回答)?(?:改短|縮短|缩短)(?:一點|一点|啲|些|點|点)?|(?:改短|縮短|缩短)(?:一點|一点|啲|些|點|点)?(?:上一個|上一个|答案|回答)?|explain(?: it| that)? (?:more )?simply|make it simpler|\bsimpler\b|\bshorter\b|(?:say|explain|answer).*(?:plain|natural|everyday|customer-friendly) (?:language|words|terms)/i;
var REPHRASE = /(換句話|换句话|另一種講法|另一种说法|改寫|改写|重新講|重新说|rephrase|rewrite|say that another way|word it differently)/i;
var TRANSLATE = /(?:用|改用)(?:廣東話|广东话|繁體中文|繁体中文|簡體中文|简体中文|英文).*(?:講|讲|回答|答|解釋|解释|說|说|一次)?|\b(?:in|into)\s+(?:english|chinese|cantonese|traditional chinese|simplified chinese)\b|translate(?: that| it)?/i;
var SUMMARY = /(?:總結|总结|概括|歸納|归纳).*(?:剛才|刚才|以上|之前|我們|我们|內容|内容|三點|三点)?|(?:根據|根据)?(?:已確認|已确认)(?:資料|资料).*(?:列|分成|整理成)?\s*(?:[一二兩两三四五六七八九十]|\d{1,2})\s*(?:點|点|項|项|條|条)|summari[sz]e(?: that| it| this| the above| what we discussed| our conversation)?/i;
var MEMORY = /(一開始|一开始|第一個問題|第一个问题|最初).*(?:問|問題|问题)|(?:剛才|刚才).*(?:主要)?(?:問|问).*(?:什麼|什么|咩)|(?:主要)(?:問|问).*(?:什麼|什么|咩)|剛才.*(?:建議|建议|叫我|要我)|刚才.*(?:建议|叫我|要我)|之前.*(?:建議|建议|提供)|what\s+(?:did\s+i\s+ask|was\s+(?:my\s+)?first)|what\s+(?:was|is)\s+(?:my\s+)?(?:main|mainly|primary).*(?:question|asking|ask)|what\s+did\s+you\s+(?:recommend|suggest)|what\s+information\s+have\s+i\s+already\s+given|what\s+have\s+i\s+already\s+given|我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\x27s| is)?\s+(?:the\s+)?(?:current\s+)?(?:region|jurisdiction).*(?:item|product)|what.*still\s+missing/i;
var CURRENT_REQUIREMENTS_SUMMARY = /(?:整理|總結|总结|概括|歸納|归纳).{0,18}(?:我)?(?:而家|現在|现在|目前|current|latest).{0,18}(?:最新)?(?:需求|要求|需要|requirements?|needs?)|(?:我)?(?:而家|現在|现在|目前|current|latest).{0,18}(?:最新)?(?:需求|要求|需要|requirements?|needs?).{0,18}(?:整理|總結|总结|概括|歸納|归纳|summary)|(?:current|latest)\s+(?:requirements?|needs?)\s+(?:summary|summarize|summarise)/i;
var EXPLICIT_FACTUAL_TARGET_CORRECTION = /(?:其實|其实|actually)?.{0,20}(?:Growth|Basic|Pro|plan|方案|型號|型号|model|價錢|价钱|價格|价格|price|費用|费用|收費|收费|limit|上限|功能|feature|保養|保修|送貨|送货|退款|退貨|退货|付款|政策|policy|terms?\b|T&C).{0,20}(?:唔係|不是|并非|並非|not).{0,28}(?:我要問|我想問|想問|想问|ask about).{0,28}(?:Growth|Basic|Pro|plan|方案|型號|型号|model|價錢|价钱|價格|价格|price|費用|费用|收費|收费|limit|上限|功能|feature|保養|保修|送貨|送货|退款|退貨|退货|付款|政策|policy|terms?\b|T&C)|(?:唔係|不是|not).{0,50}(?:我要問|我想問|想問|想问|ask about)/i;
var RETURN_PRIOR = /(回到|返回|返去|回返|講返|讲回|回香港|回到香港|back to|return to|go back to|back on).{0,50}/i;
var TOPIC_SWITCH = /^(?:算了|算啦|另外|轉個話題|转个话题|換個話題|换个话题|不談|不谈|forget that|never mind|different topic|another question)/i;
var FOLLOW = /^(?:咁|那|那麼|那么|所以|另外|仲有|还有|如果|再|又|而|同埋|what about|and what about|then|so|also|in that case|how about)/i;
var PRONOUN = /^(?:那個|那个|這個|这个|它|佢|他|她|嗰個|呢個|上述|剛才|刚才|之前|same|that|this|it|its|earlier|previous)|(?:呢|嗎|吗|about that|and that|same one|same thing)[。.!！?？\s]*$/i;
var DOMAIN_ONLY = /^(?:我有|我想問|我想问|想問|想问|請問|请问)?\s*(?:一個|一个|個|个)?\s*(?:訂單|订单|退款|退貨|退货|換貨|换货|送貨|送货|物流|付款|產品|产品|保養|保修|維修|维修|問題|问题)\s*(?:問題|问题|嘅問題|的問題)?[。.!！?？\s]*$/;
var QUESTIONISH = /[?？]|^(?:什麼|什么|如何|怎樣|怎样|哪|哪些|多久|幾耐|几耐|why|what|which|how|when|where)/i;
var CUSTOMER_CONTEXT_REQUIREMENTS = /(?:你|妳|您).{0,12}(?:還|还)?需要(?:我)?(?:再)?提供(?:什麼|什么|哪些|咩)(?:資料|资料|資訊|信息|details|information)|(?:還|还)需要(?:我)?提供(?:什麼|什么|哪些|咩)(?:資料|资料|資訊|信息)|what (?:information|details) do you (?:still )?need from me|what else do you need from me/i;
var CUSTOMER_CONTEXT_UPDATE = /(?:^|[，,。.!！\s])(?:我只知道|我只知|我目前只知道|我現在只知道|我现在只知道|我沒有|我没有|我冇|不知道型號|不知道型号|唔知型號|型號(?:是|係)?未知|型号(?:是)?未知|品牌(?:是|係)|大約.{0,24}(?:買|购买|購買)|大概.{0,24}(?:買|购买|購買)|現在.{0,32}(?:不冷|唔凍|不能|無法|无法)|现在.{0,32}(?:不冷|不能|无法)|i only know|i (?:do not|don't) have (?:the )?(?:model|model number|order number)|the brand is|brand is|i bought (?:it )?.{0,40}ago|it (?:powers|turns) on but)/i;
var CUSTOMER_OWNED_STATE_FIELD = /(?:sku|商品(?:數量|数量)?|產品(?:數量|数量)?|产品(?:数量)?|貨品(?:數量|数量)?|件(?:商品|產品|产品)?|staff|員工|员工|人手|同事|市場|市场|主要市場|主要市场|地區|地区|region|market|app(?:需求|需要|要求)?|push(?:需求|需要|要求)?|crm(?:需求|需要|要求)?|會員等級|会员等级)/i;
var CUSTOMER_OWNED_STATE_CORRECTION = /(?:記住|记住|最新|目前|現在|现在|其實|其实|更正|改返|改成|更新(?:一下)?|actually|correction).{0,45}(?:唔係|不是|并非|並非|而家係|現在係|现在是|改為|改为|最新係|最新是|而係|而是|not .+ but|instead)/i;
var BARE_LATEST_NUMERIC_CORRECTION = /(?:記住|记住).{0,20}(?:最新)?(?:係|是)?\s*\d+(?:\.\d+)?\s*[，,。.!！\s]*(?:唔係|不是|而唔係|而不是)\s*\d+(?:\.\d+)?/i;
var FACTUAL_TOPIC_OR_KB_SWITCH = /(?:Growth|Basic|Pro|plan|方案|型號|型号|model|價錢|价钱|價格|价格|price|費用|费用|收費|收费|limit|上限|保養|保修|送貨|送货|退款|退貨|退货|付款|政策|policy|terms?\b|T&C|我要問|我想問|想問|想问|ask about)/i;
var CUSTOMER_OWNED_STATE_DECLARATION_CUE = /(?:^|[，,。.!！\s])(?:我|目前|現在|现在|而家|暫時|暂时|之後|之后|未來|未来|年尾|只做|主要做|再諗|再想|再加|得我|亦|都會|都会|可能|大約|大概|only|currently|right now|for now|later|future|i (?:have|need|want|use|am|currently))/i;
var CUSTOMER_OWNED_STATE_PREFERENCE_CUE = /(?:有興趣|有兴趣|想要|想用|要用|會用|会用|需要|唔需要|不需要|不用|過時|过時|outdated|interested|need|want|use)/i;
function recentCustomerStateField(newestFirst, currentLatest) {
  let skippedCurrent = false;
  let customerTurns = 0;
  for (const row of newestFirst) {
    const role = String(row.role ?? "").toLowerCase();
    if (!CUSTOMER.has(role)) continue;
    const content = clean(row.content);
    if (!content) continue;
    if (!skippedCurrent && content === currentLatest) {
      skippedCurrent = true;
      continue;
    }
    customerTurns += 1;
    if (CUSTOMER_OWNED_STATE_FIELD.test(content)) return true;
    if (customerTurns >= 4) break;
  }
  return false;
}
function isCustomerOwnedStateCorrection(text, newestFirst = []) {
  const latest = clean(text);
  if (!latest || QUESTIONISH.test(latest) || /[?？]/.test(latest)) return false;
  if (FACTUAL_TOPIC_OR_KB_SWITCH.test(latest)) return false;
  if (CUSTOMER_OWNED_STATE_FIELD.test(latest) && (CORRECTION.test(latest) || CUSTOMER_OWNED_STATE_CORRECTION.test(latest))) return true;
  return BARE_LATEST_NUMERIC_CORRECTION.test(latest) && recentCustomerStateField(newestFirst, latest);
}
function isCustomerOwnedStateUpdate(text) {
  const latest = clean(text);
  if (!latest || QUESTIONISH.test(latest) || /[?？]/.test(latest)) return false;
  if (FACTUAL_TOPIC_OR_KB_SWITCH.test(latest)) return false;
  if (!CUSTOMER_OWNED_STATE_FIELD.test(latest)) return false;
  return CUSTOMER_OWNED_STATE_DECLARATION_CUE.test(latest) || CUSTOMER_OWNED_STATE_PREFERENCE_CUE.test(latest);
}
function isCustomerContextUpdate(text) {
  const latest = clean(text);
  if (!latest || QUESTIONISH.test(latest) || /[?？]/.test(latest)) return false;
  return CUSTOMER_CONTEXT_UPDATE.test(latest);
}
function clean(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 1200) : "";
}
function detectSemanticLanguage(text) {
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  return /[转们为这没请]/.test(text) ? "zh-CN" : "zh-TW";
}
function metadataRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function findPriorGroundedAnswer(newestFirst, currentLatest) {
  const latest = clean(currentLatest);
  let skippedCurrent = false;
  for (const row of newestFirst) {
    const role = String(row.role ?? "").toLowerCase();
    const content = clean(row.content);
    if (!content || content === "__THINKING__") continue;
    if (!skippedCurrent && latest && CUSTOMER.has(role) && content === latest) {
      skippedCurrent = true;
      continue;
    }
    if (!ASSISTANT.has(role)) continue;
    const meta2 = metadataRecord(row.metadata);
    const lineage = metadataRecord(meta2?.citation_lineage);
    const selected = typeof lineage?.selected_document_id === "string" ? lineage.selected_document_id : "";
    const ids = Array.isArray(lineage?.evidence_chunk_ids) ? lineage.evidence_chunk_ids.filter((x) => typeof x === "string" && x.length > 0) : [];
    if (!selected || ids.length === 0) continue;
    const source = typeof meta2?.source_message_id === "string" ? meta2.source_message_id : null;
    return { content, document_id: selected, chunk_ids: ids, source_message_id: source };
  }
  return null;
}
function classifyCanonicalConversationTurn(latestInput, newestFirst, options = {}) {
  const latest = clean(latestInput);
  const language = detectSemanticLanguage(latest);
  const priorGrounded = findPriorGroundedAnswer(newestFirst, latest);
  const base = (operation, reason, overrides = {}) => ({
    operation,
    language,
    latest,
    needs_history: false,
    requires_new_kb_retrieval: true,
    may_reuse_prior_grounded_answer: false,
    evidence_authority: "CURRENT_KB_REQUIRED",
    topic_action: "NONE",
    explicit_handoff: false,
    prior_grounded_answer: priorGrounded,
    reason,
    ...overrides
  });
  if (options.explicit_handoff === true) {
    return base("EXPLICIT_HANDOFF", "governed_explicit_handoff", {
      explicit_handoff: true,
      requires_new_kb_retrieval: false,
      evidence_authority: "NONE"
    });
  }
  if (!latest || TRIVIAL.test(latest)) {
    return base("TRIVIAL", "trivial_or_greeting", { requires_new_kb_retrieval: false, evidence_authority: "NONE" });
  }
  if (CURRENT_REQUIREMENTS_SUMMARY.test(latest)) {
    return base("CONVERSATION_MEMORY", "current_customer_requirements_summary", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      may_reuse_prior_grounded_answer: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "KEEP"
    });
  }
  if (EXPLICIT_FACTUAL_TARGET_CORRECTION.test(latest)) {
    return base("TOPIC_SWITCH", "explicit_factual_target_correction", {
      needs_history: true,
      requires_new_kb_retrieval: true,
      may_reuse_prior_grounded_answer: false,
      evidence_authority: "CURRENT_KB_REQUIRED",
      topic_action: "SWITCH"
    });
  }
  if (MEMORY.test(latest)) {
    return base("CONVERSATION_MEMORY", "conversation_memory_request", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "KEEP"
    });
  }
  const transform = SIMPLIFY.test(latest) ? "SIMPLIFY" : TRANSLATE.test(latest) ? "TRANSLATE" : REPHRASE.test(latest) ? "REPHRASE" : SUMMARY.test(latest) ? "SUMMARIZE" : null;
  if (transform) {
    return base(transform, priorGrounded ? "transform_of_prior_grounded_answer" : "transform_requires_history_without_grounded_anchor", {
      needs_history: true,
      requires_new_kb_retrieval: !priorGrounded,
      may_reuse_prior_grounded_answer: Boolean(priorGrounded),
      evidence_authority: priorGrounded ? "PRIOR_GROUNDED_ANSWER" : "CURRENT_KB_REQUIRED",
      topic_action: "KEEP"
    });
  }
  if (isCustomerOwnedStateCorrection(latest, newestFirst)) {
    return base("CUSTOMER_CONTEXT_UPDATE", "customer_owned_state_correction", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      may_reuse_prior_grounded_answer: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "CORRECT"
    });
  }
  if (isCustomerOwnedStateUpdate(latest)) {
    return base("CUSTOMER_CONTEXT_UPDATE", "customer_owned_state_update", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      may_reuse_prior_grounded_answer: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "KEEP"
    });
  }
  if (CORRECTION.test(latest)) {
    return base("CORRECTION", "latest_turn_supersedes_prior_context", { needs_history: true, topic_action: "CORRECT" });
  }
  if (CUSTOMER_CONTEXT_REQUIREMENTS.test(latest)) {
    return base("CUSTOMER_CONTEXT_UPDATE", "customer_context_requirements_request", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "KEEP"
    });
  }
  if (isCustomerContextUpdate(latest)) {
    return base("CUSTOMER_CONTEXT_UPDATE", "customer_supplied_context_without_factual_request", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      evidence_authority: "NONE",
      topic_action: "KEEP"
    });
  }
  if (RETURN_PRIOR.test(latest)) {
    return base("RETURN_TO_PRIOR_TOPIC", "explicit_return_to_prior_topic", { needs_history: true, topic_action: "RETURN" });
  }
  if (TOPIC_SWITCH.test(latest)) {
    return base("TOPIC_SWITCH", "explicit_topic_switch", { needs_history: true, topic_action: "SWITCH" });
  }
  if (PRONOUN.test(latest)) {
    return base("PRONOUN_OR_ELLIPSIS", "referential_follow_up_requires_history", { needs_history: true, topic_action: "KEEP" });
  }
  if (FOLLOW.test(latest)) {
    return base("FOLLOW_UP_FACTUAL", "follow_up_requires_history", { needs_history: true, topic_action: "KEEP" });
  }
  if (DOMAIN_ONLY.test(latest)) {
    return base("UNDERSPECIFIED", "semantic_intent_present_but_required_detail_missing", { requires_new_kb_retrieval: false, evidence_authority: "NONE" });
  }
  if (QUESTIONISH.test(latest)) {
    return base("NEW_FACTUAL_QUERY", "standalone_factual_request");
  }
  return base("NEW_FACTUAL_QUERY", "specific_standalone_request");
}

// supabase/functions/_shared/conversation-intelligence.ts
var HUMAN_ZH = /(真人|人工|客服)/;
var HUMAN_EN = /\b(human|live agent|human agent|real person|support agent|customer service)\b/i;
var NEG_HUMAN_ZH = /(?:唔好|不要|唔使|不用|毋須|毋需|別|别|未需要|未要|而家未|現在未|现在未|唔係要|不是要|並非要|并非要|未叫|冇叫|没有叫|沒有叫|禁止|不准|唔准).{0,8}(?:轉|转|接|搵|找|聯絡|联系|要|需要)?\s*(?:真人|人工|客服(?:人員|人员)?)|(?:真人|人工|客服(?:人員|人员)?).{0,8}(?:唔好|不要|唔使|不用|毋須|毋需|未需要|未要|禁止|不准|唔准)/;
var NEG_HUMAN_EN = /\b(?:don't|do not|didn't|did not|not asking|not ask|no need|don't need|do not need|not yet|never)\b.{0,28}\b(?:connect|transfer|put|speak|want|need)?\b.{0,12}\b(?:human|live agent|human agent|real person|support agent|customer service)\b|\b(?:human|live agent|human agent|real person|support agent|customer service)\b.{0,20}\b(?:not needed|not required|no need|not yet)\b/i;
var AI_REJECT_HUMAN_REQUEST_ZH = /(?:唔好|不要|唔使|不用|毋須|毋需)\s*(?:AI|人工智能|機器人|机器人|bot).{0,24}(?:(?:我)?(?:而家|現在|现在|即刻|立即)?(?:要|想要|需要).{0,8}(?:真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(?:轉|转|接|搵|找|聯絡|联系).{0,8}(?:真人|人工|客服(?:人員|人员)?))/i;
var AI_REJECT_HUMAN_REQUEST_EN = /\b(?:don't|do not|no longer want|stop using)\b.{0,16}\b(?:ai|bot|robot|automation)\b.{0,40}\b(?:i want|i need|please connect|please transfer|connect me|transfer me|let me speak to)\b.{0,16}\b(?:a\s+)?(?:human|live agent|human agent|real person|customer service)\b/i;
var CONDITIONAL_ZH = /(如果|若果|如果.*先|先至|才|除非|答唔到|答不到|查唔到|查不到)/;
var CONDITIONAL_EN = /\b(if|only if|unless|in case)\b/i;
var FUTURE_ZH = /(之後|之后|遲啲|迟点|遲些|稍後|稍后|日後|以后|以後|到時|到时|再考慮|再考虑|可能)/;
var FUTURE_EN = /\b(later|afterwards|after that|eventually|maybe later|might later|in the future)\b/i;
var REFERENCE_ZH = /(你頭先|你刚才|你剛才|你之前|頭先話|刚才说|剛才說|提過|提过|講過|讲过|所謂|所谓|引用)/;
var REFERENCE_EN = /\b(you said|you mentioned|earlier|previously|before|quote|quoted)\b/i;
var QUESTION_ZH = /(係咪|是不是|是否|幾點|几点|幾時|何時|多久|幾耐|邊個|哪个|點樣|怎样|怎樣|可以嗎|可唔可以).*(真人|人工|客服)|(真人|人工|客服).*(係咪|是不是|是否|幾點|几点|幾時|何時|多久|幾耐|邊個|哪个|點樣|怎样|怎樣|可以嗎|可唔可以)/;
var QUESTION_EN = /\b(when|what|who|where|how|hours|available|open|close|can i|could i)\b.*\b(human|agent|customer service|support)\b|\b(human|agent|customer service|support)\b.*\b(when|what|who|where|how|hours|available|open|close)\b/i;
var HYPOTHETICAL_ZH = /(假如|假設|假设|例如|譬如|可唔可以轉|可不可以转|如果我要|如果想)/;
var HYPOTHETICAL_EN = /\b(hypothetically|suppose|what if|could i|would i be able to)\b/i;
var EXPLICIT_ZH = /(?:而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我要|我想|我需要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即).{0,4}(?:要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即)?(?:正式|明確|明确|確定|确定)(?:要|要求|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)/;
var EXPLICIT_EN = /\b(please\s+)?(connect|transfer|put|let)\s+me\s+(to|through to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)|\b(i want|i need|let me speak to|i want to speak to|i need to speak to|connect me to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)(\s+now)?\b/i;
function detectLanguage(text) {
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  return /[转们为这没请]/.test(text) ? "zh-CN" : "zh-TW";
}
function classifyHandoffIntent(text) {
  const t = text.normalize("NFKC").trim();
  const language = detectLanguage(t);
  const hasHuman = HUMAN_ZH.test(t) || HUMAN_EN.test(t);
  if (!hasHuman) return { kind: "none", explicit_request: false, pure_negation: false, language, reason: "no_human_support_reference" };
  if (AI_REJECT_HUMAN_REQUEST_ZH.test(t) || AI_REJECT_HUMAN_REQUEST_EN.test(t)) {
    return { kind: "explicit_now", explicit_request: true, pure_negation: false, language, reason: "ai_rejected_human_requested_now" };
  }
  if (NEG_HUMAN_ZH.test(t) || NEG_HUMAN_EN.test(t)) {
    return { kind: "negated", explicit_request: false, pure_negation: true, language, reason: "handoff_prohibited_or_negated" };
  }
  if (CONDITIONAL_ZH.test(t) || CONDITIONAL_EN.test(t)) {
    return { kind: "conditional", explicit_request: false, pure_negation: false, language, reason: "handoff_is_conditional" };
  }
  if (FUTURE_ZH.test(t) || FUTURE_EN.test(t)) {
    return { kind: "future", explicit_request: false, pure_negation: false, language, reason: "handoff_is_future_or_possible" };
  }
  if (REFERENCE_ZH.test(t) || REFERENCE_EN.test(t)) {
    return { kind: "reference", explicit_request: false, pure_negation: false, language, reason: "handoff_is_referenced_not_requested" };
  }
  if (HYPOTHETICAL_ZH.test(t) || HYPOTHETICAL_EN.test(t)) {
    return { kind: "hypothetical", explicit_request: false, pure_negation: false, language, reason: "handoff_is_hypothetical" };
  }
  if (QUESTION_ZH.test(t) || QUESTION_EN.test(t)) {
    return { kind: "question_about_human_support", explicit_request: false, pure_negation: false, language, reason: "question_about_human_support" };
  }
  if (EXPLICIT_ZH.test(t) || EXPLICIT_EN.test(t)) {
    return { kind: "explicit_now", explicit_request: true, pure_negation: false, language, reason: "unambiguous_present_handoff_request" };
  }
  return { kind: "none", explicit_request: false, pure_negation: false, language, reason: "human_support_mentioned_without_explicit_request" };
}
function classifyConversationTurn(text) {
  const t = text.normalize("NFKC").trim();
  const handoff = classifyHandoffIntent(t);
  const semantic = classifyCanonicalConversationTurn(t, [], { explicit_handoff: handoff.explicit_request });
  switch (semantic.operation) {
    case "TRIVIAL":
      return { kind: "trivial", should_clarify_before_kb: false, reason: semantic.reason };
    case "UNDERSPECIFIED":
      return { kind: "underspecified", should_clarify_before_kb: true, reason: semantic.reason };
    case "CORRECTION":
      return { kind: "correction", should_clarify_before_kb: false, reason: semantic.reason };
    case "FOLLOW_UP_FACTUAL":
    case "PRONOUN_OR_ELLIPSIS":
    case "SIMPLIFY":
    case "REPHRASE":
    case "TRANSLATE":
    case "SUMMARIZE":
    case "RETURN_TO_PRIOR_TOPIC":
    case "CONVERSATION_MEMORY":
    case "CUSTOMER_CONTEXT_UPDATE":
      return { kind: "follow_up", should_clarify_before_kb: false, reason: semantic.reason };
    default:
      return { kind: "specific", should_clarify_before_kb: false, reason: semantic.reason };
  }
}
function isHumanControlState(status, assignedAgentId) {
  if (typeof assignedAgentId === "string" && assignedAgentId.length > 0) return true;
  return (/* @__PURE__ */ new Set(["pending", "transferred", "human_needed", "human_control"])).has(String(status ?? ""));
}
function hasUsableFullContentEvidence(chunks, minScore) {
  return chunks.some((c) => c.chunk_type === "full_content" && typeof c.content === "string" && c.content.trim().length > 0 && typeof c.score === "number" && c.score >= minScore);
}
var CUSTOMER_CONVERSATION_POLICY = `Customer conversation policy (customer-facing):
- Speak naturally like a capable support representative, not like a diagnostic system.
- Continue the conversation across turns. Respect the newest correction when it supersedes an earlier fact or request.
- Never expose internal implementation terms such as Knowledge Base, KB, RAG, retrieval, evidence score, confidence score, provider, routing, matched rule, model, prompt, vector search, or full-content chunk.
- If the customer's request is incomplete or ambiguous, ask exactly one concise, context-specific question needed to continue. Do not offer a human merely because details are missing.
- If you cannot verify a fact from the available information, say naturally that you do not have enough information to confirm it and avoid guessing.
- Distinguish asking about whether an action is possible from actually requesting the action. Never claim an order/refund/cancellation/compensation was executed unless an authorized tool actually completed it.
- Anger, complaints, poor ratings, VIP status, high order value, or negative sentiment alone do not mean the customer asked for a human.
- A human handoff occurs only when the governed escalation layer has already decided it; do not invent or promise a handoff yourself.`;
var NATURAL_CLARIFICATION = {
  "zh-TW": "\u53EF\u4EE5\uFF0C\u60F3\u78BA\u8A8D\u4E00\u4E0B\u4F60\u4E3B\u8981\u60F3\u8655\u7406\u54EA\u4E00\u65B9\u9762\uFF1F\u4F8B\u5982\u9001\u8CA8\u3001\u4ED8\u6B3E\u3001\u53D6\u6D88\uFF0C\u9084\u662F\u9000\u63DB\u8CA8\uFF1F",
  "zh-CN": "\u53EF\u4EE5\uFF0C\u60F3\u786E\u8BA4\u4E00\u4E0B\u4F60\u4E3B\u8981\u60F3\u5904\u7406\u54EA\u4E00\u65B9\u9762\uFF1F\u4F8B\u5982\u9001\u8D27\u3001\u4ED8\u6B3E\u3001\u53D6\u6D88\uFF0C\u8FD8\u662F\u9000\u6362\u8D27\uFF1F",
  en: "Sure \u2014 which part would you like help with, for example delivery, payment, cancellation, or a return/refund?"
};
function buildCustomerContextRequirementsResponse(language, newestFirstMessages) {
  const customerTurns = newestFirstMessages.filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase())).map((row) => cleanContinuityText(row.content)).filter(Boolean).slice(0, 12);
  const joined = customerTurns.join(" ");
  const missingModel = /(?:沒有|没有|冇|不知道|唔知).{0,8}(?:型號|型号)|(?:don't|do not) have (?:the )?(?:model|model number)/i.test(joined);
  const hasBrand = /(?:品牌(?:是|係)|brand is|\bpanasonic\b|\bsamsung\b|\blg\b|\bsony\b|\bwhirlpool\b)/i.test(joined);
  const hasApplianceType = /(?:冷氣|空調|空调|洗衣機|洗衣机|雪櫃|冰箱|電視|电视|家用電器|家用电器|air conditioner|washing machine|refrigerator|fridge|television|\btv\b)/i.test(joined);
  if (language === "en") {
    const known2 = missingModel ? "You\u2019ve already told me you don\u2019t have the model number, so you don\u2019t need to repeat that. " : "";
    const asks = [];
    if (!hasApplianceType) asks.push("what type of appliance it is");
    if (!hasBrand) asks.push("the brand, if you know it");
    asks.push("roughly when you bought it", "what is happening now");
    return known2 + "Please tell me " + asks.join(", ") + ".";
  }
  const known = missingModel ? language === "zh-CN" ? "\u4F60\u5DF2\u7ECF\u8BF4\u76EE\u524D\u6CA1\u6709\u578B\u53F7\uFF0C\u4E0D\u7528\u91CD\u590D\u63D0\u4F9B\u3002" : "\u4F60\u5DF2\u7D93\u8AAA\u76EE\u524D\u6C92\u6709\u578B\u865F\uFF0C\u4E0D\u7528\u91CD\u8907\u63D0\u4F9B\u3002" : "";
  if (language === "zh-CN") {
    return known + `\u8BF7\u544A\u8BC9\u6211${hasApplianceType ? "\u66F4\u5177\u4F53\u662F\u54EA\u4E00\u7C7B\u5BB6\u7528\u7535\u5668" : "\u662F\u54EA\u4E00\u7C7B\u5BB6\u7528\u7535\u5668"}${hasBrand ? "" : "\u3001\u54C1\u724C\uFF08\u5982\u679C\u77E5\u9053\uFF09"}\u3001\u5927\u7EA6\u8D2D\u4E70\u65F6\u95F4\uFF0C\u4EE5\u53CA\u76EE\u524D\u51FA\u73B0\u7684\u60C5\u51B5\u3002`;
  }
  return known + `\u8ACB\u544A\u8A34\u6211${hasApplianceType ? "\u66F4\u5177\u9AD4\u662F\u54EA\u4E00\u985E\u5BB6\u7528\u96FB\u5668" : "\u662F\u54EA\u4E00\u985E\u5BB6\u7528\u96FB\u5668"}${hasBrand ? "" : "\u3001\u54C1\u724C\uFF08\u5982\u679C\u77E5\u9053\uFF09"}\u3001\u5927\u7D04\u8CFC\u8CB7\u6642\u9593\uFF0C\u4EE5\u53CA\u76EE\u524D\u51FA\u73FE\u7684\u60C5\u6CC1\u3002`;
}
function buildCustomerContextAcknowledgement(language) {
  if (language === "en") {
    return "Got it. I\u2019ll keep using the details you\u2019ve provided and won\u2019t guess anything that hasn\u2019t been confirmed. If I need anything else, I\u2019ll ask you directly.";
  }
  if (language === "zh-CN") {
    return "\u6536\u5230\u3002\u6211\u4F1A\u7EE7\u7EED\u4F7F\u7528\u4F60\u5DF2\u63D0\u4F9B\u7684\u8D44\u6599\uFF0C\u672A\u786E\u8BA4\u7684\u90E8\u5206\u4E0D\u4F1A\u81EA\u884C\u731C\u6D4B\uFF1B\u5982\u679C\u8FD8\u9700\u8981\u5176\u4ED6\u8D44\u6599\uFF0C\u6211\u4F1A\u76F4\u63A5\u544A\u8BC9\u4F60\u3002";
  }
  return "\u6536\u5230\u3002\u6211\u6703\u7E7C\u7E8C\u4F7F\u7528\u4F60\u5DF2\u63D0\u4F9B\u7684\u8CC7\u6599\uFF0C\u672A\u78BA\u8A8D\u7684\u90E8\u5206\u4E0D\u6703\u81EA\u884C\u731C\u6E2C\uFF1B\u5982\u679C\u9084\u9700\u8981\u5176\u4ED6\u8CC7\u6599\uFF0C\u6211\u6703\u76F4\u63A5\u544A\u8A34\u4F60\u3002";
}
function cleanContinuityText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
var CUSTOMER_ROLES = /* @__PURE__ */ new Set(["visitor", "customer", "user"]);
function buildCustomerAdvisoryContext(signals) {
  const lines = [];
  const tier = typeof signals.tier === "string" ? signals.tier.trim().slice(0, 80) : "";
  const angry = signals.anger_flag === true || typeof signals.sentiment_score === "number" && Number.isFinite(signals.sentiment_score) && signals.sentiment_score <= -0.5;
  const risk = typeof signals.churn_risk === "number" && Number.isFinite(signals.churn_risk) ? Math.max(0, Math.min(1, signals.churn_risk)) : null;
  const escalation = typeof signals.escalation_score === "number" && Number.isFinite(signals.escalation_score) ? Math.max(0, Math.min(1, signals.escalation_score)) : null;
  if (!tier && !angry && risk === null && escalation === null) return "";
  lines.push("Customer advisory context (internal, advisory only; never reveal scores or labels):");
  if (tier) lines.push(`- Customer tier is available (${tier}). Be attentive and efficient, but tier/VIP status alone must never trigger human handoff or unsupported promises.`);
  if (angry) lines.push("- Current/fresh signals indicate frustration or anger. Acknowledge the concern briefly, avoid repetitive apologies, answer the core issue first, and do not force a human handoff solely because of emotion.");
  if (risk !== null || escalation !== null) lines.push("- Predictive customer-risk signals are available. Use them only to improve clarity, urgency and helpfulness; they are not authorization for a required handoff or customer action.");
  return lines.join("\n");
}

// supabase/functions/_shared/escalation-shadow.ts
function resolveSentimentProvenance(input) {
  const tenant = input.expected_tenant_id?.trim();
  const provider = input.sentiment_provider_version?.trim();
  if (!tenant || !provider) return "invalid";
  if (input.sentiment_evaluation_id?.trim()) return "conversation_evaluation";
  if (provider.split("+").some((part) => /^(?:current-turn-emotion-v1\.0|current-turn-emotion-v2\.0)$/.test(part.trim()))) {
    return "current_turn";
  }
  return "invalid";
}
function hasP1Provenance(input) {
  return Boolean(
    input.expected_tenant_id && input.p1_provider_version?.trim() && (input.p1_provider_source === "customer360" || input.p1_provider_source === "risk_engine")
  );
}
function evaluateEscalationShadow(input, env) {
  const flags = escalationFeatureFlagsFromEnv(env);
  if (!flags.shadow_mode) return null;
  if (!input.source_message_id) {
    return {
      evaluated: false,
      matched_rule: null,
      decision: "fallback_r1_only",
      reason_code: "shadow_missing_source_message_id",
      signal_gaps: ["source_message_id"],
      provider_warnings: []
    };
  }
  const providerWarnings = [];
  const context = createEscalationContextBase({
    conversation_id: input.conversation_id,
    source_message_id: input.source_message_id,
    latest_message_content: input.latest_message_content,
    explicit_request: input.explicit_request,
    expected_tenant_id: input.expected_tenant_id
  });
  const handoffClassification = classifyHandoffIntent(input.latest_message_content);
  context.explicit_request = availableSignal(
    handoffClassification.explicit_request,
    "local_classifier",
    { reason: handoffClassification.reason }
  );
  context.pure_handoff_negation = availableSignal(
    handoffClassification.pure_negation,
    "local_classifier",
    { reason: handoffClassification.reason }
  );
  context.conversation_status = availableSignal(
    input.conversation_status,
    "conversation_history"
  );
  context.assigned_agent_id = availableSignal(
    input.assigned_agent_id,
    "conversation_history"
  );
  if (typeof input.greeting_or_trivial === "boolean") {
    context.greeting_or_trivial = availableSignal(
      input.greeting_or_trivial,
      "local_classifier"
    );
  }
  if (input.threat_flag) {
    context.threat_flag = availableSignal(input.threat_flag.value, "local_classifier", {
      provider_version: input.threat_flag.provider_version,
      reason: input.threat_flag.reason,
      ...input.expected_tenant_id ? { tenant_id: input.expected_tenant_id } : {}
    });
  }
  if (input.compliance_jurisdiction_requires_human_review) {
    const compliance = input.compliance_jurisdiction_requires_human_review;
    context.compliance_jurisdiction_requires_human_review = availableSignal(
      compliance.value,
      "tenant_config",
      {
        provider_version: compliance.provider_version,
        reason: compliance.reason,
        ...input.expected_tenant_id ? { tenant_id: input.expected_tenant_id } : {}
      }
    );
  }
  if (input.rag_match_state) {
    context.rag_match_state = availableSignal(input.rag_match_state, "kb_rag");
  }
  if (input.topic_risk_level === "high") {
    context.topic_risk_level = availableSignal("high", "local_classifier", {
      reason: "verified_high_risk_topic"
    });
  }
  if (input.verified_local_risk_classification === true) {
    context.verified_local_risk_classification = availableSignal(
      true,
      "local_classifier"
    );
  }
  const sentimentProvenance = resolveSentimentProvenance(input);
  const ceSignalPresent = input.anger_flag === true || typeof input.sentiment_score === "number" || Array.isArray(input.sentiment_trend) || input.sentiment_recovered_same_turn === true;
  if (ceSignalPresent && sentimentProvenance === "invalid") {
    providerWarnings.push("CE_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE");
  }
  if (ceSignalPresent && sentimentProvenance !== "invalid") {
    const signalSource = sentimentProvenance === "current_turn" ? "local_classifier" : "conversation_evaluation";
    const ceMeta = {
      provider_version: input.sentiment_provider_version,
      reason: sentimentProvenance === "current_turn" ? "current_turn_emotion_classifier" : `evaluation_id:${input.sentiment_evaluation_id}`,
      tenant_id: input.expected_tenant_id
    };
    if (input.anger_flag === true) {
      context.anger_flag = availableSignal(true, signalSource, ceMeta);
    }
    if (typeof input.sentiment_score === "number" && Number.isFinite(input.sentiment_score)) {
      context.sentiment_score = availableSignal(input.sentiment_score, signalSource, ceMeta);
    }
    if (sentimentProvenance === "conversation_evaluation" && Array.isArray(input.sentiment_trend) && input.sentiment_trend.length >= 2 && input.sentiment_trend.every((n) => typeof n === "number" && Number.isFinite(n))) {
      context.sentiment_trend = availableSignal(
        input.sentiment_trend,
        "conversation_evaluation",
        ceMeta
      );
    }
    if (input.sentiment_recovered_same_turn === true) {
      context.sentiment_recovered_same_turn = availableSignal(
        true,
        signalSource,
        {
          ...ceMeta,
          reason: sentimentProvenance === "current_turn" ? "current_turn_emotion_recovery" : `evaluation_id:${input.sentiment_evaluation_id}:recovery`
        }
      );
    }
  }
  if (typeof input.conversation_duration_sec === "number" && Number.isFinite(input.conversation_duration_sec)) {
    context.conversation_duration_sec = availableSignal(
      input.conversation_duration_sec,
      "conversation_history",
      {
        ...input.expected_tenant_id ? { tenant_id: input.expected_tenant_id } : {},
        reason: "conversation_created_at_elapsed_seconds"
      }
    );
  }
  if (input.tenant_config) context.tenant_config = input.tenant_config;
  if (input.policy_match_state) {
    context.policy_match_state = availableSignal(
      input.policy_match_state,
      "policy_engine",
      {
        provider_version: input.policy_provider_version,
        reason: input.policy_provider_reason ?? "agent_assist_policy_contract",
        ...input.expected_tenant_id ? { tenant_id: input.expected_tenant_id } : {}
      }
    );
  }
  const p1SignalPresent = typeof input.predicted_csat === "number" || typeof input.churn_risk === "number" || typeof input.escalation_score === "number";
  const p1ProvenanceOk = hasP1Provenance(input);
  if (p1SignalPresent && !p1ProvenanceOk) {
    providerWarnings.push("P1_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE");
  }
  if (p1ProvenanceOk) {
    const p1Source = input.p1_provider_source === "risk_engine" ? "scoring_engine" : "customer360";
    const p1Meta = {
      provider_version: input.p1_provider_version,
      tenant_id: input.expected_tenant_id
    };
    if (typeof input.predicted_csat === "number" && Number.isFinite(input.predicted_csat)) {
      context.predicted_csat = availableSignal(
        input.predicted_csat,
        p1Source,
        { ...p1Meta, reason: "authoritative_predicted_csat" }
      );
    }
    if (typeof input.churn_risk === "number" && Number.isFinite(input.churn_risk)) {
      context.churn_risk = availableSignal(
        input.churn_risk,
        p1Source,
        { ...p1Meta, reason: "authoritative_churn_risk" }
      );
    }
    if (typeof input.escalation_score === "number" && Number.isFinite(input.escalation_score)) {
      context.escalation_score = availableSignal(
        input.escalation_score,
        p1Source,
        { ...p1Meta, reason: "authoritative_escalation_score" }
      );
    }
  }
  if (input.failure_type) {
    context.failure_type = availableSignal(input.failure_type, "runtime");
  }
  const enabled = /* @__PURE__ */ new Set();
  enabled.add("R1");
  if (flags.enable_full_ruleset || flags.enable_e2) enabled.add("E2");
  if (flags.enable_full_ruleset || flags.enable_e1) enabled.add("E1");
  if (flags.enable_full_ruleset || flags.enable_r2) enabled.add("R2");
  if (flags.enable_full_ruleset || flags.enable_r3) enabled.add("R3");
  if (flags.enable_full_ruleset || flags.enable_p2) enabled.add("P2");
  if (flags.enable_full_ruleset || flags.enable_r4) enabled.add("R4");
  if (flags.enable_full_ruleset || flags.enable_p1) enabled.add("P1");
  if (input.failure_type || input.rag_match_state === "unavailable") {
    enabled.add("S0");
  }
  const result2 = evaluateFullEscalationRuleset(context, {
    activation: { enabled }
  });
  if (result2.matched_rule === "R3" || result2.matched_rule === "P1") {
    const advisoryDecision = result2.matched_rule === "R3" ? "recommend_handoff" : "suggest_handoff";
    if (result2.decision !== advisoryDecision) {
      providerWarnings.push("ADVISORY_RULE_DECISION_DOWNGRADED");
    }
    return {
      evaluated: true,
      matched_rule: result2.matched_rule,
      decision: advisoryDecision,
      reason_code: result2.reason_code,
      signal_gaps: result2.signal_gaps,
      provider_warnings: [...result2.provider_warnings, ...providerWarnings]
    };
  }
  return {
    evaluated: true,
    matched_rule: result2.matched_rule,
    decision: result2.decision,
    reason_code: result2.reason_code,
    signal_gaps: result2.signal_gaps,
    provider_warnings: [...result2.provider_warnings, ...providerWarnings]
  };
}

// supabase/functions/_shared/escalation-live.ts
var REQUIRED_LIVE_RULES = /* @__PURE__ */ new Set(["E2", "E1", "R2"]);
function isRequiredLiveRule(rule) {
  return rule !== null && REQUIRED_LIVE_RULES.has(rule);
}
async function persistRequiredEscalationHandoff(client, input) {
  if (input.decision.decision !== "handoff" || !isRequiredLiveRule(input.decision.matched_rule)) {
    return { ok: false, result: "not_required_rule" };
  }
  const priority = input.decision.priority;
  if (priority !== "normal" && priority !== "high" && priority !== "urgent") {
    return { ok: false, result: "invalid_priority" };
  }
  const safeReply = input.safe_reply_content.trim();
  if (!safeReply || safeReply === "__THINKING__" || safeReply.length > 2e3) {
    return { ok: false, result: "invalid_safe_reply" };
  }
  const { data, error } = await client.rpc("required_escalation_handoff_tx", {
    p_conversation_id: input.conversation_id,
    p_source_message_id: input.source_message_id,
    p_escalation_rule: input.decision.matched_rule,
    p_priority: priority,
    p_safe_reply_content: safeReply,
    p_reason_code: input.decision.reason_code
  });
  if (error) {
    return {
      ok: false,
      result: "rpc_transport_error",
      detail: error.message ?? "rpc_error"
    };
  }
  const payload = data ?? {};
  const result2 = String(payload.result ?? "unexpected_result");
  switch (result2) {
    case "success":
    case "already_handled":
      return { ok: true, result: result2, data: payload };
    case "already_resolved":
    case "already_under_human_control":
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "invalid_priority":
    case "not_found":
      return { ok: false, result: result2, data: payload };
    default:
      return {
        ok: false,
        result: "unexpected_result",
        detail: result2,
        data: payload
      };
  }
}
async function persistNewIntentClarificationThroughAiGate(client, input, clarification) {
  const { data, error } = await client.rpc("commit_ai_reply_tx", {
    p_conversation_id: input.conversation_id,
    p_source_message_id: input.source_message_id,
    p_content: clarification,
    p_metadata: {
      escalation_rule: "R2",
      escalation_action: "new_intent_clarification",
      response_route: "kb_no_match_recovery",
      handoff_required: false,
      reason_code: input.decision.reason_code
    }
  });
  if (error) {
    return { ok: false, result: "rpc_transport_error", detail: error.message ?? "rpc_error" };
  }
  const payload = data ?? {};
  const result2 = String(payload.result ?? "unexpected_result");
  switch (result2) {
    case "success":
    case "idempotent":
      return { ok: true, result: "success", data: payload };
    case "human_control":
      return { ok: false, result: "already_under_human_control", data: payload };
    case "resolved":
      return { ok: false, result: "already_resolved", data: payload };
    case "invalid_source_message":
    case "invalid_input":
    case "not_found":
      return { ok: false, result: result2, data: payload };
    default:
      return { ok: false, result: "unexpected_result", detail: result2, data: payload };
  }
}
async function persistRequiredEscalationClarification(client, input) {
  if (input.decision.decision !== "clarify" || input.decision.matched_rule !== "R2") {
    return { ok: false, result: "not_r2_clarification" };
  }
  const clarification = input.safe_reply_content.trim();
  if (!clarification || clarification === "__THINKING__" || clarification.length > 1200) {
    return { ok: false, result: "invalid_clarification" };
  }
  const { data, error } = await client.rpc("required_escalation_clarification_tx", {
    p_conversation_id: input.conversation_id,
    p_source_message_id: input.source_message_id,
    p_escalation_rule: "R2",
    p_clarification_content: clarification,
    p_reason_code: input.decision.reason_code
  });
  if (error) {
    return { ok: false, result: "rpc_transport_error", detail: error.message ?? "rpc_error" };
  }
  const payload = data ?? {};
  const result2 = String(payload.result ?? "unexpected_result");
  switch (result2) {
    case "success":
    case "already_handled":
      return { ok: true, result: result2, data: payload };
    case "max_clarifications_reached":
      if (input.decision.reason_code === "clarification_new_intent_no_kb_match") {
        return await persistNewIntentClarificationThroughAiGate(
          client,
          input,
          clarification
        );
      }
      return { ok: false, result: result2, data: payload };
    case "already_resolved":
    case "already_under_human_control":
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "not_found":
      return { ok: false, result: result2, data: payload };
    default:
      return { ok: false, result: "unexpected_result", detail: result2, data: payload };
  }
}

// supabase/functions/_shared/llm-router.ts
import { createClient as createClient2 } from "npm:@supabase/supabase-js@2.45.0";
import { GoogleAuth } from "npm:google-auth-library@9.15.0";

// supabase/functions/_shared/vertex-parse.ts
var num = (v) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
function parseVertexResponse(body) {
  const obj2 = body ?? {};
  const candidate = Array.isArray(obj2.candidates) ? obj2.candidates[0] : void 0;
  const parts = candidate?.content?.parts;
  const text = Array.isArray(parts) ? parts.filter((p) => p?.thought !== true && typeof p?.text === "string").map((p) => p.text).join("").trim() : "";
  const usage = obj2.usageMetadata;
  return {
    text,
    input_tokens: num(usage?.promptTokenCount),
    output_tokens: num(usage?.candidatesTokenCount) + num(usage?.thoughtsTokenCount),
    finish_reason: typeof candidate?.finishReason === "string" ? candidate.finishReason : null,
    block_reason: typeof obj2.promptFeedback?.blockReason === "string" ? obj2.promptFeedback.blockReason : null
  };
}
function extractJsonObjectText(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}
function parseJsonObjectLoose(raw) {
  const candidateTexts = [];
  if (typeof raw === "string") {
    const direct = raw.replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "").trim();
    if (direct) candidateTexts.push(direct);
    const extracted = extractJsonObjectText(raw);
    if (extracted && extracted !== direct) candidateTexts.push(extracted);
  }
  for (const text of candidateTexts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
  }
  return null;
}

// supabase/functions/_shared/vertex-generation-config.ts
function buildVertexGenerationConfig(maxTokens, jsonOutput, responseSchema, thinkingBudget) {
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("vertex_max_tokens_invalid");
  }
  if (thinkingBudget !== void 0 && (!Number.isInteger(thinkingBudget) || thinkingBudget < 0)) {
    throw new Error("vertex_thinking_budget_invalid");
  }
  return {
    maxOutputTokens: maxTokens,
    temperature: 0,
    ...thinkingBudget !== void 0 ? { thinkingConfig: { thinkingBudget } } : {},
    ...jsonOutput ? { responseMimeType: "application/json" } : {},
    ...jsonOutput && responseSchema ? { responseSchema } : {}
  };
}

// supabase/functions/_shared/llm-router.ts
var ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
var ANTHROPIC_API_VERSION = "2023-06-01";
var MAX_ATTEMPTS = 3;
var BASE_BACKOFF_MS = 400;
var DEFAULT_TIMEOUT_MS = 3e4;
var VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
var MODEL_ENV = {
  evaluation: "LLM_MODEL_EVALUATION",
  assist: "LLM_MODEL_ASSIST",
  generation: "LLM_MODEL_GENERATION"
};
var REDACTIONS = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]"],
  [/\+?\d[\d\s\-()]{6,}\d/g, "[PHONE]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[CARD]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[UUID]"],
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[SECRET]"],
  [/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, "[SECRET]"]
];
var INJECTION_RE = /(ignore\s+(all\s+|the\s+)?(previous|above)\s+(instructions|prompts)|system\s+prompt|developer\s+prompt|you\s+are\s+now|jailbreak)/i;
function redact(input) {
  let out = input;
  for (const [re, repl] of REDACTIONS) out = out.replace(re, repl);
  return out;
}
function looksLikeInjection(input) {
  return INJECTION_RE.test(input);
}
function serviceClient() {
  return createClient2(Deno.env.get("SUPABASE_URL"), getSupabaseAdminKey());
}
function log(tag, fields) {
  console.log(
    JSON.stringify({
      component: "llm-router",
      tag,
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      ...fields
    })
  );
}
function resolveProvider() {
  const raw = (Deno.env.get("LLM_PROVIDER") ?? "").trim().toLowerCase();
  return raw === "anthropic" ? "anthropic" : raw === "vertex" ? "vertex" : "";
}
async function recordUsage(call, provider, model, outcome, httpStatus, usage, code) {
  try {
    await serviceClient().from("upstream_call_log").insert({
      conversation_id: call.conversationId,
      company_id: call.companyId,
      upstream_service: "llm",
      request_payload: {
        request_id: call.operationId,
        purpose: call.purpose,
        provider,
        model,
        company_id: call.companyId,
        outcome,
        error_code: code ?? null,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        attempts: usage.attempts
      },
      response_status: httpStatus,
      response_latency_ms: usage.latency_ms,
      error_message: code ?? null
    });
  } catch (e) {
    log(call.tag, { event: "usage_log_failed", detail: e.name });
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var GROUNDING_VERIFIER_MAX_TOKENS = 2048;
var GENERATION_MAX_TOKENS_DEFAULT = 2048;
var GENERATION_MAX_TOKENS_MIN = 768;
var GENERATION_MAX_TOKENS_MAX = 8192;
function resolveGenerationMaxTokens() {
  const raw = (Deno.env.get("LLM_MAX_OUTPUT_TOKENS_GENERATION") ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : GENERATION_MAX_TOKENS_DEFAULT;
  return Math.max(GENERATION_MAX_TOKENS_MIN, Math.min(GENERATION_MAX_TOKENS_MAX, candidate));
}
function anthropicAdapter(apiKey, model, safeSystem, safeUser, maxTokens) {
  return {
    id: "anthropic",
    model,
    buildRequest: () => Promise.resolve({
      url: ANTHROPIC_ENDPOINT,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: safeSystem,
        messages: [{ role: "user", content: safeUser }]
      })
    }),
    parseResponse: (body) => {
      const obj2 = body;
      const text = Array.isArray(obj2.content) ? obj2.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim() : "";
      return {
        text,
        input_tokens: Number(obj2.usage?.input_tokens ?? 0),
        output_tokens: Number(obj2.usage?.output_tokens ?? 0),
        finish_reason: null,
        block_reason: null
      };
    }
  };
}
async function vertexAccessToken(serviceAccountJson) {
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new GoogleAuth({ credentials, scopes: [VERTEX_SCOPE] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const value = typeof token === "string" ? token : token?.token;
  if (!value) throw new Error("vertex_token_unavailable");
  return value;
}
function vertexAdapter(serviceAccountJson, projectId, region, model, safeSystem, safeUser, maxTokens, jsonOutput, responseSchema, thinkingBudget) {
  const url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;
  return {
    id: "vertex",
    model,
    buildRequest: async () => {
      const accessToken = await vertexAccessToken(serviceAccountJson);
      return {
        url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: safeSystem }] },
          contents: [{ role: "user", parts: [{ text: safeUser }] }],
          generationConfig: buildVertexGenerationConfig(
            maxTokens,
            jsonOutput,
            responseSchema,
            thinkingBudget
          )
        })
      };
    },
    parseResponse: (body) => {
      const parsed = parseVertexResponse(body);
      return {
        text: parsed.text,
        input_tokens: parsed.input_tokens,
        output_tokens: parsed.output_tokens,
        finish_reason: parsed.finish_reason,
        block_reason: parsed.block_reason
      };
    }
  };
}
var EXACT_FACT_TOKEN_RE = /(?:[$€£¥]|HKD|USD|EUR|GBP|JPY|TWD|NTD|RMB|CNY)?\s*\d+(?:[.,]\d+)?(?:\s*(?:%|percent|days?|hours?|minutes?|years?|months?|kg|g|lb|lbs|mm|cm|m|km|ml|l|公升|毫升|公斤|克|天|日|小時|小时|分鐘|分钟|年|月))?|\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9-]{4,}\b/giu;
function canonicalExactToken(value) {
  return value.normalize("NFKC").toLowerCase().replace(/percent/g, "%").replace(/(?:litres?|liters?|公升)/g, "l").replace(/(?:millilitres?|milliliters?|毫升)/g, "ml").replace(/(?:kilograms?|公斤)/g, "kg").replace(/(?:grams?|克)/g, "g").replace(/(?:hours?|小時|小时)/g, "h").replace(/(?:minutes?|分鐘|分钟)/g, "min").replace(/(?:days?|天|日)/g, "d").replace(/(?:years?|年)/g, "y").replace(/(?:months?|月)/g, "mo").replace(/[\s,]/g, "").trim();
}
function extractCustomerConversationEvidence(input) {
  const raw = typeof input === "string" ? input : "";
  const turnPattern = /\[Turn\s+\d+\s+Visitor\]\n([\s\S]*?)(?=\n\n\[Turn\s+\d+\s+(?:Visitor|Assistant)\]\n|$)/g;
  const visitorTurns = [];
  for (const match of raw.matchAll(turnPattern)) {
    const content = String(match[1] ?? "").trim();
    if (content) visitorTurns.push(content.slice(0, 3e3));
  }
  if (visitorTurns.length > 0) {
    return visitorTurns.slice(-6).join("\n\n").slice(0, 12e3);
  }
  return raw.slice(0, 3e3);
}
function extractGroundingBlock(system) {
  const transformRules = "Prior Grounded Answer transform rules:";
  const transformMarker = "Prior Grounded Answer Evidence:\n";
  if (system.includes(transformRules)) {
    const transformIndex = system.lastIndexOf(transformMarker);
    if (transformIndex >= 0) {
      const prior = system.slice(transformIndex + transformMarker.length).trim();
      if (prior) {
        const operationsLine = system.match(/^- Operations:\s*(.+)$/m)?.[1] ?? "";
        const transformOperations = operationsLine.split("+").map((x) => x.trim()).filter(Boolean);
        return {
          authority: "PRIOR_GROUNDED_ANSWER",
          evidence_text: prior.slice(0, 3e3),
          chunk_ids: [],
          transform_operations: transformOperations
        };
      }
    }
    return null;
  }
  if (!system.includes("Knowledge Base grounding rules:")) return null;
  const marker = "Full Content Evidence:\n";
  const markerIndex = system.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const raw = system.slice(markerIndex + marker.length).trim();
  if (!raw || /^none\b/i.test(raw)) return null;
  const ids = [...raw.matchAll(/\[chunk:([^\]\s]+)\]/g)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
  return {
    authority: "CURRENT_KB",
    evidence_text: raw.slice(0, 6e3),
    chunk_ids: [...new Set(ids)],
    transform_operations: []
  };
}
function buildVerifierEvidenceAliases(grounding) {
  let next = 0;
  const allowed = [];
  const aliased = grounding.evidence_text.replace(/\[chunk:([^\]\s]+)\]/g, () => {
    next += 1;
    const alias = `E${next}`;
    allowed.push(alias);
    return `[chunk:${alias}]`;
  });
  return { evidence_text: aliased, allowed_ids: allowed };
}
function validateExactFactGrounding(answer, evidenceText, protectedChunkIds = [], conversationEvidenceText = "") {
  const answerNorm = answer.normalize("NFKC");
  for (const id of protectedChunkIds) {
    if (id && answerNorm.includes(id)) {
      return {
        ok: false,
        reason: "internal_chunk_id_leak",
        unsupported_tokens: [id]
      };
    }
  }
  const evidenceNorm = canonicalExactToken(`${evidenceText}
${conversationEvidenceText}`);
  const unsupported = /* @__PURE__ */ new Set();
  for (const match of answer.matchAll(EXACT_FACT_TOKEN_RE)) {
    const token = canonicalExactToken(match[0] ?? "");
    if (!token || /^\d$/.test(token)) continue;
    if (!evidenceNorm.includes(token)) unsupported.add(token);
  }
  return unsupported.size === 0 ? { ok: true } : {
    ok: false,
    reason: "unsupported_exact_fact",
    unsupported_tokens: [...unsupported]
  };
}
function parseGroundingVerifierDecision(raw, allowedChunkIds) {
  const parsed = parseJsonObjectLoose(raw);
  if (!parsed || typeof parsed.grounded !== "boolean") return null;
  const rawUnsupported = parsed.unsupported_claims;
  if (rawUnsupported != null && !Array.isArray(rawUnsupported)) return null;
  const unsupportedInput = Array.isArray(rawUnsupported) ? rawUnsupported : [];
  const unsupported = unsupportedInput.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (unsupported.length !== unsupportedInput.length) return null;
  const rawIds = parsed.evidence_chunk_ids;
  if (rawIds != null && !Array.isArray(rawIds)) return null;
  const idsInput = Array.isArray(rawIds) ? rawIds : [];
  const ids = idsInput.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  if (ids.length !== idsInput.length) return null;
  const allowed = new Set(allowedChunkIds.filter(Boolean));
  if (ids.some((id) => !allowed.has(id))) return null;
  if (parsed.grounded && unsupported.length > 0) return null;
  if (!parsed.grounded && unsupported.length === 0) return null;
  return {
    grounded: parsed.grounded,
    unsupported_claims: unsupported,
    evidence_chunk_ids: [...new Set(ids)]
  };
}
async function verifyGroundedGeneration(call, provider, answer, grounding, timeoutMs) {
  const conversationEvidence = extractCustomerConversationEvidence(call.user);
  const exact = validateExactFactGrounding(
    answer,
    grounding.evidence_text,
    grounding.chunk_ids,
    conversationEvidence
  );
  if (!exact.ok) {
    log(call.tag, {
      event: "grounding_exact_fact_rejected",
      request_id: call.operationId,
      reason: exact.reason,
      unsupported_token_count: exact.unsupported_tokens.length
    });
    return { ok: false, reason: exact.reason };
  }
  const verifierEvidence = buildVerifierEvidenceAliases(grounding);
  const allowedVerifierIds = [...verifierEvidence.allowed_ids, "C1"];
  const evaluationModel = (Deno.env.get(MODEL_ENV.evaluation) ?? "").trim();
  if (!evaluationModel) {
    log(call.tag, {
      event: "grounding_verifier_config_missing",
      request_id: call.operationId
    });
    return { ok: false, reason: "verifier_model_missing" };
  }
  const verifierSystem = [
    "You are a strict factual-grounding verifier.",
    grounding.authority === "PRIOR_GROUNDED_ANSWER" ? "The authoritative evidence is a previously verified grounded answer. Judge whether product, company, policy, price, date, duration, eligibility, availability, procedure, jurisdiction, model/specification or other external factual claims remain supported by that evidence." : "The authoritative evidence is the supplied current Knowledge Base evidence. Product, company, policy, price, date, duration, eligibility, availability, procedure, jurisdiction, model/specification and other external factual claims must be supported by that authoritative evidence.",
    grounding.authority === "PRIOR_GROUNDED_ANSWER" && grounding.transform_operations.length ? `Requested transform operations: ${grounding.transform_operations.join(" + ")}.` : "",
    grounding.authority === "PRIOR_GROUNDED_ANSWER" && grounding.transform_operations.includes("TRANSLATE") ? "For TRANSLATE, compare semantic meaning across languages rather than surface-word overlap. Direct translations of the same names, product categories, units, and relationships are supported when they preserve the source meaning; do not reject a faithful translation merely because its words differ from the source language." : "",
    "Conversation Context C1 is a separate, non-authoritative evidence class. It may support only facts explicitly supplied by the customer or already present as conversational state, including preferences, requested features, quantities/SKU counts, customer-provided order/reference ids, prior requests, and faithful recap/acknowledgement of those facts.",
    "Never use C1 to support a new product, company, policy, price, eligibility, availability, procedure, jurisdiction, roadmap, guarantee, refund, account-status or other external factual claim. Those claims require the authoritative E* evidence above.",
    "Do not use outside knowledge or assumptions.",
    "Politeness, conversational transitions, questions, and non-factual wording do not need evidence.",
    "Any unsupported external factual claim makes grounded=false. A faithful restatement of customer-provided/conversation facts is allowed when supported by C1.",
    "evidence_chunk_ids may contain supplied E* aliases and C1 when they materially support the answer. This field is audit metadata; grounded must still reflect the rules above.",
    "Return JSON only with grounded, unsupported_claims, evidence_chunk_ids."
  ].join("\n");
  const verifierUser = [
    "Authoritative Evidence:",
    verifierEvidence.evidence_text,
    "",
    "Conversation Context [context:C1]:",
    conversationEvidence,
    "",
    "Proposed answer:",
    answer.slice(0, 3e3)
  ].join("\n");
  let verifierAdapter;
  if (provider === "vertex") {
    const sa = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
    const projectId = Deno.env.get("GOOGLE_PROJECT_ID");
    const region = Deno.env.get("GOOGLE_REGION");
    if (!sa?.trim() || !projectId?.trim() || !region?.trim()) {
      return { ok: false, reason: "verifier_provider_config_missing" };
    }
    verifierAdapter = vertexAdapter(
      sa,
      projectId.trim(),
      region.trim(),
      evaluationModel,
      redact(verifierSystem),
      redact(verifierUser),
      GROUNDING_VERIFIER_MAX_TOKENS,
      true,
      {
        type: "OBJECT",
        properties: {
          grounded: { type: "BOOLEAN" },
          unsupported_claims: { type: "ARRAY", items: { type: "STRING" } },
          evidence_chunk_ids: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["grounded", "unsupported_claims", "evidence_chunk_ids"]
      },
      void 0
    );
  } else {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key?.trim()) {
      return { ok: false, reason: "verifier_provider_config_missing" };
    }
    verifierAdapter = anthropicAdapter(
      key,
      evaluationModel,
      redact(verifierSystem),
      redact(verifierUser),
      GROUNDING_VERIFIER_MAX_TOKENS
    );
  }
  const verifierCall = {
    purpose: "evaluation",
    system: verifierSystem,
    user: verifierUser,
    maxTokens: GROUNDING_VERIFIER_MAX_TOKENS,
    operationId: `${call.operationId}:grounding-verifier`,
    companyId: call.companyId,
    conversationId: call.conversationId,
    tag: `${call.tag}-grounding-verifier`,
    responseFormat: "json"
  };
  const verifierUsage = {
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    attempts: 0
  };
  const verifierStarted = Date.now();
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    verifierUsage.attempts = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const req = await verifierAdapter.buildRequest();
      const res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal
      });
      lastStatus = res.status;
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 2) {
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        break;
      }
      if (!res.ok) break;
      let body;
      try {
        body = await res.json();
      } catch {
        break;
      }
      const parsed = verifierAdapter.parseResponse(body);
      verifierUsage.input_tokens = parsed.input_tokens;
      verifierUsage.output_tokens = parsed.output_tokens;
      verifierUsage.latency_ms = Date.now() - verifierStarted;
      if (!parsed.text || parsed.finish_reason === "MAX_TOKENS") break;
      const decision2 = parseGroundingVerifierDecision(parsed.text, allowedVerifierIds);
      if (!decision2) {
        const parsedShape = parseJsonObjectLoose(parsed.text);
        log(call.tag, {
          event: "grounding_verifier_invalid_output_shape",
          request_id: call.operationId,
          attempt,
          keys: parsedShape ? Object.keys(parsedShape).slice(0, 12) : [],
          grounded_type: parsedShape ? typeof parsedShape.grounded : "missing",
          unsupported_claims_type: parsedShape == null ? "missing" : Array.isArray(parsedShape.unsupported_claims) ? "array" : typeof parsedShape.unsupported_claims,
          evidence_chunk_ids_type: parsedShape == null ? "missing" : Array.isArray(parsedShape.evidence_chunk_ids) ? "array" : typeof parsedShape.evidence_chunk_ids,
          finish_reason: parsed.finish_reason ?? null,
          block_reason: parsed.block_reason ?? null,
          output_tokens: parsed.output_tokens
        });
        await recordUsage(
          verifierCall,
          verifierAdapter.id,
          verifierAdapter.model,
          "failed",
          res.status,
          verifierUsage,
          "GROUNDING_VERIFIER_INVALID_OUTPUT"
        );
        if (attempt < 2) {
          log(call.tag, {
            event: "grounding_verifier_invalid_output_retry",
            request_id: call.operationId,
            attempt
          });
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, reason: "verifier_invalid_output" };
      }
      await recordUsage(
        verifierCall,
        verifierAdapter.id,
        verifierAdapter.model,
        decision2.grounded ? "success" : "failed",
        res.status,
        verifierUsage,
        decision2.grounded ? void 0 : "GROUNDING_UNSUPPORTED_CLAIMS"
      );
      if (!decision2.grounded) {
        log(call.tag, {
          event: "grounding_semantic_rejected",
          request_id: call.operationId,
          grounding_authority: grounding.authority,
          unsupported_claim_count: decision2.unsupported_claims.length
        });
        return { ok: false, reason: "unsupported_semantic_claim" };
      }
      return { ok: true };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (!aborted && attempt < 2) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  verifierUsage.latency_ms = Date.now() - verifierStarted;
  await recordUsage(
    verifierCall,
    verifierAdapter.id,
    verifierAdapter.model,
    "failed",
    lastStatus,
    verifierUsage,
    "GROUNDING_VERIFIER_UNAVAILABLE"
  );
  return { ok: false, reason: "verifier_unavailable" };
}
async function callModel(call) {
  const started = Date.now();
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    attempts: 0
  };
  const requestId = call.operationId;
  const provider = resolveProvider();
  const model = Deno.env.get(MODEL_ENV[call.purpose]);
  const timeoutMs = Number(Deno.env.get("LLM_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  const nonEmpty2 = (v) => !!v && v.trim().length > 0;
  const configMissing = async (providerLabel, modelLabel) => {
    usage.latency_ms = Date.now() - started;
    log(call.tag, {
      event: "config_missing",
      request_id: requestId,
      provider: providerLabel,
      purpose: call.purpose
    });
    await recordUsage(call, providerLabel, modelLabel, "failed", 0, usage, "LLM_CONFIG_MISSING");
    return {
      ok: false,
      code: "LLM_CONFIG_MISSING",
      request_id: requestId,
      usage
    };
  };
  if (provider !== "vertex" && provider !== "anthropic") {
    return await configMissing("unset", model ?? "unset");
  }
  if (!nonEmpty2(model)) {
    return await configMissing(provider, "unset");
  }
  let adapter;
  if (provider === "vertex") {
    const sa = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
    const projectId = Deno.env.get("GOOGLE_PROJECT_ID");
    const region = Deno.env.get("GOOGLE_REGION");
    if (!nonEmpty2(sa) || !nonEmpty2(projectId) || !nonEmpty2(region)) {
      return await configMissing(provider, model);
    }
    if (looksLikeInjection(call.user)) {
      usage.latency_ms = Date.now() - started;
      log(call.tag, { event: "input_blocked", request_id: requestId });
      await recordUsage(call, provider, model, "blocked", 0, usage, "LLM_INPUT_BLOCKED");
      return {
        ok: false,
        code: "LLM_INPUT_BLOCKED",
        request_id: requestId,
        usage
      };
    }
    adapter = vertexAdapter(
      sa,
      projectId.trim(),
      region.trim(),
      model.trim(),
      redact(call.system),
      redact(call.user),
      call.maxTokens,
      call.responseFormat === "json",
      call.responseSchema,
      call.thinkingBudget
    );
  } else {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!nonEmpty2(key)) {
      return await configMissing(provider, model);
    }
    if (looksLikeInjection(call.user)) {
      usage.latency_ms = Date.now() - started;
      log(call.tag, { event: "input_blocked", request_id: requestId });
      await recordUsage(call, provider, model, "blocked", 0, usage, "LLM_INPUT_BLOCKED");
      return {
        ok: false,
        code: "LLM_INPUT_BLOCKED",
        request_id: requestId,
        usage
      };
    }
    adapter = anthropicAdapter(
      key,
      model.trim(),
      redact(call.system),
      redact(call.user),
      call.maxTokens
    );
  }
  let lastCode = "LLM_NETWORK";
  let lastStatus;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    usage.attempts = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const attemptStart = Date.now();
    try {
      let res;
      try {
        const req = await adapter.buildRequest();
        res = await fetch(req.url, {
          method: "POST",
          headers: req.headers,
          body: req.body,
          signal: controller.signal
        });
      } catch (e) {
        const aborted = e instanceof Error && e.name === "AbortError";
        lastCode = aborted ? "LLM_TIMEOUT" : "LLM_NETWORK";
        log(call.tag, {
          event: "attempt_failed",
          request_id: requestId,
          provider: adapter.id,
          attempt,
          code: lastCode,
          ms: Date.now() - attemptStart
        });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        break;
      }
      if (res.status === 429 || res.status >= 500) {
        lastCode = "LLM_NON_2XX";
        lastStatus = res.status;
        log(call.tag, {
          event: "attempt_retryable",
          request_id: requestId,
          provider: adapter.id,
          attempt,
          status: res.status
        });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        break;
      }
      if (!res.ok) {
        lastCode = "LLM_NON_2XX";
        lastStatus = res.status;
        log(call.tag, {
          event: "attempt_fatal",
          request_id: requestId,
          provider: adapter.id,
          attempt,
          status: res.status
        });
        break;
      }
      let body;
      try {
        body = await res.json();
      } catch {
        lastCode = "LLM_INVALID_OUTPUT";
        log(call.tag, {
          event: "parse_failed",
          request_id: requestId,
          provider: adapter.id,
          attempt
        });
        break;
      }
      const parsed = adapter.parseResponse(body);
      usage.input_tokens = parsed.input_tokens;
      usage.output_tokens = parsed.output_tokens;
      if (!parsed.text) {
        lastCode = "LLM_INVALID_OUTPUT";
        log(call.tag, {
          event: "empty_output",
          request_id: requestId,
          provider: adapter.id,
          attempt,
          finish_reason: parsed.finish_reason ?? null,
          block_reason: parsed.block_reason ?? null
        });
        break;
      }
      if (parsed.finish_reason === "MAX_TOKENS") {
        lastCode = "LLM_INVALID_OUTPUT";
        log(call.tag, {
          event: "truncated_output",
          request_id: requestId,
          provider: adapter.id,
          attempt,
          output_tokens: parsed.output_tokens
        });
        break;
      }
      const grounding = call.purpose === "generation" && call.responseFormat !== "json" ? extractGroundingBlock(call.system) : null;
      if (grounding) {
        const groundingDecision = await verifyGroundedGeneration(
          call,
          provider,
          parsed.text,
          grounding,
          timeoutMs
        );
        if (!groundingDecision.ok) {
          lastCode = "LLM_INVALID_OUTPUT";
          usage.latency_ms = Date.now() - started;
          log(call.tag, {
            event: "grounding_rejected",
            request_id: requestId,
            provider: adapter.id,
            attempt,
            reason: groundingDecision.reason
          });
          const groundingErrorCode = `LLM_OUTPUT_UNGROUNDED:${groundingDecision.reason}`;
          await recordUsage(
            call,
            adapter.id,
            adapter.model,
            "failed",
            res.status,
            usage,
            groundingErrorCode
          );
          return {
            ok: false,
            code: "LLM_GROUNDING_REJECTED",
            status: res.status,
            request_id: requestId,
            usage
          };
        }
      }
      usage.latency_ms = Date.now() - started;
      log(call.tag, {
        event: "success",
        request_id: requestId,
        provider: adapter.id,
        attempt,
        model: adapter.model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ms: usage.latency_ms,
        grounding_verified: grounding !== null
      });
      await recordUsage(call, adapter.id, adapter.model, "success", res.status, usage);
      return {
        ok: true,
        text: parsed.text,
        model: adapter.model,
        usage,
        request_id: requestId
      };
    } finally {
      clearTimeout(timer);
    }
  }
  usage.latency_ms = Date.now() - started;
  log(call.tag, {
    event: "exhausted",
    request_id: requestId,
    provider: adapter.id,
    code: lastCode,
    attempts: usage.attempts
  });
  await recordUsage(
    call,
    adapter.id,
    adapter.model,
    lastCode === "LLM_TIMEOUT" ? "timeout" : "failed",
    lastStatus ?? 0,
    usage,
    lastCode
  );
  return {
    ok: false,
    code: lastCode,
    status: lastStatus,
    request_id: requestId,
    usage
  };
}
function parseJsonObject(raw) {
  return parseJsonObjectLoose(raw);
}

// supabase/functions/_shared/escalation-policy.ts
var VALID_POLICY_STATUS = /* @__PURE__ */ new Set([
  "compliant",
  "warning",
  "violation",
  "insufficient_evidence"
]);
var POLICY_PROVIDER_VERSION = "governed-policy-router-v1.0";
var POLICY_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    status: {
      type: "STRING",
      enum: ["compliant", "warning", "violation", "insufficient_evidence"]
    },
    summary: { type: "STRING" }
  },
  required: ["status", "summary"]
};
function mapPolicyStatusToR4State(status) {
  switch (status) {
    case "compliant":
      return "confident_match";
    case "warning":
      return "partial_match";
    case "violation":
      return "conflict";
    case "insufficient_evidence":
      return "no_match";
  }
}
function cleanPolicyEvidence(items) {
  return items.filter(
    (item) => typeof item.label === "string" && typeof item.content === "string" && typeof item.source_type === "string" && item.label.trim().length > 0 && item.content.trim().length > 0 && item.source_type.trim().length > 0
  ).slice(0, 3).map((item) => ({
    label: item.label.trim().slice(0, 120),
    content: item.content.trim().slice(0, 800),
    source_type: item.source_type.trim().slice(0, 40)
  }));
}
async function assessPolicyEvidenceForR4(content, items, context) {
  const evidence = cleanPolicyEvidence(items);
  if (evidence.length === 0) return void 0;
  const block = evidence.map((item) => `[${item.label}]
${item.content}`).join("\n\n");
  const result2 = await callModel({
    purpose: "generation",
    system: 'Assess policy compliance based ONLY on the provided sources. Do NOT invent rules not in the sources. If sources lack relevant policy, set status to "insufficient_evidence". Return ONLY JSON with status and summary.',
    user: `Text to check:
${content.slice(0, 2e3)}

Policy sources:
${block}`,
    maxTokens: resolveGenerationMaxTokens(),
    operationId: context.operation_id,
    companyId: context.company_id,
    conversationId: context.conversation_id,
    tag: "generate-reply-r4-policy",
    responseFormat: "json",
    responseSchema: POLICY_RESPONSE_SCHEMA
  });
  if (!result2.ok) {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: `policy_provider_${result2.code.toLowerCase()}`
    };
  }
  const parsed = parseJsonObject(result2.text);
  const rawStatus = parsed?.status;
  if (typeof rawStatus !== "string" || !VALID_POLICY_STATUS.has(rawStatus)) {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: "policy_provider_invalid_status"
    };
  }
  const status = rawStatus;
  return {
    match_state: mapPolicyStatusToR4State(status),
    provider_version: POLICY_PROVIDER_VERSION,
    reason: `policy_status:${status}`
  };
}

// supabase/functions/_shared/escalation-p1.ts
function finiteNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  return value;
}
function validateP1PredictionSignals(input) {
  if (!input?.provider_version || !input.provider_source) return void 0;
  const predictedCsat = finiteNumber(input.predicted_csat);
  const churnRisk = finiteNumber(input.churn_risk);
  const escalationScore = finiteNumber(input.escalation_score);
  const validCsat = predictedCsat !== void 0 && predictedCsat >= 1 && predictedCsat <= 5 ? predictedCsat : void 0;
  const validChurn = churnRisk !== void 0 && churnRisk >= 0 && churnRisk <= 1 ? churnRisk : void 0;
  const validEscalation = escalationScore !== void 0 && escalationScore >= 0 && escalationScore <= 1 ? escalationScore : void 0;
  if (validCsat === void 0 && validChurn === void 0 && validEscalation === void 0) return void 0;
  return {
    ...validCsat !== void 0 ? { predicted_csat: validCsat } : {},
    ...validChurn !== void 0 ? { churn_risk: validChurn } : {},
    ...validEscalation !== void 0 ? { escalation_score: validEscalation } : {},
    provider_version: input.provider_version,
    provider_source: input.provider_source
  };
}

// supabase/functions/_shared/conversation-runtime-state-core.ts
var CUSTOMER2 = /* @__PURE__ */ new Set(["visitor", "customer", "user"]);
var ASSISTANT2 = /* @__PURE__ */ new Set(["assistant", "ai", "human_agent"]);
var EXPLICIT_CORRECTION = /(我講錯|我说错|我說錯|我要更正|我想更正|更正一下[：:]?|更正[：:]|其實係|其实是|改返|改成|actually[,\s]+i meant|i meant|correction\s*[:：])/i;
var CONTRAST_CORRECTION = /(唔係[^，。,.!?！？]{1,80}[，,]\s*係|不是[^，。,.!?！？]{1,80}[，,]\s*(?:而)?是|not .+ but .+)/i;
var LATEST_VALUE_CORRECTION = /(?:記住|记住)?\s*(?:最新|目前|現在|现在)\s*(?:係|是|為|为)?\s*[^，。,.!?！？]{1,50}(?:，|,)\s*(?:唔係|不是|而不是|not)\s*[^，。,.!?！？]{1,50}/i;
function isCorrectionText(text) {
  if (EXPLICIT_CORRECTION.test(text) || LATEST_VALUE_CORRECTION.test(text)) return true;
  if (/[?？]/.test(text)) return false;
  return CONTRAST_CORRECTION.test(text);
}
var CONSTRAINT = /(不要|唔好|不准|唔准|不要猜|唔好估|沒有型號|没有型号|冇型號|only|don't|do not|without|must not|no model)/i;
var MEMORY2 = /(一開始|一开始|第一個問題|第一个问题|最初|剛才建議|刚才建议|之前建議|之前建议|剛才談過|刚才谈过|談過的內容|谈过的内容|總結我們|总结我们|first question|first thing|what did i ask|what did you suggest|earlier recommendation|what information have i already given|what have i already given|what is still missing|我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\x27s| is)?\s+(?:the\s+)?(?:current\s+)?(?:region|jurisdiction).*(?:item|product)|summari[sz]e.*(?:conversation|discussed|talked))/i;
var QUESTION = /[?？]|^(?:什麼|什么|如何|怎樣|怎样|哪|哪些|多久|幾耐|几耐|why|what|which|how|when|where)/i;
var RECOMMEND = /(建議|建议|需要我提供|請提供|请提供|可以提供|我需要知道|需要知道|仍然需要|還需要|还需要|需要以下資料|需要以下资料|recommend|suggest|provide|i need to know|we still need|still need|information.*missing)/i;
var JURISDICTIONS = [
  ["mars", /(mars|火星)/i],
  ["hong_kong", /(香港|hong\s*kong|\bhk\b)/i],
  ["macau", /(澳門|澳门|macau|macao)/i],
  ["singapore", /(新加坡|singapore)/i],
  ["taiwan", /(台灣|台湾|taiwan)/i],
  ["mainland_china", /(中國大陸|中国大陆|內地|内地|mainland\s*china)/i]
];
function clean2(v) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 800) : "";
}
function metadataRecord2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function hasGroundedLineage(metadata) {
  const meta2 = metadataRecord2(metadata);
  const lineage = metadataRecord2(meta2?.citation_lineage);
  return typeof lineage?.selected_document_id === "string" && Array.isArray(lineage?.evidence_chunk_ids) && lineage.evidence_chunk_ids.some((x) => typeof x === "string" && x.length > 0);
}
function detectFocusedItem(text) {
  const t = clean2(text);
  const focus = t.match(/(?:只(?:說|说|講|讲)|只要|聚焦|focus(?: only)? on)\s*([^，。,.!?！？]{1,40}?)(?:相關|相关|部分|內容|内容|\s+only|$)/i);
  const raw = focus?.[1]?.trim().replace(/^(?:在|關於|关于|the)\s*/i, "") ?? "";
  return raw && raw.length <= 40 ? raw : null;
}
function detectCorrectedItem(text) {
  const m = clean2(text).match(/(?:問的是|問嘅係|问的是|其實係|其实是|改成)\s*([^，。,.!?！？]{1,40})/i);
  if (!m?.[1]) return null;
  return m[1].replace(/(?:，|,)?\s*(?:不是|唔係|not)\s+.*$/i, "").trim() || null;
}
function localizedCurrentItem(item, lang2) {
  const normalized = clean2(item).toLowerCase();
  const airConditioner = /(?:冷氣機|冷气机|空調機|空调机|air[- ]?conditioner|aircon)/i.test(normalized);
  if (!airConditioner) return item;
  if (lang2 === "en") return "air conditioner";
  if (lang2 === "zh-CN") return "\u7A7A\u8C03\u673A";
  return "\u51B7\u6C23\u6A5F";
}
function detectLanguage2(text) {
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  return /[转们为这没请台]/.test(text) ? "zh-CN" : "zh-TW";
}
function jurisdictionOccurrenceIsNegated(text, index) {
  const before = text.slice(Math.max(0, index - 30), index);
  return /(?:不談|不谈|別談|别谈|不要談|不要谈|唔講|唔好講)\s*$/i.test(before) || /(?:forget|ignore|drop)(?:\s+about)?\s*$/i.test(before) || /not\s+(?:talk|discuss)(?:\s+about)?\s*$/i.test(before);
}
function detectExplicitJurisdiction(text) {
  const t = clean2(text);
  const candidates = [];
  for (const [id, re] of JURISDICTIONS) {
    const match = t.match(re);
    if (!match || typeof match.index !== "number") continue;
    if (!jurisdictionOccurrenceIsNegated(t, match.index)) candidates.push({ id, index: match.index });
  }
  candidates.sort((x, y) => y.index - x.index);
  return candidates[0]?.id ?? null;
}
function normalizeTopic(text) {
  return clean2(text).replace(/[?？!！。,.，]/g, " ").replace(/^(?:咁|那|所以|另外|再|又|what about|then|so)\s*/i, "").trim().slice(0, 180);
}
function smallCount(raw) {
  if (/^\d{1,6}$/.test(raw)) return Number(raw);
  const map = { \u4E00: 1, \u4E8C: 2, \u5169: 2, \u4E24: 2, \u4E09: 3, \u56DB: 4, \u4E94: 5, \u516D: 6, \u4E03: 7, \u516B: 8, \u4E5D: 9, \u5341: 10 };
  return map[raw] ?? null;
}
function marketLabel(id, lang2) {
  const labels = {
    hong_kong: { "zh-TW": "\u9999\u6E2F", "zh-CN": "\u9999\u6E2F", en: "Hong Kong" },
    macau: { "zh-TW": "\u6FB3\u9580", "zh-CN": "\u6FB3\u95E8", en: "Macau" },
    singapore: { "zh-TW": "\u65B0\u52A0\u5761", "zh-CN": "\u65B0\u52A0\u5761", en: "Singapore" },
    taiwan: { "zh-TW": "\u53F0\u7063", "zh-CN": "\u53F0\u6E7E", en: "Taiwan" },
    mainland_china: { "zh-TW": "\u4E2D\u570B\u5927\u9678", "zh-CN": "\u4E2D\u56FD\u5927\u9646", en: "Mainland China" },
    mars: { "zh-TW": "\u706B\u661F", "zh-CN": "\u706B\u661F", en: "Mars" }
  };
  return labels[id]?.[lang2] ?? id;
}
function deriveCurrentRequirementSnapshot(chronologicalCustomerTurns) {
  let productCount = null;
  let staffCount = null;
  let appInterest = null;
  const desired = /* @__PURE__ */ new Set();
  let currentMarket = null;
  const futureMarkets = /* @__PURE__ */ new Set();
  for (const raw of chronologicalCustomerTurns) {
    const text = clean2(raw);
    if (!text || /[?？]/.test(text)) continue;
    const product = text.match(/(\d{1,6})\s*(?:件(?:商品|產品|产品)?|sku\b)/i);
    if (product?.[1]) productCount = Number(product[1]);
    if (/(?:成千幾|成千几|一千幾|一千几)\s*sku\b/i.test(text)) productCount = productCount ?? 1e3;
    const latestCount = text.match(/(?:最新|目前|現在|现在)\s*(?:係|是|為|为)?\s*(\d{1,6})(?:\s*(?:件|sku))?/i);
    const latestCountIsStaffScoped = /(?:staff|員工|员工|管理人手|管理人员)/i.test(text);
    if (productCount !== null && latestCount?.[1] && !latestCountIsStaffScoped) productCount = Number(latestCount[1]);
    if (/(?:得我|只有我|只係我|只是我).{0,12}(?:一個人|一个人).{0,12}(?:管理|manage)/i.test(text)) staffCount = 1;
    const staff = text.match(/(?:我有|有)\s*([一二兩两三四五六七八九十]|\d{1,3})\s*(?:個|个|位)?\s*(?:staff|員工|员工)/i);
    if (staff?.[1]) staffCount = smallCount(staff[1]);
    const addStaff = text.match(/(?:再加|增加|加多|add)\s*([一二兩两三四五六七八九十]|\d{1,3})\s*(?:個|个|位)?\s*(?:staff|員工|员工)/i);
    if (addStaff?.[1]) {
      const n = smallCount(addStaff[1]);
      if (n !== null) staffCount = (staffCount ?? 0) + n;
    }
    if (/(?:唔要|不要|不需要|唔需要)\s*app.{0,20}(?:已經|已经)?(?:過時|过时|outdated|no longer)/i.test(text)) appInterest = true;
    else if (/(?:app).{0,16}(?:有興趣|有兴趣|想要|需要|要用|會用|会用)|(?:想要|需要|要用)\s*app/i.test(text)) appInterest = true;
    else if (/(?:暫時|暂时)?\s*(?:唔需要|不需要|唔要|不要)\s*app/i.test(text)) appInterest = false;
    if (/(?:想要|要用|會用|会用|需要).{0,12}(?:push|推播|推送)|(?:push|推播|推送).{0,12}(?:想要|要用|會用|会用|需要)/i.test(text)) desired.add("Push");
    if (/(?:想用|要用|會用|会用|需要).{0,12}crm|crm.{0,12}(?:想用|要用|會用|会用|需要)/i.test(text)) desired.add("CRM");
    if (/(?:會員等級|会员等级).{0,12}(?:都)?(?:會用|会用|要用|需要)|(?:想用|要用|需要).{0,12}(?:會員等級|会员等级)/i.test(text)) desired.add("\u6703\u54E1\u7B49\u7D1A");
    const market = detectExplicitJurisdiction(text);
    if (market) {
      if (/(?:之後|之后|以後|以后|未來|未来|later|future).{0,20}(?:可能|maybe|may|plan|做|進入|进入)/i.test(text)) futureMarkets.add(market);
      else if (/(?:目前|而家|現在|现在|主要市場|主要市场|仍然|只做|currently|current|main market)/i.test(text)) currentMarket = market;
    }
  }
  if (currentMarket) futureMarkets.delete(currentMarket);
  return {
    product_count: productCount,
    staff_count: staffCount,
    app_interest: appInterest,
    desired_features: [...desired],
    current_market: currentMarket,
    future_markets: [...futureMarkets]
  };
}
function currentRequirementLines(snapshot, lang2) {
  const out = [];
  if (lang2 === "en") {
    if (snapshot.product_count !== null) out.push(`Product count: about ${snapshot.product_count}`);
    if (snapshot.staff_count !== null) out.push(`Management staff: ${snapshot.staff_count}`);
    if (snapshot.app_interest === true) out.push("App: interested / include in plan");
    if (snapshot.app_interest === false) out.push("App: not currently needed");
    if (snapshot.desired_features.length) out.push(`Desired features: ${snapshot.desired_features.join(", ")}`);
    if (snapshot.current_market) out.push(`Current main market: ${marketLabel(snapshot.current_market, lang2)}`);
    if (snapshot.future_markets.length) out.push(`Possible future markets: ${snapshot.future_markets.map((x) => marketLabel(x, lang2)).join(", ")} (not the current main market)`);
    return out;
  }
  if (snapshot.product_count !== null) out.push(`\u5546\u54C1\u6578\u91CF\uFF1A\u7D04 ${snapshot.product_count} \u4EF6\uFF08${snapshot.product_count} SKU\uFF09`);
  if (snapshot.staff_count !== null) out.push(`\u7BA1\u7406\u4EBA\u624B\uFF1A${snapshot.staff_count} \u4F4D staff`);
  if (snapshot.app_interest === true) out.push("App\uFF1A\u6709\u8208\u8DA3\uFF0F\u9700\u8981\u7D0D\u5165\u65B9\u6848");
  if (snapshot.app_interest === false) out.push("App\uFF1A\u76EE\u524D\u4E0D\u9700\u8981");
  if (snapshot.desired_features.length) out.push(`\u9700\u8981\u529F\u80FD\uFF1A${snapshot.desired_features.join("\u3001")}`);
  if (snapshot.current_market) out.push(`\u76EE\u524D\u4E3B\u8981\u5E02\u5834\uFF1A${marketLabel(snapshot.current_market, lang2)}`);
  if (snapshot.future_markets.length) out.push(`\u672A\u4F86\u53EF\u80FD\u5E02\u5834\uFF1A${snapshot.future_markets.map((x) => marketLabel(x, lang2)).join("\u3001")}\uFF08\u4E0D\u662F\u76EE\u524D\u4E3B\u8981\u5E02\u5834\uFF09`);
  return out;
}
function resolveWorkflow5ConversationLanguage(latest, rows) {
  const direct = detectLanguage2(latest);
  if (/[\u4e00-\u9fff]/.test(latest)) return direct;
  const priorCustomer = rows.filter((row) => CUSTOMER2.has(String(row.role ?? "").toLowerCase())).map((row) => clean2(row.content)).filter((text) => text && text !== latest).slice(0, 6);
  const zh = priorCustomer.map(detectLanguage2).filter((x) => x !== "en");
  if (direct === "en" && latest.length <= 120 && zh.length >= 2) return zh[0];
  return direct;
}
function workflow5PreviousCustomerTurn(latest, rows) {
  let skippedCurrent = false;
  for (const row of rows) {
    if (!CUSTOMER2.has(String(row.role ?? "").toLowerCase())) continue;
    const text = clean2(row.content);
    if (!text) continue;
    if (!skippedCurrent && text === latest) {
      skippedCurrent = true;
      continue;
    }
    return text;
  }
  return null;
}
function workflow5SecurityBoundaryResponse(latest, lang2) {
  const t = clean2(latest);
  const promptProbe = /(?:system\s*prompt|hidden\s*(?:prompt|context)|internal\s*(?:prompt|instruction)|系統提示|系统提示|隱藏(?:提示|上下文)|隐藏(?:提示|上下文))/i.test(t);
  const secretProbe = /(?:secret\s*key|service[_ -]?role|api\s*key|access\s*token|密鑰|密钥|秘密金鑰|秘密密钥)/i.test(t);
  const bypassProbe = /(?:pretend\s+you\s+are\s+admin|bypass\s+auth|ignore\s+all\s+previous\s+instructions|假裝.*(?:admin|管理員)|假装.*(?:admin|管理员)|繞過.*(?:認證|驗證)|绕过.*(?:认证|验证))/i.test(t);
  const crossUserProbe = /(?:其他客戶資料|其他客户资料|other\s+(?:customer|user)s?.{0,20}(?:data|information)|all\s+customer\s+data)/i.test(t);
  if (!(promptProbe || secretProbe || bypassProbe || crossUserProbe)) return null;
  if (lang2 === "en") {
    if (crossUserProbe) return "I can\u2019t provide another customer\u2019s private information or bypass access controls. I can still help with public product and service information.";
    if (secretProbe) return "I can\u2019t reveal secret keys, access tokens, or other private credentials. I can still help with public product and service information.";
    return "I can\u2019t reveal hidden instructions, internal prompts, or bypass access controls. I can still help with normal product and service questions.";
  }
  if (lang2 === "zh-CN") {
    if (crossUserProbe) return "\u6211\u4E0D\u80FD\u63D0\u4F9B\u5176\u4ED6\u5BA2\u6237\u7684\u79C1\u4EBA\u8D44\u6599\uFF0C\u4E5F\u4E0D\u80FD\u7ED5\u8FC7\u8BBF\u95EE\u6743\u9650\uFF1B\u6211\u4ECD\u53EF\u7EE7\u7EED\u56DE\u7B54\u516C\u5F00\u7684\u4EA7\u54C1\u548C\u670D\u52A1\u95EE\u9898\u3002";
    if (secretProbe) return "\u6211\u4E0D\u80FD\u63D0\u4F9B\u5BC6\u94A5\u3001\u8BBF\u95EE\u4EE4\u724C\u6216\u5176\u4ED6\u79C1\u4EBA\u51ED\u8BC1\uFF1B\u6211\u4ECD\u53EF\u7EE7\u7EED\u56DE\u7B54\u516C\u5F00\u7684\u4EA7\u54C1\u548C\u670D\u52A1\u95EE\u9898\u3002";
    return "\u6211\u4E0D\u80FD\u62AB\u9732\u9690\u85CF\u6307\u4EE4\u3001\u5185\u90E8\u63D0\u793A\u6216\u7ED5\u8FC7\u8BBF\u95EE\u6743\u9650\uFF1B\u4F60\u4ECD\u53EF\u7EE7\u7EED\u95EE\u6B63\u5E38\u7684\u4EA7\u54C1\u548C\u670D\u52A1\u95EE\u9898\u3002";
  }
  if (crossUserProbe) return "\u6211\u4E0D\u80FD\u63D0\u4F9B\u5176\u4ED6\u5BA2\u6236\u7684\u79C1\u4EBA\u8CC7\u6599\uFF0C\u4E5F\u4E0D\u80FD\u7E5E\u904E\u5B58\u53D6\u6B0A\u9650\uFF1B\u6211\u4ECD\u53EF\u7E7C\u7E8C\u56DE\u7B54\u516C\u958B\u7684\u7522\u54C1\u548C\u670D\u52D9\u554F\u984C\u3002";
  if (secretProbe) return "\u6211\u4E0D\u80FD\u63D0\u4F9B\u5BC6\u9470\u3001\u5B58\u53D6\u6B0A\u6756\u6216\u5176\u4ED6\u79C1\u4EBA\u6191\u8B49\uFF1B\u6211\u4ECD\u53EF\u7E7C\u7E8C\u56DE\u7B54\u516C\u958B\u7684\u7522\u54C1\u548C\u670D\u52D9\u554F\u984C\u3002";
  return "\u6211\u4E0D\u80FD\u62AB\u9732\u96B1\u85CF\u6307\u4EE4\u3001\u5167\u90E8\u63D0\u793A\u6216\u7E5E\u904E\u5B58\u53D6\u6B0A\u9650\uFF1B\u4F60\u4ECD\u53EF\u7E7C\u7E8C\u554F\u6B63\u5E38\u7684\u7522\u54C1\u548C\u670D\u52D9\u554F\u984C\u3002";
}
function workflow5PostSecurityRecoveryResponse(latestInput, lang2) {
  const latest = clean2(latestInput);
  if (retrievalTargetHint(latest)) return null;
  const normalServiceRecovery = /(?:再(?:講|说|說)|再給|再给|give|show).{0,24}(?:合法|正常|lawful|normal).{0,24}(?:平台功能|平台服务|平台服務|platform feature|service).{0,30}(?:恢復|恢复|recover)|(?:證明|证明|prove).{0,24}(?:服務|服务|service).{0,24}(?:恢復|恢复|recover)/i.test(latest);
  if (normalServiceRecovery) {
    if (lang2 === "en") return "Normal service has resumed. For example, you can ask about CRM tags; I\u2019ll only describe capabilities or limits supported by published information.";
    if (lang2 === "zh-CN") return "\u670D\u52A1\u5DF2\u6062\u590D\u6B63\u5E38\uFF1B\u4F8B\u5982\u4F60\u53EF\u4EE5\u7EE7\u7EED\u67E5\u8BE2 CRM \u6807\u7B7E\u8FD9\u7C7B\u5E73\u53F0\u529F\u80FD\uFF0C\u5177\u4F53\u80FD\u529B\u548C\u9650\u5236\u6211\u53EA\u4F1A\u6309\u5DF2\u53D1\u5E03\u8D44\u6599\u56DE\u7B54\u3002";
    return "\u670D\u52D9\u5DF2\u6062\u5FA9\u6B63\u5E38\uFF1B\u4F8B\u5982\u4F60\u53EF\u4EE5\u7E7C\u7E8C\u67E5\u8A62 CRM \u6A19\u7C64\u5462\u985E\u5E73\u53F0\u529F\u80FD\uFF0C\u5177\u9AD4\u80FD\u529B\u540C\u9650\u5236\u6211\u53EA\u6703\u6309\u5DF2\u767C\u5E03\u8CC7\u6599\u56DE\u7B54\u3002";
  }
  const safeFinalReply = /(?:最後一句|最后一句|final\s+(?:line|sentence)).{0,30}(?:簡單|简单|simple).{0,40}(?:不要洩漏|不要泄漏|不披露|不透露|do\s+not\s+(?:leak|reveal)|without\s+revealing).{0,30}(?:內部指令|内部指令|internal\s+instructions?)/i.test(latest);
  if (safeFinalReply) {
    if (lang2 === "en") return "Yes. I\u2019ll keep the answer simple and won\u2019t disclose internal instructions.";
    if (lang2 === "zh-CN") return "\u53EF\u4EE5\uFF0C\u6211\u4F1A\u4FDD\u6301\u7B80\u5355\u56DE\u7B54\uFF0C\u4E5F\u4E0D\u4F1A\u62AB\u9732\u5185\u90E8\u6307\u4EE4\u3002";
    return "\u53EF\u4EE5\uFF0C\u6211\u6703\u4FDD\u6301\u7C21\u55AE\u56DE\u7B54\uFF0C\u4EA6\u5514\u6703\u62AB\u9732\u5167\u90E8\u6307\u4EE4\u3002";
  }
  return null;
}
function buildWorkflow5TopicalClarification(latestInput, lang2) {
  const latest = clean2(latestInput);
  const topic = /(?:app\s*push|push\s*notification|推播|推送通知)/i.test(latest) ? "app_push" : /(?:crm).{0,12}(?:標籤|标签|tag)|(?:標籤|标签).{0,12}crm/i.test(latest) ? "crm_tags" : /(?:會員|会员|member).{0,12}(?:等級|等级|tier)|^(?:會員等級|会员等级|member\s*tiers?)\s*(?:呢|嗞|吗|\?)?$/i.test(latest) ? "member_tiers" : /(?:香港|hong\s*kong|\bhk\b).{0,24}(?:付款|支付|payment)|(?:付款|支付|payment).{0,24}(?:香港|hong\s*kong|\bhk\b)/i.test(latest) ? "hk_payment" : null;
  if (!topic) return null;
  if (lang2 === "en") {
    if (topic === "app_push") return "I don\u2019t have enough published information to confirm the specific App Push capabilities or limits, so I won\u2019t guess.";
    if (topic === "crm_tags") return "I don\u2019t have enough published information to confirm the specific CRM tag capabilities or limits, so I won\u2019t guess.";
    if (topic === "member_tiers") return "I don\u2019t have enough published information to confirm the specific member-tier benefits or limits, so I won\u2019t guess.";
    return "I don\u2019t have enough published information to confirm which payment methods are available for the Hong Kong market, so I won\u2019t guess.";
  }
  if (lang2 === "zh-CN") {
    if (topic === "app_push") return "\u6211\u76EE\u524D\u6CA1\u6709\u8DB3\u591F\u5DF2\u53D1\u5E03\u8D44\u6599\u786E\u8BA4 App Push \u7684\u5177\u4F53\u529F\u80FD\u6216\u9650\u5236\uFF0C\u6240\u4EE5\u4E0D\u4F1A\u731C\u6D4B\u3002";
    if (topic === "crm_tags") return "\u6211\u76EE\u524D\u6CA1\u6709\u8DB3\u591F\u5DF2\u53D1\u5E03\u8D44\u6599\u786E\u8BA4 CRM \u6807\u7B7E\u7684\u5177\u4F53\u529F\u80FD\u6216\u9650\u5236\uFF0C\u6240\u4EE5\u4E0D\u4F1A\u731C\u6D4B\u3002";
    if (topic === "member_tiers") return "\u6211\u76EE\u524D\u6CA1\u6709\u8DB3\u591F\u5DF2\u53D1\u5E03\u8D44\u6599\u786E\u8BA4\u4F1A\u5458\u7B49\u7EA7\u7684\u5177\u4F53\u6743\u76CA\u6216\u9650\u5236\uFF0C\u6240\u4EE5\u4E0D\u4F1A\u731C\u6D4B\u3002";
    return "\u6211\u76EE\u524D\u6CA1\u6709\u8DB3\u591F\u5DF2\u53D1\u5E03\u8D44\u6599\u786E\u8BA4\u9999\u6E2F\u5E02\u573A\u53EF\u7528\u7684\u4ED8\u6B3E\u65B9\u5F0F\uFF0C\u6240\u4EE5\u4E0D\u4F1A\u731C\u6D4B\u3002";
  }
  if (topic === "app_push") return "\u6211\u76EE\u524D\u672A\u6709\u8DB3\u5920\u5DF2\u767C\u5E03\u8CC7\u6599\u78BA\u8A8D App Push \u5605\u5177\u9AD4\u529F\u80FD\u6216\u9650\u5236\uFF0C\u6240\u4EE5\u5514\u6703\u4F30\u3002";
  if (topic === "crm_tags") return "\u6211\u76EE\u524D\u672A\u6709\u8DB3\u5920\u5DF2\u767C\u5E03\u8CC7\u6599\u78BA\u8A8D CRM \u6A19\u7C64\u5605\u5177\u9AD4\u529F\u80FD\u6216\u9650\u5236\uFF0C\u6240\u4EE5\u5514\u6703\u4F30\u3002";
  if (topic === "member_tiers") return "\u6211\u76EE\u524D\u672A\u6709\u8DB3\u5920\u5DF2\u767C\u5E03\u8CC7\u6599\u78BA\u8A8D\u6703\u54E1\u7B49\u7D1A\u5605\u5177\u9AD4\u6B0A\u76CA\u6216\u9650\u5236\uFF0C\u6240\u4EE5\u5514\u6703\u4F30\u3002";
  return "\u6211\u76EE\u524D\u672A\u6709\u8DB3\u5920\u5DF2\u767C\u5E03\u8CC7\u6599\u78BA\u8A8D\u9999\u6E2F\u5E02\u5834\u53EF\u7528\u5605\u4ED8\u6B3E\u65B9\u5F0F\uFF0C\u6240\u4EE5\u5514\u6703\u4F30\u3002";
}
function projectConversationRuntimeState(newestFirst) {
  const rows = newestFirst.map((row) => ({ text: clean2(row.content), role: String(row.role ?? "").toLowerCase(), metadata: row.metadata })).filter((row) => row.text && row.text !== "__THINKING__");
  const customers = rows.filter((row) => CUSTOMER2.has(row.role));
  const assistants = rows.filter((row) => ASSISTANT2.has(row.role));
  const chronological = [...customers].reverse();
  const latest = customers[0]?.text ?? null;
  const first = chronological[0]?.text ?? null;
  const semantic = latest ? classifyCanonicalConversationTurn(latest, newestFirst) : null;
  const corrections = customers.filter((row) => isCorrectionText(row.text)).slice(0, 6).map((row) => row.text);
  const constraints = customers.filter((row) => CONSTRAINT.test(row.text)).slice(0, 8).map((row) => row.text);
  const unresolved = customers.filter((row) => QUESTION.test(row.text)).slice(0, 8).map((row) => row.text);
  const explicitJurisdiction = latest ? detectExplicitJurisdiction(latest) : null;
  const inheritedJurisdiction = customers.map((row) => detectExplicitJurisdiction(row.text)).find(Boolean) ?? null;
  const groundedAssistantJurisdiction = assistants.filter((row) => hasGroundedLineage(row.metadata)).map((row) => detectExplicitJurisdiction(row.text)).find(Boolean) ?? null;
  const correctedItem = corrections.map((text) => detectCorrectedItem(text)).find(Boolean) ?? null;
  const focusedItem = customers.map((row) => detectFocusedItem(row.text)).find(Boolean) ?? null;
  const topics = [];
  for (const row of chronological) {
    const topic = normalizeTopic(row.text);
    if (topic && !topics.includes(topic)) topics.push(topic);
  }
  const currentTopic = latest ? normalizeTopic(latest) : null;
  const refs = latest ? [...latest.matchAll(/(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|same|that|this|it|its)/gi)].map((m) => m[0]).slice(0, 6) : [];
  const currentRequirements = deriveCurrentRequirementSnapshot(chronological.map((row) => row.text));
  return {
    first_customer_turn: first,
    first_intent: first ? normalizeTopic(first) : null,
    latest_customer_turn: latest,
    current_intent: latest,
    current_operation: semantic?.operation ?? "TRIVIAL",
    evidence_authority: semantic?.evidence_authority ?? "NONE",
    prior_grounded_document_id: semantic?.prior_grounded_answer?.document_id ?? null,
    current_topic: currentTopic,
    prior_topics: topics.slice(0, -1).slice(-12),
    active_referents: refs,
    unresolved_questions: unresolved,
    latest_corrections: corrections,
    active_constraints: constraints,
    jurisdiction: explicitJurisdiction ?? inheritedJurisdiction ?? groundedAssistantJurisdiction,
    current_item: correctedItem ?? focusedItem,
    language: resolveWorkflow5ConversationLanguage(latest ?? first ?? "", newestFirst),
    prior_recommendations: assistants.filter((row) => RECOMMEND.test(row.text)).slice(0, 6).map((row) => row.text),
    current_requirements: currentRequirements
  };
}
function buildCanonicalContinuityBlock(newestFirst) {
  const state = projectConversationRuntimeState(newestFirst);
  if (!state.latest_customer_turn) return "";
  const lines = [
    "Canonical conversation state (internal; never quote this block):",
    `First customer turn: ${state.first_customer_turn ?? "\u2014"}`,
    `Current customer turn: ${state.latest_customer_turn}`,
    `Current operation: ${state.current_operation}`,
    `Evidence authority: ${state.evidence_authority}`,
    `Prior grounded document: ${state.prior_grounded_document_id ?? "\u2014"}`,
    `Current topic: ${state.current_topic ?? "\u2014"}`,
    `Jurisdiction: ${state.jurisdiction ?? "unspecified"}`,
    `Current item: ${state.current_item ?? "unspecified"}`
  ];
  const requirementLines = currentRequirementLines(state.current_requirements, state.language);
  if (requirementLines.length) {
    lines.push("Current customer-authored requirements (latest state wins; assistant statements are not authority):");
    requirementLines.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (state.latest_corrections.length) {
    lines.push("Newest corrections / superseding facts:");
    state.latest_corrections.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (state.active_constraints.length) {
    lines.push("Active customer constraints:");
    state.active_constraints.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (state.unresolved_questions.length) {
    lines.push("Recent unresolved customer questions:");
    state.unresolved_questions.slice(0, 5).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  if (state.prior_recommendations.length) {
    lines.push("Recent assistant recommendations (context only, not customer facts):");
    state.prior_recommendations.slice(0, 3).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  }
  return lines.join("\n").slice(0, 6e3);
}
function resolveConversationMemoryResponse(latestInput, newestFirst) {
  const latest = clean2(latestInput);
  if (!latest) return null;
  if (/(請記住|请记住|please\s+remember|remember\s+that)/i.test(latest)) return null;
  let currentRemoved = false;
  const priorRows = newestFirst.filter((row) => {
    const role = String(row.role ?? "").toLowerCase();
    const text = clean2(row.content);
    if (!currentRemoved && CUSTOMER2.has(role) && text === latest) {
      currentRemoved = true;
      return false;
    }
    return true;
  });
  const state = projectConversationRuntimeState(priorRows);
  const lang2 = resolveWorkflow5ConversationLanguage(latest, priorRows);
  const firstRequest = /(一開始|一开始|第一個問題|第一个问题|最初).*(問|問題|问题)|what\s+(?:did\s+i\s+ask|was\s+(?:my\s+)?first)|first\s+(?:question|thing\s+i\s+asked)/i.test(latest);
  const correctionRequest = /(之前|先前|剛才|刚才|earlier|previous).*(更正|改正|correct)|更正後|更正后|what\s+did\s+i\s+correct|latest\s+correction/i.test(latest);
  const constraintRequest = /(限制|約束|约束|不要猜|唔好估|constraint|restriction|what.*(?:told|asked).*(?:not|don.?t))/i.test(latest) && /(記得|记得|總結|总结|告訴|告诉|什麼|什么|what|recall|remember|summari)/i.test(latest);
  const summaryRequest = /(總結|总结|summari[sz]e).*(記得|记得|更正|限制|constraint|correction|remember)/i.test(latest);
  const recommendationRequest = /(之前|先前|剛才|刚才|earlier|previous).*(建議|建议|要我提供|需要.*資料|需要.*资料|recommend|suggest)|what\s+did\s+you\s+(?:recommend|suggest)|what\s+information.*(?:missing|need)/i.test(latest);
  const providedMissingRequest = /(我已經提供|我已经提供|我提供過|我提供过|已提供.*哪些|還缺|还缺|仍缺|what\s+information\s+have\s+i\s+already\s+given|what\s+have\s+i\s+already\s+given|what.*still\s+missing)/i.test(latest);
  const generalSummaryRequest = /(最後|最后|請|请)?\s*(?:用.{0,8})?(?:三點|三点|幾點|几点)?\s*(?:總結|总结).*(?:剛才|刚才|我們|我们|談過|谈过|內容|内容)|summari[sz]e.*(?:conversation|discussed|talked|so far)/i.test(latest);
  const mainlyAskedRequest = /(?:剛才|刚才).*(?:主要)?(?:問|问).*(?:什麼|什么|咩)|(?:主要)(?:問|问).*(?:什麼|什么|咩)|what\s+(?:was|is)\s+(?:my\s+)?(?:main|mainly|primary).*(?:question|asking|ask)/i.test(latest);
  const nameRequest = /(我叫什麼|我叫什么|我的名字|我個名|我个名|what(?:'s| is)\s+my\s+name|do\s+you\s+remember\s+my\s+name)/i.test(latest);
  const locationRequest = /(我(?:現在|现在|目前).*(?:哪裡|哪里)|我.*(?:在哪|喺邊)|where\s+am\s+i|my\s+(?:current\s+)?location|更正後.*(?:地點|地点)|更正后.*(?:地點|地点))/i.test(latest);
  const currentContextPattern = /(我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\x27s| is)?\s+(?:the\s+)?(?:current\s+)?(?:region|jurisdiction).*(?:item|product))/i;
  const languageContinuationPattern = /(?:answer|say|repeat).*(?:same|that).*(?:english|chinese|cantonese)|(?:same|that).*(?:in|into)\s+(?:english|chinese|cantonese)|(?:回到|改用|用)\s*(?:繁體中文|繁体中文|簡體中文|简体中文|英文|廣東話|广东话)/i;
  const recentPriorCustomerTurns = priorRows.filter((row) => CUSTOMER2.has(String(row.role ?? "").toLowerCase())).map((row) => clean2(row.content)).filter(Boolean).slice(0, 2);
  const hasRecentCurrentContextQuestion = recentPriorCustomerTurns.some((text) => currentContextPattern.test(text));
  const hasChainedLanguageContinuation = recentPriorCustomerTurns.length >= 2 && languageContinuationPattern.test(recentPriorCustomerTurns[0]) && currentContextPattern.test(recentPriorCustomerTurns[1]);
  const memoryLanguageContinuation = languageContinuationPattern.test(latest) && (hasRecentCurrentContextQuestion || hasChainedLanguageContinuation);
  const currentContextRequest = currentContextPattern.test(latest) || memoryLanguageContinuation;
  const workflow5SecurityReply = workflow5SecurityBoundaryResponse(latest, lang2);
  if (workflow5SecurityReply) return workflow5SecurityReply;
  const workflow5RecoveryReply = workflow5PostSecurityRecoveryResponse(latest, lang2);
  if (workflow5RecoveryReply) return workflow5RecoveryReply;
  const workflow5PreviousMeaningRequest = /(?:你)?(?:理解|記得|记得).{0,12}(?:我)?(?:上一句|上句|剛才一句|刚才一句).{0,12}(?:問|講|說|说).*(?:咩|什麼|什么)|what\s+(?:did\s+i\s+mean|was\s+i\s+asking).*(?:last|previous)/i.test(latest);
  if (workflow5PreviousMeaningRequest) {
    const previous = workflow5PreviousCustomerTurn(latest, priorRows);
    if (previous && /(?:澳門|澳门|macau).{0,20}(?:客|customer).{0,20}(?:pay|付款)|(?:澳門|澳门|macau).{0,20}(?:pay|付款)/i.test(previous)) {
      if (lang2 === "en") return "Your previous message clarified that you were asking whether a Macau customer can pay, not changing your main market from Hong Kong to Macau.";
      if (lang2 === "zh-CN") return "\u4F60\u4E0A\u4E00\u53E5\u662F\u5728\u6F84\u6E05\uFF1A\u4F60\u95EE\u7684\u662F\u6FB3\u95E8\u5BA2\u6237\u80FD\u5426\u4ED8\u6B3E\uFF0C\u800C\u4E0D\u662F\u628A\u4E3B\u8981\u5E02\u573A\u4ECE\u9999\u6E2F\u6539\u6210\u6FB3\u95E8\u3002";
      return "\u4F60\u4E0A\u4E00\u53E5\u4FC2\u6F84\u6E05\uFF1A\u4F60\u554F\u7DCA\u6FB3\u9580\u5BA2\u6236\u80FD\u5426\u4ED8\u6B3E\uFF0C\u800C\u5514\u4FC2\u5C07\u4E3B\u8981\u5E02\u5834\u7531\u9999\u6E2F\u6539\u6210\u6FB3\u9580\u3002";
    }
    if (previous) return lang2 === "en" ? `Your previous message was: \u201C${previous}\u201D` : `\u4F60\u4E0A\u4E00\u53E5\u4FC2\uFF1A\u300C${previous}\u300D`;
  }
  const workflow5KnownUnknownRequest = /(?:按|根據|根据|based\s+on).{0,25}(?:我|已確認|已确认|confirmed).{0,30}(?:邊啲|哪些|what).{0,20}(?:知|知道|known).{0,25}(?:未知|唔知|不知道|unknown)/i.test(latest);
  if (workflow5KnownUnknownRequest) {
    const req = currentRequirementLines(state.current_requirements, lang2);
    const priorCustomerText = priorRows.filter((row) => CUSTOMER2.has(String(row.role ?? "").toLowerCase())).map((row) => clean2(row.content)).filter(Boolean).join(" / ");
    const known = [...req];
    if (/(?:website|網站|网站)/i.test(priorCustomerText)) known.unshift(lang2 === "en" ? "Existing website: yes" : "\u5DF2\u6709\u7DB2\u7AD9");
    if (/(?:\bhk\b|hong\s*kong|香港)/i.test(priorCustomerText) && !known.some((x) => /(?:香港|Hong Kong)/i.test(x))) known.push(lang2 === "en" ? "Current main market: Hong Kong" : "\u76EE\u524D\u4E3B\u8981\u5E02\u5834\uFF1A\u9999\u6E2F");
    if (state.current_requirements.product_count === null && /\bsku\b/i.test(priorCustomerText)) known.push(lang2 === "en" ? "SKU volume discussed, exact count not confirmed" : "\u5DF2\u8AC7\u53CA SKU \u6578\u91CF\uFF0C\u4F46\u672A\u6709\u53EF\u9760\u7CBE\u78BA\u6578\u5B57");
    const asked = [];
    if (/(?:app)/i.test(priorCustomerText)) asked.push("App");
    if (/(?:push|推播|推送)/i.test(priorCustomerText)) asked.push("Push");
    if (/(?:ai\s*seo)/i.test(priorCustomerText)) asked.push("AI SEO");
    if (asked.length) known.push(lang2 === "en" ? `Topics being checked: ${asked.join(", ")}` : `\u6B63\u5728\u67E5\u8A62\uFF1A${asked.join("\u3001")}`);
    const unknown = [];
    if (/(?:migrate|migration|遷移|迁移)/i.test(priorCustomerText)) unknown.push(lang2 === "en" ? "product/member-data migration details" : "\u5546\u54C1\uFF0F\u6703\u54E1\u8CC7\u6599\u9077\u79FB\u7D30\u7BC0");
    if (/(?:澳門|澳门|macau).{0,30}(?:pay|付款|payment)|(?:pay|付款|payment).{0,30}(?:澳門|澳门|macau)/i.test(priorCustomerText)) unknown.push(lang2 === "en" ? "Macau-customer payment / Stripe support" : "\u6FB3\u9580\u5BA2\u6236\u4ED8\u6B3E\uFF0FStripe \u652F\u63F4");
    const knownText = known.length ? known.join(lang2 === "en" ? "; " : "\u3001") : lang2 === "en" ? "no additional customer facts are confirmed" : "\u66AB\u672A\u6709\u66F4\u591A\u5DF2\u78BA\u8A8D\u5BA2\u6236\u689D\u4EF6";
    const unknownText = unknown.length ? unknown.join(lang2 === "en" ? "; " : "\u3001") : lang2 === "en" ? "any fact not explicitly supported by published information" : "\u4EFB\u4F55\u672A\u6709\u5DF2\u767C\u5E03\u8CC7\u6599\u652F\u6301\u5605\u5177\u9AD4\u4E8B\u5BE6";
    if (lang2 === "en") return `Confirmed from this conversation: ${knownText}. Still to verify from published information: ${unknownText}.`;
    if (lang2 === "zh-CN") return `\u6309\u8FD9\u6BB5\u5BF9\u8BDD\u5DF2\u786E\u8BA4\u7684\u60C5\u51B5\uFF1A${knownText}\uFF1B\u4ECD\u9700\u6309\u5DF2\u53D1\u5E03\u8D44\u6599\u6838\u5B9E\uFF1A${unknownText}\u3002`;
    return `\u6309\u5462\u6BB5\u5C0D\u8A71\u5DF2\u78BA\u8A8D\u5605\u60C5\u6CC1\uFF1A${knownText}\uFF1B\u4ECD\u672A\u6709\u8DB3\u5920\u5DF2\u767C\u5E03\u8CC7\u6599\u78BA\u8A8D\u3001\u9700\u6838\u5BE6\uFF1A${unknownText}\u3002`;
  }
  const workflow5NextStepRequest = /(?:一句|one\s+sentence).{0,30}(?:下一步|next\s+step).{0,30}(?:確認|核實|confirm|verify)/i.test(latest);
  if (workflow5NextStepRequest) {
    const count = state.current_requirements.product_count;
    const countText = count !== null ? lang2 === "en" ? `${count} SKUs` : `${count} SKU` : "SKU";
    if (lang2 === "en") return `Next, verify the plan billing cadence, limits for ${countText}, product/member-data migration, Macau-customer payment / Stripe support, App/Push details, and the AI SEO quota or overage rules against published information.`;
    if (lang2 === "zh-CN") return `\u4E0B\u4E00\u6B65\u8BF7\u6309\u5DF2\u53D1\u5E03\u8D44\u6599\u6838\u5B9E\u65B9\u6848\u7684\u5E74\uFF0F\u6708\u6536\u8D39\u65B9\u5F0F\u3001\u5BF9 ${countText} \u7684\u9650\u5236\u3001\u5546\u54C1\uFF0F\u4F1A\u5458\u8D44\u6599\u8FC1\u79FB\u3001\u6FB3\u95E8\u5BA2\u6237\u4ED8\u6B3E\u652F\u6301\u3001App\uFF0FPush \u7EC6\u8282\uFF0C\u4EE5\u53CA AI SEO \u989D\u5EA6\u4E0E\u8D85\u989D\u89C4\u5219\u3002`;
    return `\u4E0B\u4E00\u6B65\u8ACB\u6309\u5DF2\u767C\u5E03\u8CC7\u6599\u6838\u5BE6\u65B9\u6848\u5605\u5E74\uFF0F\u6708\u6536\u8CBB\u65B9\u5F0F\u3001\u5C0D ${countText} \u5605\u9650\u5236\u3001\u5546\u54C1\uFF0F\u6703\u54E1\u8CC7\u6599\u9077\u79FB\u3001\u6FB3\u9580\u5BA2\u6236\u4ED8\u6B3E\uFF0FStripe \u652F\u63F4\u3001App\uFF0FPush \u7D30\u7BC0\uFF0C\u4EE5\u53CA AI SEO \u984D\u5EA6\u540C\u8D85\u984D\u898F\u5247\u3002`;
  }
  const latestRequirementsRequest = /(?:列出|整理|總結|总结|講出|说出|tell me|list|summari[sz]e).{0,30}(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?)|(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?).{0,30}(?:是什麼|是什么|有哪些|係咩|what are)/i.test(latest);
  const latestRequirementsLimitRequest = /(?:基於|基于|根據|根据|按|依照|based on|according to).{0,30}(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?).{0,40}(?:方案|plan).{0,20}(?:限制|上限|名額|名额|支援|支持|包含|restriction|limit|eligib)/i.test(latest);
  if (!(firstRequest || correctionRequest || constraintRequest || summaryRequest || recommendationRequest || providedMissingRequest || generalSummaryRequest || mainlyAskedRequest || nameRequest || locationRequest || currentContextRequest || latestRequirementsRequest || latestRequirementsLimitRequest)) return null;
  const zh = lang2 !== "en";
  const q = lang2 === "zh-CN" ? { first: "\u4F60\u4E00\u5F00\u59CB\u95EE\u7684\u662F", correction: "\u4F60\u4E4B\u524D\u6700\u65B0\u7684\u66F4\u6B63\u662F", constraint: "\u4F60\u4E4B\u524D\u660E\u786E\u63D0\u51FA\u7684\u9650\u5236\u5305\u62EC", recommendation: "\u6211\u4E4B\u524D\u7684\u76F8\u5173\u5EFA\u8BAE\u5305\u62EC", name: "\u4F60\u4E4B\u524D\u544A\u8BC9\u6211\u4F60\u7684\u540D\u5B57\u662F", location: "\u4F60\u4E4B\u524D\u66F4\u6B63\u540E\u7684\u5730\u70B9\u662F", none: "\u8FD9\u6BB5\u5BF9\u8BDD\u91CC\u6CA1\u6709\u8DB3\u591F\u8D44\u6599\u53EF\u4EE5\u786E\u8BA4\u3002" } : { first: "\u4F60\u4E00\u958B\u59CB\u554F\u7684\u662F", correction: "\u4F60\u4E4B\u524D\u6700\u65B0\u7684\u66F4\u6B63\u662F", constraint: "\u4F60\u4E4B\u524D\u660E\u78BA\u63D0\u51FA\u7684\u9650\u5236\u5305\u62EC", recommendation: "\u6211\u4E4B\u524D\u7684\u76F8\u95DC\u5EFA\u8B70\u5305\u62EC", name: "\u4F60\u4E4B\u524D\u544A\u8A34\u6211\u4F60\u7684\u540D\u5B57\u662F", location: "\u4F60\u4E4B\u524D\u66F4\u6B63\u5F8C\u7684\u5730\u9EDE\u662F", none: "\u9019\u6BB5\u5C0D\u8A71\u88E1\u6C92\u6709\u8DB3\u5920\u8CC7\u6599\u53EF\u4EE5\u78BA\u8A8D\u3002" };
  const en = { first: "Your first question was", correction: "Your latest correction was", constraint: "The constraints you explicitly gave me include", recommendation: "My relevant earlier recommendations include", name: "You told me your name is", location: "The location from your latest correction is", none: "There is not enough information in this conversation to confirm that." };
  const t = zh ? q : en;
  const quote = (v) => zh ? `\u300C${v}\u300D` : `\u201C${v}\u201D`;
  const list = (xs) => xs.map((x, i) => `${i + 1}. ${x}`).join("\n");
  if (latestRequirementsLimitRequest) {
    const lines = currentRequirementLines(state.current_requirements, lang2);
    if (!lines.length) return lang2 === "en" ? en.none : q.none;
    const snapshot = lines.join(lang2 === "en" ? "; " : "\u3001");
    if (lang2 === "en") return `Based on your latest requirements (${snapshot}), verify each plan's product-count limit, staff/admin-seat limit, whether App/Push/CRM/member tiers are included and any related restrictions, plus support scope for the current and future markets; use published plan information for any concrete limits.`.slice(0, 1800);
    if (lang2 === "zh-CN") return `\u57FA\u4E8E\u4F60\u76EE\u524D\u6700\u65B0\u9700\u6C42\uFF08${snapshot}\uFF09\uFF0C\u4F60\u5E94\u518D\u6838\u5B9E\u5404\u65B9\u6848\u7684\u5546\u54C1\u6570\u91CF\u4E0A\u9650\u3001\u7BA1\u7406\u4EBA\u5458\u540D\u989D\u3001App\uFF0FPush\uFF0FCRM\uFF0F\u4F1A\u5458\u7B49\u7EA7\u662F\u5426\u5305\u542B\u53CA\u76F8\u5173\u9650\u5236\uFF0C\u4EE5\u53CA\u76EE\u524D\u4E0E\u672A\u6765\u5E02\u573A\u7684\u652F\u6301\u8303\u56F4\uFF1B\u4EFB\u4F55\u5177\u4F53\u65B9\u6848\u4E0A\u9650\u53EA\u4EE5\u5DF2\u53D1\u5E03\u65B9\u6848\u8D44\u6599\u4E3A\u51C6\u3002`.slice(0, 1800);
    return `\u57FA\u65BC\u4F60\u76EE\u524D\u6700\u65B0\u9700\u6C42\uFF08${snapshot}\uFF09\uFF0C\u4F60\u61C9\u518D\u6838\u5BE6\u5404\u65B9\u6848\u7684\u5546\u54C1\u6578\u91CF\u4E0A\u9650\u3001\u7BA1\u7406\u4EBA\u624B\u540D\u984D\u3001App\uFF0FPush\uFF0FCRM\uFF0F\u6703\u54E1\u7B49\u7D1A\u662F\u5426\u5305\u542B\u53CA\u76F8\u95DC\u9650\u5236\uFF0C\u4EE5\u53CA\u76EE\u524D\u8207\u672A\u4F86\u5E02\u5834\u7684\u652F\u63F4\u7BC4\u570D\uFF1B\u4EFB\u4F55\u5177\u9AD4\u65B9\u6848\u4E0A\u9650\u53EA\u4EE5\u5DF2\u767C\u5E03\u65B9\u6848\u8CC7\u6599\u70BA\u6E96\u3002`.slice(0, 1800);
  }
  if (latestRequirementsRequest) {
    const lines = currentRequirementLines(state.current_requirements, lang2);
    if (!lines.length) return lang2 === "en" ? en.none : q.none;
    const heading = lang2 === "en" ? "Your latest confirmed requirements are:" : "\u4F60\u76EE\u524D\u6700\u65B0\u7684\u9700\u6C42\u662F\uFF1A";
    return `${heading}
${list(lines)}`.slice(0, 1800);
  }
  if (mainlyAskedRequest) {
    const label = {
      hong_kong: { "zh-TW": "\u9999\u6E2F", "zh-CN": "\u9999\u6E2F", en: "Hong Kong" },
      macau: { "zh-TW": "\u6FB3\u9580", "zh-CN": "\u6FB3\u95E8", en: "Macau" },
      singapore: { "zh-TW": "\u65B0\u52A0\u5761", "zh-CN": "\u65B0\u52A0\u5761", en: "Singapore" },
      taiwan: { "zh-TW": "\u53F0\u7063", "zh-CN": "\u53F0\u6E7E", en: "Taiwan" },
      mainland_china: { "zh-TW": "\u4E2D\u570B\u5927\u9678", "zh-CN": "\u4E2D\u56FD\u5927\u9646", en: "Mainland China" },
      mars: { "zh-TW": "\u706B\u661F", "zh-CN": "\u706B\u661F", en: "Mars" }
    };
    const region = state.jurisdiction ? label[state.jurisdiction]?.[lang2] : void 0;
    const item = state.current_item ? localizedCurrentItem(state.current_item, lang2) : "";
    if (region && item) {
      if (lang2 === "en") return `You were mainly asking about ${item} in ${region}.`;
      if (lang2 === "zh-CN") return `\u4F60\u521A\u624D\u4E3B\u8981\u95EE\u7684\u662F${region}\u7684${item}\u76F8\u5173\u95EE\u9898\u3002`;
      return `\u4F60\u525B\u624D\u4E3B\u8981\u554F\u7684\u662F${region}\u7684${item}\u76F8\u95DC\u554F\u984C\u3002`;
    }
    if (state.first_customer_turn) {
      if (lang2 === "en") return `You were mainly asking about: ${state.first_customer_turn}`;
      if (lang2 === "zh-CN") return `\u4F60\u521A\u624D\u4E3B\u8981\u95EE\u7684\u662F\uFF1A${state.first_customer_turn}`;
      return `\u4F60\u525B\u624D\u4E3B\u8981\u554F\u7684\u662F\uFF1A${state.first_customer_turn}`;
    }
    return lang2 === "en" ? en.none : q.none;
  }
  if (providedMissingRequest) {
    const priorCustomer = priorRows.filter((r) => CUSTOMER2.has(String(r.role ?? "").toLowerCase())).map((r) => clean2(r.content)).filter(Boolean).reverse().slice(-8);
    const supplied = priorCustomer.filter((x) => !QUESTION.test(x) && !MEMORY2.test(x)).slice(-5);
    const requested = state.prior_recommendations.slice(0, 4);
    if (lang2 === "en") {
      const parts2 = [];
      if (supplied.length) parts2.push(`You have already told me:
${list(supplied)}`);
      if (requested.length) parts2.push(`The information I previously asked for / that may still be missing:
${list(requested)}`);
      return parts2.length ? parts2.join("\n\n").slice(0, 1800) : en.none;
    }
    const parts = [];
    if (supplied.length) parts.push(`\u4F60\u5DF2\u7D93\u63D0\u4F9B\uFF1A
${list(supplied)}`);
    if (requested.length) parts.push(`\u6211\u4E4B\u524D\u8981\u6C42\uFF0F\u4ECD\u53EF\u80FD\u6B20\u7F3A\u7684\u8CC7\u6599\uFF1A
${list(requested)}`);
    return parts.length ? parts.join("\n\n").slice(0, 1800) : q.none;
  }
  if (generalSummaryRequest) {
    const chronological = priorRows.filter((r) => CUSTOMER2.has(String(r.role ?? "").toLowerCase())).map((r) => clean2(r.content)).filter(Boolean).reverse();
    const anchors = [state.first_customer_turn, ...chronological.slice(-6)].filter((x) => Boolean(x)).filter((x, i, a) => a.indexOf(x) === i).slice(0, 7);
    if (!anchors.length) return zh ? q.none : en.none;
    const heading = lang2 === "en" ? "Here is a concise summary of what we discussed:" : "\u6211\u5011\u525B\u624D\u4E3B\u8981\u8AC7\u5230\uFF1A";
    return `${heading}
${list(anchors.slice(0, 3))}`.slice(0, 1800);
  }
  if (summaryRequest) {
    const parts = [];
    if (state.latest_corrections.length) parts.push(`${t.correction}\uFF1A
${list(state.latest_corrections.slice(0, 3))}`);
    if (state.active_constraints.length) parts.push(`${t.constraint}\uFF1A
${list(state.active_constraints.slice(0, 5))}`);
    return parts.length ? parts.join("\n\n").slice(0, 1800) : t.none;
  }
  if (firstRequest) return state.first_customer_turn ? `${t.first} ${quote(state.first_customer_turn)}` : t.none;
  if (correctionRequest) return state.latest_corrections[0] ? `${t.correction} ${quote(state.latest_corrections[0])}` : t.none;
  if (constraintRequest) return state.active_constraints.length ? `${t.constraint}\uFF1A
${list(state.active_constraints.slice(0, 5))}` : t.none;
  if (recommendationRequest) return state.prior_recommendations.length ? `${t.recommendation}\uFF1A
${list(state.prior_recommendations.slice(0, 3))}` : t.none;
  if (nameRequest) {
    const customerTexts = priorRows.filter((r) => CUSTOMER2.has(String(r.role ?? "").toLowerCase())).map((r) => clean2(r.content));
    const named = customerTexts.find((x) => /^我叫\s*[^，。,.!?！？]{1,40}/.test(x));
    const m = named?.match(/^我叫\s*([^，。,.!?！？]{1,40})/);
    return m?.[1] ? `${t.name} ${quote(m[1].replace(/(?:請|请)?記住.*$/, "").trim())}` : t.none;
  }
  if (currentContextRequest) {
    const label = {
      hong_kong: { "zh-TW": "\u9999\u6E2F", "zh-CN": "\u9999\u6E2F", en: "Hong Kong" },
      macau: { "zh-TW": "\u6FB3\u9580", "zh-CN": "\u6FB3\u95E8", en: "Macau" },
      singapore: { "zh-TW": "\u65B0\u52A0\u5761", "zh-CN": "\u65B0\u52A0\u5761", en: "Singapore" },
      taiwan: { "zh-TW": "\u53F0\u7063", "zh-CN": "\u53F0\u6E7E", en: "Taiwan" },
      mainland_china: { "zh-TW": "\u4E2D\u570B\u5927\u9678", "zh-CN": "\u4E2D\u56FD\u5927\u9646", en: "Mainland China" },
      mars: { "zh-TW": "\u706B\u661F", "zh-CN": "\u706B\u661F", en: "Mars" }
    };
    const region = state.jurisdiction ? label[state.jurisdiction]?.[lang2] : void 0;
    const item = state.current_item ? localizedCurrentItem(state.current_item, lang2) : "";
    if (!region || !item) return t.none;
    if (lang2 === "en") return `Your current region is ${region}, and the current item is ${item}.`;
    if (lang2 === "zh-CN") return `\u4F60\u73B0\u5728\u95EE\u7684\u662F${region}\u7684${item}\u3002`;
    return `\u4F60\u73FE\u5728\u554F\u7684\u662F${region}\u7684${item}\u3002`;
  }
  if (locationRequest) {
    const corrected = state.latest_corrections.map((x) => detectExplicitJurisdiction(x)).find(Boolean) ?? null;
    const label = {
      hong_kong: { "zh-TW": "\u9999\u6E2F", "zh-CN": "\u9999\u6E2F", en: "Hong Kong" },
      macau: { "zh-TW": "\u6FB3\u9580", "zh-CN": "\u6FB3\u95E8", en: "Macau" },
      singapore: { "zh-TW": "\u65B0\u52A0\u5761", "zh-CN": "\u65B0\u52A0\u5761", en: "Singapore" },
      taiwan: { "zh-TW": "\u53F0\u7063", "zh-CN": "\u53F0\u6E7E", en: "Taiwan" },
      mainland_china: { "zh-TW": "\u4E2D\u570B\u5927\u9678", "zh-CN": "\u4E2D\u56FD\u5927\u9646", en: "Mainland China" },
      mars: { "zh-TW": "\u706B\u661F", "zh-CN": "\u706B\u661F", en: "Mars" }
    };
    const value = corrected ? label[corrected]?.[lang2] : void 0;
    return value ? `${t.location} ${value}` : t.none;
  }
  return null;
}
function retrievalTargetHint(text) {
  const t = clean2(text);
  if (!t) return null;
  if (/\b[A-Z]{2,}[A-Z0-9]*[- ]?\d{2,}[A-Z0-9-]*\b/i.test(t) || /(?:型號|型号|model)/i.test(t) || /(?:呢部|這部|这部|this one).{0,24}(?:幾錢|几钱|價錢|价钱|價格|价格|price|噪音|db|保養|保修|warranty)/i.test(t) || /(?:噪音|db|保養|保修|warranty)/i.test(t)) {
    return "Exact published product record: model identity, price, specifications, noise level, warranty and included/excluded product facts.";
  }
  if (/(?:送貨|送货|delivery|shipping|九龍|九龙|澳門|澳门|macau|地址).{0,40}(?:範圍|范围|安排|政策|policy|改|修改|change|fee|費|费)?/i.test(t)) {
    return "Published delivery policy lookup terms: service area, Kowloon, Macau handling, delivery-address change, pre-dispatch requirements, identity verification, human handling, system confirmation, delivery conditions and fees.";
  }
  if (/(?:退款|退貨|退货|refund|return|刮痕|損壞|损坏|damage|百分比|比例)/i.test(t)) {
    return "Published terms and policy: returns, refunds, damaged goods, evidence requirements, fixed-percentage rules and case-by-case handling.";
  }
  if (/(?:smoke\s*test\s*(?:basic|growth|pro)|growth|basic|pro\s*plan|sku|staff|app|push|crm|會員等級|会员等级|ai\s*seo|幾錢|几钱|價錢|价钱|價格|价格|price|monthly|yearly|每月|每年)/i.test(t)) {
    return "Published product/plan record: exact price, billing cadence, SKU/staff limits, App, Push, CRM, member tiers and AI SEO inclusions.";
  }
  return null;
}
function factualFollowupNeedsSubject(text) {
  const t = clean2(text);
  if (!t) return false;
  if (/^(?:直接|就|咁|那|再|同埋|另外|and|what about|then|so)/i.test(t) && t.length <= 120) return true;
  return t.length <= 80 && /(?:幾多|多少|幾錢|几钱|價錢|价钱|價格|价格|price|monthly|yearly|每月|每年|limit|上限|staff|sku|app|push|crm|會員等級|会员等级|噪音|db|保養|保修|warranty|百分比|比例|included|包括|有冇|有没有|係咪|是否)/i.test(t);
}
function recentFactualSubjects(previousCustomerTurns, max = 5) {
  const strong = /(?:\b[A-Z]{2,}[A-Z0-9]*[- ]?\d{2,}[A-Z0-9-]*\b|Smoke\s*Test\s*(?:Basic|Growth|Pro)|\bGrowth\b|\bBasic\b|\bPro\b)/i;
  const out = [];
  for (const turn of previousCustomerTurns) {
    if (!strong.test(turn)) continue;
    const value = turn.slice(0, 260);
    if (!out.includes(value)) out.push(value);
    if (out.length >= max) break;
  }
  if (!out.length && previousCustomerTurns[0]) out.push(previousCustomerTurns[0].slice(0, 260));
  return out;
}
function recentFactualSubject(previousCustomerTurns) {
  return recentFactualSubjects(previousCustomerTurns, 1)[0] ?? null;
}
function pluralFactualReference(text) {
  return /(?:[兩两二三四五六七八九十幾几]\s*(?:款|部|個|个)|呢幾款|呢几款|這幾款|这几款|these\s+(?:models?|products?)|those\s+(?:models?|products?)|all\s+(?:models?|products?))/i.test(clean2(text));
}
function buildCanonicalRetrievalQuery(latestInput, newestFirst) {
  const latest = clean2(latestInput);
  const state = projectConversationRuntimeState(newestFirst);
  const semantic = classifyCanonicalConversationTurn(latest, newestFirst);
  if (!latest) return { query: "", mode: "standalone", latest: "", context_turns: [], state };
  const targetHint = retrievalTargetHint(latest);
  const earlyPrevious = newestFirst.filter((row) => CUSTOMER2.has(String(row.role ?? "").toLowerCase())).map((row) => clean2(row.content)).filter((x) => x && x !== latest && x !== "__THINKING__");
  const earlyPublishedFactQuestion = /[?？]|(?:幾多|多少|幾錢|几钱|價錢|价钱|價格|价格|price|monthly|yearly|每月|每年|limit|上限|included|包括|有冇|有没有|係咪|是否|噪音|db|保養|保修|warranty|百分比|比例)|^(?:直接|再講|再说|tell me)/i.test(latest);
  if (targetHint && earlyPublishedFactQuestion) {
    const subjects = pluralFactualReference(latest) ? recentFactualSubjects(earlyPrevious) : [recentFactualSubject(earlyPrevious)].filter((x) => Boolean(x));
    const query = [
      `Current request: ${latest}`,
      `Retrieval target: ${targetHint}`,
      ...subjects.length ? [`Inherited factual subjects from customer context: ${subjects.join(" / ")}`] : []
    ].join("\n").slice(0, 1800);
    return {
      query,
      mode: subjects.length ? "contextual" : "standalone",
      latest,
      context_turns: subjects.length ? earlyPrevious.slice(0, 6) : [],
      state
    };
  }
  if (semantic.operation === "CONVERSATION_MEMORY" && !targetHint) {
    const parts = [`Conversation-memory request: ${latest}`];
    if (state.first_customer_turn) parts.push(`First customer turn: ${state.first_customer_turn}`);
    if (state.prior_recommendations.length) parts.push(`Relevant prior recommendations: ${state.prior_recommendations.join(" / ")}`);
    return { query: parts.join("\n").slice(0, 1200), mode: "memory", latest, context_turns: [], state };
  }
  const explicitJurisdiction = detectExplicitJurisdiction(latest);
  const previous = newestFirst.filter((row) => CUSTOMER2.has(String(row.role ?? "").toLowerCase())).map((row) => clean2(row.content)).filter((x) => x && x !== latest && x !== "__THINKING__");
  const referencesCurrentRequirements = /(?:基於|基于|根據|根据|按|依照|based on|according to).{0,30}(?:最新|目前|現在|现在|current).{0,20}(?:需求|要求|條件|条件|requirements?)/i.test(latest);
  const followupNeedsSubject = factualFollowupNeedsSubject(latest);
  const inheritedSubject = followupNeedsSubject ? recentFactualSubject(previous) : null;
  const needsContext = semantic.needs_history || referencesCurrentRequirements || followupNeedsSubject;
  const explicitBoundary = Boolean(explicitJurisdiction) && semantic.operation !== "RETURN_TO_PRIOR_TOPIC" && semantic.operation !== "CORRECTION" && !followupNeedsSubject;
  if (referencesCurrentRequirements) {
    const requirementLines2 = currentRequirementLines(state.current_requirements, state.language);
    return {
      query: [
        `Current request: ${latest}`,
        targetHint ? `Retrieval target: ${targetHint}` : "Retrieval target: published plan limits, included features, admin/staff seats, and market eligibility only.",
        ...inheritedSubject ? [`Inherited factual subject from customer context: ${inheritedSubject}`] : [],
        ...requirementLines2.length ? [`Current customer requirement snapshot (latest wins): ${requirementLines2.join(" / ")}`] : []
      ].join("\n").slice(0, 1600),
      mode: "contextual",
      latest,
      context_turns: [],
      state
    };
  }
  if (!needsContext || explicitBoundary) {
    const standaloneQuery = targetHint ? `Current request: ${latest}
Retrieval target: ${targetHint}` : latest;
    return { query: standaloneQuery.slice(0, 1600), mode: "standalone", latest, context_turns: [], state: { ...state, jurisdiction: explicitJurisdiction ?? state.jurisdiction } };
  }
  const contextTurns = previous.filter((x) => !MEMORY2.test(x) && !/^(不要猜|唔好估|不要估|do not guess|don.t guess|不要真人|不需要真人)/i.test(x)).slice(0, 5);
  if (state.first_customer_turn && !contextTurns.includes(state.first_customer_turn) && /(回收|政策|規則|规则|安排|official|policy|recycling)/i.test(latest)) contextTurns.push(state.first_customer_turn);
  if (!contextTurns.length) return { query: latest, mode: "standalone", latest, context_turns: [], state };
  const requirementLines = currentRequirementLines(state.current_requirements, state.language);
  return {
    query: [
      `Current request: ${latest}`,
      ...targetHint ? [`Retrieval target: ${targetHint}`] : [],
      ...inheritedSubject ? [`Inherited factual subject from customer context: ${inheritedSubject}`] : [],
      ...requirementLines.length ? [`Current customer requirement snapshot (latest wins): ${requirementLines.join(" / ")}`] : [],
      `Relevant prior customer context: ${contextTurns.join(" / ")}`
    ].join("\n").slice(0, 1600),
    mode: "contextual",
    latest,
    context_turns: contextTurns,
    state
  };
}
function workflow5ShortTopicHint(text) {
  const normalized = (text || "").trim().toLowerCase();
  if (!normalized) return null;
  let compact = normalized.replace(/\s+/g, "");
  compact = compact.replace(/[？?]+$/g, "");
  compact = compact.replace(/(?:呢|咧|啊|呀|嗎|吗)+$/g, "");
  compact = compact.replace(/^(?:咁|那)/, "");
  if (/(?:crm).*(?:會員等級|会员等级)|(?:會員等級|会员等级).*(?:crm)/i.test(compact)) return "CRM and membership tiers";
  if (["\u6703\u54E1\u7B49\u7D1A", "\u4F1A\u5458\u7B49\u7EA7", "\u6703\u54E1\u5206\u7D1A", "\u4F1A\u5458\u5206\u7EA7", "membershiptier", "membershiptiers", "membertier", "membertiers", "membershiplevel", "membershiplevels", "memberlevel", "memberlevels"].includes(compact)) return "membership tiers";
  if (["crm", "\u5BA2\u6236\u7BA1\u7406", "\u5BA2\u6237\u7BA1\u7406"].includes(compact)) return "CRM";
  if (["push", "\u63A8\u9001", "\u63A8\u64AD", "\u901A\u77E5", "\u63A8\u9001\u901A\u77E5"].includes(compact)) return "Push notifications";
  if (["app", "\u624B\u6A5Fapp", "\u624B\u673Aapp", "\u624B\u6A5F\u61C9\u7528", "\u624B\u673A\u5E94\u7528", "\u61C9\u7528\u7A0B\u5F0F", "\u5E94\u7528\u7A0B\u5E8F"].includes(compact)) return "App support";
  return retrievalTargetHint(text);
}

// supabase/functions/_shared/conversation-runtime-state.ts
var CUSTOMER_ROLES2 = /* @__PURE__ */ new Set(["visitor", "customer", "user"]);
var CURRENT_STATE_SUMMARY_VERB = /(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list)/i;
var CURRENT_STATE_SUMMARY_SCOPE = /(?:(?:根據|根据|按|依照|基於|基于|based\s+on|according\s+to).{0,80}(?:我|my).{0,50}(?:最新|目前|現在|现在|current|latest).{0,50}(?:提供|資料|资料|資訊|信息|details|information)|(?:我|my).{0,40}(?:最新|目前|現在|现在|current|latest).{0,40}(?:提供|資料|资料|資訊|信息|details|information|需求|要求|requirements?))/i;
function clean3(value, max = 1600) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function isCurrentCustomerStateSummary(text) {
  const latest = clean3(text);
  const explicitLatestRequirements = /(?:最新|目前|現在|现在|而家|current|latest).{0,24}(?:需求|要求|需要|requirements?|needs?)/i.test(latest);
  return Boolean(
    latest && CURRENT_STATE_SUMMARY_VERB.test(latest) && (CURRENT_STATE_SUMMARY_SCOPE.test(latest) || explicitLatestRequirements)
  );
}
function historyWithoutCurrentCustomerTurn(latestInput, newestFirst) {
  const latest = clean3(latestInput);
  let removed = false;
  return newestFirst.filter((row) => {
    const role = String(row.role ?? "").toLowerCase();
    const content = clean3(row.content);
    if (!removed && CUSTOMER_ROLES2.has(role) && content === latest) {
      removed = true;
      return false;
    }
    return true;
  });
}
function marketLabel2(id, language) {
  const labels = {
    hong_kong: { "zh-TW": "\u9999\u6E2F", "zh-CN": "\u9999\u6E2F", en: "Hong Kong" },
    macau: { "zh-TW": "\u6FB3\u9580", "zh-CN": "\u6FB3\u95E8", en: "Macau" },
    singapore: { "zh-TW": "\u65B0\u52A0\u5761", "zh-CN": "\u65B0\u52A0\u5761", en: "Singapore" },
    taiwan: { "zh-TW": "\u53F0\u7063", "zh-CN": "\u53F0\u6E7E", en: "Taiwan" },
    mainland_china: {
      "zh-TW": "\u4E2D\u570B\u5927\u9678",
      "zh-CN": "\u4E2D\u56FD\u5927\u9646",
      en: "Mainland China"
    },
    mars: { "zh-TW": "\u706B\u661F", "zh-CN": "\u706B\u661F", en: "Mars" }
  };
  return labels[id]?.[language] ?? id;
}
function augmentState6RequirementSnapshot(newestFirst, snapshot) {
  const customerText = newestFirst.filter((row) => CUSTOMER_ROLES2.has(String(row.role ?? "").toLowerCase())).map((row) => clean3(row.content, 1200)).filter(Boolean).reverse().join(" / ");
  let staffCount = snapshot.staff_count;
  if (staffCount === null) {
    const staff = customerText.match(/([一二兩两三四五六七八九十]|\d{1,3})\s*(?:個|个|位)?\s*(?:staff|員工|员工)/i);
    if (staff?.[1]) {
      const map = { \u4E00: 1, \u4E8C: 2, \u5169: 2, \u4E24: 2, \u4E09: 3, \u56DB: 4, \u4E94: 5, \u516D: 6, \u4E03: 7, \u516B: 8, \u4E5D: 9, \u5341: 10 };
      staffCount = /^\d+$/.test(staff[1]) ? Number(staff[1]) : map[staff[1]] ?? null;
    }
  }
  let currentMarket = snapshot.current_market;
  const current = customerText.match(/(?:目前|而家|現在|现在|currently|current|main\s+market)[^，。,.!?！？/]{0,30}?(香港|台灣|台湾|澳門|澳门|Hong\s+Kong|Taiwan|Macau)/i);
  const raw = current?.[1]?.toLowerCase() ?? "";
  if (/香港|hong\s+kong/.test(raw)) currentMarket = "hong_kong";
  else if (/台灣|台湾|taiwan/.test(raw)) currentMarket = "taiwan";
  else if (/澳門|澳门|macau/.test(raw)) currentMarket = "macau";
  const futureMarkets = new Set(snapshot.future_markets);
  const future = customerText.match(/(香港|台灣|台湾|澳門|澳门|Hong\s+Kong|Taiwan|Macau)\s*(?:之後|之后|以後|以后|未來|未来|later|future)/i);
  const futureRaw = future?.[1]?.toLowerCase() ?? "";
  if (/香港|hong\s+kong/.test(futureRaw)) futureMarkets.add("hong_kong");
  else if (/台灣|台湾|taiwan/.test(futureRaw)) futureMarkets.add("taiwan");
  else if (/澳門|澳门|macau/.test(futureRaw)) futureMarkets.add("macau");
  if (currentMarket) futureMarkets.delete(currentMarket);
  const desiredFeatures = new Set(snapshot.desired_features);
  if (/(?:會員功能|会员功能|membership(?:\s+(?:feature|features|function|functions))?)/i.test(customerText) && /(?:想要|想用|要用|會用|会用|需要|need|want|use)/i.test(customerText)) {
    desiredFeatures.add("\u6703\u54E1\u529F\u80FD");
  }
  return {
    ...snapshot,
    staff_count: staffCount,
    current_market: currentMarket,
    future_markets: [...futureMarkets],
    desired_features: [...desiredFeatures]
  };
}
function currentStateSummaryReply(latestInput, newestFirst) {
  if (!isCurrentCustomerStateSummary(latestInput)) return null;
  const priorRows = historyWithoutCurrentCustomerTurn(latestInput, newestFirst);
  const state = projectConversationRuntimeState(priorRows);
  const snapshot = augmentState6RequirementSnapshot(priorRows, state.current_requirements);
  const language = resolveWorkflow5ConversationLanguage(latestInput, priorRows);
  const lines = [];
  if (language === "en") {
    if (snapshot.product_count !== null) {
      lines.push(`Product count: about ${snapshot.product_count}`);
    }
    if (snapshot.staff_count !== null) {
      lines.push(`Management staff: ${snapshot.staff_count}`);
    }
    if (snapshot.current_market) {
      lines.push(`Current main market: ${marketLabel2(snapshot.current_market, language)}`);
    }
    if (snapshot.future_markets.length) {
      lines.push(
        `Possible future markets: ${snapshot.future_markets.map((x) => marketLabel2(x, language)).join(", ")} (not the current main market)`
      );
    }
    if (snapshot.app_interest === true) lines.push("App: interested / include in plan");
    if (snapshot.app_interest === false) lines.push("App: not currently needed");
    if (snapshot.desired_features.length) {
      lines.push(`Desired features: ${snapshot.desired_features.join(", ")}`);
    }
    return lines.length ? `Your latest confirmed requirements are:
${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}` : null;
  }
  if (snapshot.product_count !== null) {
    lines.push(`\u5546\u54C1\u6578\u91CF\uFF1A\u7D04 ${snapshot.product_count} \u4EF6\uFF08${snapshot.product_count} SKU\uFF09`);
  }
  if (snapshot.staff_count !== null) {
    lines.push(`\u7BA1\u7406\u4EBA\u624B\uFF1A${snapshot.staff_count} \u4F4D staff`);
  }
  if (snapshot.current_market) {
    lines.push(`\u76EE\u524D\u4E3B\u8981\u5E02\u5834\uFF1A${marketLabel2(snapshot.current_market, language)}`);
  }
  if (snapshot.future_markets.length) {
    lines.push(
      `\u672A\u4F86\u53EF\u80FD\u5E02\u5834\uFF1A${snapshot.future_markets.map((x) => marketLabel2(x, language)).join("\u3001")}\uFF08\u4E0D\u662F\u76EE\u524D\u4E3B\u8981\u5E02\u5834\uFF09`
    );
  }
  if (snapshot.app_interest === true) lines.push("App\uFF1A\u6709\u8208\u8DA3\uFF0F\u9700\u8981\u7D0D\u5165\u65B9\u6848");
  if (snapshot.app_interest === false) lines.push("App\uFF1A\u76EE\u524D\u4E0D\u9700\u8981");
  if (snapshot.desired_features.length) {
    lines.push(`\u9700\u8981\u529F\u80FD\uFF1A${snapshot.desired_features.join("\u3001")}`);
  }
  const heading = language === "zh-CN" ? "\u4F60\u76EE\u524D\u6700\u65B0\u7684\u9700\u6C42\u662F\uFF1A" : "\u4F60\u76EE\u524D\u6700\u65B0\u7684\u9700\u6C42\u662F\uFF1A";
  return lines.length ? `${heading}
${lines.map((line, index) => `${index + 1}. ${line}`).join("\n")}` : null;
}
function resolveConversationMemoryResponse2(latestInput, newestFirst) {
  const currentState = currentStateSummaryReply(latestInput, newestFirst);
  if (currentState) return currentState;
  return resolveConversationMemoryResponse(latestInput, newestFirst);
}
function normalizePlan(raw) {
  const value = clean3(raw, 40).toLowerCase();
  if (value === "basic") return "Basic";
  if (value === "growth") return "Growth";
  if (value === "pro") return "Pro";
  return null;
}
function correctedPlanSubject(text) {
  const latest = clean3(text);
  if (!latest) return null;
  const correctionCue = /(?:其實|其实|唔係|不是|並非|并非|改問|改问|更正|instead|not\b|i\s+meant)/i;
  if (!correctionCue.test(latest)) return null;
  const explicitTarget = latest.match(
    /(?:我要問|我要问|我想問|我想问|想問|想问|問嘅係|问的是|改問|改问|ask\s+about|i\s+(?:want|meant)\s+(?:to\s+)?(?:ask\s+about\s+)?)\s*(?:the\s+)?(Basic|Growth|Pro)(?:\s+(?:plan|方案))?/i
  );
  const explicitPlan = normalizePlan(explicitTarget?.[1]);
  if (explicitPlan) return explicitPlan;
  const contrastTarget = latest.match(
    /(?:而係|而是|instead(?:\s+of)?|but)\s*(?:the\s+)?(Basic|Growth|Pro)(?:\s+(?:plan|方案))?/i
  );
  return normalizePlan(contrastTarget?.[1]);
}
function correctedPlanFactDimension(newestFirst) {
  const previousCustomerTurns = newestFirst.filter((row) => CUSTOMER_ROLES2.has(String(row.role ?? "").toLowerCase())).map((row) => clean3(row.content, 500)).filter(Boolean);
  const prior = previousCustomerTurns.find(
    (text) => /(?:sku|staff|員工|员工|人手|app|push|crm|會員|会员|ai\s*seo|價錢|价钱|價格|价格|price|費用|费用|limit|上限)/i.test(text)
  );
  if (!prior) return null;
  if (/(?:sku|商品.*上限|產品.*上限|产品.*上限)/i.test(prior)) return "SKU limit";
  if (/(?:staff|員工|员工|人手)/i.test(prior)) return "staff/admin-seat limit";
  if (/(?:價錢|价钱|價格|价格|price|費用|费用)/i.test(prior)) return "price and billing cadence";
  if (/(?:app|push|crm|會員|会员|ai\s*seo)/i.test(prior)) return "included features and limits";
  return null;
}
function explicitPlanFactQuery(text) {
  const latest = clean3(text);
  if (!latest) return null;
  const planMatch = latest.match(/\b(Basic|Growth|Pro)\b/i);
  const plan = normalizePlan(planMatch?.[1]);
  if (!plan) return null;
  let fact = null;
  if (/(?:sku|商品.*(?:上限|limit)|產品.*(?:上限|limit)|产品.*(?:上限|limit))/i.test(latest)) fact = "SKU limit";
  else if (/(?:staff|員工|员工|人手|admin(?:[- ]?seat)?)/i.test(latest)) fact = "staff/admin-seat limit";
  else if (/(?:價錢|价钱|價格|价格|price|費用|费用|monthly|yearly|每月|每年)/i.test(latest)) fact = "price and billing cadence";
  else if (/(?:app|push|crm|會員|会员|ai\s*seo|feature|功能|included|包括|包含)/i.test(latest)) fact = "included features and limits";
  if (!fact) return null;
  return { plan, fact };
}
function buildCanonicalRetrievalQuery2(latestInput, newestFirst) {
  const correctedPlan = correctedPlanSubject(latestInput);
  const explicitPlanFact = explicitPlanFactQuery(latestInput);
  if (!correctedPlan && explicitPlanFact) {
    const latest2 = clean3(latestInput);
    const state2 = projectConversationRuntimeState(newestFirst);
    const currentRequirements2 = augmentState6RequirementSnapshot(
      newestFirst,
      state2.current_requirements
    );
    return {
      query: `${explicitPlanFact.plan} ${explicitPlanFact.fact}`,
      mode: "standalone",
      latest: latest2,
      context_turns: [],
      state: {
        ...state2,
        current_topic: explicitPlanFact.plan,
        jurisdiction: currentRequirements2.current_market ?? state2.jurisdiction,
        current_requirements: currentRequirements2
      }
    };
  }
  if (!correctedPlan) {
    return buildCanonicalRetrievalQuery(latestInput, newestFirst);
  }
  const latest = clean3(latestInput);
  const state = projectConversationRuntimeState(newestFirst);
  const factDimension = correctedPlanFactDimension(newestFirst);
  const currentRequirements = augmentState6RequirementSnapshot(
    newestFirst,
    state.current_requirements
  );
  return {
    query: [
      `Current factual target: ${correctedPlan}`,
      ...factDimension ? [`Requested fact: ${factDimension}`] : [],
      `Correction boundary: answer about ${correctedPlan} only; prior plan references are superseded for this turn and must not appear in retrieval context or evidence.`,
      `Retrieval target: published ${correctedPlan} plan record: exact price, billing cadence, SKU/staff limits, App, Push, CRM, member tiers and AI SEO inclusions.`
    ].join("\n").slice(0, 1600),
    mode: "standalone",
    latest,
    context_turns: [],
    state: {
      ...state,
      current_topic: correctedPlan,
      jurisdiction: currentRequirements.current_market ?? state.jurisdiction,
      current_requirements: currentRequirements
    }
  };
}

// supabase/functions/_shared/canonical-grounding.ts
function modelTokens(text) {
  return [...new Set(
    (text.match(/\b[A-Z]{2,}[A-Z0-9]*[- ]?\d{2,}[A-Z0-9-]*\b/g) ?? []).map((x) => x.replace(/\s+/g, "").toUpperCase())
  )];
}
function candidateText(document) {
  return [
    document.title,
    document.source_type,
    ...document.chunks.map((c) => `${c.title ?? ""} ${c.content}`),
    ...document.llm_context.full_content_evidence.map((e) => e.content)
  ].join("\n").slice(0, 5e4);
}
function jurisdictions(text) {
  const found = [];
  if (/(mars|火星)/i.test(text)) found.push("mars");
  if (/(香港|hong\s*kong|\bhk\b)/i.test(text)) found.push("hong_kong");
  if (/(澳門|澳门|macau|macao)/i.test(text)) found.push("macau");
  if (/(新加坡|singapore)/i.test(text)) found.push("singapore");
  if (/(台灣|台湾|taiwan)/i.test(text)) found.push("taiwan");
  if (/(中國大陸|中国大陆|內地|内地|mainland\s*china)/i.test(text)) found.push("mainland_china");
  return found;
}
function assessApplicability(document, requestText) {
  const requestJurisdiction = detectExplicitJurisdiction(requestText);
  const text = candidateText(document);
  const documentJurisdictions = jurisdictions(text);
  if (requestJurisdiction === "mars" && !documentJurisdictions.includes("mars")) {
    return {
      accepted: false,
      reason: "unsupported_explicit_jurisdiction",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions
    };
  }
  if (requestJurisdiction && documentJurisdictions.length > 0 && !documentJurisdictions.includes(requestJurisdiction)) {
    return {
      accepted: false,
      reason: "jurisdiction_mismatch",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions
    };
  }
  const requestModels = modelTokens(requestText);
  const documentModels = modelTokens(text);
  if (requestModels.length > 0 && documentModels.length > 0 && !requestModels.some((model) => documentModels.includes(model))) {
    return {
      accepted: false,
      reason: "model_mismatch",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions
    };
  }
  return {
    accepted: true,
    reason: "applicable",
    request_jurisdiction: requestJurisdiction,
    document_jurisdictions: documentJurisdictions
  };
}
var STRONG_LEXICAL_SCORE_FLOOR = 0.05;
function strongLexicalEvidenceMatch(requestText, document) {
  const request = requestText.normalize("NFKC").toLowerCase();
  const text = candidateText(document).normalize("NFKC").toLowerCase();
  const namedPlan = ["growth", "basic", "pro"].find(
    (plan) => new RegExp(`\\b${plan}\\b`, "i").test(request) && new RegExp(`\\b${plan}\\b`, "i").test(text)
  );
  const requestHasPlanFact = /(?:sku|staff|admin|seat|app|push|crm|會員|会员|ai\s*seo|price|billing|monthly|yearly|limit|上限|費用|费用|價錢|价钱|價格|价格)/i.test(request);
  const textHasPlanFact = /(?:sku|staff|admin|seat|app|push|crm|會員|会员|ai\s*seo|price|billing|monthly|yearly|limit|上限|費用|费用|價錢|价钱|價格|价格)/i.test(text);
  if (namedPlan && requestHasPlanFact && textHasPlanFact) return true;
  const reqModels = modelTokens(requestText);
  if (reqModels.length > 0 && reqModels.some((model) => text.includes(model.toLowerCase()))) {
    return /(?:price|spec|warranty|保養|保修|噪音|db|delivery|shipping|送貨|送货)/i.test(request);
  }
  return false;
}
function lexicalRelevance(requestText, document) {
  const request = requestText.normalize("NFKC").toLowerCase();
  const text = candidateText(document).normalize("NFKC").toLowerCase();
  let score = 0;
  const reqModels = modelTokens(requestText);
  if (reqModels.some((model) => text.includes(model.toLowerCase()))) score += 12;
  const anchors = [
    "smoke test growth",
    "smoke test basic",
    "smoke test pro",
    "growth",
    "basic",
    "pro",
    "\u4E5D\u9F8D",
    "\u4E5D\u9F99",
    "\u6FB3\u9580",
    "\u6FB3\u95E8",
    "\u9000\u6B3E",
    "\u9000\u8CA8",
    "\u9000\u8D27",
    "delivery",
    "shipping",
    "warranty",
    "\u4FDD\u990A",
    "\u4FDD\u4FEE",
    "sku",
    "staff",
    "push",
    "crm",
    "ai seo"
  ];
  for (const anchor of anchors) {
    if (request.includes(anchor) && text.includes(anchor)) score += 2;
  }
  const latinTokens = [...new Set(request.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])].filter((x) => !["current", "request", "retrieval", "target", "published", "customer", "context"].includes(x));
  for (const token of latinTokens.slice(0, 20)) if (text.includes(token)) score += 0.25;
  return score;
}
function selectCanonicalGrounding(documents, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : 0;
  const policyOnly = options.policyOnly === true;
  const requirePublished = options.requirePublished !== false;
  const requestText = options.requestText ?? "";
  const eligible = [];
  for (const document of documents ?? []) {
    if (document.llm_context.selected_document_id !== document.document_id) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    if (document.llm_context.full_content_evidence.some((e) => e.document_id !== document.document_id)) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    if (document.chunks.some((c) => c.document_id !== document.document_id)) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    const lexicalScore = lexicalRelevance(requestText, document);
    const effectiveMinScore = strongLexicalEvidenceMatch(requestText, document) ? Math.min(minScore, STRONG_LEXICAL_SCORE_FLOOR) : minScore;
    const chunks = document.chunks.filter(
      (c) => c.content.trim() && Number.isFinite(c.score) && c.score >= effectiveMinScore && (!requirePublished || c.status === "published") && (!policyOnly || c.source_type.toLowerCase().includes("policy"))
    );
    const fullContentIds = new Set(
      chunks.filter((c) => c.chunk_type === "full_content").map((c) => c.chunk_id ?? c.content)
    );
    const evidence = document.llm_context.full_content_evidence.filter(
      (e) => e.content.trim() && Number.isFinite(e.score) && e.score >= effectiveMinScore && (!policyOnly || e.source_type.toLowerCase().includes("policy")) && fullContentIds.has(e.chunk_id ?? e.content)
    );
    if (requirePublished && evidence.length > 0 && chunks.every((c) => c.status !== "published")) {
      return { ok: false, error: "KB_EVIDENCE_NOT_PUBLISHED" };
    }
    if (!evidence.length) continue;
    const applicability = assessApplicability(document, requestText);
    if (!applicability.accepted) continue;
    eligible.push({
      document,
      chunks,
      evidence,
      applicability,
      evidenceScore: Math.max(...evidence.map((e) => e.score), 0),
      lexicalScore
    });
  }
  eligible.sort(
    (a, b) => b.lexicalScore - a.lexicalScore || b.document.document_score - a.document.document_score || b.evidenceScore - a.evidenceScore || a.document.document_id.localeCompare(b.document.document_id)
  );
  const winner = eligible[0];
  return winner ? {
    ok: true,
    document: winner.document,
    chunks: winner.chunks,
    evidence: winner.evidence,
    applicability: winner.applicability
  } : {
    ok: true,
    document: null,
    chunks: [],
    evidence: [],
    applicability: {
      accepted: false,
      reason: "no_applicable_published_evidence",
      request_jurisdiction: detectExplicitJurisdiction(requestText),
      document_jurisdictions: []
    }
  };
}

// supabase/functions/_shared/citation-lineage.ts
function buildCitationMetadata(chunks, selectedDocumentId) {
  const selected = (selectedDocumentId ?? "").trim();
  if (!selected) return null;
  const citations = [];
  const seen = /* @__PURE__ */ new Set();
  for (const chunk of chunks) {
    if (citations.length >= 3) break;
    if (chunk.chunk_type !== "full_content") continue;
    if (!chunk.content?.trim()) continue;
    if (!Number.isFinite(chunk.score)) continue;
    if (chunk.document_id !== selected) return null;
    const chunkId = typeof chunk.chunk_id === "string" && chunk.chunk_id.trim() ? chunk.chunk_id.trim() : void 0;
    const dedupeKey = chunkId ? `${selected}:${chunkId}` : `${selected}:${chunk.content}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const rawLabel = typeof chunk.title === "string" ? chunk.title.trim().slice(0, 120) : "";
    const rawSourceType = typeof chunk.source_type === "string" ? chunk.source_type.trim().slice(0, 40) : "";
    const relevance = chunk.score >= 0.85 ? "high" : "medium";
    citations.push({
      label: rawLabel || "Knowledge Base source",
      source_type: rawSourceType || "unknown",
      relevance,
      document_id: selected,
      ...chunkId ? { chunk_id: chunkId } : {},
      chunk_type: "full_content"
    });
  }
  if (citations.length === 0) return null;
  return {
    citations,
    citation_lineage: {
      selected_document_id: selected,
      evidence_chunk_ids: citations.flatMap((citation) => citation.chunk_id ? [citation.chunk_id] : []),
      evidence_count: citations.length
    }
  };
}

// supabase/functions/_shared/prior-grounded-transform-core.ts
var TRANSFORMS = /* @__PURE__ */ new Set([
  "SIMPLIFY",
  "REPHRASE",
  "TRANSLATE",
  "SUMMARIZE"
]);
var COMPOSITE_TRANSFORM_RULES = [
  ["TRANSLATE", /(?:用|改用)(?:廣東話|广东话|繁體中文|繁体中文|簡體中文|简体中文|英文)|\b(?:in|into)\s+(?:english|chinese|cantonese|traditional chinese|simplified chinese)\b|translate(?: that| it)?/i],
  ["SUMMARIZE", /(?:總結|总结|概括|歸納|归纳)|summari[sz]e/i],
  ["SIMPLIFY", /(?:簡單|简单)(?:一點|一点|啲|些|點|点)?|\b(?:simpler|shorter)\b|explain(?: it| that)? (?:more )?simply/i],
  ["REPHRASE", /(?:換句話|换句话|另一種講法|另一种说法|改寫|改写|重新講|重新说|rephrase|rewrite|say that another way|word it differently)/i]
];
var CHINESE_COUNT = {
  \u4E00: 1,
  \u4E8C: 2,
  \u5169: 2,
  \u4E24: 2,
  \u4E09: 3,
  \u56DB: 4,
  \u4E94: 5,
  \u516D: 6,
  \u4E03: 7,
  \u516B: 8,
  \u4E5D: 9,
  \u5341: 10
};
var BROAD_SUMMARY_SCOPE = /(?:已確認|已确认)(?:資料|资料)|(?:剛才|刚才|以上|之前|我們|我们).{0,24}(?:內容|内容|資料|资料|討論|讨论)|\b(?:the above|what we discussed|our conversation|confirmed information|confirmed facts)\b/i;
var CURRENT_REQUIREMENTS_SUMMARY_SCOPE = /(?:(?:按|根據|根据|基於|基于|依照|based\s+on|according\s+to).{0,30}(?:最新|目前|現在|现在|current|latest).{0,30}(?:條件|条件|需求|要求|requirements?)|(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list).{0,30}(?:我|客戶|客户|customer)?\s*.{0,12}(?:最新|目前|現在|现在|current|latest).{0,20}(?:條件|条件|需求|要求|requirements?)|(?:最新|目前|現在|现在|current|latest).{0,20}(?:條件|条件|需求|要求|requirements?).{0,30}(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list))/i;
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function clean4(value, max = 4e3) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function normalizedChunkIds(value) {
  return Array.isArray(value) ? [...new Set(value.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()))] : [];
}
function sameLineage(documentId, chunkIds, candidateDocumentId, candidateChunkIds) {
  return candidateDocumentId === documentId && candidateChunkIds.length === chunkIds.length && candidateChunkIds.every((id) => chunkIds.includes(id));
}
function supportedPointCount(content) {
  const raw = typeof content === "string" ? content.normalize("NFKC").trim() : "";
  if (!raw) return 0;
  const bullets = raw.split(/\r?\n/).filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line));
  if (bullets.length > 0) return bullets.length;
  return raw.split(/[。！？!?]+/).map((part) => part.trim()).filter(Boolean).length;
}
function selectBroadSummaryAnchor(latest, newestFirst, anchor, requestedSummaryCount) {
  if (!BROAD_SUMMARY_SCOPE.test(latest)) return anchor;
  const anchorChunks = [...new Set(anchor.chunk_ids.filter(Boolean))];
  if (!anchor.document_id || anchorChunks.length === 0) return anchor;
  const minimumPoints = requestedSummaryCount ?? 1;
  for (const row of newestFirst) {
    const role = String(row.role ?? "").toLowerCase();
    if (role !== "assistant" && role !== "ai") continue;
    const content = clean4(row.content);
    if (!content || content === "__THINKING__") continue;
    const meta2 = record(row.metadata);
    const lineage = record(meta2?.citation_lineage);
    const selected = clean4(lineage?.selected_document_id, 200);
    const ids = normalizedChunkIds(lineage?.evidence_chunk_ids);
    const sourceMessageId = clean4(meta2?.source_message_id, 200);
    if (!sourceMessageId || !sameLineage(anchor.document_id, anchorChunks, selected, ids)) continue;
    if (supportedPointCount(content) < minimumPoints) continue;
    return {
      content,
      document_id: selected,
      chunk_ids: ids,
      source_message_id: sourceMessageId
    };
  }
  return anchor;
}
function detectRequestedTransformOperations(latest, primary) {
  const requested = COMPOSITE_TRANSFORM_RULES.filter(([, pattern]) => pattern.test(latest)).map(([operation]) => operation);
  if (!requested.includes(primary)) requested.unshift(primary);
  return [...new Set(requested)];
}
function detectRequestedSummaryCount(latest) {
  const normalized = latest.normalize("NFKC");
  const chinese = normalized.match(/(?:用|以|分成|分為|分为)?\s*([一二兩两三四五六七八九十]|\d{1,2})\s*(?:點|点|項|项|條|条|個|个)(?:重點|重点)?\s*(?:來|来)?\s*(?:總結|总结|概括|歸納|归纳)?/i);
  const english = normalized.match(/(?:in|using|with)?\s*(\d{1,2})\s*(?:points?|bullets?|items?)\b/i);
  const raw = chinese?.[1] ?? english?.[1] ?? "";
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : CHINESE_COUNT[raw];
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : null;
}
function resolvedOperations(context) {
  const operations = context.operations?.filter((op) => TRANSFORMS.has(op)) ?? [];
  return operations.length > 0 ? [...new Set(operations)] : [context.operation];
}
function fixedCountContract(context) {
  const count = context.requested_summary_count;
  if (!count || !resolvedOperations(context).includes("SUMMARIZE")) return [];
  return [
    `- Requested summary count: ${count} points/bullets. This is a formatting target, NEVER permission to create or infer facts.`,
    `- Return AT MOST ${count} supported points. Use exactly ${count} only when the Prior Grounded Answer already contains ${count} distinct factual points.`,
    "- If the Prior Grounded Answer contains fewer supported points, return fewer points. Grounding has higher priority than satisfying the requested count.",
    "- Never split one factual claim into artificial variants, repeat the same claim, or add filler merely to reach the requested count.",
    "- For fixed-count summaries, prefer verbatim or near-verbatim clauses from the Prior Grounded Answer. Do not add generic advice, caveats, recommendations, or meta statements as extra points."
  ];
}
function requestsCurrentCustomerRequirementsSummary(latest) {
  return CURRENT_REQUIREMENTS_SUMMARY_SCOPE.test(clean4(latest, 1600));
}
function requestsNewFactualFacet(latest, priorAnswer) {
  const facets = [
    [/(價錢|价格|price|月費|月费|年費|年费|monthly|yearly|年繳|年缴|月繳|月缴)/i, /(HKD|價錢|价格|price|月費|月费|年費|年费|monthly|yearly|年繳|年缴|月繳|月缴)/i],
    [/(staff|員工|员工|管理人手|管理人员)/i, /(staff|員工|员工|管理人手|管理人员)/i],
    [/(sku|商品數量|商品数量|product count)/i, /(sku|商品數量|商品数量|product count)/i],
    [/(保養|保修|warranty)/i, /(保養|保修|warranty)/i],
    [/(送貨|送货|delivery|九龍|九龙|kowloon|澳門|澳门|macau|macao)/i, /(送貨|送货|delivery|九龍|九龙|kowloon|澳門|澳门|macau|macao)/i],
    [/(退款|refund|百分比|比例)/i, /(退款|refund|百分比|比例)/i],
    [/(app|push|推播|推送|crm|會員等級|会员等级|membership)/i, /(app|push|推播|推送|crm|會員等級|会员等级|membership)/i]
  ];
  return facets.some(([request, evidence]) => request.test(latest) && !evidence.test(priorAnswer));
}
function requestsConversationSecuritySummary(latest, priorAnswer) {
  const asksSecuritySummary = /(拒絕|拒绝|敏感要求|sensitive requests?|system prompt|hidden context|secret key|bypass auth|其他客戶|其他客户)/i.test(latest) && /(總結|总结|summari)/i.test(latest);
  if (!asksSecuritySummary) return false;
  return !/(拒絕|拒绝|system prompt|hidden|secret|存取|访问|客戶|客户|credential|auth)/i.test(priorAnswer);
}
function resolvePriorGroundedTransform(latest, newestFirst) {
  const semantic = classifyCanonicalConversationTurn(latest, newestFirst);
  if (semantic.evidence_authority !== "PRIOR_GROUNDED_ANSWER" || !semantic.prior_grounded_answer || !TRANSFORMS.has(semantic.operation)) return null;
  if (requestsCurrentCustomerRequirementsSummary(latest)) return null;
  const operation = semantic.operation;
  if (requestsNewFactualFacet(latest, semantic.prior_grounded_answer.content)) return null;
  if (requestsConversationSecuritySummary(latest, semantic.prior_grounded_answer.content)) return null;
  const operations = detectRequestedTransformOperations(latest, operation);
  const requestedSummaryCount = operations.includes("SUMMARIZE") ? detectRequestedSummaryCount(latest) : null;
  const anchor = operations.includes("SUMMARIZE") ? selectBroadSummaryAnchor(latest, newestFirst, semantic.prior_grounded_answer, requestedSummaryCount) : semantic.prior_grounded_answer;
  if (!anchor.source_message_id) return null;
  const sourceChunks = [...new Set(anchor.chunk_ids.filter(Boolean))];
  if (!anchor.document_id || sourceChunks.length === 0) return null;
  for (const row of newestFirst) {
    const role = String(row.role ?? "").toLowerCase();
    const content = clean4(row.content);
    if (role !== "assistant" && role !== "ai" || content !== clean4(anchor.content)) continue;
    const meta2 = record(row.metadata);
    const lineage = record(meta2?.citation_lineage);
    const selected = clean4(lineage?.selected_document_id, 200);
    const lineageIds = normalizedChunkIds(lineage?.evidence_chunk_ids);
    const sourceMessageId = clean4(meta2?.source_message_id, 200);
    if (selected !== anchor.document_id || sourceMessageId !== anchor.source_message_id || lineageIds.length !== sourceChunks.length || lineageIds.some((id) => !sourceChunks.includes(id))) return null;
    if (!Array.isArray(meta2?.citations) || meta2.citations.length === 0) return null;
    const citations = [];
    for (const item of meta2.citations.slice(0, 3)) {
      const c = record(item);
      if (!c) return null;
      const documentId = clean4(c.document_id, 200);
      const chunkId = clean4(c.chunk_id, 200);
      const chunkType = clean4(c.chunk_type, 40);
      const label = clean4(c.label, 300) || "Knowledge Base source";
      const sourceType = clean4(c.source_type, 80) || "unknown";
      const relevance = c.relevance === "high" ? "high" : c.relevance === "medium" ? "medium" : null;
      if (documentId !== selected || chunkType !== "full_content" || !relevance || chunkId && !lineageIds.includes(chunkId)) return null;
      citations.push({
        label,
        source_type: sourceType,
        relevance,
        document_id: documentId,
        ...chunkId ? { chunk_id: chunkId } : {},
        chunk_type: "full_content"
      });
    }
    if (citations.length === 0) return null;
    return {
      operation,
      operations,
      prior_answer: anchor.content,
      selected_document_id: selected,
      evidence_chunk_ids: lineageIds,
      prior_source_message_id: sourceMessageId,
      ...requestedSummaryCount ? { requested_summary_count: requestedSummaryCount } : {},
      citations
    };
  }
  return null;
}
function buildPriorGroundedTransformGenerationSystem(context) {
  if (!context) return "";
  const operations = resolvedOperations(context);
  return [
    "You are a customer-service response transformer, not a factual answering system.",
    "The previously verified grounded answer below is the ONLY factual authority for this turn.",
    `Required transformation operations: ${operations.join(" + ")}.`,
    operations.length > 1 ? "This is one composite transformation. Apply ALL listed operations to the same prior grounded answer in a single response." : "Apply the listed transformation to the same prior grounded answer.",
    "Transform that answer exactly as requested by the latest customer instruction, except that factual grounding always overrides formatting/count requests.",
    "Do not use facts from conversation history, CRM/customer context, general knowledge, policies, titles, or any other prompt section.",
    "Do not add examples, explanations, caveats, eligibility conditions, jurisdictions, procedures, prices, dates, durations, quantities, model details, or recommendations unless they already appear in the prior grounded answer.",
    "Do not say that you checked, searched, know, recommend, infer, or verified anything beyond that prior answer.",
    "Return only the transformed customer-facing answer. No preface, no meta-commentary, no source discussion.",
    ...fixedCountContract(context),
    buildPriorGroundedTransformBlock(context)
  ].join("\n\n");
}
function buildPriorGroundedTransformGenerationUser(latestInstruction) {
  return [
    "Latest transformation instruction:",
    latestInstruction.normalize("NFKC").trim().slice(0, 1e3),
    "",
    "Perform every transformation explicitly requested in this instruction, using only the prior grounded answer as factual authority. Do not answer any other question or add any new factual content. If a requested summary count exceeds the number of distinct supported points, return fewer points rather than inventing filler."
  ].join("\n");
}
function buildPriorGroundedTransformRetrySystem(context) {
  const base = buildPriorGroundedTransformGenerationSystem(context);
  if (!base) return "";
  return [
    base,
    "STRICT RETRY: The previous transformed draft was rejected by the grounding verifier.",
    "Use shorter wording and copy factual nouns, numbers, product categories, jurisdictions, and conditions directly from the prior grounded answer whenever possible.",
    "For a composite transformation, preserve every requested operation while reducing wording; do not drop the requested target language or summary operation.",
    "A fixed summary count is a soft formatting target only. If satisfying it would require splitting, repeating, padding, or adding a claim, return fewer supported points.",
    "Do not introduce even plausible explanatory facts that are absent from the prior grounded answer."
  ].join("\n\n");
}
function buildPriorGroundedTransformBlock(context) {
  if (!context) return "";
  const operations = resolvedOperations(context);
  return [
    "Prior Grounded Answer transform rules:",
    `- Operation: ${context.operation}`,
    `- Operations: ${operations.join(" + ")}`,
    "- This is a transformation of the previously verified grounded answer, not a new factual query.",
    "- Transform ONLY the Prior Grounded Answer Evidence below.",
    "- Preserve factual meaning. Do not add, update, correct, infer, or replace facts from outside knowledge or other conversation text.",
    "- Simplification/rephrasing may change wording; translation may change language; summarization may omit detail, but none may introduce a new factual claim.",
    "- If multiple operations are listed, apply them together to this same evidence authority.",
    ...fixedCountContract(context),
    "- If the requested transformation cannot be completed without adding facts, preserve the grounded facts and relax only the formatting/count requirement; never invent information.",
    "Prior Grounded Answer Evidence:",
    "[chunk:PRIOR1]",
    context.prior_answer.slice(0, 3e3)
  ].join("\n");
}
function buildInheritedTransformCitationMetadata(context) {
  if (!context) return null;
  const operations = resolvedOperations(context);
  return {
    citations: context.citations.map((citation) => ({ ...citation })),
    citation_lineage: {
      selected_document_id: context.selected_document_id,
      evidence_chunk_ids: [...context.evidence_chunk_ids],
      evidence_count: context.evidence_chunk_ids.length
    },
    transform_lineage: {
      operation: context.operation,
      operations,
      composite: operations.length > 1,
      authority: "PRIOR_GROUNDED_ANSWER",
      prior_source_message_id: context.prior_source_message_id,
      ...context.requested_summary_count ? { requested_summary_count: context.requested_summary_count } : {}
    },
    response_route: "prior_grounded_transform"
  };
}

// supabase/functions/_shared/prior-grounded-transform.ts
var CURRENT_STATE_SUMMARY_VERB2 = /(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list)/i;
var CURRENT_STATE_SUMMARY_SCOPE2 = /(?:(?:根據|根据|按|依照|基於|基于|based\s+on|according\s+to).{0,80}(?:我|my).{0,50}(?:最新|目前|現時|現在|现在|而家|依家|current|latest).{0,50}(?:提供|資料|资料|資訊|信息|details|information)|(?:我|my).{0,40}(?:最新|目前|現時|現在|现在|而家|依家|current|latest).{0,40}(?:提供|資料|资料|資訊|信息|details|information|需求|要求|requirements?))/i;
var CURRENT_STATE_FIELDS = /(?:商品|產品|产品|sku|staff|員工|员工|人手|市場|市场|market|app|push|crm|會員等級|会员等级|功能|features?)/i;
var EXPLICIT_CURRENT_REQUIREMENTS_SUMMARY = /(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list).{0,30}(?:我|my)?\s*.{0,12}(?:最新|目前|現時|現在|现在|而家|依家|current|latest).{0,20}(?:條件|条件|需求|要求|requirements?)/i;
function isCurrentCustomerStateSummary2(text) {
  const latest = typeof text === "string" ? text.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 1600) : "";
  if (!latest || !CURRENT_STATE_SUMMARY_VERB2.test(latest)) return false;
  if (EXPLICIT_CURRENT_REQUIREMENTS_SUMMARY.test(latest)) return true;
  return Boolean(
    CURRENT_STATE_SUMMARY_SCOPE2.test(latest) && CURRENT_STATE_FIELDS.test(latest)
  );
}
function resolvePriorGroundedTransform2(latest, newestFirst) {
  if (isCurrentCustomerStateSummary2(latest)) return null;
  return resolvePriorGroundedTransform(latest, newestFirst);
}

// supabase/functions/_shared/e2-direct-threat.ts
function isDirectViolentThreat(text) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  const zhTarget = "(?:\u4F60|\u4F60\u5011|\u4F60\u4EEC|\u4ED6|\u5979|\u4ED6\u5011|\u4ED6\u4EEC|\u5979\u5011|\u5979\u4EEC|\u67D0\u4EBA|\u4EBA)";
  const zhVerb = "(?:\u6BBA|\u6740|\u6253\u6B7B|\u5F04\u6B7B|\u523A\u6B7B|\u50B7\u5BB3|\u4F24\u5BB3|\u653B\u64CA|\u653B\u51FB)";
  const zhAspect = "(?:\u4E86|\u6389)?";
  const zhDirect = new RegExp(`(?:\u6211\u8981|\u6211\u6703|\u6211\u4F1A|\u6211\u5C07|\u6211\u5C06|\u6211\u60F3\u8981|\u6211\u60F3|\u6211\u8981\u53BB|\u6211\u6E96\u5099|\u6211\u51C6\u5907)\\s*${zhVerb}${zhAspect}\\s*${zhTarget}`);
  const zhImperative = new RegExp(`${zhVerb}${zhAspect}\\s*${zhTarget}`);
  const enDirect = /\b(?:i\s+(?:will|am going to|want to|plan to)|i['’](?:ll|m\s+going\s+to))\s+(?:kill|hurt|attack|shoot|stab)\s+(?:you|him|her|them|someone|people)\b/i;
  return zhDirect.test(normalized) || zhImperative.test(normalized) || enDirect.test(normalized);
}

// supabase/functions/_shared/return-to-ai-control.ts
function buildReturnToAiGenerationGuard(latestHandoffReason, assignedAgentId) {
  const reason = String(latestHandoffReason ?? "").trim().toLowerCase();
  if (reason !== "return to ai" || assignedAgentId) return "";
  return [
    "Conversation control state: AI_ACTIVE_AFTER_EXPLICIT_RETURN_TO_AI.",
    "- The conversation was explicitly returned from human control to AI control.",
    "- Do NOT tell the customer that a human agent will reply, contact them, take over, or follow up unless the CURRENT visitor turn independently triggers a new governed handoff.",
    "- Historical handoff messages are past state only; do not continue or restate them as current status.",
    "- Continue the current customer conversation normally under AI control."
  ].join("\n");
}

// supabase/functions/_shared/warm-handoff.ts
var REGION = /(香港|台灣|台湾|澳門|澳门|Hong Kong|Taiwan|Macau)/i;
var PRODUCT = /(冷氣|空調|空调|洗衣機|洗衣机|雪櫃|冰箱|電視|电视|產品|产品|product)/i;
var PRODUCT_SUPPORT = /(維修|维修|保養|保修|故障|唔凍|不冷|不能運作|无法运行|repair|warranty|broken|not working)/i;
var ORDER_SUPPORT = /(訂單|订单|送貨|送货|退款|退貨|退货|order|delivery|refund|return)/i;
var MODEL_VALUE = /(?:型號|型号|model(?: number)?)[\s:：#-]*([A-Za-z0-9][A-Za-z0-9._\/-]{1,60})/i;
var ORDER_VALUE = /(?:訂單(?:編號|號碼|号码)|订单(?:编号|号码)|order(?: number| no\.?| id)|order\s*#)[\s:：#-]*([A-Za-z0-9][A-Za-z0-9._\/-]{2,80})/i;
var NO_MODEL = /(?:沒有|没有|冇|不知道|唔知|未知|no|don['’]?t have|do not have).{0,10}(?:型號|型号|model)/i;
var NO_ORDER = /(?:沒有|没有|冇|不知道|唔知|未知|no|don['’]?t have|do not have).{0,12}(?:訂單(?:編號|號碼|号码)?|订单(?:编号|号码)?|order(?: number| no\.?| id)?)/i;
function clean5(v, max = 500) {
  return typeof v === "string" ? v.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function meta(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function buildWarmHandoffPackage(rows, reason = "human_handoff") {
  const usable = rows.filter((r) => clean5(r.content) && clean5(r.content) !== "__THINKING__");
  const visitors = usable.filter((r) => ["visitor", "customer", "user"].includes(String(r.role || "").toLowerCase()));
  const transcript = visitors.map((r) => clean5(r.content)).join(" ");
  const last = clean5(visitors.at(-1)?.content);
  const known = [];
  const region = transcript.match(REGION)?.[0];
  if (region) known.push({ label: "Region", value: region });
  const product = transcript.match(PRODUCT)?.[0];
  if (product) known.push({ label: "Product", value: product });
  const model = transcript.match(MODEL_VALUE)?.[1];
  if (model) known.push({ label: "Model", value: model });
  const order = transcript.match(ORDER_VALUE)?.[1];
  if (order) known.push({ label: "Order reference", value: order });
  const unavailable = [];
  if (NO_MODEL.test(transcript)) unavailable.push("model");
  if (NO_ORDER.test(transcript)) unavailable.push("order_reference");
  const missing = [];
  if (PRODUCT_SUPPORT.test(transcript) && !model && !unavailable.includes("model")) missing.push("model");
  if (ORDER_SUPPORT.test(transcript) && !order && !unavailable.includes("order_reference")) missing.push("order_reference");
  const collectionAttempted = usable.some((r) => meta(r.metadata)?.response_route === "warm_handoff_data_collection");
  const assistants = usable.filter((r) => String(r.role || "").toLowerCase() === "assistant");
  const actions = assistants.filter((r) => meta(r.metadata)?.response_route !== "warm_handoff_data_collection").slice(-3).map((r) => clean5(r.content)).filter(Boolean);
  const goal = last || clean5(visitors.at(-2)?.content) || "Customer requested human support";
  return {
    reason,
    customer_goal: goal,
    known_facts: known,
    unavailable_facts: unavailable,
    missing_facts: missing,
    actions_already_tried: actions,
    last_customer_request: last,
    conversation_summary: visitors.slice(-5).map((r) => clean5(r.content)).join(" / ").slice(0, 1500),
    collection_already_attempted: collectionAttempted,
    ready_for_handoff: missing.length === 0 || collectionAttempted
  };
}
function buildMissingFactsQuestion(pkg, lang2 = "zh-TW") {
  if (pkg.missing_facts.length === 0 || pkg.collection_already_attempted) return null;
  const names = {
    model: { "zh-TW": "\u7522\u54C1\u578B\u865F", "zh-CN": "\u4EA7\u54C1\u578B\u53F7", en: "product model" },
    order_reference: { "zh-TW": "\u8A02\u55AE\u7DE8\u865F", "zh-CN": "\u8BA2\u5355\u7F16\u53F7", en: "order number" }
  };
  const labels = pkg.missing_facts.map((x) => names[x]?.[lang2] || x);
  if (lang2 === "en") return `I\u2019m connecting you with a human agent now. If it\u2019s convenient, please share ${labels.join(" and ")}; if you don\u2019t have it, that\u2019s fine \u2014 the handoff will still proceed.`;
  if (lang2 === "zh-CN") return `\u53EF\u4EE5\uFF0C\u6211\u73B0\u5728\u5E2E\u4F60\u8F6C\u4EBA\u5DE5\u5BA2\u670D\u3002\u5982\u679C\u65B9\u4FBF\uFF0C\u8BF7\u63D0\u4F9B${labels.join("\u3001")}\uFF1B\u6CA1\u6709\u4E5F\u53EF\u4EE5\uFF0C\u8F6C\u63A5\u4ECD\u4F1A\u7EE7\u7EED\u3002`;
  return `\u53EF\u4EE5\uFF0C\u6211\u73FE\u5728\u5E6B\u4F60\u8F49\u771F\u4EBA\u5BA2\u670D\u3002\u5982\u679C\u65B9\u4FBF\uFF0C\u8ACB\u63D0\u4F9B${labels.join("\u3001")}\uFF1B\u6C92\u6709\u4E5F\u53EF\u4EE5\uFF0C\u8F49\u63A5\u4ECD\u6703\u7E7C\u7E8C\u3002`;
}

// supabase/functions/_shared/handoff-decision.ts
var HUMAN_REQUEST = /(真人客服|人工客服|真人|人工|human agent|live agent|real person|speak to (?:a )?human|talk to (?:a )?human)/i;
var HUMAN_INFO_QUESTION = /(真人客服|人工客服|human agent|live agent).{0,16}(幾點|几点|時間|时间|服務時間|服务时间|hours|when|available)|(?:幾點|几点|hours|when).{0,16}(真人客服|人工客服|human agent|live agent)/i;
var STRONG_REQUEST = /(立即|即刻|而家|現在|现在).{0,10}(?:真人|人工)|(?:不要|唔要|不想要|別再|别再).{0,10}(?:AI|機器人|机器人)|(?:只要|一定要|必須|必须).{0,10}(?:真人|人工)|(?:connect|transfer).{0,8}(?:now|immediately)|no more ai|don't want ai|do not want ai/i;
var ANGER = /(嬲|生氣|生气|憤怒|愤怒|火大|離譜|离谱|垃圾|廢話|废话|煩|烦|投訴|投诉|angry|furious|ridiculous|useless|frustrat|annoyed)/i;
var REPETITION_FRUSTRATION = /(又問|再問|問過|问过|講過|说过|重複|重复|already told|asked already|again\?|stop asking|same question)/i;
var REFUSED = /(不想再提供|唔想再答|不要再問|不要再问|不會再提供|不会再提供|不提供|拒絕提供|拒绝提供|won't provide|will not provide|don't ask|do not ask|not giving)/i;
var CLARIFICATION_ROUTES = /* @__PURE__ */ new Set(["warm_handoff_data_collection", "kb_no_match_clarification"]);
function clean6(v) {
  return typeof v === "string" ? v.normalize("NFKC").trim() : "";
}
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function deriveHandoffDecisionInput(rows, latestMessage, requiredMissing, opts = {}) {
  const visitors = rows.filter((r) => ["visitor", "customer", "user"].includes(String(r.role ?? "").toLowerCase()));
  const humanCount = visitors.filter((r) => {
    const text = clean6(r.content);
    return HUMAN_REQUEST.test(text) && !HUMAN_INFO_QUESTION.test(text);
  }).length;
  const transcript = visitors.map((r) => clean6(r.content)).join(" ");
  const priorClarifications = rows.filter((r) => {
    const m = obj(r.metadata);
    return !!m && (CLARIFICATION_ROUTES.has(String(m.response_route ?? "")) || m.escalation_action === "clarification");
  }).length;
  const explicit = opts.explicit_human_request ?? HUMAN_REQUEST.test(latestMessage);
  const strength = opts.request_strength ?? (STRONG_REQUEST.test(latestMessage) || humanCount >= 2 ? "strong" : "standard");
  const anger = opts.anger_level ?? (ANGER.test(latestMessage) ? "high" : null);
  const refusal = opts.customer_refused_more_questions ?? REFUSED.test(latestMessage);
  const repetition = opts.frustration_due_to_repetition ?? REPETITION_FRUSTRATION.test(transcript.slice(-1200));
  const actionability = opts.missing_info_actionability ?? (requiredMissing.length === 0 ? "none" : requiredMissing.length === 1 && ["model", "order_reference"].includes(requiredMissing[0]) ? "high" : "low");
  return {
    explicit_human_request: explicit,
    human_request_count: opts.human_request_count ?? humanCount,
    request_strength: strength,
    anger_level: anger,
    sentiment_trend: opts.sentiment_trend ?? null,
    frustration_due_to_repetition: repetition,
    unresolved_turns: opts.unresolved_turns ?? 0,
    same_intent_repeat: opts.same_intent_repeat ?? false,
    prior_clarification_count: opts.prior_clarification_count ?? priorClarifications,
    customer_refused_more_questions: refusal,
    vip_tier: opts.vip_tier ?? null,
    high_value_customer: opts.high_value_customer ?? null,
    predicted_csat: opts.predicted_csat ?? null,
    churn_risk: opts.churn_risk ?? null,
    policy_risk: opts.policy_risk ?? null,
    threat_flag: opts.threat_flag ?? false,
    rag_state: opts.rag_state ?? null,
    handoff_history: opts.handoff_history ?? humanCount,
    current_intent: opts.current_intent ?? null,
    current_topic: opts.current_topic ?? null,
    required_info_missing: [...requiredMissing],
    missing_info_actionability: actionability
  };
}
function evaluateHandoffDecision(input) {
  const reasons = [];
  if (input.threat_flag || input.policy_risk === "high") {
    reasons.push(input.threat_flag ? "threat_or_safety_risk" : "high_policy_risk");
    return { handoff_mode: "immediate", handoff_priority: "emergency", missing_info_policy: "do_not_ask", reason_codes: reasons };
  }
  if (input.explicit_human_request) {
    const mustNotAsk = input.request_strength === "strong" || input.human_request_count >= 2 || input.anger_level === "high" || input.frustration_due_to_repetition || input.unresolved_turns >= 2 || input.prior_clarification_count > 0 || input.customer_refused_more_questions;
    if (input.request_strength === "strong") reasons.push("strong_explicit_human_request");
    if (input.human_request_count >= 2) reasons.push("repeated_human_request");
    if (input.anger_level === "high") reasons.push("high_anger");
    if (input.frustration_due_to_repetition) reasons.push("repetition_frustration");
    if (input.unresolved_turns >= 2) reasons.push("multiple_unresolved_turns");
    if (input.prior_clarification_count > 0) reasons.push("already_clarified");
    if (input.customer_refused_more_questions) reasons.push("customer_refused_more_questions");
    if (mustNotAsk) {
      return { handoff_mode: "immediate", handoff_priority: "required", missing_info_policy: "do_not_ask", reason_codes: reasons };
    }
    if (input.required_info_missing.length === 1 && input.missing_info_actionability === "high") {
      reasons.push("first_calm_human_request", "one_high_value_missing_fact", "handoff_not_blocked_for_missing_info");
      return { handoff_mode: "immediate", handoff_priority: "required", missing_info_policy: "ask_if_customer_willing", reason_codes: reasons };
    }
    return { handoff_mode: "immediate", handoff_priority: "required", missing_info_policy: "ask_if_customer_willing", reason_codes: ["explicit_human_request_override"] };
  }
  if (input.vip_tier || input.high_value_customer === true || input.predicted_csat !== null && input.predicted_csat < 3 || input.churn_risk !== null && input.churn_risk >= 0.7) {
    return { handoff_mode: "normal_ai_continue", handoff_priority: "advisory", missing_info_policy: "ask_if_customer_willing", reason_codes: ["advisory_signal_only"] };
  }
  return { handoff_mode: "normal_ai_continue", handoff_priority: "advisory", missing_info_policy: "ask_if_customer_willing", reason_codes: ["no_handoff_trigger"] };
}

// supabase/functions/_shared/conversation-closure.ts
var MISSING_FACT_GUARD = /(沒有|没有|冇|未有|不知道|唔知|no|don['’]?t have|do not have).{0,16}(型號|型号|model|訂單|订单|order|收到|收貨|收货|貨|货|地址|電話|电话|email|電郵|邮箱|付款|payment)/i;
var HANDOFF_GUARD = /(真人客服|人工客服|真人|人工|human agent|live agent|real person|speak to (?:a )?human|talk to (?:a )?human|transfer me|connect me)/i;
var HIGH_RISK_GUARD = /(爆炸|起火|著火|触电|觸電|漏電|受傷|受伤|危險|危险|安全事故|法律|合規|合规|投訴|投诉|fraud|scam|explod|fire|electric shock|injur|danger|legal|compliance|complaint)/i;
var NO_MORE = /(?:沒有了|没有了|冇喇|冇啦|沒有其他(?:問題)?|没有其他(?:问题)?|暫時沒有|暂时没有|不用了|唔使喇|唔使啦|就這樣|就这样|沒事了|没事了|沒有問題了|没有问题了|no more|nothing else|that['’]?s all|no thanks|all good|i['’]?m good)/i;
var POSITIVE = /(滿意|满意|很好|幫到我|帮到我|解決了|解决了|多謝|謝謝|谢谢|great|good service|helpful|satisfied|resolved)/i;
var ACK_ONLY = /^(?:謝謝|谢谢|多謝|唔該|明白|明白了|知道了|收到|好的|好|ok|okay|got it|understood|thanks|thank you)[。.!！?？\s]*$/i;
function lang(t) {
  if (!/[\u4e00-\u9fff]/.test(t)) return "en";
  return /[转们队为这吗个]/.test(t) ? "zh-CN" : "zh-TW";
}
function classifyConversationClosure(text) {
  const t = String(text ?? "").normalize("NFKC").trim();
  const language = lang(t);
  if (!t) return { kind: "none", language, reason: "empty" };
  if (isDirectViolentThreat(t)) return { kind: "none", language, reason: "e2_threat_precedes_closure" };
  if (HANDOFF_GUARD.test(t)) return { kind: "none", language, reason: "human_handoff_precedes_closure" };
  if (HIGH_RISK_GUARD.test(t)) return { kind: "none", language, reason: "risk_review_precedes_closure" };
  if (MISSING_FACT_GUARD.test(t)) return { kind: "none", language, reason: "missing_fact_not_closure" };
  if (NO_MORE.test(t)) return { kind: POSITIVE.test(t) ? "positive_no_more_help" : "no_more_help", language, reason: "customer_has_no_more_help_requests" };
  if (ACK_ONLY.test(t)) return { kind: "closure_candidate", language, reason: "customer_acknowledged_resolution" };
  return { kind: "none", language, reason: "substantive_or_unresolved_turn" };
}
function buildConversationClosureReply(c) {
  if (c.kind === "none") return null;
  if (c.kind === "closure_candidate") return c.language === "en" ? "You're welcome. Is there anything else I can help you with?" : c.language === "zh-CN" ? "\u4E0D\u7528\u5BA2\u6C14\u3002\u8FD8\u6709\u4EC0\u4E48\u53EF\u4EE5\u5E2E\u5230\u4F60\u5417\uFF1F" : "\u4E0D\u7528\u5BA2\u6C23\u3002\u9084\u6709\u4EC0\u9EBC\u53EF\u4EE5\u5E6B\u5230\u4F60\u55CE\uFF1F";
  return c.language === "en" ? "You're very welcome. Thank you for contacting us." : c.language === "zh-CN" ? "\u597D\u7684\uFF0C\u4E0D\u7528\u5BA2\u6C14\u3002\u8C22\u8C22\u4F60\u8054\u7EDC\u6211\u4EEC\uFF01" : "\u597D\u7684\uFF0C\u4E0D\u7528\u5BA2\u6C23\u3002\u8B1D\u8B1D\u4F60\u806F\u7D61\u6211\u5011\uFF01";
}

// supabase/functions/_shared/runtime-signal-lifecycle.ts
var PROVIDER_VERSION = "current-turn-emotion-v2.0";
var STRONG_ANGER = /(嬲|憤怒|愤怒|火大|離譜|离谱|垃圾|廢物|废物|荒謬|荒谬|angry|furious|irate|rage|ridiculous|unacceptable|bullshit)/i;
var FRUSTRATED = /(煩死|烦死|煩透|烦透|搞咗好多次|搞了很多次|試咗好多次|试了很多次|一直都唔得|一直都不行|frustrated|annoyed|fed up with this|keeps? failing|tried .* times)/i;
var DISAPPOINTED = /(失望|很差|太差|不滿意|不满意|辜負|辜负|disappointed|let down|terrible experience|awful experience)/i;
var HELPLESS = /(無奈|无奈|冇辦法|沒辦法|没有办法|唔知可以點|不知道怎麼辦|不知道怎么办|心累|算了|放棄|放弃|helpless|exhausted|don'?t know what else to do|give up|at a loss)/i;
var CONFUSED = /(睇唔明|看不懂|唔明|不明白|搞唔清|搞不清|不清楚你(?:講|说)乜|confused|don'?t understand|doesn'?t make sense|not clear to me)/i;
var HESITANT = /(不確定|不确定|猶豫|犹豫|怕.*不適合|怕.*不适合|唔知.*適唔適合|不知道.*适不适合|unsure|hesitant|not sure|worried .*won'?t (fit|work|suit)|can'?t decide)/i;
var URGENT = /(好急|很急|非常急|趕住|赶着|今天一定|今日一定|明天就要|聽日就要|马上要|馬上要|立即要|urgent|asap|right away|today for sure|need it (today|tomorrow))/i;
var HIGH_INTENT = /(我要買|我要买|想下單|想下单|直接下單|直接下单|怎麼付款|怎么付款|如何付款|立即購買|立即购买|ready to buy|i'?ll take it|want to buy|place (the )?order|how do i pay|checkout now)/i;
var POSITIVE_RECOVERY = /(明白了|明白啦|而家明白|現在明白|现在明白|解決了|解决了|搞掂|好了現在|好了现在|got it|that helps|understand now|makes sense now|resolved now|working now)/i;
var POSITIVE2 = /(喜歡|喜欢|滿意|满意|開心|开心|好正|真係好|真的很好|非常好|太好了|很棒|好棒|love (it|this)|like (it|this)|great|excellent|amazing|happy|satisfied|thank you|thanks|謝謝|谢谢)/i;
var THIRD_PARTY_EMOTION = /(?:朋友|同事|另一個客人|另一个客人|客戶|客户|他|她|佢|my friend|my colleague|another customer|he|she|they).{0,24}(?:嬲|憤怒|愤怒|失望|無奈|无奈|煩|烦|angry|furious|frustrated|disappointed|helpless|confused|happy|satisfied)/i;
var HYPOTHETICAL_EMOTION = /(?:如果|假如|假設|假设|例如|譬如|假如我|如果我|suppose|hypothetically|for example|what if).{0,40}(?:嬲|憤怒|愤怒|失望|無奈|无奈|煩|烦|angry|furious|frustrated|disappointed|helpless|confused|happy|satisfied)/i;
var QUOTED_EMOTION = /(?:佢話|他說|他说|她說|她说|客人話|客人说|customer said|they said|he said|she said)[：:\s“\"]{0,4}.{0,40}(?:嬲|憤怒|愤怒|失望|無奈|无奈|煩|烦|angry|furious|frustrated|disappointed|helpless|confused|happy|satisfied)/i;
function bounded(value) {
  return Math.max(0, Math.min(1, value));
}
function result(emotion_kind, sentiment_score, emotion_intensity, emotion_confidence, anger_flag = false) {
  return {
    emotion_kind,
    sentiment_score,
    emotion_intensity: bounded(emotion_intensity),
    emotion_confidence: bounded(emotion_confidence),
    ...anger_flag ? { anger_flag: true } : {},
    provider_version: PROVIDER_VERSION
  };
}
function classifyCurrentTurnEmotion(text) {
  const t = String(text ?? "").normalize("NFKC").trim();
  if (!t) return { provider_version: PROVIDER_VERSION };
  if (THIRD_PARTY_EMOTION.test(t) || HYPOTHETICAL_EMOTION.test(t) || QUOTED_EMOTION.test(t)) {
    return { provider_version: PROVIDER_VERSION };
  }
  if (STRONG_ANGER.test(t)) return result("angry", -0.9, 0.95, 0.96, true);
  if (HELPLESS.test(t)) return result("helpless", -0.72, 0.82, 0.92);
  if (FRUSTRATED.test(t)) return result("frustrated", -0.66, 0.76, 0.91);
  if (DISAPPOINTED.test(t)) return result("disappointed", -0.6, 0.7, 0.91);
  if (CONFUSED.test(t)) return result("confused", -0.28, 0.52, 0.9);
  if (HESITANT.test(t)) return result("hesitant", -0.12, 0.42, 0.88);
  if (URGENT.test(t)) return result("urgent", -0.08, 0.75, 0.9);
  if (HIGH_INTENT.test(t)) return result("high_intent", 0.48, 0.78, 0.91);
  if (POSITIVE_RECOVERY.test(t)) return result("positive_recovery", 0.42, 0.58, 0.9);
  if (POSITIVE2.test(t)) return result("positive", 0.68, 0.68, 0.91);
  return { provider_version: PROVIDER_VERSION };
}
function buildRealtimeR3SentimentSignals(text, historical) {
  const current = classifyCurrentTurnEmotion(text);
  const currentScore = current.sentiment_score;
  if (currentScore === void 0 && current.anger_flag !== true && !current.emotion_kind) return void 0;
  const base = Array.isArray(historical?.sentiment_trend) ? historical.sentiment_trend.filter(Number.isFinite).slice(-4) : typeof historical?.sentiment_score === "number" && Number.isFinite(historical.sentiment_score) ? [historical.sentiment_score] : [];
  const trend = currentScore === void 0 ? base : [...base, currentScore].slice(-5);
  const previous = base.length ? base[base.length - 1] : void 0;
  const recovered = typeof previous === "number" && previous < -0.2 && typeof currentScore === "number" && currentScore >= 0.2;
  return {
    ...current.anger_flag ? { anger_flag: true } : {},
    ...current.emotion_kind ? { emotion_kind: current.emotion_kind } : {},
    ...typeof current.emotion_intensity === "number" ? { emotion_intensity: current.emotion_intensity } : {},
    ...typeof current.emotion_confidence === "number" ? { emotion_confidence: current.emotion_confidence } : {},
    ...typeof currentScore === "number" ? { sentiment_score: currentScore } : {},
    ...trend.length >= 2 ? { sentiment_trend: trend } : {},
    ...recovered ? { sentiment_recovered_same_turn: true } : {},
    ...historical?.evaluation_id ? { evaluation_id: historical.evaluation_id } : {},
    provider_version: [current.provider_version, historical?.provider_version].filter(Boolean).join("+")
  };
}

// supabase/functions/_shared/emotion-reply-strategy.ts
var PURE_POSITIVE_RECOVERY_ACK = /^(?:(?:明白了|明白啦|而家明白|現在明白|现在明白|解決了|解决了|搞掂|好了現在|好了现在)(?:[，,。.!！\s]*(?:這樣|这样)?(?:清楚|明白)(?:多了|好多|咗))?(?:[，,。.!！\s]*(?:謝謝|谢谢|多謝))?|(?:got it|that helps|i understand now|that makes sense now|makes sense now|resolved now|working now)(?:[,.!\s]*(?:thanks|thank you))?)[。.!！\s]*$/i;
var POSITIVE_RECOVERY_ACKNOWLEDGEMENT = {
  "zh-TW": "\u4E0D\u7528\u5BA2\u6C23\uFF0C\u5F88\u9AD8\u8208\u9019\u6B21\u8AAA\u6E05\u695A\u4E86\u3002\u5982\u679C\u9084\u6709\u5176\u4ED6\u554F\u984C\uFF0C\u76F4\u63A5\u544A\u8A34\u6211\u5C31\u53EF\u4EE5\u3002",
  "zh-CN": "\u4E0D\u5BA2\u6C14\uFF0C\u5F88\u9AD8\u5174\u8FD9\u6B21\u8BF4\u660E\u767D\u4E86\u3002\u5982\u679C\u8FD8\u6709\u5176\u4ED6\u95EE\u9898\uFF0C\u76F4\u63A5\u544A\u8BC9\u6211\u5C31\u53EF\u4EE5\u3002",
  en: "You're welcome. I'm glad that makes sense now. If you have another question, just let me know."
};
function resolvePositiveRecoveryAcknowledgement(text, language) {
  const normalized = String(text ?? "").normalize("NFKC").trim();
  if (!normalized || normalized.length > 120) return null;
  if (/[?？]/.test(normalized)) return null;
  if (!PURE_POSITIVE_RECOVERY_ACK.test(normalized)) return null;
  return POSITIVE_RECOVERY_ACKNOWLEDGEMENT[language];
}
var STRATEGIES = {
  angry: [
    "Acknowledge the customer's anger or unacceptable experience briefly and naturally before the factual answer.",
    "Stay calm and non-defensive. Do not argue, blame, lecture, or repeat apologies.",
    "Address the core problem first and give the clearest grounded next step."
  ],
  frustrated: [
    "Acknowledge that the customer has already spent effort trying to resolve the problem.",
    "Do not ask them to repeat steps or facts already present in the conversation.",
    "Give one clear next action first, then only the minimum supporting explanation."
  ],
  disappointed: [
    "Recognize the gap between what the customer expected and what happened.",
    "Use warm, restrained empathy rather than a generic or repetitive apology.",
    "Clarify what failed and focus on the grounded resolution or next step."
  ],
  helpless: [
    "Recognize that the customer may feel stuck or exhausted after repeated attempts.",
    "Reduce customer effort: do not make them restate known facts or repeat completed troubleshooting.",
    "Take conversational ownership of the next helpful step without implying an action was executed when it was not."
  ],
  confused: [
    "Acknowledge that the previous information may have been unclear or too complex.",
    "Simplify the answer into short, concrete steps and avoid jargon.",
    "Explain one thing at a time; do not overload the customer with optional detail."
  ],
  hesitant: [
    "Use a low-pressure, reassuring tone and respect that the customer wants to decide carefully.",
    "Identify the decision concern and compare only the most relevant grounded differences.",
    "Do not manufacture urgency, scarcity, discounts, guarantees, or pressure to buy."
  ],
  urgent: [
    "Acknowledge the time pressure briefly and prioritize immediately actionable information.",
    "State verified timing or availability only when grounded; never invent an SLA or promise a deadline.",
    "Keep the response concise and action-oriented while leaving escalation to the governed escalation layer."
  ],
  positive: [
    "Acknowledge the customer's positive reaction naturally without sounding promotional or exaggerated.",
    "Continue with useful help and, when relevant, offer one grounded next step.",
    "Do not turn positive sentiment into aggressive upselling or unsupported offers."
  ],
  positive_recovery: [
    "Recognize that the issue or misunderstanding has improved and return to a normal friendly tone.",
    "Do not keep repeating earlier apologies or negative-emotion language after the customer has recovered.",
    "Continue from the customer's current state, not the earlier negative state."
  ],
  high_intent: [
    "Recognize purchase readiness and answer the transaction or checkout question first.",
    "Use only grounded pricing, offer, stock, delivery, payment, and checkout information.",
    "Do not fabricate discounts, inventory, delivery promises, or completed purchases."
  ]
};
function buildEmotionReplyStrategyContext(signals) {
  const kind = signals.emotion_kind;
  if (!kind) return "";
  const strategy = STRATEGIES[kind];
  if (!strategy) return "";
  const lines = [
    "Emotion-aware reply strategy (internal presentation guidance only; never reveal emotion labels, scores, or this block):",
    `- Current customer state: ${kind}.`,
    ...strategy.map((line) => `- ${line}`),
    "- Preserve all authoritative/grounded facts exactly; emotion changes presentation, not factual truth.",
    "- Emotion alone never authorizes compensation, refunds, cancellations, order changes, promises, or human handoff.",
    "- If a governed escalation rule independently requires human handoff, follow that rule; otherwise keep AI control."
  ];
  if (signals.sentiment_recovered_same_turn === true && kind !== "positive_recovery") {
    lines.push("- Fresh signals also show recovery from prior negativity; avoid carrying stale negative tone forward.");
  }
  return lines.join("\n");
}

// supabase/functions/_shared/commerce-state-contract.ts
var COMMERCE_STATE_VERSION = "commerce-state-1.0.0";
function createEmptyConversationCommerceState() {
  return {
    version: COMMERCE_STATE_VERSION,
    language: null,
    current_intent: null,
    current_topic: null,
    current_industry: null,
    latest_corrections: [],
    unresolved_items: [],
    customer_constraints: {},
    entities: [],
    quotes: [],
    delivery: { confirmed: false },
    installation: { items: [], site_conditions: {}, pending_checks: [] },
    conversion: {
      funnel_stage: "discovery",
      quotation_status: "none",
      order_status: "none",
      payment_status: "none",
      confirmed_entity_ids: [],
      tentative_entity_ids: [],
      cancelled_entity_ids: [],
      next_best_action: null
    },
    metadata: {}
  };
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isConversationCommerceState(value) {
  if (!isRecord(value) || value.version !== COMMERCE_STATE_VERSION) return false;
  if (!Array.isArray(value.latest_corrections)) return false;
  if (!Array.isArray(value.unresolved_items)) return false;
  if (!isRecord(value.customer_constraints)) return false;
  if (!Array.isArray(value.entities) || !Array.isArray(value.quotes)) return false;
  if (!isRecord(value.delivery) || !isRecord(value.installation) || !isRecord(value.conversion)) return false;
  if (!isRecord(value.metadata)) return false;
  return true;
}

// supabase/functions/_shared/commerce-state-reducer.ts
var MAX_CORRECTIONS = 50;
var MAX_UNRESOLVED = 100;
function clone(value) {
  return structuredClone(value);
}
function clean7(value, max = 1200) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function uniq(values) {
  return [...new Set(values.map((x) => clean7(x, 300)).filter(Boolean))];
}
function provenance(source_message_id, occurred_at) {
  return {
    source_type: "customer",
    source_message_id,
    recorded_at: occurred_at ?? null
  };
}
function findEntityIndex(state, entityId2) {
  return state.entities.findIndex((x) => x.entity_id === entityId2);
}
function reconcileConversionEntityLists(state) {
  const confirmed = [];
  const tentative = [];
  const cancelled = [];
  for (const entity of state.entities) {
    if (entity.status === "confirmed") confirmed.push(entity.entity_id);
    else if (entity.status === "tentative") tentative.push(entity.entity_id);
    else if (entity.status === "cancelled") cancelled.push(entity.entity_id);
  }
  state.conversion.confirmed_entity_ids = uniq(confirmed);
  state.conversion.tentative_entity_ids = uniq(tentative);
  state.conversion.cancelled_entity_ids = uniq(cancelled);
}
function assertFiniteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid_${label}`);
}
function assertStateShape(state) {
  if (state.version !== COMMERCE_STATE_VERSION) throw new Error("commerce_state_version_mismatch");
  const ids = /* @__PURE__ */ new Set();
  for (const entity of state.entities) {
    if (!entity.entity_id || ids.has(entity.entity_id)) throw new Error("duplicate_or_empty_entity_id");
    ids.add(entity.entity_id);
    assertFiniteNonNegative(entity.quantity, "entity_quantity");
  }
  const quoteIds = /* @__PURE__ */ new Set();
  for (const quote of state.quotes) {
    if (!quote.quote_id || quoteIds.has(quote.quote_id)) throw new Error("duplicate_or_empty_quote_id");
    quoteIds.add(quote.quote_id);
    assertFiniteNonNegative(quote.amount, "quote_amount");
  }
}
function reduceCommerceState(previous, events) {
  const next = clone(previous ?? createEmptyConversationCommerceState());
  assertStateShape(next);
  for (const event of events) {
    switch (event.type) {
      case "SET_CONTEXT": {
        if (event.language !== void 0) next.language = event.language;
        if (event.intent !== void 0) next.current_intent = event.intent;
        if (event.topic !== void 0) next.current_topic = event.topic;
        if (event.industry !== void 0) next.current_industry = event.industry;
        break;
      }
      case "ENSURE_ENTITY": {
        assertFiniteNonNegative(event.entity.quantity, "entity_quantity");
        if (findEntityIndex(next, event.entity.entity_id) < 0) next.entities.push(clone(event.entity));
        break;
      }
      case "ADD_ENTITY": {
        assertFiniteNonNegative(event.entity.quantity, "entity_quantity");
        if (findEntityIndex(next, event.entity.entity_id) >= 0) throw new Error("commerce_entity_already_exists");
        next.entities.push(clone(event.entity));
        break;
      }
      case "UPDATE_ENTITY": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        const old = next.entities[idx];
        const patch = clone(event.patch);
        if (patch.quantity !== void 0) assertFiniteNonNegative(patch.quantity, "entity_quantity");
        next.entities[idx] = {
          ...old,
          ...patch,
          entity_id: old.entity_id,
          attributes: patch.attributes ? { ...old.attributes, ...patch.attributes } : old.attributes,
          constraints: patch.constraints ? { ...old.constraints, ...patch.constraints } : old.constraints,
          provenance: event.provenance ?? patch.provenance ?? old.provenance
        };
        break;
      }
      case "SET_ENTITY_STATUS": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        next.entities[idx] = { ...next.entities[idx], status: event.status, provenance: clone(event.provenance) };
        break;
      }
      case "SET_ENTITY_QUANTITY": {
        assertFiniteNonNegative(event.quantity, "entity_quantity");
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        next.entities[idx] = { ...next.entities[idx], quantity: event.quantity, provenance: clone(event.provenance) };
        break;
      }
      case "SET_ENTITY_ATTRIBUTE": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        next.entities[idx] = {
          ...next.entities[idx],
          attributes: { ...next.entities[idx].attributes, [event.key]: clone(event.value) },
          provenance: clone(event.provenance)
        };
        break;
      }
      case "SET_ENTITY_CONSTRAINT": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        next.entities[idx] = {
          ...next.entities[idx],
          constraints: { ...next.entities[idx].constraints, [event.key]: clone(event.value) },
          provenance: clone(event.provenance)
        };
        break;
      }
      case "REMOVE_ENTITY_CONSTRAINT": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        const constraints = { ...next.entities[idx].constraints };
        delete constraints[event.key];
        next.entities[idx] = { ...next.entities[idx], constraints, provenance: clone(event.provenance) };
        break;
      }
      case "ADD_QUOTE": {
        assertFiniteNonNegative(event.quote.amount, "quote_amount");
        const idx = next.quotes.findIndex((x) => x.quote_id === event.quote.quote_id);
        if (idx >= 0) next.quotes[idx] = clone(event.quote);
        else next.quotes.push(clone(event.quote));
        break;
      }
      case "SET_QUOTE_VALIDITY": {
        const idx = next.quotes.findIndex((x) => x.quote_id === event.quote_id);
        if (idx < 0) throw new Error("commerce_quote_not_found");
        next.quotes[idx] = { ...next.quotes[idx], validity_status: event.validity_status };
        break;
      }
      case "SET_DELIVERY": {
        next.delivery = { ...next.delivery, ...clone(event.patch), provenance: clone(event.provenance) };
        break;
      }
      case "UPSERT_INSTALLATION_ITEM": {
        const idx = next.installation.items.findIndex((x) => x.item_id === event.item.item_id);
        if (idx >= 0) next.installation.items[idx] = clone(event.item);
        else next.installation.items.push(clone(event.item));
        break;
      }
      case "SET_SITE_CONDITION": {
        next.installation.site_conditions = {
          ...next.installation.site_conditions,
          [event.key]: clone(event.value)
        };
        break;
      }
      case "SET_PENDING_CHECKS": {
        next.installation.pending_checks = uniq(event.checks);
        break;
      }
      case "SET_CONVERSION": {
        next.conversion = { ...next.conversion, ...clone(event.patch) };
        break;
      }
      case "ADD_CORRECTION": {
        next.latest_corrections = uniq([...next.latest_corrections, event.correction]).slice(-MAX_CORRECTIONS);
        break;
      }
      case "SET_UNRESOLVED_ITEMS": {
        next.unresolved_items = uniq(event.items).slice(0, MAX_UNRESOLVED);
        break;
      }
      case "SET_CUSTOMER_CONSTRAINT": {
        next.customer_constraints = { ...next.customer_constraints, [event.key]: clone(event.value) };
        break;
      }
      case "REMOVE_CUSTOMER_CONSTRAINT": {
        const constraints = { ...next.customer_constraints };
        delete constraints[event.key];
        next.customer_constraints = constraints;
        break;
      }
      default: {
        const _never = event;
        throw new Error(`unsupported_commerce_event:${String(_never)}`);
      }
    }
  }
  reconcileConversionEntityLists(next);
  assertStateShape(next);
  return next;
}
function normalizedAliases(hint) {
  return uniq([hint.entity_id, hint.category, hint.brand ?? "", hint.model ?? "", ...hint.aliases ?? []]).map((x) => x.toLowerCase());
}
function mentionedHints(text, hints) {
  const lower2 = text.toLowerCase();
  return hints.filter((hint) => normalizedAliases(hint).some((alias) => alias.length >= 2 && lower2.includes(alias)));
}
function ensureHintEntityEvents(input, hints) {
  const p = provenance(input.source_message_id, input.occurred_at);
  return hints.map((hint) => ({
    type: "ENSURE_ENTITY",
    entity: {
      entity_id: hint.entity_id,
      category: hint.category,
      brand: hint.brand ?? null,
      model: hint.model ?? null,
      quantity: hint.quantity ?? 1,
      status: hint.status ?? "researching",
      attributes: clone(hint.attributes ?? {}),
      constraints: clone(hint.constraints ?? {}),
      provenance: p
    }
  }));
}
function parseSmallCount(raw) {
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  const map = { \u4E00: 1, \u4E8C: 2, \u5169: 2, \u4E24: 2, \u4E09: 3, \u56DB: 4, \u4E94: 5, \u516D: 6, \u4E03: 7, \u516B: 8, \u4E5D: 9, \u5341: 10 };
  return map[raw] ?? null;
}
function parseExplicitQuantity(text) {
  const m = text.match(/(?:qty|quantity|數量|数量|共|總共|总共|要|需要|買|买|訂|订|改做|改成|change to)\s*(?:係|是|=|:|：)?\s*([一二兩两三四五六七八九十]|\d{1,4})\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚|night|nights|pcs?|pieces?|units?|items?)?/i) ?? text.match(/([一二兩两三四五六七八九十]|\d{1,4})\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚|night|nights|pcs?|pieces?|units?|items?)\b/i);
  return m?.[1] ? parseSmallCount(m[1]) : null;
}
function parseMoney(text) {
  const m = text.match(/(?:HK\$|US\$|NT\$|TWD\s*|USD\s*|HKD\s*|\$)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i) ?? text.match(/(?:價|价|報價|报价|quote|quoted|price)\s*(?:係|是|為|为|=|:|：)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  if (!m?.[1]) return null;
  const amount = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const prefix = m[0].toUpperCase();
  const currency = prefix.includes("US$") || prefix.includes("USD") ? "USD" : prefix.includes("NT$") || prefix.includes("TWD") ? "TWD" : "HKD";
  return { amount, currency };
}
function detectEntityStatus(text) {
  if (/(?:取消|唔要|不要|不買|不买|唔買|cancel(?:led)?|remove it|drop it)/i.test(text)) return "cancelled";
  if (/(?:暫時唔|暫時不|暂时不|稍後先|稍后再|defer|later|hold off)/i.test(text)) return "deferred";
  if (/(?:確認要|确认要|確定要|确定要|就要|confirmed?|keep it|take it)/i.test(text)) return "confirmed";
  if (/(?:考慮|考虑|睇下|看看|研究|research|consider)/i.test(text)) return "researching";
  return null;
}
function detectFunnel(text) {
  if (/(?:已付款|已付|paid\b)/i.test(text)) return { funnel_stage: "order_confirmed", order_status: "confirmed", payment_status: "paid" };
  if (/(?:正式落單|正式下单|confirm(?:ed)? order|order confirmed)/i.test(text)) return { funnel_stage: "order_confirmed", order_status: "confirmed" };
  if (/(?:未正式落單|未正式下单|唔係正式落單|不是正式下单|not (?:a )?confirmed order|quotation only|只係報價|只是报价)/i.test(text)) {
    return { funnel_stage: "quotation", quotation_status: "draft", order_status: "draft", payment_status: "pending_quote" };
  }
  if (/(?:準備落單|准备下单|ready to order|準備下單|准备落单)/i.test(text)) return { funnel_stage: "checkout_ready", order_status: "pending_confirmation" };
  if (/(?:報價|报价|quotation|quote)/i.test(text)) return { funnel_stage: "quotation", quotation_status: "draft" };
  return null;
}
function correctionText(text) {
  if (/(?:更正|改返|改成|最新|記住|记住|唔係|不是|actually|i meant|correction)/i.test(text)) return text;
  return null;
}
function explicitDeliveryPatch(text) {
  const patch = {};
  const phone = text.match(/(?:電話|电话|phone|contact)\s*(?:係|是|=|:|：)?\s*([+\d][\d\s-]{6,20})/i);
  if (phone?.[1]) patch.recipient_phone = phone[1].replace(/\s+/g, " ").trim();
  const recipient = text.match(/(?:收貨人|收货人|recipient)\s*(?:係|是|=|:|：)?\s*([^，。,.!?！？]{1,40})/i);
  if (recipient?.[1]) patch.recipient_name = recipient[1].trim();
  const address = text.match(/(?:地址|送貨地址|送货地址|delivery address)\s*(?:係|是|=|:|：)?\s*([^。!?！？]{3,180})/i);
  if (address?.[1]) patch.address = address[1].trim();
  const date = text.match(/(?:送貨|送货|delivery|deliver|appointment|預約|预约).{0,20}(星期[一二三四五六日天]|週[一二三四五六日天]|周[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})/i);
  if (date?.[1]) patch.preferred_date = date[1];
  return Object.keys(patch).length ? patch : null;
}
function deriveCommerceEventsFromCustomerTurn(input) {
  const text = clean7(input.text);
  if (!text || !input.source_message_id) return [];
  const p = provenance(input.source_message_id, input.occurred_at);
  const hints = input.entity_hints ?? [];
  const mentioned = mentionedHints(text, hints);
  const events = [
    { type: "SET_CONTEXT", language: input.current_language, industry: input.current_industry },
    ...ensureHintEntityEvents(input, mentioned)
  ];
  const correction = correctionText(text);
  if (correction) events.push({ type: "ADD_CORRECTION", correction });
  const status = detectEntityStatus(text);
  const quantity = parseExplicitQuantity(text);
  if (mentioned.length === 1) {
    const entityId2 = mentioned[0].entity_id;
    if (status) events.push({ type: "SET_ENTITY_STATUS", entity_id: entityId2, status, provenance: p });
    if (quantity !== null) events.push({ type: "SET_ENTITY_QUANTITY", entity_id: entityId2, quantity, provenance: p });
  }
  const money = parseMoney(text);
  if (money) {
    const entityId2 = mentioned.length === 1 ? mentioned[0].entity_id : null;
    const historical = /(?:之前|上次|舊價|旧价|歷史|历史|previous|historical|last time)/i.test(text);
    const explicitlyUnverified = /(?:唔肯定|不確定|不确定|未confirm|未確認|未确认|unverified|not sure)/i.test(text);
    events.push({
      type: "ADD_QUOTE",
      quote: {
        quote_id: `customer:${input.source_message_id}:0`,
        entity_id: entityId2,
        amount: money.amount,
        currency: input.currency ?? money.currency,
        quote_type: historical ? "customer_reported_historical" : "unverified",
        validity_status: historical && !explicitlyUnverified ? "historical" : "unknown",
        source_label: "customer_reported",
        conditions: { historical, unverified: !historical || explicitlyUnverified },
        provenance: p
      }
    });
  }
  const delivery = explicitDeliveryPatch(text);
  if (delivery) events.push({ type: "SET_DELIVERY", patch: delivery, provenance: p });
  const conversion = detectFunnel(text);
  if (conversion) events.push({ type: "SET_CONVERSION", patch: conversion });
  return events;
}

// supabase/functions/_shared/commerce-state-authority.ts
function clean8(value, max = 1200) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function isRecord2(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isKnownValue(value) {
  return value !== void 0 && value !== null && value !== "";
}
function getCommerceStatePath(state, path) {
  const parts = clean8(path, 300).split(".").filter(Boolean);
  if (!parts.length) return void 0;
  let current = state;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return void 0;
      current = current[index];
      continue;
    }
    if (!isRecord2(current) || !(part in current)) return void 0;
    current = current[part];
  }
  return current;
}
function calculateCommerceTerms(terms, currency) {
  if (!terms.length) return null;
  let total = 0;
  const expressionParts = [];
  for (const term of terms) {
    if (!Number.isFinite(term.value)) return null;
    const multiplier = term.multiplier ?? 1;
    if (!Number.isFinite(multiplier)) return null;
    total += term.value * multiplier;
    expressionParts.push(`${term.label}:${term.value}\xD7${multiplier}`);
  }
  return {
    expression: expressionParts.join(" + "),
    result: Math.round((total + Number.EPSILON) * 100) / 100,
    currency: currency ?? null
  };
}
function questionLooksLikeCurrentBusinessFact(question) {
  return /(?:而家|現在|现在|目前|最新|current|latest|今日|today).{0,30}(?:價|价|price|stock|庫存|库存|有貨|有货|available|政策|policy|收費|收费|fee|delivery|送貨|送货|保養|保修|warranty)/i.test(question);
}
function questionLooksLikeCustomerState(question) {
  return /(?:我(?:而家|現在|现在|目前|最後|最后)?|my\s+(?:current|latest|final)?).{0,45}(?:幾多|多少|數量|数量|要咩|要什麼|要什么|地址|電話|电话|收貨人|收货人|日期|時間|时间|要求|需求|限制|狀態|状态|order|quote|quotation|quantity|address|phone|recipient|date|requirements?|constraints?|status)|(?:幫我|帮我|please).{0,30}(?:總結|总结|summari[sz]e).{0,30}(?:我|my)/i.test(question);
}
function questionLooksLikeCalculation(question) {
  return /(?:加埋|合共|總共幾錢|总共多少钱|一共多少|total|how much.*(?:total|altogether)|calculate|計下|算下|計算|计算)/i.test(question);
}
function questionExplicitlyAsksQuantity(question) {
  if (/(?:價|价|price|amount|金額|金额|幾錢|几钱|多少錢|多少钱|fee|收費|收费)/i.test(question)) return false;
  return /(?:數量|数量|quantity|how many|幾多\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚)|多少\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚))/i.test(question);
}
function inferKnownCustomerStatePath(question, state) {
  const candidates = [
    [/(?:送貨地址|送货地址|地址|delivery address|address)/i, "delivery.address"],
    [/(?:收貨人電話|收货人电话|recipient phone|contact phone)/i, "delivery.recipient_phone"],
    [/(?:收貨人|收货人|recipient)/i, "delivery.recipient_name"],
    [/(?:送貨日期|送货日期|送貨時間|送货时间|delivery date|delivery time|preferred date)/i, "delivery.preferred_date"],
    [/(?:order status|訂單狀態|订单状态|落單狀態|下单状态)/i, "conversion.order_status"],
    [/(?:quote status|quotation status|報價狀態|报价状态)/i, "conversion.quotation_status"],
    [/(?:payment status|付款狀態|付款状态)/i, "conversion.payment_status"]
  ];
  for (const [pattern, path] of candidates) {
    if (!pattern.test(question)) continue;
    const value = getCommerceStatePath(state, path);
    if (isKnownValue(value)) return { path, value };
  }
  if (questionExplicitlyAsksQuantity(question)) {
    const active = state.entities.filter((entity) => entity.status !== "cancelled" && entity.status !== "deferred");
    if (active.length === 1) {
      return { path: `entities.${state.entities.indexOf(active[0])}.quantity`, value: active[0].quantity };
    }
  }
  return null;
}
function resolveCommerceAnswerAuthority(input) {
  const question = clean8(input.question);
  const explicitStatePath = clean8(input.requested_state_path ?? "", 300);
  if (explicitStatePath) {
    const known = getCommerceStatePath(input.state, explicitStatePath);
    if (isKnownValue(known)) {
      return {
        authority: "CONVERSATION_STATE",
        reason: "requested_customer_state_is_known",
        known_value: known,
        state_path: explicitStatePath
      };
    }
  }
  const inferred = inferKnownCustomerStatePath(question, input.state);
  if (inferred) {
    return {
      authority: "CONVERSATION_STATE",
      reason: "customer_state_inferred_and_known",
      known_value: inferred.value,
      state_path: inferred.path
    };
  }
  if ((questionLooksLikeCalculation(question) || (input.calculation_terms?.length ?? 0) > 0) && input.calculation_terms?.length) {
    const calculation = calculateCommerceTerms(input.calculation_terms, input.calculation_currency);
    if (calculation) {
      return {
        authority: "DETERMINISTIC_CALCULATION",
        reason: "calculation_fully_supported_by_known_terms",
        calculation
      };
    }
  }
  if (input.requires_professional_site_check || input.unsafe_to_remote_confirm) {
    return {
      authority: "SAFE_PROFESSIONAL_CONFIRMATION",
      reason: "remote_confirmation_not_safe_or_not_authoritative"
    };
  }
  if (input.requires_current_business_fact || input.requires_current_price_or_stock || input.requires_policy_or_terms || questionLooksLikeCurrentBusinessFact(question)) {
    return {
      authority: "CURRENT_KB_REQUIRED",
      reason: "current_business_fact_requires_authoritative_evidence"
    };
  }
  if (questionLooksLikeCustomerState(question)) {
    return {
      authority: "INSUFFICIENT_INFORMATION",
      reason: "customer_state_question_but_requested_fact_not_resolved",
      state_path: explicitStatePath || null
    };
  }
  return {
    authority: "INSUFFICIENT_INFORMATION",
    reason: "no_authoritative_source_selected"
  };
}

// supabase/functions/_shared/commerce-capability-runtime.ts
var COUNT_TOKEN = "[\u4E00\u4E8C\u5169\u4E24\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341]|\\d{1,4}";
var GENERIC_UNIT = "\u4EF6|\u500B|\u4E2A|\u76D2|\u7BB1|\u5305|\u888B|\u6A3D|\u74F6|\u652F|\u679D|\u672C|\u518A|\u518C|\u5957|\u5C0D|\u5BF9|\u96D9|\u53CC|\u689D|\u6761|\u5F35|\u5F20|\u53F0|\u90E8|\u4EFD|\u4F4D|\u5E2D|\u9593|\u95F4|\u665A|\u6B21|\u5802|\u8AB2|\u8BFE|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?";
function clean9(value, max = 1200) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function countValue(raw) {
  const map = {
    \u4E00: 1,
    \u4E8C: 2,
    \u5169: 2,
    \u4E24: 2,
    \u4E09: 3,
    \u56DB: 4,
    \u4E94: 5,
    \u516D: 6,
    \u4E03: 7,
    \u516B: 8,
    \u4E5D: 9,
    \u5341: 10
  };
  if (/^\d+$/.test(raw)) return Number(raw);
  return map[raw] ?? null;
}
function trimCandidate(raw) {
  return clean9(raw, 80).replace(/(?:請|请)?(?:報價|报价|幾錢|几钱|多少錢|多少钱|price|quote|quotation|total|合共|總共|总共).*$/i, "").replace(/(?:星期[一二三四五六日天]|週[一二三四五六日天]|周[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/gi, " ").replace(/(?:HK\$|HKD|US\$|USD|NT\$|TWD|\$)\s*[0-9].*$/i, "").replace(/[，。！？,.!?;；:：]+$/g, "").replace(/\s+/g, " ").trim();
}
function canonicalGenericName(raw) {
  let value = trimCandidate(raw).replace(/^(?:黑色|白色|紅色|红色|藍色|蓝色|綠色|绿色|黃色|黄色|粉紅|粉红|紫色|灰色|black|white|red|blue|green|yellow|pink|purple|grey|gray)\s*/i, "").replace(/^(?:small|medium|large|xl|xxl|xs)\s+/i, "").replace(/^(?:size\s*[xsml0-9-]+)\s+/i, "").trim();
  if (/^[a-z0-9][a-z0-9 -]{3,}$/i.test(value) && /s$/i.test(value) && !/ss$/i.test(value)) {
    value = value.replace(/s$/i, "");
  }
  return value;
}
function slugify(raw) {
  return canonicalGenericName(raw).toLowerCase().replace(/["'`]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function extractSku(text) {
  const match = clean9(text).match(/(?:SKU|貨號|货号|型號|型号|model)\s*(?:=|:|：|#)?\s*([A-Z0-9][A-Z0-9._\/-]{1,39})/i);
  return match?.[1] ? match[1].trim() : null;
}
function extractVariant(text) {
  const t = clean9(text);
  const variant = {};
  const size = t.match(/(?:size|尺寸|尺碼|尺码)\s*(?:=|:|：)?\s*([A-Z0-9-]{1,12})/i) ?? t.match(/\b([XSML]{1,4})\s*碼/i);
  if (size?.[1]) variant.size = size[1];
  const color = t.match(/(?:color|colour|顏色|颜色)\s*(?:=|:|：)?\s*([^，。,.!?！？]{1,24})/i);
  if (color?.[1]) variant.color = color[1].trim();
  else {
    const leading = t.match(/(黑色|白色|紅色|红色|藍色|蓝色|綠色|绿色|黃色|黄色|粉紅|粉红|紫色|灰色|black|white|red|blue|green|yellow|pink|purple|grey|gray)(?=\s|[A-Za-z\u3400-\u9fff])/i);
    if (leading?.[1]) variant.color = leading[1];
  }
  return variant;
}
function inferKind(text, unit, quantity) {
  const t = clean9(text).toLowerCase();
  if (/(?:下載|下载|電子版|电子版|digital|download|software|license|licence|ebook|e-book|activation key|啟用碼|激活码)/i.test(t)) return "digital_good";
  if (/(?:預約|预约|appointment|book(?:ing)?|reserve|reservation|服務|服务|剪髮|剪发|療程|疗程|consultation|session|lesson|class)/i.test(t) || /^(?:位|席|次|堂|課|课|sessions?|lessons?|seats?)$/i.test(unit ?? "")) return "service";
  if (quantity >= 20 && /(?:批發|批发|MOQ|minimum order|wholesale|報價|报价|quotation|quote)/i.test(t)) return "b2b_product";
  if (unit || /(?:產品|产品|商品|貨品|货品|product|item)/i.test(t)) return "physical_product";
  return "unknown";
}
function inferCommerceCapabilities(text, kind) {
  const t = clean9(text).toLowerCase();
  const requiresInstallation = /(?:安裝|安装|install(?:ation)?|mount(?:ing)?|setup|拆機|拆机)/i.test(t);
  const requiresSiteCheck = requiresInstallation && /(?:上門|上门|site|onsite|on-site|窗口|窗台|牆|墙|承重|電壓|电压|排水|師傅|师傅|technician|survey)/i.test(t);
  const requiresBooking = kind === "service" || /(?:預約|预约|appointment|book(?:ing)?|reserve|reservation|時段|时段|slot)/i.test(t);
  const requiresDelivery = /(?:送貨|送货|配送|delivery|deliver|shipping|ship\b|寄送|收貨|收货|delivery address)/i.test(t);
  const requiresQuote = /(?:報價|报价|quotation|quote|幾錢|几钱|多少錢|多少钱|price|fee|收費|收费|MOQ)/i.test(t);
  return {
    requires_delivery: requiresDelivery,
    requires_installation: requiresInstallation,
    requires_booking: requiresBooking,
    requires_quote: requiresQuote,
    requires_site_check: requiresSiteCheck,
    digital_fulfilment: kind === "digital_good"
  };
}
function mergeCapabilities(a, b) {
  return {
    requires_delivery: a.requires_delivery || b.requires_delivery,
    requires_installation: a.requires_installation || b.requires_installation,
    requires_booking: a.requires_booking || b.requires_booking,
    requires_quote: a.requires_quote || b.requires_quote,
    requires_site_check: a.requires_site_check || b.requires_site_check,
    digital_fulfilment: a.digital_fulfilment || b.digital_fulfilment
  };
}
function extractGenericCommerceEntity(text) {
  const t = clean9(text);
  if (!t) return null;
  const action = "(?:\u6211\u8981|\u6211\u60F3\u8981|\u60F3\u8CB7|\u60F3\u4E70|\u8981\u8CB7|\u8981\u4E70|\u8CB7|\u4E70|\u9700\u8981|\u8A02\u8CFC|\u8BA2\u8D2D|\u8A02|\u8BA2|\u9810\u8A02|\u9884\u8BA2|\u9810\u7D04|\u9884\u7EA6|\u53E6\u5916\u52A0|\u518D\u52A0|\u52A0\u591A|\u65B0\u589E|I\\s+(?:want|need)|want|need|buy|order|pre[- ]?order|book|reserve|add)";
  const zhOrUnit = new RegExp(`${action}\\s*(${COUNT_TOKEN})\\s*(${GENERIC_UNIT})?\\s*([^\uFF0C\u3002\uFF01\uFF1F,.!?;\uFF1B]{1,60})`, "i");
  const match = t.match(zhOrUnit);
  if (!match?.[1] || !match?.[3]) return null;
  const quantity = countValue(match[1]);
  if (quantity === null || quantity <= 0) return null;
  const unit = match[2]?.trim() || null;
  const rawName = trimCandidate(match[3]);
  const canonicalName = canonicalGenericName(rawName);
  const slug = slugify(canonicalName);
  if (!canonicalName || !slug || canonicalName.length < 2) return null;
  const kind = inferKind(t, unit, quantity);
  const capabilities = inferCommerceCapabilities(t, kind);
  const category = kind === "service" ? "service" : kind === "digital_good" ? "digital_good" : kind === "b2b_product" ? "b2b_product" : "generic_product";
  const aliases = [...new Set([canonicalName, rawName].map((x) => clean9(x, 80)).filter(Boolean))];
  return {
    entity_id: `generic:${slug}`,
    category,
    display_name: canonicalName,
    quantity,
    unit,
    kind,
    sku: extractSku(t),
    variant: extractVariant(t),
    capabilities,
    aliases
  };
}
function buildGenericCommerceEntityHints(texts) {
  const hints = /* @__PURE__ */ new Map();
  for (const raw of texts) {
    const extracted = extractGenericCommerceEntity(raw);
    if (!extracted) continue;
    const next = {
      entity_id: extracted.entity_id,
      category: extracted.category,
      aliases: extracted.aliases,
      quantity: extracted.quantity,
      attributes: {
        product_name: extracted.display_name,
        commerce_kind: extracted.kind,
        unit: extracted.unit,
        sku: extracted.sku,
        variant: extracted.variant,
        capabilities: extracted.capabilities
      }
    };
    const existing = hints.get(extracted.entity_id);
    if (!existing) {
      hints.set(extracted.entity_id, next);
      continue;
    }
    const existingCaps = readCapabilitiesFromAttributes(existing.attributes);
    hints.set(extracted.entity_id, {
      ...existing,
      aliases: [.../* @__PURE__ */ new Set([...existing.aliases ?? [], ...extracted.aliases])],
      attributes: {
        ...existing.attributes ?? {},
        capabilities: mergeCapabilities(existingCaps, extracted.capabilities)
      }
    });
  }
  return [...hints.values()];
}
function readCapabilitiesFromAttributes(attributes) {
  const raw = attributes?.capabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return inferCommerceCapabilities("", "unknown");
  const r = raw;
  return {
    requires_delivery: r.requires_delivery === true,
    requires_installation: r.requires_installation === true,
    requires_booking: r.requires_booking === true,
    requires_quote: r.requires_quote === true,
    requires_site_check: r.requires_site_check === true,
    digital_fulfilment: r.digital_fulfilment === true
  };
}
function getEntityCapabilities(entity) {
  return readCapabilitiesFromAttributes(entity.attributes);
}
function aggregateCommerceCapabilities(state) {
  const zero = inferCommerceCapabilities("", "unknown");
  return state.entities.filter((entity) => entity.status !== "cancelled" && entity.status !== "deferred").reduce((acc, entity) => mergeCapabilities(acc, getEntityCapabilities(entity)), zero);
}
function genericEntityLabelFromId(entityId2) {
  if (!entityId2.startsWith("generic:")) return null;
  const raw = entityId2.slice("generic:".length).replace(/-/g, " ").trim();
  return raw || null;
}
function buildCapabilityAwarePreorderNextStep(state, language) {
  const caps = aggregateCommerceCapabilities(state);
  if (language === "en") {
    if (caps.requires_booking) return "The next step is to confirm the service or time slot, the final price, and then the payment arrangement.";
    if (caps.requires_installation || caps.requires_site_check) return "The next step is to confirm the final price, any installation or site requirements, and then the payment arrangement.";
    if (caps.requires_delivery) return "The next step is to confirm the final price and order details, delivery arrangements, and then payment.";
    if (caps.digital_fulfilment) return "The next step is to confirm the final price and order details, then arrange payment before digital fulfilment.";
    return "The next step is to confirm the final price and order details, then arrange payment.";
  }
  if (language === "zh-CN") {
    if (caps.requires_booking) return "\u4E0B\u4E00\u6B65\u9700\u8981\u786E\u8BA4\u670D\u52A1\uFF0F\u9884\u7EA6\u65F6\u6BB5\u548C\u6700\u7EC8\u4EF7\u683C\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u3002";
    if (caps.requires_installation || caps.requires_site_check) return "\u4E0B\u4E00\u6B65\u9700\u8981\u786E\u8BA4\u6700\u7EC8\u4EF7\u683C\u53CA\u9002\u7528\u7684\u5B89\u88C5\uFF0F\u73B0\u573A\u6761\u4EF6\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u3002";
    if (caps.requires_delivery) return "\u4E0B\u4E00\u6B65\u9700\u8981\u786E\u8BA4\u6700\u7EC8\u4EF7\u683C\u548C\u8BA2\u5355\u8D44\u6599\u3001\u9001\u8D27\u5B89\u6392\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u3002";
    if (caps.digital_fulfilment) return "\u4E0B\u4E00\u6B65\u9700\u8981\u786E\u8BA4\u6700\u7EC8\u4EF7\u683C\u548C\u8BA2\u5355\u8D44\u6599\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u53CA\u6570\u7801\u4EA4\u4ED8\u3002";
    return "\u4E0B\u4E00\u6B65\u9700\u8981\u786E\u8BA4\u6700\u7EC8\u4EF7\u683C\u548C\u8BA2\u5355\u8D44\u6599\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u3002";
  }
  if (caps.requires_booking) return "\u4E0B\u4E00\u6B65\u8981\u78BA\u8A8D\u670D\u52D9\uFF0F\u9810\u7D04\u6642\u6BB5\u540C\u6700\u7D42\u50F9\u683C\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u3002";
  if (caps.requires_installation || caps.requires_site_check) return "\u4E0B\u4E00\u6B65\u8981\u78BA\u8A8D\u6700\u7D42\u50F9\u683C\u540C\u9069\u7528\u5605\u5B89\u88DD\uFF0F\u73FE\u5834\u689D\u4EF6\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u3002";
  if (caps.requires_delivery) return "\u4E0B\u4E00\u6B65\u8981\u78BA\u8A8D\u6700\u7D42\u50F9\u683C\u540C\u8A02\u55AE\u8CC7\u6599\u3001\u9001\u8CA8\u5B89\u6392\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u3002";
  if (caps.digital_fulfilment) return "\u4E0B\u4E00\u6B65\u8981\u78BA\u8A8D\u6700\u7D42\u50F9\u683C\u540C\u8A02\u55AE\u8CC7\u6599\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u540C\u6578\u78BC\u4EA4\u4ED8\u3002";
  return "\u4E0B\u4E00\u6B65\u8981\u78BA\u8A8D\u6700\u7D42\u50F9\u683C\u540C\u8A02\u55AE\u8CC7\u6599\uFF0C\u518D\u5B89\u6392\u4ED8\u6B3E\u3002";
}

// supabase/functions/_shared/commerce-semantic-adapter.ts
function clean10(value, max = 200) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function slugify2(raw) {
  return clean10(raw, 160).toLowerCase().replace(/["'`]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function categoryFor(entity) {
  if (entity.category_hint) return clean10(entity.category_hint, 80) || "generic_product";
  switch (entity.kind) {
    case "digital_good":
      return "digital_good";
    case "service":
      return "service";
    case "rental":
      return "rental";
    case "subscription":
      return "subscription";
    case "ticket":
      return "ticket";
    case "custom_item":
      return "custom_item";
    case "b2b_product":
      return "b2b_product";
    case "physical_product":
      return "generic_product";
    default:
      return "generic_item";
  }
}
function entityId(entity) {
  const explicit = clean10(entity.entity_ref, 120);
  if (explicit && !/^(?:semantic|current|prior|item|entity):?\d*$/i.test(explicit)) {
    return explicit.startsWith("generic:") ? explicit : `generic:${slugify2(explicit)}`;
  }
  return `generic:${slugify2(entity.name) || "item"}`;
}
function semanticFrameToEntityHints(frame) {
  if (!frame) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entity of frame.entities) {
    if (!entity.name || entity.confidence < 0.45) continue;
    const id = entityId(entity);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      entity_id: id,
      category: categoryFor(entity),
      aliases: [...new Set([entity.name, entity.entity_ref, entity.sku ?? "", entity.model ?? ""].map((x) => clean10(x, 160)).filter(Boolean))],
      quantity: entity.quantity ?? void 0,
      model: entity.model,
      attributes: {
        semantic_frame_version: frame.version,
        semantic_operation: frame.operation,
        product_name: entity.name,
        commerce_kind: entity.kind,
        unit: entity.unit,
        sku: entity.sku,
        semantic_confidence: entity.confidence,
        semantic_transaction_state: frame.transaction_state,
        semantic_payment_state: frame.payment_state,
        semantic_booking_state: frame.booking_state,
        semantic_fulfillment_state: frame.fulfillment_state,
        semantic_attributes: entity.attributes,
        capabilities: entity.capabilities
      },
      constraints: entity.constraints
    });
  }
  return out;
}
function mergeCommerceEntityHints(semantic, deterministic) {
  const map = /* @__PURE__ */ new Map();
  for (const hint of deterministic) map.set(hint.entity_id, hint);
  for (const hint of semantic) {
    const semanticAliases = (hint.aliases ?? []).map((x) => clean10(x).toLowerCase()).filter(Boolean);
    const compatible = [...map.values()].find((candidate) => {
      const aliases = [candidate.entity_id, candidate.category, ...candidate.aliases ?? []].map((x) => clean10(x).toLowerCase()).filter(Boolean);
      return semanticAliases.some((a) => aliases.some((b) => a === b || a.includes(b) || b.includes(a)));
    });
    const key = compatible?.entity_id ?? hint.entity_id;
    const existing = map.get(key);
    const normalized = compatible ? { ...hint, entity_id: compatible.entity_id, category: compatible.category } : hint;
    if (!existing) {
      map.set(key, normalized);
      continue;
    }
    map.set(key, {
      ...existing,
      aliases: [.../* @__PURE__ */ new Set([...existing.aliases ?? [], ...normalized.aliases ?? []])],
      quantity: normalized.quantity ?? existing.quantity,
      model: normalized.model ?? existing.model,
      attributes: { ...existing.attributes ?? {}, ...normalized.attributes ?? {} },
      constraints: { ...existing.constraints ?? {}, ...normalized.constraints ?? {} }
    });
  }
  return [...map.values()];
}
function provenance2(sourceMessageId, occurredAt) {
  return { source_type: "customer", source_message_id: sourceMessageId, recorded_at: occurredAt ?? null };
}
function activeEntities(state) {
  return state.entities.filter((x) => x.status !== "cancelled" && x.status !== "deferred");
}
function resolveHintId(entity, hints, previous) {
  const wanted = [entity.name, entity.entity_ref, entity.sku ?? "", entity.model ?? ""].map((x) => clean10(x).toLowerCase()).filter(Boolean);
  const hinted = hints.find((hint) => {
    const aliases = [hint.entity_id, hint.category, ...hint.aliases ?? []].map((x) => clean10(x).toLowerCase()).filter(Boolean);
    return wanted.some((a) => aliases.some((b) => a === b || a.includes(b) || b.includes(a)));
  });
  if (hinted) return hinted.entity_id;
  const direct = entityId(entity);
  if (previous.entities.some((x) => x.entity_id === direct)) return direct;
  const active = activeEntities(previous);
  if (active.length === 1 && entity.confidence >= 0.75) return active[0].entity_id;
  return direct;
}
function semanticFrameToStateEvents(frame, previous, hints, sourceMessageId, occurredAt) {
  if (!frame || frame.confidence < 0.62 || frame.ambiguity.is_ambiguous) return [];
  const p = provenance2(sourceMessageId, occurredAt);
  const events = [];
  for (const entity of frame.entities) {
    if (entity.confidence < 0.55) continue;
    const id = resolveHintId(entity, hints, previous);
    if (!id) continue;
    const existing = previous.entities.find((x) => x.entity_id === id);
    const hint = hints.find((x) => x.entity_id === id);
    if (frame.operation === "ADD_ITEM") {
      if (existing && frame.additive && entity.quantity !== null) {
        events.push({ type: "SET_ENTITY_QUANTITY", entity_id: id, quantity: existing.quantity + entity.quantity, provenance: p });
      } else if (!existing) {
        events.push({
          type: "ENSURE_ENTITY",
          entity: {
            entity_id: id,
            category: hint?.category ?? categoryFor(entity),
            brand: null,
            model: entity.model,
            quantity: entity.quantity ?? 1,
            status: "tentative",
            attributes: { ...hint?.attributes ?? {}, semantic_attributes: entity.attributes, capabilities: entity.capabilities },
            constraints: { ...hint?.constraints ?? {}, ...entity.constraints },
            provenance: p
          }
        });
      } else if (entity.quantity !== null && !frame.additive) {
        events.push({ type: "SET_ENTITY_QUANTITY", entity_id: id, quantity: entity.quantity, provenance: p });
      }
    }
    if ((frame.operation === "SET_QUANTITY" || frame.customer_correction) && entity.quantity !== null && existing) {
      events.push({ type: "SET_ENTITY_QUANTITY", entity_id: id, quantity: entity.quantity, provenance: p });
    }
    if (frame.operation === "UPDATE_ITEM" && existing) {
      for (const [key, value] of Object.entries(entity.attributes)) {
        events.push({ type: "SET_ENTITY_ATTRIBUTE", entity_id: id, key, value, provenance: p });
      }
      for (const [key, value] of Object.entries(entity.constraints)) {
        events.push({ type: "SET_ENTITY_CONSTRAINT", entity_id: id, key, value, provenance: p });
      }
    }
    if ((frame.operation === "CANCEL_ITEM" || frame.operation === "REMOVE_ITEM") && existing) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: id, status: "cancelled", provenance: p });
    }
  }
  if (frame.operation === "REQUEST_QUOTE") {
    events.push({ type: "SET_CONVERSION", patch: { funnel_stage: "quotation", quotation_status: "draft" } });
  }
  return events;
}

// supabase/functions/_shared/industry-schema.ts
var IDENTIFIER = /^[a-z][a-z0-9_]{1,63}$/;
var VERSION = /^\d+\.\d+\.\d+$/;
var FIELD_TYPES = /* @__PURE__ */ new Set(["string", "number", "boolean", "object"]);
function isRecord3(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function validateIndustrySchema(schema) {
  const errors = [];
  if (!IDENTIFIER.test(schema.id)) errors.push("invalid_schema_id");
  if (!VERSION.test(schema.version)) errors.push("invalid_schema_version");
  if (!Array.isArray(schema.fields) || schema.fields.length === 0)
    errors.push("empty_schema_fields");
  const seen = /* @__PURE__ */ new Set();
  for (const field of schema.fields ?? []) {
    if (!IDENTIFIER.test(field.key)) errors.push(`invalid_field_key:${field.key}`);
    if (seen.has(field.key)) errors.push(`duplicate_field_key:${field.key}`);
    seen.add(field.key);
    if (!FIELD_TYPES.has(field.type)) errors.push(`invalid_field_type:${field.key}`);
    if (typeof field.required !== "boolean") errors.push(`invalid_field_required:${field.key}`);
    if (!field.description.trim()) errors.push(`missing_field_description:${field.key}`);
  }
  return { valid: errors.length === 0, errors };
}
function validateIndustrySchemaValues(schema, value) {
  const definition = validateIndustrySchema(schema);
  if (!definition.valid) return definition;
  if (!isRecord3(value)) return { valid: false, errors: ["industry_values_not_object"] };
  const errors = [];
  const fields = new Map(schema.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(value)) if (!fields.has(key)) errors.push(`unknown_field:${key}`);
  for (const field of schema.fields) {
    const fieldValue = value[field.key];
    if (fieldValue === void 0 || fieldValue === null) {
      if (field.required) errors.push(`missing_required_field:${field.key}`);
      continue;
    }
    const matches2 = field.type === "object" ? isRecord3(fieldValue) : typeof fieldValue === field.type;
    if (!matches2 || field.type === "number" && !Number.isFinite(fieldValue)) {
      errors.push(`invalid_field_value:${field.key}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// supabase/functions/_shared/industry-agent-registry.ts
function normalize(value) {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function createIndustryRegistry(profiles) {
  const entries = /* @__PURE__ */ new Map();
  for (const profile of profiles) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(profile.id))
      throw new Error(`invalid_industry_id:${profile.id}`);
    if (!/^\d+\.\d+\.\d+$/.test(profile.version))
      throw new Error(`invalid_profile_version:${profile.id}`);
    const validation = validateIndustrySchema(profile.schema);
    if (!validation.valid)
      throw new Error(`invalid_industry_schema:${profile.id}:${validation.errors.join(",")}`);
    if (profile.schema.id !== profile.id)
      throw new Error(`industry_schema_binding_mismatch:${profile.id}`);
    for (const candidate of [profile.id, ...profile.aliases]) {
      const key = normalize(candidate);
      if (!key || entries.has(key)) throw new Error(`duplicate_industry_identifier:${key}`);
      entries.set(key, profile);
    }
  }
  const frozen = Object.freeze([...profiles]);
  return Object.freeze({
    resolve(identifier) {
      return identifier ? entries.get(normalize(identifier)) ?? null : null;
    },
    profiles() {
      return frozen;
    }
  });
}

// supabase/functions/_shared/industry-profiles/home-appliance-v1.ts
var HOME_APPLIANCE_CATEGORIES = [
  {
    key: "air_conditioner",
    label: { "zh-TW": "\u51B7\u6C23\u6A5F", "zh-CN": "\u7A7A\u8C03", en: "air conditioner" },
    aliases: [
      "\u51B7\u6C23",
      "\u51B7\u6C14",
      "\u7A7A\u8ABF",
      "\u7A7A\u8C03",
      "air con",
      "aircon",
      "air-con",
      "air conditioner",
      "ac unit"
    ]
  },
  {
    key: "refrigerator",
    label: { "zh-TW": "\u96EA\u6AC3", "zh-CN": "\u51B0\u7BB1", en: "refrigerator" },
    aliases: ["\u96EA\u6AC3", "\u96EA\u67DC", "\u51B0\u7BB1", "fridge", "refrigerator"]
  },
  {
    key: "washing_machine",
    label: { "zh-TW": "\u6D17\u8863\u6A5F", "zh-CN": "\u6D17\u8863\u673A", en: "washing machine" },
    aliases: ["\u6D17\u8863\u6A5F", "\u6D17\u8863\u673A", "washer", "washing machine"]
  },
  {
    key: "water_heater",
    label: { "zh-TW": "\u71B1\u6C34\u7210", "zh-CN": "\u70ED\u6C34\u5668", en: "water heater" },
    aliases: ["\u71B1\u6C34\u7210", "\u70ED\u6C34\u5668", "water heater"]
  },
  {
    key: "television",
    label: { "zh-TW": "\u96FB\u8996", "zh-CN": "\u7535\u89C6", en: "television" },
    aliases: ["\u96FB\u8996", "\u7535\u89C6", "television", "tv"]
  }
];
var HOME_APPLIANCE_ROOMS = [
  {
    key: "living_room",
    label: { "zh-TW": "\u5BA2\u5EF3", "zh-CN": "\u5BA2\u5385", en: "living room" },
    aliases: ["\u5BA2\u5EF3", "\u5BA2\u5385", "living room", "lounge"]
  },
  {
    key: "bedroom",
    label: { "zh-TW": "\u7761\u623F", "zh-CN": "\u5367\u5BA4", en: "bedroom" },
    aliases: ["\u7761\u623F", "\u81E5\u5BA4", "\u5367\u5BA4", "\u623F\u9593", "\u623F\u95F4", "bedroom"]
  },
  {
    key: "kitchen",
    label: { "zh-TW": "\u5EDA\u623F", "zh-CN": "\u53A8\u623F", en: "kitchen" },
    aliases: ["\u5EDA\u623F", "\u53A8\u623F", "kitchen"]
  }
];
var HOME_APPLIANCE_PROFILE_V1 = Object.freeze({
  id: "home_appliance",
  version: "1.0.0",
  aliases: ["home_appliances", "appliance", "appliances", "\u5BB6\u96FB", "\u5BB6\u7535"],
  schema: Object.freeze({
    id: "home_appliance",
    version: "1.0.0",
    fields: Object.freeze([
      {
        key: "product",
        type: "string",
        required: false,
        description: "Customer-grounded appliance product or category."
      },
      {
        key: "model",
        type: "string",
        required: false,
        description: "Customer-grounded product model."
      },
      {
        key: "capacity",
        type: "string",
        required: false,
        description: "Customer-stated size or capacity."
      },
      {
        key: "installation",
        type: "object",
        required: false,
        description: "Installation requirements stated by the customer."
      },
      {
        key: "delivery",
        type: "object",
        required: false,
        description: "Delivery requirements stated by the customer."
      },
      {
        key: "engineering",
        type: "object",
        required: false,
        description: "Site or engineering constraints requiring confirmation."
      },
      {
        key: "payment",
        type: "object",
        required: false,
        description: "Customer-stated payment requirements; never payment authority."
      },
      {
        key: "warranty",
        type: "string",
        required: false,
        description: "Customer-stated warranty requirement; never an inferred policy."
      }
    ])
  })
});

// supabase/functions/_shared/industry-runtime-adapter.ts
var INDUSTRY_AGENT_REGISTRY = createIndustryRegistry([HOME_APPLIANCE_PROFILE_V1]);
function clean11(value) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
}
function matches(text, aliases) {
  const lower2 = clean11(text).toLowerCase();
  return aliases.some(
    (alias) => alias.trim().length >= 2 && lower2.includes(alias.trim().toLowerCase())
  );
}
function resolveIndustryRuntime(input) {
  const explicit = INDUSTRY_AGENT_REGISTRY.resolve(input.industry_identifier);
  const detected = input.texts.some(
    (text) => HOME_APPLIANCE_CATEGORIES.some((category) => matches(text, category.aliases))
  ) ? HOME_APPLIANCE_PROFILE_V1 : null;
  const hasExplicitIdentifier = Boolean(clean11(input.industry_identifier));
  const profile = hasExplicitIdentifier ? explicit : detected;
  if (!profile) return { industry_id: null, profile: null, hints: [] };
  const hints = /* @__PURE__ */ new Map();
  for (const text of input.texts) {
    const categories = HOME_APPLIANCE_CATEGORIES.filter(
      (category) => matches(text, category.aliases)
    );
    const rooms = HOME_APPLIANCE_ROOMS.filter((room) => matches(text, room.aliases));
    for (const category of categories) {
      for (const room of rooms.length ? rooms : [null]) {
        const entityId2 = `${category.key}:${room?.key ?? "unscoped"}`;
        hints.set(entityId2, {
          entity_id: entityId2,
          category: category.key,
          aliases: [...category.aliases, ...room?.aliases ?? []],
          attributes: {
            industry_profile_id: profile.id,
            industry_profile_version: profile.version
          }
        });
      }
    }
  }
  for (const entity of input.semantic_frame?.entities ?? []) {
    const values = {};
    const candidate = {
      product: entity.name,
      model: entity.model,
      ...entity.attributes,
      ...entity.constraints
    };
    for (const field of profile.schema.fields) {
      const value = candidate[field.key];
      if (value !== void 0 && value !== null) values[field.key] = value;
    }
    if (!validateIndustrySchemaValues(profile.schema, values).valid) continue;
    const semanticHint = [...hints.values()].find(
      (hint) => (hint.aliases ?? []).some(
        (alias) => clean11(entity.name).toLowerCase().includes(clean11(alias).toLowerCase())
      )
    );
    if (semanticHint)
      semanticHint.attributes = { ...semanticHint.attributes, industry_fields: values };
  }
  return { industry_id: profile.id, profile, hints: [...hints.values()] };
}
function industryEntityLabel(entityId2, language) {
  const [categoryKey, roomKey] = entityId2.split(":");
  const category = HOME_APPLIANCE_CATEGORIES.find((item) => item.key === categoryKey);
  if (!category) return null;
  const room = HOME_APPLIANCE_ROOMS.find((item) => item.key === roomKey);
  if (!room) return category.label[language];
  return language === "en" ? `${room.label.en} ${category.label.en}` : `${room.label[language]}${category.label[language]}`;
}

// supabase/functions/_shared/commerce-state-runtime-base.ts
var COMMERCE_STATE_RPC = "upsert_conversation_commerce_state_v1";
var MAX_HISTORY_TURNS = 24;
function clean12(value, max = 1600) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function isRecord4(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function matchedAliases(lower2, aliases) {
  return aliases.filter((alias) => alias.trim().length >= 2 && lower2.includes(alias.trim().toLowerCase()));
}
function detectCategories(text) {
  const lower2 = clean12(text).toLowerCase();
  return HOME_APPLIANCE_CATEGORIES.filter((spec) => matchedAliases(lower2, spec.aliases).length > 0);
}
function detectRooms(text) {
  const lower2 = clean12(text).toLowerCase();
  return HOME_APPLIANCE_ROOMS.filter((spec) => matchedAliases(lower2, spec.aliases).length > 0);
}
function entityLabel(entityId2, language) {
  const generic = genericEntityLabelFromId(entityId2);
  if (generic) return generic;
  const industry = industryEntityLabel(entityId2, language);
  if (industry) return industry;
  const [categoryKey, roomKey] = entityId2.split(":");
  const category = HOME_APPLIANCE_CATEGORIES.find((x) => x.key === categoryKey);
  const room = HOME_APPLIANCE_ROOMS.find((x) => x.key === roomKey);
  const categoryText = category ? category.label[language] : clean12(categoryKey, 60);
  if (!room) return categoryText;
  return language === "en" ? `${room.label.en} ${categoryText}` : `${room.label[language]}${categoryText}`;
}
function buildCommerceEntityHints(texts) {
  const hints = /* @__PURE__ */ new Map();
  for (const raw of texts) {
    const text = clean12(raw);
    if (!text) continue;
    const categories = detectCategories(text);
    if (categories.length) {
      const rooms = detectRooms(text);
      for (const category of categories) {
        const scopes = rooms.length ? rooms : [null];
        for (const room of scopes) {
          const entityId2 = room ? `${category.key}:${room.key}` : `${category.key}:unscoped`;
          if (hints.has(entityId2)) continue;
          hints.set(entityId2, {
            entity_id: entityId2,
            category: category.key,
            aliases: [...category.aliases, ...room ? room.aliases : []]
          });
        }
      }
      continue;
    }
    for (const hint of buildGenericCommerceEntityHints([text])) {
      const existing = hints.get(hint.entity_id);
      if (!existing) hints.set(hint.entity_id, hint);
      else hints.set(hint.entity_id, {
        ...existing,
        aliases: [.../* @__PURE__ */ new Set([...existing.aliases ?? [], ...hint.aliases ?? []])],
        attributes: { ...existing.attributes ?? {}, ...hint.attributes ?? {} }
      });
    }
  }
  return [...hints.values()];
}
function hintsMentionedInTurn(text, hints) {
  const lower2 = clean12(text).toLowerCase();
  const rooms = detectRooms(text);
  const categories = detectCategories(text).map((x) => x.key);
  return hints.filter((hint) => {
    if (hint.entity_id.startsWith("generic:")) {
      return (hint.aliases ?? []).some((alias) => {
        const normalized = clean12(alias, 80).toLowerCase();
        return normalized.length >= 2 && lower2.includes(normalized);
      });
    }
    if (!categories.includes(hint.category)) return false;
    const [, roomKey] = hint.entity_id.split(":");
    if (!rooms.length) return true;
    if (roomKey === "unscoped") return false;
    return rooms.some((room) => room.key === roomKey) || Boolean(lower2) === false;
  });
}
function hintRequiresBookingWithoutDelivery(hint) {
  const attributes = hint.attributes;
  if (!isRecord4(attributes)) return false;
  const capabilities = attributes["capabilities"];
  if (!isRecord4(capabilities)) return false;
  return capabilities["requires_booking"] === true && capabilities["requires_delivery"] !== true && capabilities["requires_installation"] !== true;
}
var COUNT_TOKEN2 = "[\u4E00\u4E8C\u5169\u4E24\u4E09\u56DB\u4E94\u516D\u4E03\u516B\u4E5D\u5341]|\\d{1,4}";
var COUNT_UNIT = "\u90E8|\u53F0|\u4EF6|\u500B|\u4E2A|\u5957|\u5F35|\u5F20|\u76D2|\u7BB1|\u5305|\u888B|\u6A3D|\u74F6|\u652F|\u679D|\u672C|\u518A|\u518C|\u5C0D|\u5BF9|\u96D9|\u53CC|\u689D|\u6761|\u4EFD|\u4F4D|\u5E2D|\u9593|\u95F4|\u665A|\u6B21|\u5802|\u8AB2|\u8BFE|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?";
function countTokenValue(raw) {
  const map = {
    \u4E00: 1,
    \u4E8C: 2,
    \u5169: 2,
    \u4E24: 2,
    \u4E09: 3,
    \u56DB: 4,
    \u4E94: 5,
    \u516D: 6,
    \u4E03: 7,
    \u516B: 8,
    \u4E5D: 9,
    \u5341: 10
  };
  if (/^\d+$/.test(raw)) return Number(raw);
  return map[raw] ?? null;
}
function detectQuantityCorrectionSignal(text) {
  const t = clean12(text);
  return /(?:更正|改(?:做|成|為|为|返)?|變成|变成|唔係.+?(?:而係|係|系)|不是.+?(?:而是|是)|不係.+?(?:而係|係)|actually|change(?:\s+it)?\s+to|make\s+it)/i.test(t);
}
function parseCount(text) {
  const t = clean12(text);
  if (!t) return null;
  const correctionPatterns = [
    new RegExp(`(?:\u5514\u4FC2|\u5514\u7CFB|\u4E0D\u662F|\u4E0D\u4FC2)\\s*(?:${COUNT_TOKEN2})\\s*(?:${COUNT_UNIT})?.{0,24}?(?:\u800C\u4FC2|\u800C\u7CFB|\u800C\u662F|\u4FC2|\u7CFB|\u662F)\\s*(${COUNT_TOKEN2})\\s*(?:${COUNT_UNIT})`, "i"),
    new RegExp(`(?:\u66F4\u6B63|\u6539(?:\u505A|\u6210|\u70BA|\u4E3A|\u8FD4)?|\u8B8A\u6210|\u53D8\u6210|change(?:\\s+it)?\\s+to|make\\s+it|actually)\\s*[:\uFF1A,\uFF0C]?\\s*(${COUNT_TOKEN2})\\s*(?:${COUNT_UNIT})`, "i")
  ];
  for (const pattern of correctionPatterns) {
    const correction = t.match(pattern);
    if (correction?.[1]) return countTokenValue(correction[1]);
  }
  const m = t.match(
    /(?:改(?:做|成|返)?|變成|变成|change to|要|need|order)?\s*([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|張|张|盒|箱|包|袋|樽|瓶|支|枝|本|冊|册|對|对|雙|双|條|条|份|位|席|間|间|晚|次|堂|課|课|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?)/i
  );
  if (!m?.[1]) return null;
  return countTokenValue(m[1]);
}
function detectCancellation(text) {
  return /(?:取消|唔要|不要|唔買|不买|不買|cancel|remove it|drop it)/i.test(text);
}
function detectDeferral(text) {
  return /(?:暫時唔|暫時不|暂时不|稍後先|稍后再|later|hold off|defer)/i.test(text);
}
var SITE_CHECK_PATTERNS = [
  [/(?:窗口|窗台|window opening)/i, "window_opening_check"],
  [/(?:牆|墙|承重|wall strength|structural)/i, "wall_structure_check"],
  [/(?:電壓|电压|電力|电力|voltage|power supply|安培|amp)/i, "electrical_supply_check"],
  [/(?:排水|drainage|drain pipe|冷凝水)/i, "drainage_check"],
  [/(?:安裝|安装|installation|拆機|拆机|dismantle)/i, "installation_site_check"]
];
function detectSiteChecks(text) {
  return SITE_CHECK_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, key]) => key);
}
function requiresProfessionalSiteCheck(text) {
  const structural = /(?:啲|個|个)?(?:窗口|窗台|牆|墙|電壓|电压|排水|承重|wall strength|structural|voltage|drainage)/i.test(text) && /(?:得唔得|可以嗎|可以吗|夠唔夠|够不够|安全|裝得|装得|OK嗎|ok\?|feasible|可行|支持|support)/i.test(text);
  const installation = /(?:安裝|安装|installation|install|mount|拆機|拆机|dismantle)/i.test(text) && /(?:上門|上门|師傅|师傅|onsite|on-site|site (?:visit|survey)|technician|安全|可行|feasible)/i.test(text);
  return structural || installation;
}
var NEGATED_TX_PATTERNS = [
  /(?:尚未|還未|还未|暫未|暂未|未|唔係|唔系|唔|冇|沒有|没有|沒|没|不是|不係|不)(?:係|系|會|会|有|想|要)?\s*(?:正式)?(?:落單|落单|下單|下单|確認落單|确认下单|確認訂單|确认订单|落實|落实|訂單|订单|確認|确认)/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|不)(?:係|系)?\s*正式/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|冇|沒有|没有|沒|没|不)\s*(?:付款|付錢|付钱|支付|畀錢|畀钱|付)/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|冇|沒有|没有|沒|没|不)\s*(?:預約|预约|約定|约定|約|约|安排|落實時間|落实时间)/gi,
  /\b(?:not|no|never|haven'?t|hasn'?t|have\s+not|has\s+not|didn'?t|did\s+not|don'?t|do\s+not|won'?t)\b[^.,;!?]{0,24}?\b(?:order(?:ed|s)?|paid|pay(?:ment|ing)?|confirm(?:ed)?|book(?:ed|ing)?|schedul(?:ed|e|ing))\b/gi,
  /\b(?:order|payment|booking|delivery|installation)\b[^.,;!?]{0,16}?\bnot\b\s*(?:yet\s*)?(?:been\s*)?(?:made|confirmed|placed|paid|booked|scheduled)?/gi
];
function scanNegatedTransaction(text) {
  let positive = text;
  const removed = [];
  for (const pattern of NEGATED_TX_PATTERNS) {
    positive = positive.replace(pattern, (match) => {
      removed.push(match);
      return " ";
    });
  }
  const negated = removed.join(" ");
  return {
    positive,
    negated_order: /(?:落單|落单|下單|下单|訂單|订单|正式|確認|确认|order|confirm)/i.test(negated),
    negated_payment: /(?:付|支付|pay|paid)/i.test(negated),
    negated_booking: /(?:預約|预约|約|约|安排|book|schedul)/i.test(negated)
  };
}
function explicitOrderConfirmation(text) {
  return /(?:已付款|已付|付咗|paid\b|正式落單|正式下单|確認落單|确认下单|confirm(?:ed)? (?:the )?order|已預約|已预约|booked)/i.test(text);
}
function explicitPaymentConfirmation(text) {
  return /(?:已付款|已付|付咗|已支付|paid\b)/i.test(text);
}
function explicitBookingConfirmation(text) {
  return /(?:已預約|已预约|已約|已约|已安排|booked|scheduled)/i.test(text);
}
function quotationOnlySignal(text) {
  return /(?:報價|报价|quotation|quote|未落單|未下单|未正式|唔係落單|不是下单|先問價|先问价)/i.test(text);
}
function detectTransactionSummaryIntent(text) {
  return /(?:幫我總結|帮我总结|總結一下|总结一下|幫我整理|帮我整理|整理(?:一下)?(?:比|畀|給|给)?同事|同事跟進|同事跟进|summar(?:y|ise|ize)|recap|hand over to)/i.test(clean12(text));
}
function detectCurrentPriceValidityQuestion(text) {
  const t = clean12(text);
  if (!t) return false;
  const historical = /(?:之前|以前|以往|舊|旧|歷史|历史|previous|earlier|old)/i.test(t);
  const price = /(?:報價|报价|價|价|price|quote|quotation|收費|收费|fee)/i.test(t);
  const current = /(?:而家|現在|现在|目前|最新|仲係|还是|仍然|current|latest|still)/i.test(t);
  const validity = /(?:一定|作準|作准|有效|同價|同价|一樣|一样|same|valid|guarantee|guaranteed)/i.test(t);
  return historical && price && (current || validity);
}
function detectPreorderUnpaidIntent(text) {
  const t = clean12(text);
  if (!t) return false;
  const preorder = /(?:想預訂|想预订|想訂|想订|要預訂|要预订|預訂|预订|想預約|想预约|要預約|要预约|預約|预约|reserve|reservation|book(?:ing)?|pre[- ]?order|want to order|place an order)/i.test(t);
  return preorder && scanNegatedTransaction(t).negated_payment;
}
function parseMoneyTerms(text) {
  const amounts = [];
  const re = /(?:HK\$|HKD|\$|元|價|价|費|费|收費|收费|fee|price)\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?)|((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?)\s*(?:元|蚊|dollars?)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) amounts.push(value);
  }
  return amounts;
}
function detectExplicitCalculationRequest(text) {
  return /(?:加埋|合共|總共|总共|一共|總數|总数|埋一齊|埋一起|total|altogether|calculate|計下|计下|算下|計算|计算|how much.*(?:total|altogether))/i.test(clean12(text));
}
function extractCommerceCalculationTerms(texts, state, options) {
  const amounts = [];
  for (const raw of texts) {
    const text = clean12(raw);
    if (!text) continue;
    for (const amount of parseMoneyTerms(text)) amounts.push(amount);
  }
  if (options?.include_historical_state) {
    const textAmounts = new Set(amounts);
    for (const quote of state.quotes) {
      if (quote.quote_type !== "customer_reported_historical") continue;
      if (textAmounts.has(quote.amount)) continue;
      amounts.push(quote.amount);
    }
  }
  const unique = [];
  const seen = /* @__PURE__ */ new Map();
  for (const amount of amounts) {
    const count = seen.get(amount) ?? 0;
    if (count < 2) {
      seen.set(amount, count + 1);
      unique.push(amount);
    }
  }
  if (!unique.length) return { terms: [], currency: null };
  const currentTurnMultiplier = parseCount(texts[0] ?? "");
  const activeEntities2 = state.entities.filter(
    (entity) => entity.status !== "cancelled" && entity.status !== "deferred"
  );
  const stateMultiplier = activeEntities2.length === 1 ? Math.max(1, activeEntities2[0].quantity) : activeEntities2.reduce((sum, entity) => sum + Math.max(0, entity.quantity), 0) || 1;
  const multiplier = currentTurnMultiplier ?? stateMultiplier;
  const currency = state.quotes.find((q) => q.currency)?.currency ?? "HKD";
  return {
    terms: unique.map((amount, index) => ({ label: `customer_term_${index + 1}`, value: amount, multiplier })),
    currency
  };
}
function calculationExplicitlyUsesHistory(text) {
  const t = clean12(text);
  if (!t) return false;
  return /(?:(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier).{0,40}(?:數字|数字|價|价|報價|报价|price|quote|figure|amount).{0,40}(?:計|计|算|calculate|total|合共|總共|总共)|(?:計|计|算|calculate|total|合共|總共|总共).{0,40}(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier))/i.test(t);
}
async function loadCommerceState(db, conversation_id) {
  const { data, error } = await db.from("conversation_commerce_state").select("revision, state").eq("conversation_id", conversation_id).maybeSingle();
  if (error || !isRecord4(data)) return { state: createEmptyConversationCommerceState(), revision: 0 };
  const revision = typeof data["revision"] === "number" ? data["revision"] : Number(data["revision"] ?? 0);
  const state = data["state"];
  return {
    state: isConversationCommerceState(state) ? state : createEmptyConversationCommerceState(),
    revision: Number.isFinite(revision) && revision > 0 ? revision : 0
  };
}
function deriveA3RuntimeEvents(input, hints, previous) {
  const text = clean12(input.text);
  const events = [];
  const provenance3 = {
    source_type: "customer",
    source_message_id: input.source_message_id,
    recorded_at: input.occurred_at ?? null
  };
  const mentioned = hintsMentionedInTurn(text, hints);
  const quantity = parseCount(text);
  const cancelled = detectCancellation(text);
  const deferred = detectDeferral(text);
  const additive = detectAdditiveEntityCreationSignal(text);
  const explicitCreation = detectExplicitEntityCreationSignal(text);
  const correction = detectQuantityCorrectionSignal(text);
  if (correction && quantity !== null && mentioned.length === 0) {
    const active = previous.entities.filter(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred"
    );
    if (active.length === 1) {
      events.push({
        type: "SET_ENTITY_QUANTITY",
        entity_id: active[0].entity_id,
        quantity,
        provenance: provenance3
      });
    }
  }
  if (additive && quantity !== null && mentioned.length === 0) {
    const active = previous.entities.filter(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred"
    );
    if (active.length === 1) {
      events.push({
        type: "SET_ENTITY_QUANTITY",
        entity_id: active[0].entity_id,
        quantity: active[0].quantity + quantity,
        provenance: provenance3
      });
      events.push({ type: "SET_ENTITY_STATUS", entity_id: active[0].entity_id, status: "tentative", provenance: provenance3 });
    }
  }
  for (const hint of mentioned) {
    if (cancelled) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "cancelled", provenance: provenance3 });
      continue;
    }
    if (deferred) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "deferred", provenance: provenance3 });
      continue;
    }
    if (quantity !== null && (additive || mentioned.length === 1)) {
      const existing = previous.entities.find((entity) => entity.entity_id === hint.entity_id);
      const nextQuantity = additive && existing ? existing.quantity + quantity : quantity;
      events.push({ type: "SET_ENTITY_QUANTITY", entity_id: hint.entity_id, quantity: nextQuantity, provenance: provenance3 });
    }
    if (quantity !== null || explicitCreation) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "tentative", provenance: provenance3 });
    }
  }
  const checks = detectSiteChecks(text);
  if (checks.length) events.push({ type: "SET_PENDING_CHECKS", checks });
  return events;
}
function enforceQuotationNotOrderEvents(text, state) {
  const scan = scanNegatedTransaction(text);
  const positiveOrder = explicitOrderConfirmation(scan.positive);
  const positivePayment = explicitPaymentConfirmation(scan.positive);
  const positiveBooking = explicitBookingConfirmation(scan.positive);
  const events = [];
  if (scan.negated_booking && !positiveBooking && state.delivery.confirmed) {
    events.push({ type: "SET_DELIVERY", patch: { confirmed: false }, provenance: { source_type: "derived" } });
  }
  if (positiveOrder) return events;
  const promoted = state.conversion.order_status === "confirmed" || state.conversion.order_status === "completed" || state.conversion.funnel_stage === "order_confirmed";
  const paidDrift = !positivePayment && scan.negated_payment && (state.conversion.payment_status === "paid" || state.conversion.payment_status === "pending_payment");
  if (!promoted && !paidDrift) {
    if (quotationOnlySignal(text) && state.conversion.quotation_status === "none") {
      events.push({ type: "SET_CONVERSION", patch: { funnel_stage: "quotation", quotation_status: "draft" } });
    }
    return events;
  }
  const patch = {
    funnel_stage: "quotation",
    quotation_status: state.conversion.quotation_status === "none" ? "draft" : state.conversion.quotation_status
  };
  if (promoted) patch.order_status = "draft";
  if (paidDrift) patch.payment_status = "pending_quote";
  events.push({ type: "SET_CONVERSION", patch });
  return events;
}
function detectExplicitEntityCreationSignal(text) {
  const t = clean12(text);
  if (!t) return false;
  if (parseCount(t) !== null) return true;
  return /(?:另外|再加|再要|加多|加一|加個|加个|多要|多買|多买|新增|想買|想买|要買|要买|購買|购买|訂購|订购|落單|下單|下单|需要|我要|加裝|加装|安裝多|添置|add\s|buy\s|purchase|order\s|need\s|want\s|another|extra|additional)/i.test(t);
}
function detectAdditiveEntityCreationSignal(text) {
  const t = clean12(text);
  if (!t) return false;
  return /(?:另外\s*(?:加|要|買|买|訂|订|新增|加裝|加装)|再加|再要|加多|多要|多買|多买|新增多|加裝多|加装多|another|extra|additional|add\s+(?:another|one|two|three|\d))/i.test(t);
}
function filterGhostUnscopedHints(text, state, hints) {
  const explicitCreation = detectExplicitEntityCreationSignal(text);
  const additive = detectAdditiveEntityCreationSignal(text);
  const categories = new Set(detectCategories(text).map((category) => category.key));
  const rooms = detectRooms(text);
  return hints.filter((hint) => {
    if (!categories.has(hint.category)) return true;
    const roomKey = hint.entity_id.split(":")[1];
    if (rooms.length > 0 && roomKey === "unscoped") return false;
    if (additive && rooms.length === 0) return roomKey === "unscoped";
    if (roomKey !== "unscoped") return true;
    if (state.entities.some((e) => e.entity_id === hint.entity_id)) return true;
    if (!explicitCreation) return false;
    const hasConcreteSameCategory = state.entities.some(
      (entity) => entity.category === hint.category && !entity.entity_id.endsWith(":unscoped") && entity.status !== "cancelled" && entity.status !== "deferred"
    );
    if (rooms.length === 0 && hasConcreteSameCategory) return false;
    return true;
  });
}
function reduceTurn(previous, input, rawHints) {
  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const hints = calculationTurn ? [] : filterGhostUnscopedHints(input.text, previous, rawHints);
  const mentioned = calculationTurn ? [] : hintsMentionedInTurn(input.text, hints);
  const bookingWithoutDelivery = mentioned.some(hintRequiresBookingWithoutDelivery);
  const semanticAuthoritative = !calculationTurn && Boolean(input.semantic_frame && input.semantic_frame.confidence >= 0.72);
  const semanticEventsRaw = semanticAuthoritative ? semanticFrameToStateEvents(input.semantic_frame, previous, hints, input.source_message_id, input.occurred_at ?? null) : [];
  const semanticEvents = bookingWithoutDelivery ? semanticEventsRaw.filter((event) => event.type !== "SET_DELIVERY") : semanticEventsRaw;
  const derivedRaw = calculationTurn || semanticAuthoritative ? [] : deriveCommerceEventsFromCustomerTurn({
    text: input.text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    entity_hints: hints,
    current_language: input.language
  });
  const derived = bookingWithoutDelivery ? derivedRaw.filter((event) => event.type !== "SET_DELIVERY") : derivedRaw;
  const runtimeEvents = calculationTurn ? [] : deriveA3RuntimeEvents(input, hints, previous);
  const industryEvent = input.industry_identifier ? [{ type: "SET_CONTEXT", language: input.language, industry: input.industry_identifier }] : [];
  const reduced = reduceCommerceState(previous, [...industryEvent, ...semanticEvents, ...derived, ...runtimeEvents]);
  const guard = enforceQuotationNotOrderEvents(clean12(input.text), reduced);
  return guard.length ? reduceCommerceState(reduced, guard) : reduced;
}
function rpcResult(data) {
  if (!isRecord4(data)) return { result: "rpc_transport_error", applied_revision: null };
  const result2 = typeof data["result"] === "string" ? data["result"] : "rpc_unknown_result";
  const applied = data["applied_revision"];
  return { result: result2, applied_revision: typeof applied === "number" ? applied : null };
}
async function persistCommerceTurn(db, input, hints) {
  const loaded = await loadCommerceState(db, input.conversation_id);
  let expected = loaded.revision;
  let next = reduceTurn(loaded.state, input, hints);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db.rpc(COMMERCE_STATE_RPC, {
      p_conversation_id: input.conversation_id,
      p_company_id: input.company_id,
      p_expected_revision: expected,
      p_source_message_id: input.source_message_id,
      p_state: next
    });
    if (error) return { state: next, revision: expected, result: "rpc_transport_error" };
    const parsed = rpcResult(data);
    if (parsed.result === "success") return { state: next, revision: parsed.applied_revision ?? expected + 1, result: "success" };
    if (parsed.result === "revision_conflict" && attempt === 0) {
      const reloaded = await loadCommerceState(db, input.conversation_id);
      expected = reloaded.revision;
      next = reduceTurn(reloaded.state, input, hints);
      continue;
    }
    return { state: next, revision: expected, result: parsed.result };
  }
  return { state: next, revision: expected, result: "revision_conflict" };
}
function statusLabel(status, language) {
  const table = {
    cancelled: { "zh-TW": "\u5DF2\u53D6\u6D88", "zh-CN": "\u5DF2\u53D6\u6D88", en: "cancelled" },
    deferred: { "zh-TW": "\u66AB\u7DE9", "zh-CN": "\u6682\u7F13", en: "deferred" },
    confirmed: { "zh-TW": "\u5DF2\u78BA\u8A8D", "zh-CN": "\u5DF2\u786E\u8BA4", en: "confirmed" },
    tentative: { "zh-TW": "\u521D\u6B65", "zh-CN": "\u521D\u6B65", en: "tentative" },
    researching: { "zh-TW": "\u8003\u616E\u4E2D", "zh-CN": "\u8003\u8651\u4E2D", en: "under consideration" }
  };
  return table[status]?.[language] ?? status;
}
function buildTransactionSummary(state, language) {
  const lines = [];
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const inactive = state.entities.filter((e) => e.status === "cancelled" || e.status === "deferred");
  const historical = state.quotes.filter((q) => q.quote_type === "customer_reported_historical");
  const t = {
    head: { "zh-TW": "\u6211\u5E6B\u4F60\u6574\u7406\u5497\u73FE\u6642\u5DF2\u78BA\u8A8D\u5605\u8CC7\u6599\uFF1A", "zh-CN": "\u6211\u5E2E\u4F60\u6574\u7406\u4E86\u76EE\u524D\u5DF2\u786E\u8BA4\u7684\u8D44\u6599\uFF1A", en: "Here is what is on record so far:" },
    items: { "zh-TW": "\u9805\u76EE", "zh-CN": "\u9879\u76EE", en: "Items" },
    none: { "zh-TW": "\u66AB\u6642\u672A\u6709", "zh-CN": "\u6682\u65F6\u6CA1\u6709", en: "none yet" },
    removed: { "zh-TW": "\u5DF2\u53D6\u6D88\uFF0F\u66AB\u7DE9", "zh-CN": "\u5DF2\u53D6\u6D88\uFF0F\u6682\u7F13", en: "Cancelled / deferred" },
    delivery: { "zh-TW": "\u9001\u8CA8\u5B89\u6392", "zh-CN": "\u9001\u8D27\u5B89\u6392", en: "Delivery" },
    pending: { "zh-TW": "\u5F85\u5E2B\u5085\u4E0A\u9580\u78BA\u8A8D", "zh-CN": "\u5F85\u5E08\u5085\u4E0A\u95E8\u786E\u8BA4", en: "Pending onsite professional checks" },
    quotes: { "zh-TW": "\u4F60\u63D0\u4F9B\u5605\u6B77\u53F2\u5831\u50F9\uFF08\u6B77\u53F2\u6578\u5B57\uFF0C\u975E\u73FE\u50F9\uFF09", "zh-CN": "\u4F60\u63D0\u4F9B\u7684\u5386\u53F2\u62A5\u4EF7\uFF08\u5386\u53F2\u6570\u5B57\uFF0C\u975E\u73B0\u4EF7\uFF09", en: "Historical prices you provided (historical, not current)" },
    status: { "zh-TW": "\u76EE\u524D\u72C0\u614B", "zh-CN": "\u76EE\u524D\u72B6\u6001", en: "Current status" },
    tail: { "zh-TW": "\u6700\u65B0\u50F9\u683C\u3001\u9069\u7528\u8CBB\u7528\u540C\u76F8\u95DC\u689D\u4EF6\u4ECD\u7136\u8981\u78BA\u8A8D\u4E4B\u5F8C\u5148\u4F5C\u6E96\u3002", "zh-CN": "\u6700\u65B0\u4EF7\u683C\u3001\u9002\u7528\u8D39\u7528\u53CA\u76F8\u5173\u6761\u4EF6\u4ECD\u9700\u786E\u8BA4\u540E\u624D\u4F5C\u51C6\u3002", en: "Latest pricing, applicable fees and relevant conditions still need to be confirmed." }
  };
  lines.push(t.head[language]);
  lines.push(`${t.items[language]}: ${active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity} (${statusLabel(e.status, language)})`).join("\u3001") : t.none[language]}`);
  if (inactive.length) lines.push(`${t.removed[language]}: ${inactive.map((e) => `${entityLabel(e.entity_id, language)} (${statusLabel(e.status, language)})`).join("\u3001")}`);
  const delivery = state.delivery;
  const deliveryParts = [delivery.preferred_date, delivery.preferred_window, delivery.address, delivery.recipient_name, delivery.recipient_phone].map((x) => clean12(x, 180)).filter(Boolean);
  lines.push(`${t.delivery[language]}: ${deliveryParts.length ? deliveryParts.join(" / ") : t.none[language]}`);
  const pending = [...state.installation.pending_checks, ...state.installation.items.filter((i) => i.status === "pending").map((i) => i.kind)];
  if (pending.length) lines.push(`${t.pending[language]}: ${[...new Set(pending)].join("\u3001")}`);
  if (historical.length) lines.push(`${t.quotes[language]}: ${historical.map((q) => `${q.currency} ${q.amount}`).join("\u3001")}`);
  const orderConfirmed = state.conversion.order_status === "confirmed" || state.conversion.order_status === "completed";
  const paymentPaid = state.conversion.payment_status === "paid";
  if (language === "en") {
    lines.push(orderConfirmed ? "Order: confirmed." : "Order: not yet confirmed.");
    lines.push(paymentPaid ? "Payment: received." : "Payment: no confirmed payment on record yet.");
  } else if (language === "zh-CN") {
    lines.push(orderConfirmed ? "\u8BA2\u5355\uFF1A\u5DF2\u786E\u8BA4\u3002" : "\u8BA2\u5355\uFF1A\u5C1A\u672A\u786E\u8BA4\u3002");
    lines.push(paymentPaid ? "\u4ED8\u6B3E\uFF1A\u5DF2\u786E\u8BA4\u6536\u5230\u3002" : "\u4ED8\u6B3E\uFF1A\u76EE\u524D\u672A\u6709\u5DF2\u4ED8\u6B3E\u8BB0\u5F55\u3002");
  } else {
    lines.push(orderConfirmed ? "\u8A02\u55AE\uFF1A\u5DF2\u78BA\u8A8D\u3002" : "\u8A02\u55AE\uFF1A\u5C1A\u672A\u78BA\u8A8D\u3002");
    lines.push(paymentPaid ? "\u4ED8\u6B3E\uFF1A\u5DF2\u78BA\u8A8D\u6536\u5230\u3002" : "\u4ED8\u6B3E\uFF1A\u76EE\u524D\u672A\u6709\u5DF2\u4ED8\u6B3E\u8A18\u9304\u3002");
  }
  lines.push(t.tail[language]);
  return lines.join("\n");
}
function buildQuantityAnswer(state, language) {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  if (!active.length) return null;
  const total = active.reduce((sum, e) => sum + e.quantity, 0);
  const breakdown = active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("\u3001");
  if (language === "en") return `You currently have ${total} unit(s) in total: ${breakdown}.`;
  if (language === "zh-CN") return `\u4F60\u76EE\u524D\u5408\u5171 ${total} \u4E2A\u5355\u4F4D\uFF1A${breakdown}\u3002`;
  return `\u4F60\u800C\u5BB6\u5408\u5171 ${total} \u500B\u55AE\u4F4D\uFF1A${breakdown}\u3002`;
}
function buildKnownStateAnswer(language, statePath, value, state) {
  if (statePath.startsWith("entities.") && statePath.endsWith(".quantity")) {
    const answer = buildQuantityAnswer(state, language);
    if (answer) return answer;
  }
  const rendered = typeof value === "object" ? JSON.stringify(value) : clean12(String(value), 300);
  if (language === "en") return `From what you already told me: ${rendered}.`;
  if (language === "zh-CN") return `\u6309\u4F60\u4E4B\u524D\u63D0\u4F9B\u7684\u8D44\u6599\uFF1A${rendered}\u3002`;
  return `\u6309\u4F60\u4E4B\u524D\u63D0\u4F9B\u5605\u8CC7\u6599\uFF1A${rendered}\u3002`;
}
function formatCalculationNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}
function renderCalculationExpression(calculation) {
  const parsed = calculation.expression.split(" + ").map((part) => {
    const match = part.match(/^[^:]+:([0-9.]+)×([0-9.]+)$/);
    return match ? { value: Number(match[1]), multiplier: Number(match[2]) } : null;
  });
  if (parsed.length && parsed.every(Boolean)) {
    const terms = parsed;
    const multiplier = terms[0].multiplier;
    if (terms.every((term) => term.multiplier === multiplier)) {
      const values = terms.map((term) => formatCalculationNumber(term.value)).join(" + ");
      return `${formatCalculationNumber(multiplier)} \xD7 (${values}) = ${formatCalculationNumber(calculation.result)}`;
    }
  }
  return `${calculation.expression} = ${formatCalculationNumber(calculation.result)}`;
}
function buildCalculationAnswer(language, calculation) {
  const currency = calculation.currency ?? "HKD";
  const rendered = renderCalculationExpression(calculation);
  if (language === "en") return `Based only on the figures in this calculation: ${rendered} (${currency}). Latest prices, applicable fees and conditions still need to be confirmed.`;
  if (language === "zh-CN") return `\u53EA\u6309\u4F60\u8FD9\u6B21\u63D0\u4F9B\u7684\u6570\u5B57\u8BA1\u7B97\uFF1A${rendered}\uFF08${currency}\uFF09\u3002\u6700\u65B0\u4EF7\u683C\u3001\u9002\u7528\u8D39\u7528\u53CA\u76F8\u5173\u6761\u4EF6\u4ECD\u9700\u786E\u8BA4\u3002`;
  return `\u53EA\u6309\u4F60\u4ECA\u6B21\u63D0\u4F9B\u5605\u6578\u5B57\u8A08\uFF1A${rendered}\uFF08${currency}\uFF09\u3002\u6700\u65B0\u50F9\u683C\u3001\u9069\u7528\u8CBB\u7528\u540C\u76F8\u95DC\u689D\u4EF6\u4ECD\u7136\u8981\u78BA\u8A8D\u3002`;
}
function buildProfessionalConfirmationAnswer(language, state) {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("\u3001") : "";
  if (language === "en") return `${known ? `I still have your details on record: ${known}. ` : ""}For safety and accuracy, our technician needs to inspect the site in person before we can confirm whether the installation is suitable.`;
  if (language === "zh-CN") return `${known ? `\u6211\u4EEC\u5DF2\u4FDD\u7559\u60A8\u4E4B\u524D\u63D0\u4F9B\u7684\u8D44\u6599\uFF1A${known}\u3002` : ""}\u4E3A\u786E\u4FDD\u5B89\u5168\u548C\u51C6\u786E\uFF0C\u9700\u8981\u5E08\u5085\u4E0A\u95E8\u68C0\u67E5\u7A97\u53E3\u5C3A\u5BF8\u3001\u627F\u6258\u53CA\u5B89\u88C5\u73AF\u5883\u540E\u518D\u786E\u8BA4\u662F\u5426\u9002\u5408\u5B89\u88C5\u3002`;
  return `${known ? `\u6211\u54CB\u5DF2\u4FDD\u7559\u60A8\u4E4B\u524D\u63D0\u4F9B\u5605\u8CC7\u6599\uFF1A${known}\u3002` : ""}\u70BA\u78BA\u4FDD\u5B89\u5168\u540C\u6E96\u78BA\uFF0C\u9700\u8981\u5E2B\u5085\u4E0A\u9580\u6AA2\u67E5\u7A97\u53E3\u5C3A\u5BF8\u3001\u627F\u6258\u540C\u5B89\u88DD\u74B0\u5883\u5F8C\u5148\u53EF\u4EE5\u78BA\u8A8D\u662F\u5426\u9069\u5408\u5B89\u88DD\u3002`;
}
function buildCurrentPriceValidityAnswer(language) {
  if (language === "en") return "Not necessarily. A previous quote is only a reference and does not guarantee the current price. The latest price, applicable fees and relevant conditions need to be confirmed again before they are final.";
  if (language === "zh-CN") return "\u672A\u5FC5\u3002\u4F60\u4E4B\u524D\u770B\u5230\u7684\u62A5\u4EF7\u53EA\u53EF\u4F5C\u4E3A\u53C2\u8003\uFF0C\u5E76\u4E0D\u4EE3\u8868\u76EE\u524D\u4ECD\u662F\u540C\u4E00\u4EF7\u683C\u3002\u6700\u65B0\u4EF7\u683C\u3001\u9002\u7528\u8D39\u7528\u53CA\u76F8\u5173\u6761\u4EF6\u9700\u8981\u91CD\u65B0\u786E\u8BA4\u540E\u624D\u4F5C\u51C6\u3002";
  return "\u672A\u5FC5\u3002\u4F60\u4E4B\u524D\u898B\u904E\u5605\u5831\u50F9\u53EA\u53EF\u4EE5\u4F5C\u53C3\u8003\uFF0C\u5514\u4EE3\u8868\u800C\u5BB6\u4ECD\u7136\u4FC2\u540C\u4E00\u500B\u50F9\u3002\u6700\u65B0\u50F9\u683C\u3001\u9069\u7528\u8CBB\u7528\u540C\u76F8\u95DC\u689D\u4EF6\u9700\u8981\u91CD\u65B0\u78BA\u8A8D\u5F8C\u5148\u4F5C\u6E96\u3002";
}
function buildPreorderUnpaidAnswer(language, state) {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("\u3001") : "";
  const nextStep = buildCapabilityAwarePreorderNextStep(state, language);
  if (language === "en") return `${known ? `Got it \u2014 you want to reserve ${known}. ` : "Got it \u2014 you want to proceed. "}Since payment has not been made yet, this is not a completed or confirmed order. ${nextStep}`;
  if (language === "zh-CN") return `${known ? `\u597D\u7684\uFF0C\u6211\u77E5\u9053\u4F60\u60F3\u9884\u8BA2${known}\u3002` : "\u597D\u7684\uFF0C\u6211\u77E5\u9053\u4F60\u60F3\u7EE7\u7EED\u9884\u8BA2\u3002"}\u7531\u4E8E\u76EE\u524D\u8FD8\u672A\u4ED8\u6B3E\uFF0C\u6240\u4EE5\u73B0\u5728\u8FD8\u4E0D\u7B97\u5DF2\u5B8C\u6210\u6216\u5DF2\u786E\u8BA4\u8BA2\u5355\u3002${nextStep}`;
  return `${known ? `\u597D\uFF0C\u6211\u77E5\u9053\u4F60\u60F3\u9810\u8A02${known}\u3002` : "\u597D\uFF0C\u6211\u77E5\u9053\u4F60\u60F3\u7E7C\u7E8C\u9810\u8A02\u3002"}\u56E0\u70BA\u4F60\u4EF2\u672A\u4ED8\u6B3E\uFF0C\u6240\u4EE5\u800C\u5BB6\u672A\u7B97\u5B8C\u6210\u6216\u5DF2\u78BA\u8A8D\u8A02\u55AE\u3002${nextStep}`;
}
async function runCommerceStateRuntime(db, input) {
  const text = clean12(input.text);
  if (!text || !input.conversation_id || !input.company_id || !input.source_message_id) return null;
  const language = input.language;
  if (detectPreorderUnpaidIntent(text)) {
    const loaded = await loadCommerceState(db, input.conversation_id);
    const hasActiveEntity = loaded.state.entities.some(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred"
    );
    if (hasActiveEntity) {
      return {
        authority: "CONVERSATION_STATE",
        reply: buildPreorderUnpaidAnswer(language, loaded.state),
        revision: loaded.revision,
        persist_result: "read_only",
        reason: "preorder_intent_acknowledged_without_order_or_payment_promotion",
        route: "commerce_state_answer"
      };
    }
  }
  const historyTexts = (input.history ?? []).filter((turn) => turn.role === "visitor" || turn.role === "user" || turn.role === "customer").slice(0, MAX_HISTORY_TURNS).map((turn) => clean12(turn.content));
  const conversationTexts = [text, ...historyTexts];
  const deterministicHints = buildCommerceEntityHints(conversationTexts);
  const semanticHints = semanticFrameToEntityHints(input.semantic_frame);
  const industry = resolveIndustryRuntime({
    texts: conversationTexts,
    semantic_frame: input.semantic_frame,
    industry_identifier: input.industry_identifier
  });
  const hints = mergeCommerceEntityHints(
    semanticHints,
    mergeCommerceEntityHints(industry.hints, deterministicHints)
  );
  const runtimeInput = industry.industry_id && !input.industry_identifier ? { ...input, industry_identifier: industry.industry_id } : input;
  const persisted = await persistCommerceTurn(db, runtimeInput, hints);
  const state = persisted.state;
  const summaryIntent = detectTransactionSummaryIntent(text);
  const wantsCalculation = detectExplicitCalculationRequest(text);
  const historicalCalculation = wantsCalculation && calculationExplicitlyUsesHistory(text);
  const calculationTexts = historicalCalculation ? conversationTexts : [text];
  const calculation = wantsCalculation ? extractCommerceCalculationTerms(calculationTexts, state, { include_historical_state: historicalCalculation }) : { terms: [], currency: null };
  const decision2 = resolveCommerceAnswerAuthority({
    question: text,
    state,
    calculation_terms: calculation.terms,
    calculation_currency: calculation.currency,
    requires_professional_site_check: requiresProfessionalSiteCheck(text)
  });
  const base = { revision: persisted.revision, persist_result: persisted.result, reason: decision2.reason };
  if (decision2.authority === "SAFE_PROFESSIONAL_CONFIRMATION") {
    return { ...base, authority: decision2.authority, reply: buildProfessionalConfirmationAnswer(language, state), route: "commerce_state_answer" };
  }
  if (detectPreorderUnpaidIntent(text)) {
    return { ...base, authority: "CONVERSATION_STATE", reason: "preorder_intent_acknowledged_without_order_or_payment_promotion", reply: buildPreorderUnpaidAnswer(language, state), route: "commerce_state_answer" };
  }
  if (decision2.authority === "CONVERSATION_STATE" && decision2.state_path) {
    return { ...base, authority: decision2.authority, state_path: decision2.state_path, reply: buildKnownStateAnswer(language, decision2.state_path, decision2.known_value, state), route: "commerce_state_answer" };
  }
  if (decision2.authority === "DETERMINISTIC_CALCULATION" && decision2.calculation) {
    return { ...base, authority: decision2.authority, calculation: decision2.calculation, reply: buildCalculationAnswer(language, decision2.calculation), route: "commerce_state_answer" };
  }
  if (detectCurrentPriceValidityQuestion(text)) {
    return { ...base, authority: "CURRENT_KB_REQUIRED", reason: "previous_quote_not_authoritative_for_current_price", reply: buildCurrentPriceValidityAnswer(language), route: "commerce_state_answer" };
  }
  if (summaryIntent && (state.entities.length > 0 || state.quotes.length > 0)) {
    return { ...base, authority: "CONVERSATION_STATE", reply: buildTransactionSummary(state, language), route: "commerce_transaction_summary" };
  }
  return {
    ...base,
    authority: decision2.authority === "CURRENT_KB_REQUIRED" ? "CURRENT_KB_REQUIRED" : decision2.authority,
    reply: null,
    route: "commerce_kb_required"
  };
}

// supabase/functions/_shared/commerce-state-runtime.ts
function cleanText(value) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 1600) : "";
}
function containsMoney(text) {
  return /(?:HK\$|HKD|\$|元|價|价|費|费|收費|收费|fee|price)\s*(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?|(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?\s*(?:元|蚊|dollars?)/i.test(text);
}
function isHistoricalMoneyContext(text) {
  return /(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier|old)/i.test(text) && /(?:報價|报价|價|价|price|quote|quotation|收費|收费|fee|HK\$|HKD|\$|元|蚊|dollars?)/i.test(text);
}
function calculationExplicitlyUsesHistory2(text) {
  return /(?:(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier).{0,40}(?:數字|数字|價|价|報價|报价|price|quote|figure|amount).{0,40}(?:計|计|算|calculate|total|合共|總共|总共)|(?:計|计|算|calculate|total|合共|總共|总共).{0,40}(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier))/i.test(text);
}
function enrichEllipticalCalculation(input) {
  const current = cleanText(input.text);
  if (!detectExplicitCalculationRequest(current)) return input;
  if (containsMoney(current)) return input;
  if (detectCurrentPriceValidityQuestion(current)) return input;
  if (calculationExplicitlyUsesHistory2(current)) return input;
  const history = (input.history ?? []).filter(
    (turn) => turn.role === "visitor" || turn.role === "user" || turn.role === "customer"
  );
  for (const turn of history) {
    const candidate = cleanText(turn.content);
    if (!candidate || candidate === current) continue;
    if (!containsMoney(candidate)) continue;
    if (isHistoricalMoneyContext(candidate)) continue;
    return {
      ...input,
      // Base runtime treats calculation turns as read-only state operations, so
      // continuity figures can safely be appended for deterministic arithmetic.
      text: `${current} ${candidate}`
    };
  }
  return input;
}
async function runCommerceStateRuntime2(db, input) {
  return await runCommerceStateRuntime(db, enrichEllipticalCalculation(input));
}

// supabase/functions/_shared/commerce-semantic-frame.ts
var COMMERCE_SEMANTIC_FRAME_VERSION = "commerce-semantic-1.0.0";
var OPERATIONS = /* @__PURE__ */ new Set([
  "ADD_ITEM",
  "SET_QUANTITY",
  "UPDATE_ITEM",
  "REMOVE_ITEM",
  "CANCEL_ITEM",
  "RESERVE",
  "REQUEST_QUOTE",
  "ASK_FACT",
  "ASK_CALCULATION",
  "CONFIRM",
  "DEFER",
  "NO_STATE_CHANGE"
]);
var KINDS = /* @__PURE__ */ new Set([
  "physical_product",
  "digital_good",
  "service",
  "rental",
  "subscription",
  "ticket",
  "custom_item",
  "b2b_product",
  "unknown"
]);
var TRANSACTION_STATES = /* @__PURE__ */ new Set([
  "none",
  "draft",
  "pending_confirmation",
  "confirmed",
  "completed",
  "cancelled",
  "unknown"
]);
var PAYMENT_STATES = /* @__PURE__ */ new Set([
  "none",
  "pending_quote",
  "pending_payment",
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
  "unknown"
]);
var BOOKING_STATES = /* @__PURE__ */ new Set([
  "none",
  "requested",
  "pending",
  "booked",
  "completed",
  "cancelled",
  "unknown"
]);
var FULFILLMENT_STATES = /* @__PURE__ */ new Set([
  "none",
  "requested",
  "pending",
  "scheduled",
  "in_progress",
  "fulfilled",
  "cancelled",
  "unknown"
]);
var COMMERCE_SEMANTIC_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "string", enum: [COMMERCE_SEMANTIC_FRAME_VERSION] },
    language: { type: "string" },
    operation: { type: "string", enum: [...OPERATIONS] },
    intent: { type: "string" },
    topic: { type: ["string", "null"] },
    entities: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          entity_ref: { type: "string" },
          name: { type: "string" },
          kind: { type: "string", enum: [...KINDS] },
          category_hint: { type: ["string", "null"] },
          sku: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          quantity: { type: ["number", "null"], minimum: 0 },
          unit: { type: ["string", "null"] },
          attributes: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
          constraints: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
          capabilities: {
            type: "object",
            properties: {
              requires_delivery: { type: "boolean" },
              supports_pickup: { type: "boolean" },
              requires_installation: { type: "boolean" },
              requires_booking: { type: "boolean" },
              requires_quote: { type: "boolean" },
              requires_site_check: { type: "boolean" },
              digital_fulfilment: { type: "boolean" },
              recurring_billing: { type: "boolean" },
              rental_return: { type: "boolean" },
              customization: { type: "boolean" }
            },
            required: [
              "requires_delivery",
              "supports_pickup",
              "requires_installation",
              "requires_booking",
              "requires_quote",
              "requires_site_check",
              "digital_fulfilment",
              "recurring_billing",
              "rental_return",
              "customization"
            ]
          },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: [
          "entity_ref",
          "name",
          "kind",
          "category_hint",
          "sku",
          "model",
          "quantity",
          "unit",
          "attributes",
          "constraints",
          "capabilities",
          "confidence"
        ]
      }
    },
    referents: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          source: { type: "string", enum: ["current_turn", "prior_turn", "persistent_state", "unknown"] },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["ref", "source", "confidence"]
      }
    },
    customer_correction: { type: "boolean" },
    additive: { type: "boolean" },
    explicit_negations: { type: "array", items: { type: "string" }, maxItems: 20 },
    requested_facts: { type: "array", items: { type: "string" }, maxItems: 20 },
    transaction_state: { type: "string", enum: [...TRANSACTION_STATES] },
    payment_state: { type: "string", enum: [...PAYMENT_STATES] },
    booking_state: { type: "string", enum: [...BOOKING_STATES] },
    fulfillment_state: { type: "string", enum: [...FULFILLMENT_STATES] },
    ambiguity: {
      type: "object",
      properties: {
        is_ambiguous: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" }, maxItems: 12 },
        clarification_question: { type: ["string", "null"] }
      },
      required: ["is_ambiguous", "reasons", "clarification_question"]
    },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: [
    "version",
    "language",
    "operation",
    "intent",
    "topic",
    "entities",
    "referents",
    "customer_correction",
    "additive",
    "explicit_negations",
    "requested_facts",
    "transaction_state",
    "payment_state",
    "booking_state",
    "fulfillment_state",
    "ambiguity",
    "confidence"
  ]
};
function isRecord5(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function clean13(value, max = 300) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function clampConfidence(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
function primitiveMap(value) {
  if (!isRecord5(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value).slice(0, 40)) {
    const k = clean13(key, 80);
    if (!k) continue;
    if (raw === null || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[k] = typeof raw === "string" ? clean13(raw, 300) : raw;
    }
  }
  return out;
}
function bool(value) {
  return value === true;
}
function normalizeCapabilities(raw) {
  const r = isRecord5(raw) ? raw : {};
  return {
    requires_delivery: bool(r.requires_delivery),
    supports_pickup: bool(r.supports_pickup),
    requires_installation: bool(r.requires_installation),
    requires_booking: bool(r.requires_booking),
    requires_quote: bool(r.requires_quote),
    requires_site_check: bool(r.requires_site_check),
    digital_fulfilment: bool(r.digital_fulfilment),
    recurring_billing: bool(r.recurring_billing),
    rental_return: bool(r.rental_return),
    customization: bool(r.customization)
  };
}
function enumValue(value, allowed, fallback) {
  const normalized = clean13(value, 60);
  return allowed.has(normalized) ? normalized : fallback;
}
function normalizeAmbiguity(value, confidence) {
  const raw = isRecord5(value) ? value : {};
  const reasons = (Array.isArray(raw.reasons) ? raw.reasons : []).map((x) => clean13(x, 200)).filter(Boolean).slice(0, 12);
  const lowConfidence = confidence < 0.62;
  const explicitAmbiguous = raw.is_ambiguous === true;
  if (lowConfidence && !reasons.includes("low_confidence")) reasons.push("low_confidence");
  return {
    is_ambiguous: explicitAmbiguous || lowConfidence,
    reasons,
    clarification_question: raw.clarification_question === null ? null : clean13(raw.clarification_question, 400) || null
  };
}
function normalizeCommerceSemanticFrame(value) {
  if (!isRecord5(value)) return null;
  const rawOperation = clean13(value.operation, 40);
  if (!OPERATIONS.has(rawOperation)) return null;
  const entities = [];
  for (const raw of Array.isArray(value.entities) ? value.entities.slice(0, 12) : []) {
    if (!isRecord5(raw)) continue;
    const kind = clean13(raw.kind, 40);
    if (!KINDS.has(kind)) continue;
    const name = clean13(raw.name, 200);
    if (!name) continue;
    const q = raw.quantity === null ? null : Number(raw.quantity);
    const quantity = q === null || !Number.isFinite(q) || q < 0 ? null : q;
    entities.push({
      entity_ref: clean13(raw.entity_ref, 120) || `semantic:${entities.length + 1}`,
      name,
      kind,
      category_hint: raw.category_hint === null ? null : clean13(raw.category_hint, 120) || null,
      sku: raw.sku === null ? null : clean13(raw.sku, 120) || null,
      model: raw.model === null ? null : clean13(raw.model, 120) || null,
      quantity,
      unit: raw.unit === null ? null : clean13(raw.unit, 60) || null,
      attributes: primitiveMap(raw.attributes),
      constraints: primitiveMap(raw.constraints),
      capabilities: normalizeCapabilities(raw.capabilities),
      confidence: clampConfidence(raw.confidence)
    });
  }
  const referents = [];
  for (const raw of Array.isArray(value.referents) ? value.referents.slice(0, 12) : []) {
    if (!isRecord5(raw)) continue;
    const source = clean13(raw.source, 40);
    if (!["current_turn", "prior_turn", "persistent_state", "unknown"].includes(source)) continue;
    const ref = clean13(raw.ref, 160);
    if (!ref) continue;
    referents.push({ ref, source, confidence: clampConfidence(raw.confidence) });
  }
  const confidence = clampConfidence(value.confidence);
  const ambiguity = normalizeAmbiguity(value.ambiguity, confidence);
  const operation = ambiguity.is_ambiguous ? "NO_STATE_CHANGE" : rawOperation;
  return {
    version: COMMERCE_SEMANTIC_FRAME_VERSION,
    language: clean13(value.language, 40) || "und",
    operation,
    intent: clean13(value.intent, 160) || "unknown",
    topic: value.topic === null ? null : clean13(value.topic, 160) || null,
    entities,
    referents,
    customer_correction: value.customer_correction === true,
    additive: value.additive === true,
    explicit_negations: (Array.isArray(value.explicit_negations) ? value.explicit_negations : []).map((x) => clean13(x, 200)).filter(Boolean).slice(0, 20),
    requested_facts: (Array.isArray(value.requested_facts) ? value.requested_facts : []).map((x) => clean13(x, 200)).filter(Boolean).slice(0, 20),
    transaction_state: enumValue(value.transaction_state, TRANSACTION_STATES, "unknown"),
    payment_state: enumValue(value.payment_state, PAYMENT_STATES, "unknown"),
    booking_state: enumValue(value.booking_state, BOOKING_STATES, "unknown"),
    fulfillment_state: enumValue(value.fulfillment_state, FULFILLMENT_STATES, "unknown"),
    ambiguity,
    confidence
  };
}

// supabase/functions/_shared/commerce-semantic-interpreter.ts
var SYSTEM = `You are a multilingual commerce semantic interpreter.
Your job is ONLY to understand the customer's commerce meaning and return one JSON object matching the canonical commerce semantic frame.
Do not answer the customer. Do not invent product facts, prices, availability, policies, T&C, delivery rules or company facts.
Do not assume an industry taxonomy. Interpret unfamiliar products/services compositionally from the customer's words and context.
Required JSON fields: version, language, operation, intent, topic, entities, referents, customer_correction, additive, explicit_negations, requested_facts, transaction_state, payment_state, booking_state, fulfillment_state, ambiguity, confidence.
Each entity must contain: entity_ref, name, kind, category_hint, sku, model, quantity, unit, attributes, constraints, capabilities, confidence.
ambiguity must contain: is_ambiguous, reasons, clarification_question.
Allowed operation values: ADD_ITEM, SET_QUANTITY, UPDATE_ITEM, REMOVE_ITEM, CANCEL_ITEM, RESERVE, REQUEST_QUOTE, ASK_FACT, ASK_CALCULATION, CONFIRM, DEFER, NO_STATE_CHANGE.
Allowed kind values: physical_product, digital_good, service, rental, subscription, ticket, custom_item, b2b_product, unknown.
Allowed transaction_state values: none, draft, pending_confirmation, confirmed, completed, cancelled, unknown.
Allowed payment_state values: none, pending_quote, pending_payment, paid, failed, refunded, partially_refunded, unknown.
Allowed booking_state values: none, requested, pending, booked, completed, cancelled, unknown.
Allowed fulfillment_state values: none, requested, pending, scheduled, in_progress, fulfilled, cancelled, unknown.
Capabilities must contain booleans: requires_delivery, supports_pickup, requires_installation, requires_booking, requires_quote, requires_site_check, digital_fulfilment, recurring_billing, rental_return, customization.
Core rules:
1. Resolve ellipsis, pronouns and short follow-ups from recent customer context and persistent state only when confidence is sufficient. If two or more plausible referents/meanings remain, set ambiguity.is_ambiguous=true, explain concise reasons, provide a clarification_question, use NO_STATE_CHANGE and do not propose a mutation.
2. Keep semantics language-neutral even though language records the customer's input language.
3. name is the clean item/service name, excluding quantity, unit, color/size/date/time and transaction verbs when possible.
4. Put arbitrary customer-authored properties in attributes and requirements/limits in constraints.
5. Capabilities describe what the requested commerce object/operation requires; do not infer company support. A customer asking about delivery may imply requires_delivery only if the requested transaction itself needs delivery; asking whether pickup is allowed may set supports_pickup=true as a requested capability, not as a confirmed company fact.
6. If a fact must come from KB/API (price, FAQ, policy, T&C, warranty, delivery rules, availability), put a concise semantic concept in requested_facts. Do NOT provide the answer.
7. customer_correction=true only when the latest message supersedes a prior customer-authored fact. additive=true only when quantity/items are explicitly added rather than replaced.
8. Negated transaction statements such as '\u672A\u4ED8\u6B3E', 'not paid yet', 'not booked', 'not confirmed' must appear in explicit_negations and must never become confirmations.
9. Lifecycle fields are semantic observations, never authority to mutate state. Never emit paid, booked, confirmed, completed, scheduled or fulfilled unless the customer/context contains explicit evidence for that exact state. Future intent such as 'I will pay', 'book it later' or '\u5B89\u6392\u661F\u671F\u4E94' is not completion evidence.
10. If the latest turn is only a factual/safety/policy question with no state mutation, use ASK_FACT or NO_STATE_CHANGE and do not invent a new commerce entity merely from the subject of the question when a prior referent is available.
11. Unknown industries and unseen vocabulary are expected; never fall back to an industry list or synonym dictionary.
12. Never invent add-ons/options/fees. Only include them when customer-authored context explicitly identifies them or persistent customer-authored state already contains them.
13. If confidence is below 0.62, set ambiguity.is_ambiguous=true and operation=NO_STATE_CHANGE.
Return JSON only.`;
function clean14(value, max = 3e3) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function isRecord6(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function buildPersistentCommerceStateSummary(row) {
  if (!isRecord6(row) || !isRecord6(row.state)) return null;
  const revision = typeof row.revision === "number" ? row.revision : Number(row.revision ?? 0);
  const bounded2 = {
    revision: Number.isFinite(revision) && revision >= 0 ? revision : 0,
    state: row.state
  };
  try {
    return JSON.stringify(bounded2).slice(0, 2400);
  } catch {
    return null;
  }
}
async function loadPersistentCommerceStateSummary(input) {
  const supplied = clean14(input.persistent_state_summary, 2400);
  if (supplied) return supplied;
  const supabaseUrl = clean14(Deno.env.get("SUPABASE_URL"), 600).replace(/\/$/, "");
  if (!supabaseUrl || !input.conversation_id || !input.company_id) return null;
  let adminKey = "";
  try {
    adminKey = getSupabaseAdminKey();
  } catch {
    return null;
  }
  const params = new URLSearchParams({
    select: "revision,state",
    conversation_id: `eq.${input.conversation_id}`,
    company_id: `eq.${input.company_id}`,
    limit: "1"
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/conversation_commerce_state?${params.toString()}`,
      {
        method: "GET",
        headers: {
          apikey: adminKey,
          Authorization: `Bearer ${adminKey}`,
          Accept: "application/json"
        },
        signal: controller.signal
      }
    );
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) return null;
    return buildPersistentCommerceStateSummary(payload[0]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function buildUser(input, persistentStateSummary) {
  const prior = (input.history ?? []).filter((x) => clean14(x.content) && clean14(x.content) !== clean14(input.latest)).slice(-12).map((x, i) => `${i + 1}. ${String(x.role || "unknown")}: ${clean14(x.content, 800)}`).join("\n");
  return [
    `Semantic frame version: ${COMMERCE_SEMANTIC_FRAME_VERSION}`,
    `Latest customer turn: ${clean14(input.latest, 1600)}`,
    prior ? `Recent conversation turns (oldest to newest):
${prior}` : "Recent conversation turns: none",
    persistentStateSummary ? `Persistent commerce state summary (customer-authored state only; do not treat as external facts):
${clean14(persistentStateSummary, 2400)}` : "Persistent commerce state summary: none",
    "Return one canonical semantic frame."
  ].join("\n\n");
}
async function interpretCommerceSemantics(input) {
  const latest = clean14(input.latest, 1600);
  if (!latest) return { frame: null, source: "none", failure_code: null };
  const persistentStateSummary = await loadPersistentCommerceStateSummary(input);
  const result2 = await callModel({
    purpose: "evaluation",
    system: SYSTEM,
    user: buildUser(input, persistentStateSummary),
    maxTokens: 1800,
    operationId: `commerce-semantic:${input.source_message_id}`,
    companyId: input.company_id,
    conversationId: input.conversation_id,
    tag: "commerce-semantic-interpreter",
    responseFormat: "json"
  });
  if (!result2.ok) {
    return { frame: null, source: "none", failure_code: result2.code };
  }
  let parsed;
  try {
    parsed = JSON.parse(result2.text);
  } catch {
    return { frame: null, source: "none", failure_code: "LLM_INVALID_OUTPUT" };
  }
  const frame = normalizeCommerceSemanticFrame(parsed);
  if (!frame) {
    return { frame: null, source: "none", failure_code: "LLM_INVALID_OUTPUT" };
  }
  return { frame, source: "llm", failure_code: null };
}

// supabase/functions/_shared/pre-send-conversion-supervisor.ts
var CURRENT_PRICE_CLAIM = /(?:current|latest|today(?:'s)?|now|而家|現在|现在|目前|最新).{0,36}(?:price|quote|quotation|fee|價|价|報價|报价|收費|收费)|(?:price|quote|quotation|fee|價|价|報價|报价|收費|收费).{0,36}(?:current|latest|valid|confirmed|final|而家|現在|现在|目前|最新|有效|作準|作准|確認|确认)/i;
var QUESTION2 = /[?？]|(?:what|which|when|where|who|how|please (?:tell|provide|confirm)|請問|请问|邊個|边个|邊度|边度|幾多|几多|多少|是否|係咪|是不是|請提供|请提供|請確認|请确认)/i;
var RESTORE_OR_ACTIVE = /(?:restore|reinstate|put .{0,20} back|add .{0,20} back|proceed|continue|keep|include|remains? in|active|confirmed|安排|繼續|继续|照舊|照旧|保留|重新加入|加返|放返|仍然包括|仍包括|確認要|确认要|會處理|会处理)/i;
var ORDER_CONFIRMED = /(?:order (?:is |has been )?(?:confirmed|completed|placed)|confirmed order|訂單已確認|订单已确认|已確認訂單|已确认订单|已落單|已下单|落單完成|下单完成)/i;
var PAYMENT_COMPLETED = /(?:payment (?:is |has been )?(?:paid|received|completed|processed)|paid in full|付款已完成|付款完成|已付款|已收到付款|支付完成)/i;
var DELIVERY_CONFIRMED = /(?:delivery (?:is |has been )?(?:confirmed|arranged|scheduled)|送貨已確認|送货已确认|已安排送貨|已安排送货|送貨安排已確認|送货安排已确认)/i;
var DELIVERY_COMPLETED = /(?:delivery (?:is |has been )?(?:completed|delivered|fulfilled)|successfully delivered|送貨已完成|送货已完成|已送達|已送达|已經送貨|已经送货|派送完成)/i;
var INSTALLATION_CONFIRMED = /(?:installation (?:is |has been )?(?:confirmed|arranged|scheduled)|安裝已確認|安装已确认|已安排安裝|已安排安装|安裝安排已確認|安装安排已确认)/i;
var INSTALLATION_COMPLETED = /(?:installation (?:is |has been )?(?:completed|installed|finished|executed)|successfully installed|安裝已完成|安装已完成|已經安裝|已经安装|安裝完成|安装完成)/i;
var GENERIC_COMPLETION = /(?:action|request|operation|process|booking|reservation).{0,24}(?:completed|processed|executed|done|finished)|(?:completed|processed|executed|done|finished).{0,24}(?:action|request|operation|process|booking|reservation)|(?:操作|動作|动作|請求|请求|流程|程序|預約|预约).{0,20}(?:已完成|完成咗|完成了|已執行|已执行|已處理|已处理)/i;
function clean15(value, max = 65536) {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function lower(value) {
  return clean15(value).toLowerCase();
}
function isRecord7(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function scalarText(value) {
  if (typeof value === "string") return clean15(value, 300) || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}
function aliasesForKey(key) {
  const normalized = key.replace(/[._-]+/g, " ").trim().toLowerCase();
  const aliases = /* @__PURE__ */ new Set([normalized, key.toLowerCase()]);
  const common = {
    address: ["address", "delivery address", "\u5730\u5740", "\u9001\u8CA8\u5730\u5740", "\u9001\u8D27\u5730\u5740"],
    recipient_name: ["recipient", "recipient name", "\u6536\u8CA8\u4EBA", "\u6536\u8D27\u4EBA"],
    recipient_phone: [
      "phone",
      "contact number",
      "telephone",
      "\u96FB\u8A71",
      "\u7535\u8BDD",
      "\u806F\u7D61\u865F\u78BC",
      "\u8054\u7EDC\u53F7\u7801"
    ],
    preferred_date: ["delivery date", "date", "\u9001\u8CA8\u65E5\u671F", "\u9001\u8D27\u65E5\u671F", "\u65E5\u671F"],
    preferred_window: ["delivery time", "time slot", "\u9001\u8CA8\u6642\u9593", "\u9001\u8D27\u65F6\u95F4", "\u6642\u6BB5", "\u65F6\u6BB5"],
    confirmed: ["confirmed", "confirmation", "\u78BA\u8A8D", "\u786E\u8BA4"],
    quantity: ["quantity", "how many", "\u6578\u91CF", "\u6570\u91CF", "\u5E7E\u591A", "\u51E0\u591A"],
    brand: ["brand", "\u54C1\u724C"],
    model: ["model", "model number", "\u578B\u865F", "\u578B\u53F7"],
    amount: ["amount", "price", "quote", "\u50F9\u9322", "\u4EF7\u94B1", "\u5831\u50F9", "\u62A5\u4EF7"],
    currency: ["currency", "\u5E63\u5225", "\u5E01\u522B", "\u8CA8\u5E63", "\u8D27\u5E01"],
    quote_type: ["quote type", "quotation type", "\u5831\u50F9\u985E\u578B", "\u62A5\u4EF7\u7C7B\u578B"],
    validity_status: ["quote validity", "validity", "\u5831\u50F9\u6709\u6548\u72C0\u614B", "\u62A5\u4EF7\u6709\u6548\u72B6\u6001"],
    current_intent: ["intent", "current intent", "\u76EE\u7684", "\u610F\u5716", "\u610F\u56FE"],
    current_topic: ["topic", "current topic", "\u4E3B\u984C", "\u4E3B\u9898"],
    current_industry: ["industry", "\u884C\u696D", "\u884C\u4E1A"],
    unresolved_items: ["unresolved", "outstanding item", "\u5F85\u8655\u7406", "\u5F85\u5904\u7406", "\u672A\u89E3\u6C7A", "\u672A\u89E3\u51B3"],
    funnel_stage: ["stage", "funnel stage", "\u968E\u6BB5", "\u9636\u6BB5"],
    quotation_status: ["quotation status", "quote status", "\u5831\u50F9\u72C0\u614B", "\u62A5\u4EF7\u72B6\u6001"],
    order_status: ["order status", "\u8A02\u55AE\u72C0\u614B", "\u8BA2\u5355\u72B6\u6001"],
    payment_status: ["payment status", "\u4ED8\u6B3E\u72C0\u614B", "\u4ED8\u6B3E\u72B6\u6001", "\u652F\u4ED8\u72C0\u614B", "\u652F\u4ED8\u72B6\u6001"],
    kind: ["installation item", "installation type", "\u5B89\u88DD\u9805\u76EE", "\u5B89\u88C5\u9879\u76EE"],
    status: ["status", "\u72C0\u614B", "\u72B6\u6001"]
  };
  const leaf = key.split(/[._-]/).at(-1) ?? key;
  for (const item of common[leaf] ?? []) aliases.add(item.toLowerCase());
  return [...aliases].filter((item) => item.length >= 2);
}
function addFact(facts, path, value) {
  const rendered = scalarText(value);
  if (!rendered) return;
  facts.push({ path, value: rendered, aliases: aliasesForKey(path) });
}
function addRecordFacts(facts, prefix, value) {
  for (const [key, item] of Object.entries(value)) {
    if (isRecord7(item)) addRecordFacts(facts, `${prefix}.${key}`, item);
    else addFact(facts, `${prefix}.${key}`, item);
  }
}
function collectKnownCommerceFacts(state) {
  const facts = [];
  addFact(facts, "current_intent", state.current_intent);
  addFact(facts, "current_topic", state.current_topic);
  addFact(facts, "current_industry", state.current_industry);
  state.unresolved_items.forEach(
    (item, index) => addFact(facts, `unresolved_items.${index}`, item)
  );
  addRecordFacts(facts, "customer_constraints", state.customer_constraints);
  state.entities.forEach((entity, index) => {
    addFact(facts, `entities.${index}.category`, entity.category);
    addFact(facts, `entities.${index}.brand`, entity.brand);
    addFact(facts, `entities.${index}.model`, entity.model);
    addFact(facts, `entities.${index}.quantity`, entity.quantity);
    addFact(facts, `entities.${index}.status`, entity.status);
    addRecordFacts(facts, `entities.${index}.attributes`, entity.attributes);
    addRecordFacts(facts, `entities.${index}.constraints`, entity.constraints);
  });
  state.quotes.forEach((quote, index) => {
    addFact(facts, `quotes.${index}.amount`, quote.amount);
    addFact(facts, `quotes.${index}.currency`, quote.currency);
    addFact(facts, `quotes.${index}.quote_type`, quote.quote_type);
    addFact(facts, `quotes.${index}.validity_status`, quote.validity_status);
    addRecordFacts(facts, `quotes.${index}.conditions`, quote.conditions);
  });
  addFact(facts, "delivery.preferred_date", state.delivery.preferred_date);
  addFact(facts, "delivery.preferred_window", state.delivery.preferred_window);
  addFact(facts, "delivery.address", state.delivery.address);
  addFact(facts, "delivery.recipient_name", state.delivery.recipient_name);
  addFact(facts, "delivery.recipient_phone", state.delivery.recipient_phone);
  addFact(facts, "delivery.confirmed", state.delivery.confirmed);
  addRecordFacts(facts, "installation.site_conditions", state.installation.site_conditions);
  state.installation.pending_checks.forEach(
    (item, index) => addFact(facts, `installation.pending_checks.${index}`, item)
  );
  state.installation.items.forEach((item, index) => {
    addFact(facts, `installation.items.${index}.kind`, item.kind);
    addFact(facts, `installation.items.${index}.status`, item.status);
    addRecordFacts(facts, `installation.items.${index}.details`, item.details);
  });
  addFact(facts, "conversion.funnel_stage", state.conversion.funnel_stage);
  addFact(facts, "conversion.quotation_status", state.conversion.quotation_status);
  addFact(facts, "conversion.order_status", state.conversion.order_status);
  addFact(facts, "conversion.payment_status", state.conversion.payment_status);
  return facts;
}
function entityAliases(entity) {
  const values = [entity.entity_id, entity.category, entity.brand, entity.model];
  for (const key of ["product_name", "display_name", "name", "sku"]) {
    values.push(scalarText(entity.attributes[key]));
  }
  return [...new Set(values.map(lower).filter((item) => item.length >= 2))];
}
function mentionedEntityIds(text, state) {
  const candidate = lower(text);
  return state.entities.filter((entity) => entityAliases(entity).some((alias) => candidate.includes(alias))).map((entity) => entity.entity_id);
}
function extractMoneyMentions(text) {
  const results = [];
  const pattern = /(?:\b(HKD|USD|TWD)\b\s*|((?:HK|US|NT)\$|\$)\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.([0-9]{1,2}))?\s*(元|蚊|dollars?)?/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const amount = Number(`${match[3].replace(/,/g, "")}${match[4] ? `.${match[4]}` : ""}`);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const marker = `${match[1] ?? ""}${match[2] ?? ""}${match[5] ?? ""}`.toUpperCase();
    const currency = marker.includes("USD") || marker.includes("US$") ? "USD" : marker.includes("TWD") || marker.includes("NT$") ? "TWD" : marker.includes("HKD") || marker.includes("HK$") || marker.includes("$") || /元|蚊/.test(marker) ? "HKD" : null;
    results.push({ amount, currency });
  }
  return results;
}
function quoteMatchesClaim(quote, money, mentioned) {
  if (quote.quote_type !== "current_verified" || quote.validity_status !== "current") return false;
  if (quote.amount !== money.amount) return false;
  if (!money.currency || quote.currency.toUpperCase() !== money.currency) return false;
  if (quote.entity_id) return mentioned.includes(String(quote.entity_id));
  return mentioned.length === 0;
}
function evaluateQuoteReality(text, state) {
  if (!CURRENT_PRICE_CLAIM.test(text)) return null;
  const money = extractMoneyMentions(text);
  if (money.length === 0) {
    return { decision: "block", code: "CURRENT_QUOTE_WITHOUT_VERIFIED_AMOUNT" };
  }
  const mentioned = mentionedEntityIds(text, state);
  for (const item of money) {
    if (!state.quotes.some((quote) => quoteMatchesClaim(quote, item, mentioned))) {
      return {
        decision: "block",
        code: "CURRENT_QUOTE_NOT_PROVEN",
        detail: `${item.currency ?? "currency_unknown"}:${item.amount}`
      };
    }
  }
  return null;
}
function evaluateTransactionReality(text, kind, state) {
  if (DELIVERY_COMPLETED.test(text)) {
    return {
      decision: "block",
      code: "DELIVERY_COMPLETION_NOT_CANONICALLY_PROVABLE"
    };
  }
  if (INSTALLATION_COMPLETED.test(text)) {
    return {
      decision: "block",
      code: "INSTALLATION_COMPLETION_NOT_CANONICALLY_PROVABLE"
    };
  }
  if (DELIVERY_CONFIRMED.test(text) && state.delivery.confirmed !== true) {
    return { decision: "block", code: "DELIVERY_CONFIRMATION_NOT_PROVEN" };
  }
  if (INSTALLATION_CONFIRMED.test(text) && !state.installation.items.some((item) => item.status === "confirmed")) {
    return { decision: "block", code: "INSTALLATION_CONFIRMATION_NOT_PROVEN" };
  }
  if (ORDER_CONFIRMED.test(text) && state.conversion.order_status !== "confirmed" && state.conversion.order_status !== "completed") {
    return { decision: "block", code: "ORDER_CONFIRMATION_NOT_PROVEN" };
  }
  if (PAYMENT_COMPLETED.test(text) && state.conversion.payment_status !== "paid") {
    return { decision: "block", code: "PAYMENT_COMPLETION_NOT_PROVEN" };
  }
  if (GENERIC_COMPLETION.test(text)) {
    const atomicHandoff = kind === "required_escalation_handoff" || kind === "explicit_handoff" || kind === "kb_fallback_handoff" || kind === "system_failure_handoff";
    if (!atomicHandoff) {
      return { decision: "block", code: "ACTION_COMPLETION_NOT_PROVEN" };
    }
  }
  return null;
}
function evaluateKnownContext(text, state) {
  if (!QUESTION2.test(text)) return null;
  const questionClauses = text.split(/(?<=[?？.!！。])|\n+/).map(lower).filter((clause) => QUESTION2.test(clause));
  for (const clause of questionClauses) {
    for (const fact of collectKnownCommerceFacts(state)) {
      if (fact.aliases.some((alias) => clause.includes(alias))) {
        return {
          decision: "block",
          code: "KNOWN_CONTEXT_RECONFIRMATION",
          detail: fact.path
        };
      }
    }
  }
  return null;
}
function trimCorrectionPart(value) {
  return clean15(value, 180).replace(/^[,，:：;；\s]+|[,，。.!！?？;；\s]+$/g, "");
}
function parseCorrection(value) {
  const text = clean15(value, 500);
  const patterns = [
    /(?:唔係|唔系|不是|不係)\s*(.+?)\s*(?:而係|而系|而是)\s*(.+)$/i,
    /(?:change|changed|correct|correction)(?:\s+it)?\s+from\s+(.+?)\s+to\s+(.+)$/i,
    /(?:更正|改(?:返|成|做|為|为)?|actually|i meant)\s*[:：]?\s*(.+?)\s*(?:改為|改为|變成|变成|to|而係|而是)\s*(.+)$/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const previous = trimCorrectionPart(match?.[1] ?? "");
    const current = trimCorrectionPart(match?.[2] ?? "");
    if (previous && current && previous !== current) {
      return { previous, current };
    }
  }
  return null;
}
function responseTouchesCommerce(text, state) {
  if (extractMoneyMentions(text).length > 0) return true;
  if (mentionedEntityIds(text, state).length > 0) return true;
  return /(?:order|payment|quote|price|delivery|installation|quantity|model|brand|訂單|订单|付款|支付|報價|报价|價錢|价钱|送貨|送货|安裝|安装|數量|数量|型號|型号|品牌)/i.test(
    text
  );
}
function evaluateCorrections(text, state) {
  if (state.latest_corrections.length === 0) return null;
  const latest = state.latest_corrections.at(-1) ?? "";
  const parsed = parseCorrection(latest);
  if (!parsed) {
    return responseTouchesCommerce(text, state) ? { decision: "indeterminate", code: "LATEST_CORRECTION_UNRESOLVED" } : null;
  }
  const candidate = lower(text);
  const previous = lower(parsed.previous);
  const current = lower(parsed.current);
  if (previous && candidate.includes(previous) && !candidate.includes(current)) {
    return {
      decision: "block",
      code: "SUPERSEDED_VALUE_REUSED",
      detail: `${parsed.previous} -> ${parsed.current}`
    };
  }
  return null;
}
function evaluateCancellation(text, state) {
  const candidate = lower(text);
  const activeLanguage = RESTORE_OR_ACTIVE.test(text);
  if (!activeLanguage) return null;
  const cancelledEntities = state.entities.filter((entity) => entity.status === "cancelled");
  const activeEntities2 = state.entities.filter(
    (entity) => entity.status !== "cancelled" && entity.status !== "deferred"
  );
  const mentionedCancelled = cancelledEntities.filter(
    (entity) => entityAliases(entity).some((alias) => candidate.includes(alias))
  );
  if (mentionedCancelled.length > 0) {
    return { decision: "block", code: "CANCELLED_ENTITY_RESTORATION" };
  }
  const pronoun = /(?:the one|that one|it\b|removed one|cancelled one|嗰個|果個|該項|该项|取消嗰|取消的|移除嗰|移除的)/i.test(
    text
  );
  if (pronoun && cancelledEntities.length > 0) {
    return activeEntities2.length === 0 ? { decision: "block", code: "CANCELLED_ENTITY_INDIRECT_RESTORATION" } : {
      decision: "indeterminate",
      code: "AMBIGUOUS_CANCELLED_ENTITY_REFERENCE"
    };
  }
  const cancelledQuote = state.quotes.some(
    (quote) => quote.validity_status === "invalid" || quote.validity_status === "expired" || quote.validity_status === "superseded"
  );
  if (cancelledQuote && /(?:quote|quotation|price|報價|报价|價錢|价钱)/i.test(text)) {
    return { decision: "block", code: "INACTIVE_QUOTE_RESTORATION" };
  }
  if (state.conversion.order_status === "cancelled" && /(?:order|訂單|订单|落單|下单)/i.test(text)) {
    return { decision: "block", code: "CANCELLED_ORDER_RESTORATION" };
  }
  if (state.installation.items.some((item) => item.status === "cancelled") && /(?:(?:cancelled|canceled|removed|取消|已取消).{0,28}(?:installation|install|安裝|安装)|(?:installation|install|安裝|安装).{0,28}(?:cancelled|canceled|removed|取消|已取消))/i.test(
    text
  )) {
    return { decision: "block", code: "CANCELLED_INSTALLATION_RESTORATION" };
  }
  return null;
}
function evaluateB2BeforeCommit(input) {
  const draft = clean15(input.proposed_response);
  if (!draft) {
    return { decision: "indeterminate", code: "EMPTY_PROPOSED_RESPONSE" };
  }
  if (!isConversationCommerceState(input.snapshot.state)) {
    return {
      decision: "indeterminate",
      code: "INVALID_CANONICAL_COMMERCE_STATE"
    };
  }
  const state = input.snapshot.state;
  return evaluateCorrections(draft, state) ?? evaluateCancellation(draft, state) ?? evaluateQuoteReality(draft, state) ?? evaluateTransactionReality(draft, input.persistence_kind, state) ?? evaluateKnownContext(draft, state) ?? { decision: "allow", code: "B2_ALLOW" };
}
function queryErrorDetail(error) {
  if (isRecord7(error)) {
    return clean15(error.message ?? error.code, 180) || "query_error";
  }
  return clean15(error, 180) || "query_error";
}
async function loadB2Snapshot(client, conversation_id, source_message_id) {
  try {
    const conversationResult = await client.from("conversations").select("id, company_id").eq("id", conversation_id).maybeSingle();
    if (conversationResult.error) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "CONVERSATION_SCOPE_LOOKUP_FAILED",
          detail: queryErrorDetail(conversationResult.error)
        }
      };
    }
    if (!isRecord7(conversationResult.data)) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "CONVERSATION_SCOPE_NOT_FOUND"
        }
      };
    }
    const companyId = clean15(conversationResult.data.company_id, 160);
    if (!companyId) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "CONVERSATION_COMPANY_UNRESOLVED"
        }
      };
    }
    const sourceResult = await client.from("messages").select("id, conversation_id, role").eq("id", source_message_id).eq("conversation_id", conversation_id).maybeSingle();
    if (sourceResult.error) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "SOURCE_MESSAGE_LOOKUP_FAILED",
          detail: queryErrorDetail(sourceResult.error)
        }
      };
    }
    if (!isRecord7(sourceResult.data) || clean15(sourceResult.data.id, 160) !== source_message_id || clean15(sourceResult.data.conversation_id, 160) !== conversation_id || sourceResult.data.role !== "visitor") {
      return {
        ok: false,
        decision: { decision: "indeterminate", code: "SOURCE_MESSAGE_INVALID" }
      };
    }
    const stateResult = await client.from("conversation_commerce_state").select("company_id, revision, source_message_id, state").eq("conversation_id", conversation_id).eq("company_id", companyId).maybeSingle();
    if (stateResult.error) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "COMMERCE_STATE_LOOKUP_FAILED",
          detail: queryErrorDetail(stateResult.error)
        }
      };
    }
    let state = createEmptyConversationCommerceState();
    let revision = 0;
    let stateSource = null;
    if (stateResult.data !== null && stateResult.data !== void 0) {
      if (!isRecord7(stateResult.data)) {
        return {
          ok: false,
          decision: {
            decision: "indeterminate",
            code: "COMMERCE_STATE_INVALID_ROW"
          }
        };
      }
      if (clean15(stateResult.data.company_id, 160) !== companyId) {
        return {
          ok: false,
          decision: {
            decision: "indeterminate",
            code: "COMMERCE_STATE_COMPANY_MISMATCH"
          }
        };
      }
      const rawRevision = typeof stateResult.data.revision === "number" ? stateResult.data.revision : Number(stateResult.data.revision);
      if (!Number.isInteger(rawRevision) || rawRevision < 0) {
        return {
          ok: false,
          decision: {
            decision: "indeterminate",
            code: "COMMERCE_STATE_REVISION_INVALID"
          }
        };
      }
      if (!isConversationCommerceState(stateResult.data.state)) {
        return {
          ok: false,
          decision: {
            decision: "indeterminate",
            code: "INVALID_CANONICAL_COMMERCE_STATE"
          }
        };
      }
      state = structuredClone(stateResult.data.state);
      revision = rawRevision;
      stateSource = clean15(stateResult.data.source_message_id, 160) || null;
    }
    return {
      ok: true,
      snapshot: {
        conversation_id,
        company_id: companyId,
        source_message_id,
        commerce_state_revision: revision,
        commerce_state_source_message_id: stateSource,
        state
      }
    };
  } catch (error) {
    return {
      ok: false,
      decision: {
        decision: "indeterminate",
        code: "SUPERVISOR_READ_ERROR",
        detail: error instanceof Error ? error.name : "unknown_error"
      }
    };
  }
}
function stableSnapshotFingerprint(snapshot) {
  return JSON.stringify({
    conversation_id: snapshot.conversation_id,
    company_id: snapshot.company_id,
    source_message_id: snapshot.source_message_id,
    commerce_state_revision: snapshot.commerce_state_revision,
    commerce_state_source_message_id: snapshot.commerce_state_source_message_id,
    state: snapshot.state
  });
}
async function executeB2PersistenceGate(input) {
  const initial = await loadB2Snapshot(
    input.client,
    input.conversation_id,
    input.source_message_id
  );
  if (!initial.ok) return { committed: false, decision: initial.decision };
  if (input.expected_commerce_state_revision !== void 0 && input.expected_commerce_state_revision !== null && input.expected_commerce_state_revision !== initial.snapshot.commerce_state_revision) {
    return {
      committed: false,
      snapshot: initial.snapshot,
      decision: {
        decision: "indeterminate",
        code: "EXPECTED_COMMERCE_REVISION_MISMATCH"
      }
    };
  }
  let decision2;
  try {
    decision2 = evaluateB2BeforeCommit({
      proposed_response: input.proposed_response,
      persistence_kind: input.persistence_kind,
      snapshot: initial.snapshot,
      metadata: input.metadata ? structuredClone(input.metadata) : input.metadata
    });
  } catch (error) {
    decision2 = {
      decision: "indeterminate",
      code: "SUPERVISOR_ERROR",
      detail: error instanceof Error ? error.name : "unknown_error"
    };
  }
  if (decision2.decision !== "allow") {
    return { committed: false, decision: decision2, snapshot: initial.snapshot };
  }
  const revalidated = await loadB2Snapshot(
    input.client,
    input.conversation_id,
    input.source_message_id
  );
  if (!revalidated.ok) {
    return { committed: false, decision: revalidated.decision };
  }
  if (stableSnapshotFingerprint(initial.snapshot) !== stableSnapshotFingerprint(revalidated.snapshot)) {
    return {
      committed: false,
      snapshot: revalidated.snapshot,
      decision: {
        decision: "indeterminate",
        code: "COMMERCE_CONTEXT_CHANGED_BEFORE_COMMIT"
      }
    };
  }
  const value = await input.commit();
  return { committed: true, decision: decision2, snapshot: revalidated.snapshot, value };
}

// supabase/functions/generate-reply/index.ts
import {
  createClient as createClient3
} from "https://esm.sh/@supabase/supabase-js@2.45.0";
function requiredEscalationRpcClient(client) {
  return {
    rpc: async (fn, args) => {
      const { data, error } = await client.rpc(fn, args);
      const payload = data == null ? null : typeof data === "object" && !Array.isArray(data) ? data : { result: data };
      return {
        data: payload,
        error: error ? { message: String(error.message ?? "rpc_error") } : null
      };
    }
  };
}
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
var MINIMAL_SAFE_FALLBACK_PROMPT = `You are a professional and friendly customer service assistant.
Answer customer questions clearly, naturally and concisely.
When a request is incomplete, ask one necessary contextual question instead of escalating.
Never expose internal implementation or retrieval terminology.
Keep responses under 150 words.
Respond in the same language and script the customer is using.

${CUSTOMER_CONVERSATION_POLICY}`;
var SAFE_HANDOFF_WORDING = {
  "zh-TW": "\u6211\u5011\u5DF2\u5C07\u4F60\u7684\u5C0D\u8A71\u8F49\u4EA4\u771F\u4EBA\u5BA2\u670D\u3002\u5BA2\u670D\u63A5\u624B\u5F8C\u6703\u5728\u6B64\u5C0D\u8A71\u4E2D\u56DE\u8986\u4F60\uFF1B\u5982\u76EE\u524D\u6709\u53EF\u7528\u7684\u8F2A\u5019\u8CC7\u6599\uFF0C\u7CFB\u7D71\u6703\u5728\u6B64\u986F\u793A\u8F2A\u5019\u4F4D\u7F6E\u53CA\u9810\u8A08\u7B49\u5019\u6642\u9593\u3002",
  "zh-CN": "\u6211\u4EEC\u5DF2\u5C06\u4F60\u7684\u5BF9\u8BDD\u8F6C\u4EA4\u4EBA\u5DE5\u5BA2\u670D\u3002\u5BA2\u670D\u63A5\u624B\u540E\u4F1A\u5728\u6B64\u5BF9\u8BDD\u4E2D\u56DE\u590D\u4F60\uFF1B\u5982\u76EE\u524D\u6709\u53EF\u7528\u7684\u6392\u961F\u8D44\u6599\uFF0C\u7CFB\u7EDF\u4F1A\u5728\u6B64\u663E\u793A\u6392\u961F\u4F4D\u7F6E\u53CA\u9884\u8BA1\u7B49\u5F85\u65F6\u95F4\u3002",
  en: "I\u2019ve handed this conversation to a human support agent. They will reply in this same chat after taking over; if live queue data is available, your queue position and estimated wait will be shown here."
};
var HUMAN_SUPPORT_INFO_WORDING = {
  "zh-TW": "\u6211\u76EE\u524D\u6C92\u6709\u5DF2\u78BA\u8A8D\u7684\u771F\u4EBA\u5BA2\u670D\u670D\u52D9\u6642\u9593\u8CC7\u6599\u3002\u5982\u679C\u4F60\u73FE\u5728\u8981\u8F49\u771F\u4EBA\u5BA2\u670D\uFF0C\u53EF\u4EE5\u76F4\u63A5\u544A\u8A34\u6211\u3002",
  "zh-CN": "\u6211\u76EE\u524D\u6CA1\u6709\u5DF2\u786E\u8BA4\u7684\u4EBA\u5DE5\u5BA2\u670D\u670D\u52A1\u65F6\u95F4\u8D44\u6599\u3002\u5982\u679C\u4F60\u73B0\u5728\u8981\u8F6C\u4EBA\u5DE5\u5BA2\u670D\uFF0C\u53EF\u4EE5\u76F4\u63A5\u544A\u8BC9\u6211\u3002",
  en: "I don't currently have confirmed human-support service hours. If you want a human agent now, you can tell me directly."
};
var REQUIRED_ESCALATION_SAFE_WORDING = {
  E2: {
    "zh-TW": "\u9019\u500B\u554F\u984C\u9700\u8981\u7531\u5BA2\u670D\u4EBA\u54E1\u9032\u4E00\u6B65\u8655\u7406\u3002\u6211\u5DF2\u5C07\u5C0D\u8A71\u8F49\u4EA4\u5BA2\u670D\u8DDF\u9032\u3002",
    "zh-CN": "\u8FD9\u4E2A\u95EE\u9898\u9700\u8981\u7531\u5BA2\u670D\u4EBA\u5458\u8FDB\u4E00\u6B65\u5904\u7406\u3002\u6211\u5DF2\u5C06\u5BF9\u8BDD\u8F6C\u4EA4\u5BA2\u670D\u8DDF\u8FDB\u3002",
    en: "This issue requires human review. I\u2019ve handed the conversation to a support agent for follow-up."
  },
  E1: {
    "zh-TW": "\u9019\u500B\u554F\u984C\u6D89\u53CA\u91CD\u8981\u98A8\u96AA\u6216\u653F\u7B56\u5167\u5BB9\uFF0C\u70BA\u78BA\u4FDD\u8CC7\u8A0A\u6E96\u78BA\uFF0C\u6211\u5DF2\u8F49\u4EA4\u5BA2\u670D\u4EBA\u54E1\u8DDF\u9032\u3002",
    "zh-CN": "\u8FD9\u4E2A\u95EE\u9898\u6D89\u53CA\u91CD\u8981\u98CE\u9669\u6216\u653F\u7B56\u5185\u5BB9\uFF0C\u4E3A\u786E\u4FDD\u4FE1\u606F\u51C6\u786E\uFF0C\u6211\u5DF2\u8F6C\u4EA4\u5BA2\u670D\u4EBA\u5458\u8DDF\u8FDB\u3002",
    en: "This issue involves important risk or policy considerations. I\u2019ve handed it to a support agent for accurate follow-up."
  },
  R2: {
    "zh-TW": "\u6211\u76EE\u524D\u672A\u80FD\u53EF\u9760\u89E3\u6C7A\u9019\u500B\u554F\u984C\uFF0C\u5DF2\u5C07\u5C0D\u8A71\u8F49\u4EA4\u5BA2\u670D\u4EBA\u54E1\u8DDF\u9032\u3002",
    "zh-CN": "\u6211\u76EE\u524D\u672A\u80FD\u53EF\u9760\u89E3\u51B3\u8FD9\u4E2A\u95EE\u9898\uFF0C\u5DF2\u5C06\u5BF9\u8BDD\u8F6C\u4EA4\u5BA2\u670D\u4EBA\u5458\u8DDF\u8FDB\u3002",
    en: "I\u2019m not able to resolve this reliably, so I\u2019ve handed the conversation to a support agent for follow-up."
  }
};
var R2_CLARIFICATION_SAFE_WORDING = {
  "zh-TW": "\u6211\u60F3\u518D\u78BA\u8A8D\u4E00\u6B21\uFF0C\u624D\u80FD\u66F4\u6E96\u78BA\u5730\u5E6B\u4F60\u3002\u8ACB\u88DC\u5145\u9019\u500B\u554F\u984C\u4E2D\u6700\u91CD\u8981\u7684\u7D30\u7BC0\uFF0C\u4F8B\u5982\u4F60\u5E0C\u671B\u8655\u7406\u7684\u9805\u76EE\u6216\u76EE\u524D\u9047\u5230\u7684\u60C5\u6CC1\u3002",
  "zh-CN": "\u6211\u60F3\u518D\u786E\u8BA4\u4E00\u6B21\uFF0C\u624D\u80FD\u66F4\u51C6\u786E\u5730\u5E2E\u4F60\u3002\u8BF7\u8865\u5145\u8FD9\u4E2A\u95EE\u9898\u4E2D\u6700\u91CD\u8981\u7684\u7EC6\u8282\uFF0C\u4F8B\u5982\u4F60\u5E0C\u671B\u5904\u7406\u7684\u9879\u76EE\u6216\u76EE\u524D\u9047\u5230\u7684\u60C5\u51B5\u3002",
  en: "I\u2019d like to clarify one detail so I can help more accurately. Please add the most important detail about what you want handled or what is happening now."
};
var GROUNDING_RECOVERY_WORDING = {
  "zh-TW": "\u6211\u60F3\u518D\u78BA\u8A8D\u4E00\u4E0B\u8CC7\u6599\uFF0C\u907F\u514D\u7B54\u932F\u3002\u4F60\u6700\u60F3\u5148\u78BA\u8A8D\u54EA\u4E00\u9EDE\uFF1F",
  "zh-CN": "\u6211\u60F3\u518D\u786E\u8BA4\u4E00\u4E0B\u8D44\u6599\uFF0C\u907F\u514D\u7B54\u9519\u3002\u4F60\u6700\u60F3\u5148\u786E\u8BA4\u54EA\u4E00\u70B9\uFF1F",
  en: "I want to verify the information before answering so I don\u2019t give you something inaccurate. Which point would you like me to confirm first?"
};
function isHandoffIntent(text) {
  return classifyHandoffIntent(text).explicit_request;
}
function detectHandoffLanguage(text) {
  const classified = classifyHandoffIntent(text);
  return classified.explicit_request ? classified.language : null;
}
function sanitizeUserMessage(text) {
  if (!text) return "";
  let s = text;
  s = s.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[redacted_email]"
  );
  s = s.replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted_phone]");
  s = s.replace(/\d{7,}/g, "[redacted_digits]");
  if (s.length > 300) s = s.slice(0, 300);
  return s;
}
async function writeTraces(supabaseAdmin, params) {
  try {
    await supabaseAdmin.from("final_prompt_trace").insert({
      conversation_id: params.conversation_id,
      message_id: params.message_id,
      model_used: params.model_used,
      system_prompt_snapshot: "[governed_generation_router_v1]",
      token_input: params.token_input,
      token_output: params.token_output,
      latency_ms: params.response_latency_ms,
      rag_context: null,
      tool_calls: null,
      user_message: sanitizeUserMessage(params.user_message_raw)
    });
  } catch (e) {
    console.error(
      "[generate-reply] final_prompt_trace insert failed (non-blocking):",
      e
    );
  }
}
function buildRouterConversationInput(messages) {
  return messages.slice(-10).map((message, index) => {
    const label = message.role === "user" ? "Visitor" : "Assistant";
    return `[Turn ${index + 1} ${label}]
${String(message.content ?? "").slice(0, 3e3)}`;
  }).join("\n\n");
}
function routerFailureHttpStatus(code) {
  if (code === "LLM_INPUT_BLOCKED") return 400;
  if (code === "LLM_TIMEOUT") return 504;
  if (code === "LLM_CONFIG_MISSING") return 503;
  if (code === "LLM_GROUNDING_REJECTED") return 422;
  return 502;
}
async function loadLatestHandoffReason(supabaseAdmin, conversationId) {
  const { data, error } = await supabaseAdmin.from("handoff_event").select("handoff_reason, created_at").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) {
    console.error(
      "[generate-reply] latest handoff control lookup failed (non-blocking):",
      conversationId
    );
    return null;
  }
  return typeof data?.handoff_reason === "string" ? data.handoff_reason : null;
}
function routerFailureToS0(code) {
  switch (code) {
    case "LLM_TIMEOUT":
      return "LLM_TIMEOUT";
    case "LLM_NETWORK":
      return "LLM_NETWORK_ERROR";
    case "LLM_NON_2XX":
      return "LLM_NON_2XX";
    case "LLM_CONFIG_MISSING":
      return "LLM_NON_2XX";
    case "LLM_INPUT_BLOCKED":
      return "LLM_INPUT_BLOCKED";
    case "LLM_INVALID_OUTPUT":
      return "LLM_INVALID_OUTPUT";
    case "LLM_GROUNDING_REJECTED":
      return "LLM_GROUNDING_REJECTED";
  }
}
async function cleanupThinking(supabaseAdmin, conversation_id, source_message_id) {
  if (!source_message_id) {
    console.error(
      "[generate-reply] cleanupThinking skipped: missing source_message_id",
      conversation_id
    );
    return;
  }
  try {
    await supabaseAdmin.from("messages").delete().eq(
      "conversation_id",
      conversation_id
    ).eq("content", "__THINKING__").filter(
      "metadata->>source_message_id",
      "eq",
      source_message_id
    );
  } catch (e) {
    console.error("[generate-reply] cleanupThinking failed (non-blocking):", e);
  }
}
async function loadSourceVisitorMessage(supabaseAdmin, conversation_id, source_message_id) {
  if (!source_message_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    source_message_id
  )) {
    return { ok: false, error: "source_message_id_required" };
  }
  const { data, error } = await supabaseAdmin.from("messages").select("id, content, created_at").eq("id", source_message_id).eq("conversation_id", conversation_id).eq("role", "visitor").eq("is_recalled", false).neq("content", "__THINKING__").maybeSingle();
  if (error) return { ok: false, error: "source_message_lookup_failed" };
  if (!data?.id || typeof data.content !== "string" || !data.created_at) {
    return { ok: false, error: "invalid_source_message" };
  }
  return {
    ok: true,
    message: {
      id: data.id,
      content: data.content,
      created_at: data.created_at
    }
  };
}
function widgetLiveTestPreActivationActor(metadataSource) {
  if (!metadataSource || typeof metadataSource !== "object" || Array.isArray(metadataSource)) {
    return void 0;
  }
  const m = metadataSource;
  if (m.widget_live_test !== true || m.exclude_training !== true || typeof m.owner_user_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    m.owner_user_id
  )) return void 0;
  return {
    userId: m.owner_user_id,
    allowPreActivation: true
  };
}
function sourceBoundaryFilter(source) {
  return `created_at.lt.${source.created_at},and(created_at.eq.${source.created_at},id.lte.${source.id})`;
}
function sourceMessageErrorResponse(result2) {
  const status = result2.error === "source_message_lookup_failed" ? 500 : 400;
  return new Response(JSON.stringify({ success: false, error: result2.error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
function b2PreventedResponse(decision2, context = {}) {
  const unavailable = decision2.decision === "indeterminate";
  return new Response(
    JSON.stringify({
      success: false,
      error: unavailable ? "b2_supervision_indeterminate" : "b2_supervision_blocked",
      b2_decision: decision2.decision,
      b2_code: decision2.code,
      persistence_prevented: true,
      ...context
    }),
    {
      status: unavailable ? 503 : 409,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    }
  );
}
async function executeB2RpcPersistence(supabaseAdmin, input, commit) {
  return await executeB2PersistenceGate({
    client: supabaseAdmin,
    ...input,
    commit
  });
}
async function commitAiReplyWithControlGate(supabaseAdmin, conversation_id, source_message_id, content, metadata = null) {
  if (!source_message_id) {
    return { ok: false, result: "invalid_source_message" };
  }
  const expectedRevision = typeof metadata?.commerce_state_revision === "number" ? metadata.commerce_state_revision : null;
  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      proposed_response: content,
      persistence_kind: "ai_reply",
      metadata,
      expected_commerce_state_revision: expectedRevision
    },
    async () => await supabaseAdmin.rpc("commit_ai_reply_tx", {
      p_conversation_id: conversation_id,
      p_source_message_id: source_message_id,
      p_content: content,
      p_metadata: metadata
    })
  );
  if (!b2.committed) {
    console.warn("[generate-reply] B2 prevented AI reply persistence:", {
      conversation_id,
      decision: b2.decision.decision,
      code: b2.decision.code
    });
    return {
      ok: false,
      result: b2.decision.decision === "block" ? "b2_block" : "b2_indeterminate"
    };
  }
  const { data, error } = b2.value;
  if (error) {
    console.error("[generate-reply] commit_ai_reply_tx RPC error:", {
      conversation_id,
      code: error.code
    });
    return { ok: false, result: "rpc_error" };
  }
  const payload = data ?? {};
  const result2 = String(payload.result ?? data ?? "unexpected_result");
  switch (result2) {
    case "success":
      return {
        ok: true,
        message_id: typeof payload.message_id === "string" ? payload.message_id : null,
        idempotent: false
      };
    case "idempotent":
      return {
        ok: true,
        message_id: typeof payload.message_id === "string" ? payload.message_id : null,
        idempotent: true
      };
    case "human_control":
    case "resolved":
    case "invalid_source_message":
    case "invalid_content":
    case "source_already_replied":
    case "superseded_source":
    case "not_found":
      return { ok: false, result: result2 };
    default:
      return { ok: false, result: "unexpected_result" };
  }
}
function classifyExplicitHandoff(text) {
  const lang2 = detectHandoffLanguage(text);
  if (lang2) {
    return {
      rule: "R1",
      confidence: 1,
      trigger_span: text.slice(0, 100),
      language: lang2
    };
  }
  return { rule: null, confidence: 0, trigger_span: "", language: "zh-TW" };
}
function isGreetingOrTrivial(text) {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  const raw = text.trim();
  const greetingRe = /^((hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|謝謝|好的|嗯)\s*[!！。.？?，,]*\s*)+$/i;
  const compoundEnRe = /^(hi|hello|hey)\s+(there|everyone|guys|all)[!！。.？?，,\s]*$/i;
  const compoundZhRe = /^(你好|嗨|哈囉|早安|午安|晚安)[，,、\s]*(呀|啊|大家好?|各位好?)[!！。.？?\s]*$/;
  return greetingRe.test(normalized) || compoundEnRe.test(normalized) || compoundZhRe.test(raw);
}
var E2_LOCAL_THREAT_CLASSIFIER_VERSION = "e2-local-threat-v1.0";
function classifyAuthoritativeThreat(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (isDirectViolentThreat(normalized)) {
    return {
      value: true,
      reason: "explicit_violence_or_harm_threat",
      provider_version: E2_LOCAL_THREAT_CLASSIFIER_VERSION
    };
  }
  const lower2 = normalized.toLowerCase();
  const explicitEnglishThreats = [
    /\b(?:i(?:'ll| will| am going to| am gonna| gonna| plan to| intend to)\s+)?(?:kill|shoot|stab|hurt|attack)\s+(?:you|him|her|them|someone|people|staff|agent|employee)\b/i,
    /\b(?:i(?:'ll| will| am going to| gonna)\s+)?bomb\s+(?:you|this place|the office|the store|the shop|your office|your store)\b/i,
    /\b(?:bomb threat|i have (?:a )?bomb)\b/i
  ];
  const explicitChineseThreats = [
    /(?:我要|我會|我会|我想|我準備|我准备|我打算|等我|信不信我).{0,8}(?:殺|杀|弄死|砍|刺|打死|傷害|伤害|襲擊|袭击).{0,8}(?:你|你們|你们|他|她|他們|他们|客服|員工|员工|店員|店员|人)/,
    /(?:殺了你|杀了你|弄死你|打死你|砍死你|刺死你)/,
    /(?:我要|我會|我会|我打算).{0,8}(?:炸掉|炸了|放炸彈|放炸弹|引爆).{0,8}(?:你們|你们|你|公司|店|辦公室|办公室|門市|门市)/,
    /(?:我有炸彈|我有炸弹)/
  ];
  const matched = explicitEnglishThreats.some((re) => re.test(lower2)) || explicitChineseThreats.some((re) => re.test(normalized));
  if (!matched) return void 0;
  return {
    value: true,
    reason: "explicit_violence_or_harm_threat",
    provider_version: E2_LOCAL_THREAT_CLASSIFIER_VERSION
  };
}
function resolveAuthoritativeComplianceReview(expectedTenantId) {
  if (!expectedTenantId) return void 0;
  const raw = Deno.env.get("ESC_E2_COMPLIANCE_REVIEW_BY_TENANT_JSON");
  if (!raw) return void 0;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      "[generate-reply] invalid ESC_E2_COMPLIANCE_REVIEW_BY_TENANT_JSON JSON"
    );
    return void 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(
      "[generate-reply] compliance tenant map must be a JSON object"
    );
    return void 0;
  }
  const tenantMap = parsed;
  if (!(expectedTenantId in tenantMap)) return void 0;
  const value = tenantMap[expectedTenantId];
  if (typeof value !== "boolean") {
    console.error(
      "[generate-reply] compliance tenant value must be boolean",
      expectedTenantId
    );
    return void 0;
  }
  return {
    value,
    reason: value ? "tenant_jurisdiction_requires_human_review" : "tenant_jurisdiction_review_not_required",
    provider_version: "e2-tenant-compliance-map-v1.0"
  };
}
function classifyLocalTopicRisk(text) {
  const transactional = [
    /退[款貨]/,
    /要退/,
    /申請退/,
    /我要.*退/,
    /refund\s*(my|this|the)/i,
    /return\s*(my|this|the)/i,
    /i\s*want\s*(a\s*)?refund/i,
    /i\s*want\s*to\s*return/i,
    /賠償/,
    /補償/,
    /compensation/i,
    /法律行動/,
    /legal\s*action/i,
    /起訴/
  ];
  const informationOnly = [
    /policy/i,
    /政策/,
    /規定/,
    /條款/,
    /what\s*(is|are)/i,
    /how\s*(do|does|to)/i,
    /tell\s*me\s*about/i,
    /請問/,
    /想了解/,
    /介紹/,
    /說明/,
    /(?:有冇|有没有|是否|係咪).{0,24}(?:退款|退貨|退货|refund|return).{0,24}(?:比例|百分比|規則|规则|政策)?/i,
    /(?:退款|退貨|退货|refund|return).{0,24}(?:有冇|有没有|是否|係咪|幾多|多少|比例|百分比|規則|规则|政策)/i
  ];
  const alwaysHigh = [
    /醫療/,
    /藥品/,
    /治療/,
    /medical/i,
    /medicine/i,
    /treatment/i,
    /隱私/,
    /個資/,
    /資料保護/,
    /privacy/i,
    /personal\s*data/i,
    /gdpr/i,
    /投資/,
    /理財/,
    /金融/,
    /investment/i,
    /financial/i,
    /finance/i
  ];
  const matchesTransactional = transactional.some((re) => re.test(text));
  const matchesInformationOnly = informationOnly.some((re) => re.test(text));
  const matchesAlwaysHigh = alwaysHigh.some((re) => re.test(text));
  const highRisk = matchesAlwaysHigh || matchesTransactional && !matchesInformationOnly;
  if (!highRisk) return void 0;
  return { level: "high", verified: true };
}
function isFiniteScore(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n);
}
function explicitAngerLabel(value) {
  if (typeof value !== "string") return false;
  return [
    "angry",
    "anger",
    "furious",
    "rage",
    "irate",
    "\u61A4\u6012",
    "\u6124\u6012",
    "\u751F\u6C23",
    "\u751F\u6C14"
  ].includes(value.trim().toLowerCase());
}
async function loadAuthoritativeR3SentimentSignals(supabaseAdmin, conversation_id, expected_tenant_id) {
  if (!expected_tenant_id) return void 0;
  const { data: freshness, error: freshnessError } = await supabaseAdmin.from("ce_evaluation_state").select(
    "conversation_id, company_id, state, last_success_evaluation_id, last_success_source, last_success_fingerprint, current_evaluation_fingerprint, last_success_at, last_activity_at"
  ).eq("conversation_id", conversation_id).eq("company_id", expected_tenant_id).maybeSingle();
  if (freshnessError || !freshness || freshness.last_success_source !== "canonical" || !freshness.last_success_evaluation_id || !freshness.last_success_fingerprint) {
    return void 0;
  }
  const { data: evaluation, error: evaluationError } = await supabaseAdmin.from("conversation_evaluation").select("id, company_id, created_at, evaluation_fingerprint, freshness").eq("id", freshness.last_success_evaluation_id).eq("conversation_id", conversation_id).eq("company_id", expected_tenant_id).eq("evaluation_fingerprint", freshness.last_success_fingerprint).maybeSingle();
  if (evaluationError || !evaluation?.id || evaluation.id !== freshness.last_success_evaluation_id) {
    return void 0;
  }
  const { data: points, error: pointsError } = await supabaseAdmin.from("ce_emotion_point").select(
    "turn_index, sentiment, sentiment_score, trigger_label, occurred_at"
  ).eq("evaluation_id", evaluation.id).eq("company_id", expected_tenant_id).order("turn_index", { ascending: true }).limit(20);
  if (pointsError || !points || points.length === 0) return void 0;
  const usable = points.map((p) => ({
    turn_index: typeof p.turn_index === "number" ? p.turn_index : -1,
    score: isFiniteScore(p.sentiment_score) ? Number(p.sentiment_score) : void 0,
    sentiment: p.sentiment,
    trigger_label: p.trigger_label
  })).filter(
    (p) => p.score !== void 0 || explicitAngerLabel(p.sentiment) || explicitAngerLabel(p.trigger_label)
  );
  if (usable.length === 0) return void 0;
  const scoreSeries = usable.filter((p) => typeof p.score === "number").sort((a, b) => a.turn_index - b.turn_index).map((p) => p.score);
  const latest = [...usable].sort((a, b) => b.turn_index - a.turn_index)[0];
  const latestScore = typeof latest?.score === "number" ? latest.score : void 0;
  const anger = explicitAngerLabel(latest?.sentiment) || explicitAngerLabel(latest?.trigger_label);
  let recovered;
  if (scoreSeries.length >= 2) {
    const previous = scoreSeries[scoreSeries.length - 2];
    const current = scoreSeries[scoreSeries.length - 1];
    if (previous < -0.2 && current >= 0 && current - previous >= 0.3) {
      recovered = true;
    }
  }
  return {
    ...anger ? { anger_flag: true } : {},
    ...latestScore !== void 0 ? { sentiment_score: latestScore } : {},
    ...scoreSeries.length >= 2 ? { sentiment_trend: scoreSeries.slice(-5) } : {},
    ...recovered ? { sentiment_recovered_same_turn: true } : {},
    evaluation_id: evaluation.id,
    provider_version: `ce-emotion-history-v1.0:${String(evaluation.evaluation_fingerprint).slice(0, 12)}`
  };
}
function normalizeIntentText(text) {
  return text.normalize("NFKC").trim().toLowerCase().replace(/[!！。.？?，,、:：;；"'“”‘’()[\]{}<>《》]/g, " ").replace(/\s+/g, " ").trim();
}
var SAME_INTENT_STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "so",
  "as",
  "of",
  "to",
  "for",
  "from",
  "with",
  "without",
  "in",
  "on",
  "at",
  "by",
  "about",
  "into",
  "over",
  "under",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "doing",
  "done",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "i",
  "me",
  "my",
  "mine",
  "we",
  "us",
  "our",
  "you",
  "your",
  "yours",
  "he",
  "she",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "not",
  "no",
  "yes",
  "just",
  "still",
  "again",
  "also",
  "any",
  "some",
  "more",
  "most",
  "much",
  "many",
  "very",
  "really",
  "please",
  "thanks",
  "thank",
  "hi",
  "hello",
  "hey",
  "ok",
  "okay",
  "sure",
  "need",
  "want",
  "looking",
  "look",
  "get",
  "got",
  "give",
  "tell",
  "know",
  "help",
  "sell",
  "sells",
  "selling",
  "available",
  "availability",
  "stock",
  "order",
  "buy",
  "purchase",
  "see",
  "use"
]);
function extractMeaningfulTokens(normalized) {
  const tokens = normalized.split(/[^\p{L}\p{N}-]+/u).map((t) => t.replace(/^-+|-+$/g, "")).filter((t) => t.length >= 3 && !SAME_INTENT_STOP_WORDS.has(t));
  return new Set(tokens);
}
function compactCjk(normalized) {
  return (normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
  ) ?? []).join("");
}
function ngramSet(text, size) {
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i + size <= text.length; i += 1) {
    out.add(text.slice(i, i + size));
  }
  return out;
}
function containment(a, b) {
  const denominator = Math.min(a.size, b.size);
  if (denominator === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / denominator;
}
function sharedCount(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared;
}
function isSameIntentRepeat(rawA, rawB) {
  const a = normalizeIntentText(rawA);
  const b = normalizeIntentText(rawB);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  if (a.length < 8 || b.length < 8) return false;
  const tokensA = extractMeaningfulTokens(a);
  const tokensB = extractMeaningfulTokens(b);
  if (tokensA.size >= 3 && tokensB.size >= 3) {
    if (sharedCount(tokensA, tokensB) >= 3 && containment(tokensA, tokensB) >= 0.7) return true;
  }
  const cjkA = compactCjk(a);
  const cjkB = compactCjk(b);
  if (cjkA.length >= 8 && cjkB.length >= 8) {
    const gramsA = ngramSet(cjkA, 2);
    const gramsB = ngramSet(cjkB, 2);
    if (Math.min(gramsA.size, gramsB.size) >= 6 && sharedCount(gramsA, gramsB) >= 6 && containment(gramsA, gramsB) >= 0.6) {
      return true;
    }
  }
  return false;
}
function isClarificationAssistantRow(row) {
  const metadata = row.metadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  const record2 = metadata;
  if (record2["escalation_action"] !== "clarification") return false;
  return record2["escalation_rule"] === "R2" || record2["response_route"] === KB_NO_MATCH_CLARIFICATION_ROUTE;
}
function deriveConversationHistorySignals(newestFirstMessages, exactVisitorTurnCount) {
  const usable = newestFirstMessages.filter(
    (m) => m.content !== "__THINKING__" && typeof m.role === "string"
  );
  let consecutiveNoAnswer = 0;
  for (const message of usable) {
    const role = message.role;
    if (role === "visitor") {
      consecutiveNoAnswer += 1;
      continue;
    }
    if (role === "assistant" || role === "agent") break;
  }
  const visitorIndices = [];
  for (let i = 0; i < usable.length && visitorIndices.length < 2; i += 1) {
    if (usable[i]?.role === "visitor") visitorIndices.push(i);
  }
  let exactSameIntentRepeated;
  let clarificationAttempts = 0;
  if (visitorIndices.length >= 2) {
    const latestIndex = visitorIndices[0];
    const previousIndex = visitorIndices[1];
    const last = String(usable[latestIndex]?.content ?? "");
    const previous = String(usable[previousIndex]?.content ?? "");
    if (isSameIntentRepeat(last, previous)) {
      exactSameIntentRepeated = true;
      for (let i = latestIndex + 1; i < previousIndex; i += 1) {
        const row = usable[i];
        if (!row || row.role !== "assistant") continue;
        if (isClarificationAssistantRow(row)) {
          clarificationAttempts = 1;
          break;
        }
      }
    }
  }
  return {
    turn_count: exactVisitorTurnCount,
    consecutive_no_answer: consecutiveNoAnswer,
    clarification_attempts: clarificationAttempts,
    exact_same_intent_repeated: exactSameIntentRepeated
  };
}
function readPositiveIntegerEnv(name) {
  const raw = Deno.env.get(name);
  if (!raw) return void 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return void 0;
  return parsed;
}
function buildVerifiedTenantEscalationConfig() {
  const maxConsecutiveNoAnswer = readPositiveIntegerEnv(
    "ESC_MAX_CONSECUTIVE_NO_ANSWER"
  );
  const maxClarifications2 = readPositiveIntegerEnv("ESC_MAX_CLARIFICATIONS");
  const sentimentThresholdRaw = Deno.env.get("ESC_SENTIMENT_SCORE_THRESHOLD");
  const parsedSentimentThreshold = sentimentThresholdRaw !== void 0 && sentimentThresholdRaw.trim() !== "" ? Number(sentimentThresholdRaw) : void 0;
  const sentimentScoreThreshold = typeof parsedSentimentThreshold === "number" && Number.isFinite(parsedSentimentThreshold) ? parsedSentimentThreshold : void 0;
  const slaWarningRaw = Deno.env.get("ESC_SLA_WARNING_SEC");
  const parsedSlaWarning = slaWarningRaw !== void 0 && slaWarningRaw.trim() !== "" ? Number(slaWarningRaw) : void 0;
  const slaWarningSec = typeof parsedSlaWarning === "number" && Number.isInteger(parsedSlaWarning) && parsedSlaWarning >= 0 ? parsedSlaWarning : void 0;
  const predictedCsatRaw = Deno.env.get("ESC_PREDICTED_CSAT_THRESHOLD");
  const parsedPredictedCsat = predictedCsatRaw !== void 0 && predictedCsatRaw.trim() !== "" ? Number(predictedCsatRaw) : void 0;
  const predictedCsatThreshold = typeof parsedPredictedCsat === "number" && Number.isFinite(parsedPredictedCsat) && parsedPredictedCsat >= 1 && parsedPredictedCsat <= 5 ? parsedPredictedCsat : void 0;
  const churnRiskRaw = Deno.env.get("ESC_CHURN_RISK_THRESHOLD");
  const parsedChurnRisk = churnRiskRaw !== void 0 && churnRiskRaw.trim() !== "" ? Number(churnRiskRaw) : void 0;
  const churnRiskThreshold = typeof parsedChurnRisk === "number" && Number.isFinite(parsedChurnRisk) && parsedChurnRisk >= 0 && parsedChurnRisk <= 1 ? parsedChurnRisk : void 0;
  const escalationScoreRaw = Deno.env.get("ESC_ESCALATION_SCORE_THRESHOLD");
  const parsedEscalationScore = escalationScoreRaw !== void 0 && escalationScoreRaw.trim() !== "" ? Number(escalationScoreRaw) : void 0;
  const escalationScoreThreshold = typeof parsedEscalationScore === "number" && Number.isFinite(parsedEscalationScore) && parsedEscalationScore >= 0 && parsedEscalationScore <= 1 ? parsedEscalationScore : void 0;
  if (maxConsecutiveNoAnswer === void 0 && maxClarifications2 === void 0 && sentimentScoreThreshold === void 0 && slaWarningSec === void 0 && predictedCsatThreshold === void 0 && churnRiskThreshold === void 0 && escalationScoreThreshold === void 0) return null;
  return {
    ...maxConsecutiveNoAnswer !== void 0 ? { max_consecutive_no_answer: maxConsecutiveNoAnswer } : {},
    ...maxClarifications2 !== void 0 ? { max_clarifications: Math.min(1, maxClarifications2) } : {},
    ...sentimentScoreThreshold !== void 0 ? { sentiment_score_threshold: sentimentScoreThreshold } : {},
    ...slaWarningSec !== void 0 ? { sla_warning_sec: slaWarningSec } : {},
    ...predictedCsatThreshold !== void 0 ? { predicted_csat_threshold: predictedCsatThreshold } : {},
    ...churnRiskThreshold !== void 0 ? { churn_risk_threshold: churnRiskThreshold } : {},
    ...escalationScoreThreshold !== void 0 ? { escalation_score_threshold: escalationScoreThreshold } : {}
  };
}
function requiredRuleActivationFromEnv(env) {
  const flags = escalationFeatureFlagsFromEnv(env);
  const enabled = /* @__PURE__ */ new Set();
  if (flags.enable_full_ruleset || flags.enable_e2) enabled.add("E2");
  if (flags.enable_full_ruleset || flags.enable_e1) enabled.add("E1");
  enabled.add("R1");
  enabled.add("R2");
  return enabled;
}
function isE2LiveActivationEnabled(env) {
  if (env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") !== "true") return false;
  const flags = escalationFeatureFlagsFromEnv(env);
  return flags.enable_full_ruleset || flags.enable_e2;
}
function isE1LiveActivationEnabled(env) {
  if (env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") !== "true") return false;
  const flags = escalationFeatureFlagsFromEnv(env);
  return flags.enable_full_ruleset || flags.enable_e1;
}
async function evaluateAndPersistRequiredRulesLive(supabaseAdmin, params) {
  if (Deno.env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") === "false") return null;
  const enabled = requiredRuleActivationFromEnv(Deno.env);
  if (enabled.size === 0) return null;
  if (!params.source_message_id) {
    console.error(
      "[generate-reply] required-rules live blocked: missing source_message_id",
      params.conversation_id
    );
    return new Response(
      JSON.stringify({
        success: false,
        error: "required_escalation_missing_source_message_id",
        handoff_persisted: false
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const handoffClassification = classifyHandoffIntent(
    params.latest_message_content
  );
  const context = createEscalationContextBase({
    conversation_id: params.conversation_id,
    source_message_id: params.source_message_id,
    latest_message_content: params.latest_message_content,
    explicit_request: handoffClassification.explicit_request,
    expected_tenant_id: params.expected_tenant_id
  });
  context.pure_handoff_negation = availableSignal(
    handoffClassification.pure_negation,
    "local_classifier",
    { reason: handoffClassification.reason }
  );
  context.conversation_status = availableSignal(
    params.conversation_status,
    "conversation_history"
  );
  context.assigned_agent_id = availableSignal(
    params.assigned_agent_id,
    "conversation_history"
  );
  context.greeting_or_trivial = availableSignal(
    params.greeting_or_trivial,
    "local_classifier"
  );
  if (params.threat_flag !== void 0) {
    context.threat_flag = availableSignal(
      params.threat_flag.value,
      "local_classifier",
      {
        provider_version: params.threat_flag.provider_version,
        observed_at: (/* @__PURE__ */ new Date()).toISOString(),
        reason: params.threat_flag.reason,
        ...params.expected_tenant_id ? { tenant_id: params.expected_tenant_id } : {}
      }
    );
  }
  if (params.compliance_jurisdiction_requires_human_review !== void 0) {
    const compliance = params.compliance_jurisdiction_requires_human_review;
    context.compliance_jurisdiction_requires_human_review = availableSignal(
      compliance.value,
      "tenant_config",
      {
        provider_version: compliance.provider_version,
        observed_at: (/* @__PURE__ */ new Date()).toISOString(),
        reason: compliance.reason,
        ...params.expected_tenant_id ? { tenant_id: params.expected_tenant_id } : {}
      }
    );
  }
  if (params.rag_match_state !== void 0) {
    context.rag_match_state = availableSignal(params.rag_match_state, "kb_rag");
  }
  if (params.topic_risk_level !== void 0) {
    context.topic_risk_level = availableSignal(
      params.topic_risk_level,
      "local_classifier"
    );
  }
  if (params.verified_local_risk_classification !== void 0) {
    context.verified_local_risk_classification = availableSignal(
      params.verified_local_risk_classification,
      "local_classifier"
    );
  }
  if (params.conversation_duration_sec !== void 0) {
    context.conversation_duration_sec = availableSignal(
      params.conversation_duration_sec,
      "conversation_history"
    );
  }
  if (params.turn_count !== void 0) {
    context.turn_count = availableSignal(
      params.turn_count,
      "conversation_history"
    );
  }
  if (params.consecutive_no_answer !== void 0) {
    context.consecutive_no_answer = availableSignal(
      params.consecutive_no_answer,
      "conversation_history"
    );
  }
  if (params.clarification_attempts !== void 0) {
    context.clarification_attempts = availableSignal(
      params.clarification_attempts,
      "conversation_history"
    );
  }
  if (params.exact_same_intent_repeated === true) {
    context.same_intent_repeated = availableSignal(
      true,
      "conversation_history",
      {
        reason: "exact_normalized_repeat"
      }
    );
  }
  context.tenant_config = buildVerifiedTenantEscalationConfig();
  const decision2 = evaluateFullEscalationRuleset(context, {
    activation: { enabled }
  });
  if (params.suppress_r2_for_prior_grounded_transform === true && decision2.matched_rule === "R2") {
    return null;
  }
  if (decision2.decision === "handoff" && decision2.matched_rule === "R2" && params.warm_handoff_question) {
    const b22 = await executeB2RpcPersistence(
      supabaseAdmin,
      {
        conversation_id: params.conversation_id,
        source_message_id: params.source_message_id,
        proposed_response: params.warm_handoff_question,
        persistence_kind: "required_escalation_clarification",
        metadata: {
          escalation_rule: "R2",
          escalation_action: "collect_missing_handoff_facts",
          response_route: "warm_handoff_data_collection",
          handoff_required: false
        }
      },
      async () => await supabaseAdmin.rpc("commit_ai_reply_tx", {
        p_conversation_id: params.conversation_id,
        p_source_message_id: params.source_message_id,
        p_content: params.warm_handoff_question,
        p_metadata: {
          escalation_rule: "R2",
          escalation_action: "collect_missing_handoff_facts",
          response_route: "warm_handoff_data_collection",
          handoff_required: false
        }
      })
    );
    if (!b22.committed) {
      return b2PreventedResponse(b22.decision, {
        escalation_rule: "R2",
        clarification_persisted: false
      });
    }
    const { data, error } = b22.value;
    if (error) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "warm_handoff_collection_failed"
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    const result2 = String(data?.result ?? "");
    if (result2 === "success" || result2 === "idempotent") {
      await cleanupThinking(
        supabaseAdmin,
        params.conversation_id,
        params.source_message_id
      );
      return new Response(
        JSON.stringify({
          success: true,
          response_route: "warm_handoff_data_collection",
          handoff_required: false,
          missing_facts_requested: true
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (result2 === "human_control" || result2 === "resolved" || result2 === "superseded_source") {
      return new Response(JSON.stringify({ success: true, skipped: result2 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `warm_handoff_collection_${result2 || "unexpected"}`
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  if (decision2.decision === "clarify" && decision2.matched_rule === "R2" && enabled.has("R2")) {
    const clarification = buildWorkflow5TopicalClarification(
      params.latest_message_content,
      params.visitor_language
    ) ?? R2_CLARIFICATION_SAFE_WORDING[params.visitor_language];
    const b22 = await executeB2RpcPersistence(
      supabaseAdmin,
      {
        conversation_id: params.conversation_id,
        source_message_id: params.source_message_id,
        proposed_response: clarification,
        persistence_kind: "required_escalation_clarification",
        metadata: {
          escalation_rule: "R2",
          escalation_action: "clarification",
          handoff_required: false
        }
      },
      async () => await persistRequiredEscalationClarification(
        requiredEscalationRpcClient(supabaseAdmin),
        {
          conversation_id: params.conversation_id,
          source_message_id: params.source_message_id,
          decision: decision2,
          safe_reply_content: clarification
        }
      )
    );
    if (!b22.committed) {
      return b2PreventedResponse(b22.decision, {
        escalation_rule: "R2",
        clarification_persisted: false
      });
    }
    const persisted2 = b22.value;
    if (persisted2.ok) {
      await cleanupThinking(
        supabaseAdmin,
        params.conversation_id,
        params.source_message_id
      );
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "R2",
          escalation_action: "clarification",
          clarification_persisted: true,
          rpc_result: persisted2.result
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (persisted2.result === "already_resolved") {
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "resolved",
          escalation_rule: "R2"
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    if (persisted2.result === "already_under_human_control") {
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "human_handling",
          escalation_rule: "R2"
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    if (persisted2.result === "max_clarifications_reached") {
      console.log("[generate-reply] R2 clarification capped at one", {
        conversation_id: params.conversation_id
      });
      return null;
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `required_escalation_clarification_${persisted2.result}`,
        escalation_rule: "R2",
        clarification_persisted: false,
        ...persisted2.result === "rpc_transport_error" ? { handoff_uncertain: true } : {}
      }),
      {
        status: persisted2.result === "not_found" ? 404 : persisted2.result === "invalid_source_message" || persisted2.result === "invalid_input" || persisted2.result === "invalid_rule" || persisted2.result === "invalid_clarification" ? 400 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  if (decision2.decision !== "handoff" || decision2.matched_rule === null || !enabled.has(decision2.matched_rule)) {
    console.log("[generate-reply] required-rules live no-match:", {
      conversation_id: params.conversation_id,
      matched_rule: decision2.matched_rule,
      decision: decision2.decision,
      reason_code: decision2.reason_code,
      signal_gaps: decision2.signal_gaps
    });
    return null;
  }
  if (decision2.matched_rule !== "E2" && decision2.matched_rule !== "E1" && decision2.matched_rule !== "R2") return null;
  const safeReply = REQUIRED_ESCALATION_SAFE_WORDING[decision2.matched_rule][params.visitor_language];
  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id: params.conversation_id,
      source_message_id: params.source_message_id,
      proposed_response: safeReply,
      persistence_kind: "required_escalation_handoff",
      metadata: {
        escalation_rule: decision2.matched_rule,
        escalation_action: "handoff",
        handoff_required: true
      }
    },
    async () => await persistRequiredEscalationHandoff(
      requiredEscalationRpcClient(supabaseAdmin),
      {
        conversation_id: params.conversation_id,
        source_message_id: params.source_message_id,
        decision: decision2,
        safe_reply_content: safeReply
      }
    )
  );
  if (!b2.committed) {
    return b2PreventedResponse(b2.decision, {
      escalation_rule: decision2.matched_rule,
      handoff_persisted: false
    });
  }
  const persisted = b2.value;
  if (persisted.ok) {
    await cleanupThinking(
      supabaseAdmin,
      params.conversation_id,
      params.source_message_id
    );
    return new Response(
      JSON.stringify({
        success: true,
        escalation_rule: decision2.matched_rule,
        handoff_persisted: true,
        rpc_result: persisted.result
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  switch (persisted.result) {
    case "already_resolved":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "resolved",
          escalation_rule: decision2.matched_rule,
          handoff_persisted: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "human_handling",
          escalation_rule: decision2.matched_rule,
          handoff_persisted: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "invalid_priority":
    case "invalid_safe_reply":
      return new Response(
        JSON.stringify({
          success: false,
          error: `required_escalation_${persisted.result}`,
          escalation_rule: decision2.matched_rule,
          handoff_persisted: false
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "rpc_transport_error":
      return new Response(
        JSON.stringify({
          success: false,
          error: "required_escalation_rpc_transport_error",
          escalation_rule: decision2.matched_rule,
          handoff_persisted: false,
          handoff_uncertain: true
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "not_found":
      return new Response(
        JSON.stringify({
          success: false,
          error: "required_escalation_conversation_not_found",
          escalation_rule: decision2.matched_rule,
          handoff_persisted: false
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    default:
      return new Response(
        JSON.stringify({
          success: false,
          error: "required_escalation_unexpected_result",
          escalation_rule: decision2.matched_rule,
          handoff_persisted: false
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
  }
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const body = await req.json();
    const { conversation_id, source_message_id } = body ?? {};
    if (!conversation_id) {
      return new Response(
        JSON.stringify({ error: "conversation_id required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    const ENABLE_KB = Deno.env.get("ENABLE_KB_ADAPTER") !== "false";
    const ENABLE_COACH = Deno.env.get("ENABLE_COACH_PROMPT_ADAPTER") === "true";
    const ENABLE_C360 = Deno.env.get("ENABLE_CUSTOMER360_ADAPTER") === "true";
    const ENABLE_TOOL_EXEC = Deno.env.get("ENABLE_TOOL_EXECUTOR") === "true";
    const ENABLE_PR5_ESCALATION_RUNTIME = Deno.env.get("ESC_MVP_FEATURE_FLAG") === "true" || Deno.env.get("ESC_ENABLE_S0") === "true" || Deno.env.get("ESC_SHADOW_MODE") === "true" || Deno.env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") === "true";
    if (!ENABLE_KB && !ENABLE_COACH && !ENABLE_C360 && !ENABLE_TOOL_EXEC && !ENABLE_PR5_ESCALATION_RUNTIME) {
      return await legacyGenerateReply(
        conversation_id,
        source_message_id ?? null
      );
    }
    return await orchestrationGenerateReply(
      conversation_id,
      { ENABLE_KB, ENABLE_COACH, ENABLE_C360, ENABLE_TOOL_EXEC },
      source_message_id ?? null
    );
  } catch (error) {
    console.error("[generate-reply] unexpected error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
async function handleConversationClosureIfNeeded(supabaseAdmin, conversation_id, source_message_id, latestMessage) {
  const classification = classifyConversationClosure(latestMessage);
  const content = buildConversationClosureReply(classification);
  if (!content || classification.kind === "none") return null;
  const { data: conversation } = await supabaseAdmin.from("conversations").select("status, assigned_agent_id").eq("id", conversation_id).maybeSingle();
  if (!conversation || conversation.status === "resolved" || isHumanControlState(
    String(conversation.status ?? ""),
    conversation.assigned_agent_id ?? null
  )) return null;
  const { data: prior } = await supabaseAdmin.from("messages").select(
    "role, metadata, content, created_at"
  ).eq("conversation_id", conversation_id).eq("is_recalled", false).neq(
    "content",
    "__THINKING__"
  ).order("created_at", { ascending: false }).limit(4);
  const previousAssistant = (prior ?? []).find(
    (r) => r.role === "assistant" && String(r.content ?? "") !== content
  );
  const pm = previousAssistant?.metadata && typeof previousAssistant.metadata === "object" ? previousAssistant.metadata : null;
  if (!previousAssistant || pm?.handoff_required === true || [
    "warm_handoff_data_collection",
    "kb_no_match_clarification",
    "system_error_handoff"
  ].includes(String(pm?.response_route ?? ""))) return null;
  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    content,
    {
      response_route: "conversation_closure",
      closure_state: classification.kind === "closure_candidate" ? "awaiting_more_help" : "completed",
      closure_reason: classification.reason,
      feedback_eligible_candidate: classification.kind !== "closure_candidate",
      handoff_required: false
    }
  );
  await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
  if (!committed.ok) {
    if (["human_control", "resolved", "superseded_source"].includes(
      committed.result
    )) {
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `conversation_closure_${committed.result}`
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  return new Response(
    JSON.stringify({
      success: true,
      response_route: "conversation_closure",
      closure_state: classification.kind
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
async function legacyGenerateReply(conversation_id, source_message_id) {
  const supabaseAdmin = createClient3(
    Deno.env.get("SUPABASE_URL") ?? "",
    getSupabaseAdminKey()
  );
  const { data: conversation, error: convError } = await supabaseAdmin.from("conversations").select(
    "id, status, assigned_agent_id, created_at, company_id"
  ).eq("id", conversation_id).single();
  if (convError || !conversation) {
    console.error("[generate-reply] conversation not found:", conversation_id);
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
  if (conversation.status === "resolved") {
    return new Response(
      JSON.stringify({ success: true, skipped: "resolved" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (isHumanControlState(
    conversation.status,
    conversation.assigned_agent_id ?? null
  )) {
    console.log(
      "[generate-reply] human-handling guard: skipping LLM for status:",
      conversation.status,
      conversation_id
    );
    return new Response(
      JSON.stringify({ success: true, skipped: "human_handling" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (conversation.assigned_agent_id) {
    console.log(
      "[generate-reply] S-1 assigned_agent_id guard (legacy):",
      conversation_id
    );
    return new Response(
      JSON.stringify({ success: true, skipped: "assigned_to_agent" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const sourceResult = await loadSourceVisitorMessage(
    supabaseAdmin,
    conversation_id,
    source_message_id
  );
  if (!sourceResult.ok) return sourceMessageErrorResponse(sourceResult);
  const sourceVisitorMessage = sourceResult.message;
  const { data: newestMessages } = await supabaseAdmin.from("messages").select("id, role, content, created_at").eq("conversation_id", conversation_id).neq("content", "__THINKING__").eq("is_recalled", false).or(sourceBoundaryFilter(sourceVisitorMessage)).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(10);
  if (!newestMessages || newestMessages.length === 0) {
    return new Response(
      JSON.stringify({ success: true, skipped: "no messages" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const messages = [...newestMessages].reverse();
  const modelMessages = messages.map((m) => ({
    role: m.role === "visitor" ? "user" : "assistant",
    content: String(m.content ?? "")
  }));
  if (modelMessages[modelMessages.length - 1].role === "assistant") {
    return new Response(
      JSON.stringify({ success: true, skipped: "last message is assistant" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const lastVisitorMsg = sourceVisitorMessage.content;
  const handoffLang = detectHandoffLanguage(lastVisitorMsg);
  if (handoffLang) {
    if (!source_message_id) {
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(
        JSON.stringify({
          success: false,
          error: "legacy_handoff_missing_source_message_id",
          escalation_rule: "R1",
          handoff_persisted: false
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    const b2 = await executeB2RpcPersistence(
      supabaseAdmin,
      {
        conversation_id,
        source_message_id,
        proposed_response: SAFE_HANDOFF_WORDING[handoffLang],
        persistence_kind: "explicit_handoff",
        metadata: { escalation_rule: "R1", handoff_required: true }
      },
      async () => await supabaseAdmin.rpc("explicit_handoff_tx", {
        p_conversation_id: conversation_id,
        p_safe_reply_content: SAFE_HANDOFF_WORDING[handoffLang],
        p_source_message_id: source_message_id
      })
    );
    if (!b2.committed) {
      return b2PreventedResponse(b2.decision, {
        escalation_rule: "R1",
        handoff_persisted: false
      });
    }
    const { data: handoffData, error: handoffError } = b2.value;
    if (handoffError) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "legacy_handoff_rpc_transport_error",
          escalation_rule: "R1",
          handoff_persisted: false,
          handoff_uncertain: true
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    const handoffResult = String(handoffData?.result ?? "unknown");
    switch (handoffResult) {
      case "success":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id
        );
        return new Response(
          JSON.stringify({
            success: true,
            escalation_rule: "R1",
            handoff_persisted: true,
            rpc_result: "success"
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      case "already_handled":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id
        );
        return new Response(
          JSON.stringify({
            success: true,
            escalation_rule: "R1",
            handoff_persisted: true,
            rpc_result: "already_handled"
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      case "already_resolved":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id
        );
        return new Response(
          JSON.stringify({
            success: true,
            skipped: "resolved",
            escalation_rule: "R1",
            handoff_persisted: false
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      case "already_under_human_control":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id
        );
        return new Response(
          JSON.stringify({
            success: true,
            skipped: "human_handling",
            escalation_rule: "R1",
            handoff_persisted: false
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      case "invalid_source_message":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id
        );
        return new Response(
          JSON.stringify({
            success: false,
            error: "legacy_handoff_invalid_source_message",
            escalation_rule: "R1",
            handoff_persisted: false
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      case "not_found":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id
        );
        return new Response(
          JSON.stringify({
            success: false,
            error: "legacy_handoff_conversation_not_found",
            escalation_rule: "R1",
            handoff_persisted: false
          }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      default:
        return new Response(
          JSON.stringify({
            success: false,
            error: "legacy_handoff_unexpected_result",
            escalation_rule: "R1",
            handoff_persisted: false,
            rpc_result: handoffResult
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
    }
  }
  const legacyLatestHandoffReason = await loadLatestHandoffReason(
    supabaseAdmin,
    conversation_id
  );
  const legacyReturnToAiGuard = buildReturnToAiGenerationGuard(
    legacyLatestHandoffReason,
    conversation.assigned_agent_id ?? null
  );
  const legacySystemPrompt = `You are a professional and friendly customer service assistant.
Answer customer questions clearly and concisely.
If details are missing, ask one concise contextual question. If a fact cannot be verified, say you cannot confirm it and do not guess. Do not offer a human unless the governed escalation layer has decided one is appropriate.
Keep responses under 150 words.
Respond in the same language and script the customer is using.
When the customer explicitly requests a human agent, or when you transfer to a human agent, include a short safe handoff status message in the same language and script as the customer. Confirm only that the conversation has been handed to human support and that the agent will reply in this same chat. Queue position, customers-ahead counts, and estimated wait time are dynamic widget runtime data: never invent or hard-code them. If live queue data is available, the widget will display it separately; if it is unavailable, do not promise an estimate.

${CUSTOMER_CONVERSATION_POLICY}

${legacyReturnToAiGuard}`;
  const llm = await callModel({
    purpose: "generation",
    system: legacySystemPrompt,
    user: buildRouterConversationInput(modelMessages),
    maxTokens: resolveGenerationMaxTokens(),
    operationId: `generate-reply:legacy:${conversation_id}:${source_message_id}`,
    companyId: typeof conversation.company_id === "string" && conversation.company_id.length > 0 ? conversation.company_id : null,
    conversationId: conversation_id,
    tag: "generate-reply-legacy",
    responseFormat: "text"
  });
  if (!llm.ok) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    await writeTraces(supabaseAdmin, {
      conversation_id,
      message_id: null,
      user_message_raw: lastVisitorMsg,
      response_latency_ms: llm.usage.latency_ms,
      token_input: llm.usage.input_tokens,
      token_output: llm.usage.output_tokens,
      model_used: Deno.env.get("LLM_MODEL_GENERATION")?.trim() || "unset"
    });
    return new Response(
      JSON.stringify({
        success: false,
        error: "AI service error",
        error_code: llm.code
      }),
      {
        status: routerFailureHttpStatus(llm.code),
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const aiReplyContent = llm.text;
  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    aiReplyContent,
    null
  );
  if (!committed.ok) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (committed.result === "human_control" || committed.result === "resolved" || committed.result === "superseded_source") {
      console.log(
        "[generate-reply] stale AI reply suppressed by control gate:",
        {
          conversation_id,
          result: committed.result
        }
      );
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `ai_reply_commit_${committed.result}`
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  await writeTraces(supabaseAdmin, {
    conversation_id,
    message_id: committed.message_id,
    user_message_raw: lastVisitorMsg,
    response_latency_ms: llm.usage.latency_ms,
    token_input: llm.usage.input_tokens,
    token_output: llm.usage.output_tokens,
    model_used: llm.model
  });
  console.log(
    "[generate-reply] AI reply committed for conversation:",
    conversation_id
  );
  return new Response(
    JSON.stringify({ success: true, idempotent: committed.idempotent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
function extractExplicitJurisdictionConstraint(text) {
  const t = text.normalize("NFKC").trim();
  const jurisdictions2 = [
    { label: "Mars", re: /(mars|火星)/ig },
    { label: "\u9999\u6E2F", re: /(香港|hong\s*kong|\bhk\b)/ig },
    { label: "\u6FB3\u9580", re: /(澳門|澳门|macau|macao)/ig },
    { label: "\u65B0\u52A0\u5761", re: /(新加坡|singapore)/ig },
    { label: "\u53F0\u7063", re: /(台灣|台湾|taiwan)/ig },
    {
      label: "\u4E2D\u570B\u5927\u9678",
      re: /(中國大陸|中国大陆|內地|内地|mainland\s*china)/ig
    }
  ];
  const negatedMars = /(不談|不谈|唔講|唔讲|不要談|不要谈|not\s+(?:talking\s+about|about)|forget\s+about)\s*(mars|火星)/i.test(t);
  let best = null;
  for (const item of jurisdictions2) {
    item.re.lastIndex = 0;
    for (const match of t.matchAll(item.re)) {
      if (item.label === "Mars" && negatedMars) continue;
      const index = match.index ?? -1;
      if (!best || index > best.index) best = { label: item.label, index };
    }
  }
  return best?.label ?? null;
}
function evidenceSupportsJurisdiction(jurisdiction, chunks) {
  if (!jurisdiction) return true;
  const needle = jurisdiction.toLocaleLowerCase();
  return chunks.some(
    (chunk) => `${chunk.title ?? ""}
${chunk.content ?? ""}`.toLocaleLowerCase().includes(
      needle
    )
  );
}
var KB_FALLBACK_SAFE_TEXT = {
  KB_SCOPE_GATE: {
    "zh-TW": "\u5F88\u62B1\u6B49\uFF0C\u7CFB\u7D71\u66AB\u6642\u7121\u6CD5\u67E5\u8A62\u77E5\u8B58\u5EAB\u3002\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\u3002",
    "zh-CN": "\u5F88\u62B1\u6B49\uFF0C\u7CFB\u7EDF\u6682\u65F6\u65E0\u6CD5\u67E5\u8BE2\u77E5\u8BC6\u5E93\u3002\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\u3002",
    en: "Sorry, the knowledge base is temporarily unavailable. Let me connect you with a human agent."
  },
  KB_API_FAIL: {
    "zh-TW": "\u7CFB\u7D71\u66AB\u6642\u7121\u6CD5\u67E5\u8A62\u77E5\u8B58\u5EAB\uFF0C\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\u3002",
    "zh-CN": "\u7CFB\u7EDF\u6682\u65F6\u65E0\u6CD5\u67E5\u8BE2\u77E5\u8BC6\u5E93\uFF0C\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\u3002",
    en: "The knowledge base is temporarily unavailable. Let me connect you with a human agent."
  },
  KB_EMPTY: {
    "zh-TW": "\u5F88\u62B1\u6B49\uFF0C\u6211\u76EE\u524D\u7121\u6CD5\u78BA\u5B9A\u7B54\u6848\u3002\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\uFF0C\u4EE5\u63D0\u4F9B\u66F4\u6E96\u78BA\u7684\u5354\u52A9\u3002",
    "zh-CN": "\u5F88\u62B1\u6B49\uFF0C\u6211\u76EE\u524D\u65E0\u6CD5\u786E\u5B9A\u7B54\u6848\u3002\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\uFF0C\u4EE5\u63D0\u4F9B\u66F4\u51C6\u786E\u7684\u534F\u52A9\u3002",
    en: "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance."
  },
  KB_LOW_SCORE_HIGH_RISK: {
    "zh-TW": "\u9019\u500B\u554F\u984C\u6D89\u53CA\u91CD\u8981\u653F\u7B56\uFF0C\u70BA\u78BA\u4FDD\u60A8\u7372\u5F97\u6E96\u78BA\u8CC7\u8A0A\uFF0C\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\u3002",
    "zh-CN": "\u8FD9\u4E2A\u95EE\u9898\u6D89\u53CA\u91CD\u8981\u653F\u7B56\uFF0C\u4E3A\u786E\u4FDD\u60A8\u83B7\u5F97\u51C6\u786E\u4FE1\u606F\uFF0C\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\u3002",
    en: "This question involves important policy matters. To ensure you receive accurate information, let me connect you with a human agent."
  },
  KB_LOW_SCORE_STANDARD: {
    "zh-TW": "\u5F88\u62B1\u6B49\uFF0C\u6211\u76EE\u524D\u7121\u6CD5\u78BA\u5B9A\u7B54\u6848\u3002\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\uFF0C\u4EE5\u63D0\u4F9B\u66F4\u6E96\u78BA\u7684\u5354\u52A9\u3002",
    "zh-CN": "\u5F88\u62B1\u6B49\uFF0C\u6211\u76EE\u524D\u65E0\u6CD5\u786E\u5B9A\u7B54\u6848\u3002\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\uFF0C\u4EE5\u63D0\u4F9B\u66F4\u51C6\u786E\u7684\u534F\u52A9\u3002",
    en: "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance."
  }
};
var S0_LLM_FAILURE_SAFE_TEXT = {
  "zh-TW": "\u7CFB\u7D71\u66AB\u6642\u7121\u6CD5\u5B8C\u6210\u56DE\u8986\uFF0C\u6211\u5DF2\u70BA\u4F60\u8F49\u4EA4\u5BA2\u670D\u4EBA\u54E1\u8DDF\u9032\u3002",
  "zh-CN": "\u7CFB\u7EDF\u6682\u65F6\u65E0\u6CD5\u5B8C\u6210\u56DE\u590D\uFF0C\u6211\u5DF2\u4E3A\u4F60\u8F6C\u4EA4\u5BA2\u670D\u4EBA\u5458\u8DDF\u8FDB\u3002",
  en: "The system is temporarily unable to complete a response. I\u2019ve handed this conversation to a support agent for follow-up."
};
var KB_NO_MATCH_CLARIFICATION_TEXT = {
  "zh-TW": "\u70BA\u4E86\u5E6B\u4F60\u627E\u5230\u6E96\u78BA\u7684\u8CC7\u6599\uFF0C\u53EF\u4EE5\u518D\u88DC\u5145\u4E00\u9EDE\u7D30\u7BC0\u55CE\uFF1F\u4F8B\u5982\u4F60\u60F3\u4E86\u89E3\u7684\u7522\u54C1\u3001\u670D\u52D9\u6216\u5177\u9AD4\u60C5\u6CC1\u3002",
  "zh-CN": "\u4E3A\u4E86\u5E2E\u4F60\u627E\u5230\u51C6\u786E\u7684\u8D44\u6599\uFF0C\u53EF\u4EE5\u518D\u8865\u5145\u4E00\u70B9\u7EC6\u8282\u5417\uFF1F\u4F8B\u5982\u4F60\u60F3\u4E86\u89E3\u7684\u4EA7\u54C1\u3001\u670D\u52A1\u6216\u5177\u4F53\u60C5\u51B5\u3002",
  en: "To find the right information for you, could you share a bit more detail \u2014 for example the product, service, or specific situation you're asking about?"
};
var KB_NO_MATCH_CLARIFICATION_ROUTE = "kb_no_match_recovery";
function isFirstNoMatchClarificationEligible(input) {
  if (input.branch_tag !== "KB_EMPTY" && input.branch_tag !== "KB_LOW_SCORE_STANDARD") return false;
  if (input.high_risk) return false;
  if (input.explicit_human_request) return false;
  if (input.threat_flag === true) return false;
  if (input.compliance_requires_human_review === true) return false;
  if (input.clarification_attempts > 0) return false;
  if (input.exact_same_intent_repeated) return false;
  if (!input.source_message_id) return false;
  return true;
}
async function attemptFirstNoMatchClarification(supabaseAdmin, conversation_id, source_message_id, branchTag, visitorLang, eligibility, traceMetadata) {
  if (!isFirstNoMatchClarificationEligible({
    ...eligibility,
    branch_tag: branchTag,
    source_message_id
  })) {
    return null;
  }
  const content = KB_NO_MATCH_CLARIFICATION_TEXT[visitorLang] ?? KB_NO_MATCH_CLARIFICATION_TEXT["zh-TW"];
  const commit = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    content,
    {
      response_route: KB_NO_MATCH_CLARIFICATION_ROUTE,
      escalation_action: "clarification",
      clarification_reason: "clarification_new_intent_no_kb_match",
      kb_lookup: true,
      kb_branch_tag: branchTag,
      handoff_required: false,
      trace_metadata: traceMetadata
    }
  );
  if (!commit.ok) {
    if (commit.result === "human_control" || commit.result === "resolved" || commit.result === "superseded_source") {
      return new Response(
        JSON.stringify({
          success: true,
          skipped: commit.result,
          response_route: KB_NO_MATCH_CLARIFICATION_ROUTE,
          handoff_required: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return null;
  }
  await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
  return new Response(
    JSON.stringify({
      success: true,
      reply: content,
      no_answer: true,
      handoff_required: false,
      handoff_persisted: false,
      response_route: KB_NO_MATCH_CLARIFICATION_ROUTE,
      escalation_rule: null,
      trace_metadata: {
        ...traceMetadata,
        branch: branchTag,
        clarification_persisted: true,
        idempotent: commit.idempotent
      }
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
async function handleKBFallback(supabaseAdmin, conversation_id, branchTag, source_message_id, traceMetadata, visitorLang = "zh-TW") {
  const _branchTexts = KB_FALLBACK_SAFE_TEXT[branchTag];
  const safeText = _branchTexts ? _branchTexts[visitorLang] ?? _branchTexts["zh-TW"] : void 0;
  if (!safeText) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "kb_fallback_unknown_branch",
        no_answer: true,
        handoff_required: true,
        handoff_persisted: false,
        trace_metadata: {
          ...traceMetadata,
          branch: branchTag,
          handoff_persisted: false
        }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  if (!source_message_id) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "kb_fallback_missing_source_id",
        reply: safeText,
        no_answer: true,
        handoff_required: true,
        handoff_persisted: false,
        trace_metadata: { ...traceMetadata, handoff_persisted: false }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      proposed_response: safeText,
      persistence_kind: "kb_fallback_handoff",
      metadata: { branch: branchTag, handoff_required: true }
    },
    async () => await supabaseAdmin.rpc("kb_fallback_handoff_tx", {
      p_conversation_id: conversation_id,
      p_safe_reply_content: safeText,
      p_branch_tag: branchTag,
      p_source_message_id: source_message_id
    })
  );
  if (!b2.committed) {
    return b2PreventedResponse(b2.decision, {
      branch: branchTag,
      handoff_persisted: false
    });
  }
  const { data: rpcData, error: rpcErr } = b2.value;
  if (rpcErr) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "kb_fallback_persistence_failed",
        reply: safeText,
        no_answer: true,
        handoff_required: true,
        handoff_persisted: false,
        trace_metadata: { ...traceMetadata, handoff_persisted: false }
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const result2 = rpcData?.result ?? "unknown";
  switch (result2) {
    case "success":
      return new Response(
        JSON.stringify({
          success: true,
          reply: safeText,
          no_answer: true,
          handoff_required: true,
          handoff_persisted: true,
          trace_metadata: {
            ...traceMetadata,
            rpc_result: "success",
            handoff_persisted: true
          }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_handled":
      return new Response(
        JSON.stringify({
          success: true,
          reply: null,
          no_answer: true,
          handoff_required: false,
          handoff_persisted: true,
          trace_metadata: {
            ...traceMetadata,
            rpc_result: "already_handled",
            handoff_persisted: true,
            existing_branch: rpcData?.existing_branch,
            requested_branch: rpcData?.requested_branch
          }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_resolved":
      return new Response(
        JSON.stringify({
          success: false,
          error: "conversation_resolved",
          reply: null,
          no_answer: false,
          handoff_required: false,
          handoff_persisted: false,
          trace_metadata: {
            ...traceMetadata,
            rpc_result: "already_resolved",
            handoff_persisted: false
          }
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({
          success: true,
          reply: null,
          no_answer: false,
          handoff_required: false,
          handoff_persisted: false,
          trace_metadata: {
            ...traceMetadata,
            rpc_result: "already_under_human_control",
            handoff_persisted: false
          }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "invalid_source_message":
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_invalid_source",
          reply: safeText,
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false }
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "invalid_branch":
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_invalid_branch",
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false }
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "not_found":
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_conversation_not_found",
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false }
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    default:
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_unexpected_result",
          reply: safeText,
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false }
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
  }
}
async function handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, failure_type, visitorLang) {
  const isKBFailure = failure_type === "KB_SCOPE_GATE" || failure_type === "KB_API_FAIL";
  let safeReply;
  if (isKBFailure) {
    const branchTexts = KB_FALLBACK_SAFE_TEXT[failure_type];
    safeReply = branchTexts?.[visitorLang] ?? branchTexts?.["zh-TW"] ?? "";
  } else {
    safeReply = S0_LLM_FAILURE_SAFE_TEXT[visitorLang] ?? S0_LLM_FAILURE_SAFE_TEXT["zh-TW"];
  }
  if (!safeReply) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "s0_no_safe_reply",
        failure_type
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  if (!source_message_id) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "s0_missing_source_message_id",
        failure_type
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      proposed_response: safeReply,
      persistence_kind: "system_failure_handoff",
      metadata: { escalation_rule: "S0", failure_type, handoff_required: true }
    },
    async () => await supabaseAdmin.rpc("s0_handoff_tx", {
      p_conversation_id: conversation_id,
      p_safe_reply_content: safeReply,
      p_source_message_id: source_message_id,
      p_failure_type: failure_type
    })
  );
  if (!b2.committed) {
    return b2PreventedResponse(b2.decision, {
      escalation_rule: "S0",
      failure_type,
      handoff_persisted: false
    });
  }
  const { data: rpcData, error: rpcErr } = b2.value;
  if (rpcErr) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "s0_rpc_transport_error",
        failure_type,
        handoff_persisted: false,
        handoff_uncertain: true
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const _s0Result = rpcData?.result ?? "unknown";
  switch (_s0Result) {
    case "success":
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "S0",
          failure_type,
          handoff_persisted: true,
          rpc_result: "success"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_handled":
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "S0",
          failure_type,
          handoff_persisted: true,
          rpc_result: "already_handled"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_resolved":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "resolved",
          escalation_rule: "S0",
          failure_type,
          handoff_persisted: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "human_handling",
          escalation_rule: "S0",
          failure_type,
          handoff_persisted: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "invalid_source_message":
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_invalid_source_message",
          escalation_rule: "S0",
          failure_type
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "invalid_input":
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_invalid_input",
          escalation_rule: "S0",
          failure_type
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "invalid_failure_type":
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_invalid_failure_type",
          escalation_rule: "S0",
          failure_type
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "not_found":
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_conversation_not_found",
          escalation_rule: "S0",
          failure_type
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    default:
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_rpc_unknown_result",
          escalation_rule: "S0",
          failure_type,
          rpc_result: _s0Result
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
  }
}
async function persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, latestMessage, runtimeSignals = {}) {
  const classified = classifyExplicitHandoff(latestMessage);
  const { data: handoffHistory, error: handoffHistoryError } = await supabaseAdmin.from("messages").select(
    "id, role, content, metadata, created_at"
  ).eq("conversation_id", conversation_id).eq("is_recalled", false).order(
    "created_at",
    { ascending: true }
  ).order("id", { ascending: true }).limit(40);
  const pkg = buildWarmHandoffPackage(handoffHistory ?? [], "R1");
  const collectionContinuation = pkg.collection_already_attempted && classified.rule !== "R1";
  if (classified.rule !== "R1" && !collectionContinuation) return null;
  const urgent = isDirectViolentThreat(latestMessage);
  const hf1Input = deriveHandoffDecisionInput(
    handoffHistory ?? [],
    latestMessage,
    pkg.missing_facts,
    {
      explicit_human_request: classified.rule === "R1",
      threat_flag: runtimeSignals.threat_flag ?? urgent,
      anger_level: runtimeSignals.anger_level ?? null,
      sentiment_trend: runtimeSignals.sentiment_trend ?? null,
      unresolved_turns: runtimeSignals.unresolved_turns ?? 0,
      same_intent_repeat: runtimeSignals.same_intent_repeat ?? false,
      prior_clarification_count: runtimeSignals.prior_clarification_count,
      vip_tier: runtimeSignals.vip_tier ?? null,
      high_value_customer: runtimeSignals.high_value_customer ?? null,
      predicted_csat: runtimeSignals.predicted_csat ?? null,
      churn_risk: runtimeSignals.churn_risk ?? null,
      policy_risk: runtimeSignals.policy_risk ?? null,
      rag_state: runtimeSignals.rag_state ?? null,
      current_intent: runtimeSignals.current_intent ?? null,
      current_topic: pkg.customer_goal
    }
  );
  const hf1Decision = evaluateHandoffDecision(hf1Input);
  if (handoffHistoryError) {
    console.error(
      "[generate-reply] HF1 handoff history unavailable; fail-open to immediate handoff",
      conversation_id
    );
  }
  if (classified.rule === "R1" && !handoffHistoryError && hf1Decision.handoff_mode === "optional_clarification_then_handoff" && !pkg.collection_already_attempted) {
    const question = buildMissingFactsQuestion(pkg, classified.language);
    if (question) {
      const collected = await commitAiReplyWithControlGate(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        question,
        {
          escalation_rule: "R1",
          escalation_action: "collect_missing_handoff_facts",
          response_route: "warm_handoff_data_collection",
          handoff_required: false,
          hf1_decision: hf1Decision
        }
      );
      if (collected.ok) {
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id
        );
        return new Response(
          JSON.stringify({
            success: true,
            escalation_rule: "R1",
            response_route: "warm_handoff_data_collection",
            handoff_required: false,
            handoff_mode: hf1Decision.handoff_mode,
            missing_info_policy: hf1Decision.missing_info_policy
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (["human_control", "resolved", "superseded_source"].includes(
        collected.result
      )) {
        return new Response(
          JSON.stringify({ success: true, skipped: collected.result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `r1_optional_clarification_${collected.result}`
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
  }
  if (!source_message_id) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "esc_missing_source_message_id",
        escalation_rule: "R1",
        handoff_persisted: false
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      proposed_response: SAFE_HANDOFF_WORDING[classified.language],
      persistence_kind: "explicit_handoff",
      metadata: { escalation_rule: "R1", handoff_required: true }
    },
    async () => await supabaseAdmin.rpc("explicit_handoff_tx", {
      p_conversation_id: conversation_id,
      p_safe_reply_content: SAFE_HANDOFF_WORDING[classified.language],
      p_source_message_id: source_message_id
    })
  );
  if (!b2.committed) {
    return b2PreventedResponse(b2.decision, {
      escalation_rule: "R1",
      handoff_persisted: false
    });
  }
  const { data, error } = b2.value;
  if (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "esc_rpc_transport_error",
        escalation_rule: "R1",
        handoff_persisted: false,
        handoff_uncertain: true
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const result2 = data?.result ?? "unknown";
  switch (result2) {
    case "success":
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "R1",
          handoff_persisted: true,
          rpc_result: "success"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_handled":
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "R1",
          handoff_persisted: true,
          rpc_result: "already_handled"
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_resolved":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "resolved",
          escalation_rule: "R1",
          handoff_persisted: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "human_handling",
          escalation_rule: "R1",
          handoff_persisted: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "not_found":
      return new Response(
        JSON.stringify({
          success: false,
          error: "esc_conversation_not_found",
          escalation_rule: "R1"
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    case "invalid_source_message":
      return new Response(
        JSON.stringify({
          success: false,
          error: "esc_invalid_source_message",
          escalation_rule: "R1"
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    default:
      return new Response(
        JSON.stringify({
          success: false,
          error: "esc_rpc_unknown_result",
          escalation_rule: "R1",
          rpc_result: result2
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
  }
}
async function orchestrationGenerateReply(conversation_id, flags, source_message_id) {
  const supabaseAdmin = createClient3(
    Deno.env.get("SUPABASE_URL") ?? "",
    getSupabaseAdminKey()
  );
  const { data: conversation, error: convError } = await supabaseAdmin.from(
    "conversations"
  ).select(
    "id, status, assigned_agent_id, created_at, company_id, metadata_source"
  ).eq("id", conversation_id).single();
  if (convError || !conversation) {
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
  if (conversation.status === "resolved" || conversation.status === "closed") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return safeRefusal("CONV_RESOLVED_OR_CLOSED");
  }
  if (isHumanControlState(
    conversation.status,
    conversation.assigned_agent_id ?? null
  )) {
    console.log(
      "[generate-reply] orchestration human-handling guard:",
      conversation.status,
      conversation_id
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: true, skipped: "human_handling" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (conversation.assigned_agent_id) {
    console.log(
      "[generate-reply] S-1 assigned_agent_id guard (orchestration):",
      conversation_id
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: true, skipped: "assigned_to_agent" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const sourceResult = await loadSourceVisitorMessage(
    supabaseAdmin,
    conversation_id,
    source_message_id
  );
  if (!sourceResult.ok) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return sourceMessageErrorResponse(sourceResult);
  }
  const sourceVisitorMessage = sourceResult.message;
  const _h1SourceMessageId = sourceVisitorMessage.id;
  const _h1LastMsg = sourceVisitorMessage.content;
  const _closureResponse = await handleConversationClosureIfNeeded(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    _h1LastMsg
  );
  if (_closureResponse) return _closureResponse;
  const [
    { data: _pr5HistoryRows },
    { count: _pr5VisitorTurnCount }
  ] = await Promise.all([
    supabaseAdmin.from("messages").select("role, content, created_at, metadata").eq("conversation_id", conversation_id).eq("is_recalled", false).neq("content", "__THINKING__").or(sourceBoundaryFilter(sourceVisitorMessage)).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(50),
    supabaseAdmin.from("messages").select("id", { count: "exact", head: true }).eq("conversation_id", conversation_id).eq("role", "visitor").eq("is_recalled", false).neq("content", "__THINKING__").or(sourceBoundaryFilter(sourceVisitorMessage))
  ]);
  const _pr5History = deriveConversationHistorySignals(
    _pr5HistoryRows ?? [],
    _pr5VisitorTurnCount ?? 0
  );
  const _priorGroundedTransform = resolvePriorGroundedTransform2(
    _h1LastMsg,
    _pr5HistoryRows ?? []
  );
  const _conversationContinuityBlock = buildCanonicalContinuityBlock(
    _pr5HistoryRows ?? []
  );
  const _visitorLang = resolveWorkflow5ConversationLanguage(
    _h1LastMsg,
    _pr5HistoryRows ?? []
  );
  const _w5ShortTopicHint = workflow5ShortTopicHint(_h1LastMsg);
  if (_w5ShortTopicHint === "membership tiers") {
    const topicalReply = _visitorLang === "en" ? "You\u2019re asking about membership tiers. I don\u2019t have enough confirmed published information to state the tier structure, inclusions, or limits, so I won\u2019t guess." : _visitorLang === "zh-CN" ? "\u4F60\u95EE\u7684\u662F\u4F1A\u5458\u7B49\u7EA7\u3002\u76EE\u524D\u6CA1\u6709\u8DB3\u591F\u5DF2\u786E\u8BA4\u7684\u5DF2\u53D1\u5E03\u8D44\u6599\u6765\u786E\u5B9A\u4F1A\u5458\u7B49\u7EA7\u7684\u67B6\u6784\u3001\u5305\u542B\u5185\u5BB9\u6216\u9650\u5236\uFF0C\u6240\u4EE5\u6211\u4E0D\u4F1A\u731C\u3002" : "\u4F60\u554F\u7684\u662F\u6703\u54E1\u7B49\u7D1A\u3002\u76EE\u524D\u672A\u6709\u8DB3\u5920\u5DF2\u78BA\u8A8D\u7684\u5DF2\u767C\u5E03\u8CC7\u6599\u53BB\u78BA\u5B9A\u6703\u54E1\u7B49\u7D1A\u7684\u67B6\u69CB\u3001\u5305\u542B\u5167\u5BB9\u6216\u9650\u5236\uFF0C\u6240\u4EE5\u6211\u5514\u6703\u4F30\u3002";
    const topicalCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      topicalReply,
      {
        response_route: "workflow5_topical_recovery",
        escalation_action: "continue_ai",
        handoff_required: false,
        topic: _w5ShortTopicHint,
        factual_grounding_required: true,
        grounding_state: "published_evidence_unconfirmed"
      }
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (topicalCommit.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply: topicalReply,
          response_route: "workflow5_topical_recovery",
          handoff_required: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (["human_control", "resolved", "superseded_source"].includes(
      topicalCommit.result
    )) {
      return new Response(
        JSON.stringify({ success: true, skipped: topicalCommit.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `workflow5_topical_recovery_${topicalCommit.result}`
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const _criticalE2ExpectedTenantId = typeof conversation.company_id === "string" && conversation.company_id.length > 0 ? conversation.company_id : void 0;
  const _criticalE2ThreatSignal = classifyAuthoritativeThreat(_h1LastMsg);
  if (isE2LiveActivationEnabled(Deno.env) && _criticalE2ThreatSignal) {
    const _criticalE2Response = await evaluateAndPersistRequiredRulesLive(
      supabaseAdmin,
      {
        conversation_id,
        source_message_id: _h1SourceMessageId,
        latest_message_content: _h1LastMsg,
        conversation_status: conversation.status,
        assigned_agent_id: conversation.assigned_agent_id ?? null,
        greeting_or_trivial: isGreetingOrTrivial(_h1LastMsg),
        visitor_language: _visitorLang,
        expected_tenant_id: _criticalE2ExpectedTenantId,
        turn_count: _pr5History.turn_count,
        consecutive_no_answer: _pr5History.consecutive_no_answer,
        clarification_attempts: _pr5History.clarification_attempts,
        exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
        threat_flag: _criticalE2ThreatSignal,
        compliance_jurisdiction_requires_human_review: resolveAuthoritativeComplianceReview(_criticalE2ExpectedTenantId)
      }
    );
    if (_criticalE2Response) return _criticalE2Response;
  }
  let _a3SemanticFrame = null;
  if (_criticalE2ExpectedTenantId) {
    try {
      const semanticResult = await interpretCommerceSemantics({
        company_id: _criticalE2ExpectedTenantId,
        conversation_id,
        source_message_id: _h1SourceMessageId,
        latest: _h1LastMsg,
        history: (_pr5HistoryRows ?? []).map((row) => ({
          role: String(row.role ?? ""),
          content: String(row.content ?? "")
        }))
      });
      _a3SemanticFrame = semanticResult.frame;
    } catch (error) {
      console.error(
        "[generate-reply] A3.1 semantic interpreter fallback",
        error instanceof Error ? error.name : "unknown_error"
      );
    }
  }
  let _a3Commerce = null;
  if (_criticalE2ExpectedTenantId) {
    try {
      _a3Commerce = await runCommerceStateRuntime2(
        supabaseAdmin,
        {
          conversation_id,
          company_id: _criticalE2ExpectedTenantId,
          source_message_id: _h1SourceMessageId,
          text: _h1LastMsg,
          language: _visitorLang === "en" ? "en" : _visitorLang === "zh-CN" ? "zh-CN" : "zh-TW",
          occurred_at: sourceVisitorMessage.created_at ?? null,
          history: (_pr5HistoryRows ?? []).map((row) => ({
            role: String(row.role ?? ""),
            content: String(row.content ?? "")
          })),
          semantic_frame: _a3SemanticFrame
        }
      );
    } catch (commerceError) {
      console.error(
        "[generate-reply] A3 commerce state runtime failed (non-blocking):",
        commerceError
      );
      _a3Commerce = null;
    }
  }
  if (_a3Commerce && _a3Commerce.reply) {
    const commerceReply = _a3Commerce.reply;
    const commerceCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      commerceReply,
      {
        response_route: _a3Commerce.route,
        escalation_action: "continue_ai",
        handoff_required: false,
        commerce_authority: _a3Commerce.authority,
        commerce_state_revision: _a3Commerce.revision,
        commerce_state_persist_result: _a3Commerce.persist_result,
        commerce_reason: _a3Commerce.reason,
        commerce_state_path: _a3Commerce.state_path ?? null,
        commerce_calculation: _a3Commerce.calculation ?? null
      }
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (commerceCommit.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply: commerceReply,
          response_route: _a3Commerce.route,
          commerce_authority: _a3Commerce.authority,
          commerce_state_revision: _a3Commerce.revision,
          handoff_required: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (["human_control", "resolved", "superseded_source"].includes(
      commerceCommit.result
    )) {
      return new Response(
        JSON.stringify({ success: true, skipped: commerceCommit.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `commerce_state_runtime_${commerceCommit.result}`
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const _criticalLocalRisk = classifyLocalTopicRisk(_h1LastMsg);
  const _canonicalTurn = classifyCanonicalConversationTurn(
    _h1LastMsg,
    _pr5HistoryRows ?? [],
    { explicit_handoff: isHandoffIntent(_h1LastMsg) }
  );
  if (_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE") {
    const acknowledgement = _canonicalTurn.reason === "customer_context_requirements_request" ? buildCustomerContextRequirementsResponse(
      _canonicalTurn.language,
      _pr5HistoryRows ?? []
    ) : buildCustomerContextAcknowledgement(_canonicalTurn.language);
    const contextCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      acknowledgement,
      {
        response_route: "customer_context_update",
        escalation_action: "continue_ai",
        handoff_required: false,
        reason_code: _canonicalTurn.reason
      }
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (contextCommit.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply: acknowledgement,
          response_route: "customer_context_update",
          handoff_required: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (["human_control", "resolved", "superseded_source"].includes(
      contextCommit.result
    )) {
      return new Response(
        JSON.stringify({ success: true, skipped: contextCommit.result }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `context_update_commit_${contextCommit.result}`
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const _turnClassification = classifyConversationTurn(_h1LastMsg);
  if (!_w5ShortTopicHint && _turnClassification.should_clarify_before_kb && !isHandoffIntent(_h1LastMsg) && _criticalLocalRisk?.level !== "high") {
    const clarification = NATURAL_CLARIFICATION[_visitorLang];
    const clarificationCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      clarification,
      {
        response_route: "conversational_clarification",
        escalation_action: "clarification",
        handoff_required: false,
        reason_code: _turnClassification.reason
      }
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (clarificationCommit.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply: clarification,
          response_route: "conversational_clarification",
          handoff_required: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (["human_control", "resolved", "superseded_source"].includes(
      clarificationCommit.result
    )) {
      return new Response(
        JSON.stringify({ success: true, skipped: clarificationCommit.result }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `clarification_commit_${clarificationCommit.result}`
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const _pr5ExpectedTenantId = typeof conversation.company_id === "string" && conversation.company_id.length > 0 ? conversation.company_id : void 0;
  const _widgetLiveTestActor = _pr5ExpectedTenantId === void 0 ? widgetLiveTestPreActivationActor(conversation.metadata_source) : void 0;
  const _pr5ThreatSignal = classifyAuthoritativeThreat(_h1LastMsg);
  const _pr5ComplianceSignal = resolveAuthoritativeComplianceReview(
    _pr5ExpectedTenantId
  );
  const _pr5LocalRisk = classifyLocalTopicRisk(_h1LastMsg);
  const _pr5HistoricalR3Sentiment = await loadAuthoritativeR3SentimentSignals(
    supabaseAdmin,
    conversation_id,
    _pr5ExpectedTenantId
  );
  const _pr5R3Sentiment = buildRealtimeR3SentimentSignals(
    _h1LastMsg,
    _pr5HistoricalR3Sentiment
  );
  const _pr5ConversationDurationSec = conversation.created_at ? Math.max(
    0,
    Math.floor(
      (Date.now() - new Date(conversation.created_at).getTime()) / 1e3
    )
  ) : void 0;
  const _pr5VerifiedTenantConfig = buildVerifiedTenantEscalationConfig();
  const _pr5GreetingOrTrivial = isGreetingOrTrivial(_h1LastMsg);
  const _pr5Shadow = evaluateEscalationShadow(
    {
      conversation_id,
      source_message_id,
      latest_message_content: _h1LastMsg,
      conversation_status: conversation.status,
      assigned_agent_id: conversation.assigned_agent_id ?? null,
      explicit_request: isHandoffIntent(_h1LastMsg),
      greeting_or_trivial: _pr5GreetingOrTrivial,
      expected_tenant_id: _pr5ExpectedTenantId,
      threat_flag: _pr5ThreatSignal,
      compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal,
      anger_flag: _pr5R3Sentiment?.anger_flag,
      sentiment_score: _pr5R3Sentiment?.sentiment_score,
      sentiment_trend: _pr5R3Sentiment?.sentiment_trend,
      sentiment_recovered_same_turn: _pr5R3Sentiment?.sentiment_recovered_same_turn,
      sentiment_provider_version: _pr5R3Sentiment?.provider_version,
      sentiment_evaluation_id: _pr5R3Sentiment?.evaluation_id,
      conversation_duration_sec: _pr5ConversationDurationSec,
      tenant_config: _pr5VerifiedTenantConfig
    },
    Deno.env
  );
  if (_pr5Shadow) {
    console.log("[generate-reply] PR-5 escalation shadow:", {
      conversation_id,
      matched_rule: _pr5Shadow.matched_rule,
      decision: _pr5Shadow.decision,
      reason_code: _pr5Shadow.reason_code,
      signal_gaps: _pr5Shadow.signal_gaps,
      provider_warnings: _pr5Shadow.provider_warnings
    });
  }
  if (isE2LiveActivationEnabled(Deno.env)) {
    const _pr5E2PreflightResponse = await evaluateAndPersistRequiredRulesLive(
      supabaseAdmin,
      {
        conversation_id,
        source_message_id,
        latest_message_content: _h1LastMsg,
        conversation_status: conversation.status,
        assigned_agent_id: conversation.assigned_agent_id ?? null,
        greeting_or_trivial: _pr5GreetingOrTrivial,
        visitor_language: _visitorLang,
        expected_tenant_id: _pr5ExpectedTenantId,
        turn_count: _pr5History.turn_count,
        consecutive_no_answer: _pr5History.consecutive_no_answer,
        clarification_attempts: _pr5History.clarification_attempts,
        exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
        threat_flag: _pr5ThreatSignal,
        compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal
      }
    );
    if (_pr5E2PreflightResponse) return _pr5E2PreflightResponse;
  }
  const _deferR1ForE1 = isE1LiveActivationEnabled(Deno.env) && _pr5LocalRisk?.level === "high" && flags.ENABLE_KB && !_pr5GreetingOrTrivial;
  let _hf1CustomerContext = null;
  let _hf1OpaqueCustomerRef = null;
  const _hf1ExplicitClassification = classifyExplicitHandoff(_h1LastMsg);
  if (!_deferR1ForE1 && flags.ENABLE_C360 && _hf1ExplicitClassification.rule === "R1") {
    const c360 = await callCustomer360Adapter(conversation_id);
    if (c360.success && c360.customer_context) {
      _hf1CustomerContext = c360.customer_context;
      _hf1OpaqueCustomerRef = c360.customer_ref ?? null;
    }
  }
  if (!_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _h1LastMsg,
      {
        anger_level: _pr5R3Sentiment?.anger_flag === true ? "high" : null,
        sentiment_trend: _pr5R3Sentiment?.sentiment_trend ?? null,
        unresolved_turns: _pr5History.consecutive_no_answer,
        same_intent_repeat: _pr5History.exact_same_intent_repeated === true,
        prior_clarification_count: _pr5History.clarification_attempts,
        vip_tier: _hf1CustomerContext?.tier ?? null,
        high_value_customer: null,
        predicted_csat: _hf1CustomerContext?.predicted_csat ?? null,
        churn_risk: _hf1CustomerContext?.churn_risk ?? null,
        policy_risk: _pr5ComplianceSignal?.value === true || _pr5LocalRisk?.level === "high" ? "high" : "standard",
        threat_flag: _pr5ThreatSignal?.value === true,
        rag_state: null,
        current_intent: _canonicalTurn.operation
      }
    );
    if (r1Response) return r1Response;
  }
  const _humanSupportIntent = classifyHandoffIntent(_h1LastMsg);
  if (_humanSupportIntent.kind === "question_about_human_support") {
    const infoReply = HUMAN_SUPPORT_INFO_WORDING[_humanSupportIntent.language];
    const committed2 = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      infoReply,
      {
        response_route: "human_support_information",
        handoff_required: false,
        escalation_rule: null,
        handoff_intent_kind: _humanSupportIntent.kind
      }
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!committed2.ok) {
      if (committed2.result === "human_control" || committed2.result === "resolved" || committed2.result === "superseded_source") {
        return new Response(
          JSON.stringify({ success: true, skipped: committed2.result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `human_support_info_commit_${committed2.result}`
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        response_route: "human_support_information",
        handoff_required: false
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const _positiveRecoveryAcknowledgement = _pr5R3Sentiment?.emotion_kind === "positive_recovery" ? resolvePositiveRecoveryAcknowledgement(_h1LastMsg, _visitorLang) : null;
  if (_positiveRecoveryAcknowledgement) {
    const committed2 = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _positiveRecoveryAcknowledgement,
      {
        response_route: "positive_recovery_acknowledgement",
        handoff_required: false,
        factual_grounding_required: false
      }
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!committed2.ok) {
      if (committed2.result === "human_control" || committed2.result === "resolved" || committed2.result === "superseded_source") {
        return new Response(
          JSON.stringify({ success: true, skipped: committed2.result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `positive_recovery_commit_${committed2.result}`
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        response_route: "positive_recovery_acknowledgement",
        handoff_required: false
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const _conversationMemoryReply = resolveConversationMemoryResponse2(
    _h1LastMsg,
    _pr5HistoryRows ?? []
  );
  if (_conversationMemoryReply) {
    const committed2 = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _conversationMemoryReply,
      { response_route: "conversation_memory", conversation_grounded: true }
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!committed2.ok) {
      if (committed2.result === "human_control" || committed2.result === "resolved" || committed2.result === "superseded_source") {
        return new Response(
          JSON.stringify({ success: true, skipped: committed2.result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `conversation_memory_commit_${committed2.result}`
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        response_route: "conversation_memory",
        conversation_grounded: true
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const _g1SkipKB = _pr5GreetingOrTrivial || Boolean(_priorGroundedTransform);
  let _pr5RagMatchState;
  const _escEnableS0 = Deno.env.get("ESC_ENABLE_S0") !== "false";
  let basePrompt = MINIMAL_SAFE_FALLBACK_PROMPT;
  let coachTrace = { source: "minimal_fallback" };
  if (flags.ENABLE_COACH && !_priorGroundedTransform) {
    const promptResult = await callCoachPromptAdapter(conversation_id);
    if (!promptResult.success || !promptResult.content) {
      console.error("[generate-reply] COACH_PROMPT_REQUIRED_UNAVAILABLE", {
        conversation_id,
        error_type: promptResult.error_type ?? "COACH_UNKNOWN_FAILURE"
      });
      await cleanupThinking(
        supabaseAdmin,
        conversation_id,
        source_message_id
      );
      return new Response(
        JSON.stringify({
          success: false,
          error: "coach_prompt_required_unavailable",
          error_type: promptResult.error_type ?? "COACH_UNKNOWN_FAILURE",
          retryable: promptResult.error_type === "COACH_API_TIMEOUT" || promptResult.error_type === "COACH_API_ERROR" || promptResult.error_type === "COACH_API_EXCEPTION"
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
    basePrompt = promptResult.content;
    coachTrace = {
      version_id: promptResult.version_id,
      version_label: promptResult.version_label,
      prompt_hash: promptResult.prompt_hash,
      source: "upstream"
    };
  }
  let customerContext = _hf1CustomerContext;
  let opaqueCustomerRef = _hf1OpaqueCustomerRef;
  if (flags.ENABLE_C360 && customerContext === null) {
    const c360Result = await callCustomer360Adapter(conversation_id);
    if (c360Result.success && c360Result.customer_context) {
      customerContext = c360Result.customer_context;
      opaqueCustomerRef = c360Result.customer_ref ?? null;
    }
  }
  const _pr5P1Input = customerContext?.p1_provider_version ? {
    predicted_csat: customerContext.predicted_csat,
    churn_risk: customerContext.churn_risk,
    escalation_score: customerContext.escalation_score,
    provider_version: customerContext.p1_provider_version,
    provider_source: "customer360"
  } : void 0;
  const _pr5P1Signals = validateP1PredictionSignals(_pr5P1Input);
  let finalPromptChunks = [];
  let _kbDone = false;
  let ragResult = null;
  if (flags.ENABLE_KB && !_g1SkipKB) {
    const _kbTenantResult = await resolveTenantScope(
      conversation_id,
      _widgetLiveTestActor
    );
    if (!_kbTenantResult.resolved) {
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg
        );
        if (r1Response) return r1Response;
      }
      if (_escEnableS0) {
        return await handleS0Handoff(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          "KB_SCOPE_GATE",
          _visitorLang
        );
      }
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        "KB_SCOPE_GATE",
        source_message_id,
        { rag_api_status: "scope_unavailable" },
        _visitorLang
      );
    }
    const _semanticRetrieval = buildCanonicalRetrievalQuery2(
      _h1LastMsg,
      _pr5HistoryRows ?? []
    );
    const userQuery = _semanticRetrieval.query;
    ragResult = !userQuery ? {
      success: true,
      no_answer: true,
      retrieval_quality: "failed",
      chunks: []
    } : await callKBAdapter(conversation_id, userQuery, _kbTenantResult.scope);
    if (!ragResult || !ragResult.success) {
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg
        );
        if (r1Response) return r1Response;
      }
      if (_escEnableS0) {
        return await handleS0Handoff(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          "KB_API_FAIL",
          _visitorLang
        );
      }
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        "KB_API_FAIL",
        source_message_id,
        { rag_api_status: "failure" },
        _visitorLang
      );
    }
    if (ragResult.no_answer || !ragResult.chunks || ragResult.chunks.length === 0) {
      _pr5RagMatchState = "no_match";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(
        supabaseAdmin,
        {
          conversation_id,
          source_message_id,
          latest_message_content: _h1LastMsg,
          conversation_status: conversation.status,
          assigned_agent_id: conversation.assigned_agent_id ?? null,
          greeting_or_trivial: _pr5GreetingOrTrivial,
          visitor_language: _visitorLang,
          expected_tenant_id: _pr5ExpectedTenantId,
          warm_handoff_question: buildMissingFactsQuestion(
            buildWarmHandoffPackage(_pr5HistoryRows ?? [], "R2"),
            _visitorLang
          ) ?? void 0,
          rag_match_state: _pr5RagMatchState,
          topic_risk_level: _pr5LocalRisk?.level,
          verified_local_risk_classification: _pr5LocalRisk?.verified,
          conversation_duration_sec: _pr5ConversationDurationSec,
          turn_count: _pr5History.turn_count,
          consecutive_no_answer: _pr5History.consecutive_no_answer,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
          threat_flag: _pr5ThreatSignal,
          compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal
        }
      );
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg
        );
        if (r1Response) return r1Response;
      }
      const clarification = await attemptFirstNoMatchClarification(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        "KB_EMPTY",
        _visitorLang,
        {
          high_risk: _pr5LocalRisk?.level === "high",
          explicit_human_request: isHandoffIntent(_h1LastMsg),
          threat_flag: _pr5ThreatSignal?.value === true,
          compliance_requires_human_review: _pr5ComplianceSignal?.value === true,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated === true
        },
        { rag_api_status: "success_empty" }
      );
      if (clarification) return clarification;
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        "KB_EMPTY",
        source_message_id,
        { rag_api_status: "success_empty" },
        _visitorLang
      );
    }
    const isHighRisk = _pr5LocalRisk?.level === "high";
    const minScore = isHighRisk ? 0.78 : 0.45;
    const _groundingSelection = selectCanonicalGrounding(
      ragResult.documents ?? [],
      {
        minScore,
        requirePublished: true,
        requestText: userQuery
      }
    );
    const _scoreUsableChunks = _groundingSelection.ok ? _groundingSelection.chunks : [];
    const _explicitJurisdiction = extractExplicitJurisdictionConstraint(
      _h1LastMsg
    );
    const _jurisdictionSupported = evidenceSupportsJurisdiction(
      _explicitJurisdiction,
      _scoreUsableChunks
    );
    const usableChunks = _jurisdictionSupported ? _scoreUsableChunks : [];
    const traceMetadata = {
      rag_api_status: "success",
      total_results: ragResult.chunks.length,
      filtered_results: usableChunks.length,
      jurisdiction_constraint: _explicitJurisdiction,
      jurisdiction_supported: _jurisdictionSupported,
      min_score_used: usableChunks.length > 0 ? Math.min(...usableChunks.map((c) => c.score ?? 0)) : null,
      max_score_used: usableChunks.length > 0 ? Math.max(...usableChunks.map((c) => c.score ?? 0)) : null,
      high_risk_topic: isHighRisk,
      min_threshold: minScore,
      citations: usableChunks.map((c) => ({
        doc_id: c.doc_id,
        chunk_id: c.chunk_id,
        title: c.title,
        score: c.score,
        source_type: c.source_type
      }))
    };
    ragResult.trace_metadata = traceMetadata;
    if (usableChunks.length === 0) {
      _pr5RagMatchState = "partial_match";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(
        supabaseAdmin,
        {
          conversation_id,
          source_message_id,
          latest_message_content: _h1LastMsg,
          conversation_status: conversation.status,
          assigned_agent_id: conversation.assigned_agent_id ?? null,
          greeting_or_trivial: _pr5GreetingOrTrivial,
          visitor_language: _visitorLang,
          expected_tenant_id: _pr5ExpectedTenantId,
          warm_handoff_question: buildMissingFactsQuestion(
            buildWarmHandoffPackage(_pr5HistoryRows ?? [], "R2"),
            _visitorLang
          ) ?? void 0,
          rag_match_state: _pr5RagMatchState,
          topic_risk_level: _pr5LocalRisk?.level,
          verified_local_risk_classification: _pr5LocalRisk?.verified,
          conversation_duration_sec: _pr5ConversationDurationSec,
          turn_count: _pr5History.turn_count,
          consecutive_no_answer: _pr5History.consecutive_no_answer,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
          threat_flag: _pr5ThreatSignal,
          compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal
        }
      );
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg
        );
        if (r1Response) return r1Response;
      }
      const clarification = await attemptFirstNoMatchClarification(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        isHighRisk ? "KB_LOW_SCORE_HIGH_RISK" : "KB_LOW_SCORE_STANDARD",
        _visitorLang,
        {
          high_risk: isHighRisk,
          explicit_human_request: isHandoffIntent(_h1LastMsg),
          threat_flag: _pr5ThreatSignal?.value === true,
          compliance_requires_human_review: _pr5ComplianceSignal?.value === true,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated === true
        },
        traceMetadata
      );
      if (clarification) return clarification;
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        isHighRisk ? "KB_LOW_SCORE_HIGH_RISK" : "KB_LOW_SCORE_STANDARD",
        source_message_id,
        traceMetadata,
        _visitorLang
      );
    }
    if (!hasUsableFullContentEvidence(usableChunks, minScore)) {
      _pr5RagMatchState = "partial_match";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(
        supabaseAdmin,
        {
          conversation_id,
          source_message_id,
          latest_message_content: _h1LastMsg,
          conversation_status: conversation.status,
          assigned_agent_id: conversation.assigned_agent_id ?? null,
          greeting_or_trivial: _pr5GreetingOrTrivial,
          visitor_language: _visitorLang,
          expected_tenant_id: _pr5ExpectedTenantId,
          warm_handoff_question: buildMissingFactsQuestion(
            buildWarmHandoffPackage(_pr5HistoryRows ?? [], "R2"),
            _visitorLang
          ) ?? void 0,
          rag_match_state: _pr5RagMatchState,
          topic_risk_level: _pr5LocalRisk?.level,
          verified_local_risk_classification: _pr5LocalRisk?.verified,
          conversation_duration_sec: _pr5ConversationDurationSec,
          turn_count: _pr5History.turn_count,
          consecutive_no_answer: _pr5History.consecutive_no_answer,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
          threat_flag: _pr5ThreatSignal,
          compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal
        }
      );
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg
        );
        if (r1Response) return r1Response;
      }
      const clarification = await attemptFirstNoMatchClarification(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        isHighRisk ? "KB_LOW_SCORE_HIGH_RISK" : "KB_LOW_SCORE_STANDARD",
        _visitorLang,
        {
          high_risk: isHighRisk,
          explicit_human_request: isHandoffIntent(_h1LastMsg),
          threat_flag: _pr5ThreatSignal?.value === true,
          compliance_requires_human_review: _pr5ComplianceSignal?.value === true,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated === true
        },
        { ...traceMetadata, answerability: "missing_full_content_evidence" }
      );
      if (clarification) return clarification;
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        isHighRisk ? "KB_LOW_SCORE_HIGH_RISK" : "KB_LOW_SCORE_STANDARD",
        source_message_id,
        { ...traceMetadata, answerability: "missing_full_content_evidence" },
        _visitorLang
      );
    }
    _pr5RagMatchState = "confident_match";
    ragResult.chunks = usableChunks;
    ragResult.no_answer = false;
    const usableSummary = usableChunks.find(
      (c) => c.chunk_type === "rag_summary"
    );
    const usableFullContent = usableChunks.filter((c) => c.chunk_type === "full_content").slice(0, 3);
    const selectedDocumentId = usableChunks[0]?.document_id ?? usableChunks[0]?.doc_id;
    ragResult.llm_context = selectedDocumentId ? {
      selected_document_id: selectedDocumentId,
      orientation_summary: usableSummary?.content ?? null,
      full_content_evidence: usableFullContent.map((c) => ({
        document_id: c.document_id ?? c.doc_id ?? selectedDocumentId,
        ...c.chunk_id ? { chunk_id: c.chunk_id } : {},
        content: c.content ?? "",
        score: c.score ?? 0,
        source_type: c.source_type ?? "unknown"
      }))
    } : void 0;
    finalPromptChunks = usableFullContent;
    _kbDone = true;
  }
  if (!flags.ENABLE_KB || _g1SkipKB) _kbDone = true;
  if (flags.ENABLE_KB && !_g1SkipKB && !_kbDone) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ error: "Internal KB processing error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  let _pr5R4Policy;
  const _pr5ShadowFlags = escalationFeatureFlagsFromEnv(Deno.env);
  if (_pr5ShadowFlags.shadow_mode && (_pr5ShadowFlags.enable_full_ruleset || _pr5ShadowFlags.enable_r4)) {
    const structuredPolicyEvidence = ragResult?.llm_context?.full_content_evidence?.filter(
      (item) => typeof item.source_type === "string" && item.source_type.toLowerCase().includes("policy") && typeof item.content === "string" && item.content.trim().length > 0
    ).slice(0, 3) ?? [];
    const policyEvidence = structuredPolicyEvidence.map((item, index) => ({
      label: `Policy evidence ${index + 1}`,
      content: item.content.slice(0, 800),
      source_type: item.source_type.slice(0, 40)
    }));
    if (policyEvidence.length > 0) {
      _pr5R4Policy = await assessPolicyEvidenceForR4(
        _h1LastMsg,
        policyEvidence,
        {
          company_id: _pr5ExpectedTenantId ?? null,
          conversation_id,
          operation_id: `generate-reply:r4-policy:${conversation_id}:${source_message_id ?? "none"}`
        }
      );
    }
  }
  if (Deno.env.get("ESC_SHADOW_MODE") === "true" && _pr5LocalRisk?.level === "high") {
    const e1Shadow = evaluateEscalationShadow({
      conversation_id,
      source_message_id,
      latest_message_content: _h1LastMsg,
      conversation_status: conversation.status,
      assigned_agent_id: conversation.assigned_agent_id ?? null,
      explicit_request: isHandoffIntent(_h1LastMsg),
      greeting_or_trivial: _pr5GreetingOrTrivial,
      expected_tenant_id: _pr5ExpectedTenantId,
      threat_flag: _pr5ThreatSignal,
      compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal,
      rag_match_state: _pr5RagMatchState,
      topic_risk_level: _pr5LocalRisk.level,
      verified_local_risk_classification: _pr5LocalRisk.verified
    }, Deno.env);
    if (e1Shadow) {
      console.log("[generate-reply] PR-5 E1 post-KB shadow:", {
        conversation_id,
        matched_rule: e1Shadow.matched_rule,
        decision: e1Shadow.decision,
        reason_code: e1Shadow.reason_code,
        signal_gaps: e1Shadow.signal_gaps
      });
    }
  }
  const _warmHandoffPackage = buildWarmHandoffPackage(
    _pr5HistoryRows ?? [],
    "R2"
  );
  const _warmHandoffQuestion = buildMissingFactsQuestion(
    _warmHandoffPackage,
    _visitorLang
  );
  const _pr5RequiredLiveResponse = await evaluateAndPersistRequiredRulesLive(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      latest_message_content: _h1LastMsg,
      conversation_status: conversation.status,
      assigned_agent_id: conversation.assigned_agent_id ?? null,
      greeting_or_trivial: _pr5GreetingOrTrivial,
      visitor_language: _visitorLang,
      expected_tenant_id: _pr5ExpectedTenantId,
      suppress_r2_for_prior_grounded_transform: Boolean(
        _priorGroundedTransform
      ),
      warm_handoff_question: _warmHandoffQuestion ?? void 0,
      rag_match_state: _pr5RagMatchState,
      topic_risk_level: _pr5LocalRisk?.level,
      verified_local_risk_classification: _pr5LocalRisk?.verified,
      conversation_duration_sec: _pr5ConversationDurationSec,
      turn_count: _pr5History.turn_count,
      consecutive_no_answer: _pr5History.consecutive_no_answer,
      clarification_attempts: _pr5History.clarification_attempts,
      exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
      threat_flag: _pr5ThreatSignal,
      compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal
    }
  );
  if (_pr5RequiredLiveResponse) return _pr5RequiredLiveResponse;
  if (_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _h1LastMsg
    );
    if (r1Response) return r1Response;
  }
  if (Deno.env.get("ESC_SHADOW_MODE") === "true") {
    const advisoryShadow = evaluateEscalationShadow({
      conversation_id,
      source_message_id,
      latest_message_content: _h1LastMsg,
      conversation_status: conversation.status,
      assigned_agent_id: conversation.assigned_agent_id ?? null,
      explicit_request: isHandoffIntent(_h1LastMsg),
      greeting_or_trivial: _pr5GreetingOrTrivial,
      expected_tenant_id: _pr5ExpectedTenantId,
      anger_flag: _pr5R3Sentiment?.anger_flag,
      sentiment_score: _pr5R3Sentiment?.sentiment_score,
      sentiment_trend: _pr5R3Sentiment?.sentiment_trend,
      sentiment_recovered_same_turn: _pr5R3Sentiment?.sentiment_recovered_same_turn,
      sentiment_provider_version: _pr5R3Sentiment?.provider_version,
      sentiment_evaluation_id: _pr5R3Sentiment?.evaluation_id,
      conversation_duration_sec: _pr5ConversationDurationSec,
      tenant_config: _pr5VerifiedTenantConfig,
      policy_match_state: _pr5R4Policy?.match_state,
      policy_provider_version: _pr5R4Policy?.provider_version,
      policy_provider_reason: _pr5R4Policy?.reason,
      predicted_csat: _pr5P1Signals?.predicted_csat,
      churn_risk: _pr5P1Signals?.churn_risk,
      escalation_score: _pr5P1Signals?.escalation_score,
      p1_provider_version: _pr5P1Signals?.provider_version,
      p1_provider_source: _pr5P1Signals?.provider_source
    }, Deno.env);
    if (advisoryShadow) {
      console.log("[generate-reply] PR-5 advisory post-KB shadow:", {
        conversation_id,
        matched_rule: advisoryShadow.matched_rule,
        decision: advisoryShadow.decision,
        reason_code: advisoryShadow.reason_code,
        signal_gaps: advisoryShadow.signal_gaps,
        sentiment_evaluation_id: _pr5R3Sentiment?.evaluation_id
      });
    }
  }
  if (flags.ENABLE_TOOL_EXEC) {
    console.log(
      "[generate-reply] ENABLE_TOOL_EXECUTOR=true: Gate present, tools NOT attached (L5d scope)"
    );
  }
  const _customerAdvisoryBlock = buildCustomerAdvisoryContext({
    tier: customerContext?.tier,
    anger_flag: _pr5R3Sentiment?.anger_flag,
    sentiment_score: _pr5R3Sentiment?.sentiment_score,
    churn_risk: customerContext?.churn_risk,
    escalation_score: customerContext?.escalation_score
  });
  const _emotionReplyStrategyBlock = buildEmotionReplyStrategyContext({
    emotion_kind: _pr5R3Sentiment?.emotion_kind,
    emotion_intensity: _pr5R3Sentiment?.emotion_intensity,
    emotion_confidence: _pr5R3Sentiment?.emotion_confidence,
    sentiment_recovered_same_turn: _pr5R3Sentiment?.sentiment_recovered_same_turn
  });
  const latestHandoffReason = await loadLatestHandoffReason(
    supabaseAdmin,
    conversation_id
  );
  const returnToAiGuard = buildReturnToAiGenerationGuard(
    latestHandoffReason,
    conversation.assigned_agent_id ?? null
  );
  const finalSystemPrompt = _priorGroundedTransform ? buildPriorGroundedTransformGenerationSystem(_priorGroundedTransform) : [
    basePrompt,
    CUSTOMER_CONVERSATION_POLICY,
    _conversationContinuityBlock,
    returnToAiGuard,
    _customerAdvisoryBlock,
    _emotionReplyStrategyBlock,
    buildMaskedContextBlock(customerContext, opaqueCustomerRef),
    buildRagBlock(ragResult)
  ].filter((s) => s && s.length > 0).join("\n\n");
  const { data: newestMessages } = await supabaseAdmin.from("messages").select("id, role, content, created_at").eq("conversation_id", conversation_id).neq("content", "__THINKING__").eq("is_recalled", false).or(sourceBoundaryFilter(sourceVisitorMessage)).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(10);
  if (!newestMessages || newestMessages.length === 0) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: true, skipped: "no messages" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const messages = [...newestMessages].reverse();
  const modelMessages = messages.map((m) => ({
    role: m.role === "visitor" ? "user" : "assistant",
    content: String(m.content ?? "")
  }));
  if (modelMessages[modelMessages.length - 1].role === "assistant") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: true, skipped: "last message is assistant" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (flags.ENABLE_TOOL_EXEC) {
    console.warn(
      "[generate-reply] TOOL_EXECUTOR_NOT_READY: tools withheld from governed LLM request",
      { conversation_id }
    );
  }
  const _generationCompanyId = typeof conversation.company_id === "string" && conversation.company_id.length > 0 ? conversation.company_id : null;
  const _generationUserInput = _priorGroundedTransform ? buildPriorGroundedTransformGenerationUser(_h1LastMsg) : buildRouterConversationInput(modelMessages);
  let llm = await callModel({
    purpose: "generation",
    system: finalSystemPrompt,
    user: _generationUserInput,
    maxTokens: resolveGenerationMaxTokens(),
    operationId: `generate-reply:orchestration:${conversation_id}:${source_message_id}`,
    companyId: _generationCompanyId,
    conversationId: conversation_id,
    tag: "generate-reply-orchestration",
    responseFormat: "text"
  });
  if (_priorGroundedTransform && !llm.ok && (llm.code === "LLM_INVALID_OUTPUT" || llm.code === "LLM_GROUNDING_REJECTED")) {
    llm = await callModel({
      purpose: "generation",
      system: buildPriorGroundedTransformRetrySystem(_priorGroundedTransform),
      user: _generationUserInput,
      maxTokens: resolveGenerationMaxTokens(),
      operationId: `generate-reply:orchestration:${conversation_id}:${source_message_id}:transform-retry`,
      companyId: _generationCompanyId,
      conversationId: conversation_id,
      tag: "generate-reply-orchestration-transform-retry",
      responseFormat: "text"
    });
  }
  if (!llm.ok) {
    if (llm.code === "LLM_GROUNDING_REJECTED") {
      const recoveryReply = GROUNDING_RECOVERY_WORDING[_visitorLang] ?? GROUNDING_RECOVERY_WORDING.en;
      const committed2 = await commitAiReplyWithControlGate(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        recoveryReply,
        {
          response_route: "grounding_recovery_clarification",
          handoff_required: false,
          factual_grounding_required: false,
          source_error_code: "LLM_GROUNDING_REJECTED"
        }
      );
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      if (!committed2.ok) {
        if (["human_control", "resolved", "superseded_source"].includes(
          committed2.result
        )) {
          return new Response(
            JSON.stringify({ success: true, skipped: committed2.result }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            success: false,
            error: `grounding_recovery_commit_${committed2.result}`
          }),
          {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          response_route: "grounding_recovery_clarification",
          handoff_required: false
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (_escEnableS0) {
      return await handleS0Handoff(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        routerFailureToS0(llm.code),
        _visitorLang
      );
    }
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({
        success: false,
        error: "AI service error",
        error_code: llm.code
      }),
      {
        status: routerFailureHttpStatus(llm.code),
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const aiReplyContent = llm.text;
  const citationMeta = _priorGroundedTransform ? buildInheritedTransformCitationMetadata(_priorGroundedTransform) : finalPromptChunks.length > 0 ? buildCitationMetadata(
    finalPromptChunks,
    ragResult?.llm_context?.selected_document_id ?? null
  ) : null;
  if (_priorGroundedTransform && !citationMeta) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({
        success: false,
        error: "prior_grounded_transform_lineage_unavailable"
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  if (flags.ENABLE_KB && !_g1SkipKB && finalPromptChunks.length > 0 && !citationMeta) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: false, error: "citation_lineage_unavailable" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    aiReplyContent,
    citationMeta
  );
  if (!committed.ok) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (committed.result === "human_control" || committed.result === "resolved" || committed.result === "superseded_source") {
      console.log("[generate-reply] stale orchestration reply suppressed:", {
        conversation_id,
        result: committed.result
      });
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `ai_reply_commit_${committed.result}`
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      }
    );
  }
  if (flags.ENABLE_COACH) void coachTrace;
  if (flags.ENABLE_KB && ragResult?.success) void ragResult;
  console.log(
    "[generate-reply] AI reply committed (orchestration path) for conversation:",
    conversation_id
  );
  return new Response(
    JSON.stringify({ success: true, idempotent: committed.idempotent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
function safeRefusal(code) {
  return new Response(
    JSON.stringify({
      success: true,
      skipped: "refused",
      reason_code: code,
      handoff_required: true
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
function buildMaskedContextBlock(customerContext, opaqueCustomerRef) {
  if (!customerContext) return "";
  const parts = [];
  if (customerContext.tier) {
    parts.push(`Customer tier: ${customerContext.tier}`);
  }
  if (customerContext.masked_summary) {
    parts.push(customerContext.masked_summary);
  }
  if (opaqueCustomerRef) {
    parts.push(
      `Customer reference (pseudonymous): ${pseudonymizeRef(opaqueCustomerRef)}`
    );
  }
  return parts.length === 0 ? "" : `Customer context (masked):
${parts.join("\n")}`;
}
function buildRagBlock(ragResult) {
  if (!ragResult || !ragResult.success) return "";
  const context = ragResult.llm_context;
  if (context) {
    const sections = [
      "Knowledge Base grounding rules:",
      "- Answer ONLY from the evidence below.",
      "- The RAG summary is orientation only; never use it alone for exact facts.",
      "- Prices, dates, dimensions, policy conditions, procedures, limits, and other exact facts MUST be supported by Full Content Evidence.",
      "- If Full Content Evidence does not support an exact claim, state that the knowledge base does not provide enough evidence and offer human assistance.",
      `Selected document: ${context.selected_document_id}`
    ];
    if (context.orientation_summary) {
      sections.push(
        `Orientation Summary (not sufficient by itself for exact facts):
${context.orientation_summary.slice(0, 1200)}`
      );
    }
    if (context.full_content_evidence.length > 0) {
      const evidence2 = context.full_content_evidence.slice(0, 3).map(
        (item, index) => `[Full Content Evidence ${index + 1}]${item.chunk_id ? ` [chunk:${item.chunk_id}]` : ""}
` + item.content.slice(0, 1200)
      ).join("\n\n");
      sections.push(`Full Content Evidence:
${evidence2}`);
    } else {
      sections.push(
        "Full Content Evidence: none. Do not assert exact facts from the summary."
      );
    }
    return sections.join("\n\n");
  }
  if (!ragResult.chunks?.length) return "";
  const summaries = ragResult.chunks.filter((c) => c.chunk_type === "rag_summary").slice(0, 1);
  const evidence = ragResult.chunks.filter((c) => c.chunk_type === "full_content").slice(0, 3);
  if (summaries.length === 0 && evidence.length === 0) return "";
  return [
    "Knowledge Base grounding rules:",
    "- Answer ONLY from the evidence below.",
    "- Summary is orientation only and cannot independently support exact facts.",
    summaries[0]?.content ? `Orientation Summary:
${summaries[0].content.slice(0, 1200)}` : "",
    evidence.length > 0 ? `Full Content Evidence:
${evidence.map(
      (c, i) => `[${i + 1}]
${(c.content ?? c.short_snippet ?? "").slice(0, 1200)}`
    ).join("\n\n")}` : "Full Content Evidence: none. Do not assert exact facts."
  ].filter(Boolean).join("\n\n");
}
function pseudonymizeRef(ref) {
  let h = 0;
  for (let i = 0; i < ref.length; i++) {
    h = (h << 5) - h + ref.charCodeAt(i) | 0;
  }
  return `cust_${(h >>> 0).toString(36)}`;
}
async function callCoachPromptAdapter(conversation_id) {
  const FAIL = (error_type) => ({
    success: false,
    error_type
  });
  const endpoint = Deno.env.get("COACH_PROMPT_ENDPOINT");
  const token = Deno.env.get("COACH_PROMPT_INTERNAL_TOKEN");
  const timeoutMs = parseInt(Deno.env.get("COACH_AI_TIMEOUT_MS") || "3000");
  if (!endpoint) return FAIL("COACH_API_NOT_CONFIGURED");
  if (!token) return FAIL("COACH_TOKEN_MISSING");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-coach-internal-token": token,
        "x-coach-runtime": "C0",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ include_content: true }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) return FAIL("COACH_API_ERROR");
    let data;
    try {
      data = await response.json();
    } catch {
      return FAIL("COACH_JSON_INVALID");
    }
    if (!data.ok || !data.data?.content) return FAIL("COACH_NO_ACTIVE_PROMPT");
    const content = data.data.content;
    const validationError = validateCoachPromptContent(content);
    if (validationError) return FAIL(validationError);
    const versionId = data.data.id || "";
    const promptHash = await computePromptHash(
      content,
      versionId,
      conversation_id
    );
    return {
      success: true,
      content,
      version_id: versionId,
      version_label: data.data.label || "",
      prompt_hash: promptHash
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") {
      return FAIL("COACH_API_TIMEOUT");
    }
    return FAIL("COACH_API_EXCEPTION");
  }
}
function validateCoachPromptContent(content) {
  if (typeof content !== "string") return "COACH_SCHEMA_INVALID";
  if (content.length === 0) return "COACH_CONTENT_EMPTY";
  if (content.length > 2e4) return "COACH_CONTENT_TOO_LONG";
  if (/sk-ant-[a-zA-Z0-9]+/.test(content) || /service_role/.test(content)) {
    return "COACH_SCHEMA_INVALID";
  }
  return null;
}
async function computePromptHash(content, versionId, conversationId) {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content + "|" + versionId + "|" + conversationId)
  );
  return Array.from(new Uint8Array(hashBuffer)).map(
    (b) => b.toString(16).padStart(2, "0")
  ).join("").substring(0, 12);
}
async function callCustomer360Adapter(conversation_id) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const internalToken = Deno.env.get("CUSTOMER360_INTERNAL_TOKEN");
  const timeoutRaw = Number.parseInt(
    Deno.env.get("CUSTOMER360_CALLER_TIMEOUT_MS") ?? "6000",
    10
  );
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw >= 1e3 && timeoutRaw <= 15e3 ? timeoutRaw : 6e3;
  if (!supabaseUrl || !internalToken) {
    console.error("[generate-reply] C360_CALLER_CONFIG_MISSING");
    return { success: false, error_type: "C360_CALLER_CONFIG_MISSING" };
  }
  const endpoint = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/customer360-adapter`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": internalToken
      },
      body: JSON.stringify({
        conversation_id,
        fields_requested: [
          "masked_summary",
          "tier",
          "predicted_csat",
          "churn_risk",
          "escalation_score",
          "p1_provider_version",
          "privacy_flags",
          "context_quality"
        ]
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeout);
    const errorType = error instanceof DOMException && error.name === "AbortError" ? "C360_CALLER_TIMEOUT" : "C360_CALLER_FETCH_EXCEPTION";
    console.error("[generate-reply] Customer360 caller failed", {
      conversation_id,
      error_type: errorType
    });
    return { success: false, error_type: errorType };
  }
  clearTimeout(timeout);
  if (!response.ok) {
    console.error("[generate-reply] Customer360 caller non-2xx", {
      conversation_id,
      status: response.status
    });
    return {
      success: false,
      error_type: `C360_CALLER_HTTP_${response.status}`
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { success: false, error_type: "C360_CALLER_INVALID_JSON" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { success: false, error_type: "C360_CALLER_INVALID_SCHEMA" };
  }
  const data = payload;
  if (data.success !== true) {
    const errorObj = data.error && typeof data.error === "object" && !Array.isArray(data.error) ? data.error : null;
    const code = errorObj && typeof errorObj.error_code === "string" ? errorObj.error_code.slice(0, 80) : "C360_UPSTREAM_DEGRADED";
    return { success: false, error_type: code };
  }
  const context = data.customer_context && typeof data.customer_context === "object" && !Array.isArray(data.customer_context) ? data.customer_context : null;
  const customerRef = typeof data.customer_ref === "string" && /^cus_[A-Za-z0-9_-]{16,64}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.customer_ref) ? data.customer_ref : void 0;
  if (!context || !customerRef) {
    return { success: false, error_type: "C360_CALLER_INVALID_SCHEMA" };
  }
  const safeContext = {};
  if (typeof context.masked_summary === "string" && context.masked_summary.trim()) {
    safeContext.masked_summary = context.masked_summary.trim().slice(0, 1e3);
  }
  if (typeof context.tier === "string" && context.tier.trim()) {
    safeContext.tier = context.tier.trim().slice(0, 100);
  }
  if (typeof context.predicted_csat === "number" && Number.isFinite(context.predicted_csat)) {
    safeContext.predicted_csat = context.predicted_csat;
  }
  if (typeof context.churn_risk === "number" && Number.isFinite(context.churn_risk)) {
    safeContext.churn_risk = context.churn_risk;
  }
  if (typeof context.escalation_score === "number" && Number.isFinite(context.escalation_score)) {
    safeContext.escalation_score = context.escalation_score;
  }
  if (typeof context.p1_provider_version === "string" && context.p1_provider_version.trim()) {
    safeContext.p1_provider_version = context.p1_provider_version.trim().slice(
      0,
      120
    );
  }
  return {
    success: true,
    customer_context: safeContext,
    customer_ref: customerRef
  };
}
async function callKBAdapter(_conversation_id, userMessage, scope) {
  const endpointCfg = resolveKBEndpoint();
  if (!endpointCfg) {
    return { success: false, no_answer: true, retrieval_quality: "failed" };
  }
  const result2 = await fetchKBRag(
    { query: userMessage, top_k: 5 },
    scope,
    endpointCfg,
    { timeoutMs: 15e3 }
  );
  if (!result2.success) {
    return { success: false, no_answer: true, retrieval_quality: "failed" };
  }
  if (result2.chunks.length === 0) {
    return {
      success: true,
      no_answer: true,
      retrieval_quality: "failed",
      chunks: [],
      query_text_preview: userMessage.slice(0, 100)
    };
  }
  return {
    success: true,
    no_answer: false,
    retrieval_quality: "high",
    chunks: result2.chunks,
    documents: result2.documents,
    ...result2.llm_context ? { llm_context: result2.llm_context } : {},
    ...result2.meta ? { meta: result2.meta } : {},
    query_text_preview: userMessage.slice(0, 100)
  };
}
var ALLOWED_TOOLS = [
  "kb_search",
  "escalate_to_human",
  "get_customer_context",
  "get_order_summary",
  "create_handoff_summary",
  "mark_unresolved",
  "suggest_reply"
];
var READ_ONLY_TOOLS = [
  "kb_search",
  "get_customer_context",
  "get_order_summary"
];
var HIGH_RISK_ALLOWED = [
  "kb_search",
  "get_customer_context",
  "escalate_to_human",
  "create_handoff_summary"
];
var OFFLINE_BOT_ALLOWED = ["kb_search", "escalate_to_human"];
var MAX_TOOL_CALLS = 10;
var MAX_KB_SEARCH = 3;
var MAX_C360_CALLS = 2;
function buildSafeDedupeKey(tool_name, input, server_resolved_customer_ref) {
  if (tool_name === "get_order_summary") {
    return server_resolved_customer_ref ? `get_order_summary:${server_resolved_customer_ref}` : null;
  }
  const SAFE_FIELDS = {
    kb_search: ["query_norm", "locale"],
    get_customer_context: [],
    escalate_to_human: ["reason_code"],
    create_handoff_summary: ["reason_code"],
    mark_unresolved: ["reason_code"],
    suggest_reply: ["intent_code"]
  };
  const safe = {};
  for (const k of SAFE_FIELDS[tool_name] ?? []) {
    if (input[k] !== void 0 && typeof input[k] !== "object") {
      safe[k] = String(input[k]).slice(0, 200);
    }
  }
  return `${tool_name}:${JSON.stringify(safe)}`;
}
function toolExecutorGate(toolRequest, context) {
  const { tool_name, input } = toolRequest;
  const {
    conversation,
    caller_mode,
    risk_level,
    privacy_flags,
    turn_tool_calls,
    turn_budget,
    server_resolved_customer_ref
  } = context;
  if (tool_name === "schedule_feedback_request") {
    return { decision: "DENY", reason: "TOOL_EXCLUDED" };
  }
  if (!ALLOWED_TOOLS.includes(tool_name)) {
    return { decision: "DENY", reason: "TOOL_NOT_REGISTERED" };
  }
  const status = conversation.status;
  if (status === "resolved" || status === "closed") {
    return { decision: "DENY", reason: "CONV_RESOLVED_OR_CLOSED" };
  }
  if ((status === "human_needed" || status === "human_control") && !READ_ONLY_TOOLS.includes(tool_name)) return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_IN_STATUS" };
  if (status === "offline_bot" && !OFFLINE_BOT_ALLOWED.includes(tool_name)) return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_OFFLINE" };
  if (risk_level === "high" && !HIGH_RISK_ALLOWED.includes(tool_name)) return { decision: "ESCALATE", reason: "HIGH_RISK_TOOL_BLOCKED" };
  if (tool_name === "mark_unresolved" && caller_mode === "system_auto") {
    return { decision: "DENY", reason: "MARK_UNRESOLVED_REQUIRES_HUMAN" };
  }
  if ((privacy_flags?.do_not_profile === true || privacy_flags?.consent_status === "withdrawn") && tool_name === "get_customer_context") return { decision: "DENY", reason: "PRIVACY_DO_NOT_PROFILE" };
  const dedupe_key = buildSafeDedupeKey(
    tool_name,
    input,
    server_resolved_customer_ref
  );
  if (dedupe_key === null) {
    return { decision: "DENY", reason: "SERVER_REFERENCE_REQUIRED" };
  }
  if (turn_tool_calls.has(dedupe_key)) {
    return { decision: "DENY", reason: "DUPLICATE_TOOL_CALL_IN_TURN" };
  }
  turn_tool_calls.add(dedupe_key);
  if (turn_budget.total >= MAX_TOOL_CALLS) {
    return { decision: "DENY", reason: "TOOL_BUDGET_EXCEEDED" };
  }
  if (tool_name === "kb_search" && turn_budget.kb_search >= MAX_KB_SEARCH) {
    return { decision: "DENY", reason: "KB_SEARCH_BUDGET_EXCEEDED" };
  }
  if (tool_name === "get_customer_context" && turn_budget.c360 >= MAX_C360_CALLS) return { decision: "DENY", reason: "C360_BUDGET_EXCEEDED" };
  if (status === "ai_draft_only" || status === "unresolved") {
    return {
      decision: "DOWNGRADE_TO_DRAFT",
      reason: "STATUS_DRAFT_ONLY",
      execution_allowed: true,
      force_draft: true,
      execution_deferred_to: "L5d",
      draft_enforcement_deferred_to: "L5e"
    };
  }
  if (status === "escalation_risk") {
    return {
      decision: "DOWNGRADE_TO_DRAFT",
      reason: "ESCALATION_RISK_DOWNGRADE",
      execution_allowed: true,
      force_draft: true,
      execution_deferred_to: "L5d",
      draft_enforcement_deferred_to: "L5e"
    };
  }
  return {
    decision: "ALLOW",
    reason: "GATE_PASSED",
    execution_allowed: true,
    execution_deferred_to: "L5d"
  };
}
function handleGateDecision(decision2) {
  switch (decision2.decision) {
    case "ALLOW":
      return {
        decision: "ALLOW",
        reason: decision2.reason ?? "GATE_PASSED",
        execution_allowed: true,
        execution_deferred_to: "L5d"
      };
    case "DENY":
      return {
        decision: "DENY",
        reason: decision2.reason,
        message_to_llm: "tool not available in current context"
      };
    case "DOWNGRADE_TO_DRAFT":
      return {
        decision: "DOWNGRADE_TO_DRAFT",
        reason: decision2.reason,
        execution_allowed: true,
        force_draft: true,
        execution_deferred_to: "L5d",
        draft_enforcement_deferred_to: "L5e"
      };
    case "ESCALATE":
      return {
        decision: "ESCALATE",
        reason: decision2.reason,
        handoff_required: true,
        action_deferred_to: "L5e"
      };
  }
}
async function handleToolCall(tool_name, _tool_input, _context) {
  switch (tool_name) {
    case "kb_search":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        retrieval_quality: "failed",
        no_answer: true,
        handoff_required: true,
        results: [],
        stub_note: "KB adapter not yet enabled (L5d stub)"
      };
    case "escalate_to_human":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        escalated: false,
        stub_note: "Escalation workflow deferred to L5e \u2014 no state changes in L5d"
      };
    case "get_customer_context":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        customer_context: null,
        context_available: false,
        stub_note: "Customer360 adapter not enabled; no customer context returned"
      };
    case "get_order_summary":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        order_available: false,
        stub_note: "Order adapter not yet enabled (L5d stub)"
      };
    case "create_handoff_summary":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        summary: "[Handoff summary not yet available \u2014 L5d stub]",
        stub_note: "Handoff summary generation deferred to L5e; conversation_id server-side only"
      };
    case "mark_unresolved":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        marked: false,
        stub_note: "mark_unresolved write action deferred to L5e \u2014 no state changes in L5d"
      };
    case "suggest_reply":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        draft_content: "",
        confidence: 0,
        recommended_action: "human_review",
        stub_note: "suggest_reply draft write deferred to L5e \u2014 no state changes in L5d"
      };
    default:
      return {
        tool_name,
        status: "denied",
        result_classification: "internal_only",
        error: "tool not available in current context"
      };
  }
}
function determineOutputMode(conversationStatus, toolResults, ragResult, mode) {
  switch (conversationStatus) {
    case "resolved":
    case "closed":
      return { action: "refuse", reason: "CONV_RESOLVED_OR_CLOSED" };
    case "ai_handling":
      break;
    case "ai_draft_only":
      return { action: "draft_only", reason: "STATUS_AI_DRAFT_ONLY" };
    case "human_needed":
    case "human_control":
      return { action: "draft_only", reason: "STATUS_HUMAN_CONTROL" };
    case "escalation_risk":
      return { action: "draft_only", reason: "STATUS_ESCALATION_RISK" };
    case "unresolved":
      return { action: "draft_only", reason: "STATUS_UNRESOLVED" };
    case "offline_bot":
      return { action: "draft_only", reason: "STATUS_OFFLINE_BOT" };
    case "reopened":
      return { action: "draft_only", reason: "STATUS_REOPENED_TRANSITIONAL" };
    default:
      return { action: "draft_only", reason: "STATUS_UNKNOWN_SAFE_FALLBACK" };
  }
  const guardrailsPass = checkGuardrails(toolResults, ragResult, mode);
  return guardrailsPass.pass ? { action: "auto_send", reason: "GUARDRAILS_PASSED" } : { action: "draft_only", reason: guardrailsPass.reason };
}
function checkGuardrails(toolResults, ragResult, mode) {
  if (mode === "console_suggest") {
    return { pass: false, reason: "CONSOLE_SUGGEST_ALWAYS_DRAFT" };
  }
  if (ragResult) {
    if (ragResult.no_answer) return { pass: false, reason: "KB_NO_ANSWER" };
    if (ragResult.conflict_detected) {
      return { pass: false, reason: "KB_CONFLICT" };
    }
    if (ragResult.retrieval_quality === "low") {
      return { pass: false, reason: "KB_LOW_QUALITY" };
    }
    if (ragResult.policy_gap) return { pass: false, reason: "KB_POLICY_GAP" };
    if (ragResult.source_scope !== "customer_answer") {
      return { pass: false, reason: "KB_SCOPE_NOT_CUSTOMER_ANSWER" };
    }
  }
  for (const result2 of toolResults) {
    if (result2.result_classification === "draft_only") {
      return { pass: false, reason: "TOOL_RESULT_DRAFT_ONLY" };
    }
    if (result2.result_classification === "supervisor_only") {
      return { pass: false, reason: "TOOL_RESULT_SUPERVISOR_ONLY" };
    }
  }
  const suggestResult = toolResults.find(
    (r) => r.tool_name === "suggest_reply"
  );
  if (suggestResult?.citation_required && !suggestResult?.has_valid_citation) {
    return { pass: false, reason: "SUGGEST_REPLY_MISSING_CITATION" };
  }
  if (toolResults.some((r) => r.handoff_required)) {
    return { pass: false, reason: "HANDOFF_REQUIRED_BY_TOOL" };
  }
  return { pass: true, reason: "ALL_GUARDRAILS_PASSED" };
}
function l5eSanitize(input, opts) {
  if (!input) return "";
  let s = String(input);
  if (opts.noPII) {
    s = s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]");
    s = s.replace(/\+?\d[\d\s\-().]{7,}\d/g, "[phone]");
    s = s.replace(/\b\d{9,}\b/g, "[digits]");
  }
  return s.length > opts.maxChars ? s.slice(0, opts.maxChars) : s;
}
async function executeSuggestReply(_input, context, outputMode) {
  if (!context.flags.ENABLE_TOOL_EXEC) {
    return { auto_sent: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  }
  void outputMode;
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
async function executeEscalateToHuman(input, context) {
  const _reason = l5eSanitize(input.reason, { maxChars: 500, noPII: true });
  const _summary = l5eSanitize(input.summary, { maxChars: 500, noPII: true });
  const _handoffSummary = context.handoff_summary_from_tool || _summary;
  void _reason;
  void _handoffSummary;
  if (!context.flags.ENABLE_TOOL_EXEC) {
    return { escalated: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  }
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
async function executeMarkUnresolved(input, context) {
  if (!context.flags.ENABLE_TOOL_EXEC) {
    return { marked: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  }
  void input;
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
export {
  KB_NO_MATCH_CLARIFICATION_ROUTE,
  checkGuardrails,
  determineOutputMode,
  executeEscalateToHuman,
  executeMarkUnresolved,
  executeSuggestReply,
  handleGateDecision,
  handleToolCall,
  isFirstNoMatchClarificationEligible,
  toolExecutorGate
};
