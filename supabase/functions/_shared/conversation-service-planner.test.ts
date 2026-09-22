import {
  applyServiceTone,
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

Deno.test("C3 deterministic 112-case regression does not claim held-out quality", () => {
  const observations: Array<Record<string, unknown>> = [];
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
        ...(family.id === "historical_calculation" ? {
          calculation_quantity: 2,
          calculation_terms: [
            { label: "舊機價", amount: 5600, currency: "HKD", charge_basis: "per_unit" as const, source: "customer_message" as const },
            { label: "舊安裝費", amount: 550, currency: "HKD", charge_basis: "per_unit" as const, source: "customer_message" as const },
            { label: "舊鋁架費", amount: 550, currency: "HKD", charge_basis: "per_unit" as const, source: "customer_message" as const },
          ],
        } : {}),
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
      observations.push({ id: `${family.id}-${index + 1}`, family: family.id, question, response, action: plan.action });
    }
  }
  assert(observations.length === 112, `sample_count:${observations.length}`);
  console.log(`C3_DETERMINISTIC_REGRESSION|cases=${observations.length}|quality_score=NOT_MEASURED|held_out=false|result=PASS`);
});

Deno.test("C3 historical calculation uses typed monetary terms and explicit charge basis", () => {
  const base = { question: "舊價：機價5600每部、安裝550每部、鋁架550每單，共2部；型號AC-2026、180平方呎、日期2026-09-16", language: "zh-TW" as const, recall: { handled: false, reason: "CURRENT_KB_REQUIRED" as const }, memory: null, commerce };
  const plan = planConversationService({ ...base, calculation_quantity: 2, calculation_terms: [
    { label: "機價", amount: 5600, currency: "HKD", charge_basis: "per_unit", source: "customer_message" },
    { label: "安裝", amount: 550, currency: "HKD", charge_basis: "per_unit", source: "customer_message" },
    { label: "鋁架", amount: 550, currency: "HKD", charge_basis: "per_order", source: "customer_message" },
  ] });
  assert(plan.calculation?.total === 12850, JSON.stringify(plan.calculation));
  assert(!JSON.stringify(plan.calculation).includes("2026") && !JSON.stringify(plan.calculation).includes("180"), "non_monetary_number_leak");
});

Deno.test("C3 shortening preserves negation, uncertainty and current-price limits", () => {
  const plan = planConversationService({ question: "短啲", language: "zh-TW", recall: { handled: false }, memory: null, commerce });
  const reply = renderServicePlanReply(plan, null, [{ role: "assistant", content: "舊機價是 HKD 5,600。這不是現行報價。訂單尚未確認。實際工程費仍需核實。" }]) ?? "";
  assert(reply.includes("不是現行報價") && reply.includes("尚未確認") && reply.includes("仍需核實"), reply);
});

Deno.test("C3 known slot is not re-asked and checklist hides internal keys", () => {
  const plan = planConversationService({ question: "型號資料", language: "zh-TW", recall: { handled: false, reason: "CURRENT_KB_REQUIRED" }, memory: null, commerce });
  assert(!plan.missing_slots.includes("model_or_product_link"), JSON.stringify(plan.missing_slots));
  const checklist = renderServicePlanReply({ ...plan, action: "current_state_checklist" }, null) ?? "";
  assert(!checklist.includes("entity:") && !checklist.includes("current_intent"), checklist);
  assert(checklist.includes("草擬中") && !checklist.includes("✓"), checklist);
});

Deno.test("C3 tool failure does not claim lookup, save or handoff completion", () => {
  const plan = planConversationService({ question: "查保養", language: "zh-TW", recall: { handled: false, reason: "CURRENT_KB_REQUIRED" }, memory: null, commerce });
  const reply = renderServiceRecovery(plan, "tool_failure", "zh-TW");
  assert(reply.includes("工具") && reply.includes("未能完成"), reply);
  assert(!/(已查|已保存|已轉交)/.test(reply), reply);
});

