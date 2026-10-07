/**
 * C3 bounded customer-service dialogue planning.
 *
 * This module never changes commerce, memory, KB, handoff or persistence state.
 * It consumes the decisions produced by those authorities and selects the next
 * useful dialogue action.  It is deliberately deterministic so the same facts
 * cannot acquire a different meaning during natural-language rendering.
 */
import { renderCanonicalRequirement, renderRequirementQualification } from "./commerce-capability-runtime.ts";
import type { CommerceEntity, ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CanonicalConversationMemory } from "./conversation-long-memory.ts";
import { exactProductIdentifiers, isProductOperationFailure, isProductSupportProblem } from "./natural-customer-response.ts";
import { deriveTypedCustomerMoneyFacts } from "./customer-money-facts.ts";
import { activeCustomerGoal, customerRequestedQuantity } from "./customer-journey-orchestration.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { requiresSemanticKnowledge, scopedServiceKnowledgeQuery } from "./service-semantic-routing.ts";
import { DecisionContextLimitError } from "./bounded-decision-context.ts";

import { HOME_APPLIANCE_CATEGORIES, HOME_APPLIANCE_ROOMS } from "./industry-profiles/home-appliance-v1.ts";

export type ServiceLanguage = "zh-TW" | "zh-CN" | "en";
export type ServiceKnowledgeState =
  | "not_needed"
  | "lookup_required"
  | "available"
  | "no_match"
  | "conflict"
  | "tool_failure";
export type ServiceDialogueAction =
  | "state_acknowledgement"
  | "direct_answer"
  | "historical_calculation"
  | "shorten_previous_answer"
  | "current_state_checklist"
  | "targeted_clarification"
  | "published_kb_lookup"
  | "bounded_kb_refinement"
  | "partial_answer_then_question"
  | "customer_issue_next_step"
  | "offer_handoff_or_reframe"
  | "explicit_handoff";

export type ServiceIssueKind =
  | "account_access"
  | "order_change"
  | "order_status_lookup"
  | "refund_or_product_quality"
  | "delivery_or_collection"
  | "stock_or_store_availability"
  | "product_operation_failure"
  | "marketplace_or_product_support"
  | "general_customer_issue";

export interface ServiceRecallDecision {
  handled: boolean;
  reason?: "CURRENT_KB_REQUIRED" | "AMBIGUOUS" | "NOT_A_RECALL_QUERY";
  detail?: string;
  fact_type?: string;
  value?: unknown;
}

export interface ServiceDialoguePlan {
  version: "c3-service-plan-1.1.0";
  language: ServiceLanguage;
  action: ServiceDialogueAction;
  customer_goal: string;
  committed_requirements?: CommerceEntity[];
  committed_commerce?: ConversationCommerceState;
  question_lifecycle?: CanonicalConversationMemory["question_lifecycle"];
  known_facts: Array<{
    name: string;
    label: string;
    value: string;
    authority: string;
    status: "provided" | "confirmed" | "draft" | "not_started";
  }>;
  missing_slots: string[];
  clarification_target: string | null;
  clarification_previously_asked: boolean;
  knowledge_state: ServiceKnowledgeState;
  kb_query: string | null;
  handoff_requested: boolean;
  safe_assumptions: string[];
  emotion_trace?: { kind: string; intensity: string; source: string };
  entitlement_trace?: {
    name: string;
    value: string;
    authority: string;
    source: string;
  };
  entitlement_status: "trusted" | "unknown";
  calculation?: {
    terms: Array<
      {
        label: string;
        amount: number;
        charge_basis: "per_unit" | "per_order";
        source: string;
      }
    >;
    quantity: number;
    per_unit_total: number;
    per_order_total: number;
    total: number;
    currency: string;
    historical_only: true;
  };
  issue_kind?: ServiceIssueKind;
  /** The current customer turn, retained only for bounded natural rendering. */
  customer_turn?: string;
  recall_reason?: ServiceRecallDecision["reason"];
  recall_detail?: string;
}

export interface ServiceCalculationTerm {
  label: string;
  amount: number;
  currency: string;
  charge_basis: "per_unit" | "per_order";
  source: "customer_message" | "canonical_commerce_state";
  source_message_id?: string;
}

export interface ServicePlanInput {
  question: string;
  semantic_frame?: CommerceSemanticFrame | null;
  committed_source_message_id?: string;
  language: ServiceLanguage;
  recall: ServiceRecallDecision;
  memory: CanonicalConversationMemory | null;
  commerce: ConversationCommerceState | null;
  recent_messages?: Array<{ role: string; content: string }>;
  clarification_attempts?: number;
  exact_same_intent_repeated?: boolean;
  explicit_handoff?: boolean;
  calculation_terms?: ServiceCalculationTerm[];
  calculation_quantity?: number;
  calculation_status?:
    | "not_requested"
    | "ready"
    | "missing_explicit_basis"
    | "missing_quantity"
    | "mixed_currency"
    | "no_typed_amounts";
  emotion?: { kind: string; intensity?: string; source: string } | null;
  entitlement?: {
    name: string;
    value: string;
    authority: "TRUSTED_CRM";
    source: string;
  } | null;
}

const clean = (value: unknown, limit = 180) =>
  Array.from(
    String(value ?? ""),
    (character) => character.charCodeAt(0) < 32 ? " " : character,
  ).join("").replace(/\s+/g, " ").trim().slice(0, limit);
const has = (text: string, values: string[]) =>
  values.some((value) =>
    text.toLocaleLowerCase().includes(value.toLocaleLowerCase())
  );

// Locale names for the existing canonical room-size keys used below.
const SERVICE_ROOM_LABELS: Record<string, [string, string, string]> = {
  small_bedroom: ["細房", "小卧室", "small bedroom"],
  large_bedroom: ["大房", "大卧室", "large bedroom"],
  living_room: ["客廳", "客厅", "living room"],
  study: ["書房", "书房", "study"],
};

