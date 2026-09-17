/** Tenant-bound PostgreSQL FTS adapter for deterministic runtime mode. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "./supabase-admin-key.ts";
import {
  detectLocale,
  type SupportedLocale,
  type SupportedMarket,
} from "./deterministic-commerce-engine.ts";
import {
  createAggregationAuthorityMetadata,
  type AggregationAuthorityMetadata,
} from "./kb-aggregation-response.ts";

export interface KBQueryInput {
  query: string;
  top_k: number;
  market?: SupportedMarket;
  locale?: SupportedLocale;
}
export type KBScopeMode = "canonical" | "pre_activation" | "demo";
export interface KBResolvedScope {
  mode: KBScopeMode;
  aiCompanyId: string | null;
  singaporeTenantId: string;
}
export interface KBPreActivationActor {
  userId: string;
  allowPreActivation: true;
}
export interface KBFullChunk {
  document_id: string;
  doc_id?: string;
  chunk_id?: string;
  title?: string;
  content: string;
  score: number;
  chunk_type: "rag_summary" | "full_content" | "faq_pair" | "section";
  source_type: string;
  status: "published" | "historical" | "superseded" | "cancelled" | "draft";
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
export interface KBDocumentCandidate {
  document_id: string;
  title: string;
  source_type: string;
  document_score: number;
  chunks: KBFullChunk[];
  citations: KBCitationChunk[];
  llm_context: KBLLMContext;
  meta: KBRagMeta;
  authority?: AggregationAuthorityMetadata;
}
export interface KBRagResponse {
  success: boolean;
  chunks: KBFullChunk[];
  citations: KBCitationChunk[];
  documents: KBDocumentCandidate[];
  llm_context?: KBLLMContext;
  meta?: KBRagMeta;
  selected_document_id?: string;
  dropped_without_document_id?: number;
  dropped_without_content?: number;
  error_code?: string;
}
export interface KBEndpointConfig {
  mode: "postgres_fts";
}
export type TenantResolutionReason =
  | "KB_DB_CONFIG_MISSING"
  | "KB_CONVERSATION_LOOKUP_FAILED"
  | "KB_CONVERSATION_NOT_FOUND"
  | "KB_TENANT_MAPPING_UNRESOLVED"
  | "KB_TENANT_IDENTITY_CONFLICT"
  | "KB_DEMO_DISABLED";
export type TenantResolutionResult =
  { resolved: true; scope: KBResolvedScope } | { resolved: false; reason: TenantResolutionReason };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function resolveKBEndpoint(): KBEndpointConfig {
  return { mode: "postgres_fts" };
}

export async function resolveTenantScope(
  conversationId: string | null,
  _actor?: KBPreActivationActor,
): Promise<TenantResolutionResult> {
  if (!conversationId || !UUID_RE.test(conversationId)) {
    return { resolved: false, reason: "KB_DEMO_DISABLED" };
  }
  const url = Deno.env.get("SUPABASE_URL");
  let key = "";
  try {
    key = getSupabaseAdminKey();
  } catch {
    /* fail closed below */
  }
  if (!url || !key) return { resolved: false, reason: "KB_DB_CONFIG_MISSING" };
  const admin = createClient(url, key);
  const { data: conversation, error } = await admin
    .from("conversations")
    .select("company_id,channel_config_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) {
    return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
  }
  if (!conversation) {
    return { resolved: false, reason: "KB_CONVERSATION_NOT_FOUND" };
  }
  let channelCompany: string | null = null;
  if (conversation.channel_config_id) {
    const { data: channel, error: channelError } = await admin
      .from("channel_config")
      .select("company_id")
      .eq("id", conversation.channel_config_id)
      .maybeSingle();
    if (channelError) {
      return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    }
    channelCompany = typeof channel?.company_id === "string" ? channel.company_id : null;
  }
  const conversationCompany =
    typeof conversation.company_id === "string" ? conversation.company_id : null;
  if (conversationCompany && channelCompany && conversationCompany !== channelCompany)
    return { resolved: false, reason: "KB_TENANT_IDENTITY_CONFLICT" };
  const companyId = conversationCompany ?? channelCompany;
  if (!companyId || !UUID_RE.test(companyId)) {
    return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
  }
  const { data: company, error: companyError } = await admin
    .from("company")
    .select("id,is_active")
    .eq("id", companyId)
    .maybeSingle();
  if (companyError) {
    return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
  }
  if (!company || company.is_active !== true) {
    return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
  }
  return {
    resolved: true,
    scope: {
      mode: "canonical",
      aiCompanyId: companyId,
      singaporeTenantId: companyId,
    },
  };
}

