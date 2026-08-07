// supabase/functions/_shared/kb-client.ts
//
// PR-2 Task 1 Round 2 — ONE canonical KB upstream adapter.
// Separates user query from server-resolved tenant scope.
// Upstream error != empty success.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ─── Query + Scope types (security boundary) ─────────────────────────────────

/** User/caller query — no tenant fields. */
export interface KBQueryInput {
  query: string;
  top_k: number;
}

/** Server-resolved KB tenant scope — never from frontend. */
export interface KBResolvedScope {
  kbCompanyId: number;
  industry: string;
  language: string;
}

// ─── Response types ──────────────────────────────────────────────────────────

export interface KBUpstreamChunk {
  doc_id?: string;
  chunk_id?: string;
  title?: string;
  content?: string;
  score?: number;
  industry?: string;
  company_id?: number;
  language?: string;
  status?: string;
  source_type?: string;
  published_at?: string;
  updated_at?: string;
}

export interface KBCitationChunk {
  display_label: string;
  content: string;
  score: number;
  source_type: string;
}

export type KBFullChunk = KBUpstreamChunk;

export interface KBRagResponse {
  success: boolean;
  chunks: KBFullChunk[];
  citations: KBCitationChunk[];
  error_code?: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface KBEndpointConfig {
  endpoint: string;
  token: string;
}

export function resolveKBEndpoint(): KBEndpointConfig | null {
  const endpoint = Deno.env.get("KB_RAG_ENDPOINT");
  const token = Deno.env.get("KB_RAG_TOKEN");
  if (!endpoint || !token) return null;
  return { endpoint, token };
}

// ─── Tenant scope resolution ─────────────────────────────────────────────────

export type TenantResolutionResult =
  | { resolved: true; scope: KBResolvedScope }
  | { resolved: false; reason: string };

/**
 * Resolve KB tenant scope for a conversation.
 *
 * Tries: conversation.company_id → company table → KB mapping fields.
 * Currently: no authoritative mapping exists (company table empty,
 * conversations.company_id all NULL, no industry/kb_company_id columns).
 *
 * Falls back to demo scope ONLY when KB_DEMO_MODE=true is explicitly set.
 * Otherwise fails closed.
 */
export async function resolveTenantScope(
  conversationId: string | null,
): Promise<TenantResolutionResult> {
  // Step 1: If conversation_id supplied, attempt real resolution
  if (conversationId) {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("company_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (convErr || !conv) {
      // conversation not found or query error — cannot resolve tenant
      // Fall through to demo check below
    } else if (conv.company_id) {
      // Has company_id — attempt to resolve KB mapping
      const { data: company, error: compErr } = await supabaseAdmin
        .from("company")
        .select("id, external_tenant_id, external_workspace_id")
        .eq("id", conv.company_id)
        .maybeSingle();

      if (!compErr && company) {
        // Company exists — but no industry / kb_company_id columns exist
        // Cannot map AI Chatbot company UUID to KB numeric company_id + industry
        // This is the EXTERNAL BLOCKER
        return {
          resolved: false,
          reason: "KB_TENANT_MAPPING_UNRESOLVED: company exists but no KB numeric company_id/industry mapping",
        };
      }
      // Company row not found for this company_id
      return {
        resolved: false,
        reason: "KB_TENANT_MAPPING_UNRESOLVED: conversation.company_id references non-existent company",
      };
    }
    // conversation.company_id is NULL — fall through to demo
  }

  // Step 2: Demo mode fallback (explicit flag required)
  const demoMode = Deno.env.get("KB_DEMO_MODE") === "true";
  if (!demoMode) {
    return {
      resolved: false,
      reason: "KB_TENANT_MAPPING_UNRESOLVED: no conversation company_id and KB_DEMO_MODE not enabled",
    };
  }

  const companyIdStr = Deno.env.get("KB_DEMO_COMPANY_ID");
  const industry = Deno.env.get("KB_DEMO_INDUSTRY");
  const language = Deno.env.get("KB_DEMO_LANGUAGE") ?? "zh-TW";

  if (!companyIdStr || !industry) {
    return { resolved: false, reason: "KB_DEMO_CONFIG_MISSING" };
  }
  const kbCompanyId = parseInt(companyIdStr, 10);
  if (isNaN(kbCompanyId)) {
    return { resolved: false, reason: "KB_DEMO_COMPANY_ID_INVALID" };
  }

  return { resolved: true, scope: { kbCompanyId, industry, language } };
}

// ─── Canonical upstream fetch ────────────────────────────────────────────────

const KB_DEFAULT_TIMEOUT_MS = 12000;

export async function fetchKBRag(
  queryInput: KBQueryInput,
  scope: KBResolvedScope,
  endpointCfg: KBEndpointConfig,
  opts?: { timeoutMs?: number },
): Promise<KBRagResponse> {
  const timeoutMs = opts?.timeoutMs ?? KB_DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${endpointCfg.endpoint}/kb/rag-search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpointCfg.token}`,
      },
      body: JSON.stringify({
        query: queryInput.query,
        company_id: scope.kbCompanyId,
        industry: scope.industry,
        language: scope.language,
        status: "published",
        top_k: queryInput.top_k,
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
  clearTimeout(timeout);

  if (!response.ok) {
    return { success: false, chunks: [], citations: [], error_code: `KB_HTTP_${response.status}` };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { success: false, chunks: [], citations: [], error_code: "KB_INVALID_JSON" };
  }

  // Strict upstream contract validation
  if (!data || typeof data !== "object") {
    return { success: false, chunks: [], citations: [], error_code: "KB_SCHEMA_INVALID" };
  }
  const d = data as Record<string, unknown>;
  if (d.ok !== true) {
    return { success: false, chunks: [], citations: [], error_code: "KB_UPSTREAM_REJECTED" };
  }
  if (!Array.isArray(d.results)) {
    return { success: false, chunks: [], citations: [], error_code: "KB_SCHEMA_INVALID" };
  }

  // Legitimate empty: ok=true, results=[]
  const results = d.results as KBUpstreamChunk[];
  if (results.length === 0) {
    return { success: true, chunks: [], citations: [] };
  }

  // Defense-in-depth scope filter
  const scopedChunks = results.filter((c) => {
    if (c.company_id !== undefined && c.company_id !== null && c.company_id !== scope.kbCompanyId) return false;
    if (c.industry !== undefined && c.industry !== null && c.industry !== scope.industry) return false;
    return true;
  });

  const chunks: KBFullChunk[] = scopedChunks.slice(0, queryInput.top_k);
  const citations: KBCitationChunk[] = chunks.map((c) => ({
    display_label: typeof c.title === "string" ? c.title.slice(0, 200) : "KB document",
    content: typeof c.content === "string" ? c.content.slice(0, 500) : "",
    score: typeof c.score === "number" ? c.score : 0,
    source_type: typeof c.source_type === "string" ? c.source_type : "unknown",
  }));

  return { success: true, chunks, citations };
}