function knownFacts(input: ServicePlanInput) {
  const facts: ServiceDialoguePlan["known_facts"] = [];
  const add = (
    name: string,
    label: string,
    value: unknown,
    authority: string,
    status: ServiceDialoguePlan["known_facts"][number]["status"] = "provided",
  ) => {
    const rendered = clean(value);
    if (
      rendered &&
      !facts.some((item) => item.name === name && item.value === rendered)
    ) {
      facts.push({ name, label, value: rendered, authority, status });
    }
  };
  const state = input.commerce;
  if (state) {
    add(
      "current_intent",
      "目前目標",
      state.current_intent,
      "CANONICAL_COMMERCE_STATE",
    );
    add(
      "current_topic",
      "查詢項目",
      state.current_topic,
      "CANONICAL_COMMERCE_STATE",
    );
    add(
      "delivery_address",
      "送貨地址",
      state.delivery.address,
      "CANONICAL_COMMERCE_STATE",
      state.delivery.confirmed ? "confirmed" : "provided",
    );
    add(
      "recipient_name",
      "收件人",
      state.delivery.recipient_name,
      "CANONICAL_COMMERCE_STATE",
    );
    add(
      "delivery_preference",
      "希望送貨日期",
      state.delivery.preferred_date,
      "CUSTOMER_PREFERENCE",
    );
    add(
      "quotation_status",
      "報價狀態",
      state.conversion.quotation_status,
      "CANONICAL_COMMERCE_STATE",
      state.conversion.quotation_status === "draft" ? "draft" : "provided",
    );
    add(
      "order_status",
      "訂單狀態",
      state.conversion.order_status,
      "CANONICAL_COMMERCE_STATE",
      state.conversion.order_status === "none" ? "not_started" : "provided",
    );
    for (
      const entity of state.entities.filter((item) =>
        !["cancelled", "deferred"].includes(item.status)
      )
    ) {
      const l = input.language === "en" ? 2 : input.language === "zh-CN" ? 1 : 0;
      if (entity.attributes.room_sizes && typeof entity.attributes.room_sizes === "object") {
        for (const [room, size] of Object.entries(entity.attributes.room_sizes))
          add(`entity:${entity.entity_id}:room_size:${room}`, `${SERVICE_ROOM_LABELS[room]?.[l] ?? HOME_APPLIANCE_ROOMS.find(r => r.key === room)?.label[input.language] ?? ["空間", "空间", "Space"][l]}${["面積", "面积", " area"][l]}`, size, "CUSTOMER_PROVIDED");
      }
      add(`entity:${entity.entity_id}:requested_date`, "Requested date", entity.attributes.requested_date,"CUSTOMER_PROVIDED");
      add(`entity:${entity.entity_id}:product_name`, "Item", entity.attributes.product_name, "CUSTOMER_PROVIDED");
      add(`entity:${entity.entity_id}:sku`, "SKU", entity.attributes.sku, "CUSTOMER_PROVIDED");
      const variant = entity.attributes.variant;
      if (variant && typeof variant === "object" && !Array.isArray(variant)) {
        for (const field of ["color", "version", "size", "region"])
          add(`entity:${entity.entity_id}:${field}`, field, (variant as Record<string, unknown>)[field], "CUSTOMER_PROVIDED");
      }
      add(
        `entity:${entity.entity_id}:quantity`,
        "數量",
        customerRequestedQuantity(entity),
        "CANONICAL_COMMERCE_STATE",
      );
      add(
        `entity:${entity.entity_id}:model`,
        "型號",
        entity.model ?? entity.attributes.model,
        "CUSTOMER_PROVIDED",
      );
      add(
        `entity:${entity.entity_id}:room_size`,
        "使用面積",
        entity.attributes.room_size,
        "CUSTOMER_PROVIDED",
      );
      add(
        `entity:${entity.entity_id}:horsepower`,
        "所需匹數",
        entity.attributes.horsepower,
        "CUSTOMER_REQUIREMENT",
      );
    }
  }
  if (input.memory) {
    add(
      "customer_goal",
      "目前目標",
      input.memory.current_goal,
      "CURRENT_CUSTOMER_MEMORY",
    );
    add(
      "current_topic",
      "查詢項目",
      input.memory.current_topic,
      "CURRENT_CUSTOMER_MEMORY",
    );
    for (const preference of input.memory.customer_preferences) {
      add("customer_preference", "偏好", preference, "CURRENT_CUSTOMER_MEMORY");
    }
    for (const constraint of input.memory.active_constraints) {
      add(
        "customer_constraint",
        "重要限制",
        constraint,
        "CURRENT_CUSTOMER_MEMORY",
      );
    }
  }
  return facts.slice(0, 12);
}

function historicalCalculation(
  question: string,
  input: ServicePlanInput,
): ServiceDialoguePlan["calculation"] | null {
  if (
    !has(question, [
      "試算",
      "试算",
      "假設",
      "假设",
      "如果",
      "若果",
      "若按",
      "conditional",
      "hypothetical",
      "assuming",
      "if",
      "舊",
      "頭先", "用返", "以前", "之前", "earlier", "previous",
      "旧",
      "historical",
      "estimate",
    ])
  ) return null;
  const terms = (input.calculation_terms ?? []).filter((term) =>
    Number.isFinite(term.amount) && term.amount >= 0 && clean(term.label) &&
    clean(term.currency)
  );
  if (terms.length < 1) return null;
  const currencies = new Set(terms.map((term) => term.currency.toUpperCase()));
  if (currencies.size !== 1) return null;
  const needsQuantity = terms.some((term) => term.charge_basis === "per_unit");
  const quantity = Number.isInteger(input.calculation_quantity) &&
      Number(input.calculation_quantity) > 0
    ? Number(input.calculation_quantity)
    : needsQuantity
    ? null
    : 1;
  if (quantity === null) return null;
  const perUnit = terms.filter((term) => term.charge_basis === "per_unit")
    .reduce((sum, term) => sum + term.amount, 0);
  const perOrder = terms.filter((term) => term.charge_basis === "per_order")
    .reduce((sum, term) => sum + term.amount, 0);
  return {
    terms: terms.map((term) => ({
      label: clean(term.label, 80),
      amount: term.amount,
      charge_basis: term.charge_basis,
      source: term.source,
      ...(term.source_message_id ? { source_message_id: term.source_message_id } : {}),
    })),
    quantity,
    per_unit_total: perUnit,
    per_order_total: perOrder,
    total: Math.round((perUnit * quantity + perOrder)*100)/100,
    currency: [...currencies][0],
    historical_only: true,
  };
}

function factSatisfiesSlot(
  facts: ServiceDialoguePlan["known_facts"],
  slot: string | null,
): boolean {
  if (!slot) return false;
  const names: Record<string, RegExp> = {
    model_or_product_link: /:model(?:\n|$)|product_link/,
    room_size_or_dimensions: /:room_size(?:\n|$)|dimensions/,
    region: /region|market/,
    applicable_date: /delivery_preference|date/,
    intended_use: /current_intent|customer_goal/,
    budget_range: /budget/,
  };
  return names[slot]?.test(facts.map((fact) => fact.name).join("\n")) ?? false;
}

function requestedSlot(question: string): string | null {
  const slots: Array<[string, string[]]> = [
    ["model_or_product_link", [
      "型號",
      "型号",
      "model",
      "產品頁",
      "产品页",
      "product link",
    ]],
    ["budget_range", ["預算", "预算", "budget"]],
    ["room_size_or_dimensions", [
      "面積",
      "面积",
      "尺寸",
      "room size",
      "dimensions",
    ]],
    ["intended_use", ["用途", "使用情況", "使用情况", "intended use"]],
    ["region", ["地區", "地区", "region", "market"]],
    ["applicable_date", ["日期", "幾時", "何时", "date", "when"]],
  ];
  return slots.find(([, words]) => has(question, words))?.[0] ?? null;
}

function buildKbQuery(question: string, input: ServicePlanInput): string {
  return scopedServiceKnowledgeQuery(question, input.semantic_frame, input.commerce);
}

/**
 * Thin shared semantic layer for a fully described customer-service issue.
 * It selects a safe next-step family only; it never reads or mutates state and
 * never claims that an order, refund, delivery, cancellation or handoff exists.
 */
