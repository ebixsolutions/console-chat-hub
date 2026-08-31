import {
  resolveKBEndpoint,
  resolveTenantScope,
  fetchKBRag,
  type KBDocumentCandidate,
  type KBResolvedScope,
} from "../_shared/kb-client.ts";
import { callModel, parseJsonObject } from "../_shared/llm-router.ts";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { supabaseCorsHeaders } from "../_shared/supabase-cors.ts";

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
type QueryDbClient = { from: (relation: string) => any; };
const MAX_QUERY_LENGTH = 500;
const MAX_TOP_K = 3;
const MAX_CONTEXT_MESSAGES = 5;
const CONTEXT_SEPARATOR = " / ";
const UI_RELEVANCE_FLOOR = 0.75;
const LLM_RELEVANCE_FLOOR = 0.75;
const DIRECT_LEXICAL_FLOOR = 0.6;
const RERANK_MAX_TOKENS = 768;
const RERANK_TRUNCATION_NEAR_LIMIT = Math.floor(RERANK_MAX_TOKENS * 0.9);
const RERANK_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    relevant: { type: "BOOLEAN" },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
  },
  required: ["relevant", "confidence"],
  propertyOrdering: ["relevant", "confidence"],
};
const CONSOLE_ORIGINS = [
  "https://console-chat-hub.lovable.app",
  "https://id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app",
  "http://localhost:3000",
  "http://localhost:5173",
];

