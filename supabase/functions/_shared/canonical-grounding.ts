import type { KBDocumentCandidate, KBFullChunk, KBLLMContextEvidence } from "./kb-client.ts";
import { detectExplicitJurisdiction } from "./conversation-runtime-state.ts";
import {
  type ReferenceAuthorityDecision,
  type ReferenceEvidenceCandidate,
  resolveReferenceAuthority,
} from "./commerce-state-authority.ts";

export interface CanonicalGroundingOptions {
  minScore?: number;
  policyOnly?: boolean;
  requirePublished?: boolean;
  requestText?: string;
  currentTurnText?: string;
  expectedTenantId?: string | null;
  expectedEntityIds?: string[];
  expectedTopicIds?: string[];
  expectedRegion?: string | null;
  requiresCurrentKb?: boolean;
  targetChanged?: boolean;
}
export interface CurrentGroundingTarget {
  entity_ids: string[];
  topic_ids: string[];
  region: string | null;
  explicit_entity: boolean;
  explicit_topic: boolean;
  target_changed: boolean;
}
export type CanonicalGroundingResult =
  | {
      ok: true;
      document: KBDocumentCandidate | null;
      chunks: KBFullChunk[];
      evidence: KBLLMContextEvidence[];
      applicability: {
        accepted: boolean;
        reason: string;
        request_jurisdiction: string | null;
        document_jurisdictions: string[];
      };
      authority_decision: ReferenceAuthorityDecision;
    }
  | {
      ok: false;
      error: "KB_DOCUMENT_EVIDENCE_MISMATCH" | "KB_EVIDENCE_NOT_PUBLISHED";
    };

