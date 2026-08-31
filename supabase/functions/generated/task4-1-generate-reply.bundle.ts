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
    const result = RULES[ruleId](context, gaps, warnings);
    if (result) return result;
  }
  return decision(null, "continue_ai", null, "no_escalation", gaps, warnings);
}

// supabase/functions/_shared/conversation-intelligence.ts
var HUMAN_ZH = /(真人|人工|客服)/;
var HUMAN_EN = /\b(human|live agent|human agent|real person|support agent|customer service)\b/i;
var NEG_ZH = /(唔好|不要|唔使|不用|毋須|毋需|別|别|未需要|未要|而家未|現在未|唔係|不是|並非|并非|未叫|冇叫|没有叫|沒有叫|禁止|不准|唔准)/;
var NEG_EN = /\b(don't|do not|didn't|did not|not asking|not ask|no need|don't need|do not need|not yet|without|never)\b/i;
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
var EXPLICIT_ZH = /(而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,5}(真人|人工|客服)|(請|请|麻煩|麻烦).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,5}(真人|人工|客服)|(我要|我想|我需要).{0,5}(真人|人工|客服)/;
var EXPLICIT_EN = /\b(please\s+)?(connect|transfer|put|let)\s+me\s+(to|through to)\s+(a\s+)?(human|live agent|human agent|real person)|\b(i want|i need|let me speak to|i want to speak to|i need to speak to)\s+(a\s+)?(human|live agent|human agent|real person)(\s+now)?\b/i;
function detectLanguage(text) {
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  return /[转们为这没请]/.test(text) ? "zh-CN" : "zh-TW";
}
function classifyHandoffIntent(text) {
  const t = text.normalize("NFKC").trim();
  const language = detectLanguage(t);
  const hasHuman = HUMAN_ZH.test(t) || HUMAN_EN.test(t);
  if (!hasHuman) return { kind: "none", explicit_request: false, pure_negation: false, language, reason: "no_human_support_reference" };
  if (NEG_ZH.test(t) || NEG_EN.test(t)) {
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
var TRIVIAL = /^(hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|ok|okay|好的|好|嗯|謝謝|谢谢|thanks|thank you)[!！。.？?，,\s]*$/i;
var CORRECTION = /(我講錯|我说错|我說錯|更正|其實係|其实是|唔係.*係|不是.*是|改返|改成|actually|correction|i meant|not .* but )/i;
var FOLLOW_UP_ZH = /^(咁|那|那麼|那么|所以|另外|仲有|还有|咁如果|那如果)/;
var FOLLOW_UP_EN = /^(then|so|also|what about|and what about|in that case)\b/i;
var DOMAIN_ONLY = /^(我有|我想問|我想问|想問|想问|請問|请问)?\s*(一個|一个|個|个)?\s*(訂單|订单|退款|退貨|退货|換貨|换货|送貨|送货|物流|付款|產品|产品|保養|保修|維修|维修|問題|问题)\s*(問題|问题|嘅問題|的問題)?[。.!！?？\s]*$/;
var VAGUE_REFERENCE = /^(之前嗰樣嘢|之前那件事|之前那个|嗰樣嘢|那個事情|那个事情|same thing|that thing|the previous thing)[。.!！?？\s]*$/i;
function classifyConversationTurn(text) {
  const t = text.normalize("NFKC").trim();
  if (!t || TRIVIAL.test(t)) return { kind: "trivial", should_clarify_before_kb: false, reason: "trivial_or_greeting" };
  if (CORRECTION.test(t)) return { kind: "correction", should_clarify_before_kb: false, reason: "latest_turn_corrects_prior_context" };
  if (FOLLOW_UP_ZH.test(t) || FOLLOW_UP_EN.test(t)) return { kind: "follow_up", should_clarify_before_kb: false, reason: "follow_up_requires_history" };
  if (DOMAIN_ONLY.test(t) || VAGUE_REFERENCE.test(t)) {
    return { kind: "underspecified", should_clarify_before_kb: true, reason: "semantic_intent_present_but_required_detail_missing" };
  }
  return { kind: "specific", should_clarify_before_kb: false, reason: "specific_enough_for_normal_routing" };
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
function cleanContinuityText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
var CUSTOMER_ROLES = /* @__PURE__ */ new Set(["visitor", "customer", "user"]);
var CORRECTION_OR_CONSTRAINT = /(我講錯|我说错|我說錯|更正|其實係|其实是|唔係.*係|不是.*是|改返|改成|唔好|不要|不准|唔准|只係想知|只是想知道|只想知道|actually|i meant|correction|don't|do not|not .* but|only asking|just asking)/i;
function buildConversationContinuityBlock(newestFirstMessages) {
  const customerTurns = newestFirstMessages.filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase())).map((row) => cleanContinuityText(row.content)).filter(Boolean).slice(0, 20);
  if (customerTurns.length < 2) return "";
  const corrections = customerTurns.filter((text) => CORRECTION_OR_CONSTRAINT.test(text)).slice(0, 6);
  const recent = customerTurns.slice(0, 8);
  const lines = [
    "Conversation continuity (internal guidance; never quote this block):",
    "- Treat the newest customer statement as authoritative when it corrects, narrows, cancels, or forbids an earlier request.",
    "- Do not re-ask a detail already supplied unless the customer made it ambiguous or contradictory.",
    "- Keep unresolved follow-up questions in context; do not pretend an action was requested when the customer only asked whether it is possible."
  ];
  if (corrections.length) {
    lines.push("Latest corrections / constraints (newest first):");
    corrections.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  }
  lines.push("Recent customer turns (newest first):");
  recent.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  return lines.join("\n").slice(0, 5e3);
}
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
function hasCeProvenance(input) {
  return Boolean(
    input.expected_tenant_id && input.sentiment_provider_version?.trim() && input.sentiment_evaluation_id?.trim()
  );
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
  const ceProvenanceOk = hasCeProvenance(input);
  const ceSignalPresent = input.anger_flag === true || typeof input.sentiment_score === "number" || Array.isArray(input.sentiment_trend) || input.sentiment_recovered_same_turn === true;
  if (ceSignalPresent && !ceProvenanceOk) {
    providerWarnings.push("CE_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE");
  }
  if (ceProvenanceOk) {
    const ceMeta = {
      provider_version: input.sentiment_provider_version,
      reason: `evaluation_id:${input.sentiment_evaluation_id}`,
      tenant_id: input.expected_tenant_id
    };
    if (input.anger_flag === true) {
      context.anger_flag = availableSignal(
        true,
        "conversation_evaluation",
        ceMeta
      );
    }
    if (typeof input.sentiment_score === "number" && Number.isFinite(input.sentiment_score)) {
      context.sentiment_score = availableSignal(
        input.sentiment_score,
        "conversation_evaluation",
        ceMeta
      );
    }
    if (Array.isArray(input.sentiment_trend) && input.sentiment_trend.length >= 2 && input.sentiment_trend.every((n) => typeof n === "number" && Number.isFinite(n))) {
      context.sentiment_trend = availableSignal(
        input.sentiment_trend,
        "conversation_evaluation",
        ceMeta
      );
    }
    if (input.sentiment_recovered_same_turn === true) {
      context.sentiment_recovered_same_turn = availableSignal(
        true,
        "conversation_evaluation",
        {
          ...ceMeta,
          reason: `evaluation_id:${input.sentiment_evaluation_id}:recovery`
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
  const result = evaluateFullEscalationRuleset(context, {
    activation: { enabled }
  });
  if (result.matched_rule === "R3" || result.matched_rule === "P1") {
    const advisoryDecision = result.matched_rule === "R3" ? "recommend_handoff" : "suggest_handoff";
    if (result.decision !== advisoryDecision) {
      providerWarnings.push("ADVISORY_RULE_DECISION_DOWNGRADED");
    }
    return {
      evaluated: true,
      matched_rule: result.matched_rule,
      decision: advisoryDecision,
      reason_code: result.reason_code,
      signal_gaps: result.signal_gaps,
      provider_warnings: [...result.provider_warnings, ...providerWarnings]
    };
  }
  return {
    evaluated: true,
    matched_rule: result.matched_rule,
    decision: result.decision,
    reason_code: result.reason_code,
    signal_gaps: result.signal_gaps,
    provider_warnings: [...result.provider_warnings, ...providerWarnings]
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
  const result = String(payload.result ?? "unexpected_result");
  switch (result) {
    case "success":
    case "already_handled":
      return { ok: true, result, data: payload };
    case "already_resolved":
    case "already_under_human_control":
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "invalid_priority":
    case "not_found":
      return { ok: false, result, data: payload };
    default:
      return {
        ok: false,
        result: "unexpected_result",
        detail: result,
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
  const result = String(payload.result ?? "unexpected_result");
  switch (result) {
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
      return { ok: false, result, data: payload };
    default:
      return { ok: false, result: "unexpected_result", detail: result, data: payload };
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
  const result = String(payload.result ?? "unexpected_result");
  switch (result) {
    case "success":
    case "already_handled":
      return { ok: true, result, data: payload };
    case "max_clarifications_reached":
      if (input.decision.reason_code === "clarification_new_intent_no_kb_match") {
        return await persistNewIntentClarificationThroughAiGate(
          client,
          input,
          clarification
        );
      }
      return { ok: false, result, data: payload };
    case "already_resolved":
    case "already_under_human_control":
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "not_found":
      return { ok: false, result, data: payload };
    default:
      return { ok: false, result: "unexpected_result", detail: result, data: payload };
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
  const obj = body ?? {};
  const candidate = Array.isArray(obj.candidates) ? obj.candidates[0] : void 0;
  const parts = candidate?.content?.parts;
  const text = Array.isArray(parts) ? parts.filter((p) => p?.thought !== true && typeof p?.text === "string").map((p) => p.text).join("").trim() : "";
  const usage = obj.usageMetadata;
  return {
    text,
    input_tokens: num(usage?.promptTokenCount),
    output_tokens: num(usage?.candidatesTokenCount) + num(usage?.thoughtsTokenCount),
    finish_reason: typeof candidate?.finishReason === "string" ? candidate.finishReason : null,
    block_reason: typeof obj.promptFeedback?.blockReason === "string" ? obj.promptFeedback.blockReason : null
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
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "[UUID]"
  ],
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
  return createClient2(
    Deno.env.get("SUPABASE_URL"),
    getSupabaseAdminKey()
  );
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
var GENERATION_MAX_TOKENS_DEFAULT = 2048;
var GENERATION_MAX_TOKENS_MIN = 768;
var GENERATION_MAX_TOKENS_MAX = 8192;
function resolveGenerationMaxTokens() {
  const raw = (Deno.env.get("LLM_MAX_OUTPUT_TOKENS_GENERATION") ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : GENERATION_MAX_TOKENS_DEFAULT;
  return Math.max(
    GENERATION_MAX_TOKENS_MIN,
    Math.min(GENERATION_MAX_TOKENS_MAX, candidate)
  );
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
      const obj = body;
      const text = Array.isArray(obj.content) ? obj.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim() : "";
      return {
        text,
        input_tokens: Number(obj.usage?.input_tokens ?? 0),
        output_tokens: Number(obj.usage?.output_tokens ?? 0),
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
function vertexAdapter(serviceAccountJson, projectId, region, model, safeSystem, safeUser, maxTokens, jsonOutput, responseSchema) {
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
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0,
            // Gemini honours a response mime type; callers that require a JSON
            // object get one without fences or prose. A response schema pins
            // field names and primitive types, which prompt text alone does
            // not (Gemini otherwise renames keys and stringifies numbers).
            ...jsonOutput ? { responseMimeType: "application/json" } : {},
            ...jsonOutput && responseSchema ? { responseSchema } : {}
          }
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
  const timeoutMs = Number(
    Deno.env.get("LLM_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS
  );
  const nonEmpty2 = (v) => !!v && v.trim().length > 0;
  const configMissing = async (providerLabel, modelLabel) => {
    usage.latency_ms = Date.now() - started;
    log(call.tag, {
      event: "config_missing",
      request_id: requestId,
      provider: providerLabel,
      purpose: call.purpose
    });
    await recordUsage(
      call,
      providerLabel,
      modelLabel,
      "failed",
      0,
      usage,
      "LLM_CONFIG_MISSING"
    );
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
      await recordUsage(
        call,
        provider,
        model,
        "blocked",
        0,
        usage,
        "LLM_INPUT_BLOCKED"
      );
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
      call.responseSchema
    );
  } else {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!nonEmpty2(key)) {
      return await configMissing(provider, model);
    }
    if (looksLikeInjection(call.user)) {
      usage.latency_ms = Date.now() - started;
      log(call.tag, { event: "input_blocked", request_id: requestId });
      await recordUsage(
        call,
        provider,
        model,
        "blocked",
        0,
        usage,
        "LLM_INPUT_BLOCKED"
      );
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
      usage.latency_ms = Date.now() - started;
      log(call.tag, {
        event: "success",
        request_id: requestId,
        provider: adapter.id,
        attempt,
        model: adapter.model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ms: usage.latency_ms
      });
      await recordUsage(
        call,
        adapter.id,
        adapter.model,
        "success",
        res.status,
        usage
      );
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
  const result = await callModel({
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
  if (!result.ok) {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: `policy_provider_${result.code.toLowerCase()}`
    };
  }
  const parsed = parseJsonObject(result.text);
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

// supabase/functions/generate-reply/index.ts
import { createClient as createClient3 } from "https://esm.sh/@supabase/supabase-js@2";
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
  "zh-TW": "\u6211\u5011\u5DF2\u5C07\u4F60\u7684\u5C0D\u8A71\u8A18\u9304\uFF0C\u5BA2\u670D\u63A5\u624B\u5F8C\u6703\u5728\u6B64\u5C0D\u8A71\u4E2D\u56DE\u8986\u4F60\u3002\u76EE\u524D\u672A\u555F\u7528\u5373\u6642\u8F2A\u5019\u6642\u9593\u986F\u793A\u3002",
  "zh-CN": "\u6211\u4EEC\u5DF2\u5C06\u4F60\u7684\u5BF9\u8BDD\u8BB0\u5F55\uFF0C\u5BA2\u670D\u63A5\u624B\u540E\u4F1A\u5728\u6B64\u5BF9\u8BDD\u4E2D\u56DE\u590D\u4F60\u3002\u76EE\u524D\u672A\u542F\u7528\u5B9E\u65F6\u6392\u961F\u4F4D\u7F6E\u548C\u9884\u8BA1\u7B49\u5F85\u65F6\u95F4\u663E\u793A\u3002",
  en: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled."
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
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted_email]");
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
    console.error("[generate-reply] final_prompt_trace insert failed (non-blocking):", e);
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
  return 502;
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
      return "LLM_EMPTY_RESPONSE";
    case "LLM_INVALID_OUTPUT":
      return "LLM_EMPTY_RESPONSE";
  }
}
async function cleanupThinking(supabaseAdmin, conversation_id, source_message_id) {
  if (!source_message_id) {
    console.error("[generate-reply] cleanupThinking skipped: missing source_message_id", conversation_id);
    return;
  }
  try {
    await supabaseAdmin.from("messages").delete().eq("conversation_id", conversation_id).eq("content", "__THINKING__").filter("metadata->>source_message_id", "eq", source_message_id);
  } catch (e) {
    console.error("[generate-reply] cleanupThinking failed (non-blocking):", e);
  }
}
async function loadSourceVisitorMessage(supabaseAdmin, conversation_id, source_message_id) {
  if (!source_message_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source_message_id)) {
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
  if (m.widget_live_test !== true || m.exclude_training !== true || typeof m.owner_user_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.owner_user_id)) return void 0;
  return {
    userId: m.owner_user_id,
    allowPreActivation: true
  };
}
function sourceBoundaryFilter(source) {
  return `created_at.lt.${source.created_at},and(created_at.eq.${source.created_at},id.lte.${source.id})`;
}
function sourceMessageErrorResponse(result) {
  const status = result.error === "source_message_lookup_failed" ? 500 : 400;
  return new Response(JSON.stringify({ success: false, error: result.error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
async function commitAiReplyWithControlGate(supabaseAdmin, conversation_id, source_message_id, content, metadata = null) {
  if (!source_message_id) return { ok: false, result: "invalid_source_message" };
  const { data, error } = await supabaseAdmin.rpc("commit_ai_reply_tx", {
    p_conversation_id: conversation_id,
    p_source_message_id: source_message_id,
    p_content: content,
    p_metadata: metadata
  });
  if (error) {
    console.error("[generate-reply] commit_ai_reply_tx RPC error:", {
      conversation_id,
      code: error.code
    });
    return { ok: false, result: "rpc_error" };
  }
  const payload = data ?? {};
  const result = String(payload.result ?? data ?? "unexpected_result");
  switch (result) {
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
      return { ok: false, result };
    default:
      return { ok: false, result: "unexpected_result" };
  }
}
function classifyExplicitHandoff(text) {
  const lang = detectHandoffLanguage(text);
  if (lang) return { rule: "R1", confidence: 1, trigger_span: text.slice(0, 100), language: lang };
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
  const lower = normalized.toLowerCase();
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
  const matched = explicitEnglishThreats.some((re) => re.test(lower)) || explicitChineseThreats.some((re) => re.test(normalized));
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
    console.error("[generate-reply] invalid ESC_E2_COMPLIANCE_REVIEW_BY_TENANT_JSON JSON");
    return void 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[generate-reply] compliance tenant map must be a JSON object");
    return void 0;
  }
  const tenantMap = parsed;
  if (!(expectedTenantId in tenantMap)) return void 0;
  const value = tenantMap[expectedTenantId];
  if (typeof value !== "boolean") {
    console.error("[generate-reply] compliance tenant value must be boolean", expectedTenantId);
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
    /說明/
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
  return ["angry", "anger", "furious", "rage", "irate", "\u61A4\u6012", "\u6124\u6012", "\u751F\u6C23", "\u751F\u6C14"].includes(value.trim().toLowerCase());
}
async function loadAuthoritativeR3SentimentSignals(supabaseAdmin, conversation_id, expected_tenant_id) {
  if (!expected_tenant_id) return void 0;
  const { data: freshness, error: freshnessError } = await supabaseAdmin.from("ce_evaluation_state").select(
    "conversation_id, company_id, state, last_success_evaluation_id, last_success_source, last_success_fingerprint, current_evaluation_fingerprint, last_success_at, last_activity_at"
  ).eq("conversation_id", conversation_id).eq("company_id", expected_tenant_id).maybeSingle();
  if (freshnessError || !freshness || freshness.state !== "up_to_date" || freshness.last_success_source !== "canonical" || !freshness.last_success_evaluation_id || !freshness.last_success_fingerprint || !freshness.current_evaluation_fingerprint || freshness.last_success_fingerprint !== freshness.current_evaluation_fingerprint) {
    return void 0;
  }
  if (freshness.last_activity_at && freshness.last_success_at) {
    const activityAt = Date.parse(String(freshness.last_activity_at));
    const successAt = Date.parse(String(freshness.last_success_at));
    if (!Number.isFinite(activityAt) || !Number.isFinite(successAt) || activityAt > successAt) {
      return void 0;
    }
  }
  const { data: evaluation, error: evaluationError } = await supabaseAdmin.from("conversation_evaluation").select("id, company_id, created_at, evaluation_fingerprint, freshness").eq("id", freshness.last_success_evaluation_id).eq("conversation_id", conversation_id).eq("company_id", expected_tenant_id).eq("freshness", "current").eq("evaluation_fingerprint", freshness.last_success_fingerprint).maybeSingle();
  if (evaluationError || !evaluation?.id || evaluation.id !== freshness.last_success_evaluation_id) {
    return void 0;
  }
  const { data: points, error: pointsError } = await supabaseAdmin.from("ce_emotion_point").select("turn_index, sentiment, sentiment_score, trigger_label, occurred_at").eq("evaluation_id", evaluation.id).eq("company_id", expected_tenant_id).order("turn_index", { ascending: true }).limit(20);
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
    if (previous < -0.2 && current >= 0 && current - previous >= 0.3) recovered = true;
  }
  return {
    ...anger ? { anger_flag: true } : {},
    ...latestScore !== void 0 ? { sentiment_score: latestScore } : {},
    ...scoreSeries.length >= 2 ? { sentiment_trend: scoreSeries.slice(-5) } : {},
    ...recovered ? { sentiment_recovered_same_turn: true } : {},
    evaluation_id: evaluation.id,
    provider_version: `ce-emotion-point-v1.1:${String(evaluation.evaluation_fingerprint).slice(0, 12)}`
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
  return (normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).join("");
}
function ngramSet(text, size) {
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i + size <= text.length; i += 1) out.add(text.slice(i, i + size));
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
  const record = metadata;
  if (record["escalation_action"] !== "clarification") return false;
  return record["escalation_rule"] === "R2" || record["response_route"] === KB_NO_MATCH_CLARIFICATION_ROUTE;
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
  const maxConsecutiveNoAnswer = readPositiveIntegerEnv("ESC_MAX_CONSECUTIVE_NO_ANSWER");
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
    console.error("[generate-reply] required-rules live blocked: missing source_message_id", params.conversation_id);
    return new Response(
      JSON.stringify({
        success: false,
        error: "required_escalation_missing_source_message_id",
        handoff_persisted: false
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const handoffClassification = classifyHandoffIntent(params.latest_message_content);
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
  context.conversation_status = availableSignal(params.conversation_status, "conversation_history");
  context.assigned_agent_id = availableSignal(params.assigned_agent_id, "conversation_history");
  context.greeting_or_trivial = availableSignal(params.greeting_or_trivial, "local_classifier");
  if (params.threat_flag !== void 0) {
    context.threat_flag = availableSignal(params.threat_flag.value, "local_classifier", {
      provider_version: params.threat_flag.provider_version,
      observed_at: (/* @__PURE__ */ new Date()).toISOString(),
      reason: params.threat_flag.reason,
      ...params.expected_tenant_id ? { tenant_id: params.expected_tenant_id } : {}
    });
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
    context.topic_risk_level = availableSignal(params.topic_risk_level, "local_classifier");
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
    context.turn_count = availableSignal(params.turn_count, "conversation_history");
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
    context.same_intent_repeated = availableSignal(true, "conversation_history", {
      reason: "exact_normalized_repeat"
    });
  }
  context.tenant_config = buildVerifiedTenantEscalationConfig();
  const decision2 = evaluateFullEscalationRuleset(context, {
    activation: { enabled }
  });
  if (decision2.decision === "clarify" && decision2.matched_rule === "R2" && enabled.has("R2")) {
    const clarification = R2_CLARIFICATION_SAFE_WORDING[params.visitor_language];
    const persisted2 = await persistRequiredEscalationClarification(supabaseAdmin, {
      conversation_id: params.conversation_id,
      source_message_id: params.source_message_id,
      decision: decision2,
      safe_reply_content: clarification
    });
    if (persisted2.ok) {
      await cleanupThinking(supabaseAdmin, params.conversation_id, params.source_message_id);
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
      return new Response(JSON.stringify({ success: true, skipped: "resolved", escalation_rule: "R2" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    if (persisted2.result === "already_under_human_control") {
      return new Response(JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: "R2" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
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
  const persisted = await persistRequiredEscalationHandoff(supabaseAdmin, {
    conversation_id: params.conversation_id,
    source_message_id: params.source_message_id,
    decision: decision2,
    safe_reply_content: safeReply
  });
  if (persisted.ok) {
    await cleanupThinking(supabaseAdmin, params.conversation_id, params.source_message_id);
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
        JSON.stringify({ success: true, skipped: "resolved", escalation_rule: decision2.matched_rule, handoff_persisted: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: decision2.matched_rule, handoff_persisted: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "invalid_priority":
    case "invalid_safe_reply":
      return new Response(
        JSON.stringify({ success: false, error: `required_escalation_${persisted.result}`, escalation_rule: decision2.matched_rule, handoff_persisted: false }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "rpc_transport_error":
      return new Response(
        JSON.stringify({ success: false, error: "required_escalation_rpc_transport_error", escalation_rule: decision2.matched_rule, handoff_persisted: false, handoff_uncertain: true }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    case "not_found":
      return new Response(
        JSON.stringify({ success: false, error: "required_escalation_conversation_not_found", escalation_rule: decision2.matched_rule, handoff_persisted: false }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    default:
      return new Response(
        JSON.stringify({ success: false, error: "required_escalation_unexpected_result", escalation_rule: decision2.matched_rule, handoff_persisted: false }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
  }
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const { conversation_id, source_message_id } = body ?? {};
    if (!conversation_id) {
      return new Response(JSON.stringify({ error: "conversation_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const ENABLE_KB = Deno.env.get("ENABLE_KB_ADAPTER") !== "false";
    const ENABLE_COACH = Deno.env.get("ENABLE_COACH_PROMPT_ADAPTER") === "true";
    const ENABLE_C360 = Deno.env.get("ENABLE_CUSTOMER360_ADAPTER") === "true";
    const ENABLE_TOOL_EXEC = Deno.env.get("ENABLE_TOOL_EXECUTOR") === "true";
    const ENABLE_PR5_ESCALATION_RUNTIME = Deno.env.get("ESC_MVP_FEATURE_FLAG") === "true" || Deno.env.get("ESC_ENABLE_S0") === "true" || Deno.env.get("ESC_SHADOW_MODE") === "true" || Deno.env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") === "true";
    if (!ENABLE_KB && !ENABLE_COACH && !ENABLE_C360 && !ENABLE_TOOL_EXEC && !ENABLE_PR5_ESCALATION_RUNTIME) {
      return await legacyGenerateReply(conversation_id, source_message_id ?? null);
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
async function legacyGenerateReply(conversation_id, source_message_id) {
  const supabaseAdmin = createClient3(Deno.env.get("SUPABASE_URL") ?? "", getSupabaseAdminKey());
  const { data: conversation, error: convError } = await supabaseAdmin.from("conversations").select("id, status, assigned_agent_id, created_at, company_id").eq("id", conversation_id).single();
  if (convError || !conversation) {
    console.error("[generate-reply] conversation not found:", conversation_id);
    return new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (conversation.status === "resolved") return new Response(JSON.stringify({ success: true, skipped: "resolved" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (isHumanControlState(conversation.status, conversation.assigned_agent_id ?? null)) {
    console.log("[generate-reply] human-handling guard: skipping LLM for status:", conversation.status, conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: "human_handling" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (conversation.assigned_agent_id) {
    console.log("[generate-reply] S-1 assigned_agent_id guard (legacy):", conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: "assigned_to_agent" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const sourceResult = await loadSourceVisitorMessage(
    supabaseAdmin,
    conversation_id,
    source_message_id
  );
  if (!sourceResult.ok) return sourceMessageErrorResponse(sourceResult);
  const sourceVisitorMessage = sourceResult.message;
  const { data: newestMessages } = await supabaseAdmin.from("messages").select("id, role, content, created_at").eq("conversation_id", conversation_id).neq("content", "__THINKING__").eq("is_recalled", false).or(sourceBoundaryFilter(sourceVisitorMessage)).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(10);
  if (!newestMessages || newestMessages.length === 0) return new Response(JSON.stringify({ success: true, skipped: "no messages" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const messages = [...newestMessages].reverse();
  const modelMessages = messages.map((m) => ({ role: m.role === "visitor" ? "user" : "assistant", content: m.content }));
  if (modelMessages[modelMessages.length - 1].role === "assistant") return new Response(JSON.stringify({ success: true, skipped: "last message is assistant" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const lastVisitorMsg = sourceVisitorMessage.content;
  const handoffLang = detectHandoffLanguage(lastVisitorMsg);
  if (handoffLang) {
    if (!source_message_id) {
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(
        JSON.stringify({ success: false, error: "legacy_handoff_missing_source_message_id", escalation_rule: "R1", handoff_persisted: false }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const { data: handoffData, error: handoffError } = await supabaseAdmin.rpc(
      "explicit_handoff_tx",
      {
        p_conversation_id: conversation_id,
        p_safe_reply_content: SAFE_HANDOFF_WORDING[handoffLang],
        p_source_message_id: source_message_id
      }
    );
    if (handoffError) {
      return new Response(
        JSON.stringify({ success: false, error: "legacy_handoff_rpc_transport_error", escalation_rule: "R1", handoff_persisted: false, handoff_uncertain: true }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const handoffResult = String(handoffData?.result ?? "unknown");
    switch (handoffResult) {
      case "success":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: true, escalation_rule: "R1", handoff_persisted: true, rpc_result: "success" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "already_handled":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: true, escalation_rule: "R1", handoff_persisted: true, rpc_result: "already_handled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "already_resolved":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: true, skipped: "resolved", escalation_rule: "R1", handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "already_under_human_control":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: "R1", handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "invalid_source_message":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: false, error: "legacy_handoff_invalid_source_message", escalation_rule: "R1", handoff_persisted: false }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "not_found":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: false, error: "legacy_handoff_conversation_not_found", escalation_rule: "R1", handoff_persisted: false }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      default:
        return new Response(JSON.stringify({ success: false, error: "legacy_handoff_unexpected_result", escalation_rule: "R1", handoff_persisted: false, rpc_result: handoffResult }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }
  const legacySystemPrompt = `You are a professional and friendly customer service assistant.
Answer customer questions clearly and concisely.
If details are missing, ask one concise contextual question. If a fact cannot be verified, say you cannot confirm it and do not guess. Do not offer a human unless the governed escalation layer has decided one is appropriate.
Keep responses under 150 words.
Respond in the same language and script the customer is using.
When the customer explicitly requests a human agent, or when you transfer to a human agent, include a short safe handoff status message in the same language and script as the customer. The message must state that the conversation has been recorded and that a human agent will reply in this same chat after taking over. If the customer is using Traditional Chinese, use: "\u6211\u5011\u5DF2\u5C07\u4F60\u7684\u5C0D\u8A71\u8A18\u9304\uFF0C\u5BA2\u670D\u63A5\u624B\u5F8C\u6703\u5728\u6B64\u5C0D\u8A71\u4E2D\u56DE\u8986\u4F60\u3002\u76EE\u524D\u672A\u555F\u7528\u5373\u6642\u8F2A\u5019\u6642\u9593\u986F\u793A\u3002" If the customer is using Simplified Chinese, use: "\u6211\u4EEC\u5DF2\u5C06\u4F60\u7684\u5BF9\u8BDD\u8BB0\u5F55\uFF0C\u5BA2\u670D\u63A5\u624B\u540E\u4F1A\u5728\u6B64\u5BF9\u8BDD\u4E2D\u56DE\u590D\u4F60\u3002\u76EE\u524D\u672A\u542F\u7528\u5B9E\u65F6\u6392\u961F\u4F4D\u7F6E\u548C\u9884\u8BA1\u7B49\u5F85\u65F6\u95F4\u663E\u793A\u3002" If the customer is using English, use: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled." Do NOT invent estimated wait times, response-time promises, or queue positions.

${CUSTOMER_CONVERSATION_POLICY}`;
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
      JSON.stringify({ success: false, error: "AI service error", error_code: llm.code }),
      { status: routerFailureHttpStatus(llm.code), headers: { ...corsHeaders, "Content-Type": "application/json" } }
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
      console.log("[generate-reply] stale AI reply suppressed by control gate:", {
        conversation_id,
        result: committed.result
      });
      return new Response(JSON.stringify({ success: true, skipped: committed.result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: false, error: `ai_reply_commit_${committed.result}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
  console.log("[generate-reply] AI reply committed for conversation:", conversation_id);
  return new Response(JSON.stringify({ success: true, idempotent: committed.idempotent }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function buildCitationMetadata(chunks) {
  const seen = /* @__PURE__ */ new Set();
  const citations = [];
  for (const c of chunks) {
    if (citations.length >= 3) break;
    const label = (typeof c.title === "string" ? c.title : "").trim().slice(0, 120);
    if (!label) continue;
    const dedupeKey = label.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const rawSt = typeof c.source_type === "string" ? c.source_type.trim().slice(0, 40) : "";
    const source_type = rawSt || "unknown";
    const relevance = typeof c.score === "number" ? c.score >= 0.85 ? "high" : "medium" : void 0;
    citations.push({ label, source_type, ...relevance ? { relevance } : {} });
  }
  return citations.length > 0 ? { citations } : null;
}
var KB_FALLBACK_SAFE_TEXT = {
  KB_SCOPE_GATE: { "zh-TW": "\u5F88\u62B1\u6B49\uFF0C\u7CFB\u7D71\u66AB\u6642\u7121\u6CD5\u67E5\u8A62\u77E5\u8B58\u5EAB\u3002\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\u3002", "zh-CN": "\u5F88\u62B1\u6B49\uFF0C\u7CFB\u7EDF\u6682\u65F6\u65E0\u6CD5\u67E5\u8BE2\u77E5\u8BC6\u5E93\u3002\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\u3002", en: "Sorry, the knowledge base is temporarily unavailable. Let me connect you with a human agent." },
  KB_API_FAIL: { "zh-TW": "\u7CFB\u7D71\u66AB\u6642\u7121\u6CD5\u67E5\u8A62\u77E5\u8B58\u5EAB\uFF0C\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\u3002", "zh-CN": "\u7CFB\u7EDF\u6682\u65F6\u65E0\u6CD5\u67E5\u8BE2\u77E5\u8BC6\u5E93\uFF0C\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\u3002", en: "The knowledge base is temporarily unavailable. Let me connect you with a human agent." },
  KB_EMPTY: { "zh-TW": "\u5F88\u62B1\u6B49\uFF0C\u6211\u76EE\u524D\u7121\u6CD5\u78BA\u5B9A\u7B54\u6848\u3002\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\uFF0C\u4EE5\u63D0\u4F9B\u66F4\u6E96\u78BA\u7684\u5354\u52A9\u3002", "zh-CN": "\u5F88\u62B1\u6B49\uFF0C\u6211\u76EE\u524D\u65E0\u6CD5\u786E\u5B9A\u7B54\u6848\u3002\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\uFF0C\u4EE5\u63D0\u4F9B\u66F4\u51C6\u786E\u7684\u534F\u52A9\u3002", en: "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance." },
  KB_LOW_SCORE_HIGH_RISK: { "zh-TW": "\u9019\u500B\u554F\u984C\u6D89\u53CA\u91CD\u8981\u653F\u7B56\uFF0C\u70BA\u78BA\u4FDD\u60A8\u7372\u5F97\u6E96\u78BA\u8CC7\u8A0A\uFF0C\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\u3002", "zh-CN": "\u8FD9\u4E2A\u95EE\u9898\u6D89\u53CA\u91CD\u8981\u653F\u7B56\uFF0C\u4E3A\u786E\u4FDD\u60A8\u83B7\u5F97\u51C6\u786E\u4FE1\u606F\uFF0C\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\u3002", en: "This question involves important policy matters. To ensure you receive accurate information, let me connect you with a human agent." },
  KB_LOW_SCORE_STANDARD: { "zh-TW": "\u5F88\u62B1\u6B49\uFF0C\u6211\u76EE\u524D\u7121\u6CD5\u78BA\u5B9A\u7B54\u6848\u3002\u8B93\u6211\u70BA\u60A8\u8F49\u63A5\u5BA2\u670D\u4EBA\u54E1\uFF0C\u4EE5\u63D0\u4F9B\u66F4\u6E96\u78BA\u7684\u5354\u52A9\u3002", "zh-CN": "\u5F88\u62B1\u6B49\uFF0C\u6211\u76EE\u524D\u65E0\u6CD5\u786E\u5B9A\u7B54\u6848\u3002\u8BA9\u6211\u4E3A\u60A8\u8F6C\u63A5\u5BA2\u670D\u4EBA\u5458\uFF0C\u4EE5\u63D0\u4F9B\u66F4\u51C6\u786E\u7684\u534F\u52A9\u3002", en: "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance." }
};
var S0_LLM_FAILURE_SAFE_TEXT = {
  "zh-TW": "\u7CFB\u7D71\u66AB\u6642\u7121\u6CD5\u5B8C\u6210\u56DE\u8986\uFF0C\u6211\u5DF2\u70BA\u4F60\u8F49\u4EA4\u5BA2\u670D\u4EBA\u54E1\u8DDF\u9032\u3002",
  "zh-CN": "\u7CFB\u7EDF\u6682\u65F6\u65E0\u6CD5\u5B8C\u6210\u56DE\u590D\uFF0C\u6211\u5DF2\u4E3A\u4F60\u8F6C\u4EA4\u5BA2\u670D\u4EBA\u5458\u8DDF\u8FDB\u3002",
  en: "The system is temporarily unable to complete a response. I\u2019ve handed this conversation to a support agent for follow-up."
};
function detectVisitorLanguage(text) {
  if (!text) return "zh-TW";
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  const zhCnIndicators = ["\u8F6C", "\u4EEC", "\u961F", "\u9884\u8BA1", "\u4E3A\u60A8", "\u4E3A\u6211", "\u4E3A\u4F60", "\u8BF7", "\u8FD9", "\u6CA1"];
  if (zhCnIndicators.some((c) => text.includes(c))) return "zh-CN";
  return "zh-TW";
}
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
  if (!isFirstNoMatchClarificationEligible({ ...eligibility, branch_tag: branchTag, source_message_id })) {
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
        JSON.stringify({ success: true, skipped: commit.result, response_route: KB_NO_MATCH_CLARIFICATION_ROUTE, handoff_required: false }),
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
      trace_metadata: { ...traceMetadata, branch: branchTag, clarification_persisted: true, idempotent: commit.idempotent }
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
async function handleKBFallback(supabaseAdmin, conversation_id, branchTag, source_message_id, traceMetadata, visitorLang = "zh-TW") {
  const _branchTexts = KB_FALLBACK_SAFE_TEXT[branchTag];
  const safeText = _branchTexts ? _branchTexts[visitorLang] ?? _branchTexts["zh-TW"] : void 0;
  if (!safeText) return new Response(JSON.stringify({ success: false, error: "kb_fallback_unknown_branch", no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, branch: branchTag, handoff_persisted: false } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (!source_message_id) return new Response(JSON.stringify({ success: false, error: "kb_fallback_missing_source_id", reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc("kb_fallback_handoff_tx", { p_conversation_id: conversation_id, p_safe_reply_content: safeText, p_branch_tag: branchTag, p_source_message_id: source_message_id });
  if (rpcErr) return new Response(JSON.stringify({ success: false, error: "kb_fallback_persistence_failed", reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const result = rpcData?.result ?? "unknown";
  switch (result) {
    case "success":
      return new Response(JSON.stringify({ success: true, reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: true, trace_metadata: { ...traceMetadata, rpc_result: "success", handoff_persisted: true } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_handled":
      return new Response(JSON.stringify({ success: true, reply: null, no_answer: true, handoff_required: false, handoff_persisted: true, trace_metadata: { ...traceMetadata, rpc_result: "already_handled", handoff_persisted: true, existing_branch: rpcData?.existing_branch, requested_branch: rpcData?.requested_branch } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_resolved":
      return new Response(JSON.stringify({ success: false, error: "conversation_resolved", reply: null, no_answer: false, handoff_required: false, handoff_persisted: false, trace_metadata: { ...traceMetadata, rpc_result: "already_resolved", handoff_persisted: false } }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_under_human_control":
      return new Response(JSON.stringify({ success: true, reply: null, no_answer: false, handoff_required: false, handoff_persisted: false, trace_metadata: { ...traceMetadata, rpc_result: "already_under_human_control", handoff_persisted: false } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_source_message":
      return new Response(JSON.stringify({ success: false, error: "kb_fallback_invalid_source", reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_branch":
      return new Response(JSON.stringify({ success: false, error: "kb_fallback_invalid_branch", no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "not_found":
      return new Response(JSON.stringify({ success: false, error: "kb_fallback_conversation_not_found", no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    default:
      return new Response(JSON.stringify({ success: false, error: "kb_fallback_unexpected_result", reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}
async function handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, failure_type, visitorLang) {
  const isKBFailure = failure_type === "KB_SCOPE_GATE" || failure_type === "KB_API_FAIL";
  let safeReply;
  if (isKBFailure) {
    const branchTexts = KB_FALLBACK_SAFE_TEXT[failure_type];
    safeReply = branchTexts?.[visitorLang] ?? branchTexts?.["zh-TW"] ?? "";
  } else safeReply = S0_LLM_FAILURE_SAFE_TEXT[visitorLang] ?? S0_LLM_FAILURE_SAFE_TEXT["zh-TW"];
  if (!safeReply) return new Response(JSON.stringify({ success: false, error: "s0_no_safe_reply", failure_type }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (!source_message_id) return new Response(JSON.stringify({ success: false, error: "s0_missing_source_message_id", failure_type }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc("s0_handoff_tx", { p_conversation_id: conversation_id, p_safe_reply_content: safeReply, p_source_message_id: source_message_id, p_failure_type: failure_type });
  if (rpcErr) return new Response(JSON.stringify({ success: false, error: "s0_rpc_transport_error", failure_type, handoff_persisted: false, handoff_uncertain: true }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const _s0Result = rpcData?.result ?? "unknown";
  switch (_s0Result) {
    case "success":
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(JSON.stringify({ success: true, escalation_rule: "S0", failure_type, handoff_persisted: true, rpc_result: "success" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_handled":
      return new Response(JSON.stringify({ success: true, escalation_rule: "S0", failure_type, handoff_persisted: true, rpc_result: "already_handled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_resolved":
      return new Response(JSON.stringify({ success: true, skipped: "resolved", escalation_rule: "S0", failure_type, handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_under_human_control":
      return new Response(JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: "S0", failure_type, handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_source_message":
      return new Response(JSON.stringify({ success: false, error: "s0_invalid_source_message", escalation_rule: "S0", failure_type }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_input":
      return new Response(JSON.stringify({ success: false, error: "s0_invalid_input", escalation_rule: "S0", failure_type }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_failure_type":
      return new Response(JSON.stringify({ success: false, error: "s0_invalid_failure_type", escalation_rule: "S0", failure_type }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "not_found":
      return new Response(JSON.stringify({ success: false, error: "s0_conversation_not_found", escalation_rule: "S0", failure_type }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    default:
      return new Response(JSON.stringify({ success: false, error: "s0_rpc_unknown_result", escalation_rule: "S0", failure_type, rpc_result: _s0Result }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}
async function persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, latestMessage) {
  const classified = classifyExplicitHandoff(latestMessage);
  if (classified.rule !== "R1") return null;
  if (!source_message_id) {
    return new Response(JSON.stringify({ success: false, error: "esc_missing_source_message_id", escalation_rule: "R1", handoff_persisted: false }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const { data, error } = await supabaseAdmin.rpc("explicit_handoff_tx", {
    p_conversation_id: conversation_id,
    p_safe_reply_content: SAFE_HANDOFF_WORDING[classified.language],
    p_source_message_id: source_message_id
  });
  if (error) {
    return new Response(JSON.stringify({ success: false, error: "esc_rpc_transport_error", escalation_rule: "R1", handoff_persisted: false, handoff_uncertain: true }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const result = data?.result ?? "unknown";
  switch (result) {
    case "success":
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(JSON.stringify({ success: true, escalation_rule: "R1", handoff_persisted: true, rpc_result: "success" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_handled":
      return new Response(JSON.stringify({ success: true, escalation_rule: "R1", handoff_persisted: true, rpc_result: "already_handled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_resolved":
      return new Response(JSON.stringify({ success: true, skipped: "resolved", escalation_rule: "R1", handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_under_human_control":
      return new Response(JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: "R1", handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "not_found":
      return new Response(JSON.stringify({ success: false, error: "esc_conversation_not_found", escalation_rule: "R1" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_source_message":
      return new Response(JSON.stringify({ success: false, error: "esc_invalid_source_message", escalation_rule: "R1" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    default:
      return new Response(JSON.stringify({ success: false, error: "esc_rpc_unknown_result", escalation_rule: "R1", rpc_result: result }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}
async function orchestrationGenerateReply(conversation_id, flags, source_message_id) {
  const supabaseAdmin = createClient3(Deno.env.get("SUPABASE_URL") ?? "", getSupabaseAdminKey());
  const { data: conversation, error: convError } = await supabaseAdmin.from("conversations").select("id, status, assigned_agent_id, created_at, company_id, metadata_source").eq("id", conversation_id).single();
  if (convError || !conversation) return new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (conversation.status === "resolved" || conversation.status === "closed") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return safeRefusal("CONV_RESOLVED_OR_CLOSED");
  }
  if (isHumanControlState(conversation.status, conversation.assigned_agent_id ?? null)) {
    console.log("[generate-reply] orchestration human-handling guard:", conversation.status, conversation_id);
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "human_handling" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (conversation.assigned_agent_id) {
    console.log("[generate-reply] S-1 assigned_agent_id guard (orchestration):", conversation_id);
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "assigned_to_agent" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
  const _h1LastMsg = sourceVisitorMessage.content;
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
  const _conversationContinuityBlock = buildConversationContinuityBlock(_pr5HistoryRows ?? []);
  const _visitorLang = detectVisitorLanguage(_h1LastMsg);
  const _turnClassification = classifyConversationTurn(_h1LastMsg);
  if (_turnClassification.should_clarify_before_kb && !isHandoffIntent(_h1LastMsg)) {
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
      return new Response(JSON.stringify({
        success: true,
        reply: clarification,
        response_route: "conversational_clarification",
        handoff_required: false
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (["human_control", "resolved", "superseded_source"].includes(clarificationCommit.result)) {
      return new Response(JSON.stringify({ success: true, skipped: clarificationCommit.result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: false, error: `clarification_commit_${clarificationCommit.result}` }), {
      status: 409,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
  const _pr5ExpectedTenantId = typeof conversation.company_id === "string" && conversation.company_id.length > 0 ? conversation.company_id : void 0;
  const _widgetLiveTestActor = _pr5ExpectedTenantId === void 0 ? widgetLiveTestPreActivationActor(conversation.metadata_source) : void 0;
  const _pr5ThreatSignal = classifyAuthoritativeThreat(_h1LastMsg);
  const _pr5ComplianceSignal = resolveAuthoritativeComplianceReview(_pr5ExpectedTenantId);
  const _pr5LocalRisk = classifyLocalTopicRisk(_h1LastMsg);
  const _pr5R3Sentiment = await loadAuthoritativeR3SentimentSignals(
    supabaseAdmin,
    conversation_id,
    _pr5ExpectedTenantId
  );
  const _pr5ConversationDurationSec = conversation.created_at ? Math.max(0, Math.floor((Date.now() - new Date(conversation.created_at).getTime()) / 1e3)) : void 0;
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
    const _pr5E2PreflightResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {
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
    });
    if (_pr5E2PreflightResponse) return _pr5E2PreflightResponse;
  }
  const _deferR1ForE1 = isE1LiveActivationEnabled(Deno.env) && _pr5LocalRisk?.level === "high" && flags.ENABLE_KB && !_pr5GreetingOrTrivial;
  if (!_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _h1LastMsg
    );
    if (r1Response) return r1Response;
  }
  const _g1SkipKB = _pr5GreetingOrTrivial;
  let _pr5RagMatchState;
  const _escEnableS0 = Deno.env.get("ESC_ENABLE_S0") !== "false";
  let basePrompt = MINIMAL_SAFE_FALLBACK_PROMPT;
  let coachTrace = { source: "minimal_fallback" };
  if (flags.ENABLE_COACH) {
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
  let customerContext = null;
  let opaqueCustomerRef = null;
  if (flags.ENABLE_C360) {
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
    const _kbTenantResult = await resolveTenantScope(conversation_id, _widgetLiveTestActor);
    if (!_kbTenantResult.resolved) {
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
        if (r1Response) return r1Response;
      }
      if (_escEnableS0) return await handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, "KB_SCOPE_GATE", _visitorLang);
      return await handleKBFallback(supabaseAdmin, conversation_id, "KB_SCOPE_GATE", source_message_id, { rag_api_status: "scope_unavailable" }, _visitorLang);
    }
    const userQuery = _h1LastMsg;
    ragResult = !userQuery ? { success: true, no_answer: true, retrieval_quality: "failed", chunks: [] } : await callKBAdapter(conversation_id, userQuery, _kbTenantResult.scope);
    if (!ragResult || !ragResult.success) {
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
        if (r1Response) return r1Response;
      }
      if (_escEnableS0) return await handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, "KB_API_FAIL", _visitorLang);
      return await handleKBFallback(supabaseAdmin, conversation_id, "KB_API_FAIL", source_message_id, { rag_api_status: "failure" }, _visitorLang);
    }
    if (ragResult.no_answer || !ragResult.chunks || ragResult.chunks.length === 0) {
      _pr5RagMatchState = "no_match";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {
        conversation_id,
        source_message_id,
        latest_message_content: _h1LastMsg,
        conversation_status: conversation.status,
        assigned_agent_id: conversation.assigned_agent_id ?? null,
        greeting_or_trivial: _pr5GreetingOrTrivial,
        visitor_language: _visitorLang,
        expected_tenant_id: _pr5ExpectedTenantId,
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
      });
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
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
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated
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
    const minScore = isHighRisk ? 0.78 : 0.55;
    const usableChunks = ragResult.chunks.filter(
      (c) => c.score && c.score >= minScore && (!c.status || c.status === "published")
    );
    const traceMetadata = { rag_api_status: "success", total_results: ragResult.chunks.length, filtered_results: usableChunks.length, min_score_used: usableChunks.length > 0 ? Math.min(...usableChunks.map((c) => c.score ?? 0)) : null, max_score_used: usableChunks.length > 0 ? Math.max(...usableChunks.map((c) => c.score ?? 0)) : null, high_risk_topic: isHighRisk, min_threshold: minScore, citations: usableChunks.map((c) => ({ doc_id: c.doc_id, chunk_id: c.chunk_id, title: c.title, score: c.score, source_type: c.source_type })) };
    ragResult.trace_metadata = traceMetadata;
    if (usableChunks.length === 0) {
      _pr5RagMatchState = "partial_match";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {
        conversation_id,
        source_message_id,
        latest_message_content: _h1LastMsg,
        conversation_status: conversation.status,
        assigned_agent_id: conversation.assigned_agent_id ?? null,
        greeting_or_trivial: _pr5GreetingOrTrivial,
        visitor_language: _visitorLang,
        expected_tenant_id: _pr5ExpectedTenantId,
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
      });
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
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
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated
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
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {
        conversation_id,
        source_message_id,
        latest_message_content: _h1LastMsg,
        conversation_status: conversation.status,
        assigned_agent_id: conversation.assigned_agent_id ?? null,
        greeting_or_trivial: _pr5GreetingOrTrivial,
        visitor_language: _visitorLang,
        expected_tenant_id: _pr5ExpectedTenantId,
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
      });
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
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
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated
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
    const usableSummary = usableChunks.find((c) => c.chunk_type === "rag_summary");
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
    finalPromptChunks = usableChunks;
    _kbDone = true;
  }
  if (!flags.ENABLE_KB || _g1SkipKB) _kbDone = true;
  if (flags.ENABLE_KB && !_g1SkipKB && !_kbDone) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ error: "Internal KB processing error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
  const _pr5RequiredLiveResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {
    conversation_id,
    source_message_id,
    latest_message_content: _h1LastMsg,
    conversation_status: conversation.status,
    assigned_agent_id: conversation.assigned_agent_id ?? null,
    greeting_or_trivial: _pr5GreetingOrTrivial,
    visitor_language: _visitorLang,
    expected_tenant_id: _pr5ExpectedTenantId,
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
  });
  if (_pr5RequiredLiveResponse) return _pr5RequiredLiveResponse;
  if (_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
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
  if (flags.ENABLE_TOOL_EXEC) console.log("[generate-reply] ENABLE_TOOL_EXECUTOR=true: Gate present, tools NOT attached (L5d scope)");
  const _customerAdvisoryBlock = buildCustomerAdvisoryContext({
    tier: customerContext?.tier,
    anger_flag: _pr5R3Sentiment?.anger_flag,
    sentiment_score: _pr5R3Sentiment?.sentiment_score,
    churn_risk: customerContext?.churn_risk,
    escalation_score: customerContext?.escalation_score
  });
  const finalSystemPrompt = [
    basePrompt,
    CUSTOMER_CONVERSATION_POLICY,
    _conversationContinuityBlock,
    _customerAdvisoryBlock,
    buildMaskedContextBlock(customerContext, opaqueCustomerRef),
    buildRagBlock(ragResult)
  ].filter((s) => s && s.length > 0).join("\n\n");
  const { data: newestMessages } = await supabaseAdmin.from("messages").select("id, role, content, created_at").eq("conversation_id", conversation_id).neq("content", "__THINKING__").eq("is_recalled", false).or(sourceBoundaryFilter(sourceVisitorMessage)).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(10);
  if (!newestMessages || newestMessages.length === 0) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "no messages" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const messages = [...newestMessages].reverse();
  const modelMessages = messages.map((m) => ({ role: m.role === "visitor" ? "user" : "assistant", content: m.content }));
  if (modelMessages[modelMessages.length - 1].role === "assistant") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "last message is assistant" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (flags.ENABLE_TOOL_EXEC) {
    console.warn(
      "[generate-reply] TOOL_EXECUTOR_NOT_READY: tools withheld from governed LLM request",
      { conversation_id }
    );
  }
  const llm = await callModel({
    purpose: "generation",
    system: finalSystemPrompt,
    user: buildRouterConversationInput(modelMessages),
    maxTokens: resolveGenerationMaxTokens(),
    operationId: `generate-reply:orchestration:${conversation_id}:${source_message_id}`,
    companyId: typeof conversation.company_id === "string" && conversation.company_id.length > 0 ? conversation.company_id : null,
    conversationId: conversation_id,
    tag: "generate-reply-orchestration",
    responseFormat: "text"
  });
  if (!llm.ok) {
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
      JSON.stringify({ success: false, error: "AI service error", error_code: llm.code }),
      { status: routerFailureHttpStatus(llm.code), headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const aiReplyContent = llm.text;
  const citationMeta = finalPromptChunks.length > 0 ? buildCitationMetadata(finalPromptChunks) : null;
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
      return new Response(JSON.stringify({ success: true, skipped: committed.result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: false, error: `ai_reply_commit_${committed.result}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (flags.ENABLE_COACH) void coachTrace;
  if (flags.ENABLE_KB && ragResult?.success) void ragResult;
  console.log("[generate-reply] AI reply committed (orchestration path) for conversation:", conversation_id);
  return new Response(JSON.stringify({ success: true, idempotent: committed.idempotent }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function safeRefusal(code) {
  return new Response(JSON.stringify({ success: true, skipped: "refused", reason_code: code, handoff_required: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function buildMaskedContextBlock(customerContext, opaqueCustomerRef) {
  if (!customerContext) return "";
  const parts = [];
  if (customerContext.tier) parts.push(`Customer tier: ${customerContext.tier}`);
  if (customerContext.masked_summary) parts.push(customerContext.masked_summary);
  if (opaqueCustomerRef) parts.push(`Customer reference (pseudonymous): ${pseudonymizeRef(opaqueCustomerRef)}`);
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
${evidence.map((c, i) => `[${i + 1}]
${(c.content ?? c.short_snippet ?? "").slice(0, 1200)}`).join("\n\n")}` : "Full Content Evidence: none. Do not assert exact facts."
  ].filter(Boolean).join("\n\n");
}
function pseudonymizeRef(ref) {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = (h << 5) - h + ref.charCodeAt(i) | 0;
  return `cust_${(h >>> 0).toString(36)}`;
}
async function callCoachPromptAdapter(conversation_id) {
  const FAIL = (error_type) => ({ success: false, error_type });
  const endpoint = Deno.env.get("COACH_PROMPT_ENDPOINT");
  const token = Deno.env.get("COACH_PROMPT_INTERNAL_TOKEN");
  const timeoutMs = parseInt(Deno.env.get("COACH_AI_TIMEOUT_MS") || "3000");
  if (!endpoint) return FAIL("COACH_API_NOT_CONFIGURED");
  if (!token) return FAIL("COACH_TOKEN_MISSING");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "x-coach-internal-token": token, "x-coach-runtime": "C0", "Content-Type": "application/json" }, body: JSON.stringify({ include_content: true }), signal: controller.signal });
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
    const promptHash = await computePromptHash(content, versionId, conversation_id);
    return { success: true, content, version_id: versionId, version_label: data.data.label || "", prompt_hash: promptHash };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") return FAIL("COACH_API_TIMEOUT");
    return FAIL("COACH_API_EXCEPTION");
  }
}
function validateCoachPromptContent(content) {
  if (typeof content !== "string") return "COACH_SCHEMA_INVALID";
  if (content.length === 0) return "COACH_CONTENT_EMPTY";
  if (content.length > 2e4) return "COACH_CONTENT_TOO_LONG";
  if (/sk-ant-[a-zA-Z0-9]+/.test(content) || /service_role/.test(content)) return "COACH_SCHEMA_INVALID";
  return null;
}
async function computePromptHash(content, versionId, conversationId) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content + "|" + versionId + "|" + conversationId));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 12);
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
    return { success: false, error_type: `C360_CALLER_HTTP_${response.status}` };
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
    safeContext.p1_provider_version = context.p1_provider_version.trim().slice(0, 120);
  }
  return {
    success: true,
    customer_context: safeContext,
    customer_ref: customerRef
  };
}
async function callKBAdapter(_conversation_id, userMessage, scope) {
  const endpointCfg = resolveKBEndpoint();
  if (!endpointCfg) return { success: false, no_answer: true, retrieval_quality: "failed" };
  const result = await fetchKBRag({ query: userMessage, top_k: 5 }, scope, endpointCfg, { timeoutMs: 15e3 });
  if (!result.success) return { success: false, no_answer: true, retrieval_quality: "failed" };
  if (result.chunks.length === 0) return { success: true, no_answer: true, retrieval_quality: "failed", chunks: [], query_text_preview: userMessage.slice(0, 100) };
  return {
    success: true,
    no_answer: false,
    retrieval_quality: "high",
    chunks: result.chunks,
    ...result.llm_context ? { llm_context: result.llm_context } : {},
    ...result.meta ? { meta: result.meta } : {},
    query_text_preview: userMessage.slice(0, 100)
  };
}
var ALLOWED_TOOLS = ["kb_search", "escalate_to_human", "get_customer_context", "get_order_summary", "create_handoff_summary", "mark_unresolved", "suggest_reply"];
var READ_ONLY_TOOLS = ["kb_search", "get_customer_context", "get_order_summary"];
var HIGH_RISK_ALLOWED = ["kb_search", "get_customer_context", "escalate_to_human", "create_handoff_summary"];
var OFFLINE_BOT_ALLOWED = ["kb_search", "escalate_to_human"];
var MAX_TOOL_CALLS = 10;
var MAX_KB_SEARCH = 3;
var MAX_C360_CALLS = 2;
function buildSafeDedupeKey(tool_name, input, server_resolved_customer_ref) {
  if (tool_name === "get_order_summary") return server_resolved_customer_ref ? `get_order_summary:${server_resolved_customer_ref}` : null;
  const SAFE_FIELDS = { kb_search: ["query_norm", "locale"], get_customer_context: [], escalate_to_human: ["reason_code"], create_handoff_summary: ["reason_code"], mark_unresolved: ["reason_code"], suggest_reply: ["intent_code"] };
  const safe = {};
  for (const k of SAFE_FIELDS[tool_name] ?? []) if (input[k] !== void 0 && typeof input[k] !== "object") safe[k] = String(input[k]).slice(0, 200);
  return `${tool_name}:${JSON.stringify(safe)}`;
}
function toolExecutorGate(toolRequest, context) {
  const { tool_name, input } = toolRequest;
  const { conversation, caller_mode, risk_level, privacy_flags, turn_tool_calls, turn_budget, server_resolved_customer_ref } = context;
  if (tool_name === "schedule_feedback_request") return { decision: "DENY", reason: "TOOL_EXCLUDED" };
  if (!ALLOWED_TOOLS.includes(tool_name)) return { decision: "DENY", reason: "TOOL_NOT_REGISTERED" };
  const status = conversation.status;
  if (status === "resolved" || status === "closed") return { decision: "DENY", reason: "CONV_RESOLVED_OR_CLOSED" };
  if ((status === "human_needed" || status === "human_control") && !READ_ONLY_TOOLS.includes(tool_name)) return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_IN_STATUS" };
  if (status === "offline_bot" && !OFFLINE_BOT_ALLOWED.includes(tool_name)) return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_OFFLINE" };
  if (risk_level === "high" && !HIGH_RISK_ALLOWED.includes(tool_name)) return { decision: "ESCALATE", reason: "HIGH_RISK_TOOL_BLOCKED" };
  if (tool_name === "mark_unresolved" && caller_mode === "system_auto") return { decision: "DENY", reason: "MARK_UNRESOLVED_REQUIRES_HUMAN" };
  if ((privacy_flags?.do_not_profile === true || privacy_flags?.consent_status === "withdrawn") && tool_name === "get_customer_context") return { decision: "DENY", reason: "PRIVACY_DO_NOT_PROFILE" };
  const dedupe_key = buildSafeDedupeKey(tool_name, input, server_resolved_customer_ref);
  if (dedupe_key === null) return { decision: "DENY", reason: "SERVER_REFERENCE_REQUIRED" };
  if (turn_tool_calls.has(dedupe_key)) return { decision: "DENY", reason: "DUPLICATE_TOOL_CALL_IN_TURN" };
  turn_tool_calls.add(dedupe_key);
  if (turn_budget.total >= MAX_TOOL_CALLS) return { decision: "DENY", reason: "TOOL_BUDGET_EXCEEDED" };
  if (tool_name === "kb_search" && turn_budget.kb_search >= MAX_KB_SEARCH) return { decision: "DENY", reason: "KB_SEARCH_BUDGET_EXCEEDED" };
  if (tool_name === "get_customer_context" && turn_budget.c360 >= MAX_C360_CALLS) return { decision: "DENY", reason: "C360_BUDGET_EXCEEDED" };
  if (status === "ai_draft_only" || status === "unresolved") return { decision: "DOWNGRADE_TO_DRAFT", reason: "STATUS_DRAFT_ONLY", execution_allowed: true, force_draft: true, execution_deferred_to: "L5d", draft_enforcement_deferred_to: "L5e" };
  if (status === "escalation_risk") return { decision: "DOWNGRADE_TO_DRAFT", reason: "ESCALATION_RISK_DOWNGRADE", execution_allowed: true, force_draft: true, execution_deferred_to: "L5d", draft_enforcement_deferred_to: "L5e" };
  return { decision: "ALLOW", reason: "GATE_PASSED", execution_allowed: true, execution_deferred_to: "L5d" };
}
function handleGateDecision(decision2) {
  switch (decision2.decision) {
    case "ALLOW":
      return { decision: "ALLOW", reason: decision2.reason ?? "GATE_PASSED", execution_allowed: true, execution_deferred_to: "L5d" };
    case "DENY":
      return { decision: "DENY", reason: decision2.reason, message_to_llm: "tool not available in current context" };
    case "DOWNGRADE_TO_DRAFT":
      return { decision: "DOWNGRADE_TO_DRAFT", reason: decision2.reason, execution_allowed: true, force_draft: true, execution_deferred_to: "L5d", draft_enforcement_deferred_to: "L5e" };
    case "ESCALATE":
      return { decision: "ESCALATE", reason: decision2.reason, handoff_required: true, action_deferred_to: "L5e" };
  }
}
async function handleToolCall(tool_name, _tool_input, _context) {
  switch (tool_name) {
    case "kb_search":
      return { tool_name, status: "stub", result_classification: "internal_only", retrieval_quality: "failed", no_answer: true, handoff_required: true, results: [], stub_note: "KB adapter not yet enabled (L5d stub)" };
    case "escalate_to_human":
      return { tool_name, status: "stub", result_classification: "internal_only", escalated: false, stub_note: "Escalation workflow deferred to L5e \u2014 no state changes in L5d" };
    case "get_customer_context":
      return { tool_name, status: "stub", result_classification: "internal_only", customer_context: null, context_available: false, stub_note: "Customer360 adapter not enabled; no customer context returned" };
    case "get_order_summary":
      return { tool_name, status: "stub", result_classification: "internal_only", order_available: false, stub_note: "Order adapter not yet enabled (L5d stub)" };
    case "create_handoff_summary":
      return { tool_name, status: "stub", result_classification: "internal_only", summary: "[Handoff summary not yet available \u2014 L5d stub]", stub_note: "Handoff summary generation deferred to L5e; conversation_id server-side only" };
    case "mark_unresolved":
      return { tool_name, status: "stub", result_classification: "internal_only", marked: false, stub_note: "mark_unresolved write action deferred to L5e \u2014 no state changes in L5d" };
    case "suggest_reply":
      return { tool_name, status: "stub", result_classification: "internal_only", draft_content: "", confidence: 0, recommended_action: "human_review", stub_note: "suggest_reply draft write deferred to L5e \u2014 no state changes in L5d" };
    default:
      return { tool_name, status: "denied", result_classification: "internal_only", error: "tool not available in current context" };
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
  if (mode === "console_suggest") return { pass: false, reason: "CONSOLE_SUGGEST_ALWAYS_DRAFT" };
  if (ragResult) {
    if (ragResult.no_answer) return { pass: false, reason: "KB_NO_ANSWER" };
    if (ragResult.conflict_detected) return { pass: false, reason: "KB_CONFLICT" };
    if (ragResult.retrieval_quality === "low") return { pass: false, reason: "KB_LOW_QUALITY" };
    if (ragResult.policy_gap) return { pass: false, reason: "KB_POLICY_GAP" };
    if (ragResult.source_scope !== "customer_answer") return { pass: false, reason: "KB_SCOPE_NOT_CUSTOMER_ANSWER" };
  }
  for (const result of toolResults) {
    if (result.result_classification === "draft_only") return { pass: false, reason: "TOOL_RESULT_DRAFT_ONLY" };
    if (result.result_classification === "supervisor_only") return { pass: false, reason: "TOOL_RESULT_SUPERVISOR_ONLY" };
  }
  const suggestResult = toolResults.find((r) => r.tool_name === "suggest_reply");
  if (suggestResult?.citation_required && !suggestResult?.has_valid_citation) return { pass: false, reason: "SUGGEST_REPLY_MISSING_CITATION" };
  if (toolResults.some((r) => r.handoff_required)) return { pass: false, reason: "HANDOFF_REQUIRED_BY_TOOL" };
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
  if (!context.flags.ENABLE_TOOL_EXEC) return { auto_sent: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  void outputMode;
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
async function executeEscalateToHuman(input, context) {
  const _reason = l5eSanitize(input.reason, { maxChars: 500, noPII: true });
  const _summary = l5eSanitize(input.summary, { maxChars: 500, noPII: true });
  const _handoffSummary = context.handoff_summary_from_tool || _summary;
  void _reason;
  void _handoffSummary;
  if (!context.flags.ENABLE_TOOL_EXEC) return { escalated: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
async function executeMarkUnresolved(input, context) {
  if (!context.flags.ENABLE_TOOL_EXEC) return { marked: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
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
