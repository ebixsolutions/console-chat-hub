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
  | "offer_handoff_or_reframe"
  | "explicit_handoff";

export interface ServiceRecallDecision {
  handled: boolean;
  reason?: "CURRENT_KB_REQUIRED" | "AMBIGUOUS" | "NOT_A_RECALL_QUERY";
  detail?: string;
  fact_type?: string;
  value?: unknown;
}

export interface ServiceDialoguePlan {
  version: "c3-service-plan-1.0.0";
  language: ServiceLanguage;
  action: ServiceDialogueAction;
  customer_goal: string;
  known_facts: Array<{ name: string; value: string; authority: string }>;
  missing_slots: string[];
  clarification_target: string | null;
  clarification_previously_asked: boolean;
  knowledge_state: ServiceKnowledgeState;
  kb_query: string | null;
  handoff_requested: boolean;
  safe_assumptions: string[];
  calculation?: {
    operands: number[];
    quantity: number;
    per_unit_total: number;
    total: number;
    currency: "HKD";
    historical_only: true;
  };
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
}

const clean = (value: unknown, limit = 180) =>
  Array.from(String(value ?? ""), (character) =>
    character.charCodeAt(0) < 32 ? " " : character
  ).join("").replace(/\s+/g, " ").trim().slice(0, limit);
const has = (text: string, values: string[]) =>
  values.some((value) => text.toLocaleLowerCase().includes(value.toLocaleLowerCase()));

function knownFacts(input: ServicePlanInput) {
  const facts: ServiceDialoguePlan["known_facts"] = [];
  const add = (name: string, value: unknown, authority: string) => {
    const rendered = clean(value);
    if (rendered && !facts.some((item) => item.name === name && item.value === rendered)) {
      facts.push({ name, value: rendered, authority });
    }
  };
  const state = input.commerce;
  if (state) {
    add("current_intent", state.current_intent, "CANONICAL_COMMERCE_STATE");
    add("current_topic", state.current_topic, "CANONICAL_COMMERCE_STATE");
    add("delivery_address", state.delivery.address, "CANONICAL_COMMERCE_STATE");
    add("recipient_name", state.delivery.recipient_name, "CANONICAL_COMMERCE_STATE");
    add("delivery_preference", state.delivery.preferred_date, "CUSTOMER_PREFERENCE");
    add("quotation_status", state.conversion.quotation_status, "CANONICAL_COMMERCE_STATE");
    add("order_status", state.conversion.order_status, "CANONICAL_COMMERCE_STATE");
    for (const entity of state.entities.filter((item) => !["cancelled", "deferred"].includes(item.status))) {
      add(`entity:${entity.entity_id}:quantity`, entity.quantity, "CANONICAL_COMMERCE_STATE");
      add(`entity:${entity.entity_id}:model`, entity.attributes.model, "CUSTOMER_PROVIDED");
      add(`entity:${entity.entity_id}:room_size`, entity.attributes.room_size, "CUSTOMER_PROVIDED");
      add(`entity:${entity.entity_id}:horsepower`, entity.attributes.horsepower, "CUSTOMER_REQUIREMENT");
    }
  }
  if (input.memory) {
    add("customer_goal", input.memory.current_goal, "CURRENT_CUSTOMER_MEMORY");
    add("current_topic", input.memory.current_topic, "CURRENT_CUSTOMER_MEMORY");
    for (const preference of input.memory.customer_preferences) {
      add("customer_preference", preference, "CURRENT_CUSTOMER_MEMORY");
    }
    for (const constraint of input.memory.active_constraints) {
      add("customer_constraint", constraint, "CURRENT_CUSTOMER_MEMORY");
    }
  }
  return facts.slice(0, 12);
}

function historicalCalculation(question: string): ServiceDialoguePlan["calculation"] | null {
  if (!has(question, ["試算", "试算", "假設", "假设", "舊", "旧", "historical", "estimate"])) return null;
  const numbers = (question.match(/(?:HKD|HK\$|\$)?\s*\d[\d,]*(?:\.\d+)?/gi) ?? [])
    .map((value) => Number(value.replace(/[^\d.]/g, "")))
    .filter((value) => Number.isFinite(value) && value > 0);
  const quantityMatch = question.match(/(?:×|x|乘|共|合共|total\s+for)\s*(\d+)|(?:兩|两|2)\s*(?:部|件|台|units?)/i);
  const quantity = quantityMatch?.[1] ? Number(quantityMatch[1]) : quantityMatch ? 2 : 1;
  const operands = numbers.filter((value, index) => !(quantity > 1 && index === numbers.length - 1 && value === quantity));
  if (operands.length < 2) return null;
  const perUnit = operands.reduce((sum, value) => sum + value, 0);
  return {
    operands,
    quantity,
    per_unit_total: perUnit,
    total: perUnit * quantity,
    currency: "HKD",
    historical_only: true,
  };
}

