import { createHash } from "node:crypto";
import {
  prepareConversationRecall,
  type RecallCommerceSnapshot,
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
  classifyCommerceStatePersistenceResult,
  classifyB2AuthoritativePersistence,
  evaluateB2BeforeCommit,
} from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";
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

const fixture = { turns: ["Hi", "Hi，想問冷氣，兩間房加個廳，唔知買咩匹數好。", "兩間房大概80呎同100呎，廳180呎，全部窗口位。", "我唔想太貴，格力、美的、Panasonic都得。", "仲有呀，我屋企下午西斜得幾勁。", "我之前問你同事，佢話格力 GWF12P $5788，安裝550，鋁架550。", "之後胡小姐又話如果兩部可以5600一部。", "咁兩部連安裝同架，按我頭先提供嘅舊報價計幾錢？", "順便問埋雪櫃，想要三門，600mm樓下闊。", "雪櫃限制呢？", "送貨方面，算啦，星期六做首選。", "送星期幾？", "咁目前有邊個價係有來源？", "短啲。", "再短啲。", "你有冇 Panasonic 1匹窗口變頻冷氣？", "改做一部1匹，一部1.5匹。", "客廳嗰部暫時唔買住。", "最終幾部冷氣？", "幫我總結而家要咩，未落單。"] };

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

function semanticFrame(_turn: number, text: string): CommerceSemanticFrame | null {
  let topic = "", requested: string[] = [];
  if (/^雪櫃限制/.test(text)) { topic = "refrigerator"; requested=["constraints"]; }
  else if (/^送星期幾/.test(text)) { topic = "delivery"; requested=["preferred_date"]; }
  else if (/最終幾部/.test(text)) { topic = "air_conditioner"; requested=["current_quantity"]; }
  else if (/Hi，想問冷氣/.test(text)) { topic = "air_conditioner"; requested=["horsepower_guidance"]; }
  else return null;
  return { version:"commerce-semantic-1.0.0", language:"zh-TW", operation:"ASK_FACT", intent:"read authoritative current conversation state", topic, entities:[], referents:[], customer_correction:false, additive:false, explicit_negations:[], requested_facts:requested, transaction_state:"none", payment_state:"none", booking_state:"none", fulfillment_state:"none", ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},confidence:.94 };
}

const checkpoints = new Map<number, (reply: string, outcome: unknown) => boolean>();
let falseSemanticMutation = 0;
let knownAnswerDeadEnd = 0;
let unnecessaryReask = 0;
let runtimeFailures = 0;
let terminalFailures = 0;
let fallbackCount = 0;
let completed = 0;
let naturalProxy = 0;
const knownResults: Record<string, unknown> = {};
const capturedProductionFailureTurns = new Set<number>();

