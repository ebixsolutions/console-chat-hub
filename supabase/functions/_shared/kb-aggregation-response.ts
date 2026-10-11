// supabase/functions/_shared/kb-aggregation-response.ts
// Strict parser for the Singapore KB aggregated RAG v1 response contract.
// Structured selected_documents[].evidence[] is authoritative for grounding.
// llm_context.combined_text is intentionally not used as factual evidence.
//
// Task 1.1 invariant: Singapore may return multiple candidate documents, but
// evidence is parsed and retained per document. Callers must select exactly one
// winning document before exposing llm_context/policy evidence to the UI.

export type AggregationChunkType = "rag_summary" | "full_content" | "faq_pair" | "section";

export interface AggregationChunk {
  document_id: string;
  chunk_id?: string;
  title: string;
  source_type: string;
  content: string;
  score: number;
  chunk_type: AggregationChunkType;
}

export interface AggregationCitation {
  display_label: string;
  content: string;
  score: number;
  source_type: string;
  document_id: string;
  chunk_id?: string;
  chunk_type: AggregationChunkType;
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

export interface AggregationAuthorityMetadata {
  tenant_id: string | null;
  publication_state: string | null;
  currentness: "current" | "historical" | "superseded" | "cancelled" | "unknown";
  entity_ids: string[];
  regions: string[];
  language: string | null;
  version: string | null;
  version_rank: number | null;
  updated_at: string | null;
  source_priority: number | null;
  claims: Array<{ key: string; value: string }>;
}

/** Runtime constructor shared by all KB adapters so authority metadata cannot drift by transport. */
export function createAggregationAuthorityMetadata(
  value: AggregationAuthorityMetadata,
): AggregationAuthorityMetadata {
  return {
    ...value,
    entity_ids: [...value.entity_ids],
    regions: [...value.regions],
    claims: value.claims.map((claim) => ({ ...claim })),
  };
}

export interface AggregationDocumentCandidate {
  document_id: string;
  title: string;
  source_type: string;
  document_score: number;
  chunks: AggregationChunk[];
  citations: AggregationCitation[];
  llm_context: AggregationInternalContext;
  meta: AggregationMeta;
  authority: AggregationAuthorityMetadata;
}

export type ParsedAggregationResponse =
  | {
      ok: true;
      contextFound: false;
      chunks: [];
      citations: [];
      documents: [];
    }
  | {
      ok: true;
      contextFound: true;
      chunks: AggregationChunk[];
      citations: AggregationCitation[];
      documents: AggregationDocumentCandidate[];
    }
  | { ok: false; error_code: string };

type Obj = Record<string, unknown>;
const MAX_SELECTED_DOCUMENTS = 5;
const MAX_SUMMARY_CHUNKS_PER_DOCUMENT = 1;
const MAX_FULL_CONTENT_CHUNKS_PER_DOCUMENT = 3;

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

function stringArray(value: unknown, maxItems = 24, maxLength = 160): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.normalize("NFKC").trim().slice(0, maxLength))
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

function authorityMetadata(doc: Obj): AggregationAuthorityMetadata {
  const metadata = isObj(doc.authority) ? doc.authority : isObj(doc.metadata) ? doc.metadata : {};
  const first = (...values: unknown[]) => values.map(nonEmpty).find(Boolean) ?? null;
  const firstIdentifier = (...values: unknown[]) => {
    for (const value of values) {
      const parsed =
        nonEmpty(value) ??
        (typeof value === "number" && Number.isSafeInteger(value) ? String(value) : null);
      if (parsed) return parsed;
    }
    return null;
  };
  const currentRaw = first(
    metadata.currentness,
    metadata.freshness_status,
    doc.currentness,
    doc.freshness_status,
  )?.toLowerCase();
  const explicitCurrent =
    typeof metadata.is_current === "boolean"
      ? metadata.is_current
      : typeof doc.is_current === "boolean"
        ? doc.is_current
        : null;
  const currentness =
    currentRaw === "historical" ||
    currentRaw === "superseded" ||
    currentRaw === "cancelled" ||
    currentRaw === "current"
      ? currentRaw
      : explicitCurrent === false
        ? "historical"
        : explicitCurrent === true
          ? "current"
          : "unknown";
  const rawClaims = Array.isArray(metadata.claims)
    ? metadata.claims
    : Array.isArray(doc.claims)
      ? doc.claims
      : [];
  const claims = rawClaims
    .flatMap((claim): Array<{ key: string; value: string }> => {
      if (!isObj(claim)) return [];
      const key = first(claim.key, claim.fact_key);
      const value = first(claim.value, claim.fact_value);
      return key && value ? [{ key: key.slice(0, 200), value: value.slice(0, 500) }] : [];
    })
    .slice(0, 24);
  const versionRank = finite(
    metadata.version_rank ?? metadata.version_number ?? doc.version_rank ?? doc.version_number,
  );
  const sourcePriority = finite(metadata.source_priority ?? doc.source_priority);
  return {
    tenant_id: firstIdentifier(
      metadata.tenant_id,
      metadata.company_id,
      doc.tenant_id,
      doc.company_id,
    ),
    publication_state: first(
      metadata.publication_state,
      metadata.status,
      doc.publication_state,
      doc.status,
    ),
    currentness,
    entity_ids: stringArray(metadata.entity_ids ?? metadata.models ?? doc.entity_ids ?? doc.models),
    regions: stringArray(
      metadata.regions ?? metadata.markets ?? doc.regions ?? doc.markets,
      12,
      80,
    ),
    language: first(metadata.language, doc.language),
    version: first(metadata.version, metadata.version_id, doc.version, doc.version_id),
    version_rank: versionRank,
    updated_at: first(metadata.updated_at, metadata.published_at, doc.updated_at, doc.published_at),
    source_priority: sourcePriority,
    claims,
  };
}

