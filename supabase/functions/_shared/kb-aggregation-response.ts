// supabase/functions/_shared/kb-aggregation-response.ts
// Strict parser for the Singapore KB aggregated RAG v1 response contract.
// The API key binds tenant scope server-side; this parser never accepts or
// derives tenant/company scope from the upstream response.

export interface AggregationChunk {
  document_id: string;
  chunk_id?: string;
  title: string;
  source_type: string;
  content: string;
  score: number;
  chunk_type: "rag_summary" | "full_content";
}

export interface AggregationCitation {
  display_label: string;
  content: string;
  score: number;
  source_type: string;
  document_id: string;
  chunk_id?: string;
  chunk_type: "rag_summary" | "full_content";
}

export interface AggregationEvidence {
  document_id: string;
  chunk_id?: string;
  content: string;
  score: number;
  source_type: string;
}

export interface AggregationInternalContext {
  selected_document_id: string;
  orientation_summary: string | null;
  full_content_evidence: AggregationEvidence[];
}

export interface AggregationMeta {
  document_score: number;
  highest_chunk_score: number;
  second_highest_chunk_score: number;
  returned_summary_count: number;
  returned_full_content_count: number;
  dropped_without_document_id: number;
  dropped_without_content: number;
}

export type ParsedAggregationResponse =
  | {
      ok: true;
      contextFound: false;
      chunks: [];
      citations: [];
      llmContext?: undefined;
      meta?: undefined;
      selectedDocumentId?: undefined;
    }
  | {
      ok: true;
      contextFound: true;
      chunks: AggregationChunk[];
      citations: AggregationCitation[];
      llmContext: AggregationInternalContext;
      meta: AggregationMeta;
      selectedDocumentId: string;
    }
  | { ok: false; error_code: string };

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function finite(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function parseAggregationResponse(data: unknown): ParsedAggregationResponse {
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
    if (!isObj(data.llm_context)) {
      return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    }
    const sc = finite(data.llm_context.summary_count);
    const ec = finite(data.llm_context.evidence_count);
    if (sc !== 0 || ec !== 0 || data.llm_context.combined_text !== "") {
      return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    }
    return { ok: true, contextFound: false, chunks: [], citations: [] };
  }

  if (!Array.isArray(data.selected_documents) || data.selected_documents.length !== 1) {
    return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  }
  if (!Array.isArray(data.citations) || !isObj(data.llm_context)) {
    return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  }

  const doc = data.selected_documents[0];
  if (!isObj(doc)) return { ok: false, error_code: "KB_SCHEMA_INVALID" };

  const documentId = nonEmpty(doc.document_id);
  const title = nonEmpty(doc.title);
  const sourceType = nonEmpty(doc.source_type);
  const documentScore = finite(doc.document_score);
  if (!documentId || !title || !sourceType || documentScore === null) {
    return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  }

  const chunks: AggregationChunk[] = [];
  const citations: AggregationCitation[] = [];
  const fullEvidence: AggregationEvidence[] = [];
  const scores: number[] = [];

  let orientationSummary: string | null = null;
  if (doc.summary !== null && doc.summary !== undefined) {
    if (!isObj(doc.summary)) return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    const content = nonEmpty(doc.summary.content);
    const score = finite(doc.summary.score);
    const chunkType = doc.summary.chunk_type;
    const chunkId = nonEmpty(doc.summary.chunk_id) ?? undefined;
    if (!content || score === null || chunkType !== "rag_summary") {
      return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    }
    orientationSummary = content;
    scores.push(score);
    chunks.push({
      document_id: documentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      title,
      source_type: sourceType,
      content,
      score,
      chunk_type: "rag_summary",
    });
    citations.push({
      display_label: title.slice(0, 200),
      content: content.slice(0, 500),
      score,
      source_type: sourceType,
      document_id: documentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      chunk_type: "rag_summary",
    });
  }

  if (!Array.isArray(doc.evidence) || doc.evidence.length > 3) {
    return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  }
  for (const item of doc.evidence) {
    if (!isObj(item)) return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    const content = nonEmpty(item.content);
    const score = finite(item.score);
    const chunkId = nonEmpty(item.chunk_id) ?? undefined;
    if (!content || score === null || item.chunk_type !== "full_content") {
      return { ok: false, error_code: "KB_SCHEMA_INVALID" };
    }
    scores.push(score);
    chunks.push({
      document_id: documentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      title,
      source_type: sourceType,
      content,
      score,
      chunk_type: "full_content",
    });
    citations.push({
      display_label: title.slice(0, 200),
      content: content.slice(0, 500),
      score,
      source_type: sourceType,
      document_id: documentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      chunk_type: "full_content",
    });
    fullEvidence.push({
      document_id: documentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      content,
      score,
      source_type: sourceType,
    });
  }

  if (!orientationSummary && fullEvidence.length === 0) {
    return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  }

  scores.sort((a, b) => b - a);
  const llmContext: AggregationInternalContext = {
    selected_document_id: documentId,
    orientation_summary: orientationSummary,
    full_content_evidence: fullEvidence,
  };
  const meta: AggregationMeta = {
    document_score: documentScore,
    highest_chunk_score: scores[0] ?? 0,
    second_highest_chunk_score: scores[1] ?? 0,
    returned_summary_count: orientationSummary ? 1 : 0,
    returned_full_content_count: fullEvidence.length,
    dropped_without_document_id: 0,
    dropped_without_content: 0,
  };

  return {
    ok: true,
    contextFound: true,
    chunks,
    citations,
    llmContext,
    meta,
    selectedDocumentId: documentId,
  };
}
