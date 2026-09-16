import {
  GENERATION_RESPONSE_BUDGET_MS,
  GENERATION_TERMINAL_RESERVE_MS,
  GENERATION_WORK_BUDGET_MS,
  historicalQuoteValidityReply,
  isRecoverableTerminalError,
  isRecoverableTerminalStatus,
  runWithTerminalDeadline,
  terminalRecoveryReply,
} from "./generation-terminal-guard.ts";
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
  const result = await runWithTerminalDeadline(
    async (signal) => {
      signal.addEventListener("abort", () => aborted = true, { once: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
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
    assert(
      frozenDecision.code === "CURRENT_QUOTE_WITHOUT_VERIFIED_AMOUNT",
      `${language} did not reproduce the turn-5 B2 root cause`,
    );
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
