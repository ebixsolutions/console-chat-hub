import { createHash } from "node:crypto";
import {
  prepareConversationRecall,
  type RecallCommerceSnapshot,
  type ConversationRecallInput,
} from "../../supabase/functions/_shared/conversation-recall.ts";
import {
  buildCommerceEntityHints,
  type CommerceStateDbClient,
  isReadOnlyCurrentStateQuery,
  runCommerceStateRuntime,
} from "../../supabase/functions/_shared/commerce-state-runtime.ts";
import {
  type ConversationCommerceState,
  createEmptyConversationCommerceState,
} from "../../supabase/functions/_shared/commerce-state-contract.ts";
import type { CommerceSemanticFrame } from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import {
  buildCanonicalConversationMemory,
  type CanonicalConversationMemory,
  type MemoryHistoryRow,
} from "../../supabase/functions/_shared/conversation-long-memory.ts";
import {
  buildB2AuthoritativeReadbackProof,
  buildB2ReadOnlyRecapProof,
  classifyCommerceStatePersistenceResult,
  classifyB2AuthoritativePersistence,
  evaluateB2BeforeCommit,
} from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";
import { canonicalJson } from "../../supabase/functions/_shared/canonical-json.ts";
import {
  isCanonicalReadOnlyCommerceReason,
  resolveCanonicalCommerceResolution,
} from "../../supabase/functions/_shared/conversation-resolution-contract.ts";
import {
  canAnswerBoundedNoCurrentEvidence,
  canonicalTenantScopeFromAuthoritativeCompany,
  classifyCurrentFactEvidence,
} from "../../supabase/functions/_shared/current-fact-evidence.ts";
import {
  planConversationService,
  renderServicePlanReply,
  renderTargetedServiceQuestion,
} from "../../supabase/functions/_shared/conversation-service-planner.ts";
import {
  classifyNaturalCustomerIntent,
  renderNaturalImmediateResponse,
} from "../../supabase/functions/_shared/natural-customer-response.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const fixture = JSON.parse(
  Deno.readTextFileSync(new URL("./c3_canonical_103_turns.json", import.meta.url)),
) as {
  schema_version: string;
  frozen: boolean;
  turn_count: number;
  turns: string[];
};
assert(fixture.frozen === true && fixture.turn_count === 103, "fixture_invalid");
assert(fixture.turns.length === 103, "fixture_turn_count_invalid");
const capturedFailures = JSON.parse(
  Deno.readTextFileSync(new URL("./c3_captured_production_failure_envelopes.json", import.meta.url)),
) as { frozen: boolean; failures: Array<{ turn: number; text: string; required_contract: string }> };
assert(capturedFailures.frozen === true, "captured_failures_not_frozen");
assert(capturedFailures.failures.length === 11, "captured_failure_count_invalid");
for (const failure of capturedFailures.failures) {
  assert(fixture.turns[failure.turn - 1] === failure.text, `captured_failure_text_drift_T${failure.turn}`);
}

const conversationId = "10300000-0000-4000-8000-000000000001";
const companyId = "10300000-0000-4000-8000-000000000002";
let state = createEmptyConversationCommerceState();
let revision = 0;
let stateSourceMessageId: string | null = null;
let rpcCalls = 0;
let memory: CanonicalConversationMemory | null = null;
const history: MemoryHistoryRow[] = [];

const db: CommerceStateDbClient = {
  from: () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: revision ? { revision, state, source_message_id: stateSourceMessageId } : null,
          error: null,
        }),
      }),
    }),
  }),
  rpc: async (_name, params) => {
    rpcCalls += 1;
    const expected = Number(params.p_expected_revision);
    if (expected !== revision) {
      return {
        data: { result: "revision_conflict", applied_revision: revision },
        error: null,
      };
    }
    state = params.p_state as ConversationCommerceState;
    revision += 1;
    stateSourceMessageId = String(params.p_source_message_id);
    return {
      data: { result: "success", applied_revision: revision },
      error: null,
    };
  },
};

function sourceId(turn: number): string {
  return `10300000-0000-4000-8000-${String(turn).padStart(12, "0")}`;
}

