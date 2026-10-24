#!/usr/bin/env -S deno run --allow-read --allow-write
import { createHash } from "node:crypto";
import type { ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import {
  applyServiceTone,
  planConversationService,
  renderServicePlanReply,
  renderServiceRecovery,
  renderTargetedServiceQuestion,
  type ServicePlanInput,
} from "../../supabase/functions/_shared/conversation-service-planner.ts";
import {
  applyServiceRuntimeDerivation,
  deriveServiceRuntimeInputs,
} from "../../supabase/functions/_shared/conversation-service-runtime.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
    ? `{${
      Object.keys(value as Record<string, unknown>).sort().map((key) =>
        `${JSON.stringify(key)}:${
          canonical((value as Record<string, unknown>)[key])
        }`
      ).join(",")
    }}`
    : JSON.stringify(value);
const sourceFiles = [
  "supabase/functions/_shared/conversation-service-planner.ts",
  "supabase/functions/_shared/conversation-service-runtime.ts",
  "supabase/functions/generate-reply/index.ts",
  "supabase/functions/agent-assist/index.ts",
];

function commerce(index: number): ConversationCommerceState {
  return {
    version: "commerce-state-1.0.0",
    language: "zh-TW",
    current_intent: `處理案例 ${index}`,
    current_topic: index % 2 ? "冷氣" : "送貨安排",
    latest_corrections: [`地址由A座改為B座${index}樓`],
    unresolved_items: [],
    customer_constraints: { brand_required: false },
    entities: [{
      entity_id: `ac-${index}`,
      category: "aircon",
      quantity: index % 3 + 1,
      status: "researching",
      attributes: {
        name: `客廳冷氣${index}`,
        model: `AC-${2100 + index}`,
        room_size: `${120 + index}平方呎`,
        horsepower: index % 2 ? 1 : 1.5,
      },
      constraints: { brand_required: false },
      provenance: {
        source_type: "customer",
        source_message_id: `source-${index}`,
      },
    }],
    quotes: [],
    delivery: {
      address: `幸福邨B座${index}樓`,
      recipient_name: `測試客戶${index}`,
      preferred_date: index % 2 ? "星期六" : "星期日",
      confirmed: false,
      provenance: {
        source_type: "customer",
        source_message_id: `address-${index}`,
      },
    },
    installation: { items: [], site_conditions: {}, pending_checks: [] },
    conversion: {
      funnel_stage: "quotation",
      quotation_status: "draft",
      order_status: "none",
      payment_status: "none",
      confirmed_entity_ids: [],
      tentative_entity_ids: [`ac-${index}`],
      cancelled_entity_ids: [],
    },
    metadata: {},
  };
}

type Definition = {
  family: string;
  question: (index: number, state: ConversationCommerceState) => string;
  recall: ServicePlanInput["recall"];
  kind?: "no_match" | "conflict" | "tool_failure";
  reply?: (state: ConversationCommerceState) => string;
  recent?: Array<{ role: string; content: string }>;
  explicit_handoff?: boolean;
};

const definitions: Definition[] = [
  {
    family: "corrected_address",
    question: () => "我更正後嘅送貨地址係邊？",
    recall: { handled: true },
    reply: (s) => `更正後送貨地址是${s.delivery.address}。`,
  },
  {
    family: "ambiguous_product",
    question: () => "嗰部適唔適合睡房？",
    recall: {
      handled: false,
      reason: "AMBIGUOUS",
      detail: "ENTITY_REFERENCE_AMBIGUOUS",
    },
  },
  {
    family: "typed_calculation",
    question: (i, s) =>
      `用舊數字試算${s.entities[0].quantity}部：舊機價每部 HKD ${
        5600 + i
      }，安裝每部 HKD 550，運費整單 HKD 300`,
    recall: { handled: false },
  },
  {
    family: "calculation_missing_basis",
    question: (i) => `用舊數字試算：機價 HKD ${5600 + i}，安裝 HKD 550`,
    recall: { handled: false },
  },
  {
    family: "shorten_with_limits",
    question: () => "短啲",
    recall: { handled: false },
    recent: [{
      role: "assistant",
      content:
        "舊機價是 HKD 5,600。這不是現行報價。訂單尚未確認。實際工程費仍需核實。",
    }],
  },
  {
    family: "prepayment_checklist",
    question: () => "付款前清單",
    recall: { handled: false },
  },
  {
    family: "kb_no_match",
    question: (_i, s) => `${s.entities[0].attributes.model}香港現行保養？`,
    recall: { handled: false, reason: "CURRENT_KB_REQUIRED" },
    kind: "no_match",
  },
  {
    family: "kb_tool_failure",
    question: (_i, s) => `${s.entities[0].attributes.model}香港現行存貨？`,
    recall: { handled: false, reason: "CURRENT_KB_REQUIRED" },
    kind: "tool_failure",
  },
  {
    family: "explicit_handoff",
    question: () => "我而家要真人客服",
    recall: { handled: false },
    explicit_handoff: true,
  },
  {
    family: "customer_expressed_frustration",
    question: () => "我已經講咗幾次，好失望，請講清楚下一步",
    recall: { handled: false, reason: "AMBIGUOUS" },
  },
];

function render(index: number, definition: Definition, offset: number) {
  const state = commerce(index),
    question = definition.question(index, state),
    recent = definition.recent ?? [];
  const derived = deriveServiceRuntimeInputs({
    question,
    recent_messages: recent,
    commerce: state,
    trusted_customer_context: null,
    expected_conversation_id: `component-conversation-${index}`,
    expected_company_id: "component-company",
  });
  const plan = planConversationService(
    applyServiceRuntimeDerivation({
      question,
      language: "zh-TW",
      recall: definition.recall,
      memory: null,
      commerce: state,
      recent_messages: recent,
      explicit_handoff: definition.explicit_handoff,
    }, derived),
  );
  const response = definition.kind
    ? renderServiceRecovery(plan, definition.kind, "zh-TW")
    : applyServiceTone(
      plan,
      renderServicePlanReply(plan, definition.reply?.(state) ?? null, recent) ??
        renderTargetedServiceQuestion(plan, "zh-TW"),
    ) ?? "";
  const context = {
    commerce: state,
    recent_messages: recent,
    customer_turn: question,
  };
  return {
    id: `CR-${String(offset + 1).padStart(3, "0")}`,
    cohort: "component_runtime_wiring_regression",
    family: definition.family,
    context,
    customer_turn: question,
    actual_response_or_action: response,
    action: plan.action,
    context_sha256: sha(canonical(context)),
    response_sha256: sha(response),
    deterministic_checks: {
      response_present: response.trim().length > 0,
      runtime_derivation_used: derived.version === "c3-service-runtime-1.0.0",
      no_untyped_calculation: plan.action !== "historical_calculation" ||
        derived.calculation_status === "ready",
      no_client_asserted_entitlement: plan.entitlement_status === "unknown",
    },
  };
}

export async function runComponentRegression() {
  const samples = Array.from({ length: 10 }, (_, i) => i + 1)
    .flatMap((index) =>
      definitions.map((definition, familyIndex) =>
        render(
          index,
          definition,
          (index - 1) * definitions.length + familyIndex,
        )
      )
    );
  const evidence = {
    schema_version: "c3-service-component-evidence-2.0.0",
    mode: "component_runtime_wiring_regression",
    quality_status: "NOT_MEASURED",
    independent_held_out: false,
    human_calibrated: false,
    sample_count: samples.length,
    dataset: {
      id: "c3-component-runtime-regression-2026-09-16.2",
      status: "observed_regression_not_held_out",
      sha256: sha(
        canonical(
          samples.map((row) => ({
            id: row.id,
            family: row.family,
            context_sha256: row.context_sha256,
          })),
        ),
      ),
    },
    candidate_source_hashes: Object.fromEntries(
      await Promise.all(
        sourceFiles.map(async (
          file,
        ) => [file, sha(await Deno.readTextFile(file))]),
      ),
    ),
    samples,
    machine_correctness: {
      pass: samples.every((row) =>
        Object.values(row.deterministic_checks).every(Boolean)
      ),
      failed_checks: samples.flatMap((row) =>
        Object.entries(row.deterministic_checks).filter(([, pass]) => !pass)
          .map(([name]) => `${row.id}:${name}`)
      ),
    },
    service_quality_scores: "NOT_MEASURED",
    reason:
      "Independent grader and blinded human calibration have not produced candidate-bound assessments.",
  };
  if (samples.length !== 100 || !evidence.machine_correctness.pass) {
    throw new Error(
      `component_regression_failed:${
        evidence.machine_correctness.failed_checks.join(",")
      }`,
    );
  }
  const output = Deno.args[0];
  if (output) {
    await Deno.writeTextFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
  console.log(
    `C3_SERVICE_COMPONENT|responses=${samples.length}|machine_correctness=PASS|quality_score=NOT_MEASURED|held_out=false|human_calibration=AWAITING`,
  );
  return evidence;
}

if (import.meta.main) await runComponentRegression();