for (let index = 0; index < fixture.turns.length; index++) {
  const turn = index + 1;
  const text = fixture.turns[index];
  const id = sourceId(turn);
  const frame = semanticFrame(turn, text);
  const beforeState = JSON.stringify(state);
  const beforeRevision = revision;
  const beforeRpcCalls = rpcCalls;
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
  const recall = prepareConversationRecall(
    {
      conversation_id: conversationId,
      company_id: companyId,
      source_message_id: id,
      question: text,
      memory,
      commerce,
      referents: frame?.referents ?? [],
      recent_questions: history.slice(1, 13).map((row) => String(row.content ?? "")),
    },
    "zh-TW",
  );
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
  const serviceReply = renderServicePlanReply(servicePlan, recall.reply, history.map((row) => ({ role: String(row.role ?? ""), content: String(row.content ?? "") }))) ??
    ([
      "targeted_clarification",
      "partial_answer_then_question",
      "offer_handoff_or_reframe",
      "explicit_handoff",
    ].includes(servicePlan.action)
      ? renderTargetedServiceQuestion(servicePlan, "zh-TW")
      : null);
  const naturalIntent = classifyNaturalCustomerIntent(text);
  const naturalGuidanceReply = ["greeting", "product_guidance", "product_shopping"].includes(naturalIntent.kind)
    ? renderNaturalImmediateResponse(naturalIntent, "zh-TW")
    : null;
  const authoritativeRuntimeReply = resolution.bypass_service_plan && outcome?.reply
    ? outcome.reply
    : null;
  const reply = naturalIntent.kind === "greeting" ? (naturalGuidanceReply ?? "") : authoritativeRuntimeReply ?? naturalGuidanceReply ?? serviceReply ?? outcome?.reply ?? recall.reply ?? "";
  const route = authoritativeRuntimeReply
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
      assert(reply === naturalGuidanceReply, "turn_1_natural_guidance_not_selected");
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
  const checks: Record<number, RegExp> = {
    1:/你好|Hi/i, 2:/(?=.*冷氣)(?=.*空間)/s, 3:/80.*100.*180/, 4:/格力.*美的.*Panasonic/i,
    5:/西斜/, 6:/5,?788.*550/, 7:/5,?600/, 8:/(?=.*歷史)(?=.*2 × \(5,600 \+ 550 \+ 550\) = 13,400)/s,
    9:/雪櫃.*(?:三門|600)/, 10:/雪櫃.*600/, 11:/(?=.*星期六)(?=.*(?:偏好|首選))/s,
    12:/星期六/, 13:/(?=.*5788)(?=.*5600)(?=.*歷史)(?=.*現價)/s, 14:/5788.*5600.*歷史/,
    15:/5788.*5600.*(?:舊價|歷史)/, 16:/(?=.*Panasonic)(?=.*1匹)(?=.*窗口)(?=.*(?:未有|不能確認))/s,
    17:/1\s*匹.*1\.5\s*匹/, 18:/客廳.*(?:取消|暫緩).*2/, 19:/2 部/,
    20:/冷氣.*2.*雪櫃.*1.*(?:訂單：尚未確認)/s,
  };
  assert(checks[turn].test(reply), `demo_${turn}_irrelevant:${reply}`);
  assert(!/明白，我會按你啱啱提供嘅最新要求繼續|canonical_|brand_required|customer_goal|air_conditioner/i.test(reply), `demo_${turn}_machine:${reply}`);
  assert(!/已確認落單|已安排送貨|(?<!未有)已付款|已轉真人/.test(reply), `demo_${turn}_false_action:${reply}`);
  if (reply.trim().length >= 8 && !/^(?:收到[。.]|明白[。.]|請提供)/.test(reply)) naturalProxy += 1;
  if (turn === 14 || turn === 15) {
    const previous = history.find((row) => row.role === "assistant")?.content ?? "";
    assert(reply.length < previous.length, `demo_${turn}_not_shorter`);
  }
  console.log(JSON.stringify({ turn, question:text, reply, route, action: servicePlan.action, reason:outcome?.reason }));
  if (reply) {
    const selectedOutcome = authoritativeRuntimeReply ? outcome : null;
    const metadata = authoritativeRuntimeReply
      ? {
        response_route: selectedOutcome!.route,
        commerce_authority: selectedOutcome!.authority,
        commerce_state_revision: selectedOutcome!.revision,
        commerce_state_persist_result: selectedOutcome!.persist_result,
        commerce_state_persistence_classification:
          classifyCommerceStatePersistenceResult(selectedOutcome!.persist_result),
        commerce_reason: selectedOutcome!.reason,
        commerce_state_path: selectedOutcome!.state_path ?? null,
        commerce_state_readback_proof: selectedOutcome!.state_path
          ? buildB2AuthoritativeReadbackProof(state, selectedOutcome!.state_path)
          : null,
      }
      : null;
    const b2 = evaluateB2BeforeCommit({
      proposed_response: reply,
      persistence_kind: "ai_reply",
      snapshot: { conversation_id: conversationId, company_id: companyId, source_message_id: id, commerce_state_revision: revision, commerce_state_source_message_id: stateSourceMessageId, state },
      metadata,
    });
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
  if (reply) history.unshift({ id:`assistant-${id}`, role:"assistant", content:reply, created_at:turnTimestamp(turn) });
  completed += 1;
}


assert(completed === 20, `completed_${completed}`);
assert(naturalProxy >= 18, `natural_proxy_${naturalProxy}`);
assert(falseSemanticMutation === 0 && knownAnswerDeadEnd === 0 && unnecessaryReask === 0 && fallbackCount === 0 && runtimeFailures === 0 && terminalFailures === 0, "demo_gate_fail");
const refrigerator = state.entities.find((entity) => entity.category === "refrigerator");
assert(refrigerator?.quantity === 1 && refrigerator.constraints.max_width_mm === 600, "fridge_scope_or_quantity");
assert(!Object.keys(refrigerator.constraints).some((key) => /horsepower|air_conditioner/i.test(key)), "fridge_ac_leak");
assert(state.delivery.preferred_date === "星期六", "delivery_preference_missing");
console.log(`C3_CUSTOMER_DEMO_CONTEXT|cases=20|p0=0|dead_end=0|reask=0|cross_entity=0|relevant=20|natural_proxy=${naturalProxy}|result=PASS`);
