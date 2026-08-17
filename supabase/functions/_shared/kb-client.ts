// supabase/functions/_shared/kb-client.ts
// PR27 Task 1 — canonical Singapore KB adapter + secure pre-activation scope.
//
// Frozen rules:
// - Canonical company identity always wins.
// - Pre-activation never creates/fabricates company_id and is available only
//   for an authenticated Admin/Supervisor with ZERO company_membership rows.
// - Browser request bodies never choose tenant/company scope.
// - Singapore tenant is server-only configuration.
// - Demo scope is separate and is never used as production/pre-activation fallback.
// - Opaque company-specific API keys / JWTs / tokens / raw upstream payloads are never returned to the browser.
// - Preferred production auth is a server-only Singapore tenant -> API key map.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  resolveSingaporeCredential,
  singaporeCredentialHeaders,
  type KBAuthHeaderMode,
} from "./kb-auth.ts";
import { parseAggregationResponse } from "./kb-aggregation-response.ts";

export interface KBQueryInput { query: string; top_k: number }
export type KBScopeMode = "canonical" | "pre_activation" | "demo";
export interface KBResolvedScope {
  mode: KBScopeMode;
  aiCompanyId: string | null;
  singaporeTenantId: string;
}
export interface KBFullChunk {
  document_id: string; doc_id?: string; chunk_id?: string; title?: string;
  content: string; score: number; chunk_type: "rag_summary" | "full_content";
  source_type: string; status: "published";
}
export interface KBCitationChunk {
  display_label: string; content: string; score: number; source_type: string;
  document_id?: string; chunk_id?: string; chunk_type?: string;
}
export interface KBLLMContextEvidence {
  document_id: string; chunk_id?: string; content: string; score: number; source_type: string;
}
export interface KBLLMContext {
  selected_document_id: string; orientation_summary: string | null;
  full_content_evidence: KBLLMContextEvidence[];
}
export interface KBRagMeta {
  document_score: number; highest_chunk_score: number; second_highest_chunk_score: number;
  returned_summary_count: number; returned_full_content_count: number;
  dropped_without_document_id: number; dropped_without_content: number;
}
export interface KBRagResponse {
  success: boolean; chunks: KBFullChunk[]; citations: KBCitationChunk[];
  llm_context?: KBLLMContext; meta?: KBRagMeta; selected_document_id?: string;
  dropped_without_document_id?: number; dropped_without_content?: number; error_code?: string;
}
export interface KBEndpointConfig {
  baseUrl: string; ragUrl: string; signingSecret?: string; jwtTtlSec: number;
  defaultToken?: string; tenantTokens: Record<string, string>;
  tenantApiKeys: Record<string, string>;
  apiKeyHeaderMode: KBAuthHeaderMode;
}
export interface KBPreActivationActor {
  userId: string;
  /** Must be explicitly enabled by the authenticated server caller. */
  allowPreActivation: true;
}

const SINGAPORE_KB_DEFAULT_BASE_URL = "https://py.ebixmall.com/py-knowledge-base";
const SINGAPORE_RAG_PATH = "/api/v1/rag/context-search";
const KB_DEFAULT_TIMEOUT_MS = 12000;
const PREACTIVATION_ROLES = new Set(["admin", "supervisor"]);

// Narrow structural type for helpers that only need Supabase query-builder access.
// Avoids coupling helper signatures to createClient's inferred schema generics.
type QueryDbClient = {
  from: (relation: string) => any;
};

function normalizeBaseUrl(raw: string): { baseUrl: string; ragUrl: string } | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) return null;
  } catch { return null; }
  if (value.endsWith(SINGAPORE_RAG_PATH)) {
    return { baseUrl: value.slice(0, -SINGAPORE_RAG_PATH.length), ragUrl: value };
  }
  return { baseUrl: value, ragUrl: `${value}${SINGAPORE_RAG_PATH}` };
}

function parseStringMapEnv(name: string): Record<string, string> | null {
  const raw = Deno.env.get(name);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" || !key.trim() || !value.trim()) return null;
      out[key.trim()] = value.trim();
    }
    return out;
  } catch { return null; }
}