function explicitMarket(query: string): SupportedMarket {
  if (/\b(?:united states|u\.s\.|usa|us market)\b/iu.test(query)) return "US";
  if (/香港|\bhong kong\b/iu.test(query)) return "HK";
  if (/台灣|台湾|\btaiwan\b/iu.test(query)) return "TW";
  return "UNKNOWN";
}

export async function fetchKBRag(
  queryInput: KBQueryInput,
  scope: KBResolvedScope,
  _endpoint: KBEndpointConfig,
  _opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<KBRagResponse> {
  const empty = (error_code?: string): KBRagResponse => ({
    success: false,
    chunks: [],
    citations: [],
    documents: [],
    ...(error_code ? { error_code } : {}),
  });
  const query = queryInput.query.normalize("NFKC").trim().slice(0, 500);
  const market = queryInput.market ?? explicitMarket(query);
  const locale = queryInput.locale ?? detectLocale(query);
  if (
    !scope.aiCompanyId ||
    !UUID_RE.test(scope.aiCompanyId) ||
    scope.mode !== "canonical" ||
    market === "UNKNOWN" ||
    query.length < 2
  )
    return empty("KB_FTS_SCOPE_OR_MARKET_UNRESOLVED");
  const url = Deno.env.get("SUPABASE_URL");
  let key = "";
  try {
    key = getSupabaseAdminKey();
  } catch {
    /* fail closed below */
  }
  if (!url || !key || _opts?.signal?.aborted) {
    return empty("KB_FTS_CONFIG_OR_SIGNAL_INVALID");
  }
  const admin = createClient(url, key);
  const { data, error } = await admin.rpc("c3_deterministic_kb_search", {
    p_company_id: scope.aiCompanyId,
    p_tenant_id: scope.singaporeTenantId,
    p_market: market,
    p_locale: locale,
    p_query: query,
    p_limit: Math.min(Math.max(queryInput.top_k, 1), 10),
  });
  if (
    error ||
    !Array.isArray(data) ||
    data.length === 0 ||
    data.some((row) => row.ambiguous_match === true)
  )
    return empty(error ? "KB_FTS_RPC_FAILED" : "KB_FTS_NO_UNAMBIGUOUS_MATCH");
  const chunks: KBFullChunk[] = data.map((row) => ({
    document_id: String(row.document_id),
    doc_id: String(row.document_id),
    chunk_id: String(row.chunk_id),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    score: Number(row.rank ?? 0),
    chunk_type: "full_content",
    source_type: "postgres_fts",
    status: "published",
  }));
  const byDocument = new Map<string, KBFullChunk[]>();
  for (const chunk of chunks) {
    byDocument.set(chunk.document_id, [...(byDocument.get(chunk.document_id) ?? []), chunk]);
  }
  const documents: KBDocumentCandidate[] = [...byDocument.entries()].map(([documentId, rows]) => {
    const citations = rows.map((row) => ({
      display_label: row.title || documentId,
      content: row.content,
      score: row.score,
      source_type: row.source_type,
      document_id: documentId,
      chunk_id: row.chunk_id,
      chunk_type: row.chunk_type,
    }));
    const context = {
      selected_document_id: documentId,
      orientation_summary: null,
      full_content_evidence: rows.map((row) => ({
        document_id: documentId,
        chunk_id: row.chunk_id,
        content: row.content,
        score: row.score,
        source_type: row.source_type,
      })),
    };
    const scores = rows.map((row) => row.score).sort((a, b) => b - a);
    const meta = {
      document_score: scores[0] ?? 0,
      highest_chunk_score: scores[0] ?? 0,
      second_highest_chunk_score: scores[1] ?? 0,
      returned_summary_count: 0,
      returned_full_content_count: rows.length,
      dropped_without_document_id: 0,
      dropped_without_content: 0,
    };
    const authority: AggregationAuthorityMetadata = createAggregationAuthorityMetadata({
      tenant_id: scope.singaporeTenantId,
      publication_state: "published",
      currentness: "current",
      entity_ids: [],
      regions: [market],
      language: locale,
      version: null,
      version_rank: null,
      updated_at: null,
      source_priority: null,
      claims: [],
    });
    return {
      document_id: documentId,
      title: rows[0]?.title ?? "",
      source_type: "postgres_fts",
      document_score: meta.document_score,
      chunks: rows,
      citations,
      llm_context: context,
      meta,
      authority,
    };
  });
  const only = documents.length === 1 ? documents[0] : null;
  return {
    success: true,
    chunks,
    citations: documents.flatMap((row) => row.citations),
    documents,
    ...(only
      ? {
          llm_context: only.llm_context,
          meta: only.meta,
          selected_document_id: only.document_id,
        }
      : {}),
  };
}

export function singaporeCompanyIdFromScope(_scope: KBResolvedScope): number | null {
  return null;
}
