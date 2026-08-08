// supabase/functions/_shared/kb-client.ts
// PR-2 Task 1 Director Takeover — canonical KB upstream adapter.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

export interface KBQueryInput {
  query: string;
  top_k: number;
}

export interface KBResolvedScope {
  kbCompanyId: number;
  industry: string;
  language: string;
}

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

export type TenantResolutionResult =
  | { resolved: true; scope: KBResolvedScope }
  | {
      resolved: false;
      reason:
        | "KB_DB_CONFIG_MISSING"
        | "KB_CONVERSATION_LOOKUP_FAILED"
        | "KB_CONVERSATION_NOT_FOUND"
        | "KB_TENANT_MAPPING_UNRESOLVED"
        | "KB_DEMO_DISABLED"
        | "KB_DEMO_CONFIG_MISSING"
        | "KB_DEMO_COMPANY_ID_INVALID";
    };

export async function resolveTenantScope(conversationId: string | null): Promise<TenantResolutionResult> {
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

    if (!conv) {
      return { resolved: false, reason: "KB_CONVERSATION_NOT_FOUND" };
    }

    if (!conv.company_id) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    }

    const { data: company, error: companyErr } = await sb
      .from("company")
      .select("id, external_tenant_id, external_workspace_id, is_active")
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

    // No authoritative KB numeric company_id + industry mapping exists in
    // the current schema. Do not reinterpret external_tenant_id or
    // external_workspace_id as KB identity.
    return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
  }

  // Demo mode is allowed only when there is no production conversation_id.
  if (Deno.env.get("KB_DEMO_MODE") !== "true") {
    return { resolved: false, reason: "KB_DEMO_DISABLED" };
  }

  const companyIdStr = Deno.env.get("KB_DEMO_COMPANY_ID");
  const industry = Deno.env.get("KB_DEMO_INDUSTRY");
  const language = Deno.env.get("KB_DEMO_LANGUAGE") ?? "zh-TW";

  if (!companyIdStr || !industry) {
    return { resolved: false, reason: "KB_DEMO_CONFIG_MISSING" };
  }

  const kbCompanyId = Number.parseInt(companyIdStr, 10);
  if (!Number.isFinite(kbCompanyId)) {
    return { resolved: false, reason: "KB_DEMO_COMPANY_ID_INVALID" };
  }

  return {
    resolved: true,
    scope: { kbCompanyId, industry, language },
  };
}

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

  const results = d.results as KBUpstreamChunk[];
  if (results.length === 0) {
    return { success: true, chunks: [], citations: [] };
  }

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
