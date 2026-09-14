import {
  classifyCanonicalConversationTurn,
  type ConversationOperation,
  type SemanticHistoryRow,
} from "./conversation-semantic-contract.ts";
import { deriveCurrentGroundingTarget, type CurrentGroundingTarget } from "./canonical-grounding.ts";

export type TransformOperation = "SIMPLIFY" | "REPHRASE" | "TRANSLATE" | "SUMMARIZE";

export interface PriorGroundedTransformContext {
  operation: TransformOperation;
  operations?: TransformOperation[];
  prior_answer: string;
  selected_document_id: string;
  evidence_chunk_ids: string[];
  prior_source_message_id: string;
  grounding_target?: CurrentGroundingTarget;
  authority_decision?: string;
  evidence_state?: string;
  requested_summary_count?: number;
  citations: Array<{
    label: string;
    source_type: string;
    relevance: "high" | "medium";
    document_id: string;
    chunk_id?: string;
    chunk_type: "full_content";
    target_entity_model?: string[];
    target_topics?: string[];
    authority_decision?: string;
    evidence_state?: string;
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
  ["SIMPLIFY", /(?:簡單|简单)(?:一點|一点|啲|些|點|点)?|\b(?:simpler|short(?:en|er))\b|explain(?: it| that)? (?:more )?simply/i],
  ["REPHRASE", /(?:換句話|换句话|另一種講法|另一种说法|改寫|改写|重新講|重新说|rephrase|rewrite|say that another way|word it differently)/i],
];

const CHINESE_COUNT: Record<string, number> = {
  一: 1,
  二: 2,
  兩: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const BROAD_SUMMARY_SCOPE = /(?:已確認|已确认)(?:資料|资料)|(?:剛才|刚才|以上|之前|我們|我们).{0,24}(?:內容|内容|資料|资料|討論|讨论)|\b(?:the above|what we discussed|our conversation|confirmed information|confirmed facts)\b/i;
const CURRENT_REQUIREMENTS_SUMMARY_SCOPE = /(?:(?:按|根據|根据|基於|基于|依照|based\s+on|according\s+to).{0,30}(?:最新|目前|現在|现在|current|latest).{0,30}(?:條件|条件|需求|要求|requirements?)|(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list).{0,30}(?:我|客戶|客户|customer)?\s*.{0,12}(?:最新|目前|現在|现在|current|latest).{0,20}(?:條件|条件|需求|要求|requirements?)|(?:最新|目前|現在|现在|current|latest).{0,20}(?:條件|条件|需求|要求|requirements?).{0,30}(?:總結|总结|整理|列出|概括|歸納|归纳|summari[sz]e|list))/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function readGroundingTarget(value: unknown): CurrentGroundingTarget | null {
  const target = record(value);
  if (!target) return null;
  return {
    entity_ids: stringList(target.entity_ids),
    topic_ids: stringList(target.topic_ids),
    region: typeof target.region === "string" && target.region.trim() ? target.region : null,
    explicit_entity: target.explicit_entity === true,
    explicit_topic: target.explicit_topic === true,
    target_changed: target.target_changed === true,
  };
}

function targetKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function targetOverlap(expected: string[], actual: string[]): boolean {
  const actualKeys = new Set(actual.map(targetKey).filter(Boolean));
  return expected.some((value) => actualKeys.has(targetKey(value)));
}

function transformTargetCompatible(latest: string, prior: CurrentGroundingTarget | null): boolean {
  const requested = deriveCurrentGroundingTarget(latest);
  const hasExplicitBoundary = requested.explicit_entity || requested.explicit_topic || Boolean(requested.region);
  if (!hasExplicitBoundary) return true;
  if (!prior) return false;
  if (requested.explicit_entity && !targetOverlap(requested.entity_ids, prior.entity_ids)) return false;
  if (requested.explicit_topic && !targetOverlap(requested.topic_ids, prior.topic_ids)) return false;
  if (requested.region && requested.region !== prior.region) return false;
  return true;
}

function clean(value: unknown, max = 4000): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function normalizedChunkIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()))]
    : [];
}

function sameLineage(
  documentId: string,
  chunkIds: string[],
  candidateDocumentId: string,
  candidateChunkIds: string[],
): boolean {
  return candidateDocumentId === documentId &&
    candidateChunkIds.length === chunkIds.length &&
    candidateChunkIds.every((id) => chunkIds.includes(id));
}

function supportedPointCount(content: string): number {
  const raw = typeof content === "string" ? content.normalize("NFKC").trim() : "";
  if (!raw) return 0;
  const bullets = raw
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line));
  if (bullets.length > 0) return bullets.length;
  return raw
    .split(/[。！？!?]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .length;
}