function getCorsHeaders(req: Request): Record<string, string> {
  return supabaseCorsHeaders(
    req.headers.get("Origin") ?? "",
    CONSOLE_ORIGINS,
    req.headers.get("Access-Control-Request-Headers") ?? "",
  );
}
function jsonResponse(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}
function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function normalizeComparable(v: string): string {
  return v.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
function lexicalTokens(v: string): Set<string> {
  const normalized = normalizeComparable(v);
  const out = new Set<string>();
  for (const token of normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []) out.add(token);
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}
function lexicalSupport(query: string, evidence: string): number {
  const q = normalizeComparable(query);
  const e = normalizeComparable(evidence);
  if (!q || !e) return 0;
  if (e.includes(q)) return 1;
  const qTokens = lexicalTokens(q);
  if (qTokens.size === 0) return 0;
  const eTokens = lexicalTokens(e);
  let matched = 0;
  for (const token of qTokens) if (eTokens.has(token)) matched++;
  return matched / qTokens.size;
}

type MembershipRow = { company_id: string; role: string };
type VisitorTurn = { content: string; created_at: string | null };
type RankedDocument = {
  document: KBDocumentCandidate;
  results: Array<Record<string, unknown>>;
  method: string;
  confidence: number | null;
  displayScore: number;
  retrievalScore: number;
};

async function loadEligibleMemberships(
  admin: QueryDbClient,
  userId: string,
): Promise<{ ok: true; rows: MembershipRow[] } | { ok: false }> {
  const { data, error } = await admin.from("company_membership")
    .select("company_id, role").eq("user_id", userId).eq("is_active", true);
  if (error) return { ok: false };
  return {
    ok: true,
    rows: (data ?? []).filter((r: { company_id?: unknown; role?: unknown }) =>
      typeof r.company_id === "string" &&
      typeof r.role === "string" && ALLOWED_ROLES.has(r.role)
    ) as MembershipRow[],
  };
}
async function loadGlobalRoles(admin: QueryDbClient, userId: string): Promise<string[] | null> {
  const { data, error } = await admin.from("user_roles").select("role").eq("user_id", userId);
  if (error) return null;
  return (data ?? []).map((r: { role?: unknown }) => String(r.role ?? ""));
}
async function requireActiveCompany(admin: QueryDbClient, companyId: string): Promise<boolean | null> {
  const { data, error } = await admin.from("company")
    .select("id, is_active").eq("id", companyId).maybeSingle();
  return error ? null : !!data && data.is_active === true;
}
async function loadRecentVisitorTurns(
  admin: QueryDbClient,
  conversationId: string,
): Promise<VisitorTurn[] | null> {
  const { data, error } = await admin.from("messages")
    .select("content, created_at")
    .eq("conversation_id", conversationId)
    .eq("role", "visitor")
    .eq("is_recalled", false)
    .order("created_at", { ascending: false })
    .limit(MAX_CONTEXT_MESSAGES);
  if (error) return null;
  return (data ?? [])
    .filter((row: { content?: unknown }) =>
      typeof row.content === "string" && row.content.trim() && row.content !== "__THINKING__"
    )
    .map((row: { content: string; created_at?: string | null }) => ({
      content: row.content.trim(),
      created_at: row.created_at ?? null,
    }))
    .reverse();
}
function buildTrustedRetrievalQuery(
  clientQuery: string,
  turns: VisitorTurn[],
): { query: string; currentRequest: string; mode: "auto_context" | "manual" } {
  if (turns.length === 0) {
    return { query: clientQuery, currentRequest: clientQuery, mode: "manual" };
  }
  const latest = turns[turns.length - 1].content.trim();
  const joined = turns.map((t) => t.content.trim()).join(CONTEXT_SEPARATOR);
  const q = normalizeComparable(clientQuery);
  const isAuto = q === normalizeComparable(latest) ||
    q === normalizeComparable(joined.slice(0, MAX_QUERY_LENGTH));
  if (!isAuto) return { query: clientQuery, currentRequest: clientQuery, mode: "manual" };

  const previous = turns.slice(-3, -1)
    .map((t) => t.content.trim()).filter(Boolean).join(CONTEXT_SEPARATOR);
  const composed = previous
    ? `Current request: ${latest}\nRecent context: ${previous}`
    : latest;
  return {
    query: composed.length <= MAX_QUERY_LENGTH ? composed : composed.slice(0, MAX_QUERY_LENGTH),
    currentRequest: latest,
    mode: "auto_context",
  };
}
function parseTenantMap(): Record<string, string> | null {
  const raw = Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON");
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (!isUuid(k) || typeof v !== "string" || !v.trim()) return null;
      out[k] = v.trim();
    }
    return out;
  } catch {
    return null;
  }
}
async function resolveStandaloneScope(
  admin: QueryDbClient,
  userId: string,
  eligible: MembershipRow[],
): Promise<{ ok: true; scope: KBResolvedScope } | { ok: false; status: number; error: string }> {
  const ids = [...new Set(eligible.map((r) => r.company_id))];
  if (ids.length > 1) return { ok: false, status: 409, error: "company_membership_ambiguous" };
  if (ids.length === 1) {
    const active = await requireActiveCompany(admin, ids[0]);
    if (active === null) return { ok: false, status: 500, error: "kb_tenant_unresolved" };
    if (!active) return { ok: false, status: 403, error: "company_inactive" };
    const map = parseTenantMap();
    if (map === null) return { ok: false, status: 500, error: "kb_tenant_mapping_invalid" };
    const tenant = map[ids[0]];
    if (!tenant) return { ok: false, status: 503, error: "kb_tenant_unresolved" };
    return {
      ok: true,
      scope: { mode: "canonical", aiCompanyId: ids[0], singaporeTenantId: tenant },
    };
  }
  const roles = await loadGlobalRoles(admin, userId);
  if (!roles) return { ok: false, status: 500, error: "role_lookup_failed" };
  if (!roles.some((r) => ALLOWED_ROLES.has(r))) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  const { data: allMemberships, error: allErr } = await admin.from("company_membership")
    .select("company_id, is_active").eq("user_id", userId);
  if (allErr) return { ok: false, status: 500, error: "membership_lookup_failed" };
  if ((allMemberships ?? []).length > 0) return { ok: false, status: 403, error: "not_a_member" };
  if (Deno.env.get("KB_PREACTIVATION_ENABLED") !== "true") {
    return { ok: false, status: 503, error: "kb_preactivation_disabled" };
  }
  const tenant = Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim();
  if (!tenant) return { ok: false, status: 503, error: "kb_preactivation_config_missing" };
  return {
    ok: true,
    scope: { mode: "pre_activation", aiCompanyId: null, singaporeTenantId: tenant },
  };
}

function classifyRerankFailure(code: string, outputTokens: number): string {
  if (code === "LLM_INVALID_OUTPUT" && outputTokens >= RERANK_TRUNCATION_NEAR_LIMIT) {
    return "rerank_token_budget_exhausted";
  }
  switch (code) {
    case "LLM_INVALID_OUTPUT": return "rerank_llm_invalid_output";
    case "LLM_TIMEOUT": return "rerank_llm_timeout";
    case "LLM_NETWORK": return "rerank_llm_network";
    case "LLM_NON_2XX": return "rerank_llm_non_2xx";
    case "LLM_CONFIG_MISSING": return "rerank_llm_config_missing";
    case "LLM_INPUT_BLOCKED": return "rerank_llm_input_blocked";
    default: return "rerank_llm_failure";
  }
}

