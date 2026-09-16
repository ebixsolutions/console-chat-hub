#!/usr/bin/env -S deno run --allow-read --allow-write
import {
  buildServicePlanPromptBlock,
  planConversationService,
  renderServicePlanReply,
  renderServiceRecovery,
  renderTargetedServiceQuestion,
  type ServicePlanInput,
} from "../../supabase/functions/_shared/conversation-service-planner.ts";
import type { ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";

const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
const must = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message); };
const sourceFiles = [
  "supabase/functions/_shared/conversation-service-planner.ts",
  "supabase/functions/generate-reply/index.ts",
  "supabase/functions/agent-assist/index.ts",
];

type Dimension = "factual_grounding_and_commitment_truth" | "resolution_and_progress" |
  "context_correction_and_entity" | "targeted_clarification_and_kb_use" |
  "natural_language_and_concision" | "handoff_next_step_and_customer_effort";
const dimensions: Dimension[] = [
  "factual_grounding_and_commitment_truth", "resolution_and_progress",
  "context_correction_and_entity", "targeted_clarification_and_kb_use",
  "natural_language_and_concision", "handoff_next_step_and_customer_effort",
];
const weights: Record<Dimension, number> = {
  factual_grounding_and_commitment_truth: 25, resolution_and_progress: 25,
  context_correction_and_entity: 20, targeted_clarification_and_kb_use: 10,
  natural_language_and_concision: 10, handoff_next_step_and_customer_effort: 10,
};

function commerce(index: number): ConversationCommerceState {
  return {
    version: "commerce-state-1.0.0", language: "zh-TW",
    current_intent: `為客廳選擇冷氣方案 ${index}`, current_topic: "冷氣",
    latest_corrections: [`地址由A座改為B座${index}樓`], unresolved_items: [],
    customer_constraints: { brand_required: false },
    entities: [{
      entity_id: `ac-${index}`, category: "aircon", quantity: 2, status: "researching",
      attributes: { name: "客廳冷氣", model: `AC-${1000 + index}`, room_size: `${170 + index}平方呎`, horsepower: 1.5 },
      constraints: { brand_required: false },
      provenance: { source_type: "customer", source_message_id: `heldout-source-${index}` },
    }], quotes: [],
    delivery: { address: `幸福邨B座${index}樓`, recipient_name: `測試客戶${index}`, recipient_phone: null, preferred_date: "星期六", confirmed: false, provenance: { source_type: "customer", source_message_id: `heldout-address-${index}` } },
    installation: { items: [], site_conditions: {}, pending_checks: [] },
    conversion: { funnel_stage: "quotation", quotation_status: "draft", order_status: "none", payment_status: "none", confirmed_entity_ids: [], tentative_entity_ids: [`ac-${index}`], cancelled_entity_ids: [] },
    metadata: {},
  };
}