function requestedSlot(question: string): string | null {
  const slots: Array<[string, string[]]> = [
    ["model_or_product_link", ["型號", "型号", "model", "產品頁", "产品页", "product link"]],
    ["budget_range", ["預算", "预算", "budget"]],
    ["room_size_or_dimensions", ["面積", "面积", "尺寸", "room size", "dimensions"]],
    ["intended_use", ["用途", "使用情況", "使用情况", "intended use"]],
    ["region", ["地區", "地区", "region", "market"]],
    ["applicable_date", ["日期", "幾時", "何时", "date", "when"]],
  ];
  return slots.find(([, words]) => has(question, words))?.[0] ?? null;
}

function buildKbQuery(question: string, input: ServicePlanInput): string {
  const parts = [
    input.commerce?.current_topic,
    ...((input.commerce?.entities ?? []).filter((item) => !["cancelled", "deferred"].includes(item.status)).map((item) =>
      [item.attributes.model, item.attributes.name, item.category].filter(Boolean).join(" ")
    )),
    question,
  ].map((value) => clean(value, 160)).filter(Boolean);
  return [...new Set(parts)].join(" ").slice(0, 500);
}

export function planConversationService(input: ServicePlanInput): ServiceDialoguePlan {
  const question = clean(input.question, 2400);
  const facts = knownFacts(input);
  const clarificationTarget = requestedSlot(question);
  const repeated = (input.clarification_attempts ?? 0) >= 2 || input.exact_same_intent_repeated === true;
  const base = {
    version: "c3-service-plan-1.0.0" as const,
    language: input.language,
    customer_goal: clean(input.memory?.current_goal || input.commerce?.current_intent || question, 240),
    known_facts: facts,
    missing_slots: [] as string[],
    clarification_target: null as string | null,
    clarification_previously_asked: (input.clarification_attempts ?? 0) > 0,
    knowledge_state: "not_needed" as ServiceKnowledgeState,
    kb_query: null as string | null,
    handoff_requested: input.explicit_handoff === true,
    safe_assumptions: [] as string[],
  };
  if (input.explicit_handoff) return { ...base, action: "explicit_handoff" };

  const calculation = historicalCalculation(question);
  if (calculation) {
    return {
      ...base,
      action: "historical_calculation",
      calculation,
      safe_assumptions: ["customer_provided_historical_amounts", "per_unit_unless_customer_confirms_otherwise"],
    };
  }
  if (has(question, ["短啲", "短一點", "短一点", "shorten", "more concise"])) {
    return { ...base, action: "shorten_previous_answer" };
  }
  if (has(question, ["checklist", "清單", "清单", "付款前", "落單前", "下单前"])) {
    return { ...base, action: "current_state_checklist" };
  }
  if (input.recall.handled) return { ...base, action: "direct_answer" };
  if (input.recall.reason === "CURRENT_KB_REQUIRED") {
    return {
      ...base,
      action: repeated ? "bounded_kb_refinement" : "published_kb_lookup",
      knowledge_state: "lookup_required",
      kb_query: buildKbQuery(question, input),
      clarification_target: clarificationTarget,
      missing_slots: clarificationTarget ? [clarificationTarget] : [],
    };
  }
  if (input.recall.reason === "AMBIGUOUS") {
    const target = input.recall.detail === "ENTITY_REFERENCE_AMBIGUOUS"
      ? "specific_product_or_item"
      : clarificationTarget ?? "specific_item_or_time";
    return {
      ...base,
      action: repeated ? "offer_handoff_or_reframe" : facts.length ? "partial_answer_then_question" : "targeted_clarification",
      missing_slots: [target],
      clarification_target: target,
    };
  }
  const target = clarificationTarget ?? "customer_goal";
  return {
    ...base,
    action: repeated ? "offer_handoff_or_reframe" : facts.length ? "partial_answer_then_question" : "targeted_clarification",
    missing_slots: [target],
    clarification_target: target,
  };
}

const formatMoney = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const labels: Record<string, [string, string, string]> = {
  specific_product_or_item: ["你指的是哪一件產品或哪個項目？", "你指的是哪一件产品或哪个项目？", "Which product or item do you mean?"],
  specific_item_or_time: ["你想核對哪個項目或哪個時間點？", "你想核对哪个项目或哪个时间点？", "Which item or point in time should I check?"],
  model_or_product_link: ["請提供型號或產品頁。", "请提供型号或产品页。", "Please share the model or product page."],
  budget_range: ["你的預算範圍是多少？", "你的预算范围是多少？", "What budget range should I use?"],
  room_size_or_dimensions: ["請提供使用位置的面積或尺寸。", "请提供使用位置的面积或尺寸。", "What is the room size or relevant dimensions?"],
  intended_use: ["主要用途是甚麼？", "主要用途是什么？", "What is the main intended use?"],
  region: ["這項查詢適用哪個地區？", "这项查询适用哪个地区？", "Which region does this apply to?"],
  applicable_date: ["你要核對哪個日期的資料？", "你要核对哪个日期的资料？", "Which date should I check?"],
  customer_goal: ["你今次最想完成哪一件事？", "你这次最想完成哪一件事？", "What would you most like to complete now?"],
};

