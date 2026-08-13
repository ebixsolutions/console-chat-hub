// supabase/functions/_shared/kb-client.ts
// PR-KB — canonical Singapore Knowledge Base upstream adapter.
//
// Authoritative Singapore contract (2026-08-13):
//   Base URL: https://py.ebixmall.com/py-knowledge-base
//   POST /api/v1/rag/context-search
//   Authorization: Bearer <JWT>
//   Tenant scope: JWT tenant_id (or sub fallback) ONLY; request body never carries tenant/company.
//
// This adapter normalizes the Singapore response back into the frozen AI Chatbot
// structured contract: orientation_summary + max 3 full_content_evidence.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface KBQueryInput {
  query: string;
  top_k: number;
}

export interface KBResolvedScope {
  aiCompanyId: string;
  singaporeTenantId: string;
}

export interface KBFullChunk {
  document_id: string;
  doc_id?: string;
  chunk_id?: string;
  title?: string;
  content: string;
  score: number;
  chunk_type: "rag_summary" | "full_content";
  source_type: string;
  status: "published";
}

export interface KBCitationChunk {
  display_label: string;
  content: string;
  score: number;
  source_type: string;
  document_id?: string;
  chunk_id?: string;
  chunk_type?: string;
}

export interface KBLLMContextEvidence {
  document_id: string;
  chunk_id?: string;
  content: string;
  score: number;
  source_type: string;
}

export interface KBLLMContext {
  selected_document_id: string;
  orientation_summary: string | null;
  full_content_evidence: KBLLMContextEvidence[];
}

export interface KBRagMeta {
  document_score: number;
  highest_chunk_score: number;
  second_highest_chunk_score: number;
  returned_summary_count: number;
  returned_full_content_count: number;
  dropped_without_document_id: number;
  dropped_without_content: number;
}

export interface KBRagResponse {
  success: boolean;
  chunks: KBFullChunk[];
  citations: KBCitationChunk[];
  llm_context?: KBLLMContext;
  meta?: KBRagMeta;
  selected_document_id?: string;
  dropped_without_document_id?: number;
  dropped_without_content?: number;
  error_code?: string;
}

export interface KBEndpointConfig {
  baseUrl: string;
  ragUrl: string;
  defaultToken?: string;
  tenantTokens: Record<string, string>;
}

const SINGAPORE_KB_DEFAULT_BASE_URL =
  "https://py.ebixmall.com/py-knowledge-base";
const SINGAPORE_RAG_PATH = "/api/v1/rag/context-search";
const KB_DEFAULT_TIMEOUT_MS = 12000;

function normalizeBaseUrl(raw: string): { baseUrl: string; ragUrl: string } | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;

  try {
    const url = new URL(value);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) return null;
  } catch {
    return null;
  }

  if (value.endsWith(SINGAPORE_RAG_PATH)) {
    return {
      baseUrl: value.slice(0, -SINGAPORE_RAG_PATH.length),
      ragUrl: value,
    };
  }
  return { baseUrl: value, ragUrl: `${value}${SINGAPORE_RAG_PATH}` };
}

