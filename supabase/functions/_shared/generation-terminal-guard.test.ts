import {
  GENERATION_RESPONSE_BUDGET_MS,
  GENERATION_TERMINAL_RESERVE_MS,
  GENERATION_WORK_BUDGET_MS,
  historicalQuoteValidityReply,
  isRecoverableTerminalError,
  isRecoverableTerminalStatus,
  runWithTerminalDeadline,
  terminalFailureDiagnostic,
  terminalRecoveryReply,
} from "./generation-terminal-guard.ts";
import { executionFailure, safeB2FailureCode } from "./execution-failure.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { buildCurrentPriceValidityAnswer } from "./commerce-state-runtime-base.ts";
import { evaluateB2BeforeCommit } from "./pre-send-conversion-supervisor.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("C3 generation budget leaves a deterministic terminal reserve", () => {
  assert(GENERATION_WORK_BUDGET_MS === 75_000, "work budget drifted");
  assert(GENERATION_TERMINAL_RESERVE_MS === 15_000, "terminal reserve drifted");
  assert(GENERATION_RESPONSE_BUDGET_MS === 90_000, "response budget drifted");
  assert(
    GENERATION_RESPONSE_BUDGET_MS < 120_000,
    "widget observation SLA exceeded",
  );
  assert(
    GENERATION_RESPONSE_BUDGET_MS < 150_000,
    "Supabase idle limit exceeded",
  );
});

Deno.test("C3 deadline aborts work and returns one safe fallback", async () => {
  let aborted = false;
  let fallbackCalls = 0;
  let settleWork!: () => void;
  const workSettled = new Promise<void>((resolve) => settleWork = resolve);
  const result = await runWithTerminalDeadline(
    async (signal) => {
      signal.addEventListener("abort", () => aborted = true, { once: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      settleWork();
      return "late";
    },
    async () => {
      fallbackCalls += 1;
      return "safe";
    },
    5,
  );
  assert(
    result.kind === "deadline" && result.value === "safe",
    "fallback missing",
  );
  assert(aborted, "in-flight work was not aborted");
  assert(fallbackCalls === 1, "fallback was not exactly once");
  await workSettled;
});

Deno.test("C3 completed work does not invoke fallback", async () => {
  let fallbackCalls = 0;
  const result = await runWithTerminalDeadline(
    async () => "ok",
    async () => {
      fallbackCalls += 1;
      return "safe";
    },
    50,
  );
  assert(result.kind === "completed" && result.value === "ok", "work lost");
  assert(fallbackCalls === 0, "fallback ran after success");
});

Deno.test("C3 transient and B2 terminal failures are recoverable", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert(
      isRecoverableTerminalStatus(status),
      `status ${status} not recoverable`,
    );
  }
  assert(
    !isRecoverableTerminalStatus(400),
    "invalid input must not be recovered",
  );
  assert(
    !isRecoverableTerminalStatus(404),
    "missing conversation must not be recovered",
  );
  assert(
    isRecoverableTerminalError("commerce_state_runtime_b2_block"),
    "turn-5 B2 block missing",
  );
  assert(
    isRecoverableTerminalError("ai_reply_commit_b2_indeterminate"),
    "B2 indeterminate missing",
  );
  assert(
    isRecoverableTerminalError("AI service error"),
    "LLM terminal error missing",
  );
  assert(
    isRecoverableTerminalError("Internal KB processing error"),
    "KB terminal error missing",
  );
  assert(
    !isRecoverableTerminalError("superseded_source"),
    "stale source must not be recovered",
  );
  assert(
    !isRecoverableTerminalError("required_escalation_rpc_transport_error"),
    "uncertain handoff must not race an AI fallback",
  );
});

