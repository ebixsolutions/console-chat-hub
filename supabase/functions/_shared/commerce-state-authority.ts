import type { ConversationCommerceState } from "./commerce-state-contract.ts";

export type CommerceAnswerAuthority =
  | "CONVERSATION_STATE"
  | "DETERMINISTIC_CALCULATION"
  | "CURRENT_KB_REQUIRED"
  | "SAFE_PROFESSIONAL_CONFIRMATION"
  | "INSUFFICIENT_INFORMATION";

export interface CommerceAuthorityDecision {
  authority: CommerceAnswerAuthority;
  reason: string;
  known_value?: unknown;
  state_path?: string | null;
  calculation?: { expression: string; result: number; currency?: string | null } | null;
}

export interface CommerceCalculationTerm {
  label: string;
  value: number;
  multiplier?: number;
}

export interface ResolveCommerceAuthorityInput {
  question: string;
  state: ConversationCommerceState;
  requested_state_path?: string | null;
  calculation_terms?: CommerceCalculationTerm[];
  calculation_currency?: string | null;
  requires_current_business_fact?: boolean;
  requires_current_price_or_stock?: boolean;
  requires_policy_or_terms?: boolean;
  requires_professional_site_check?: boolean;
  unsafe_to_remote_confirm?: boolean;
}

/**
 * C1 extends the existing A2 authority contract to cover read-only reference
 * evidence.  It deliberately contains no KB transport or persistence logic:
 * callers provide bounded provenance and receive a deterministic decision.
 */
export type ReferenceAuthorityClass =
  | "CANONICAL_TRANSACTION"
  | "DETERMINISTIC_CALCULATION"
  | "CURRENT_KB"
  | "CUSTOMER_CONTEXT"
  | "HISTORICAL"
  | "MODEL_INFERENCE";

export type ReferenceEvidenceCurrentness =
  "current" | "historical" | "superseded" | "cancelled" | "unknown";

export type ReferenceAuthorityDecisionKind =
  | "USE_CANONICAL_STATE"
  | "USE_DETERMINISTIC_CALCULATION"
  | "USE_CURRENT_KB"
  | "USE_CUSTOMER_CONTEXT"
  | "HISTORICAL_ONLY"
  | "CURRENT_KB_REQUIRED"
  | "CONFLICT_UNRESOLVED"
  | "INSUFFICIENT_EVIDENCE";

export interface ReferenceFactClaim {
  key: string;
  value: string;
}

export interface ReferenceEvidenceCandidate {
  source_id: string;
  source_type: string;
  authority_class: ReferenceAuthorityClass;
  tenant_id?: string | null;
  publication_state?: string | null;
  currentness?: ReferenceEvidenceCurrentness;
  entity_ids?: string[];
  topic_ids?: string[];
  regions?: string[];
  language?: string | null;
  version?: string | null;
  version_rank?: number | null;
  updated_at?: string | null;
  source_priority?: number | null;
  relevance_score?: number | null;
  claims?: ReferenceFactClaim[];
}

export interface ResolveReferenceAuthorityInput {
  candidates: ReferenceEvidenceCandidate[];
  expected_tenant_id?: string | null;
  expected_entity_ids?: string[];
  expected_topic_ids?: string[];
  expected_region?: string | null;
  requires_current_kb?: boolean;
  require_explicit_target_match?: boolean;
}

export interface ReferenceAuthorityRejection {
  source_id: string;
  reason: string;
}

export interface ReferenceAuthorityDecision {
  decision: ReferenceAuthorityDecisionKind;
  reason: string;
  selected_source_id: string | null;
  selected_authority_class: ReferenceAuthorityClass | null;
  conflict_source_ids: string[];
  rejected: ReferenceAuthorityRejection[];
  provenance: {
    tenant_id: string | null;
    entity_ids: string[];
    topic_ids: string[];
    region: string | null;
    source_type: string | null;
    version: string | null;
    currentness: ReferenceEvidenceCurrentness | null;
  };
}