function parseStringMapEnv(name: string): Record<string, string> | null {
  const raw = Deno.env.get(name);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[kb-client] ${name} invalid JSON`);
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`[kb-client] ${name} must be a JSON object`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || !key.trim() || !value.trim()) {
      console.error(`[kb-client] ${name} values must be non-empty strings`);
      return null;
    }
    out[key.trim()] = value.trim();
  }
  return out;
}

export function resolveKBEndpoint(): KBEndpointConfig | null {
  const configured =
    Deno.env.get("KB_RAG_ENDPOINT") ??
    Deno.env.get("KB_RAG_BASE_URL") ??
    SINGAPORE_KB_DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) return null;

  const tenantTokens = parseStringMapEnv("KB_RAG_TENANT_TOKENS_JSON");
  if (tenantTokens === null) return null;

  const defaultToken = Deno.env.get("KB_RAG_TOKEN")?.trim() || undefined;
  return { ...normalized, defaultToken, tenantTokens };
}

export type TenantResolutionResult =
  | { resolved: true; scope: KBResolvedScope }
  | {
      resolved: false;
      reason:
        | "KB_DB_CONFIG_MISSING"
        | "KB_CONVERSATION_LOOKUP_FAILED"
        | "KB_CONVERSATION_NOT_FOUND"
        | "KB_TENANT_MAPPING_CONFIG_INVALID"
        | "KB_TENANT_MAPPING_UNRESOLVED"
        | "KB_DEMO_DISABLED"
        | "KB_DEMO_CONFIG_MISSING";
    };

export async function resolveTenantScope(
  conversationId: string | null,
): Promise<TenantResolutionResult> {
  if (conversationId) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      return { resolved: false, reason: "KB_DB_CONFIG_MISSING" };
    }

    const sb = createClient(supabaseUrl, serviceRoleKey);
    const { data: conv, error: convErr } = await sb
      .from("conversations")
      .select("company_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr) {
      console.error("[kb-client] conversation lookup failed", {
        conversation_id: conversationId,
        code: convErr.code,
      });
      return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    }
    if (!conv) return { resolved: false, reason: "KB_CONVERSATION_NOT_FOUND" };
    if (!conv.company_id) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    }

    const { data: company, error: companyErr } = await sb
      .from("company")
      .select("id, is_active")
      .eq("id", conv.company_id)
      .maybeSingle();

    if (companyErr) {
      console.error("[kb-client] company lookup failed", {
        conversation_id: conversationId,
        company_id: conv.company_id,
        code: companyErr.code,
      });
      return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    }
    if (!company || company.is_active !== true) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    }

    // Singapore KB tenant identity is explicit configuration only.
    // Never reinterpret external_tenant_id/external_workspace_id or the AI
    // Chatbot company UUID as a Singapore tenant without a frozen mapping.
    const tenantMap = parseStringMapEnv("KB_SINGAPORE_TENANT_MAP_JSON");
    if (tenantMap === null) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_CONFIG_INVALID" };
    }
    const singaporeTenantId = tenantMap[String(company.id)]?.trim();
    if (!singaporeTenantId) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    }

    return {
      resolved: true,
      scope: {
        aiCompanyId: String(company.id),
        singaporeTenantId,
      },
    };
  }

  if (Deno.env.get("KB_DEMO_MODE") !== "true") {
    return { resolved: false, reason: "KB_DEMO_DISABLED" };
  }
  const tenantId = Deno.env.get("KB_DEMO_TENANT_ID")?.trim();
  if (!tenantId) {
    return { resolved: false, reason: "KB_DEMO_CONFIG_MISSING" };
  }
  return {
    resolved: true,
    scope: { aiCompanyId: "demo", singaporeTenantId: tenantId },
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4 || 4)) % 4);
    const json = atob(padded);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function resolveTenantToken(
  scope: KBResolvedScope,
  cfg: KBEndpointConfig,
): { ok: true; token: string } | { ok: false; error_code: string } {
  const token = cfg.tenantTokens[scope.singaporeTenantId] ?? cfg.defaultToken;
  if (!token) return { ok: false, error_code: "KB_AUTH_TOKEN_MISSING" };

  // Defense in depth only. Signature is authoritatively verified by Singapore KB.
  // Here we ensure the configured token advertises the same tenant we resolved
  // from the explicit AI-company → Singapore-tenant mapping.
  const claims = decodeJwtPayload(token);
  if (!claims) return { ok: false, error_code: "KB_AUTH_TOKEN_INVALID" };
  const tokenTenant = claims.tenant_id ?? claims.sub;
  if (String(tokenTenant ?? "") !== scope.singaporeTenantId) {
    return { ok: false, error_code: "KB_AUTH_TENANT_MISMATCH" };
  }
  const exp = Number(claims.exp);
  if (Number.isFinite(exp) && exp * 1000 <= Date.now() + 5000) {
    return { ok: false, error_code: "KB_AUTH_TOKEN_EXPIRED" };
  }
  return { ok: true, token };
}

interface SingaporeCitation {
  document_id?: unknown;
  document_title?: unknown;
  chunk_id?: unknown;
  chunk_type?: unknown;
  score?: unknown;
  label?: unknown;
}

interface SingaporeDocument {
  document_id?: unknown;
  doc_score?: unknown;
  chunk_count?: unknown;
}

interface SingaporeDocumentMetadata {
  id?: unknown;
  name?: unknown;
  source_type?: unknown;
  knowledge_type?: unknown;
  status?: unknown;
  production_status?: unknown;
  available_to_live_console?: unknown;
  is_outdated?: unknown;
}

function parseSingaporeContext(raw: string): {
  summaries: string[];
  evidence: string[];
} {
  const summaries: string[] = [];
  const evidence: string[] = [];
  let currentKind: "summary" | "evidence" | null = null;
  let current: string[] = [];

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) {
      if (currentKind === "summary") summaries.push(text);
      if (currentKind === "evidence") evidence.push(text);
    }
    current = [];
  };

  for (const line of raw.split(/\r?\n/)) {
    const summary = line.match(/^\[summary\]\s*(.*)$/i);
    if (summary) {
      flush();
      currentKind = "summary";
      current.push(summary[1] ?? "");
      continue;
    }
    const ev = line.match(/^\[evidence\]\s*(.*)$/i);
    if (ev) {
      flush();
      currentKind = "evidence";
      current.push(ev[1] ?? "");
      continue;
    }
    if (currentKind) current.push(line);
  }
  flush();
  return { summaries, evidence };
}

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchSelectedDocumentMetadata(
  cfg: KBEndpointConfig,
  token: string,
  documentId: string,
  signal: AbortSignal,
): Promise<
  | { ok: true; data: SingaporeDocumentMetadata }
  | { ok: false; error_code: string }
> {
  let response: Response;
  try {
    response = await fetch(
      `${cfg.baseUrl}/api/entities/KBDocument/${encodeURIComponent(documentId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal,
      },
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, error_code: "KB_TIMEOUT" };
    }
    return { ok: false, error_code: "KB_DOCUMENT_METADATA_FETCH_ERROR" };
  }
  if (!response.ok) {
    return {
      ok: false,
      error_code: `KB_DOCUMENT_METADATA_HTTP_${response.status}`,
    };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error_code: "KB_DOCUMENT_METADATA_INVALID_JSON" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error_code: "KB_DOCUMENT_METADATA_SCHEMA_INVALID" };
  }
  return { ok: true, data: data as SingaporeDocumentMetadata };
}