function parseDocumentCandidate(doc: unknown): AggregationDocumentCandidate | null {
  if (!isObj(doc)) return null;

  const documentId = nonEmpty(doc.document_id);
  const title = nonEmpty(doc.title) ?? "Knowledge Base document";
  const sourceType = nonEmpty(doc.source_type) ?? "knowledge";
  const documentScore = finite(doc.document_score);
  if (!documentId || documentScore === null || !Array.isArray(doc.evidence)) {
    return null;
  }

  const chunks: AggregationChunk[] = [];
  const citations: AggregationCitation[] = [];
  const fullEvidence: AggregationEvidence[] = [];
  const scores: number[] = [];
  let orientationSummary: string | null = null;

  if (doc.summary !== null && doc.summary !== undefined) {
    if (!isObj(doc.summary)) return null;
    const content = nonEmpty(doc.summary.content);
    const score = finite(doc.summary.score);
    const chunkId = nonEmpty(doc.summary.chunk_id) ?? undefined;
    if (!content || score === null || doc.summary.chunk_type !== "rag_summary") return null;

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

  let fullCount = 0;
  let summaryCount = orientationSummary ? 1 : 0;
  for (const item of doc.evidence) {
    if (!isObj(item)) return null;
    const content = nonEmpty(item.content);
    const score = finite(item.score);
    const chunkId = nonEmpty(item.chunk_id) ?? undefined;
    const chunkType = item.chunk_type;
    if (
      !content ||
      score === null ||
      (chunkType !== "rag_summary" &&
        chunkType !== "full_content" &&
        chunkType !== "faq_pair" &&
        chunkType !== "section")
    )
      return null;

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
        ...(chunkId ? { chunk_id: chunkId } : {}),
        content,
        score,
        source_type: sourceType,
      });
    }

    scores.push(score);
    chunks.push({
      document_id: documentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      title,
      source_type: sourceType,
      content,
      score,
      chunk_type: chunkType as AggregationChunkType,
    });
    citations.push({
      display_label: title.slice(0, 200),
      content: content.slice(0, 500),
      score,
      source_type: sourceType,
      document_id: documentId,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      chunk_type: chunkType as AggregationChunkType,
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
      full_content_evidence: fullEvidence,
    },
    meta: {
      document_score: documentScore,
      highest_chunk_score: scores[0] ?? 0,
      second_highest_chunk_score: scores[1] ?? 0,
      returned_summary_count: orientationSummary ? 1 : 0,
      returned_full_content_count: fullEvidence.length,
      dropped_without_document_id: 0,
      dropped_without_content: 0,
    },
    authority: authorityMetadata(doc),
  };
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
    if (data.llm_context !== undefined && data.llm_context !== null) {
      if (!isObj(data.llm_context)) {
        return { ok: false, error_code: "KB_SCHEMA_INVALID" };
      }
      const sc = finite(data.llm_context.summary_count);
      const ec = finite(data.llm_context.evidence_count);
      if (sc !== 0 || ec !== 0) {
        return { ok: false, error_code: "KB_SCHEMA_INVALID" };
      }
    }
    return {
      ok: true,
      contextFound: false,
      chunks: [],
      citations: [],
      documents: [],
    };
  }

  if (
    !Array.isArray(data.selected_documents) ||
    data.selected_documents.length < 1 ||
    data.selected_documents.length > MAX_SELECTED_DOCUMENTS
  ) {
    return { ok: false, error_code: "KB_SCHEMA_INVALID" };
  }

  const documents: AggregationDocumentCandidate[] = [];
  const seenDocumentIds = new Set<string>();
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
    citations: documents.flatMap((d) => d.citations),
  };
}
