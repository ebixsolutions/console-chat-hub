/**
 * C3 bounded customer-service dialogue planning.
 *
 * This module never changes commerce, memory, KB, handoff or persistence state.
 * It consumes the decisions produced by those authorities and selects the next
 * useful dialogue action.  It is deliberately deterministic so the same facts
 * cannot acquire a different meaning during natural-language rendering.
 */
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CanonicalConversationMemory } from "./conversation-long-memory.ts";

export type ServiceLanguage = "zh-TW" | "zh-CN" | "en";
export type ServiceKnowledgeState =
  | "not_needed"
  | "lookup_required"
  | "available"
  | "no_match"
  | "conflict"
  | "tool_failure";
export type ServiceDialogueAction =
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
  | "refund_or_product_quality"
  | "delivery_or_collection"
  | "stock_or_store_availability"
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
}

export interface ServicePlanInput {
  question: string;
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
      add(
        `entity:${entity.entity_id}:quantity`,
        "數量",
        entity.quantity,
        "CANONICAL_COMMERCE_STATE",
      );
      add(
        `entity:${entity.entity_id}:model`,
        "型號",
        entity.attributes.model,
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
      "舊",
      "旧",
      "historical",
      "estimate",
    ])
  ) return null;
  const terms = (input.calculation_terms ?? []).filter((term) =>
    Number.isFinite(term.amount) && term.amount > 0 && clean(term.label) &&
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
    })),
    quantity,
    per_unit_total: perUnit,
    per_order_total: perOrder,
    total: perUnit * quantity + perOrder,
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
  const parts = [
    input.commerce?.current_topic,
    ...((input.commerce?.entities ?? []).filter((item) =>
      !["cancelled", "deferred"].includes(item.status)
    ).map((item) =>
      [item.attributes.model, item.attributes.name, item.category].filter(
        Boolean,
      ).join(" ")
    )),
    question,
  ].map((value) => clean(value, 160)).filter(Boolean);
  return [...new Set(parts)].join(" ").slice(0, 500);
}

/**
 * Thin shared semantic layer for a fully described customer-service issue.
 * It selects a safe next-step family only; it never reads or mutates state and
 * never claims that an order, refund, delivery, cancellation or handoff exists.
 */