async function rerankForDisplay(params: {
  currentRequest: string;
  retrievalQuery: string;
  citations: Array<Record<string, unknown>>;
  scope: KBResolvedScope;
  conversationId: string | null;
}): Promise<{ results: Array<Record<string, unknown>>; method: string; confidence: number | null }> {
  const { currentRequest, retrievalQuery, citations, scope, conversationId } = params;
  if (citations.length === 0) return { results: [], method: "no_hit", confidence: null };

  const rawTop = Math.max(
    ...citations.map((c) => Number(c.score ?? 0)).filter(Number.isFinite),
    0,
  );
  const evidence = citations
    .map((c) => `${String(c.display_label ?? "")}\n${String(c.content ?? "")}`)
    .join("\n---\n")
    .slice(0, 5000);
  const lexical = lexicalSupport(currentRequest, evidence);

  if (lexical >= DIRECT_LEXICAL_FLOOR) {
    const confidence = Math.min(1, Math.max(UI_RELEVANCE_FLOOR, 0.75 + lexical * 0.25));
    return {
      results: citations.map((c) => ({
        ...c,
        retrieval_score: Number(c.score ?? 0),
        score: Math.max(Number(c.score ?? 0), confidence),
        relevance_method: "lexical_semantic",
      })),
      method: "lexical_semantic",
      confidence,
    };
  }
  if (rawTop >= UI_RELEVANCE_FLOOR) {
    return {
      results: citations.map((c) => ({
        ...c,
        retrieval_score: Number(c.score ?? 0),
        relevance_method: "high_semantic",
      })),
      method: "high_semantic",
      confidence: rawTop,
    };
  }

  const llm = await callModel({
    purpose: "assist",
    system: "You are a multilingual relevance judge for a customer-service knowledge base. Decide only whether the retrieved evidence directly helps answer the CURRENT customer request. Use semantic meaning across languages, not exact wording. Reject same-domain but unrelated documents. Return exactly one JSON object matching the supplied schema. Confidence must be between 0 and 1.",
    user: `CURRENT REQUEST:\n${currentRequest.slice(0, 1000)}\n\nRETRIEVAL CONTEXT:\n${retrievalQuery.slice(0, 1200)}\n\nCANDIDATE KNOWLEDGE:\n${evidence}`,
    maxTokens: RERANK_MAX_TOKENS,
    operationId: crypto.randomUUID(),
    companyId: scope.aiCompanyId,
    conversationId,
    tag: "kb-relevance-rerank",
    responseFormat: "json",
    responseSchema: RERANK_RESPONSE_SCHEMA,
  });

  if (!llm.ok) {
    return {
      results: [],
      method: classifyRerankFailure(llm.code, llm.usage.output_tokens),
      confidence: null,
    };
  }

  const parsed = parseJsonObject(llm.text);
  if (!parsed || typeof parsed.relevant !== "boolean") {
    return { results: [], method: "rerank_schema_invalid", confidence: null };
  }
  const confidence = typeof parsed.confidence === "number"
    ? parsed.confidence
    : Number.NaN;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { results: [], method: "rerank_schema_invalid", confidence: null };
  }
  if (parsed.relevant !== true || confidence < LLM_RELEVANCE_FLOOR) {
    return { results: [], method: "llm_rejected", confidence };
  }

  const bounded = Math.max(LLM_RELEVANCE_FLOOR, Math.min(1, confidence));
  return {
    results: citations.map((c) => ({
      ...c,
      retrieval_score: Number(c.score ?? 0),
      score: Math.max(Number(c.score ?? 0), bounded),
      relevance_method: "multilingual_llm",
    })),
    method: "multilingual_llm",
    confidence: bounded,
  };
}