function turnTimestamp(turn: number): string {
  return new Date(Date.UTC(2026, 8, 21, 0, 0, turn)).toISOString();
}

function semanticFrame(turn: number, text: string): CommerceSemanticFrame | null {
  const requested: string[] = [];
  let topic = "";
  if (turn === 1) {
    topic = "air_conditioner";
    requested.push("horsepower_guidance");
  } else if (turn === 25 || turn === 55 || turn === 102) {
    topic = "air_conditioner";
    requested.push("current_quantity");
  } else if (turn === 27) {
    topic = "refrigerator";
    requested.push("width");
  } else if (turn === 40 || turn === 57 || turn === 103) {
    topic = "delivery address";
    requested.push("address");
  } else if (turn === 56) {
    topic = "refrigerator"; requested.push("constraints");
  } else if (turn === 58) {
    topic = "delivery"; requested.push("preferred_date");
  } else if (turn === 59) {
    topic = "installation"; requested.push("old_machine_removal_count");
  } else if (turn === 68) {
    topic = "air_conditioner"; requested.push("horsepower");
  } else if (turn === 69) {
    topic = "air_conditioner"; requested.push("brand_constraint");
  } else if (turn === 71) {
    topic = "historical quote"; requested.push("current_price");
  } else if (turn === 90) {
    topic = "air_conditioner"; requested.push("current_quantity");
  } else if (turn === 91) {
    topic = "transaction"; requested.push("summary");
  } else if (turn === 96) {
    topic = "delivery"; requested.push("address", "recipient", "recipient_phone");
  } else if (turn === 48 || turn === 101) {
    topic = "installation";
    requested.push("pending_checks");
  } else if (turn === 50) {
    topic = "room size";
    requested.push("room_size");
  } else {
    return null;
  }
  return {
    version: "commerce-semantic-1.0.0",
    language: "zh-TW",
    operation: "ASK_FACT",
    intent: "read authoritative current conversation state",
    topic,
    entities: [],
    referents: turn === 27 ? [{ ref: "一部598mm", source: "prior_turn", confidence: 0.94 }] : [],
    customer_correction: false,
    additive: false,
    explicit_negations: [],
    requested_facts: requested,
    transaction_state: "none",
    payment_state: "none",
    booking_state: "none",
    fulfillment_state: "none",
    ambiguity: {
      is_ambiguous: false,
      reasons: [],
      clarification_question: null,
    },
    confidence: 0.94,
  };
}