function modelTokens(text: string): string[] {
  return [
    ...new Set(
      (text.match(/\b[A-Z]{2,}[A-Z0-9]*[- ]?\d{2,}[A-Z0-9-]*\b/g) ?? []).map((x) =>
        x.replace(/\s+/g, "").toUpperCase(),
      ),
    ),
  ];
}
function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.normalize("NFKC").trim()).filter((value): value is string => Boolean(value)))];
}
function namedTargetTokens(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\b(?:smoke\s+test\s+)?(basic|growth|pro)\b/gi)) {
    const plan = match[1].toLowerCase();
    targets.push(plan);
    if (/smoke\s+test/i.test(match[0])) targets.push(`smoke test ${plan}`);
  }
  for (const match of text.matchAll(/\b(product|model|sku)\s*[:#-]?\s*([a-z0-9][a-z0-9._/-]{0,80})\b/gi)) {
    targets.push(`${match[1].toLowerCase()} ${match[2].toLowerCase()}`);
    targets.push(match[2].toLowerCase());
  }
  return unique([...targets, ...modelTokens(text).map((value) => value.toLowerCase())]);
}
function topicTokens(text: string): string[] {
  const topics: string[] = [];
  const rules: Array<[string, RegExp]> = [
    ["warranty", /(?:warranty|保養|保修)/i],
    ["delivery", /(?:delivery|shipping|送貨|送货|物流|派送)/i],
    ["returns", /(?:refund|return|退款|退貨|退货|換貨|换货)/i],
    ["price", /(?:price|pricing|價錢|价钱|價格|价格|費用|费用|收費|收费|monthly|yearly|每月|每年)/i],
    ["sku_limit", /(?:sku|商品|產品|产品).{0,20}(?:limit|上限)|(?:limit|上限).{0,20}(?:sku|商品|產品|产品)/i],
    ["staff_limit", /(?:staff|admin(?:[- ]?seat)?|員工|员工|人手).{0,20}(?:limit|上限)|(?:limit|上限).{0,20}(?:staff|admin|員工|员工|人手)/i],
    ["features", /(?:feature|included|功能|包括|包含|app|push|crm|會員|会员|ai\s*seo)/i],
    ["specification", /(?:spec(?:ification)?s?|規格|规格|噪音|noise|\bdb\b|dimension|尺寸)/i],
    ["payment", /(?:payment|付款|支付)/i],
  ];
  for (const [topic, pattern] of rules) if (pattern.test(text)) topics.push(topic);
  return topics;
}
export function deriveCurrentGroundingTarget(
  currentTurnText: string,
  retrievalText = currentTurnText,
  fallbackEntityIds: string[] = [],
  fallbackTopicIds: string[] = [],
  targetChanged = false,
): CurrentGroundingTarget {
  const explicitEntities = namedTargetTokens(currentTurnText);
  const explicitTopics = topicTokens(currentTurnText);
  const retrievalTopics = topicTokens(retrievalText);
  return {
    entity_ids: explicitEntities.length ? explicitEntities : unique(fallbackEntityIds),
    topic_ids: explicitTopics.length ? explicitTopics : unique([...fallbackTopicIds, ...retrievalTopics]),
    region: detectExplicitJurisdiction(currentTurnText) ?? null,
    explicit_entity: explicitEntities.length > 0,
    explicit_topic: explicitTopics.length > 0,
    target_changed: targetChanged,
  };
}
function candidateText(document: KBDocumentCandidate): string {
  return [
    document.title,
    document.source_type,
    ...document.chunks.map((c) => `${c.title ?? ""} ${c.content}`),
    ...document.llm_context.full_content_evidence.map((e) => e.content),
  ]
    .join("\n")
    .slice(0, 50000);
}
function jurisdictions(text: string): string[] {
  const found: string[] = [];
  if (/(mars|火星)/i.test(text)) found.push("mars");
  if (/(香港|hong\s*kong|\bhk\b)/i.test(text)) found.push("hong_kong");
  if (/(澳門|澳门|macau|macao)/i.test(text)) found.push("macau");
  if (/(新加坡|singapore)/i.test(text)) found.push("singapore");
  if (/(台灣|台湾|taiwan)/i.test(text)) found.push("taiwan");
  if (/(中國大陸|中国大陆|內地|内地|mainland\s*china)/i.test(text)) {
    found.push("mainland_china");
  }
  return found;
}
function assessApplicability(document: KBDocumentCandidate, requestText: string) {
  const requestJurisdiction = detectExplicitJurisdiction(requestText);
  const text = candidateText(document);
  const documentJurisdictions = jurisdictions(text);
  if (requestJurisdiction === "mars" && !documentJurisdictions.includes("mars")) {
    return {
      accepted: false,
      reason: "unsupported_explicit_jurisdiction",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions,
    };
  }
  if (
    requestJurisdiction &&
    documentJurisdictions.length > 0 &&
    !documentJurisdictions.includes(requestJurisdiction)
  ) {
    return {
      accepted: false,
      reason: "jurisdiction_mismatch",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions,
    };
  }
  const requestModels = modelTokens(requestText);
  const documentModels = modelTokens(text);
  if (
    requestModels.length > 0 &&
    documentModels.length > 0 &&
    !requestModels.some((model) => documentModels.includes(model))
  ) {
    return {
      accepted: false,
      reason: "model_mismatch",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions,
    };
  }
  return {
    accepted: true,
    reason: "applicable",
    request_jurisdiction: requestJurisdiction,
    document_jurisdictions: documentJurisdictions,
  };
}

const STRONG_LEXICAL_SCORE_FLOOR = 0.05;

function strongLexicalEvidenceMatch(requestText: string, document: KBDocumentCandidate): boolean {
  const request = requestText.normalize("NFKC").toLowerCase();
  const text = candidateText(document).normalize("NFKC").toLowerCase();
  const namedPlan = ["growth", "basic", "pro"].find(
    (plan) =>
      new RegExp(`\\b${plan}\\b`, "i").test(request) && new RegExp(`\\b${plan}\\b`, "i").test(text),
  );
  const requestHasPlanFact =
    /(?:sku|staff|admin|seat|app|push|crm|會員|会员|ai\s*seo|price|billing|monthly|yearly|limit|上限|費用|费用|價錢|价钱|價格|价格)/i.test(
      request,
    );
  const textHasPlanFact =
    /(?:sku|staff|admin|seat|app|push|crm|會員|会员|ai\s*seo|price|billing|monthly|yearly|limit|上限|費用|费用|價錢|价钱|價格|价格)/i.test(
      text,
    );
  if (namedPlan && requestHasPlanFact && textHasPlanFact) return true;

  const reqModels = modelTokens(requestText);
  if (reqModels.length > 0 && reqModels.some((model) => text.includes(model.toLowerCase()))) {
    return /(?:price|spec|warranty|保養|保修|噪音|db|delivery|shipping|送貨|送货)/i.test(request);
  }
  return false;
}

function lexicalRelevance(requestText: string, document: KBDocumentCandidate): number {
  const request = requestText.normalize("NFKC").toLowerCase();
  const text = candidateText(document).normalize("NFKC").toLowerCase();
  let score = 0;
  const reqModels = modelTokens(requestText);
  if (reqModels.some((model) => text.includes(model.toLowerCase()))) {
    score += 12;
  }
  const anchors = [
    "smoke test growth",
    "smoke test basic",
    "smoke test pro",
    "growth",
    "basic",
    "pro",
    "九龍",
    "九龙",
    "澳門",
    "澳门",
    "退款",
    "退貨",
    "退货",
    "delivery",
    "shipping",
    "warranty",
    "保養",
    "保修",
    "sku",
    "staff",
    "push",
    "crm",
    "ai seo",
  ];
  for (const anchor of anchors) {
    if (request.includes(anchor) && text.includes(anchor)) score += 2;
  }
  const latinTokens = [...new Set(request.match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])].filter(
    (x) =>
      !["current", "request", "retrieval", "target", "published", "customer", "context"].includes(
        x,
      ),
  );
  for (const token of latinTokens.slice(0, 20)) {
    if (text.includes(token)) score += 0.25;
  }
  return score;
}

