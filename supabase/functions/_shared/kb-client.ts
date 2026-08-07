// supabase/functions/_shared/kb-client.ts
//
// PR-2 Task 1 — ONE canonical KB upstream adapter.
// Both kb-search-proxy and generate-reply import this module.

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

export interface KBRagRequest {
  query: string;
  top_k: number;
  company_id?: number;
  industry?: string;
  language?: string;
}

export interface KBRagResponse {
  success: boolean;
  chunks: KBFullChunk[];
  citations: KBCitationChunk[];
  error_code?: string;
}

export interface KBConfig {
  endpoint: string;
  token: string;
  companyId: number;
  industry: string;
  language: string;
}

export function resolveKBConfig(): KBConfig | null {
  const endpoint = Deno.env.get("KB_RAG_ENDPOINT");
  const token = Deno.env.get("KB_RAG_TOKEN");
  const companyIdStr = Deno.env.get("KB_DEMO_COMPANY_ID");
  const industry = Deno.env.get("KB_DEMO_INDUSTRY");
  const language = Deno.env.get("KB_DEMO_LANGUAGE") ?? "zh-TW";
  if (!endpoint || !token || !companyIdStr || !industry) return null;
  const companyId = parseInt(companyIdStr, 10);
  if (isNaN(companyId)) return null;
  return { endpoint, token, companyId, industry, language };
}

const KB_DEFAULT_TIMEOUT_MS = 12000;

export async function fetchKBRag(
  req: KBRagRequest,
  cfg: KBConfig,
  opts?: { timeoutMs?: number },
): Promise<KBRagResponse> {
  const timeoutMs = opts?.timeoutMs ?? KB_DEFAULT_TIMEOUT_MS;
  const companyId = req.company_id ?? cfg.companyId;
  const industry = req.industry ?? cfg.industry;
  const language = req.language ?? cfg.language;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${cfg.endpoint}/kb/rag-search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        query: req.query,
        company_id: companyId,
        industry,
        language,
        status: "published",
        top_k: req.top_k,
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

  let data: { ok?: boolean; results?: KBUpstreamChunk[] };
  try {
    data = await response.json();
  } catch {
    return { success: false, chunks: [], citations: [], error_code: "KB_INVALID_JSON" };
  }

  if (!data.ok || !Array.isArray(data.results)) {
    return { success: true, chunks: [], citations: [] };
  }

  const scopedChunks = data.results.filter((c) => {
    if (c.company_id !== undefined && c.company_id !== null && c.company_id !== companyId) return false;
    if (c.industry !== undefined && c.industry !== null && c.industry !== industry) return false;
    return true;
  });

  const chunks: KBFullChunk[] = scopedChunks.slice(0, req.top_k);

  const citations: KBCitationChunk[] = chunks.map((c) => ({
    display_label: typeof c.title === "string" ? c.title.slice(0, 200) : "KB document",
    content: typeof c.content === "string" ? c.content.slice(0, 500) : "",
    score: typeof c.score === "number" ? c.score : 0,
    source_type: typeof c.source_type === "string" ? c.source_type : "unknown",
  }));

  return { success: true, chunks, citations };
}