function classifyCustomerIssue(question: string): ServiceIssueKind | null {
  const text = clean(question, 2400);
  const productProblem = isProductSupportProblem(text);
  if (/(?:查|查看|查詢|查询|核對|核对).{0,10}(?:訂單|订单)|(?:check|track|look up).{0,24}\border\b|\border\s+status\b/i.test(text)) return "order_status_lookup";
  if (text.length < 24 && !productProblem) return null;
  if (isProductOperationFailure(text)) return "product_operation_failure";
  if (
    /(?:password|login|log in|sign in|reset email|account access|密碼|密码|登入|登錄|登录|重設電郵|重置邮件)/i
      .test(text)
  ) {
    return "account_access";
  }
  if (
    /(?:change (?:the )?address|wrong (?:size|item)|cancel.{0,40}\border\b|requested cancellation|取消訂單|取消订单|更改地址|改地址|尺碼錯|尺寸错)/i
      .test(text)
  ) {
    return "order_change";
  }
  if (
    /(?:out of date|expired|expiry|refund|return|damaged|broken|missing (?:part|item|feature)|not protected|wrong (?:plug|part|product)|food.{0,30}(?:bad|fresh|satisfied)|退款|退貨|退货|過期|过期|損壞|损坏|缺件|品質|质量)/i
      .test(text)
  ) {
    return "refund_or_product_quality";
  }
  if (
    /(?:in stock|out of stock|stock availability|popular brands|store.{0,40}(?:stock|deliveries)|availability|現貨|现货|庫存|库存|門市有貨|门店有货)/i
      .test(text)
  ) {
    return "stock_or_store_availability";
  }
  if (
    /(?:delivery|delivered|dispatch|shipment|tracking|parcel|package|lost in transit|arriv|collection|courier|送貨|送货|配送|派送|物流|包裹|到貨|到货|取件)/i
      .test(text) &&
    // A historical delivery charge is a money fact, not a delivery incident.
    (!deriveTypedCustomerMoneyFacts(text).historical ||
      !deriveTypedCustomerMoneyFacts(text).facts.length ||
      /(?:problem|issue|late|delay|missing|lost|not arrived|hasn.t arrived|問題|问题|遲到|延誤|延误|未到|唔到|未收到|投訴|投诉)/i.test(text))
  ) {
    return "delivery_or_collection";
  }
  if (
    productProblem || /(?:third[- ]party seller|marketplace|seller|賣家|卖家).{0,50}(?:problem|issue|complain|support|投訴|投诉|問題|问题|協助|协助)/i
      .test(text)
  ) {
    return "marketplace_or_product_support";
  }
  return /(?:customer|complain|issue|problem|help|service|disappoint|not satisfied|客戶|客户|投訴|投诉|問題|问题|協助|协助|失望)/i
      .test(text)
    ? "general_customer_issue"
    : null;
}

export function planConversationService(
  input: ServicePlanInput,
): ServiceDialoguePlan {
  const question = clean(input.question, 2400);
  const observedEmotion = input.emotion ?? (
    /(?:失望|嬲|憤怒|愤怒|生氣|生气|frustrat|angry|furious|disappoint)/i.test(
        question,
      )
      ? {
        kind: /(?:嬲|憤怒|愤怒|生氣|生气|angry|furious)/i.test(question)
          ? "angry"
          : "frustrated",
        intensity: "customer_expressed",
        source: "current_customer_turn",
      }
      : null
  );
  const facts = knownFacts(input);
  const clarificationTarget = requestedSlot(question);
  const repeated = (input.clarification_attempts ?? 0) >= 2 ||
    input.exact_same_intent_repeated === true;
  const base = {
    version: "c3-service-plan-1.1.0" as const,
    language: input.language,
    customer_goal: clean(
      input.memory?.current_goal || input.commerce?.current_intent || question,
      240,
    ),
    known_facts: facts,
    committed_commerce: input.commerce ?? undefined,
    question_lifecycle: input.memory?.question_lifecycle,
    missing_slots: [] as string[],
    clarification_target: null as string | null,
    clarification_previously_asked: (input.clarification_attempts ?? 0) > 0,
    knowledge_state: "not_needed" as ServiceKnowledgeState,
    kb_query: null as string | null,
    handoff_requested: input.explicit_handoff === true,
    safe_assumptions: [] as string[],
    ...(observedEmotion && clean(observedEmotion.kind)
      ? {
        emotion_trace: {
          kind: clean(observedEmotion.kind, 40),
          intensity: clean(observedEmotion.intensity ?? "unknown", 20),
          source: clean(observedEmotion.source, 80),
        },
      }
      : {}),
    ...(input.entitlement?.authority === "TRUSTED_CRM"
      ? {
        entitlement_trace: {
          name: clean(input.entitlement.name, 80),
          value: clean(input.entitlement.value, 120),
          authority: input.entitlement.authority,
          source: clean(input.entitlement.source, 80),
        },
      }
      : {}),
    entitlement_status: input.entitlement?.authority === "TRUSTED_CRM"
      ? "trusted" as const
      : "unknown" as const,
    customer_turn: question,
    recall_reason: input.recall.reason,
    recall_detail: clean(input.recall.detail, 100) || undefined,
  };
  if (input.explicit_handoff) return { ...base, action: "explicit_handoff" };
  const semanticMerchantRead = requiresSemanticKnowledge(input.semantic_frame);
  const merchantReadRequired = input.recall.reason === "CURRENT_KB_REQUIRED" || semanticMerchantRead;
  if (
    !semanticMerchantRead &&
    input.calculation_status &&
    !["not_requested", "ready"].includes(input.calculation_status)
  ) {
    const target = input.calculation_status === "missing_quantity"
      ? "calculation_quantity"
      : input.calculation_status === "mixed_currency"
      ? "calculation_currency"
      : "calculation_charge_basis";
    return {
      ...base,
      action: facts.length
        ? "partial_answer_then_question"
        : "targeted_clarification",
      missing_slots: [target],
      clarification_target: target,
      safe_assumptions: ["calculation_blocked_until_typed_operands_complete"],
    };
  }

  const calculation = semanticMerchantRead ? null : historicalCalculation(question, input);
  if (calculation) {
    return {
      ...base,
      action: "historical_calculation",
      calculation,
      safe_assumptions: [
        "typed_historical_amounts_only",
        "charge_basis_explicit",
      ],
    };
  }
  if (!semanticMerchantRead && has(question, ["短啲", "短一點", "短一点", "shorten", "more concise"])) {
    return { ...base, action: "shorten_previous_answer" };
  }
  if (
    !semanticMerchantRead && has(question, ["checklist", "清單", "清单", "付款前", "落單前", "下单前"])
  ) {
    return { ...base, action: "current_state_checklist" };
  }
  if (input.recall.handled && !merchantReadRequired) return { ...base, action: "direct_answer" };
  if (input.semantic_frame?.ambiguity.is_ambiguous && !input.recall.handled) {
    return { ...base, action: "targeted_clarification", missing_slots: ["specific_product_or_item"], clarification_target: "specific_product_or_item" };
  }
  if (merchantReadRequired) {
    let query: string;
    try { query = buildKbQuery(question, input); }
    catch (error) {
      if (!(error instanceof DecisionContextLimitError)) throw error;
      return { ...base, action:"offer_handoff_or_reframe", knowledge_state:"tool_failure",
        safe_assumptions:[...base.safe_assumptions,"query_context_limit"], kb_query:null };
    }
    const missingTarget = factSatisfiesSlot(facts, clarificationTarget)
      ? null
      : clarificationTarget;
    return {
      ...base,
      action: repeated ? "bounded_kb_refinement" : "published_kb_lookup",
      knowledge_state: "lookup_required",
      kb_query: query,
      clarification_target: missingTarget,
      missing_slots: missingTarget ? [missingTarget] : [],
    };
  }
  if (input.recall.reason === "AMBIGUOUS") {
    const target = input.recall.detail === "ENTITY_REFERENCE_AMBIGUOUS"
      ? "specific_product_or_item"
      : clarificationTarget ?? "specific_item_or_time";
    return {
      ...base,
      action: repeated
        ? "offer_handoff_or_reframe"
        : facts.length
        ? "partial_answer_then_question"
        : "targeted_clarification",
      missing_slots: [target],
      clarification_target: target,
    };
  }
  const issueKind = classifyCustomerIssue(question);
  if (issueKind) {
    return {
      ...base,
      action: "customer_issue_next_step",
      issue_kind: issueKind,
      missing_slots: [],
      clarification_target: null,
      safe_assumptions: [
        "no_live_account_or_order_state",
        "no_completed_action_without_runtime_evidence",
      ],
    };
  }
  const committed = input.commerce?.entities.filter(entity=>entity.entity_id.startsWith("generic:") &&
    entity.provenance.source_message_id === input.committed_source_message_id) ?? [];
  if (committed.length && input.committed_source_message_id && !/[?？]/.test(question)) {
    return {...base, action:"state_acknowledgement", committed_requirements:committed, committed_commerce:input.commerce!};
  }
  const customerGap = contextualCustomerGap(input.commerce);
  if (customerGap && !clarificationTarget) return {...base, action:"partial_answer_then_question", missing_slots:[customerGap.field], clarification_target:customerGap.field};
  const target = clarificationTarget ?? "customer_goal";
  if (factSatisfiesSlot(facts, target)) {
    return { ...base, action: "partial_answer_then_question", missing_slots: [], clarification_target: null };
  }
  return {
    ...base,
    action: repeated
      ? "offer_handoff_or_reframe"
      : facts.length
      ? "partial_answer_then_question"
      : "targeted_clarification",
    missing_slots: [target],
    clarification_target: target,
  };
}