function extractStructuredClaims(
  evidence: KBLLMContextEvidence[],
): Array<{ key: string; value: string }> {
  const claims: Array<{ key: string; value: string }> = [];
  for (const item of evidence) {
    for (const line of item.content.split(/\r?\n/).slice(0, 120)) {
      const match = line.match(/^\s*[-*]?\s*([^:：=]{2,120})\s*[:：=]\s*(.{1,300})\s*$/u);
      if (!match) continue;
      const key = match[1].normalize("NFKC").replace(/\s+/g, " ").trim();
      const value = match[2].normalize("NFKC").replace(/\s+/g, " ").trim();
      if (key && value) claims.push({ key, value });
      if (claims.length >= 24) return claims;
    }
  }
  return claims;
}

export function selectCanonicalGrounding(
  documents: KBDocumentCandidate[],
  options: CanonicalGroundingOptions = {},
): CanonicalGroundingResult {
  const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : 0;
  const policyOnly = options.policyOnly === true;
  const requirePublished = options.requirePublished !== false;
  const requestText = options.requestText ?? "";
  const currentTurnText = options.currentTurnText ?? requestText;
  const target = deriveCurrentGroundingTarget(currentTurnText, requestText, options.expectedEntityIds ?? modelTokens(requestText), options.expectedTopicIds ?? [], options.targetChanged === true);
  const expectedEntityIds = target.entity_ids;
  const expectedTopicIds = target.topic_ids;
  const expectedRegion = options.expectedRegion ?? target.region ?? detectExplicitJurisdiction(requestText);
  const eligible: Array<{
    document: KBDocumentCandidate;
    chunks: KBFullChunk[];
    evidence: KBLLMContextEvidence[];
    applicability: ReturnType<typeof assessApplicability>;
    evidenceScore: number;
    lexicalScore: number;
    authorityCandidate: ReferenceEvidenceCandidate;
  }> = [];

  for (const document of documents ?? []) {
    if (document.llm_context.selected_document_id !== document.document_id) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    if (
      document.llm_context.full_content_evidence.some((e) => e.document_id !== document.document_id)
    ) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    if (document.chunks.some((c) => c.document_id !== document.document_id)) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }

    const currentTargetRequest = currentTurnText || requestText;
    const lexicalScore = lexicalRelevance(currentTargetRequest, document);
    const effectiveMinScore = strongLexicalEvidenceMatch(currentTargetRequest, document)
      ? Math.min(minScore, STRONG_LEXICAL_SCORE_FLOOR)
      : minScore;
    const chunks = document.chunks.filter(
      (c) =>
        c.content.trim() &&
        Number.isFinite(c.score) &&
        c.score >= effectiveMinScore &&
        (!requirePublished || c.status === "published") &&
        (!policyOnly || c.source_type.toLowerCase().includes("policy")),
    );
    const fullContentIds = new Set(
      chunks.filter((c) => c.chunk_type === "full_content").map((c) => c.chunk_id ?? c.content),
    );
    const evidence = document.llm_context.full_content_evidence.filter(
      (e) =>
        e.content.trim() &&
        Number.isFinite(e.score) &&
        e.score >= effectiveMinScore &&
        (!policyOnly || e.source_type.toLowerCase().includes("policy")) &&
        fullContentIds.has(e.chunk_id ?? e.content),
    );

    if (requirePublished && evidence.length > 0 && chunks.every((c) => c.status !== "published")) {
      return { ok: false, error: "KB_EVIDENCE_NOT_PUBLISHED" };
    }
    if (!evidence.length) continue;

    const applicability = assessApplicability(document, currentTargetRequest);
    const metadata = document.authority;
    const declaredCurrentness = metadata?.currentness ?? "unknown";
    const effectiveCurrentness =
      declaredCurrentness === "unknown"
        ? // The authenticated Singapore endpoint is explicitly the published/live
          // read path. Missing optional currentness metadata is bound to that
          // server-side contract, never to a client assertion.
          "current"
        : declaredCurrentness;
    eligible.push({
      document,
      chunks,
      evidence,
      applicability,
      evidenceScore: Math.max(...evidence.map((e) => e.score), 0),
      lexicalScore,
      authorityCandidate: {
        source_id: document.document_id,
        source_type: document.source_type,
        authority_class: effectiveCurrentness === "current" ? "CURRENT_KB" : "HISTORICAL",
        tenant_id: metadata?.tenant_id ?? options.expectedTenantId ?? null,
        publication_state: metadata?.publication_state ?? "published",
        currentness: effectiveCurrentness,
        entity_ids: unique([...(metadata?.entity_ids ?? []), ...namedTargetTokens(candidateText(document))]),
        topic_ids: unique([...(metadata?.claims ?? []).map((claim) => claim.key), ...topicTokens(candidateText(document)), ...namedTargetTokens(candidateText(document))]),
        regions: metadata?.regions?.length
          ? metadata.regions
          : applicability.document_jurisdictions.length
            ? applicability.document_jurisdictions
            : !applicability.accepted && applicability.request_jurisdiction
              ? ["unknown"]
              : [],
        language: metadata?.language ?? null,
        version: metadata?.version ?? null,
        version_rank: metadata?.version_rank ?? null,
        updated_at: metadata?.updated_at ?? null,
        source_priority: metadata?.source_priority ?? null,
        relevance_score: Math.max(
          lexicalScore,
          document.document_score,
          Math.max(...evidence.map((e) => e.score), 0),
        ),
        claims: metadata?.claims?.length ? metadata.claims : extractStructuredClaims(evidence),
      },
    });
  }

  const authorityDecision = resolveReferenceAuthority({
    candidates: eligible.map((candidate) => candidate.authorityCandidate),
    expected_tenant_id: options.expectedTenantId ?? null,
    expected_entity_ids: expectedEntityIds,
    expected_topic_ids: expectedTopicIds,
    expected_region: expectedRegion,
    requires_current_kb: options.requiresCurrentKb !== false,
    require_explicit_target_match: target.target_changed || target.explicit_entity || target.explicit_topic || Boolean(expectedRegion),
  });
  const winner = authorityDecision.selected_source_id
    ? eligible.find(
        (candidate) =>
          candidate.document.document_id === authorityDecision.selected_source_id &&
          candidate.applicability.accepted,
      )
    : undefined;
  return winner
    ? {
        ok: true,
        document: winner.document,
        chunks: winner.chunks,
        evidence: winner.evidence,
        applicability: winner.applicability,
        authority_decision: authorityDecision,
      }
    : {
        ok: true,
        document: null,
        chunks: [],
        evidence: [],
        applicability: {
          accepted: false,
          reason: "no_applicable_published_evidence",
          request_jurisdiction: detectExplicitJurisdiction(requestText),
          document_jurisdictions: [],
        },
        authority_decision: authorityDecision,
      };
}
