import {
  classifyCanonicalConversationTurn,
  type ConversationOperation,
  type SemanticHistoryRow,
} from "./conversation-semantic-contract.ts";

export type TransformOperation = "SIMPLIFY" | "REPHRASE" | "TRANSLATE" | "SUMMARIZE";

export interface PriorGroundedTransformContext {
  operation: TransformOperation;
  prior_answer: string;
  selected_document_id: string;
  evidence_chunk_ids: string[];
  prior_source_message_id: string;
  citations: Array<{
    label: string;
    source_type: string;
    relevance: "high" | "medium";
    document_id: string;
    chunk_id?: string;
    chunk_type: "full_content";
  }>;
}

const TRANSFORMS = new Set<ConversationOperation>([
  "SIMPLIFY",
  "REPHRASE",
  "TRANSLATE",
  "SUMMARIZE",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function clean(value: unknown, max = 4000): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

export function resolvePriorGroundedTransform(
  latest: string,
  newestFirst: SemanticHistoryRow[],
): PriorGroundedTransformContext | null {
  const semantic = classifyCanonicalConversationTurn(latest, newestFirst);
  if (
    semantic.evidence_authority !== "PRIOR_GROUNDED_ANSWER" ||
    !semantic.prior_grounded_answer ||
    !TRANSFORMS.has(semantic.operation)
  ) return null;

  const anchor = semantic.prior_grounded_answer;
  if (!anchor.source_message_id) return null;

  const sourceChunks = [...new Set(anchor.chunk_ids.filter(Boolean))];
  if (!anchor.document_id || sourceChunks.length === 0) return null;

  for (const row of newestFirst) {
    const role = String(row.role ?? "").toLowerCase();
    const content = clean(row.content);
    if ((role !== "assistant" && role !== "ai") || content !== clean(anchor.content)) continue;

    const meta = record(row.metadata);
    const lineage = record(meta?.citation_lineage);
    const selected = clean(lineage?.selected_document_id, 200);
    const lineageIds = Array.isArray(lineage?.evidence_chunk_ids)
      ? [...new Set(lineage.evidence_chunk_ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()))]
      : [];
    const sourceMessageId = clean(meta?.source_message_id, 200);
    if (
      selected !== anchor.document_id ||
      sourceMessageId !== anchor.source_message_id ||
      lineageIds.length !== sourceChunks.length ||
      lineageIds.some((id) => !sourceChunks.includes(id))
    ) return null;

    if (!Array.isArray(meta?.citations) || meta.citations.length === 0) return null;
    const citations: PriorGroundedTransformContext["citations"] = [];
    for (const item of meta.citations.slice(0, 3)) {
      const c = record(item);
      if (!c) return null;
      const documentId = clean(c.document_id, 200);
      const chunkId = clean(c.chunk_id, 200);
      const chunkType = clean(c.chunk_type, 40);
      const label = clean(c.label, 300) || "Knowledge Base source";
      const sourceType = clean(c.source_type, 80) || "unknown";
      const relevance = c.relevance === "high" ? "high" : c.relevance === "medium" ? "medium" : null;
      if (
        documentId !== selected ||
        chunkType !== "full_content" ||
        !relevance ||
        (chunkId && !lineageIds.includes(chunkId))
      ) return null;
      citations.push({
        label,
        source_type: sourceType,
        relevance,
        document_id: documentId,
        ...(chunkId ? { chunk_id: chunkId } : {}),
        chunk_type: "full_content",
      });
    }
    if (citations.length === 0) return null;

    return {
      operation: semantic.operation as TransformOperation,
      prior_answer: anchor.content,
      selected_document_id: selected,
      evidence_chunk_ids: lineageIds,
      prior_source_message_id: sourceMessageId,
      citations,
    };
  }
  return null;
}

export function buildPriorGroundedTransformBlock(
  context: PriorGroundedTransformContext | null,
): string {
  if (!context) return "";
  return [
    "Prior Grounded Answer transform rules:",
    `- Operation: ${context.operation}`,
    "- This is a transformation of the previously verified grounded answer, not a new factual query.",
    "- Transform ONLY the Prior Grounded Answer Evidence below.",
    "- Preserve factual meaning. Do not add, update, correct, infer, or replace facts from outside knowledge or other conversation text.",
    "- Simplification/rephrasing may change wording; translation may change language; summarization may omit detail, but none may introduce a new factual claim.",
    "- If the requested transformation cannot be completed without adding facts, say so without inventing information.",
    "Prior Grounded Answer Evidence:",
    context.prior_answer.slice(0, 3000),
  ].join("\n");
}

export function buildInheritedTransformCitationMetadata(
  context: PriorGroundedTransformContext | null,
): Record<string, unknown> | null {
  if (!context) return null;
  return {
    citations: context.citations.map((citation) => ({ ...citation })),
    citation_lineage: {
      selected_document_id: context.selected_document_id,
      evidence_chunk_ids: [...context.evidence_chunk_ids],
      evidence_count: context.evidence_chunk_ids.length,
    },
    transform_lineage: {
      operation: context.operation,
      authority: "PRIOR_GROUNDED_ANSWER",
      prior_source_message_id: context.prior_source_message_id,
    },
    response_route: "prior_grounded_transform",
  };
}