const formatMoney = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const labels: Record<string, [string, string, string]> = {
  specific_product_or_item: [
    "你指的是哪一件產品或哪個項目？",
    "你指的是哪一件产品或哪个项目？",
    "Which product or item do you mean?",
  ],
  specific_item_or_time: [
    "你想核對哪個項目或哪個時間點？",
    "你想核对哪个项目或哪个时间点？",
    "Which item or point in time should I check?",
  ],
  model_or_product_link: [
    "請提供型號或產品頁。",
    "请提供型号或产品页。",
    "Please share the model or product page.",
  ],
  budget_range: [
    "你的預算範圍是多少？",
    "你的预算范围是多少？",
    "What budget range should I use?",
  ],
  room_size_or_dimensions: [
    "請提供使用位置的面積或尺寸。",
    "请提供使用位置的面积或尺寸。",
    "What is the room size or relevant dimensions?",
  ],
  intended_use: [
    "主要用途是甚麼？",
    "主要用途是什么？",
    "What is the main intended use?",
  ],
  region: [
    "這項查詢適用哪個地區？",
    "这项查询适用哪个地区？",
    "Which region does this apply to?",
  ],
  applicable_date: [
    "你要核對哪個日期的資料？",
    "你要核对哪个日期的资料？",
    "Which date should I check?",
  ],
  customer_goal: [
    "你今次最想完成哪一件事？",
    "你这次最想完成哪一件事？",
    "What would you most like to complete now?",
  ],
  calculation_quantity: [
    "請確認要按多少部／件計算。",
    "请确认要按多少部／件计算。",
    "Please confirm how many units the calculation should cover.",
  ],
  calculation_currency: [
    "這些金額包含不同幣別；請確認要用哪一個幣別，不能直接相加。",
    "这些金额包含不同币别；请确认要用哪一个币别，不能直接相加。",
    "These amounts use different currencies. Please confirm one currency; I cannot add them directly.",
  ],
  calculation_charge_basis: [
    "呢個金額係單價，定係整批總額？",
    "这个金额是单价，还是整批总额？",
    "Is this amount a unit price or the total for the whole batch?",
  ],
};

/** Presentation only: typed fields use the existing industry locale contract.
 * Customer text, identifiers, numbers and units are never globally rewritten. */
function contextualFacts(plan: ServiceDialoguePlan, language: ServiceLanguage): string[] {
  const state = plan.committed_commerce;
  const active = state?.entities.filter(e => !["deferred", "cancelled"].includes(e.status)) ?? [];
  const goal = state ? activeCustomerGoal(state) : null;
  const categoryKey = (value: string | null | undefined) => HOME_APPLIANCE_CATEGORIES.find(c =>
    c.key === value || c.aliases.some(alias => alias.toLowerCase() === value?.toLowerCase()))?.key ?? clean(value);
  const category = categoryKey(goal?.goal.category ?? state?.current_topic);
  const labels: Record<string, [string, string, string]> = {
    current_topic: ["查詢項目", "查询项目", "Item"],
    delivery_address: ["送貨地址", "送货地址", "Delivery address"],
    recipient_name: ["收件人", "收件人", "Recipient"],
    delivery_preference: ["希望送貨日期", "希望送货日期", "Preferred delivery date"],
    customer_preference: ["偏好", "偏好", "Preference"],
    customer_constraint: ["重要限制", "重要限制", "Constraint"],
    model: ["型號", "型号", "Model"], quantity: ["數量", "数量", "Quantity"],
    room_size: ["使用面積", "使用面积", "Area"],
    horsepower: ["所需匹數", "所需匹数", "Required horsepower"],
    requested_date: ["希望日期", "希望日期", "Requested date"],
    product_name: ["項目", "项目", "Item"], sku: ["SKU", "SKU", "SKU"],
    color: ["顏色", "颜色", "Color"], version: ["版本", "版本", "Version"],
    region: ["適用地區", "适用地区", "Region"], size: ["尺寸", "尺寸", "Size"],
  };
  const l = language === "en" ? 2 : language === "zh-CN" ? 1 : 0;
  const selected = active.find(e => e.entity_id === goal?.entity_id) ??
    (active.filter(e => categoryKey(e.category) === category).length === 1 ? active.find(e => categoryKey(e.category) === category) : undefined);
  const topicName = HOME_APPLIANCE_CATEGORIES.find(c => c.key === category)?.label[language] ??
    (clean(selected?.attributes.product_name) || clean(selected?.model) || clean(selected?.attributes.sku));
  const seen = new Set<string>();
  return plan.known_facts.flatMap(fact => {
    if (["current_intent", "customer_goal", "quotation_status", "order_status"].includes(fact.name)) return [];
    // Prefer the current entity fields over prose memory copies of requirements.
    if (active.length && fact.authority === "CURRENT_CUSTOMER_MEMORY" && !["customer_preference", "customer_constraint"].includes(fact.name)) return [];
    const entity = active.find(e => fact.name.startsWith(`entity:${e.entity_id}:`));
    if (fact.name.startsWith("entity:") && state && (!entity || (category && categoryKey(entity.category) !== category))) return [];
    if (fact.name.startsWith("delivery") || fact.name === "recipient_name") {
      if (!/(?:送貨|送货|delivery|收件|recipient)/i.test(plan.customer_goal + " " + (plan.customer_turn ?? ""))) return [];
    }
    let label = labels[fact.name]?.[l];
    let value = fact.value;
    if (fact.name === "current_topic") {
      return [topicName || ["仲未確認你指邊項產品", "还未确认你指哪项产品", "item not confirmed yet"][l]];
    }
    if (entity) {
      const field = fact.name.slice(`entity:${entity.entity_id}:`.length);
      if (field.startsWith("room_size:")) {
        const roomKey = field.slice("room_size:".length);
        const roomName = SERVICE_ROOM_LABELS[roomKey]?.[l] ?? HOME_APPLIANCE_ROOMS.find(r => r.key === roomKey)?.label[language];
        label = roomName ? roomName + ["面積", "面积", " area"][l] : ["空間面積", "空间面积", "Space area"][l];
      } else label = labels[field]?.[l];
    }
    // Unknown schema fields receive a neutral label, never a raw internal key.
    label ??= ["你提供的資料", "你提供的资料", "Provided detail"][l];
    if (entity && ["product_name", "model", "sku"].includes(fact.name.slice(`entity:${entity.entity_id}:`.length)) && seen.has(value)) return [];
    seen.add(value);
    return [`${label}${l === 2 ? ": " : "："}${value}`];
  }).slice(0, 6);
}