export function resolveKBEndpoint(): KBEndpointConfig | null {
  const configured = Deno.env.get("KB_RAG_ENDPOINT") ?? Deno.env.get("KB_RAG_BASE_URL") ?? SINGAPORE_KB_DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) return null;

  const tenantTokens = parseStringMapEnv("KB_RAG_TENANT_TOKENS_JSON");
  const tenantApiKeys = parseStringMapEnv("KB_SINGAPORE_TENANT_API_KEYS_JSON");
  if (tenantTokens === null || tenantApiKeys === null) return null;

  const headerRaw = (Deno.env.get("KB_SINGAPORE_API_KEY_HEADER") ?? "authorization")
    .trim().toLowerCase();
  if (headerRaw !== "authorization" && headerRaw !== "x-api-key") return null;
  const apiKeyHeaderMode = headerRaw as KBAuthHeaderMode;

  const signingSecret = Deno.env.get("KB_SINGAPORE_JWT_SECRET")?.trim() || undefined;
  const ttlRaw = Number.parseInt(Deno.env.get("KB_SINGAPORE_JWT_TTL_SEC") ?? "300", 10);
  const jwtTtlSec = Number.isInteger(ttlRaw) && ttlRaw >= 60 && ttlRaw <= 900 ? ttlRaw : 300;
  const defaultToken = Deno.env.get("KB_RAG_TOKEN")?.trim() || undefined;

  return {
    ...normalized,
    signingSecret,
    jwtTtlSec,
    defaultToken,
    tenantTokens,
    tenantApiKeys,
    apiKeyHeaderMode,
  };
}

export type TenantResolutionReason =
  | "KB_DB_CONFIG_MISSING" | "KB_CONVERSATION_LOOKUP_FAILED" | "KB_CONVERSATION_NOT_FOUND"
  | "KB_TENANT_MAPPING_CONFIG_INVALID" | "KB_TENANT_MAPPING_UNRESOLVED"
  | "KB_TENANT_IDENTITY_CONFLICT" | "KB_DEMO_DISABLED" | "KB_DEMO_CONFIG_MISSING"
  | "KB_PREACTIVATION_DISABLED" | "KB_PREACTIVATION_CONFIG_MISSING"
  | "KB_PREACTIVATION_MEMBERSHIP_PRESENT" | "KB_PREACTIVATION_ROLE_LOOKUP_FAILED"
  | "KB_PREACTIVATION_ROLE_FORBIDDEN";
export type TenantResolutionResult =
  | { resolved: true; scope: KBResolvedScope }
  | { resolved: false; reason: TenantResolutionReason };

async function resolvePreActivationScope(
  sb: QueryDbClient, actor: KBPreActivationActor | undefined,
): Promise<TenantResolutionResult> {
  if (!actor?.allowPreActivation) return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
  if (Deno.env.get("KB_PREACTIVATION_ENABLED") !== "true") {
    return { resolved: false, reason: "KB_PREACTIVATION_DISABLED" };
  }
  const tenantId = Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim();
  if (!tenantId) return { resolved: false, reason: "KB_PREACTIVATION_CONFIG_MISSING" };

  // IMPORTANT: query ALL membership rows, not only active ones. Any canonical
  // identity history prevents fallback to pre-activation.
  const { data: memberships, error: membershipError } = await sb
    .from("company_membership").select("company_id, is_active").eq("user_id", actor.userId);
  if (membershipError) return { resolved: false, reason: "KB_PREACTIVATION_ROLE_LOOKUP_FAILED" };
  if ((memberships ?? []).length > 0) {
    return { resolved: false, reason: "KB_PREACTIVATION_MEMBERSHIP_PRESENT" };
  }

  const { data: roles, error: roleError } = await sb
    .from("user_roles").select("role").eq("user_id", actor.userId);
  if (roleError) return { resolved: false, reason: "KB_PREACTIVATION_ROLE_LOOKUP_FAILED" };
  const allowed = (roles ?? []).some((row: { role?: unknown }) => PREACTIVATION_ROLES.has(String(row.role ?? "")));
  if (!allowed) return { resolved: false, reason: "KB_PREACTIVATION_ROLE_FORBIDDEN" };

  return { resolved: true, scope: { mode: "pre_activation", aiCompanyId: null, singaporeTenantId: tenantId } };
}