function evaluate(id: string, family: string, input: ServicePlanInput, responseKind: "reply" | "no_match" | "conflict" | "tool_failure", recallReply: string | null, recent: Array<{ role: string; content: string }>) {
  const plan = planConversationService(input);
  const response = responseKind === "reply"
    ? (renderServicePlanReply(plan, recallReply, recent) ?? renderTargetedServiceQuestion(plan, input.language))
    : renderServiceRecovery(plan, responseKind, input.language);
  const assertions: Record<Dimension, Array<{ name: string; pass: boolean }>> = {
    factual_grounding_and_commitment_truth: [
      { name: "no_false_current_price", pass: !/(?:現行|目前|current).{0,12}(?:正式|official).{0,8}(?:價格|售價|price).{0,8}(?:是|is)\s*(?:HKD|\$)?\s*\d/i.test(response) },
      { name: "no_false_completed_action", pass: !/(?:已保存|已儲存|已转交|已轉交|has been (?:saved|handed off))/i.test(response) },
    ],
    resolution_and_progress: [
      { name: "nonempty_actionable_output", pass: Boolean(plan.action) && /[\p{L}\p{N}]/u.test(response) },
      { name: "known_fact_or_next_step", pass: plan.known_facts.length > 0 || /(?:請|可以|提供|核對|稍後|choose|share|retry|which|what)/i.test(response) },
      { name: "handoff_request_acknowledged", pass: family !== "handoff" || (plan.action === "explicit_handoff" && /(?:真人客服|人工客服|human support)/i.test(response)) },
    ],
    context_correction_and_entity: [
      { name: "corrected_address_only", pass: responseKind !== "reply" || family !== "correction" || (response.includes(input.commerce!.delivery.address!) && !response.includes("A座")) },
      { name: "entity_source_retained", pass: plan.known_facts.some((fact) => fact.name.includes("entity:") && fact.authority.length > 0) },
    ],
    targeted_clarification_and_kb_use: [
      { name: "at_most_one_missing_slot", pass: plan.missing_slots.length <= 1 },
      { name: "known_model_not_reasked", pass: !plan.missing_slots.includes("model_or_product_link") },
      { name: "kb_states_distinct", pass: responseKind === "reply" || ({ no_match: /沒有返回|未找到|could not find|returned no/i, conflict: /相反|opposing/i, tool_failure: /工具|tool/i }[responseKind]).test(response) },
    ],
    natural_language_and_concision: [
      { name: "customer_language_no_internal_keys", pass: !/(?:entity:|current_intent|canonical|persistence gate|source revision)/i.test(response) },
      { name: "preserves_constraints_when_shortened", pass: family !== "shorten" || /(?:不是現行報價|尚未確認|仍需核實)/.test(response) },
      { name: "emotion_acknowledged", pass: family !== "emotion_entitlement" || /(?:失望|frustrating)/i.test(response) },
    ],
    handoff_next_step_and_customer_effort: [
      { name: "no_false_handoff", pass: !/(?:已轉交|已转交|has been handed off)/i.test(response) },
      { name: "no_repeat_known_model", pass: !/(?:請提供|please share).{0,12}(?:型號|model)/i.test(response) },
      { name: "handoff_status_truthful", pass: family !== "handoff" || /(?:尚未完成|not complete)/i.test(response) },
    ],
  };
  const scores = Object.fromEntries(dimensions.map((dimension) => {
    const checks = assertions[dimension];
    return [dimension, 10 * checks.filter((check) => check.pass).length / checks.length];
  }));
  return { id, family, input: input.question, action: plan.action, response, response_sha256: "", assertions, scores, prompt_trace: buildServicePlanPromptBlock(plan) };
}

