import type { CommerceRuntimeOutcome } from "./commerce-state-runtime.ts";

export type CanonicalCommerceResolutionKind =
  | "AUTHORITATIVE_MUTATION"
  | "AUTHORITATIVE_READ_ONLY"
  | "TARGETED_READ_ONLY_CLARIFICATION"
  | "UNRESOLVED";

export interface CanonicalCommerceResolution {
  kind: CanonicalCommerceResolutionKind;
  bypass_service_plan: boolean;
  skip_memory_refresh: boolean;
  reply_authoritative: boolean;
  no_semantic_change: boolean;
}

const READ_ONLY_RESOLVED = new Set([
  "read_only_current_state_query_resolved",
  "read_only_memory_or_current_state_recall_resolved",
  "read_only_attribute_constraint_query_resolved",
  "read_only_current_state_aggregate_query_resolved",
]);

const READ_ONLY_TARGETED_CLARIFICATION = new Set([
  "read_only_attribute_constraint_query_unresolved",
  "read_only_current_state_aggregate_query_unresolved",
]);

const READ_ONLY_REASONS = new Set([...READ_ONLY_RESOLVED, ...READ_ONLY_TARGETED_CLARIFICATION]);

export function isCanonicalReadOnlyCommerceReason(reason: unknown): boolean {
  return typeof reason === "string" && READ_ONLY_REASONS.has(reason);
}

export function resolveCanonicalCommerceResolution(input: {
  outcome: CommerceRuntimeOutcome | null;
  authoritative_address_correction: boolean;
}): CanonicalCommerceResolution {
  if (input.authoritative_address_correction) {
    return {
      kind: "AUTHORITATIVE_MUTATION",
      bypass_service_plan: true,
      skip_memory_refresh: false,
      reply_authoritative: true,
      no_semantic_change: false,
    };
  }
  const outcome = input.outcome;
  if (!outcome) {
    return {
      kind: "UNRESOLVED",
      bypass_service_plan: false,
      skip_memory_refresh: false,
      reply_authoritative: false,
      no_semantic_change: false,
    };
  }
  if (READ_ONLY_REASONS.has(outcome.reason)) {
    const validReadOnlyEnvelope =
      outcome.persist_result === "read_only" && outcome.route === "commerce_state_answer";
    if (!validReadOnlyEnvelope) {
      return {
        kind: "UNRESOLVED",
        bypass_service_plan: false,
        skip_memory_refresh: false,
        reply_authoritative: false,
        no_semantic_change: false,
      };
    }
    const resolved =
      READ_ONLY_RESOLVED.has(outcome.reason) &&
      outcome.authority === "CONVERSATION_STATE" &&
      Boolean(outcome.reply);
    const targeted = READ_ONLY_TARGETED_CLARIFICATION.has(outcome.reason) && Boolean(outcome.reply);
    return {
      kind: resolved
        ? "AUTHORITATIVE_READ_ONLY"
        : targeted
          ? "TARGETED_READ_ONLY_CLARIFICATION"
          : "UNRESOLVED",
      bypass_service_plan: resolved || targeted,
      skip_memory_refresh: true,
      reply_authoritative: resolved,
      no_semantic_change: true,
    };
  }
  const resolvedMutation =
    outcome.reason === "explicit_entity_status_change_applied" &&
    outcome.route === "commerce_state_answer" &&
    outcome.authority === "CONVERSATION_STATE" &&
    Boolean(outcome.reply);
  return {
    kind: resolvedMutation ? "AUTHORITATIVE_MUTATION" : "UNRESOLVED",
    bypass_service_plan: resolvedMutation,
    skip_memory_refresh: false,
    reply_authoritative: resolvedMutation,
    no_semantic_change: false,
  };
}