const checkpoints = new Map<number, (reply: string, outcome: unknown) => boolean>([
  [1, (reply) => /冷氣/.test(reply) && /(?:用途|尺寸|空間|安裝)/.test(reply) && !/canonical|根據這段對話已有的資料/i.test(reply)],
  [13, (reply) => /13,?400/.test(reply) && /(?:今次提供|最新價格|舊報價|歷史)/.test(reply)],
  [20, (reply) => /(?:項目|冷氣)/.test(reply) && !/canonical|customer_|air_conditioner/i.test(reply)],
  [25, (reply) => /(?:2|兩)/.test(reply) && !/[?？]/.test(reply)],
  [
    27,
    (reply) =>
      reply.includes("598") &&
      /(?:595|600)/.test(reply) &&
      !/(?:冷氣|空調).{0,20}(?:2|兩)/.test(reply),
  ],
  [30, (reply) => /(?:項目|冷氣|雪櫃)/.test(reply) && !/canonical|customer_|air_conditioner/i.test(reply)],
  [40, (reply) => /B座|Ｂ座/.test(reply) && !reply.includes("A座")],
  [48, (reply) => /(?:2|兩)/.test(reply) && /窗口/.test(reply) && /安裝/.test(reply)],
  [50, (reply) => reply.includes("80") && reply.includes("100")],
  [55, (reply) => /(?:2|兩)/.test(reply) && !/[?？]/.test(reply)],
  [56, (reply) => /(?:595|600)/.test(reply) && !/(?:冷氣|空調).{0,20}(?:2|兩)/.test(reply)],
  [57, (reply) => /B座|Ｂ座/.test(reply) && !reply.includes("A座")],
  [58, (reply) => /星期六|週六|周六|Saturday/i.test(reply)],
  [59, (reply) => /(?:1|一)/.test(reply) && !/[?？]/.test(reply)],
  [60, (reply) => /(?:窗口|安裝)/.test(reply) && !/[?？]/.test(reply)],
  [65, (reply) => /冷氣/.test(reply) && /雪櫃/.test(reply) && /洗衣機/.test(reply)],
  [67, (reply) => /冷氣/.test(reply) && /雪櫃/.test(reply) && !/洗衣機/.test(reply)],
  [68, (reply) => /1匹/.test(reply) && /1\.5匹/.test(reply)],
  [69, (reply) => /(?:並非|唔係|不是|not mandatory|not required)/i.test(reply)],
  [71, (reply) => /(?:未必|不一定|not necessarily)/i.test(reply) && /(?:確認|确认|confirm)/i.test(reply)],
  [73, (reply) => /(?:唔會當現價|不会当作现价|not be used as a current price)/i.test(reply)],
  [74, (reply) => /5,?600|5,?788/.test(reply) && /(?:歷史|来源|來源|source)/i.test(reply) && !/品牌並非|品牌并非/.test(reply)],
  [76, (reply) => /(?:唔會當現價|不会当作现价|not be used as a current price)/i.test(reply)],
  [80, (reply) => /(?:1\.|1。)/.test(reply) && /(?:付款|payment)/i.test(reply)],
  [90, (reply) => /(?:2|兩)/.test(reply) && !/[?？]/.test(reply) && !/air_conditioner|quantity\s*\(/i.test(reply)],
  [91, (reply) => /(?:項目|项目|Items)/.test(reply) && /(?:訂單|订单|Order)/.test(reply) && !/window_opening_check|installation_site_check|air_conditioner/i.test(reply)],
  [95, (_reply) => state.delivery.recipient_phone === "6987 6543"],
  [96, (reply) => /陳太/.test(reply) && /6987 6543/.test(reply)],
  [98, (reply) => /(?:報價階段|报价阶段|quotation stage)/i.test(reply) && /(?:唔係已確認訂單|不是已确认订单|not a confirmed order)/i.test(reply)],
  [101, (reply) => /(?:2|兩)/.test(reply) && /窗口/.test(reply) && /安裝/.test(reply)],
  [102, (reply) => /(?:2|兩)/.test(reply) && !/[?？]/.test(reply)],
  [103, (reply) => /B座|Ｂ座/.test(reply) && !reply.includes("A座")],
]);

let falseSemanticMutation = 0;
let knownAnswerDeadEnd = 0;
let unnecessaryReask = 0;
let runtimeFailures = 0;
let terminalFailures = 0;
let fallbackCount = 0;
let completed = 0;
const knownResults: Record<string, unknown> = {};
const capturedProductionFailureTurns = new Set([
  ...capturedFailures.failures.map((failure) => failure.turn),
  58,
  71,
  73,
  76,
]);

for (let index = 0; index < fixture.turns.length; index++) {
  const turn = index + 1;
  const text = fixture.turns[index];
  const id = sourceId(turn);
  const frame = semanticFrame(turn, text);
  const beforeState = JSON.stringify(state);
  const beforeRevision = revision;
  const beforeRpcCalls = rpcCalls;
  const beforeMemory = canonicalJson(memory);
  const beforeMemoryRevision: number | null = memory?.memory_revision ?? null;
  let outcome;
  try {
    outcome = await runCommerceStateRuntime(db, {
      conversation_id: conversationId,
      company_id: companyId,
      source_message_id: id,
      text,
      language: "zh-TW",
      history: history
        .slice()
        .map((row) => ({
          role: String(row.role ?? ""),
          content: String(row.content ?? ""),
        })),
      semantic_frame: frame,
      industry_identifier: "home_appliance",
    });
  } catch (error) {
    runtimeFailures += 1;
    throw new Error(`turn_${turn}_runtime_exception:${String(error)}`);
  }

  const resolution = resolveCanonicalCommerceResolution({
    outcome,
    authoritative_address_correction: false,
  });
  const readOnly = Boolean(outcome && isCanonicalReadOnlyCommerceReason(outcome.reason));
  if (
    readOnly &&
    (beforeState !== JSON.stringify(state) ||
      beforeRevision !== revision ||
      beforeRpcCalls !== rpcCalls ||
      !resolution.no_semantic_change)
  ) {
    falseSemanticMutation += 1;
  }
  if (
    isReadOnlyCurrentStateQuery(text, frame) &&
    outcome?.persist_result !== "read_only" &&
    outcome?.persist_result !== "no_semantic_change"
  ) {
    falseSemanticMutation += 1;
  }

  history.unshift({
    id,
    role: "visitor",
    content: text,
    created_at: turnTimestamp(turn),
  });
  if (!resolution.skip_memory_refresh) {
    memory = buildCanonicalConversationMemory({
      previous: memory,
      conversation_id: conversationId,
      company_id: companyId,
      source_message_id: id,
      commerce_state_revision: revision,
      commerce_state: state,
      newest_first: history,
      visitor_turn_count: turn,
      source_created_at: turnTimestamp(turn),
      next_memory_revision: (memory?.memory_revision ?? 0) + 1,
    });
  }
  const commerce: RecallCommerceSnapshot = {
    conversation_id: conversationId,
    company_id: companyId,
    source_message_id: stateSourceMessageId ?? id,
    revision,
    state,
  };
  // Simulates the server's validated retained row; hash binds replay JSON only.
  const retainedMemoryReadback = outcome?.reason === "read_only_current_requirements_recap" && memory
    ? { contract: "persisted-memory-readback-v1" as const,
      conversation_id: conversationId, company_id: companyId,
      source_message_id: memory.source_message_id, memory_revision: memory.memory_revision,
      commerce_state_revision: revision,
      memory_hash: createHash("sha256").update(canonicalJson(memory)).digest("hex") }
    : null;
  const recallInput: ConversationRecallInput = {
      conversation_id: conversationId,
      company_id: companyId,
      source_message_id: id,
      question: text,
      memory,
      commerce,
      trusted_persisted_memory_readback: retainedMemoryReadback,
      referents: frame?.referents ?? [],
      recent_questions: history.slice(1, 13).map((row) => String(row.content ?? "")),
    };
  const recall = prepareConversationRecall(recallInput, "zh-TW");
  if (turn === 91) {
    assert(memory && retainedMemoryReadback && memory.source_message_id === sourceId(89) &&
      commerce.source_message_id === sourceId(88) && revision === 27 &&
      memory.commerce_state_revision === revision, "turn_91_retained_lineage_fixture_changed");
    const p = retainedMemoryReadback;
    for (const [name, change] of [
      ["omitted", { trusted_persisted_memory_readback: null }],
      ["conversation", { trusted_persisted_memory_readback: { ...p, conversation_id: "wrong" } }],
      ["company", { trusted_persisted_memory_readback: { ...p, company_id: "wrong" } }],
      ["source", { trusted_persisted_memory_readback: { ...p, source_message_id: "wrong" } }],
      ["memory_revision", { trusted_persisted_memory_readback: { ...p, memory_revision: p.memory_revision + 1 } }],
      ["commerce_revision", { trusted_persisted_memory_readback: { ...p, commerce_state_revision: revision + 1 } }],
      ["stale_memory", { memory: { ...memory, commerce_state_revision: revision - 1 } }],
      ["invalid_source", { memory: { ...memory, source_message_id: "" }, trusted_persisted_memory_readback: { ...p, source_message_id: "" } }],
      ["hash", { trusted_persisted_memory_readback: { ...p, memory_hash: "invalid" } }],
    ] as const) {
      const negative = prepareConversationRecall({ ...recallInput, ...change }, "zh-TW");
      assert(!negative.decision.handled && negative.decision.reason === "AMBIGUOUS" &&
        negative.decision.detail === "MEMORY_SCOPE_OR_SOURCE_MISMATCH",
        `turn_91_lineage_negative_${name}_accepted`);
    }
    console.log("TURN91_RETAINED_LINEAGE|source=89|commerce_source=88|revision=27|negatives=REJECTED");
    const conversion = state.conversion;
    const quotationText: Record<string, string> = { none: "未建立", draft: "草擬中", pending_verification: "待核實", verified: "已核實", accepted: "已接受", expired: "已過期", cancelled: "已取消" };
    const orderText: Record<string, string> = { none: "未建立訂單", draft: "訂單仍未確認", pending_confirmation: "訂單仍待確認", confirmed: "訂單已確認", completed: "訂單已完成", cancelled: "訂單已取消" };
    const paymentText: Record<string, string> = { none: "未有付款記錄", pending_quote: "付款金額仍待核實", pending_payment: "仍待付款", paid: "已有已收款記錄", failed: "付款未成功", refunded: "已有退款記錄", partially_refunded: "已有部分退款記錄" };
    assert(recall.reply?.includes("報價階段：" + quotationText[conversion.quotation_status]) &&
      recall.reply.includes(orderText[conversion.order_status]) &&
      recall.reply.includes("付款：" + paymentText[conversion.payment_status]),
      "turn_91_transaction_summary_disagrees_with_canonical_conversion");
    assert(!["confirmed", "completed"].includes(conversion.order_status) && conversion.payment_status !== "paid",
      "turn_91_nonconfirmed_nonpaid_fixture_changed");
    console.log(`TURN91_TRANSACTION_TRUTH|quotation=${conversion.quotation_status}|order=${conversion.order_status}|payment=${conversion.payment_status}|PASS`);
  }
  const servicePlan = planConversationService({
    question: text,
    language: "zh-TW",
    recall: recall.decision,
    memory,
    commerce: state,
    recent_messages: history.map((row) => ({
      role: String(row.role ?? ""),
      content: String(row.content ?? ""),
    })),
  });
  const serviceReply = renderServicePlanReply(servicePlan, recall.reply, []) ??
    ([
      "targeted_clarification",
      "partial_answer_then_question",
      "offer_handoff_or_reframe",
      "explicit_handoff",
    ].includes(servicePlan.action)
      ? renderTargetedServiceQuestion(servicePlan, "zh-TW")
      : null);
  const naturalIntent = classifyNaturalCustomerIntent(text);
  const naturalGuidanceReply = naturalIntent.kind === "product_guidance"
    ? renderNaturalImmediateResponse(naturalIntent, "zh-TW")
    : null;
  const authoritativeRuntimeReply = resolution.bypass_service_plan && outcome?.reply
    ? outcome.reply
    : null;
  const groundedReadOnlyRecap = outcome?.reason === "read_only_current_requirements_recap" &&
    recall.decision.handled && recall.decision.fact_type === "summary";
  const reply = groundedReadOnlyRecap ? recall.reply ?? ""
    : authoritativeRuntimeReply ?? naturalGuidanceReply ?? serviceReply ?? outcome?.reply ?? recall.reply ?? "";
  const route = groundedReadOnlyRecap ? "canonical_memory_recall" : authoritativeRuntimeReply
    ? outcome!.route
    : naturalGuidanceReply
      ? "product_guidance"
      : serviceReply
      ? String(recall.metadata.response_route)
      : outcome?.reply
        ? outcome.route
        : recall.reply
          ? String(recall.metadata.response_route)
          : "orchestration_pass_through";
  if (capturedProductionFailureTurns.has(turn)) {
    if (turn === 1) {
      assert(Boolean(naturalGuidanceReply), "turn_1_natural_guidance_missing");
      const contextualGuidanceSelected =
        outcome?.route === "product_guidance" &&
        resolution.bypass_service_plan &&
        reply === outcome.reply;
      assert(
        reply === naturalGuidanceReply || contextualGuidanceSelected,
        "turn_1_product_guidance_not_selected",
      );
      assert(route === "product_guidance", "turn_1_product_guidance_route_missing");
      assert(
        /(?:面積|日照|窗口|安裝)/.test(reply),
        "turn_1_useful_sizing_question_missing",
      );
    } else if (outcome?.reason === "read_only_current_requirements_recap") {
      assert(outcome.persist_result === "read_only" && outcome.route === "commerce_state_answer" &&
        outcome.reply === null && !resolution.bypass_service_plan &&
        resolution.skip_memory_refresh && resolution.no_semantic_change,
        `turn_${turn}_read_only_recap_ownership_invalid`);
      assert(memory && groundedReadOnlyRecap && recall.reply && reply === recall.reply &&
        route === "canonical_memory_recall", `turn_${turn}_canonical_recap_not_selected`);
      assert(!/window_opening_check|installation_site_check|air_conditioner|state_path|pending_actions/i.test(reply),
        `turn_${turn}_recap_internal_code_leak`);
    } else {
      assert(Boolean(outcome?.reply), `turn_${turn}_captured_envelope_missing_runtime_reply:${JSON.stringify(outcome)}`);
      assert(resolution.bypass_service_plan, `turn_${turn}_clarification_precedence_regression`);
      assert(reply === outcome?.reply, `turn_${turn}_runtime_reply_not_selected`);
    }
  }
  if (/terminal_failure_recovery|terminal_recovery/i.test(route)) {
    terminalFailures += 1;
  }
  if (/fallback/i.test(route)) fallbackCount += 1;
  if (/^(?:抱歉[，,。 ]*)?(?:我(?:不能|無法|无法)協助|請稍後再試)[。.!]?$/.test(reply.trim())) {
    knownAnswerDeadEnd += 1;
  }
  if (
    checkpoints.has(turn) &&
    /(?:請|请).{0,10}(?:再|重新).{0,10}(?:提供|確認|确认|說明|说明)/i.test(reply)
  ) {
    unnecessaryReask += 1;
  }
  const checkpoint = checkpoints.get(turn);
  if (checkpoint) {
    assert(checkpoint(reply, outcome), `turn_${turn}_checkpoint_failed:${reply}`);
    knownResults[`T${String(turn).padStart(3, "0")}`] = {
      route,
      reason:
        outcome?.reason ?? ("reason" in recall.decision ? recall.decision.reason : "resolved"),
      reply_sha256: createHash("sha256").update(reply).digest("hex"),
      revision,
      no_semantic_change: beforeRevision === revision,
    };
  }
  if (reply) {
    const selectedOutcome = authoritativeRuntimeReply ? outcome : null;
    // Replay-local binding only; this is not PostgreSQL jsonb::text byte parity.
    const recapProof = groundedReadOnlyRecap && memory ? await buildB2ReadOnlyRecapProof({
      conversation_id: conversationId, company_id: companyId, source_message_id: id,
      commerce_revision: revision, commerce_state: state,
      memory_revision: memory.memory_revision,
      memory_hash: createHash("sha256").update(canonicalJson(memory)).digest("hex"),
      memory_source_message_id: memory.source_message_id, memory, reply,
    }) : null;
    const metadata = recapProof ? {
      ...recall.metadata, response_route: "canonical_memory_recall", recap_read_only: true,
      commerce_state_persist_result: "read_only",
      commerce_state_persistence_classification: "NO_SEMANTIC_CHANGE",
      recap_commerce_hash: recapProof.commerce_hash, recap_memory_hash: recapProof.memory_hash,
      recap_response_hash: recapProof.response_hash,
    } : authoritativeRuntimeReply
      ? {
        response_route: selectedOutcome!.route,
        commerce_authority: selectedOutcome!.authority,
        commerce_state_revision: selectedOutcome!.revision,
        commerce_state_persist_result: selectedOutcome!.persist_result,
        commerce_state_persistence_classification:
          classifyCommerceStatePersistenceResult(selectedOutcome!.persist_result),
        commerce_reason: selectedOutcome!.reason,
        contextual_decision: selectedOutcome!.contextual_decision ?? null,
        commerce_state_path: selectedOutcome!.state_path ?? null,
        commerce_state_readback_proof: selectedOutcome!.state_path
          ? buildB2AuthoritativeReadbackProof(state, selectedOutcome!.state_path)
          : null,
      }
      : null;
    const b2Input = {
      proposed_response: reply,
      persistence_kind: "ai_reply" as const,
      snapshot: { conversation_id: conversationId, company_id: companyId, source_message_id: id, source_message_content: text, commerce_state_revision: revision, commerce_state_source_message_id: stateSourceMessageId, state },
      metadata,
      trusted_read_only_recap: recapProof,
      trusted_journey_progress: selectedOutcome?.trusted_journey_progress ?? null,
      trusted_correction_commit: selectedOutcome?.trusted_correction_commit ?? null,
      trusted_lifecycle_commit: selectedOutcome?.trusted_lifecycle_commit ?? null,
      trusted_targeted_clarification: selectedOutcome?.reason === "contextual_targeted_clarification" &&
          selectedOutcome.persist_result === "read_only" && selectedOutcome.contextual_decision
        ? { reply: selectedOutcome.reply ?? "", revision: selectedOutcome.revision,
          contextual_decision: selectedOutcome.contextual_decision }
        : null,
    };
    const stateBeforeB2 = JSON.stringify(state);
    const b2 = evaluateB2BeforeCommit(b2Input);
    if (groundedReadOnlyRecap) {
      assert(recapProof && b2.decision === "allow" && b2.code === "B2_ALLOW_AUTHORITATIVE_READ_ONLY_RECAP",
        `turn_${turn}_recap_b2_${b2.code}`);
      assert(beforeState === JSON.stringify(state) && beforeRevision === revision &&
        beforeRpcCalls === rpcCalls && beforeMemory === canonicalJson(memory) &&
        beforeMemoryRevision === memory?.memory_revision, `turn_${turn}_recap_mutated_state`);
      for (const [name, change] of [
        ["omitted", { trusted_read_only_recap: null }],
        ["wrong_source", { trusted_read_only_recap: { ...recapProof, source_message_id: "wrong" } }],
        ["wrong_company", { trusted_read_only_recap: { ...recapProof, company_id: "wrong" } }],
        ["wrong_revision", { trusted_read_only_recap: { ...recapProof, commerce_revision: revision + 1 } }],
        ["reply_substitution", { proposed_response: `${reply} substituted` }],
        ["memory_revision", { trusted_read_only_recap: { ...recapProof, memory_revision: recapProof.memory_revision + 1 } }],
        ["memory_hash", { trusted_read_only_recap: { ...recapProof, memory_hash: "wrong" } }],
        ["memory_substitution", { trusted_read_only_recap: { ...recapProof,
          memory: { ...recapProof.memory, company_id: "wrong" } } }],
      ] as const) {
        assert(evaluateB2BeforeCommit({ ...b2Input, ...change }).decision === "block",
          `turn_${turn}_recap_negative_${name}_allowed`);
      }
      console.log(`TURN${turn}_RECAP_PARITY|owner=canonical_memory_recall|B2=ALLOW|negatives=BLOCK|state=UNCHANGED`);
    }
    if (turn === 2) {
      const proof = selectedOutcome?.trusted_journey_progress;
      assert(authoritativeRuntimeReply && proof && proof.company_id === companyId &&
        proof.source_message_id === id && proof.source_text === text &&
        proof.committed_revision === revision && proof.reply === reply,
        "turn_2_runtime_journey_proof_binding_invalid");
      assert(b2.decision === "allow" && b2.code === "B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE",
        "turn_2_trusted_journey_not_authorized");
      for (const [name, change] of [
        ["omitted", { trusted_journey_progress: null }],
        ["wrong_source", { trusted_journey_progress: { ...proof, source_message_id: "wrong-source" } }],
        ["wrong_company", { trusted_journey_progress: { ...proof, company_id: "wrong-company" } }],
        ["wrong_revision", { trusted_journey_progress: { ...proof, committed_revision: revision + 1 } }],
        ["substituted_reply", { proposed_response: `${reply} substituted` }],
      ] as const) {
        const negative = evaluateB2BeforeCommit({ ...b2Input, ...change });
        assert(negative.decision === "block", `turn_2_journey_negative_${name}_allowed`);
      }
      console.log("TURN2_B2_PROOF_PARITY|exact=ALLOW|omitted/source/company/revision/reply=BLOCK");
    }
    assert(JSON.stringify(state) === stateBeforeB2, `turn_${turn}_b2_mutated_state`);
    assert(b2.decision === "allow", `turn_${turn}_b2_${b2.decision}:${b2.code}:${state.latest_corrections.at(-1) ?? "none"}`);
  }
  if (
    outcome?.persist_result === "read_only" &&
    outcome.reply &&
    outcome.authority === "CONVERSATION_STATE" &&
    outcome.state_path
  ) {
    const metadata = {
      response_route: outcome.route,
      commerce_authority: outcome.authority,
      commerce_state_revision: outcome.revision,
      commerce_state_persist_result: outcome.persist_result,
      commerce_state_persistence_classification: "NO_SEMANTIC_CHANGE",
      commerce_reason: outcome.reason,
      commerce_state_path: outcome.state_path,
      commerce_state_readback_proof: buildB2AuthoritativeReadbackProof(state, outcome.state_path),
    };
    const b2Input = {
      proposed_response: outcome.reply,
      persistence_kind: "ai_reply" as const,
      snapshot: {
        conversation_id: conversationId,
        company_id: companyId,
        source_message_id: id,
        source_message_content: text,
        commerce_state_revision: revision,
        commerce_state_source_message_id: stateSourceMessageId,
        state,
      },
      metadata,
    };
    const classification = classifyB2AuthoritativePersistence(b2Input);
    const b2 = evaluateB2BeforeCommit(b2Input);
    assert(
      classification === "NO_SEMANTIC_CHANGE" || b2.decision === "allow",
      `turn_${turn}_b2_indeterminate:${JSON.stringify(b2)}`,
    );
  }
  completed += 1;
}

const livingRoom = state.entities.find((entity) =>
  entity.entity_id === "air_conditioner:living_room"
);
const unscopedAirConditioner = state.entities.find((entity) =>
  entity.entity_id === "air_conditioner:unscoped"
);
const refrigerator = state.entities.find((entity) => entity.entity_id === "refrigerator:unscoped");
const washingMachine = state.entities.find((entity) => entity.entity_id === "washing_machine:unscoped");
assert(livingRoom?.status === "cancelled", "turn_88_living_room_not_cancelled");
assert(livingRoom?.attributes.horsepower === "2匹", "turn_85_scoped_horsepower_missing");
assert(
  unscopedAirConditioner?.attributes.horsepower !== "2匹",
  "turn_85_cross_entity_horsepower_contamination",
);
assert(refrigerator, "refrigerator_entity_not_persisted");
assert(washingMachine?.status === "deferred", "washing_machine_not_persisted_or_deferred");
assert(
  !Object.keys(refrigerator.constraints).some((key) => /horsepower|air_conditioner/i.test(key)),
  "refrigerator_cross_entity_constraint_contamination",
);
assert(
  /星期六|週六|周六|Saturday/i.test(String(state.delivery.preferred_date ?? "")),
  "turn_37_delivery_preference_writer_reader_mismatch",
);

const turn36Scope = canonicalTenantScopeFromAuthoritativeCompany(companyId);
assert(turn36Scope?.aiCompanyId === companyId, "turn36_authoritative_scope_failed");
const bounded = canAnswerBoundedNoCurrentEvidence({
  decision: classifyCurrentFactEvidence({
    knowledge_state: "lookup_required",
    current_evidence_count: 0,
  }),
  high_risk: false,
  explicit_human_request: false,
  threat: false,
  compliance_requires_human_review: false,
});
assert(bounded, "turn36_false_s0_handoff");

assert(completed === 103, `completed_${completed}`);
assert(falseSemanticMutation === 0, `false_semantic_mutation_${falseSemanticMutation}`);
assert(knownAnswerDeadEnd === 0, `known_answer_dead_end_${knownAnswerDeadEnd}`);
assert(unnecessaryReask === 0, `unnecessary_reask_${unnecessaryReask}`);
assert(runtimeFailures === 0, `runtime_failures_${runtimeFailures}`);
assert(terminalFailures === 0, `terminal_failures_${terminalFailures}`);
assert(fallbackCount / completed < 0.05, `fallback_rate_${fallbackCount / completed}`);

console.log(
  JSON.stringify({
    contract: "AI-ABC-C3-CANONICAL-103-SOURCE-REPLAY",
    completed,
    p0: 0,
    known_answer_dead_end: knownAnswerDeadEnd,
    unnecessary_reask: unnecessaryReask,
    fallback_count: fallbackCount,
    fallback_rate: fallbackCount / completed,
    runtime_failures: runtimeFailures,
    terminal_failures: terminalFailures,
    false_semantic_mutation: falseSemanticMutation,
    rpc_writes: rpcCalls,
    known_p0_regressions: knownResults,
  }),
);