export async function runEvaluation() {
  const rows: Array<ReturnType<typeof evaluate>> = [];
  for (let index = 1; index <= 10; index++) {
    const state = commerce(index);
    const base = { language: "zh-TW" as const, memory: null, commerce: state };
    const recent = [{ role: "assistant", content: "舊機價是 HKD 5,600。這不是現行報價。訂單尚未確認。實際工程費仍需核實。" }];
    const definitions: Array<[string, ServicePlanInput, "reply" | "no_match" | "conflict" | "tool_failure", string | null]> = [
      ["correction", { ...base, question: "更正後送貨地址係邊？", recall: { handled: true } }, "reply", `更正後送貨地址是${state.delivery.address}。`],
      ["partial", { ...base, question: "嗰部適唔適合？", recall: { handled: false, reason: "AMBIGUOUS", detail: "ENTITY_REFERENCE_AMBIGUOUS" } }, "reply", null],
      ["calculation", { ...base, question: "用舊數字試算，兩部冷氣", recall: { handled: false }, calculation_quantity: 2, calculation_terms: [{ label: "舊機價", amount: 5600 + index, currency: "HKD", charge_basis: "per_unit", source: "customer_message" }, { label: "舊安裝費", amount: 550, currency: "HKD", charge_basis: "per_unit", source: "customer_message" }, { label: "舊訂單費", amount: 300, currency: "HKD", charge_basis: "per_order", source: "customer_message" }] }, "reply", null],
      ["shorten", { ...base, question: "短啲", recall: { handled: false } }, "reply", null],
      ["checklist", { ...base, question: "付款前清單", recall: { handled: false } }, "reply", null],
      ["no_match", { ...base, question: `${state.entities[0].attributes.model}現行保養？`, recall: { handled: false, reason: "CURRENT_KB_REQUIRED" } }, "no_match", null],
      ["conflict", { ...base, question: `${state.entities[0].attributes.model}香港保養資料互相衝突`, recall: { handled: false, reason: "CURRENT_KB_REQUIRED" } }, "conflict", null],
      ["tool_failure", { ...base, question: `${state.entities[0].attributes.model}現行存貨？`, recall: { handled: false, reason: "CURRENT_KB_REQUIRED" } }, "tool_failure", null],
      ["handoff", { ...base, question: "我要真人客服", recall: { handled: false }, explicit_handoff: true }, "reply", null],
      ["emotion_entitlement", { ...base, question: "我好失望，請按已核實權益講下一步", recall: { handled: false, reason: "AMBIGUOUS" }, emotion: { kind: "frustrated", intensity: "high", source: "source-bound-current-turn" }, entitlement: { name: "priority_support", value: "eligible", authority: "TRUSTED_CRM", source: `crm-${index}` } }, "reply", null],
    ];
    for (const [family, input, kind, reply] of definitions) rows.push(evaluate(`HO-${String(rows.length + 1).padStart(3, "0")}`, family, input, kind, reply, recent));
  }
  for (const row of rows) row.response_sha256 = await sha256(row.response);
  const dimension_averages = Object.fromEntries(dimensions.map((dimension) => [dimension, rows.reduce((sum, row) => sum + Number(row.scores[dimension]), 0) / rows.length]));
  const weighted_score = dimensions.reduce((sum, dimension) => sum + Number(dimension_averages[dimension]) / 10 * weights[dimension], 0);
  const critical_p0 = rows.flatMap((row) => Object.values(row.assertions).flat()).filter((assertion) => !assertion.pass).length;
  const evidence = {
    schema_version: "c3-service-quality-evidence-1.0.0", mode: "independent_held_out_nonproduction",
    candidate_source_hashes: Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, await sha256(await Deno.readTextFile(file))]))),
    sample_count: rows.length, deterministic_regression_count: 112, deterministic_samples_included: false,
    scoring: { formula: "per-dimension passed executable assertions / applicable assertions * 10; no rounding", weights },
    dimension_averages, weighted_score, critical_p0, rows,
    human_calibration: "AWAITING_HUMAN_CALIBRATION",
  };
  must(rows.length === 100, `held_out_count:${rows.length}`);
  must(weighted_score >= 95, `weighted_score:${weighted_score}`);
  must(dimension_averages.factual_grounding_and_commitment_truth >= 9.5, "factual_below_9_5");
  must(dimension_averages.resolution_and_progress >= 9.5, "resolution_below_9_5");
  must(dimension_averages.natural_language_and_concision >= 9.5, "naturalness_below_9_5");
  for (const dimension of ["context_correction_and_entity", "targeted_clarification_and_kb_use", "handoff_next_step_and_customer_effort"]) must(Number(dimension_averages[dimension]) >= 9, `${dimension}_below_9`);
  must(critical_p0 === 0, `critical_p0:${critical_p0}`);
  const out = Deno.args[0];
  if (out) await Deno.writeTextFile(out, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`C3_SERVICE_QUALITY|mode=${evidence.mode}|responses=${rows.length}|weighted_score=${weighted_score}|critical_p0=${critical_p0}|human_calibration=AWAITING`);
  return evidence;
}

if (import.meta.main) await runEvaluation();
