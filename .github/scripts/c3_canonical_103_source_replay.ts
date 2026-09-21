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
  if (turn === 25 || turn === 55 || turn === 102) {
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
  [25, (reply) => /(?:2|兩)/.test(reply) && !/[?？]/.test(reply)],
  [
    27,
    (reply) =>
      reply.includes("598") &&
      /(?:595|600)/.test(reply) &&
      !/(?:冷氣|空調).{0,20}(?:2|兩)/.test(reply),
  ],
  [40, (reply) => /B座|Ｂ座/.test(reply) && !reply.includes("A座")],
  [48, (reply) => /(?:2|兩)/.test(reply) && /窗口/.test(reply) && /安裝/.test(reply)],
  [50, (reply) => reply.includes("80") && reply.includes("100")],
  [55, (reply) => /(?:2|兩)/.test(reply) && !/[?？]/.test(reply)],
  [56, (reply) => /(?:595|600)/.test(reply) && !/(?:冷氣|空調).{0,20}(?:2|兩)/.test(reply)],
  [57, (reply) => /B座|Ｂ座/.test(reply) && !reply.includes("A座")],
  [58, (reply) => /星期六|週六|周六|Saturday/i.test(reply)],
  [59, (reply) => /(?:1|一)/.test(reply) && !/[?？]/.test(reply)],
  [68, (reply) => /1匹/.test(reply) && /1\.5匹/.test(reply)],
  [69, (reply) => /(?:並非|唔係|不是|not mandatory|not required)/i.test(reply)],
  [71, (reply) => /(?:未必|不一定|not necessarily)/i.test(reply) && /(?:確認|确认|confirm)/i.test(reply)],
  [73, (reply) => /(?:唔會當現價|不会当作现价|not be used as a current price)/i.test(reply)],
  [76, (reply) => /(?:唔會當現價|不会当作现价|not be used as a current price)/i.test(reply)],
  [80, (reply) => /(?:1\.|1。)/.test(reply) && /(?:付款|payment)/i.test(reply)],
  [90, (reply) => /(?:2|兩)/.test(reply) && !/[?？]/.test(reply)],
  [91, (reply) => /(?:項目|项目|Items)/.test(reply) && /(?:訂單|订单|Order)/.test(reply)],
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
        .reverse()
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
  const reply = outcome?.reply ?? recall.reply ?? "";
  const route = outcome?.reply
    ? outcome.route
    : recall.reply
      ? String(recall.metadata.response_route)
      : "orchestration_pass_through";
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
    const metadata = outcome?.persist_result === "read_only" && outcome.authority === "CONVERSATION_STATE" && outcome.state_path
      ? {
        response_route: outcome.route,
        commerce_authority: outcome.authority,
        commerce_state_revision: outcome.revision,
        commerce_state_persist_result: outcome.persist_result,
        commerce_state_persistence_classification: "NO_SEMANTIC_CHANGE",
        commerce_reason: outcome.reason,
        commerce_state_path: outcome.state_path,
        commerce_state_readback_proof: buildB2AuthoritativeReadbackProof(state, outcome.state_path),
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
  completed += 1;
}

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
