/**
 * PR-5 Task 3 — Full Escalation shadow adapter.
 *
 * Shadow-only:
 * - no DB writes
 * - no network calls
 * - no status changes
 * - no handoff RPC calls
 * - no live routing changes
 *
 * It consumes only signals already verified in the current generate-reply turn.
 * Unavailable providers remain unavailable; nothing is invented.
 */

import {
  availableSignal,
  createEscalationContextBase,
  escalationFeatureFlagsFromEnv,
  type EscalationContext,
  type EscalationRuleId,
  type RagMatchState,
} from "./escalation-signals.ts";
import { evaluateFullEscalationRuleset } from "./escalation-rules.ts";

export interface EscalationShadowInput {
  conversation_id: string;
  source_message_id: string | null;
  latest_message_content: string;
  conversation_status: string;
  assigned_agent_id: string | null;
  explicit_request: boolean;
  greeting_or_trivial?: boolean;
  rag_match_state?: RagMatchState;
  failure_type?: string | null;
  expected_tenant_id?: string;
}

export interface EscalationShadowResult {
  evaluated: boolean;
  matched_rule: EscalationRuleId | null;
  decision: string;
  reason_code: string;
  signal_gaps: string[];
  provider_warnings: string[];
}

/**
 * Returns null unless ESC_SHADOW_MODE=true.
 *
 * Important:
 * `ESC_ENABLE_*` values only determine which rules are evaluated in SHADOW.
 * They never activate live persistence from this module.
 */
export function evaluateEscalationShadow(
  input: EscalationShadowInput,
  env: { get(name: string): string | undefined },
): EscalationShadowResult | null {
  const flags = escalationFeatureFlagsFromEnv(env);
  if (!flags.shadow_mode) return null;

  if (!input.source_message_id) {
    return {
      evaluated: false,
      matched_rule: null,
      decision: "fallback_r1_only",
      reason_code: "shadow_missing_source_message_id",
      signal_gaps: ["source_message_id"],
      provider_warnings: [],
    };
  }

  const context: EscalationContext = createEscalationContextBase({
    conversation_id: input.conversation_id,
    source_message_id: input.source_message_id,
    latest_message_content: input.latest_message_content,
    explicit_request: input.explicit_request,
    expected_tenant_id: input.expected_tenant_id,
  });

  // Only bind signals already known by current generate-reply.
  context.conversation_status = availableSignal(
    input.conversation_status,
    "conversation_history",
  );
  context.assigned_agent_id = availableSignal(
    input.assigned_agent_id,
    "conversation_history",
  );
  if (typeof input.greeting_or_trivial === "boolean") {
    context.greeting_or_trivial = availableSignal(
      input.greeting_or_trivial,
      "local_classifier",
    );
  }

  if (input.rag_match_state) {
    context.rag_match_state = availableSignal(
      input.rag_match_state,
      "kb_rag",
    );
  }

  if (input.failure_type) {
    context.failure_type = availableSignal(
      input.failure_type,
      "runtime",
    );
  }

  const enabled = new Set<EscalationRuleId>();

  // R1 is safe to evaluate because explicit_request is locally verified.
  enabled.add("R1");

  // All other rules stay opt-in even in shadow.
  if (flags.enable_full_ruleset || flags.enable_e2) enabled.add("E2");
  if (flags.enable_full_ruleset || flags.enable_e1) enabled.add("E1");
  if (flags.enable_full_ruleset || flags.enable_r2) enabled.add("R2");
  if (flags.enable_full_ruleset || flags.enable_r3) enabled.add("R3");
  if (flags.enable_full_ruleset || flags.enable_p2) enabled.add("P2");
  if (flags.enable_full_ruleset || flags.enable_r4) enabled.add("R4");
  if (flags.enable_full_ruleset || flags.enable_p1) enabled.add("P1");

  // Existing live S0 remains independently owned by generate-reply. Shadow S0
  // is only evaluated when the caller supplies a verified runtime failure.
  if (input.failure_type || input.rag_match_state === "unavailable") {
    enabled.add("S0");
  }

  const result = evaluateFullEscalationRuleset(context, {
    activation: { enabled },
  });

  return {
    evaluated: true,
    matched_rule: result.matched_rule,
    decision: result.decision,
    reason_code: result.reason_code,
    signal_gaps: result.signal_gaps,
    provider_warnings: result.provider_warnings,
  };
}