export function renderServicePlanReply(
  plan: ServiceDialoguePlan,
  recallReply: string | null,
  recentMessages: Array<{ role: string; content: string }> = [],
): string | null {
  const l = planLanguageIndex(plan, recentMessages);
  if (plan.action === "direct_answer") return recallReply;
  if (plan.action === "historical_calculation" && plan.calculation) {
    const c = plan.calculation;
    const expression = `(${c.operands.map(formatMoney).join(" + ")}) × ${c.quantity} = HKD ${formatMoney(c.total)}`;
    return [
      `按你提供的舊數字，假設各項都是每部收費：${expression}。這只是歷史條件試算，不是現行正式報價；如有項目是整單收費，總額會不同。`,
      `按你提供的旧数字，假设各项都是每台收费：${expression}。这只是历史条件试算，不是当前正式报价；如有项目是整单收费，总额会不同。`,
      `Using your historical figures and assuming every item is charged per unit: ${expression}. This is a conditional historical calculation, not a current quotation; the total changes if any item is charged once per order.`,
    ][l];
  }
  if (plan.action === "shorten_previous_answer") {
    const prior = [...recentMessages].reverse().find((item) => item.role === "assistant" && clean(item.content));
    if (!prior) return null;
    const sentences = clean(prior.content, 1200).split(/(?<=[。！？.!?])\s*/).filter(Boolean).slice(0, 2);
    return sentences.join(" ").slice(0, 360);
  }
  if (plan.action === "current_state_checklist") {
    const known = plan.known_facts.slice(0, 6).map((fact) => `✓ ${fact.name}: ${fact.value}`);
    const missing = plan.missing_slots.map((slot) => `□ ${slot}`);
    const heading = ["付款／落單前清單", "付款／下单前清单", "Pre-payment checklist"][l];
    return [heading, ...known, ...missing].join("\n").slice(0, 1600);
  }
  return null;
}

function planLanguageIndex(plan: ServiceDialoguePlan, messages: Array<{ role: string; content: string }>): number {
  void messages;
  return plan.language === "en" ? 2 : plan.language === "zh-CN" ? 1 : 0;
}

export function renderTargetedServiceQuestion(plan: ServiceDialoguePlan, language: ServiceLanguage): string {
  const l = language === "en" ? 2 : language === "zh-CN" ? 1 : 0;
  if (plan.action === "offer_handoff_or_reframe") {
    return [
      "目前未有新的關鍵資料，我不想重複問同一問題。你可以提供更具體的型號／項目，或選擇由真人客服接手；目前尚未執行轉交。",
      "目前没有新的关键资料，我不想重复问同一问题。你可以提供更具体的型号／项目，或选择由人工客服接手；目前尚未执行转交。",
      "We still do not have a new decision-making detail, so I will not repeat the same question. You can share the specific model or item, or choose human support; no handoff has been performed yet.",
    ][l];
  }
  const target = plan.clarification_target ?? plan.missing_slots[0] ?? "customer_goal";
  const question = labels[target]?.[l] ?? labels.customer_goal[l];
  const prefix = plan.known_facts.length
    ? ["我已保留你之前提供的資料。", "我已保留你之前提供的资料。", "I have kept the information you already provided."][l]
    : "";
  return `${prefix}${prefix ? " " : ""}${question}`;
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
      "我已保留你提供的內容，但目前未能核實商家的最新資料。你可以稍後再查，或選擇由真人客服接手；目前尚未執行轉交。",
      "我已保留你提供的内容，但目前无法核实商家的最新资料。你可以稍后再查，或选择由人工客服接手；目前尚未执行转交。",
      "I have kept what you provided, but I cannot verify the merchant's latest information right now. You can retry later or choose human support; no handoff has been performed yet.",
    ][l];
  }
  if (plan.action === "bounded_kb_refinement" || plan.clarification_previously_asked) {
    return [
      "我已按現有型號、地區及問題查過，但未找到可核實的現行資料。我不會重複問同一問題；你可以提供產品頁／更精確型號，或選擇由真人客服接手，目前尚未執行轉交。",
      "我已按现有型号、地区及问题查过，但未找到可核实的当前资料。我不会重复问同一问题；你可以提供产品页／更精确型号，或选择由人工客服接手，目前尚未执行转交。",
      "I checked using the known model, region, and question but found no verifiable current answer. I will not repeat the same question; you can share a product page or exact model, or choose human support. No handoff has been performed yet.",
    ][l];
  }
  const question = renderTargetedServiceQuestion(plan, language);
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
    "Rules: answer known facts first; ask at most one decision-changing question; do not expose internal terms; do not add prices, promises, quantities, completed actions, or handoff claims.",
  ].join("\n").slice(0, 4096);
}