function clean(value: unknown, max = 1200): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isKnownValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function getCommerceStatePath(state: ConversationCommerceState, path: string): unknown {
  const parts = clean(path, 300).split(".").filter(Boolean);
  if (!parts.length) return undefined;
  let current: unknown = state;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

export function findCommerceEntity(
  state: ConversationCommerceState,
  key: string,
): ConversationCommerceState["entities"][number] | null {
  const needle = clean(key, 120).toLowerCase();
  if (!needle) return null;
  const matches = state.entities.filter((entity) =>
    [entity.entity_id, entity.category, entity.brand ?? "", entity.model ?? ""]
      .map((x) => clean(x, 120).toLowerCase())
      .some(
        (x) =>
          x === needle ||
          (x.length >= 2 && x.includes(needle)) ||
          (needle.length >= 2 && needle.includes(x)),
      ),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function calculateCommerceTerms(
  terms: CommerceCalculationTerm[],
  currency?: string | null,
): CommerceAuthorityDecision["calculation"] {
  if (!terms.length) return null;
  let total = 0;
  const expressionParts: string[] = [];
  for (const term of terms) {
    if (!Number.isFinite(term.value)) return null;
    const multiplier = term.multiplier ?? 1;
    if (!Number.isFinite(multiplier)) return null;
    total += term.value * multiplier;
    expressionParts.push(`${term.label}:${term.value}×${multiplier}`);
  }
  return {
    expression: expressionParts.join(" + "),
    result: Math.round((total + Number.EPSILON) * 100) / 100,
    currency: currency ?? null,
  };
}

function questionLooksLikeCurrentBusinessFact(question: string): boolean {
  return /(?:而家|現在|现在|目前|最新|current|latest|今日|today).{0,30}(?:價|价|price|stock|庫存|库存|有貨|有货|available|政策|policy|收費|收费|fee|delivery|送貨|送货|保養|保修|warranty)/i.test(
    question,
  );
}

function questionLooksLikeCustomerState(question: string): boolean {
  return /(?:我(?:而家|現在|现在|目前|最後|最后)?|my\s+(?:current|latest|final)?).{0,45}(?:幾多|多少|數量|数量|要咩|要什麼|要什么|地址|電話|电话|收貨人|收货人|日期|時間|时间|要求|需求|限制|狀態|状态|order|quote|quotation|quantity|address|phone|recipient|date|requirements?|constraints?|status)|(?:幫我|帮我|please).{0,30}(?:總結|总结|summari[sz]e).{0,30}(?:我|my)/i.test(
    question,
  );
}

function explicitCustomerMutation(question: string): boolean {
  const text = clean(question);
  return /(?:更正|改(?:做|成|為|为|返)|變成|变成|加多|再加|新增|另外加|唔係.+?(?:改|而係|而系)|不是.+?(?:改|而是)|而家要|現在要|现在要|目前要)\s*(?:[一二兩两三四五六七八九十]|\d{1,4})?\s*(?:部|台|件|個|个|套)?/i.test(text) ||
    /(?:取消|移除|刪除|删除)\s*(?:其中|呢|這|这|嗰|那|一|[一二兩两三四五六七八九十]|\d)/i.test(text) ||
    /\b(?:change|set|make)\b.{0,24}\bto\b|\badd\b(?:\s+(?:another|one|two|three|\d+))?|\b(?:please\s+)?(?:cancel|remove)\b/i.test(text);
}

function quantityRecallTarget(question: string): boolean {
  return /(?:數量|数量|quantity|how many|幾多\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚)|多少\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚)|(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚))/i.test(
    question,
  );
}

export type CommerceDimensionAttribute = "width" | "height" | "depth";

export interface CommerceDimensionMeasurement {
  attribute: CommerceDimensionAttribute | null;
  value: number;
  unit: "mm" | "cm" | "in";
  value_mm: number;
}

function dimensionAttributeFromText(text: string): CommerceDimensionAttribute | null {
  if (/(?:闊|寬|宽|width)/i.test(text)) return "width";
  if (/(?:高|高度|height)/i.test(text)) return "height";
  if (/(?:深|深度|depth)/i.test(text)) return "depth";
  return null;
}

export function parseCommerceDimensionMeasurement(
  question: string,
): CommerceDimensionMeasurement | null {
  const text = clean(question);
  const match = text.match(
    /(\d{1,5}(?:\.\d+)?)\s*(mm|毫米|cm|厘米|公分|inches?|inch|吋)/i,
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const rawUnit = match[2].toLowerCase();
  const unit: CommerceDimensionMeasurement["unit"] =
    rawUnit === "mm" || rawUnit === "毫米"
      ? "mm"
      : rawUnit === "cm" || rawUnit === "厘米" || rawUnit === "公分"
      ? "cm"
      : "in";
  const multiplier = unit === "mm" ? 1 : unit === "cm" ? 10 : 25.4;
  return {
    attribute: dimensionAttributeFromText(text),
    value,
    unit,
    value_mm: Math.round(value * multiplier * 1000) / 1000,
  };
}

export function inferCommerceDimensionAttribute(
  question: string,
  semantic?: { requested_facts?: string[] | null } | null,
): CommerceDimensionAttribute | null {
  const direct = dimensionAttributeFromText(clean(question));
  if (direct) return direct;
  const requested = (semantic?.requested_facts ?? []).join(" ");
  return dimensionAttributeFromText(requested);
}

/**
 * Shared delivery/schedule current-fact target.  This recognises bounded
 * read-only questions about the already-authoritative delivery preference;
 * policy, reschedule and mutation requests stay outside this contract.
 */
export function isDeliveryScheduleCurrentFactQuery(question: string): boolean {
  const text = clean(question);
  if (!text || explicitCustomerMutation(text)) return false;
  if (/(?:改期|更改|改做|取消|政策|可唔可以改|能不能改|reschedul|change|cancel|policy)/i.test(text)) {
    return false;
  }
  const interrogative = /[?？]|(?:幾時|几时|何時|何时|邊日|边日|星期幾|星期几|哪天|what|which|when)/i.test(text);
  const deliveryAndSchedule =
    /(?:送(?:貨|货)?|配送|派送).{0,12}(?:星期幾|星期几|邊日|边日|哪天|日期|時間|时间|幾時|几时)/i.test(text) ||
    /(?:星期幾|星期几|邊日|边日|哪天|日期|幾時|几时).{0,12}(?:送(?:貨|货)?|配送|派送)/i.test(text) ||
    /(?:current\s+)?delivery\s+(?:day|date|time|schedule)|when\s+(?:is|will).{0,12}(?:delivery|deliver)/i.test(text) ||
    /(?:preferred_date|delivery_preference)/i.test(text);
  return interrogative && deliveryAndSchedule;
}

/**
 * Shared READ_ONLY_MEMORY_OR_CURRENT_STATE_RECALL contract. A counted noun in
 * an interrogative/recall utterance is a fact target, never mutation authority.
 * Explicit SET/ADD/CANCEL language remains outside this class.
 */
export function isReadOnlyMemoryOrCurrentStateRecall(
  question: string,
  semantic?: { operation?: string | null; requested_facts?: string[] | null } | null,
): boolean {
  const text = clean(question);
  if (!text || explicitCustomerMutation(text)) return false;
  const requested = (semantic?.requested_facts ?? []).join(" ");
  const semanticRead = ["ASK_FACT", "NO_STATE_CHANGE"].includes(String(semantic?.operation ?? ""));
  const recallLanguage = /(?:記唔記得|记不记得|記得嗎|记得吗|仲記得|还记得|還記得|頭先|头先|之前最後|之前最后|最後話|最后说|提我|提醒我|do you remember|remind me|settled on|have now)/i.test(text);
  const interrogative = /[?？]|呢\s*$|嗎\s*$|吗\s*$|(?:幾多|几多|多少|how many|what quantity|what.*(?:have|settled))/i.test(text);
  const deicticQuantity = recallLanguage &&
    /(?:嗰|那|這|这|呢)\s*(?:件|個|个|部|台|套)/i.test(text);
  const dimensionMeasurement = parseCommerceDimensionMeasurement(text);
  const explicitQuantityFact = /(?:quantity|current_quantity)/i.test(requested) ||
    /(?:數量|数量|quantity|how many|幾多|几多|多少)/i.test(text) ||
    /(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚).{0,20}?(?:定|還是|还是|or)\s*(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚)/i.test(text);
  // A product article followed by a dimension (for example, "一部598mm")
  // is not a quantity fact. It remains available to attribute-compatible
  // entity/constraint routing instead of inheriting a known quantity.
  const quantity = (!dimensionMeasurement || explicitQuantityFact) &&
    (quantityRecallTarget(text) || deicticQuantity ||
      /(?:quantity|current_quantity)/i.test(requested));
  const status = /(?:狀態|状态|status|係咪取消|是否取消|仲要|仍然要|still active|cancelled|canceled)/i.test(text) ||
    /(?:status|current_state)/i.test(requested);
  const currentAttribute = isDeliveryScheduleCurrentFactQuery(text) ||
    /(?:地址|address|收貨人|收货人|recipient|電話|电话|phone|contact|匹數|匹数|幾匹|几匹|horsepower|\bhp\b|舊機|旧机|舊冷氣|旧空调).*(?:[?？]|呢\s*$)|(?:address|recipient|recipient_phone|preferred_date|horsepower|old_machine_removal_count)/i.test(`${text} ${requested}`);
  return (semanticRead || recallLanguage || interrogative) &&
    (quantity || status || currentAttribute) &&
    (recallLanguage || interrogative);
}

/**
 * READ_ONLY_CURRENT_STATE_AGGREGATE_QUERY covers questions about the already
 * recorded set of technician/professional checks. A count/list mention is a
 * fact target, not authority to add, cancel, or otherwise rewrite a check.
 */
export function isReadOnlyCurrentStateAggregateQuery(
  question: string,
  semantic?: { operation?: string | null; requested_facts?: string[] | null } | null,
): boolean {
  const text = clean(question);
  if (!text || explicitCustomerMutation(text)) return false;
  const requested = (semantic?.requested_facts ?? []).join(" ");
  const semanticRead = ["ASK_FACT", "NO_STATE_CHANGE"].includes(String(semantic?.operation ?? ""));
  const technicianDomain = /(?:師傅|师傅|技師|技师|專業人員|专业人员|technician|professional|site\s*(?:check|survey)|onsite\s*(?:check|survey)|上門(?:確認|检查|檢查)|上门(?:确认|检查))/i.test(text) ||
    /(?:pending\s+(?:checks?|items?)|(?:checks?|items?)\s+(?:are\s+)?still\s+pending)/i.test(text) ||
    /(?:幾多|几多|多少|邊啲|边啲|哪些).{0,20}(?:未確認|未确认|待確認|待确认)/i.test(text) ||
    /(?:pending_(?:technician_)?checks?|professional_confirmation|installation\.pending_checks)/i.test(requested);
  const aggregateOrList = /(?:幾多\s*(?:項|個位|個|个)|几多\s*(?:项|个位|个)|多少\s*(?:項|项|個|个)|仲有\s*(?:幾多|几多|邊啲|边啲)|還有\s*(?:多少|哪些)|还有\s*(?:多少|哪些)|邊啲|边啲|哪些|how many\s+(?:checks?|items?)|which\s+(?:checks?|items?)|what\s+(?:still\s+)?(?:needs?|requires?).{0,24}(?:confirmation|checking)|what\s+is\s+still\s+pending)/i.test(text) ||
    /(?:pending_(?:technician_)?checks?|professional_confirmation)/i.test(requested);
  const interrogative = /[?？]/.test(text) || aggregateOrList;
  return technicianDomain && aggregateOrList && (semanticRead || interrogative);
}

function questionLooksLikeCalculation(question: string): boolean {
  return /(?:加埋|合共|總共幾錢|总共多少钱|一共多少|total|how much.*(?:total|altogether)|calculate|計下|算下|計算|计算)/i.test(
    question,
  );
}

function questionExplicitlyAsksQuantity(question: string): boolean {
  if (/(?:價|价|price|amount|金額|金额|幾錢|几钱|多少錢|多少钱|fee|收費|收费)/i.test(question))
    return false;
  return /(?:數量|数量|quantity|how many|幾多\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚)|多少\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚)|(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚).{0,20}?(?:定|還是|还是|or)\s*(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚))/i.test(question) ||
    (isReadOnlyMemoryOrCurrentStateRecall(question) && quantityRecallTarget(question));
}