export async function fetchKBRag(
  queryInput: KBQueryInput,
  scope: KBResolvedScope,
  endpointCfg: KBEndpointConfig,
  opts?: { timeoutMs?: number },
): Promise<KBRagResponse> {
  const query = queryInput.query.trim();
  if (!query) {
    return { success: true, chunks: [], citations: [] };
  }

  const auth = resolveTenantToken(scope, endpointCfg);
  if (!auth.ok) {
    return {
      success: false,
      chunks: [],
      citations: [],
      error_code: auth.error_code,
    };
  }

  const timeoutMs = opts?.timeoutMs ?? KB_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(endpointCfg.ragUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      // Singapore backend owns tenant isolation from JWT. Never add tenant,
      // company, workspace, industry or language scope to this payload.
      body: JSON.stringify({
        query,
        top_k: Math.max(queryInput.top_k, 12),
        score_threshold: 0.05,
        max_documents: 1,
        max_summary: 1,
        max_full_chunks: 3,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { success: false, chunks: [], citations: [], error_code: "KB_TIMEOUT" };
    }
    return { success: false, chunks: [], citations: [], error_code: "KB_FETCH_ERROR" };
  }

  if (!response.ok) {
    clearTimeout(timeout);
    return {
      success: false,
      chunks: [],
      citations: [],
      error_code: `KB_HTTP_${response.status}`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    clearTimeout(timeout);
    return { success: false, chunks: [], citations: [], error_code: "KB_INVALID_JSON" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    clearTimeout(timeout);
    return { success: false, chunks: [], citations: [], error_code: "KB_SCHEMA_INVALID" };
  }

  const d = data as Record<string, unknown>;
  if (typeof d.has_context !== "boolean" || typeof d.reason !== "string") {
    clearTimeout(timeout);
    return { success: false, chunks: [], citations: [], error_code: "KB_SCHEMA_INVALID" };
  }

  if (d.has_context === false) {
    clearTimeout(timeout);
    if (!Array.isArray(d.citations) || !Array.isArray(d.documents)) {
      return { success: false, chunks: [], citations: [], error_code: "KB_SCHEMA_INVALID" };
    }
    return { success: true, chunks: [], citations: [] };
  }

  if (
    d.reason !== "ok" ||
    typeof d.llm_context !== "string" ||
    !Array.isArray(d.citations) ||
    !Array.isArray(d.documents)
  ) {
    clearTimeout(timeout);
    return { success: false, chunks: [], citations: [], error_code: "KB_SCHEMA_INVALID" };
  }

  const upstreamCitations = d.citations as SingaporeCitation[];
  const upstreamDocuments = d.documents as SingaporeDocument[];
  const selectedDocumentId =
    typeof upstreamDocuments[0]?.document_id === "string"
      ? upstreamDocuments[0].document_id
      : typeof upstreamCitations[0]?.document_id === "string"
        ? upstreamCitations[0].document_id
        : null;

  if (!selectedDocumentId) {
    clearTimeout(timeout);
    return { success: false, chunks: [], citations: [], error_code: "KB_SCHEMA_INVALID" };
  }

  const crossDocument = upstreamCitations.some(
    (c) => typeof c.document_id === "string" && c.document_id !== selectedDocumentId,
  );
  if (crossDocument) {
    clearTimeout(timeout);
    return { success: false, chunks: [], citations: [], error_code: "KB_CROSS_DOCUMENT_MISMATCH" };
  }

  const metadata = await fetchSelectedDocumentMetadata(
    endpointCfg,
    auth.token,
    selectedDocumentId,
    controller.signal,
  );
  clearTimeout(timeout);
  if (!metadata.ok) {
    return {
      success: false,
      chunks: [],
      citations: [],
      error_code: metadata.error_code,
    };
  }

  const doc = metadata.data;
  if (String(doc.id ?? "") !== selectedDocumentId) {
    return { success: false, chunks: [], citations: [], error_code: "KB_DOCUMENT_METADATA_MISMATCH" };
  }

  // Production safety gate. Singapore RAG reads production vectors; AI Chatbot
  // additionally verifies the selected document is still live, published and current.
  if (
    doc.status !== "published" ||
    doc.production_status !== "production" ||
    doc.available_to_live_console !== true ||
    doc.is_outdated === true
  ) {
    return { success: false, chunks: [], citations: [], error_code: "KB_DOCUMENT_NOT_LIVE" };
  }

  const sourceType =
    typeof doc.source_type === "string" && doc.source_type.trim()
      ? doc.source_type.trim()
      : typeof doc.knowledge_type === "string" && doc.knowledge_type.trim()
        ? doc.knowledge_type.trim()
        : "unknown";
  const title =
    typeof doc.name === "string" && doc.name.trim()
      ? doc.name.trim().slice(0, 200)
      : "KB document";

  const parsed = parseSingaporeContext(d.llm_context);
  const orientationSummary = parsed.summaries[0] ?? null;
  const chunks: KBFullChunk[] = [];
  const citations: KBCitationChunk[] = [];

  const docScore = asFiniteNumber(upstreamDocuments[0]?.doc_score) ?? 0;
  const upstreamScores = upstreamCitations
    .map((c) => asFiniteNumber(c.score))
    .filter((n): n is number => n !== null)
    .sort((a, b) => b - a);

  if (orientationSummary) {
    const summaryScore = upstreamScores[0] ?? docScore;
    chunks.push({
      document_id: selectedDocumentId,
      doc_id: selectedDocumentId,
      title,
      content: orientationSummary,
      score: summaryScore,
      chunk_type: "rag_summary",
      source_type: sourceType,
      status: "published",
    });
    citations.push({
      display_label: title,
      content: orientationSummary.slice(0, 500),
      score: summaryScore,
      source_type: sourceType,
      document_id: selectedDocumentId,
      chunk_type: "rag_summary",
    });
  }

  let droppedWithoutContent = 0;
  let droppedWithoutDocumentId = 0;
  const fullEvidence: KBLLMContextEvidence[] = [];
  for (let i = 0; i < upstreamCitations.length && fullEvidence.length < 3; i++) {
    const citation = upstreamCitations[i];
    if (citation.chunk_type !== "full_content") continue;
    if (citation.document_id !== selectedDocumentId) {
      droppedWithoutDocumentId += 1;
      continue;
    }
    const content = parsed.evidence[i]?.trim() ?? "";
    if (!content) {
      droppedWithoutContent += 1;
      continue;
    }
    const score = asFiniteNumber(citation.score) ?? 0;
    const chunkId = typeof citation.chunk_id === "string" ? citation.chunk_id : undefined;
    const chunk: KBFullChunk = {
      document_id: selectedDocumentId,
      doc_id: selectedDocumentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      title,
      content,
      score,
      chunk_type: "full_content",
      source_type: sourceType,
      status: "published",
    };
    chunks.push(chunk);
    fullEvidence.push({
      document_id: selectedDocumentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      content,
      score,
      source_type: sourceType,
    });
    citations.push({
      display_label: title,
      content: content.slice(0, 500),
      score,
      source_type: sourceType,
      document_id: selectedDocumentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      chunk_type: "full_content",
    });
  }

  // Frozen AI Chatbot rule: faq_pair/section are NOT substituted for
  // full_content evidence. If Singapore returns no full_content, exact-fact
  // callers remain safely ungrounded instead of silently broadening evidence.
  const llmContext: KBLLMContext = {
    selected_document_id: selectedDocumentId,
    orientation_summary: orientationSummary,
    full_content_evidence: fullEvidence,
  };

  const highest = upstreamScores[0] ?? 0;
  const second = upstreamScores[1] ?? 0;
  const meta: KBRagMeta = {
    document_score: docScore,
    highest_chunk_score: highest,
    second_highest_chunk_score: second,
    returned_summary_count: orientationSummary ? 1 : 0,
    returned_full_content_count: fullEvidence.length,
    dropped_without_document_id: droppedWithoutDocumentId,
    dropped_without_content: droppedWithoutContent,
  };

  return {
    success: true,
    chunks,
    citations,
    llm_context: llmContext,
    meta,
    selected_document_id: selectedDocumentId,
    dropped_without_document_id: droppedWithoutDocumentId,
    dropped_without_content: droppedWithoutContent,
  };
}