function selectBroadSummaryAnchor(
  latest: string,
  newestFirst: SemanticHistoryRow[],
  anchor: {
    content: string;
    document_id: string;
    chunk_ids: string[];
    source_message_id: string | null;
  },
  requestedSummaryCount: number | null,
): typeof anchor {
  if (!BROAD_SUMMARY_SCOPE.test(latest)) return anchor;
  const anchorChunks = [...new Set(anchor.chunk_ids.filter(Boolean))];
  if (!anchor.document_id || anchorChunks.length === 0) return anchor;

  const minimumPoints = requestedSummaryCount ?? 1;
  for (const row of newestFirst) {
    const role = String(row.role ?? "").toLowerCase();
    if (role !== "assistant" && role !== "ai") continue;
    const content = clean(row.content);
    if (!content || content === "__THINKING__") continue;
    const meta = record(row.metadata);
    const lineage = record(meta?.citation_lineage);
    const selected = clean(lineage?.selected_document_id, 200);
    const ids = normalizedChunkIds(lineage?.evidence_chunk_ids);
    const sourceMessageId = clean(meta?.source_message_id, 200);
    if (!sourceMessageId || !sameLineage(anchor.document_id, anchorChunks, selected, ids)) continue;
    if (supportedPointCount(content) < minimumPoints) continue;
    return {
      content,
      document_id: selected,
      chunk_ids: ids,
      source_message_id: sourceMessageId,
    };
  }
  return anchor;
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

export function detectRequestedSummaryCount(latest: string): number | null {
  const normalized = latest.normalize("NFKC");
  const chinese = normalized.match(/(?:用|以|分成|分為|分为)?\s*([一二兩两三四五六七八九十]|\d{1,2})\s*(?:點|点|項|项|條|条|個|个)(?:重點|重点)?\s*(?:來|来)?\s*(?:總結|总结|概括|歸納|归纳)?/i);
  const english = normalized.match(/(?:in|using|with)?\s*(\d{1,2})\s*(?:points?|bullets?|items?)\b/i);
  const raw = chinese?.[1] ?? english?.[1] ?? "";
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : CHINESE_COUNT[raw];
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 10 ? parsed : null;
}

function resolvedOperations(context: PriorGroundedTransformContext): TransformOperation[] {
  const operations = context.operations?.filter((op) => TRANSFORMS.has(op)) ?? [];
  return operations.length > 0 ? [...new Set(operations)] : [context.operation];
}

function fixedCountContract(context: PriorGroundedTransformContext): string[] {
  const count = context.requested_summary_count;
  if (!count || !resolvedOperations(context).includes("SUMMARIZE")) return [];
  return [
    `- Requested summary count: ${count} points/bullets. This is a formatting target, NEVER permission to create or infer facts.`,
    `- Return AT MOST ${count} supported points. Use exactly ${count} only when the Prior Grounded Answer already contains ${count} distinct factual points.`,
    "- If the Prior Grounded Answer contains fewer supported points, return fewer points. Grounding has higher priority than satisfying the requested count.",
    "- Never split one factual claim into artificial variants, repeat the same claim, or add filler merely to reach the requested count.",
    "- For fixed-count summaries, prefer verbatim or near-verbatim clauses from the Prior Grounded Answer. Do not add generic advice, caveats, recommendations, or meta statements as extra points.",
  ];
}

function requestsCurrentCustomerRequirementsSummary(latest: string): boolean {
  return CURRENT_REQUIREMENTS_SUMMARY_SCOPE.test(clean(latest, 1600));
}

function requestsNewFactualFacet(latest: string, priorAnswer: string): boolean {
  const facets: Array<[RegExp, RegExp]> = [
    [/(價錢|价格|price|月費|月费|年費|年费|monthly|yearly|年繳|年缴|月繳|月缴)/i, /(HKD|價錢|价格|price|月費|月费|年費|年费|monthly|yearly|年繳|年缴|月繳|月缴)/i],
    [/(staff|員工|员工|管理人手|管理人员)/i, /(staff|員工|员工|管理人手|管理人员)/i],
    [/(sku|商品數量|商品数量|product count)/i, /(sku|商品數量|商品数量|product count)/i],
    [/(保養|保修|warranty)/i, /(保養|保修|warranty)/i],
    [/(送貨|送货|delivery|九龍|九龙|kowloon|澳門|澳门|macau|macao)/i, /(送貨|送货|delivery|九龍|九龙|kowloon|澳門|澳门|macau|macao)/i],
    [/(退款|refund|百分比|比例)/i, /(退款|refund|百分比|比例)/i],
    [/(app|push|推播|推送|crm|會員等級|会员等级|membership)/i, /(app|push|推播|推送|crm|會員等級|会员等级|membership)/i],
  ];
  return facets.some(([request, evidence]) => request.test(latest) && !evidence.test(priorAnswer));
}

function requestsConversationSecuritySummary(latest: string, priorAnswer: string): boolean {
  const asksSecuritySummary = /(拒絕|拒绝|敏感要求|sensitive requests?|system prompt|hidden context|secret key|bypass auth|其他客戶|其他客户)/i.test(latest) && /(總結|总结|summari)/i.test(latest);
  if (!asksSecuritySummary) return false;
  return !/(拒絕|拒绝|system prompt|hidden|secret|存取|访问|客戶|客户|credential|auth)/i.test(priorAnswer);
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

  // Latest/current customer-requirements summaries are conversation-memory/state
  // operations, not formatting transforms of the immediately prior KB answer.
  // Never let a grounded answer hijack customer-authored state just because the
  // request contains words such as "summarize" or "list".
  if (requestsCurrentCustomerRequirementsSummary(latest)) return null;

  const operation = semantic.operation as TransformOperation;
  if (requestsNewFactualFacet(latest, semantic.prior_grounded_answer.content)) return null;
  if (requestsConversationSecuritySummary(latest, semantic.prior_grounded_answer.content)) return null;
  const operations = detectRequestedTransformOperations(latest, operation);
  const requestedSummaryCount = operations.includes("SUMMARIZE")
    ? detectRequestedSummaryCount(latest)
    : null;
  const anchor = operations.includes("SUMMARIZE")
    ? selectBroadSummaryAnchor(latest, newestFirst, semantic.prior_grounded_answer, requestedSummaryCount)
    : semantic.prior_grounded_answer;
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
    const lineageIds = normalizedChunkIds(lineage?.evidence_chunk_ids);
    const sourceMessageId = clean(meta?.source_message_id, 200);
    const groundingTarget = readGroundingTarget(lineage?.current_target);
    if (
      selected !== anchor.document_id ||
      sourceMessageId !== anchor.source_message_id ||
      lineageIds.length !== sourceChunks.length ||
      lineageIds.some((id) => !sourceChunks.includes(id))
    ) return null;
    if (!transformTargetCompatible(latest, groundingTarget)) return null;

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
        target_entity_model: groundingTarget?.entity_ids ?? [],
        target_topics: groundingTarget?.topic_ids ?? [],
        authority_decision: typeof lineage?.authority_decision === "string"
          ? lineage.authority_decision
          : "PRIOR_GROUNDED_ANSWER",
        evidence_state: typeof lineage?.evidence_state === "string"
          ? lineage.evidence_state
          : "current",
      });
    }
    if (citations.length === 0) return null;

    return {
      operation,
      operations,
      prior_answer: anchor.content,
      selected_document_id: selected,
      evidence_chunk_ids: lineageIds,
      prior_source_message_id: sourceMessageId,
      ...(groundingTarget ? { grounding_target: groundingTarget } : {}),
      ...(typeof lineage?.authority_decision === "string"
        ? { authority_decision: lineage.authority_decision }
        : {}),
      ...(typeof lineage?.evidence_state === "string"
        ? { evidence_state: lineage.evidence_state }
        : {}),
      ...(requestedSummaryCount ? { requested_summary_count: requestedSummaryCount } : {}),
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
    "Transform that answer exactly as requested by the latest customer instruction, except that factual grounding always overrides formatting/count requests.",
    "Do not use facts from conversation history, CRM/customer context, general knowledge, policies, titles, or any other prompt section.",
    "Do not add examples, explanations, caveats, eligibility conditions, jurisdictions, procedures, prices, dates, durations, quantities, model details, or recommendations unless they already appear in the prior grounded answer.",
    "Do not say that you checked, searched, know, recommend, infer, or verified anything beyond that prior answer.",
    "Return only the transformed customer-facing answer. No preface, no meta-commentary, no source discussion.",
    ...fixedCountContract(context),
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
    "Perform every transformation explicitly requested in this instruction, using only the prior grounded answer as factual authority. Do not answer any other question or add any new factual content. If a requested summary count exceeds the number of distinct supported points, return fewer points rather than inventing filler.",
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
    "For a composite transformation, preserve every requested operation while reducing wording; do not drop the requested target language or summary operation.",
    "A fixed summary count is a soft formatting target only. If satisfying it would require splitting, repeating, padding, or adding a claim, return fewer supported points.",
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
    ...fixedCountContract(context),
    "- If the requested transformation cannot be completed without adding facts, preserve the grounded facts and relax only the formatting/count requirement; never invent information.",
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
  const inheritedTarget = context.grounding_target ?? deriveCurrentGroundingTarget(context.prior_answer);
  return {
    citations: context.citations.map((citation) => ({
      ...citation,
      target_entity_model: citation.target_entity_model ?? inheritedTarget.entity_ids,
      target_topics: citation.target_topics ?? inheritedTarget.topic_ids,
      authority_decision: citation.authority_decision ?? "PRIOR_GROUNDED_ANSWER",
      evidence_state: citation.evidence_state ?? "current",
    })),
    citation_lineage: {
      selected_document_id: context.selected_document_id,
      evidence_chunk_ids: [...context.evidence_chunk_ids],
      evidence_count: context.evidence_chunk_ids.length,
      current_target: inheritedTarget,
      authority_decision: context.authority_decision ?? "PRIOR_GROUNDED_ANSWER",
      evidence_state: context.evidence_state ?? "current",
    },
    transform_lineage: {
      operation: context.operation,
      operations,
      composite: operations.length > 1,
      authority: "PRIOR_GROUNDED_ANSWER",
      prior_source_message_id: context.prior_source_message_id,
      ...(context.requested_summary_count ? { requested_summary_count: context.requested_summary_count } : {}),
    },
    response_route: "prior_grounded_transform",
  };
}