Deno.test("C3 emotion is source-traced while untrusted entitlement stays unavailable", () => {
  const plan = planConversationService({ question: "我好失望，下一步係咩？", language: "zh-TW", recall: { handled: true }, memory: null, commerce });
  assert(plan.emotion_trace?.source === "current_customer_turn", JSON.stringify(plan.emotion_trace));
  assert(plan.entitlement_status === "unknown" && plan.entitlement_trace === undefined, JSON.stringify(plan));
  const reply = applyServiceTone(plan, "下一步是核對現行保養資料。") ?? "";
  assert(reply.startsWith("我明白這個情況令人失望"), reply);
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

Deno.test("C3 clear KB no-match stays useful without machine framing or generic goal re-ask", () => {
  const plan = planConversationService({
    question: "iPhone 16 Pro Max 256GB 而家有冇現貨？",
    language: "zh-TW",
    recall: {
      handled: false,
      reason: "CURRENT_KB_REQUIRED",
      detail: "EXTERNAL_OR_MIXED_FACT",
    },
    memory: null,
    commerce: null,
  });
  const reply = renderServiceRecovery(plan, "no_match", "zh-TW");
  assert(/未找到/.test(reply) && /產品頁|完整型號|地區|日期/.test(reply), reply);
  assert(!/最想完成|根據這段對話已有的資料/.test(reply), reply);

  const targeted = renderTargetedServiceQuestion({
    ...plan,
    action: "targeted_clarification",
    known_facts: [{
      name: "entity:model",
      label: "型號",
      value: "AC-TEST",
      authority: "CONVERSATION_STATE",
      status: "provided",
    }],
    missing_slots: ["region"],
    clarification_target: "region",
  }, "zh-TW");
  assert(targeted === "這項查詢適用哪個地區？", targeted);
});

Deno.test("C3 described customer issues receive one safe actionable next step", () => {
  for (const [question, expected] of [
    ["My password reset email never arrives and I cannot sign in.", "email domain"],
    ["The parcel is marked lost in transit and delivery is overdue.", "parcel reference"],
    ["I asked to cancel the wrong-size order but it was dispatched.", "order/reference"],
    ["The food expires tomorrow and I need help with a refund.", "expiry date"],
    ["Is this exact model in stock at the local store?", "exact product/model"],
    ["The third-party seller's laptop is missing advertised features.", "product model"],
  ] as const) {
    const plan = planConversationService({
      question,
      language: "en",
      recall: { handled: false, reason: "NOT_A_RECALL_QUERY" },
      memory: null,
      commerce: null,
    });
    assert(plan.action === "customer_issue_next_step", `${question}:${plan.action}`);
    const reply = renderServicePlanReply(plan, null) ?? "";
    assert(reply.includes(expected), `${question}:${reply}`);
    assert(!/What would you most like|Based on the information available/.test(reply), reply);
    assert(!/(has been refunded|has been cancelled|was delivered|handoff completed)/i.test(reply), reply);
  }
});

Deno.test("C3 shared contextual fallback never emits a generic goal or item re-ask", () => {
  for (const [question, detail] of [
    ["我最緊要唔好超過600闊，深少少冇所謂。", "CUSTOMER_STATEMENT_NOT_QUERY"],
    ["Panasonic有冇合適方向？", "NO_SUPPORTED_FACT_SLOT"],
    ["送星期幾？", "MISSING_DELIVERY_PREFERENCE"],
    ["幫我簡單講一次我而家要咩。", "NO_SUPPORTED_FACT_SLOT"],
  ] as const) {
    const plan = planConversationService({ question, language: "zh-TW", recall: { handled: false, reason: "NOT_A_RECALL_QUERY", detail }, memory: null, commerce });
    const reply = renderServicePlanReply(plan, null) ?? renderTargetedServiceQuestion(plan, "zh-TW");
    assert(!/你今次最想完成哪一件事|你想核對哪個項目或哪個時間點/.test(reply), reply);
    assert(/明白|目前資料|核實/.test(reply), reply);
    assert(!/已確認|已保存|已轉交/.test(reply), reply);
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