const CONTEXTUAL_CUSTOMER_SLOTS = [
    { keys:["color","colour","variant_color"], field:"color", match:/顏色|颜色|colou?r/i,
      label:["顏色","颜色","color"], purpose:["定位相應款式","定位相应款式","identify the relevant variant options"] },
    { keys:["version","edition","variant_version"], field:"version", match:/版本|version|edition/i,
      label:["版本","版本","version"], purpose:["核對相應版本資料","核对相应版本资料","locate the matching version information"] },
    { keys:["region","market","applicable_region"], field:"region", match:/地區|地区|region|market/i,
      label:["適用地區","适用地区","region"], purpose:["核對適用資料及政策","核对适用资料及政策","find applicable information and policy"] },
    { keys:["size","variant_size"], field:"size", match:/尺碼|尺码|size/i,
      label:["尺碼","尺码","size"], purpose:["定位相應款式","定位相应款式","identify the relevant variant options"] },
  ];

function contextualCustomerGap(state: ConversationCommerceState | null | undefined) {
  if (!state) return null;
  const current = activeCustomerGoal(state);
  if (!current) return null;
  const entity = state.entities.find(e => e.entity_id === current.entity_id)!;
  const variant = entity.attributes.variant as Record<string, unknown> | undefined;
  return CONTEXTUAL_CUSTOMER_SLOTS.find(slot => current.goal.missing.some(k => slot.keys.includes(k)) &&
    !slot.keys.some(k => current.goal.collected.includes(k)) &&
    !clean(variant?.[slot.field] ?? entity.attributes[slot.field] ?? state.customer_constraints[slot.field])) ?? null;
}

/** Read existing goal slots and question lifecycle; this projection stores no new state. */
function contextualMissingContinuation(plan: ServiceDialoguePlan, l: number, recent: Array<{role: string; content: string}>): string | null {
  const state = plan.committed_commerce;
  const current = state && activeCustomerGoal(state);
  if (!current?.goal.missing.length) return null;
  const entity = state!.entities.find(e => e.entity_id === current.entity_id)!;
  const variant = entity.attributes.variant as Record<string, unknown> | undefined;

  for (const missing of current.goal.missing) {
    const slot = CONTEXTUAL_CUSTOMER_SLOTS.find(s => s.keys.includes(missing));
    if (!slot) continue;
    const supplied = clean(variant?.[slot.field] ?? entity.attributes[slot.field] ?? state!.customer_constraints[slot.field]);
    if (supplied || slot.keys.some(k => current.goal.collected.includes(k))) continue;
    const asked = (plan.clarification_previously_asked && slot.keys.includes(plan.clarification_target ?? "")) ||
      recent.some(m => m.role === "assistant" && /[?？]/.test(m.content) && slot.match.test(m.content)) ||
      plan.question_lifecycle?.some(q => q.status !== "superseded" && q.entity_id === current.entity_id && slot.match.test(q.text));
    return asked ? [
      `${slot.label[l]}仍未確認；有呢項資料後先可以${slot.purpose[l]}，唔會重複問同一缺項。`,
      `${slot.label[l]}仍未确认；有这项资料后才能${slot.purpose[l]}，不会重复问同一缺项。`,
      `The ${slot.label[l]} is still unconfirmed. It is needed to ${slot.purpose[l]}; I will not repeat the same question.`,
    ][l] : [
      `你想要邊個${slot.label[l]}？呢項資料用嚟${slot.purpose[l]}。`,
      `你想要哪个${slot.label[l]}？这项资料用于${slot.purpose[l]}。`,
      `Which ${slot.label[l]} do you need? That will help ${slot.purpose[l]}.`,
    ][l];
  }
  if (current.goal.missing.some(k => ["stock","current_stock","stock_confirmation","live_stock"].includes(k))) return [
    "即時庫存仍要由商家嘅庫存資料核實，現時未能確認有貨。",
    "实时库存仍需由商家的库存资料核实，目前无法确认有货。",
    "Live stock still needs merchant inventory confirmation; availability is not confirmed.",
  ][l];
  const capabilities = entity.attributes.capabilities as Record<string, unknown> | undefined;
  if (current.goal.missing.some(k => ["site_check","site_safety","professional_confirmation"].includes(k)) ||
      capabilities?.requires_site_check === true) return [
    "現場適用性及安全仍需專業人員核實；現有資料未足以確認。",
    "现场适用性及安全仍需专业人员核实；现有资料不足以确认。",
    "Site suitability and safety still need professional confirmation; the current information cannot establish them.",
  ][l];
  const unresolved = current.goal.missing.filter(k => !CONTEXTUAL_CUSTOMER_SLOTS.some(s => s.keys.includes(k)));
  if (!unresolved.length) return null;
  if (unresolved.some(k => ["suitable_models","product_information","policy","sizing_decision"].includes(k))) return [
    "未確認嘅產品或政策資料仍要由適用嘅已發布資料核實；現時未能確認。",
    "未确认的产品或政策资料仍需由适用的已发布资料核实，目前无法确认。",
    "The unresolved product or policy information still needs applicable published evidence; it is not confirmed.",
  ][l];
  return ["仍有未確認資料；現有資料不足以決定下一步，需先核對具體缺項。","仍有未确认资料；现有资料不足以决定下一步，需先核对具体缺项。","Some information remains unresolved. The specific missing requirement must be identified before deciding the next step."][l];
}

function contextualContinuation(plan: ServiceDialoguePlan, l: number, recent: Array<{role: string; content: string}>): string {
  const state = plan.committed_commerce;
  const goal = state ? activeCustomerGoal(state) : null;
  const objectives: Record<string, [string, string, string]> = {
    select_product: ["你想揀合適產品", "你想选择合适产品", "You want to choose a suitable product"],
    replace_existing_appliance: ["你想更換現有產品", "你想更换现有产品", "You want to replace your existing product"],
    compare_products: ["你想比較產品", "你想比较产品", "You want to compare products"],
    repair: ["你想處理維修", "你想处理维修", "You need help with a repair"],
    after_sales: ["你想跟進售後問題", "你想跟进售后问题", "You need after-sales support"],
  };
  const objective = goal?.goal.objective ?? state?.current_intent;
  const goalText = objective && objectives[objective]?.[l] ||
    (objective && !/^[a-z]+(?:_[a-z]+)*$/.test(objective) ? objective : "");
  const prefix = goalText ? goalText + (l === 2 ? ". " : "。") : "";
  // A persisted pending check is not a completed check or a new discovery goal.
  const category = goal?.goal.category ?? state?.current_topic;
  const selectingAC = HOME_APPLIANCE_CATEGORIES.find(c => c.key === "air_conditioner")?.aliases
    .some(alias => alias.toLowerCase() === category?.toLowerCase()) || category === "air_conditioner";
  if (selectingAC && objective && ["select_product", "replace_existing_appliance", "compare_products"].includes(objective) && state?.installation.pending_checks.includes("window_opening_check")) {
    const alreadyAsked = plan.clarification_previously_asked || recent.some(m => m.role === "assistant" && /(?:窗口|window)/i.test(m.content) && /(?:闊|宽|高度|width|height)/i.test(m.content));
    return prefix + (alreadyAsked ? [
      "窗口位闊度同高度仍未有資料；有尺寸後先可以核對放機限制，型號適用性仍要產品資料及專業確認。",
      "窗口位置的宽度和高度仍未提供；有尺寸后才能核对放置限制，型号适用性仍需产品资料及专业确认。",
      "The window-opening width and height are still missing. Those measurements are needed to check fit; product evidence and professional confirmation are still needed for suitability.",
    ][l] : [
      "要核對窗口位可唔可以放得落，仲欠各位置可用嘅闊度同高度。你有呢啲尺寸嗎？型號適用性仍要產品資料及專業確認。",
      "要核对放置限制，还缺各位置可用的宽度和高度。你有这些尺寸吗？型号适用性仍需产品资料及专业确认。",
      "To check whether a unit will fit, I still need the usable width and height of each opening. Do you have those measurements? Suitability still needs product evidence and professional confirmation.",
    ][l]);
  }
  const missing = contextualMissingContinuation(plan, l, recent);
  if (missing) return prefix + missing;
  if (goalText) return prefix + [
    "相關商戶資料仍需核實。",
    "相关商户资料仍需核实。",
    "Merchant information still requires verification.",
  ][l];
  return plan.clarification_previously_asked ? [
    "跟進方向仍未確認；可以補充你想處理嘅具體問題。",
    "跟进方向仍未确认；可以补充你想处理的具体问题。",
    "The next step is still unclear; please add the specific issue you need help with.",
  ][l] : [
    "你想核對產品資料，定係跟進使用問題？",
    "你想核对产品资料，还是跟进使用问题？",
    "Would you like to check product information or get help with a usage issue?",
  ][l];
}

