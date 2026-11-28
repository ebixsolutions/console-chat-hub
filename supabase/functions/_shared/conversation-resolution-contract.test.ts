import {
  isCanonicalReadOnlyCommerceReason,
  resolveCanonicalCommerceResolution,
} from "./conversation-resolution-contract.ts";
import type { CommerceRuntimeOutcome } from "./commerce-state-runtime.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const outcome = (
  reason: string,
  overrides: Partial<CommerceRuntimeOutcome> = {},
): CommerceRuntimeOutcome => ({
  authority: "CONVERSATION_STATE",
  reply: "authoritative reply",
  revision: 9,
  persist_result: "read_only",
  reason,
  state_path: "entities.0.quantity",
  route: "commerce_state_answer",
  ...overrides,
});

Deno.test("shared resolution contract covers all read-only P0 classes", () => {
  for (const reason of [
    "read_only_current_state_query_resolved",
    "read_only_memory_or_current_state_recall_resolved",
    "read_only_attribute_constraint_query_resolved",
    "read_only_current_state_aggregate_query_resolved",
  ]) {
    assert(isCanonicalReadOnlyCommerceReason(reason), reason);
    const decision = resolveCanonicalCommerceResolution({
      outcome: outcome(reason),
      authoritative_address_correction: false,
    });
    assert(decision.kind === "AUTHORITATIVE_READ_ONLY", reason);
    assert(decision.bypass_service_plan, reason);
    assert(decision.skip_memory_refresh && decision.no_semantic_change, reason);
  }
});

Deno.test("shared resolution contract preserves targeted fail-closed clarification", () => {
  for (const reason of [
    "read_only_attribute_constraint_query_unresolved",
    "read_only_current_state_aggregate_query_unresolved",
  ]) {
    const decision = resolveCanonicalCommerceResolution({
      outcome: outcome(reason, { authority: "INSUFFICIENT_INFORMATION" }),
      authoritative_address_correction: false,
    });
    assert(decision.kind === "TARGETED_READ_ONLY_CLARIFICATION", reason);
    assert(decision.bypass_service_plan && decision.no_semantic_change, reason);
  }
});

Deno.test("shared resolution contract rejects malformed read-only envelopes", () => {
  const mutationReceipt = resolveCanonicalCommerceResolution({
    outcome: outcome("read_only_current_state_query_resolved", {
      persist_result: "success",
    }),
    authoritative_address_correction: false,
  });
  assert(mutationReceipt.kind === "UNRESOLVED", "mutation receipt accepted");
  assert(!mutationReceipt.skip_memory_refresh, "invalid envelope skipped memory");

  const wrongAuthority = resolveCanonicalCommerceResolution({
    outcome: outcome("read_only_memory_or_current_state_recall_resolved", {
      authority: "CURRENT_KB_REQUIRED",
    }),
    authoritative_address_correction: false,
  });
  assert(wrongAuthority.kind === "UNRESOLVED", "wrong authority accepted");
});

Deno.test("shared resolution contract prioritizes committed corrections and cancellations", () => {
  const correction = resolveCanonicalCommerceResolution({
    outcome: null,
    authoritative_address_correction: true,
  });
  assert(correction.kind === "AUTHORITATIVE_MUTATION", "correction unresolved");
  assert(correction.bypass_service_plan && correction.reply_authoritative, "correction precedence");

  const cancellation = resolveCanonicalCommerceResolution({
    outcome: outcome("explicit_entity_status_change_applied", {
      persist_result: "success",
    }),
    authoritative_address_correction: false,
  });
  assert(cancellation.kind === "AUTHORITATIVE_MUTATION", "cancellation unresolved");
});

Deno.test("shared resolution contract gives all complete runtime envelopes precedence", () => {
  for (const [reason, route, persistResult] of [
    ["historical_price_exclusion_acknowledged", "commerce_state_answer", "no_semantic_change"],
    ["previous_quote_not_authoritative_for_current_price", "commerce_state_answer", "no_semantic_change"],
    ["read_only_transaction_summary_resolved", "commerce_transaction_summary", "no_semantic_change"],
    ["payment_checklist_from_current_state", "commerce_transaction_summary", "success"],
  ] as const) {
    const decision = resolveCanonicalCommerceResolution({
      outcome: outcome(reason, { route, persist_result: persistResult }),
      authoritative_address_correction: false,
    });
    assert(decision.bypass_service_plan, reason);
    assert(decision.reply_authoritative, reason);
    assert(
      decision.no_semantic_change === (persistResult === "no_semantic_change"),
      reason,
    );
  }
});
