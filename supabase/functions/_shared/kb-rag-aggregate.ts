/**
 * PR-KB — Knowledge Base v2 document-centric RAG aggregation.
 *
 * Authoritative KB v2 schema:
 * - KBVectorChunk.document_id: string
 * - KBVectorChunk.chunk_type: full_content | rag_summary | faq_pair | section
 * - KBVectorChunk.chunk_text: string
 *
 * Frozen retrieval target:
 * candidate chunks
 *   -> group by document_id
 *   -> choose the most relevant document
 *   -> at most 1 rag_summary
 *   -> 0..3 most relevant full_content chunks
 *
 * Pure function: no DB/network/writes.
 */

export type KBRagChunkType =
  | "full_content"
  | "rag_summary"
  | "faq_pair"
  | "section"
  | "unknown";

export interface KBRagCandidate {
  document_id?: string;
  doc_id?: string; // legacy upstream alias, normalized only
  chunk_id?: string;
  title?: string;
  content?: string;
  chunk_text?: string; // KB v2 authoritative field
  score?: number;
  chunk_type?: string;
  source_type?: string;
  status?: string;
  industry?: string;
  company_id?: number;
  language?: string;
  published_at?: string;
  updated_at?: string;
}

export interface KBAggregatedChunk {
  document_id: string;
  chunk_id?: string;
  title?: string;
  content: string;
  score: number;
  chunk_type: KBRagChunkType;
  source_type?: string;
  status?: string;
  industry?: string;
  company_id?: number;
  language?: string;
  published_at?: string;
  updated_at?: string;
}

export interface KBAggregationResult {
  document_id: string | null;
  document_score: number | null;
  highest_chunk_score: number | null;
  second_highest_chunk_score: number | null;
  chunks: KBAggregatedChunk[];
  dropped_without_document_id: number;
  dropped_without_content: number;
}

function finiteScore(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeChunkType(value: unknown): KBRagChunkType {
  return value === "full_content" ||
      value === "rag_summary" ||
      value === "faq_pair" ||
      value === "section"
    ? value
    : "unknown";
}

function normalizeCandidate(
  candidate: KBRagCandidate,
): KBAggregatedChunk | null {
  const documentId =
    typeof candidate.document_id === "string" && candidate.document_id.trim()
      ? candidate.document_id.trim()
      : typeof candidate.doc_id === "string" && candidate.doc_id.trim()
        ? candidate.doc_id.trim()
        : null;

  if (!documentId) return null;

  const rawContent =
    typeof candidate.chunk_text === "string" && candidate.chunk_text.trim()
      ? candidate.chunk_text
      : typeof candidate.content === "string" && candidate.content.trim()
        ? candidate.content
        : null;

  if (!rawContent) return null;

  return {
    document_id: documentId,
    ...(candidate.chunk_id ? { chunk_id: candidate.chunk_id } : {}),
    ...(candidate.title ? { title: candidate.title } : {}),
    content: rawContent,
    score: finiteScore(candidate.score),
    chunk_type: normalizeChunkType(candidate.chunk_type),
    ...(candidate.source_type ? { source_type: candidate.source_type } : {}),
    ...(candidate.status ? { status: candidate.status } : {}),
    ...(candidate.industry ? { industry: candidate.industry } : {}),
    ...(candidate.company_id !== undefined
      ? { company_id: candidate.company_id }
      : {}),
    ...(candidate.language ? { language: candidate.language } : {}),
    ...(candidate.published_at
      ? { published_at: candidate.published_at }
      : {}),
    ...(candidate.updated_at ? { updated_at: candidate.updated_at } : {}),
  };
}

/**
 * Selects exactly one best document.
 *
 * Ranking:
 * 1. document_score = highest_chunk_score + 0.2 * second_highest_chunk_score
 * 2. highest candidate score
 * 3. deterministic lexical document_id tie-break
 *
 * Output:
 * - max 1 rag_summary
 * - max 3 full_content
 * - no faq_pair/section substitution for full_content
 */
export function aggregateKBRagByDocument(
  candidates: KBRagCandidate[],
): KBAggregationResult {
  let droppedWithoutDocumentId = 0;
  let droppedWithoutContent = 0;

  const normalized: KBAggregatedChunk[] = [];
  for (const candidate of candidates) {
    const hasDocumentId =
      (typeof candidate.document_id === "string" &&
        candidate.document_id.trim().length > 0) ||
      (typeof candidate.doc_id === "string" &&
        candidate.doc_id.trim().length > 0);

    if (!hasDocumentId) {
      droppedWithoutDocumentId += 1;
      continue;
    }

    const chunk = normalizeCandidate(candidate);
    if (!chunk) {
      droppedWithoutContent += 1;
      continue;
    }
    normalized.push(chunk);
  }

  if (normalized.length === 0) {
    return {
      document_id: null,
      document_score: null,
      highest_chunk_score: null,
      second_highest_chunk_score: null,
      chunks: [],
      dropped_without_document_id: droppedWithoutDocumentId,
      dropped_without_content: droppedWithoutContent,
    };
  }

  const groups = new Map<string, KBAggregatedChunk[]>();
  for (const chunk of normalized) {
    const group = groups.get(chunk.document_id) ?? [];
    group.push(chunk);
    groups.set(chunk.document_id, group);
  }

  const rankedDocuments = [...groups.entries()]
    .map(([documentId, chunks]) => {
      const scores = chunks
        .map((c) => c.score)
        .sort((a, b) => b - a);
      const highestScore = scores[0] ?? 0;
      const secondHighestScore = scores[1] ?? 0;
      const documentScore = highestScore + 0.2 * secondHighestScore;
      return {
        documentId,
        chunks,
        highestScore,
        secondHighestScore,
        documentScore,
      };
    })
    .sort((a, b) =>
      b.documentScore - a.documentScore ||
      b.highestScore - a.highestScore ||
      a.documentId.localeCompare(b.documentId)
    );

  const best = rankedDocuments[0];

  const summaries = best.chunks
    .filter((c) => c.chunk_type === "rag_summary")
    .sort((a, b) => b.score - a.score)
    .slice(0, 1);

  const fullContent = best.chunks
    .filter((c) => c.chunk_type === "full_content")
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return {
    document_id: best.documentId,
    document_score: best.documentScore,
    highest_chunk_score: best.highestScore,
    second_highest_chunk_score: best.secondHighestScore,
    chunks: [...summaries, ...fullContent],
    dropped_without_document_id: droppedWithoutDocumentId,
    dropped_without_content: droppedWithoutContent,
  };
}