function renderContextualServiceReply(
  plan: ServiceDialoguePlan,
  languageIndex: number,
  recentMessages: Array<{ role: string; content: string }> = [],
): string {
  // Customer-authored state can support a recap, never a merchant answer.
  const facts = contextualFacts(plan, languageIndex === 2 ? "en" : languageIndex === 1 ? "zh-CN" : "zh-TW");
  const target = plan.clarification_target;
  if (target && !["customer_goal", "specific_item_or_time"].includes(target) && !CONTEXTUAL_CUSTOMER_SLOTS.some(slot => slot.field === target) && labels[target]) return labels[target][languageIndex];
  const continuation = contextualContinuation(plan, languageIndex, recentMessages);
  return facts.length ? facts.join(languageIndex === 2 ? "; " : "；") + (languageIndex === 2 ? ". " : "。") + continuation : continuation;
}

export function renderServicePlanReply(
  plan: ServiceDialoguePlan,
  recallReply: string | null,
  recentMessages: Array<{ role: string; content: string }> = [],
): string | null {
  const l = planLanguageIndex(plan, recentMessages);
  if (plan.safe_assumptions.includes("query_context_limit")) return [
    "今次查詢未能完整保留所有必要條件，所以我未核實到適合的選項。可以先選最重要的要求逐項核對，或者選擇真人客服協助。",
    "本次查询无法完整保留所有必要条件，所以我尚未核实适合的选项。可以先选择最重要的要求逐项核对，或者选择人工客服协助。",
    "I couldn't check all the necessary requirements in one lookup, so I haven't verified a suitable option. We can check the most important requirement first, or you can choose human support.",
  ][l];
  if (["published_kb_lookup", "bounded_kb_refinement"].includes(plan.action)) return null;
  if (plan.action === "direct_answer") return recallReply;
  if (plan.action === "state_acknowledgement" && plan.committed_requirements?.length && plan.committed_commerce) {
    const details = plan.committed_requirements.map(e=>renderCanonicalRequirement(e,plan.language)).join(l===2?"; ":"；");
    const inactive = plan.committed_commerce.entities.filter(e=>["deferred","cancelled"].includes(e.status) && !plan.committed_requirements!.some(x=>x.entity_id===e.entity_id));
    const retained = inactive.length ? (l===2?"; ":"；")+inactive.map(e=>renderCanonicalRequirement(e,plan.language)).join(l===2?"; ":"；") : "";
    const prefix = ["今次要求已記錄：","本次要求已记录：","I've noted "][l];
    const hasBooking = plan.committed_commerce.entities.some(e=>!["deferred","cancelled"].includes(e.status) && typeof e.attributes.capabilities === "object" && e.attributes.capabilities && (e.attributes.capabilities as Record<string,unknown>).requires_booking === true);
    return prefix+details+retained+(l===2?".":"。")+(hasBooking?" "+renderRequirementQualification(plan.committed_commerce,plan.language):"");
  }

  if (
    ["targeted_clarification", "partial_answer_then_question"].includes(
      plan.action,
    ) &&
    (CONTEXTUAL_CUSTOMER_SLOTS.some(slot => slot.field === plan.clarification_target) || !plan.clarification_target ||
      ["customer_goal", "specific_item_or_time"].includes(
        plan.clarification_target,
      ))
  ) {
    return renderContextualServiceReply(plan, l, recentMessages);
  }
  if (plan.action === "customer_issue_next_step" && plan.issue_kind) {
    if (plan.issue_kind === "order_status_lookup") {
      const provided = [plan.customer_turn ?? "", ...recentMessages.filter(row=>/visitor|customer|user/.test(row.role)).map(row=>row.content)]
        .map(text=>text.match(/(?:訂單|订单|參考編號|参考编号|order|reference|ref)\s*(?:number|no\.?|#|:|：)?\s*([A-Z0-9][A-Z0-9-]{3,})/i)?.[1]).find(ref=>ref && /\d/.test(ref));
      return provided
        ? [
          `我記低咗參考編號 ${provided}；目前我未能讀取即時訂單狀態，呢個需要客服核對。`,
          `已记录参考编号 ${provided}；目前我无法读取实时订单状态，需要客服核对。`,
          `I have reference ${provided}. I cannot read the live order status here; support needs to check it.`,
        ][l]
        : ["可以幫你整理查詢；目前我未能讀取即時訂單狀態。你有訂單或參考編號嗎？", "可以帮你整理查询；目前我无法读取实时订单状态。你有订单或参考编号吗？", "I can help with the enquiry, but I cannot read the live order status here. What is the order or reference number?"][l];
    }
    if (plan.issue_kind === "product_operation_failure") {
      const models = exactProductIdentifiers(plan.customer_turn ?? "");
      const subject = models.length === 1 ? models[0] : null;
      return l === 2
        ? `I understand ${subject ? `${subject} ` : "the product "}does not turn on. Does it show any indicator light or error message when you try to start it?`
        : l === 1
        ? `你提到${subject ? ` ${subject} ` : "产品"}无法开机。尝试开机时有显示灯或错误提示吗？`
        : `你提到${subject ? ` ${subject} ` : "部機"}開唔到機。試開機時有冇燈號或錯誤提示？`;
    }
    const responses: Record<Exclude<ServiceIssueKind, "product_operation_failure" | "order_status_lookup">, [string, string, string]> = {
      account_access: [
        "我明白你遇到帳戶登入或重設問題。目前我看不到帳戶或電郵派送狀態；請先檢查垃圾郵件，並提供電郵網域（毋須提供完整地址或密碼），以便核對下一步。",
        "我明白你遇到账户登录或重置问题。目前我看不到账户或邮件发送状态；请先检查垃圾邮件，并提供邮箱域名（无需提供完整地址或密码），以便核对下一步。",
        "I understand the account-access or reset issue. I cannot see the live account or email-delivery status here. Please check spam/junk and share only the email domain—not the full address or password—so the next check can be narrowed down.",
      ],
      order_change: [
        "我明白你要更改或取消訂單。目前我不能核實或修改即時訂單；請提供訂單／參考編號及受影響項目，以便先確認仍可處理的範圍。現階段不會假設更改已生效。",
        "我明白你要更改或取消订单。目前我无法核实或修改实时订单；请提供订单／参考编号及受影响项目，以便先确认仍可处理的范围。现阶段不会假设更改已生效。",
        "I understand that you need to change or cancel an order. I cannot verify or alter the live order here. Please share the order/reference number and affected item(s) so the available options can be checked; I will not assume the change has taken effect.",
      ],
      refund_or_product_quality: [
        "很抱歉產品狀況不符合預期。目前我不能核實退款、退貨或訂單狀態；請提供訂單／參考編號，以及相關相片、到期日或缺漏資料。若涉及安全或過期問題，請先停止使用產品，等待核實。",
        "很抱歉产品状况不符合预期。目前我无法核实退款、退货或订单状态；请提供订单／参考编号，以及相关照片、到期日或缺漏资料。若涉及安全或过期问题，请先停止使用产品，等待核实。",
        "I’m sorry the product was not as expected. I cannot verify a refund, return, or live order status here. Please share the order/reference number plus any relevant photo, expiry date, or missing-item detail. If this may be a safety or expiry issue, stop using the product until it is checked.",
      ],
      delivery_or_collection: [
        "我明白送貨、取件或追蹤資料出現問題。目前我看不到即時物流狀態；請提供訂單／包裹參考編號及最新追蹤訊息或時間，以便核對下一步。我不會在未核實前假設已送達或已取消。",
        "我明白送货、取件或追踪资料出现问题。目前我看不到实时物流状态；请提供订单／包裹参考编号及最新追踪信息或时间，以便核对下一步。我不会在未核实前假设已送达或已取消。",
        "I understand there is a delivery, collection, or tracking problem. I cannot see the live shipment status here. Please share the order/parcel reference and latest tracking message or timestamp so the next step can be checked; I will not assume delivery or cancellation occurred.",
      ],
      stock_or_store_availability: [
        "我明白你想核對門市或商品供應。目前我未有可核實的即時庫存；請提供完整產品名稱／型號、門市或地區及所需日期，我再按該範圍核對。",
        "我明白你想核对门店或商品供应。目前我没有可核实的实时库存；请提供完整产品名称／型号、门店或地区及所需日期，我再按该范围核对。",
        "I understand that you want to check store or product availability. I do not have verified live stock here. Please share the exact product/model, store or region, and required date so that specific scope can be checked.",
      ],
      marketplace_or_product_support: [
        "我明白商品或第三方賣家交付內容與預期不符。目前我不能核實訂單或賣家處理狀態；請提供訂單／參考編號、商品型號及不符之處，以便核對可行的下一步。",
        "我明白商品或第三方卖家交付内容与预期不符。目前我无法核实订单或卖家处理状态；请提供订单／参考编号、商品型号及不符之处，以便核对可行的下一步。",
        "I understand that the product or third-party seller outcome did not match what was expected. I cannot verify the live order or seller action here. Please share the order/reference number, product model, and the specific mismatch so the available next step can be checked.",
      ],
      general_customer_issue: [
        "我明白你遇到客戶服務問題。目前我不能核實即時帳戶、訂單或處理狀態；請提供相關訂單／個案參考編號及受影響項目，以便核對下一步。我不會在未有證據前聲稱任何處理已完成。",
        "我明白你遇到客户服务问题。目前我无法核实实时账户、订单或处理状态；请提供相关订单／个案参考编号及受影响项目，以便核对下一步。我不会在没有证据前声称任何处理已完成。",
        "I understand the customer-service issue. I cannot verify the live account, order, or case status here. Please share the relevant order/case reference and affected item so the next step can be checked; I will not claim that any action has completed without evidence.",
      ],
    };
    return responses[plan.issue_kind][l];
  }
  if (plan.action === "historical_calculation" && plan.calculation) {
    const c = plan.calculation;
    const perUnit = c.terms.filter((term) => term.charge_basis === "per_unit");
    const perOrder = c.terms.filter((term) =>
      term.charge_basis === "per_order"
    );
    const money = (amount: number) => `${c.currency === "HKD" ? "HK$" : c.currency === "USD" ? "US$" : c.currency} ${formatMoney(amount)}`;
    const unitExpression = perUnit.some(term=>term.amount !== 0)
      ? `(${perUnit.map((term) => money(term.amount)).join(" + ")}) × ${c.quantity}`
      : "";
    const expression = [unitExpression,...perOrder.filter(term=>term.amount !== 0).map(term=>money(term.amount))]
      .filter(Boolean).join(" + ") || money(0);
    const equation = `${expression} = ${money(c.total)}`;
    return [
      `按你提供嘅歷史金額（每部收費 × 部數，另加每單收費，如有）：${equation}。呢個只係歷史條件試算，唔代表現行正式報價或現價。`,
      `按你提供并已标明收费单位的旧数字：${equation}。这只是历史条件试算，不是当前正式报价。`,
      `Using only the historical amounts with an explicit charge basis: ${equation}. This is a conditional historical calculation using your figures only, not a current merchant offer.`,
    ][l];
  }
  if (plan.action === "shorten_previous_answer") {
    // generate-reply supplies newest-first message rows.
    const prior = recentMessages.find((item) =>
      item.role === "assistant" && clean(item.content)
    );
    if (!prior) return null;
    const previous = clean(prior.content, 1600);
    const amounts = [...previous.matchAll(/(?:HKD\s*)?\d[\d,]{2,}/g)]
      .map((match) => match[0].replace(/^HKD\s*/i, ""))
      .filter((value, index, all) => all.indexOf(value) === index);
    if (amounts.length && /(?:歷史|历史|舊價|旧价|非現價|非现价|不是現行報價|不是当前报价)/i.test(previous)) {
      const compact = amounts.slice(0, 2).join("／");
      if (/訂單尚未確認/.test(previous) && /仍需核實/.test(previous)) {
        return `HKD ${compact} 不是現行報價；訂單尚未確認，工程費仍需核實。`;
      }
      return /再短|even shorter/i.test(plan.customer_turn ?? "")
        ? `${compact}：舊價，非現價。`
        : `${compact} 係你提供嘅歷史價，唔係已核實現價。`;
    }
    const sentences = previous.split(/(?<=[。！？.!?])\s*/)
      .filter(Boolean);
    const safety = sentences.filter((sentence) =>
      /(?:不|未|尚未|不能|不可|並非|并非|唔|冇|沒有|没有|仍需|待核|核實|核实|not|isn't|is not|cannot|can't|unconfirmed|pending|subject to|限制|假設|假设)/i
        .test(sentence)
    );
    const selected = [...new Set([sentences[0], ...safety])].filter(Boolean);
    return selected.join(" ").slice(0, 600);
  }
  if (plan.action === "current_state_checklist") {
    const statusLabels: Record<string, string[]> = {
      confirmed: ["已確認", "已确认", "confirmed"],
      provided: [
        "已提供，待最終確認",
        "已提供，待最终确认",
        "provided, awaiting final confirmation",
      ],
      draft: ["草擬中", "草拟中", "draft"],
      not_started: ["尚未建立", "尚未建立", "not created"],
    };
    const known = plan.known_facts.slice(0, 6).map((fact) =>
      `• ${fact.label}：${fact.value}（${
        statusLabels[fact.status]?.[l] ?? statusLabels.provided[l]
      }）`
    );
    const missing = plan.missing_slots.map((slot) =>
      `• ${labels[slot]?.[l] ?? labels.customer_goal[l]}`
    );
    const heading =
      ["付款／落單前清單", "付款／下单前清单", "Pre-payment checklist"][l];
    return [heading, ...known, ...missing].join("\n").slice(0, 1600);
  }
  return null;
}

function planLanguageIndex(
  plan: ServiceDialoguePlan,
  messages: Array<{ role: string; content: string }>,
): number {
  void messages;
  return plan.language === "en" ? 2 : plan.language === "zh-CN" ? 1 : 0;
}

export function renderTargetedServiceQuestion(
  plan: ServiceDialoguePlan,
  language: ServiceLanguage,
): string {
  const l = language === "en" ? 2 : language === "zh-CN" ? 1 : 0;
  if (plan.action === "explicit_handoff") {
    return [
      "收到你想聯絡真人客服的要求；目前尚未完成交接，請等候系統確認。",
      "收到你想联系人工客服的要求；目前尚未完成交接，请等候系统确认。",
      "I understand that you want human support. The handoff is not complete yet; please wait for the system confirmation.",
    ][l];
  }
  if (plan.action === "offer_handoff_or_reframe") {
    return [
      "目前未有新的關鍵資料，我不想重複問同一問題。你可以提供更具體的型號／項目，或選擇由真人客服接手；目前尚未執行轉交。",
      "目前没有新的关键资料，我不想重复问同一问题。你可以提供更具体的型号／项目，或选择由人工客服接手；目前尚未执行转交。",
      "We still do not have a new decision-making detail, so I will not repeat the same question. You can share the specific model or item, or choose human support; no handoff has been performed yet.",
    ][l];
  }
  const target = plan.clarification_target ?? plan.missing_slots[0] ??
    "customer_goal";
  const question = labels[target]?.[l] ?? labels.customer_goal[l];
  const empathy = plan.emotion_trace?.kind &&
      /(?:frustrat|angry|disappoint|失望|憤怒|愤怒)/i.test(
        plan.emotion_trace.kind,
      )
    ? [
      "我明白這個情況令人失望。",
      "我明白这个情况令人失望。",
      "I understand that this situation is frustrating.",
    ][l]
    : "";
  return `${empathy}${empathy ? " " : ""}${question}`;
}

export function applyServiceTone(
  plan: ServiceDialoguePlan,
  reply: string | null,
): string | null {
  if (
    !reply || !plan.emotion_trace?.kind ||
    !/(?:frustrat|angry|disappoint|失望|憤怒|愤怒)/i.test(
      plan.emotion_trace.kind,
    )
  ) return reply;
  const prefix = plan.language === "en"
    ? "I understand that this situation is frustrating. "
    : plan.language === "zh-CN"
    ? "我明白这个情况令人失望。 "
    : "我明白這個情況令人失望。 ";
  return reply.startsWith(prefix.trim()) ? reply : `${prefix}${reply}`;
}

export function renderServiceRecovery(
  plan: ServiceDialoguePlan,
  state: "no_match" | "tool_failure" | "conflict",
  language: ServiceLanguage,
): string {
  const l = language === "en" ? 2 : language === "zh-CN" ? 1 : 0;
  if (state === "conflict") {
    return [
      "我找到針對同一項目及適用範圍、但內容相反的現行資料。請告訴我要以哪個型號、地區或日期核對；我不會自行選一項當答案。",
      "我找到针对同一项目及适用范围、但内容相反的当前资料。请告诉我要以哪个型号、地区或日期核对；我不会自行选择一项作为答案。",
      "I found opposing current evidence for the same item and scope. Please specify the model, region, or date to verify; I will not choose one without evidence.",
    ][l];
  }
  if (state === "tool_failure") {
    return [
      "查詢工具目前未能完成，所以我不能核實商家的最新資料；本次沒有進行資料寫入或真人交接。你可以稍後再試，或選擇由真人客服接手。",
      "查询工具目前未能完成，所以我无法核实商家的最新资料；本次没有进行资料写入或人工交接。你可以稍后再试，或选择由人工客服接手。",
      "The lookup tool did not complete, so I cannot verify the merchant's latest information or claim that anything was saved or handed off. You can retry later or choose human support; no handoff has been performed yet.",
    ][l];
  }
  if (
    plan.action === "bounded_kb_refinement" ||
    plan.clarification_previously_asked
  ) {
    return [
      "這次知識庫查詢沒有返回可核實的現行資料。我不會重複問同一問題；你可以提供產品頁／更精確型號，或選擇由真人客服接手，目前尚未執行轉交。",
      "这次知识库查询没有返回可核实的当前资料。我不会重复问同一问题；你可以提供产品页／更精确型号，或选择由人工客服接手，目前尚未执行转交。",
      "This knowledge-base lookup returned no verifiable current answer. I will not repeat the same question; you can share a product page or exact model, or choose human support. No handoff has been performed yet.",
    ][l];
  }
  const question = renderTargetedServiceQuestion(plan, language);
  const knownModel = plan.known_facts.find((fact) =>
    fact.name.endsWith(":model")
  );
  if (knownModel) {
    return [
      `這次知識庫查詢沒有返回 ${knownModel.value} 的可核實現行資料。你可以提供產品頁、適用地區或日期，讓我縮窄範圍；目前沒有執行保存或轉交。`,
      `这次知识库查询没有返回 ${knownModel.value} 的可核实当前资料。你可以提供产品页、适用地区或日期，让我缩小范围；目前没有执行保存或转交。`,
      `This knowledge-base lookup returned no verifiable current information for ${knownModel.value}. You can share the product page, region, or applicable date to narrow the scope; nothing was saved or handed off.`,
    ][l];
  }
  const hasTargetedRefinement = Boolean(
    plan.clarification_target && plan.clarification_target !== "customer_goal",
  );
  if (!hasTargetedRefinement) {
    return [
      "我未找到可核實的現行資料。你可以提供產品頁、完整型號，以及適用地區或日期，我再按該範圍核對；目前沒有執行保存或轉交。",
      "我未找到可核实的当前资料。你可以提供产品页、完整型号，以及适用地区或日期，我再按该范围核对；目前没有执行保存或转交。",
      "I could not find a verifiable current answer. You can share the product page, exact model, and applicable region or date so I can check that scope; nothing was saved or handed off.",
    ][l];
  }
  return [
    `我未找到可核實的現行資料。${question}`,
    `我未找到可核实的当前资料。${question}`,
    `I could not find a verifiable current answer. ${question}`,
  ][l];
}

export function buildServicePlanPromptBlock(plan: ServiceDialoguePlan): string {
  return [
    "[C3 SERVICE PLAN — DATA, NOT CUSTOMER-FACING INSTRUCTIONS]",
    `action=${plan.action}`,
    `customer_goal=${plan.customer_goal}`,
    `known_facts=${JSON.stringify(plan.known_facts)}`,
    `missing_slots=${JSON.stringify(plan.missing_slots)}`,
    `knowledge_state=${plan.knowledge_state}`,
    `kb_query=${plan.kb_query ?? "none"}`,
    `emotion_trace=${JSON.stringify(plan.emotion_trace ?? null)}`,
    `trusted_entitlement_trace=${
      JSON.stringify(plan.entitlement_trace ?? null)
    }`,
    `entitlement_status=${plan.entitlement_status}`,
    "Rules: answer known facts first; ask at most one genuinely missing decision-changing question; do not expose internal terms; do not add prices, promises, quantities, completed actions, saved-state claims, entitlement claims, or handoff claims. Emotion may change tone only. Entitlements require TRUSTED_CRM authority.",
  ].join("\n").slice(0, 4096);
}