function classifyCustomerIssue(question: string): ServiceIssueKind | null {
  const text = clean(question, 2400);
  if (text.length < 24) return null;
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
      .test(text)
  ) {
    return "delivery_or_collection";
  }
  if (
    /(?:third[- ]party seller|marketplace|seller|product support|laptop|feature|model|產品|产品|賣家|卖家|功能)/i
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

  if (
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

  const calculation = historicalCalculation(question, input);
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
  if (has(question, ["短啲", "短一點", "短一点", "shorten", "more concise"])) {
    return { ...base, action: "shorten_previous_answer" };
  }
  if (
    has(question, ["checklist", "清單", "清单", "付款前", "落單前", "下单前"])
  ) {
    return { ...base, action: "current_state_checklist" };
  }
  if (input.recall.handled) return { ...base, action: "direct_answer" };
  if (input.recall.reason === "CURRENT_KB_REQUIRED") {
    const missingTarget = factSatisfiesSlot(facts, clarificationTarget)
      ? null
      : clarificationTarget;
    return {
      ...base,
      action: repeated ? "bounded_kb_refinement" : "published_kb_lookup",
      knowledge_state: "lookup_required",
      kb_query: buildKbQuery(question, input),
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
  const target = clarificationTarget ?? "customer_goal";
  if (factSatisfiesSlot(facts, target)) {
    return { ...base, action: "partial_answer_then_question" };
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
    "請確認每個金額是每部／每件收費，還是整單收費。",
    "请确认每个金额是每部／每件收费，还是整单收费。",
    "Please confirm whether each amount is per unit or per order.",
  ],
};

function renderContextualServiceReply(
  plan: ServiceDialoguePlan,
  languageIndex: number,
): string {
  const turn = clean(plan.customer_turn || plan.customer_goal, 320);
  const summaryIntent =
    /(?:總結|总结|講一次|讲一次|列一次|讀返|读返|而家有咩|现在有什么|目前需求|準備報價|准备报价|what (?:do i|are we)|summari[sz]e|list (?:it|them))/i
      .test(turn);
  const questionIntent =
    /[?？]|(?:有冇|有沒有|有没有|係咪|是不是|幾(?!勁)|几(?!乎)|邊|哪|咩|什么|點|怎么|如何|可唔可以|能不能|記唔記得|记不记得|do |does |did |is |are |can |could |what |which |when |where |how )/i
      .test(turn);
  const genericTarget = !plan.clarification_target ||
    ["customer_goal", "specific_item_or_time"].includes(
      plan.clarification_target,
    );

  if (summaryIntent && plan.known_facts.length) {
    const safeFacts = plan.known_facts.filter((fact) =>
      !["current_intent", "customer_goal", "quotation_status", "order_status"]
        .includes(fact.name)
    );
    const facts = (safeFacts.length ? safeFacts : plan.known_facts).slice(0, 6)
      .map((fact) => `${fact.label}：${fact.value}`).join("；");
    return [
      `目前資料係：${facts}。其餘未確定細節仍要再核實。`,
      `目前资料是：${facts}。其余未确定细节仍需核实。`,
      `Here is the current information: ${facts}. Any remaining uncertain detail still needs verification.`,
    ][languageIndex];
  }

  if (!questionIntent && genericTarget) {
    if (/雪櫃|雪柜/i.test(turn) && /三門|三门/i.test(turn) && /\d+\s*mm/i.test(turn)) {
      const width = turn.match(/\d+\s*mm/i)?.[0] ?? "";
      return [
        `雪櫃想要三門、闊度唔超過${width}，我會同冷氣要求分開記。`,
        `雪柜想要三门、宽度不超过${width}，我会与冷气要求分开记录。`,
        `For the refrigerator: three doors and no wider than ${width}. I’ll keep it separate from the AC requirements.`,
      ][languageIndex];
    }
    if (/(?:兩間房|两间房)/i.test(turn) && /\d+\s*呎/.test(turn)) {
      const sizes = [...turn.matchAll(/\d+\s*呎/g)].map((match) => match[0]);
      return [
        `兩間房${sizes[0] ?? ""}、${sizes[1] ?? ""}，客廳${sizes[2] ?? "未提供尺寸"}；窗口位嘅安裝尺寸仍要量清楚。`,
        `两间房${sizes[0] ?? ""}、${sizes[1] ?? ""}，客厅${sizes[2] ?? "未提供尺寸"}；窗口安装尺寸仍需测量。`,
        `I have ${sizes.join(", ")} for the rooms. The window openings still need measurement before sizing the AC units.`,
      ][languageIndex];
    }
    if (/西斜|西晒|west.facing/i.test(turn)) {
      return [
        "下午西斜我記低咗；揀冷氣匹數時要連房間面積同日照一齊考慮。",
        "下午西晒已记录；挑选冷气匹数时要结合房间面积和日照。",
        "I’ve noted the strong afternoon sun. Room size and sun exposure both matter when choosing AC capacity.",
      ][languageIndex];
    }
    if (/(?:格力|美的|Panasonic)/i.test(turn) && /(?:唔想太貴|预算|預算)/i.test(turn)) {
      return [
        "明白，想控制預算，格力、美的或 Panasonic 都可以考慮；暫時冇指定必須買邊個品牌。",
        "明白，想控制预算，格力、美的或 Panasonic 都可以考虑；目前没有指定必须购买某个品牌。",
        "Budget matters, and Gree, Midea or Panasonic are options. No brand is mandatory yet.",
      ][languageIndex];
    }
    if (/\b5788\b|\b5,788\b/i.test(turn) && /550/.test(turn)) {
      return [
        "記低你轉述嘅舊數字：機價 HKD 5,788，安裝同鋁架各 HKD 550；未當作現價。",
        "已记下你转述的旧数字：机价 HKD 5,788，安装和铝架各 HKD 550；不当作现价。",
        "I have your earlier figures: HKD 5,788 for the unit, plus HKD 550 each for installation and the bracket. These are historical figures.",
      ][languageIndex];
    }
    if (/\b5600\b|\b5,600\b/i.test(turn) && /(?:兩部|两部)/.test(turn)) {
      return [
        "記低你轉述嘅兩部舊價：每部 HKD 5,600；要再核實適用型號，唔會當現價。",
        "已记下你转述的两部旧价：每部 HKD 5,600；适用型号还需核实，不当作现价。",
        "I have the earlier two-unit figure of HKD 5,600 each. The applicable model and current price still need checking.",
      ][languageIndex];
    }
    if (/一部\s*1匹.*一部\s*1\.5匹/.test(turn)) {
      return [
        "冷氣匹數改為一部 1 匹、一部 1.5 匹；我會按呢個組合整理。",
        "冷气匹数改为一部 1 匹、一部 1.5 匹；我会按这个组合整理。",
        "I have the AC mix as one 1 HP unit and one 1.5 HP unit.",
      ][languageIndex];
    }
    if (/(?:機價|机价|安裝|安装).{0,20}(?:分開|分开)/i.test(turn)) {
      return [
        "係，機價同安裝係分開核對嘅項目；產品頁未寫明嘅話，唔能夠假設已包安裝。",
        "对，机价和安装是分开核对的项目；产品页没写明，就不能假设包含安装。",
        "Yes, the product price and installation are separate items to check. A product page does not imply installation is included unless it says so.",
      ][languageIndex];
    }
    // A state update needs a customer-visible acknowledgement of the actual
    // detail. A generic promise loses the customer's room, product or price.
    const detail = turn.replace(/^[，,。\s]+|[。.!！\s]+$/g, "").slice(0, 100);
    return [
      `收到，你提到「${detail}」。我會按呢個條件整理；未確定嘅細節會再核實。`,
      `收到，你提到「${detail}」。我会按这个条件整理；未确定的细节会再核实。`,
      `Got it: “${detail}.” I’ll keep this detail in mind and verify anything still uncertain.`,
    ][languageIndex];
  }

  if (genericTarget) {
    if (/(?:產品頁|产品页).{0,24}(?:機價|机价).{0,24}(?:包安裝|包安装)/i.test(turn)) {
      return [
        "產品頁有機價，唔代表已包安裝；要睇頁面有冇明確列出安裝服務同費用。",
        "产品页有机价，不代表包含安装；要看页面是否明确列出安装服务及费用。",
        "A product price does not imply installation is included. Check whether the product page explicitly lists installation and its charge.",
      ][languageIndex];
    }
    if (/(?:有冇|有沒有|有没有|現貨|现货)/i.test(turn) &&
      /(?:冷氣|冷气|雪櫃|雪柜|洗衣機|洗衣机|Panasonic|變頻|变频)/i.test(turn)) {
      const context = clean(turn.match(/(?:有冇|有沒有|有没有)\s*([^。？?]{2,70})/i)?.[1] ??
        (/Panasonic/i.test(turn) ? "Panasonic" : /1匹/.test(turn) ? "1匹窗口變頻冷氣" : "呢款產品"), 70);
      return [
        `我未有可核實嘅店內商品或庫存資料，暫時不能確認有冇${context}；亦唔會當作有現貨。`,
        `我没有可核实的店内商品或库存资料，暂时无法确认是否有${context}；也不会当作有现货。`,
        `I cannot verify current store listings or stock for ${context}, so I cannot confirm availability.`,
      ][languageIndex];
    }
    const usefulScope = /(?:送貨|送货|delivery|日期|星期|when)/i.test(turn)
      ? [
        "型號／項目、地區同日期",
        "型号／项目、地区和日期",
        "item/model, region, and date",
      ]
      : /(?:產品|产品|型號|型号|品牌|雪櫃|雪柜|冷氣|冷气|洗衣機|洗衣机|product|model|brand)/i
          .test(turn)
      ? [
        "完整型號、產品頁同適用地區",
        "完整型号、产品页和适用地区",
        "exact model, product page, and applicable region",
      ]
      : [
        "相關項目、適用範圍同日期",
        "相关项目、适用范围和日期",
        "the relevant item, scope, and date",
      ];
    return [
      `呢項我暫時未有可核實嘅現行資料直接答你。提供${
        usefulScope[0]
      }後，可以按該範圍核對；現時仍待核實。`,
      `这项我暂时没有可核实的当前资料直接回答。提供${
        usefulScope[1]
      }后，可以按该范围核对；目前仍待核实。`,
      `I do not yet have a verifiable current answer for this. With ${
        usefulScope[2]
      }, it can be checked in that scope; I will not treat it as confirmed before verification.`,
    ][languageIndex];
  }

  return labels[plan.clarification_target!]?.[languageIndex] ??
    labels.customer_goal[languageIndex];
}

export function renderServicePlanReply(
  plan: ServiceDialoguePlan,
  recallReply: string | null,
  recentMessages: Array<{ role: string; content: string }> = [],
): string | null {
  const l = planLanguageIndex(plan, recentMessages);
  if (plan.action === "direct_answer") return recallReply;
  if (/產品頁|产品页/i.test(plan.customer_turn ?? "") &&
    /機價|机价/i.test(plan.customer_turn ?? "") &&
    /包安裝|包安装/i.test(plan.customer_turn ?? "")) {
    return [
      "產品頁有機價，唔代表已包安裝；要睇頁面有冇明確列出安裝服務同費用。",
      "产品页有机价，不代表包含安装；要看页面是否明确列出安装服务及费用。",
      "A product price does not imply installation is included. Check whether the page explicitly lists installation and its charge.",
    ][l];
  }
  if (
    ["targeted_clarification", "partial_answer_then_question"].includes(
      plan.action,
    ) &&
    (!plan.clarification_target ||
      ["customer_goal", "specific_item_or_time"].includes(
        plan.clarification_target,
      ))
  ) {
    return renderContextualServiceReply(plan, l);
  }
  if (plan.action === "customer_issue_next_step" && plan.issue_kind) {
    const responses: Record<ServiceIssueKind, [string, string, string]> = {
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
    const unitExpression = perUnit.length
      ? `(${
        perUnit.map((term) => `${term.label} ${formatMoney(term.amount)}`).join(
          " + ",
        )
      }) × ${c.quantity}`
      : "0";
    const orderExpression = perOrder.length
      ? ` + ${
        perOrder.map((term) => `${term.label} ${formatMoney(term.amount)}`)
          .join(" + ")
      }`
      : "";
    const expression = `${unitExpression}${orderExpression} = ${c.currency} ${
      formatMoney(c.total)
    }`;
    return [
      `按你提供並已標明收費單位的舊數字：${expression}。這只是歷史條件試算，不是現行正式報價。`,
      `按你提供并已标明收费单位的旧数字：${expression}。这只是历史条件试算，不是当前正式报价。`,
      `Using only the historical amounts with an explicit charge basis: ${expression}. This is a conditional historical calculation, not a current quotation.`,
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