function inferEntityStatusPath(
  question: string,
  state: ConversationCommerceState,
): { path: string; value: unknown } | null {
  if (!/(?:狀態|状态|status|已取消|取消咗|取消了|仲要|仍然要|still active|cancelled|canceled)/i.test(question)) {
    return null;
  }
  const normalized = clean(question).toLowerCase();
  const roomKeys: Array<[RegExp, string]> = [
    [/(?:客廳|客厅|living\s*room|lounge)/i, "living_room"],
    [/(?:睡房|臥室|卧室|bedroom)/i, "bedroom"],
    [/(?:廚房|厨房|kitchen)/i, "kitchen"],
  ];
  const room = roomKeys.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
  let matches = state.entities.filter((entity) => {
    if (room && entity.entity_id.includes(room)) return true;
    return [entity.entity_id, entity.category, entity.brand ?? "", entity.model ?? ""]
      .map((value) => clean(value).toLowerCase())
      .some((value) => value.length >= 2 && normalized.includes(value));
  });
  if (!matches.length && state.entities.length === 1) matches = [state.entities[0]];
  if (matches.length !== 1) return null;
  const index = state.entities.indexOf(matches[0]);
  return { path: `entities.${index}.status`, value: matches[0].status };
}

function inferKnownCustomerStatePath(
  question: string,
  state: ConversationCommerceState,
): { path: string; value: unknown } | null {
  if (isDeliveryScheduleCurrentFactQuery(question)) {
    const value = getCommerceStatePath(state, "delivery.preferred_date");
    if (isKnownValue(value)) {
      return { path: "delivery.preferred_date", value };
    }
  }
  const candidates: Array<[RegExp, string]> = [
    [/(?:送貨地址|送货地址|地址|delivery address|address)/i, "delivery.address"],
    [/(?:收貨人電話|收货人电话|recipient phone|contact phone)/i, "delivery.recipient_phone"],
    [/(?:收貨人|收货人|recipient)/i, "delivery.recipient_name"],
    [
      /(?:送貨日期|送货日期|送貨時間|送货时间|delivery date|delivery time|preferred date)/i,
      "delivery.preferred_date",
    ],
    [/(?:order status|訂單狀態|订单状态|落單狀態|下单状态)/i, "conversion.order_status"],
    [/(?:quote status|quotation status|報價狀態|报价状态)/i, "conversion.quotation_status"],
    [/(?:payment status|付款狀態|付款状态)/i, "conversion.payment_status"],
  ];

  for (const [pattern, path] of candidates) {
    if (!pattern.test(question)) continue;
    const value = getCommerceStatePath(state, path);
    if (isKnownValue(value)) return { path, value };
  }

  const entityStatus = inferEntityStatusPath(question, state);
  if (entityStatus) return entityStatus;

  if (questionExplicitlyAsksQuantity(question)) {
    const active = state.entities.filter(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (active.length === 1) {
      return {
        path: `entities.${state.entities.indexOf(active[0])}.quantity`,
        value: active[0].quantity,
      };
    }
  }

  return null;
}

/**
 * Universal authority hierarchy for commerce answers.
 * 1. Explicit/inferred customer-owned state wins when already known.
 * 2. Deterministic arithmetic from supplied terms wins over KB retrieval.
 * 3. Safety/site-sensitive questions require professional confirmation.
 * 4. Current business/product/policy facts require current KB/tool evidence.
 * 5. Otherwise fail safely instead of inventing facts.
 */
export function resolveCommerceAnswerAuthority(
  input: ResolveCommerceAuthorityInput,
): CommerceAuthorityDecision {
  const question = clean(input.question);
  const explicitStatePath = clean(input.requested_state_path ?? "", 300);

  if (explicitStatePath) {
    const known = getCommerceStatePath(input.state, explicitStatePath);
    if (isKnownValue(known)) {
      return {
        authority: "CONVERSATION_STATE",
        reason: "requested_customer_state_is_known",
        known_value: known,
        state_path: explicitStatePath,
      };
    }
  }

  const inferred = inferKnownCustomerStatePath(question, input.state);
  if (inferred) {
    return {
      authority: "CONVERSATION_STATE",
      reason: "customer_state_inferred_and_known",
      known_value: inferred.value,
      state_path: inferred.path,
    };
  }

  if (
    (questionLooksLikeCalculation(question) || (input.calculation_terms?.length ?? 0) > 0) &&
    input.calculation_terms?.length
  ) {
    const calculation = calculateCommerceTerms(input.calculation_terms, input.calculation_currency);
    if (calculation) {
      return {
        authority: "DETERMINISTIC_CALCULATION",
        reason: "calculation_fully_supported_by_known_terms",
        calculation,
      };
    }
  }

  if (input.requires_professional_site_check || input.unsafe_to_remote_confirm) {
    return {
      authority: "SAFE_PROFESSIONAL_CONFIRMATION",
      reason: "remote_confirmation_not_safe_or_not_authoritative",
    };
  }

  if (
    input.requires_current_business_fact ||
    input.requires_current_price_or_stock ||
    input.requires_policy_or_terms ||
    questionLooksLikeCurrentBusinessFact(question)
  ) {
    return {
      authority: "CURRENT_KB_REQUIRED",
      reason: "current_business_fact_requires_authoritative_evidence",
    };
  }

  if (questionLooksLikeCustomerState(question)) {
    return {
      authority: "INSUFFICIENT_INFORMATION",
      reason: "customer_state_question_but_requested_fact_not_resolved",
      state_path: explicitStatePath || null,
    };
  }

  return {
    authority: "INSUFFICIENT_INFORMATION",
    reason: "no_authoritative_source_selected",
  };
}

const REFERENCE_AUTHORITY_RANK: Record<ReferenceAuthorityClass, number> = {
  CANONICAL_TRANSACTION: 500,
  DETERMINISTIC_CALCULATION: 500,
  CURRENT_KB: 400,
  CUSTOMER_CONTEXT: 300,
  HISTORICAL: 100,
  MODEL_INFERENCE: 0,
};

function boundedStrings(values: unknown, maxItems = 24, maxLength = 160): string[] {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => clean(value, maxLength).toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

function referenceCurrentness(candidate: ReferenceEvidenceCandidate): ReferenceEvidenceCurrentness {
  if (candidate.currentness) return candidate.currentness;
  if (candidate.authority_class === "HISTORICAL") return "historical";
  if (candidate.authority_class === "CURRENT_KB") return "current";
  return "unknown";
}

function normalizedPublicationState(candidate: ReferenceEvidenceCandidate): string {
  return clean(candidate.publication_state ?? "", 40).toLowerCase();
}

function isCurrentPublishedReference(candidate: ReferenceEvidenceCandidate): boolean {
  if (candidate.authority_class !== "CURRENT_KB") return true;
  const publication = normalizedPublicationState(candidate);
  const currentness = referenceCurrentness(candidate);
  return (
    (publication === "" || publication === "published" || publication === "live") &&
    currentness === "current"
  );
}

function overlaps(expected: string[], actual: string[]): boolean {
  if (!expected.length || !actual.length) return true;
  const key = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const actualKeys = new Set(actual.map(key).filter(Boolean));
  return expected.some((value) => actualKeys.has(key(value)));
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeClaimPart(value: string): string {
  return clean(value, 500).toLowerCase();
}

function normalizedClaims(candidate: ReferenceEvidenceCandidate): Map<string, string> {
  const claims = new Map<string, string>();
  for (const claim of candidate.claims ?? []) {
    const key = normalizeClaimPart(claim?.key ?? "");
    const value = normalizeClaimPart(claim?.value ?? "");
    if (key && value) claims.set(key, value);
  }
  return claims;
}

function hasInternalClaimConflict(candidate: ReferenceEvidenceCandidate): boolean {
  const valuesByKey = new Map<string, Set<string>>();
  for (const claim of candidate.claims ?? []) {
    const key = normalizeClaimPart(claim?.key ?? "");
    const value = normalizeClaimPart(claim?.value ?? "");
    if (!key || !value) continue;
    const values = valuesByKey.get(key) ?? new Set<string>();
    values.add(value);
    valuesByKey.set(key, values);
  }
  return [...valuesByKey.values()].some((values) => values.size > 1);
}

function bindingSpecificity(
  candidate: ReferenceEvidenceCandidate,
  expectedEntities: string[],
  expectedTopics: string[],
  expectedRegion: string,
): number {
  const entities = boundedStrings(candidate.entity_ids);
  const topics = boundedStrings(candidate.topic_ids);
  const regions = boundedStrings(candidate.regions, 12, 80);
  return (
    (expectedEntities.length && entities.length && overlaps(expectedEntities, entities) ? 2 : 0) +
    (expectedTopics.length && topics.length && overlaps(expectedTopics, topics) ? 2 : 0) +
    (expectedRegion && regions.includes(expectedRegion) ? 1 : 0)
  );
}

function comparableAuthorityTuple(
  candidate: ReferenceEvidenceCandidate,
  expectedEntities: string[],
  expectedTopics: string[],
  expectedRegion: string,
): string {
  return [
    REFERENCE_AUTHORITY_RANK[candidate.authority_class],
    bindingSpecificity(candidate, expectedEntities, expectedTopics, expectedRegion),
    finiteOrZero(candidate.source_priority),
    finiteOrZero(candidate.version_rank),
    parseTimestamp(candidate.updated_at),
  ].join(":");
}

function conflictingTopSources(
  candidates: ReferenceEvidenceCandidate[],
  expectedEntities: string[],
  expectedTopics: string[],
  expectedRegion: string,
): string[] {
  if (candidates.length < 1) return [];
  const topTuple = comparableAuthorityTuple(candidates[0], expectedEntities, expectedTopics, expectedRegion);
  const peers = candidates.filter(
    (candidate) =>
      comparableAuthorityTuple(candidate, expectedEntities, expectedTopics, expectedRegion) === topTuple,
  );
  const internallyConflicting = peers
    .filter(hasInternalClaimConflict)
    .map((candidate) => candidate.source_id)
    .sort();
  if (internallyConflicting.length) return internallyConflicting;
  if (peers.length < 2) return [];

  const valuesByKey = new Map<string, Map<string, Set<string>>>();
  for (const candidate of peers) {
    for (const [key, value] of normalizedClaims(candidate)) {
      const values = valuesByKey.get(key) ?? new Map<string, Set<string>>();
      const sources = values.get(value) ?? new Set<string>();
      sources.add(candidate.source_id);
      values.set(value, sources);
      valuesByKey.set(key, values);
    }
  }

  const conflictIds = new Set<string>();
  for (const values of valuesByKey.values()) {
    if (values.size < 2) continue;
    for (const sources of values.values()) {
      for (const source of sources) conflictIds.add(source);
    }
  }
  return [...conflictIds].sort();
}

function decisionForClass(authorityClass: ReferenceAuthorityClass): ReferenceAuthorityDecisionKind {
  if (authorityClass === "CANONICAL_TRANSACTION") return "USE_CANONICAL_STATE";
  if (authorityClass === "DETERMINISTIC_CALCULATION") {
    return "USE_DETERMINISTIC_CALCULATION";
  }
  if (authorityClass === "CURRENT_KB") return "USE_CURRENT_KB";
  if (authorityClass === "CUSTOMER_CONTEXT") return "USE_CUSTOMER_CONTEXT";
  if (authorityClass === "HISTORICAL") return "HISTORICAL_ONLY";
  return "INSUFFICIENT_EVIDENCE";
}

/**
 * Generic deterministic authority resolver shared by every industry.
 * Relevance is the last tie-breaker and can never outrank tenant, binding,
 * publication, currentness, authority class, source priority, or version.
 */
export function resolveReferenceAuthority(
  input: ResolveReferenceAuthorityInput,
): ReferenceAuthorityDecision {
  const expectedTenant = clean(input.expected_tenant_id ?? "", 160).toLowerCase();
  const expectedEntities = boundedStrings(input.expected_entity_ids);
  const expectedTopics = boundedStrings(input.expected_topic_ids);
  const expectedRegion = clean(input.expected_region ?? "", 80).toLowerCase();
  const requireExplicitTargetMatch = input.require_explicit_target_match === true;
  const rejected: ReferenceAuthorityRejection[] = [];
  const historical: ReferenceEvidenceCandidate[] = [];
  const eligible: ReferenceEvidenceCandidate[] = [];

  for (const candidate of input.candidates ?? []) {
    const sourceId = clean(candidate?.source_id ?? "", 200);
    if (!sourceId) continue;
    const tenant = clean(candidate.tenant_id ?? "", 160).toLowerCase();
    if (expectedTenant && tenant && tenant !== expectedTenant) {
      rejected.push({ source_id: sourceId, reason: "wrong_tenant" });
      continue;
    }
    const entities = boundedStrings(candidate.entity_ids);
    if (expectedEntities.length > 0 && ((requireExplicitTargetMatch && entities.length === 0) || !overlaps(expectedEntities, entities))) {
      rejected.push({ source_id: sourceId, reason: "wrong_entity" });
      continue;
    }
    const topics = boundedStrings(candidate.topic_ids);
    if (expectedTopics.length > 0 && ((requireExplicitTargetMatch && topics.length === 0) || !overlaps(expectedTopics, topics))) {
      rejected.push({ source_id: sourceId, reason: "wrong_topic" });
      continue;
    }
    const regions = boundedStrings(candidate.regions, 12, 80);
    if (expectedRegion && regions.length && !regions.includes(expectedRegion)) {
      rejected.push({ source_id: sourceId, reason: "wrong_region" });
      continue;
    }
    const currentness = referenceCurrentness(candidate);
    // A cancelled canonical transaction is itself the current transaction
    // truth. Keep it eligible so a generic KB candidate cannot resurrect it.
    if (candidate.authority_class === "CANONICAL_TRANSACTION" && currentness === "cancelled") {
      eligible.push(candidate);
      continue;
    }
    if (
      candidate.authority_class === "HISTORICAL" ||
      currentness === "historical" ||
      currentness === "superseded" ||
      currentness === "cancelled"
    ) {
      historical.push(candidate);
      rejected.push({ source_id: sourceId, reason: `${currentness}_evidence` });
      continue;
    }
    if (!isCurrentPublishedReference(candidate)) {
      rejected.push({
        source_id: sourceId,
        reason: "not_current_published_live",
      });
      continue;
    }
    if (candidate.authority_class === "MODEL_INFERENCE") {
      rejected.push({
        source_id: sourceId,
        reason: "model_inference_not_authority",
      });
      continue;
    }
    eligible.push(candidate);
  }

  const selectable = input.requires_current_kb
    ? eligible.filter(
        (candidate) =>
          candidate.authority_class === "CANONICAL_TRANSACTION" ||
          candidate.authority_class === "DETERMINISTIC_CALCULATION" ||
          candidate.authority_class === "CURRENT_KB",
      )
    : eligible;

  selectable.sort(
    (a, b) =>
      REFERENCE_AUTHORITY_RANK[b.authority_class] - REFERENCE_AUTHORITY_RANK[a.authority_class] ||
      bindingSpecificity(b, expectedEntities, expectedTopics, expectedRegion) -
        bindingSpecificity(a, expectedEntities, expectedTopics, expectedRegion) ||
      finiteOrZero(b.source_priority) - finiteOrZero(a.source_priority) ||
      finiteOrZero(b.version_rank) - finiteOrZero(a.version_rank) ||
      parseTimestamp(b.updated_at) - parseTimestamp(a.updated_at) ||
      finiteOrZero(b.relevance_score) - finiteOrZero(a.relevance_score) ||
      a.source_id.localeCompare(b.source_id),
  );

  const conflictSourceIds = conflictingTopSources(selectable, expectedEntities, expectedTopics, expectedRegion);
  if (conflictSourceIds.length > 0) {
    return {
      decision: "CONFLICT_UNRESOLVED",
      reason: "equal_authority_current_sources_conflict_without_precedence",
      selected_source_id: null,
      selected_authority_class: null,
      conflict_source_ids: conflictSourceIds,
      rejected,
      provenance: {
        tenant_id: expectedTenant || null,
        entity_ids: expectedEntities,
        topic_ids: expectedTopics,
        region: expectedRegion || null,
        source_type: null,
        version: null,
        currentness: null,
      },
    };
  }

  const selected = selectable[0];
  if (!selected) {
    const historicalOnly = historical.length > 0;
    return {
      decision: input.requires_current_kb
        ? "CURRENT_KB_REQUIRED"
        : historicalOnly
          ? "HISTORICAL_ONLY"
          : "INSUFFICIENT_EVIDENCE",
      reason: input.requires_current_kb
        ? "current_published_kb_evidence_not_available"
        : historicalOnly
          ? "only_historical_evidence_available"
          : "no_authoritative_evidence_available",
      selected_source_id: null,
      selected_authority_class: null,
      conflict_source_ids: [],
      rejected,
      provenance: {
        tenant_id: expectedTenant || null,
        entity_ids: expectedEntities,
        topic_ids: expectedTopics,
        region: expectedRegion || null,
        source_type: null,
        version: null,
        currentness: null,
      },
    };
  }

  return {
    decision: decisionForClass(selected.authority_class),
    reason: "highest_bound_current_authority_selected",
    selected_source_id: selected.source_id,
    selected_authority_class: selected.authority_class,
    conflict_source_ids: [],
    rejected,
    provenance: {
      tenant_id: clean(selected.tenant_id ?? "", 160) || expectedTenant || null,
      entity_ids: boundedStrings(selected.entity_ids),
      topic_ids: boundedStrings(selected.topic_ids),
      region: boundedStrings(selected.regions, 12, 80)[0] ?? (expectedRegion || null),
      source_type: clean(selected.source_type, 80) || null,
      version: clean(selected.version ?? "", 120) || null,
      currentness: referenceCurrentness(selected),
    },
  };
}
