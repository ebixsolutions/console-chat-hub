import {
  classifyCanonicalConversationTurn,
  type ConversationOperation,
  type SemanticHistoryRow,
} from "./conversation-semantic-contract.ts";

export type TransformOperation = "SIMPLIFY" | "REPHRASE" | "TRANSLATE" | "SUMMARIZE";

export interface PriorGroundedTransformContext {
  operation: TransformOperation;
  operations?: TransformOperation[];
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

const COMPOSITE_TRANSFORM_RULES: Array<[TransformOperation, RegExp]> = [
  ["TRANSLATE", /(?:用|改用)(?:廣東話|广东话|繁體中文|繁体中文|簡體中文|简体中文|英文)|\b(?:in|into)\s+(?:english|chinese|cantonese|traditional chinese|simplified chinese)\b|translate(?: that| it)?/i],
  ["SUMMARIZE", /(?:總結|总结|概括|歸納|归纳)|summari[sz]e/i],
  ["SIMPLIFY", /(?:簡單|简单)(?:一點|一点|啲|些|點|点)?|\b(?:simpler|shorter)\b|explain(?: it| that)? (?:more )?simply/i],
  ["REPHRASE", /(?:換句話|换句话|另一種講法|另一种说法|改寫|改写|重新講|重新说|rephrase|rewrite|say that another way|word it differently)/i],
];

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

export function detectRequestedTransformOperations(
  latest: string,
  primary: TransformOperation,
): TransformOperation[] {
  const requested = COMPOSITE_TRANSFORM_RULES
    .filter(([, pattern]) => pattern.test(latest))
    .map(([operation]) => operation);
  if (!requested.includes(primary)) requested.unshift(primary);
  return [...new Set(requested)];
}

function resolvedOperations(context: PriorGroundedTransformContext): TransformOperation[] {
  const operations = context.operations?.filter((op) => TRANSFORMS.has(op)) ?? [];
  return operations.length > 0 ? [...new Set(operations)] : [context.operation];
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

    const operation = semantic.operation as TransformOperation;
    return {
      operation,
      operations: detectRequestedTransformOperations(latest, operation),
      prior_answer: anchor.content,
      selected_document_id: selected,
      evidence_chunk_ids: lineageIds,
      prior_source_message_id: sourceMessageId,
      citations,
    };
  }
  return null;
}

export function buildPriorGroundedTransformGenerationSystem(
  context: PriorGroundedTransformContext | null,
): string {
  if (!context) return "";
  const operations = resolvedOperations(context);
  return [
    "You are a customer-service response transformer, not a factual answering system.",
    "The previously verified grounded answer below is the ONLY factual authority for this turn.",
    `Required transformation operations: ${operations.join(" + ")}.`,
    operations.length > 1
      ? "This is one composite transformation. Apply ALL listed operations to the same prior grounded answer in a single response."
      : "Apply the listed transformation to the same prior grounded answer.",
    "Transform that answer exactly as requested by the latest customer instruction.",
    "Do not use facts from conversation history, CRM/customer context, general knowledge, policies, titles, or any other prompt section.",
    "Do not add examples, explanations, caveats, eligibility conditions, jurisdictions, procedures, prices, dates, durations, quantities, model details, or recommendations unless they already appear in the prior grounded answer.",
    "Do not say that you checked, searched, know, recommend, infer, or verified anything beyond that prior answer.",
    "Return only the transformed customer-facing answer. No preface, no meta-commentary, no source discussion.",
    buildPriorGroundedTransformBlock(context),
  ].join("\n\n");
}

export function buildPriorGroundedTransformGenerationUser(
  latestInstruction: string,
): string {
  return [
    "Latest transformation instruction:",
    latestInstruction.normalize("NFKC").trim().slice(0, 1000),
    "",
    "Perform every transformation explicitly requested in this instruction, using only the prior grounded answer as factual authority. Do not answer any other question or add any new factual content.",
  ].join("\n");
}

export function buildPriorGroundedTransformRetrySystem(
  context: PriorGroundedTransformContext | null,
): string {
  const base = buildPriorGroundedTransformGenerationSystem(context);
  if (!base) return "";
  return [
    base,
    "STRICT RETRY: The previous transformed draft was rejected by the grounding verifier.",
    "Use shorter wording and copy factual nouns, numbers, product categories, jurisdictions, and conditions directly from the prior grounded answer whenever possible.",
    "For a composite transformation, preserve every requested operation while reducing wording; do not drop the requested target language or summary constraint.",
    "Do not introduce even plausible explanatory facts that are absent from the prior grounded answer.",
  ].join("\n\n");
}

export function buildPriorGroundedTransformBlock(
  context: PriorGroundedTransformContext | null,
): string {
  if (!context) return "";
  const operations = resolvedOperations(context);
  return [
    "Prior Grounded Answer transform rules:",
    `- Operation: ${context.operation}`,
    `- Operations: ${operations.join(" + ")}`,
    "- This is a transformation of the previously verified grounded answer, not a new factual query.",
    "- Transform ONLY the Prior Grounded Answer Evidence below.",
    "- Preserve factual meaning. Do not add, update, correct, infer, or replace facts from outside knowledge or other conversation text.",
    "- Simplification/rephrasing may change wording; translation may change language; summarization may omit detail, but none may introduce a new factual claim.",
    "- If multiple operations are listed, apply them together to this same evidence authority.",
    "- If the requested transformation cannot be completed without adding facts, say so without inventing information.",
    "Prior Grounded Answer Evidence:",
    "[chunk:PRIOR1]",
    context.prior_answer.slice(0, 3000),
  ].join("\n");
}

export function buildInheritedTransformCitationMetadata(
  context: PriorGroundedTransformContext | null,
): Record<string, unknown> | null {
  if (!context) return null;
  const operations = resolvedOperations(context);
  return {
    citations: context.citations.map((citation) => ({ ...citation })),
    citation_lineage: {
      selected_document_id: context.selected_document_id,
      evidence_chunk_ids: [...context.evidence_chunk_ids],
      evidence_count: context.evidence_chunk_ids.length,
    },
    transform_lineage: {
      operation: context.operation,
      operations,
      composite: operations.length > 1,
      authority: "PRIOR_GROUNDED_ANSWER",
      prior_source_message_id: context.prior_source_message_id,
    },
    response_route: "prior_grounded_transform",
  };
}