Deno.test("Task1C terminal B2 outcomes retain their actual failure class", () => {
  const source = "33333333-3333-4333-8333-333333333333";
  for (const [reason, code, stage, inner, status] of [
    ["canonical_kb_direct_answer_commit_b2_block", "B2_SUPERVISION_BLOCKED", "canonical_validation", "KNOWN_CONTEXT_RECONFIRMATION", 409],
    ["catalogue_clarification_commit_b2_block", "B2_SUPERVISION_BLOCKED", "canonical_validation", "CURRENT_QUOTE_NOT_PROVEN", 409],
    ["b2_supervision_blocked", "B2_SUPERVISION_BLOCKED", "canonical_validation", "UNPROVEN_CORRECTION_COMMIT", 409],
    ["commerce_state_runtime_b2_indeterminate", "B2_SUPERVISION_INDETERMINATE", "persistence", "LATEST_CORRECTION_UNRESOLVED", 409],
    ["ai_reply_commit_b2_indeterminate", "B2_SUPERVISION_INDETERMINATE", "persistence", "SUPERVISOR_READ_ERROR", 409],
    ["b2_supervision_indeterminate", "B2_SUPERVISION_INDETERMINATE", "persistence", "COMMERCE_CONTEXT_CHANGED_BEFORE_COMMIT", 503],
  ] as const) {
    const failure = terminalFailureDiagnostic(reason, {
      source_message_id: source, http_status: status, b2_code: inner,
    });
    assert(failure.code === code, reason + " was mislabeled as a semantic failure");
    assert(failure.stage === stage, reason + " lost its stage");
    assert(failure.b2_code === inner, reason + " lost the closed inner B2 label");
    assert(failure.source_message_id === source && failure.http_status === status, "source/status lost");
    assert(failure.retryable === false, "B2 refusal must not grant an automatic retry");
    assert(!JSON.stringify(failure).includes(reason), "internal route was reflected");
  }
  const withoutInner = terminalFailureDiagnostic("canonical_kb_direct_answer_commit_b2_block");
  assert(withoutInner.code === "B2_SUPERVISION_BLOCKED", "a missing inner label must not invent a semantic failure");
  assert(!("b2_code" in withoutInner), "missing inner B2 label was invented");
});

Deno.test("Task1C terminal diagnostics reject raw B2 details and retain closed labels only", () => {
  const privateDetail = "Bearer PRIVATE-SECRET customer@example.invalid entities.0.price:2100";
  for (const inner of [privateDetail, "NEW_UNRECOGNIZED_REASON", "B2_ALLOW", null, {code:"KNOWN_CONTEXT_RECONFIRMATION",detail:privateDetail}]) {
    const failure = terminalFailureDiagnostic("canonical_kb_direct_answer_commit_b2_block", {
      b2_code: inner, request_id: privateDetail, source_message_id: privateDetail,
    });
    assert(failure.code === "B2_SUPERVISION_BLOCKED", "closed outer failure lost");
    assert(!("b2_code" in failure), "untrusted or non-failure B2 label reflected");
    assert(!JSON.stringify(failure).includes("PRIVATE") && !JSON.stringify(failure).includes("customer@"), "private detail leaked");
  }
  assert(safeB2FailureCode("KNOWN_CONTEXT_RECONFIRMATION") === "KNOWN_CONTEXT_RECONFIRMATION", "known B2 label rejected");
  assert(safeB2FailureCode("CANCELLED_ENTITY_RESTORATION") === "CANCELLED_ENTITY_RESTORATION", "conditional B2 label rejected");
  assert(safeB2FailureCode("B2_ALLOW_CURRENT_KB_SELLING_PRICE") === null, "success label accepted as failure");
  const unrelated = executionFailure("LLM_INVALID_OUTPUT", {b2_code:"KNOWN_CONTEXT_RECONFIRMATION"});
  assert(!("b2_code" in unrelated), "unrelated provider failure acquired B2 evidence");
  assert(!JSON.stringify(terminalFailureDiagnostic(privateDetail)).includes(privateDetail), "raw reason reflected");
});

Deno.test("Task1C B2 diagnostic sanitization cannot turn a refusal into a retryable provider error", () => {
  for (const [code, stage] of [["B2_SUPERVISION_BLOCKED","canonical_validation"],["B2_SUPERVISION_INDETERMINATE","persistence"]] as const) {
    const failure = executionFailure(code, {stage:"provider_http",http_status:503,b2_code:"KNOWN_CONTEXT_RECONFIRMATION"});
    assert(failure.stage === stage && failure.retryable === false, "B2 stage/retry policy was overridden");
    const normalized = executionFailure(failure.code, failure);
    assert(JSON.stringify(normalized) === JSON.stringify(failure), "closed B2 diagnostic did not survive normalization");
  }
  for (const [reason, code, stage, retryable] of [
    ["semantic_interpretation_failed", "SEMANTIC_INTERPRETER_UNAVAILABLE", "unexpected", false],
    ["canonical_memory_commit_failed", "PERSISTENCE_FAILED", "persistence", false],
    ["generation_work_budget_exhausted", "LLM_TIMEOUT", "timeout", true],
  ] as const) {
    const failure = terminalFailureDiagnostic(reason);
    assert(failure.code === code && failure.stage === stage && failure.retryable === retryable, "non-B2 behavior changed: " + reason);
  }
});