export async function resolveTenantScope(
  conversationId: string | null,
  actor?: KBPreActivationActor,
): Promise<TenantResolutionResult> {
  if (conversationId) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return { resolved: false, reason: "KB_DB_CONFIG_MISSING" };
    const sb = createClient(supabaseUrl, serviceRoleKey);
    const { data: conv, error: convErr } = await sb
      .from("conversations").select("company_id, channel_config_id").eq("id", conversationId).maybeSingle();
    if (convErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    if (!conv) return { resolved: false, reason: "KB_CONVERSATION_NOT_FOUND" };

    let channelCompanyId: string | null = null;
    if (conv.channel_config_id) {
      const { data: channel, error: channelErr } = await sb
        .from("channel_config").select("company_id").eq("id", conv.channel_config_id).maybeSingle();
      if (channelErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
      channelCompanyId = channel?.company_id ? String(channel.company_id) : null;
    }
    const conversationCompanyId = conv.company_id ? String(conv.company_id) : null;
    if (conversationCompanyId && channelCompanyId && conversationCompanyId !== channelCompanyId) {
      return { resolved: false, reason: "KB_TENANT_IDENTITY_CONFLICT" };
    }
    const resolvedCompanyId = conversationCompanyId ?? channelCompanyId;

    // Canonical ALWAYS wins. Pre-activation is considered only when both
    // conversation and channel identity are genuinely absent.
    if (!resolvedCompanyId) return await resolvePreActivationScope(sb, actor);

    const { data: company, error: companyErr } = await sb
      .from("company").select("id, is_active").eq("id", resolvedCompanyId).maybeSingle();
    if (companyErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    if (!company || company.is_active !== true) return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    const tenantMap = parseStringMapEnv("KB_SINGAPORE_TENANT_MAP_JSON");
    if (tenantMap === null) return { resolved: false, reason: "KB_TENANT_MAPPING_CONFIG_INVALID" };
    const singaporeTenantId = tenantMap[String(company.id)]?.trim();
    if (!singaporeTenantId) return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    return { resolved: true, scope: { mode: "canonical", aiCompanyId: String(company.id), singaporeTenantId } };
  }

  // Demo is an explicit non-production mode and remains completely separate
  // from pre-activation.
  if (Deno.env.get("KB_DEMO_MODE") !== "true") return { resolved: false, reason: "KB_DEMO_DISABLED" };
  const tenantId = Deno.env.get("KB_DEMO_TENANT_ID")?.trim();
  if (!tenantId) return { resolved: false, reason: "KB_DEMO_CONFIG_MISSING" };
  return { resolved: true, scope: { mode: "demo", aiCompanyId: null, singaporeTenantId: tenantId } };
}

export async function fetchKBRag(
  queryInput: KBQueryInput,
  scope: KBResolvedScope,
  endpointCfg: KBEndpointConfig,
  opts?: { timeoutMs?: number },
): Promise<KBRagResponse> {
  const query = queryInput.query.trim();
  if (!query) return { success: true, chunks: [], citations: [] };

  const credential = await resolveSingaporeCredential(scope, endpointCfg);
  if (!credential.ok) {
    return {
      success: false,
      chunks: [],
      citations: [],
      error_code: credential.error_code,
    };
  }

  const authHeaders = singaporeCredentialHeaders(credential, endpointCfg);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? KB_DEFAULT_TIMEOUT_MS,
  );

  let response: Response;
  try {
    response = await fetch(endpointCfg.ragUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body: JSON.stringify({
        query,
        candidate_top_k: Math.max(queryInput.top_k, 10),
        max_documents: 1,
        max_summary_chunks: 1,
        max_full_content_chunks: 3,
        score_threshold: 0.05,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    return {
      success: false,
      chunks: [],
      citations: [],
      error_code:
        err instanceof DOMException && err.name === "AbortError"
          ? "KB_TIMEOUT"
          : "KB_FETCH_ERROR",
    };
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
    return {
      success: false,
      chunks: [],
      citations: [],
      error_code: "KB_INVALID_JSON",
    };
  }
  clearTimeout(timeout);

  const parsed = parseAggregationResponse(data);
  if (!parsed.ok) {
    return {
      success: false,
      chunks: [],
      citations: [],
      error_code: parsed.error_code,
    };
  }

  if (!parsed.contextFound) {
    return { success: true, chunks: [], citations: [] };
  }

  return {
    success: true,
    chunks: parsed.chunks.map((c) => ({
      document_id: c.document_id,
      doc_id: c.document_id,
      ...(c.chunk_id ? { chunk_id: c.chunk_id } : {}),
      title: c.title,
      content: c.content,
      score: c.score,
      chunk_type: c.chunk_type,
      source_type: c.source_type,
      status: "published" as const,
    })),
    citations: parsed.citations,
    llm_context: parsed.llmContext,
    meta: parsed.meta,
    selected_document_id: parsed.selectedDocumentId,
    dropped_without_document_id: 0,
    dropped_without_content: 0,
  };
}
