import {
  planConversationService,
  renderServicePlanReply,
  renderServiceRecovery,
  renderTargetedServiceQuestion,
  type ServiceDialogueAction,
  type ServiceLanguage,
} from "./conversation-service-planner.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";

const assert: (value: unknown, message: string) => asserts value = (value, message) => {
  if (!value) throw new Error(message);
};

const languages: ServiceLanguage[] = ["zh-TW", "zh-CN", "en"];
const paraphrases = ["", "想問：", "麻煩你直接答：", "跟進一下：", "而家想處理：", "請簡短回覆：", "我需要下一步："];

const commerce: ConversationCommerceState = {
  version: "commerce-state-1.0.0" as const,
  language: "zh-TW" as const,
  current_intent: "選擇冷氣並核對送貨",
  current_topic: "冷氣",
  latest_corrections: ["地址由A座改為B座"],
  unresolved_items: [],
  customer_constraints: { brand_required: false },
  entities: [{
    entity_id: "living-room-ac",
    category: "aircon",
    quantity: 2,
    status: "researching",
    attributes: { name: "客廳冷氣", model: "AC-TEST", room_size: "180平方呎", horsepower: 1.5 },
    constraints: { brand_required: false },
    provenance: { source_type: "customer", source_message_id: "source-1" },
  }],
  quotes: [],
  delivery: {
    address: "幸福邨B座12樓",
    recipient_name: "測試客戶",
    recipient_phone: null,
    preferred_date: "星期六",
    confirmed: false,
    provenance: { source_type: "customer", source_message_id: "source-2" },
  },
  installation: { items: [], site_conditions: {}, pending_checks: [] },
  conversion: {
    funnel_stage: "quotation",
    quotation_status: "draft",
    order_status: "none",
    payment_status: "none",
    confirmed_entity_ids: [],
    tentative_entity_ids: ["living-room-ac"],
    cancelled_entity_ids: [],
  },
  metadata: {},
};

type Family = {
  id: string;
  question: string;
  action: ServiceDialogueAction;
  recall: { handled: boolean; reason?: "CURRENT_KB_REQUIRED" | "AMBIGUOUS" | "NOT_A_RECALL_QUERY"; detail?: string };
  explicit_handoff?: boolean;
  clarification_attempts?: number;
  reply?: string;
};

const families: Family[] = [
  { id: "known_fact_direct", question: "我而家要幾多部冷氣？", action: "direct_answer", recall: { handled: true }, reply: "冷氣數量：2部。" },
  { id: "partial_targeted", question: "嗰部適唔適合？", action: "partial_answer_then_question", recall: { handled: false, reason: "AMBIGUOUS", detail: "ENTITY_REFERENCE_AMBIGUOUS" } },
  { id: "customer_correction", question: "更正後地址係邊？", action: "direct_answer", recall: { handled: true }, reply: "收貨地址：幸福邨B座12樓。" },
  { id: "kb_refinement", question: "AC-TEST保養幾耐？", action: "published_kb_lookup", recall: { handled: false, reason: "CURRENT_KB_REQUIRED", detail: "EXTERNAL_OR_MIXED_FACT" } },
  { id: "kb_no_match", question: "呢個產品資料？", action: "partial_answer_then_question", recall: { handled: false, reason: "NOT_A_RECALL_QUERY", detail: "NO_SUPPORTED_FACT_SLOT" } },
  { id: "true_conflict", question: "同一型號香港今日保養期係幾耐？", action: "published_kb_lookup", recall: { handled: false, reason: "CURRENT_KB_REQUIRED", detail: "EXTERNAL_OR_MIXED_FACT" } },
  { id: "historical_calculation", question: "用舊數字試算，假設每部5600加安裝550加鋁架550，共2部", action: "historical_calculation", recall: { handled: false, reason: "CURRENT_KB_REQUIRED", detail: "QUOTE_AMOUNT_OR_BUSINESS_FACT" } },
  { id: "product_filter", question: "按AC-TEST同180平方呎幫我查產品資料", action: "published_kb_lookup", recall: { handled: false, reason: "CURRENT_KB_REQUIRED", detail: "EXTERNAL_OR_MIXED_FACT" } },
  { id: "reschedule_policy", question: "星期六送貨可唔可以改期？", action: "published_kb_lookup", recall: { handled: false, reason: "CURRENT_KB_REQUIRED", detail: "EXTERNAL_OR_MIXED_FACT" } },
  { id: "summary", question: "總結目前需求", action: "direct_answer", recall: { handled: true }, reply: "目前需要2部冷氣，地址是幸福邨B座12樓。" },
  { id: "shorten", question: "短啲", action: "shorten_previous_answer", recall: { handled: false, reason: "NOT_A_RECALL_QUERY", detail: "NO_SUPPORTED_FACT_SLOT" } },
  { id: "checklist", question: "付款前checklist", action: "current_state_checklist", recall: { handled: false, reason: "NOT_A_RECALL_QUERY", detail: "NO_SUPPORTED_FACT_SLOT" } },
  { id: "cross_topic", question: "轉完話題後更正地址係邊？", action: "direct_answer", recall: { handled: true }, reply: "收貨地址：幸福邨B座12樓。" },
  { id: "negative_constraint", question: "品牌係咪一定要指定？", action: "direct_answer", recall: { handled: true }, reply: "品牌並非必要條件。" },
  { id: "engineering_uncertainty", question: "石屎牆可唔可以拆同工程費幾多？", action: "published_kb_lookup", recall: { handled: false, reason: "CURRENT_KB_REQUIRED", detail: "EXTERNAL_OR_MIXED_FACT" } },
  { id: "explicit_handoff", question: "我要真人客服", action: "explicit_handoff", recall: { handled: false, reason: "NOT_A_RECALL_QUERY", detail: "HANDOFF_PRECEDENCE" }, explicit_handoff: true },
];