async function rankDocumentCandidates(params: {
  currentRequest: string;
  retrievalQuery: string;
  documents: KBDocumentCandidate[];
  scope: KBResolvedScope;
  conversationId: string | null;
}): Promise<{ winner: RankedDocument | null; evaluated: RankedDocument[] }> {
  const evaluated: RankedDocument[] = [];
  for (const document of params.documents) {
    if (document.citations.some((c) => c.document_id !== document.document_id)) {
      throw new Error("KB_DOCUMENT_EVIDENCE_MISMATCH");
    }
    const ranked = await rerankForDisplay({
      currentRequest: params.currentRequest,
      retrievalQuery: params.retrievalQuery,
      citations: document.citations as unknown as Array<Record<string, unknown>>,
      scope: params.scope,
      conversationId: params.conversationId,
    });
    const displayScore = ranked.results.length
      ? Math.max(...ranked.results.map((c) => Number(c.score ?? 0)).filter(Number.isFinite), 0)
      : 0;
    const retrievalScore = Math.max(
      ...document.citations.map((c) => Number(c.score ?? 0)).filter(Number.isFinite),
      document.document_score,
      0,
    );
    evaluated.push({
      document,
      results: ranked.results,
      method: ranked.method,
      confidence: ranked.confidence,
      displayScore,
      retrievalScore,
    });
  }

  const accepted = evaluated.filter((r) => r.results.length > 0);
  accepted.sort((a, b) =>
    b.displayScore - a.displayScore ||
    (b.confidence ?? 0) - (a.confidence ?? 0) ||
    b.retrievalScore - a.retrievalScore ||
    b.document.document_score - a.document.document_score ||
    a.document.document_id.localeCompare(b.document.document_id)
  );
  return { winner: accepted[0] ?? null, evaluated };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("Origin") ?? "";
    if (!CONSOLE_ORIGINS.includes(origin)) return new Response(null, { status: 403 });
    return new Response(null, { headers: getCorsHeaders(req) });
  }
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, req);
  const requestOrigin = req.headers.get("Origin");
  if (requestOrigin && !CONSOLE_ORIGINS.includes(requestOrigin)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    let adminKey = "";
    try { adminKey = getSupabaseAdminKey(); } catch { adminKey = ""; }
    if (!supabaseUrl || !anonKey || !adminKey) {
      return jsonResponse({ error: "server_config_missing" }, 500, req);
    }

    const auth = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user }, error: authErr } = await auth.auth.getUser();
    if (authErr || !user) return jsonResponse({ error: "unauthorized" }, 401, req);

    const admin = createClient(supabaseUrl, adminKey);
    const roles = await loadGlobalRoles(admin, user.id);
    if (!roles) return jsonResponse({ error: "role_lookup_failed" }, 500, req);
    if (!roles.some((r) => ALLOWED_ROLES.has(r))) {
      return jsonResponse({ error: "forbidden" }, 403, req);
    }
    const membershipResult = await loadEligibleMemberships(admin, user.id);
    if (!membershipResult.ok) {
      return jsonResponse({ error: "tenant_authorization_failed" }, 500, req);
    }

    const body = await req.json().catch(() => ({}));
    for (const forbidden of ["company_id", "industry", "language", "tenant_id", "workspace_id"]) {
      if (body?.[forbidden] !== undefined) {
        return jsonResponse({
          error: "invalid_request",
          detail: "tenant/company/industry/language/workspace scope must not be provided by client",
        }, 400, req);
      }
    }

    const rawQuery = body?.query;
    if (typeof rawQuery !== "string") {
      return jsonResponse({ error: "invalid_request", detail: "query required" }, 400, req);
    }
    const query = rawQuery.trim();
    if (!query) return jsonResponse({ error: "invalid_request", detail: "query empty" }, 400, req);
    if (query.length > MAX_QUERY_LENGTH) {
      return jsonResponse({ error: "invalid_request", detail: "query too long (max 500)" }, 400, req);
    }
    const topK = Math.max(1, Math.min(MAX_TOP_K, Number.parseInt(String(body?.top_k), 10) || 3));

    const rawConversationId = body?.conversation_id;
    let scope: KBResolvedScope;
    let conversationId: string | null = null;
    let recentTurns: VisitorTurn[] = [];

    if (rawConversationId !== undefined && rawConversationId !== null) {
      if (!isUuid(rawConversationId)) {
        return jsonResponse({ error: "invalid_request", detail: "invalid conversation_id" }, 400, req);
      }
      conversationId = rawConversationId;
      const { data: conversation, error: convErr } = await admin.from("conversations")
        .select("id").eq("id", conversationId).maybeSingle();
      if (convErr) return jsonResponse({ error: "conversation_lookup_failed" }, 500, req);
      if (!conversation) return jsonResponse({ error: "conversation_not_found" }, 404, req);

      const resolved = await resolveTenantScope(conversationId, {
        userId: user.id,
        allowPreActivation: true,
      });
      if (!resolved.resolved) {
        return jsonResponse({ error: "kb_tenant_unresolved", detail: resolved.reason }, 503, req);
      }
      scope = resolved.scope;
      if (scope.mode === "canonical") {
        if (!scope.aiCompanyId) {
          return jsonResponse({ error: "tenant_authorization_failed" }, 500, req);
        }
        if (!membershipResult.rows.some((r) => r.company_id === scope.aiCompanyId)) {
          return jsonResponse({ error: "forbidden_tenant_role" }, 403, req);
        }
        const active = await requireActiveCompany(admin, scope.aiCompanyId);
        if (active === null) return jsonResponse({ error: "tenant_authorization_failed" }, 500, req);
        if (!active) return jsonResponse({ error: "forbidden_tenant" }, 403, req);
      }
      const loaded = await loadRecentVisitorTurns(admin, conversationId);
      if (loaded === null) {
        return jsonResponse({ error: "conversation_context_lookup_failed" }, 500, req);
      }
      recentTurns = loaded;
    } else {
      const standalone = await resolveStandaloneScope(admin, user.id, membershipResult.rows);
      if (!standalone.ok) {
        return jsonResponse({ error: standalone.error }, standalone.status, req);
      }
      scope = standalone.scope;
    }

    const derived = buildTrustedRetrievalQuery(query, recentTurns);
    const endpoint = resolveKBEndpoint();
    if (!endpoint) return jsonResponse({ error: "kb_config_missing" }, 500, req);

    const result = await fetchKBRag({ query: derived.query, top_k: topK }, scope, endpoint);
    if (!result.success) {
      if (result.error_code === "KB_TIMEOUT") {
        return jsonResponse({ error: "kb_api_timeout" }, 504, req);
      }
      console.error("[kb-search-proxy] KB API error", {
        code: result.error_code,
        scope_mode: scope.mode,
      });
      return jsonResponse({ error: "kb_api_error", detail: result.error_code }, 502, req);
    }

    const ranked = await rankDocumentCandidates({
      currentRequest: derived.currentRequest,
      retrievalQuery: derived.query,
      documents: result.documents,
      scope,
      conversationId,
    });
    const winner = ranked.winner;
    const winnerDocumentId = winner?.document.document_id ?? null;

    const policyEvidence = winner
      ? winner.document.llm_context.full_content_evidence
          .filter((i) =>
            i.document_id === winnerDocumentId &&
            i.source_type.toLowerCase().includes("policy") &&
            i.content.trim()
          )
          .slice(0, 3)
          .map((i, index) => ({
            label: `Policy evidence ${index + 1}`,
            content: i.content.slice(0, 800),
            source_type: i.source_type.slice(0, 40),
            document_id: i.document_id,
            ...(i.chunk_id ? { chunk_id: i.chunk_id } : {}),
            score: i.score,
          }))
      : [];

    return jsonResponse({
      success: true,
      scope_mode: scope.mode,
      query_mode: derived.mode,
      results: winner?.results ?? [],
      llm_context: winner ? winner.document.llm_context : null,
      meta: {
        ...(winner?.document.meta ?? {}),
        relevance_method: winner?.method ?? "no_accepted_document",
        relevance_confidence: winner?.confidence ?? null,
        raw_result_count: result.citations.length,
        accepted_result_count: winner?.results.length ?? 0,
        candidate_document_count: result.documents.length,
        evaluated_document_count: ranked.evaluated.length,
        accepted_document_count: ranked.evaluated.filter((r) => r.results.length > 0).length,
        selected_document_score: winner?.document.document_score ?? null,
        candidate_diagnostics: ranked.evaluated.map((r) => ({
          document_id: r.document.document_id,
          title: r.document.title.slice(0, 160),
          source_type: r.document.source_type.slice(0, 80),
          method: r.method,
          confidence: r.confidence,
          retrieval_score: r.retrievalScore,
          display_score: r.displayScore,
          accepted: r.results.length > 0,
        })),
      },
      selected_document_id: winnerDocumentId,
      policy_evidence: policyEvidence,
    }, 200, req);
  } catch (e) {
    const name = (e as Error).message === "KB_DOCUMENT_EVIDENCE_MISMATCH"
      ? "KB_DOCUMENT_EVIDENCE_MISMATCH"
      : (e as Error).name;
    console.error("[kb-search-proxy] unexpected error", name);
    return jsonResponse(
      { error: name === "KB_DOCUMENT_EVIDENCE_MISMATCH" ? "kb_contract_mismatch" : "internal_error" },
      name === "KB_DOCUMENT_EVIDENCE_MISMATCH" ? 502 : 500,
      req,
    );
  }
});