Deno.test("Task1C truthful B2 terminal diagnostic preserves the existing safe customer reply", () => {
  const state = createEmptyConversationCommerceState();
  const failure = terminalFailureDiagnostic("canonical_kb_direct_answer_commit_b2_block", {b2_code:"KNOWN_CONTEXT_RECONFIRMATION"});
  for (const language of ["zh-TW", "zh-CN", "en"] as const) {
    const reply = terminalRecoveryReply(language, failure);
    assert(reply === terminalRecoveryReply(language, executionFailure("SEMANTIC_INTERPRETER_UNAVAILABLE")), "customer recovery text unexpectedly changed");
    assert(!reply.includes(failure.b2_code!) && !reply.includes(failure.code), "internal B2 labels were exposed to the customer");
    const decision = evaluateB2BeforeCommit({proposed_response:reply,persistence_kind:"ai_reply",snapshot:{
      conversation_id:"11111111-1111-4111-8111-111111111111",company_id:"22222222-2222-4222-8222-222222222222",
      source_message_id:"33333333-3333-4333-8333-333333333333",commerce_state_revision:5,
      commerce_state_source_message_id:"33333333-3333-4333-8333-333333333333",state,
    },metadata:{response_route:"terminal_failure_recovery"}});
    assert(decision.decision === "allow", "unchanged recovery no longer passes B2: " + decision.code);
  }
});

Deno.test("C3 historical quote validity reply passes frozen B2 without asserting current price", () => {
  const state = createEmptyConversationCommerceState();
  state.quotes = [{
    quote_id: "historical-8000",
    entity_id: null,
    amount: 8000,
    currency: "HKD",
    quote_type: "customer_reported_historical",
    validity_status: "historical",
    conditions: {},
    provenance: { source_type: "customer", source_message_id: "source-turn-5" },
  }];
  for (const language of ["zh-TW", "zh-CN", "en"] as const) {
    const frozenDecision = evaluateB2BeforeCommit({
      proposed_response: buildCurrentPriceValidityAnswer(language),
      persistence_kind: "ai_reply",
      snapshot: {
        conversation_id: "11111111-1111-4111-8111-111111111111",
        company_id: "22222222-2222-4222-8222-222222222222",
        source_message_id: "33333333-3333-4333-8333-333333333333",
        commerce_state_revision: 5,
        commerce_state_source_message_id:
          "33333333-3333-4333-8333-333333333333",
        state,
      },
    });
    assert(frozenDecision.decision === "allow", `${language} authoritative historical-price disclaimer was blocked`);
    const reply = historicalQuoteValidityReply(language);
    const decision = evaluateB2BeforeCommit({
      proposed_response: reply,
      persistence_kind: "ai_reply",
      snapshot: {
        conversation_id: "11111111-1111-4111-8111-111111111111",
        company_id: "22222222-2222-4222-8222-222222222222",
        source_message_id: "33333333-3333-4333-8333-333333333333",
        commerce_state_revision: 5,
        commerce_state_source_message_id:
          "33333333-3333-4333-8333-333333333333",
        state,
      },
      metadata: {
        commerce_reason: "previous_quote_not_authoritative_for_current_price",
      },
    });
    assert(
      decision.decision === "allow",
      `${language} reply blocked: ${decision.code}`,
    );
    assert(!reply.includes("8000"), `${language} repeated a historical amount`);
  }
});

Deno.test("C3 terminal fallback stays B2-safe in every supported language", () => {
  const state = createEmptyConversationCommerceState();
  for (const language of ["zh-TW", "zh-CN", "en"] as const) {
    const decision = evaluateB2BeforeCommit({
      proposed_response: terminalRecoveryReply(language),
      persistence_kind: "ai_reply",
      snapshot: {
        conversation_id: "11111111-1111-4111-8111-111111111111",
        company_id: "22222222-2222-4222-8222-222222222222",
        source_message_id: "33333333-3333-4333-8333-333333333333",
        commerce_state_revision: 5,
        commerce_state_source_message_id:
          "33333333-3333-4333-8333-333333333333",
        state,
      },
      metadata: { response_route: "terminal_failure_recovery" },
    });
    assert(
      decision.decision === "allow",
      `${language} fallback blocked: ${decision.code}`,
    );
  }
});