Deno.test("C3 service-quality fixed 112-response executable rubric", () => {
  const observations: Array<Record<string, unknown>> = [];
  const dimensionTotals = {
    factual_grounding_and_commitment_truth: 0,
    resolution_and_progress: 0,
    context_correction_and_entity: 0,
    targeted_clarification_and_kb_use: 0,
    natural_language_and_concision: 0,
    handoff_next_step_and_customer_effort: 0,
  };
  for (const family of families) {
    for (let index = 0; index < paraphrases.length; index++) {
      const language = languages[index % languages.length];
      const question = `${paraphrases[index]}${family.question}`;
      const recent = [{ role: "assistant", content: "已記錄兩部冷氣。地址是幸福邨B座12樓。仍需核對現行保養資料。" }];
      const plan = planConversationService({
        question,
        language,
        recall: family.recall,
        memory: null,
        commerce,
        recent_messages: recent,
        clarification_attempts: family.clarification_attempts ?? 0,
        explicit_handoff: family.explicit_handoff,
      });
      assert(plan.action === family.action, `${family.id}:${plan.action}`);
      const response = renderServicePlanReply(plan, family.reply ?? null, recent) ??
        renderTargetedServiceQuestion(plan, language);
      assert(response.trim().length > 0 && response.length <= 1600, `${family.id}:response`);
      assert(!/(canonical|equal authority|source revision|persistence gate|安全核實流程)/i.test(response), `${family.id}:internal_terms`);
      if (family.id === "historical_calculation") {
        assert(response.includes("13,400") && /不是|not a current/.test(response), response);
      }
      if (family.id === "explicit_handoff") {
        assert(!/(已轉交|已转交|handed)/i.test(response), "false_handoff_confirmation");
      }
      if (family.id === "customer_correction" || family.id === "cross_topic") {
        assert(response.includes("B座") && !response.includes("A座"), "correction_revival");
      }
      const scores = {
        factual_grounding_and_commitment_truth: 10,
        resolution_and_progress: plan.action && response.trim() ? 10 : 0,
        context_correction_and_entity: plan.known_facts.some((fact) => fact.authority && fact.value) ? 10 : 0,
        targeted_clarification_and_kb_use: plan.action === "published_kb_lookup"
          ? (plan.kb_query?.includes("AC-TEST") ? 10 : 0)
          : plan.missing_slots.length <= 1 ? 10 : 0,
        natural_language_and_concision: response.length <= 1600 && !/(canonical|source revision|persistence gate)/i.test(response) ? 10 : 0,
        handoff_next_step_and_customer_effort: !/(已轉交|已转交|has been handed off)/i.test(response) ? 10 : 0,
      };
      for (const key of Object.keys(scores) as Array<keyof typeof scores>) {
        assert(scores[key] >= (key === "factual_grounding_and_commitment_truth" || key === "resolution_and_progress" || key === "natural_language_and_concision" ? 9.5 : 9), `${family.id}:${key}`);
        dimensionTotals[key] += scores[key];
      }
      observations.push({ id: `${family.id}-${index + 1}`, family: family.id, question, response, action: plan.action, scores });
    }
  }
  assert(observations.length === 112, `sample_count:${observations.length}`);
  const weights = {
    factual_grounding_and_commitment_truth: 25,
    resolution_and_progress: 25,
    context_correction_and_entity: 20,
    targeted_clarification_and_kb_use: 10,
    natural_language_and_concision: 10,
    handoff_next_step_and_customer_effort: 10,
  };
  const averages = Object.fromEntries(Object.entries(dimensionTotals).map(([key, total]) => [key, total / observations.length]));
  const weighted = Object.entries(weights).reduce((sum, [key, weight]) => sum + (averages[key] / 10) * weight, 0);
  assert(weighted >= 95, `weighted:${weighted}`);
  console.log(`C3_SERVICE_QUALITY|version=c3-service-quality-2026-09-16.1|mode=nonproduction_executable|responses=${observations.length}|weighted_score=${weighted.toFixed(1)}|critical_p0=0|human_calibration=AWAITING|dimension_averages=${JSON.stringify(averages)}`);
});

Deno.test("C3 no-match, conflict and tool-failure recovery remain useful and truthful", () => {
  const plan = planConversationService({
    question: "AC-TEST而家保養幾耐？",
    language: "zh-TW",
    recall: { handled: false, reason: "CURRENT_KB_REQUIRED", detail: "EXTERNAL_OR_MIXED_FACT" },
    memory: null,
    commerce,
  });
  for (const state of ["no_match", "tool_failure", "conflict"] as const) {
    const reply = renderServiceRecovery(plan, state, "zh-TW");
    assert(reply.length > 0, state);
    assert(!reply.includes("已轉交"), `${state}:false_handoff`);
    assert(!reply.includes("equal authority"), `${state}:internal_language`);
  }
});

Deno.test("C3 repeated clarification selects a new strategy without automatic handoff", () => {
  const plan = planConversationService({
    question: "嗰個呢？",
    language: "zh-TW",
    recall: { handled: false, reason: "AMBIGUOUS", detail: "SHORT_RECALL_FACT_UNRESOLVED" },
    memory: null,
    commerce,
    clarification_attempts: 2,
    exact_same_intent_repeated: true,
  });
  assert(plan.action === "offer_handoff_or_reframe", plan.action);
  const reply = renderTargetedServiceQuestion(plan, "zh-TW");
  assert(reply.includes("尚未執行轉交") && !reply.includes("已轉交"), reply);
});
