/**
 * PR-5 Task 2 — Full Escalation pure first-match decision engine.
 *
 * Authoritative runtime order:
 * E2 → E1 → R1 → S0 → R2 → R3 → P2 → R4 → P1
 *
 * PURE ONLY:
 * - no DB/network writes
 * - no message insertion
 * - no status mutation
 * - no live routing
 *
 * Required rules return `handoff`.
 * Recommended rules return `recommend_handoff` (pause/agent review semantics).
 * Suggested P1 returns `suggest_handoff` (AI may continue).
 */

import {
  ESCALATION_FIRST_MATCH_ORDER,
  ESCALATION_RULESET_VERSION,
  type EscalationContext,
  type EscalationDecision,
  type EscalationRuleId,
  type SignalValue,
  validateEscalationContext,
} from "./escalation-signals.ts";

export const MAX_CLARIFICATIONS = 1 as const;

export interface EscalationRuleActivation {
  enabled: ReadonlySet<EscalationRuleId>;
}

export interface FullRulesetEvaluationOptions {
  activation: EscalationRuleActivation;
}

function isAvailable<T>(signal: SignalValue<T>): signal is SignalValue<T> & { value: T } {
  return signal.provenance.availability === "available" && signal.value !== null;
}

function signalGap<T>(name: string, signal: SignalValue<T>, gaps: Set<string>): void {
  if (!isAvailable(signal)) gaps.add(name);
}

function decision(
  matchedRule: EscalationRuleId | null,
  kind: EscalationDecision["decision"],
  priority: EscalationDecision["priority"],
  reasonCode: string,
  gaps: Set<string>,
  warnings: string[],
): EscalationDecision {
  return {
    ruleset_version: ESCALATION_RULESET_VERSION,
    matched_rule: matchedRule,
    decision: kind,
    priority,
    reason_code: reasonCode,
    signal_gaps: [...gaps],
    provider_warnings: warnings,
  };
}

function isResolved(context: EscalationContext): boolean {
  return isAvailable(context.conversation_status) && context.conversation_status.value === "resolved";
}

function isExistingHumanControl(context: EscalationContext): boolean {
  return (
    isAvailable(context.conversation_status) &&
    context.conversation_status.value === "pending" &&
    isAvailable(context.assigned_agent_id) &&
    typeof context.assigned_agent_id.value === "string" &&
    context.assigned_agent_id.value.length > 0
  );
}

function isGreetingOnly(context: EscalationContext): boolean {
  return isAvailable(context.greeting_or_trivial) && context.greeting_or_trivial.value === true;
}

function hasCriticalSignalInSameTurn(context: EscalationContext): boolean {
  return (
    (isAvailable(context.explicit_request) && context.explicit_request.value === true) ||
    (isAvailable(context.threat_flag) && context.threat_flag.value === true) ||
    (isAvailable(context.compliance_jurisdiction_requires_human_review) &&
      context.compliance_jurisdiction_requires_human_review.value === true) ||
    (isAvailable(context.topic_risk_level) && context.topic_risk_level.value === "high")
  );
}

function greetingSuppressesNonCritical(context: EscalationContext): boolean {
  return isGreetingOnly(context) && !hasCriticalSignalInSameTurn(context);
}

function trendHasTwoConsecutiveDrops(values: number[]): boolean {
  if (values.length < 3) return false;
  let drops = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < values[i - 1]) {
      drops += 1;
      if (drops >= 2) return true;
    } else {
      drops = 0;
    }
  }
  return false;
}

function threshold(
  context: EscalationContext,
  key: keyof NonNullable<EscalationContext["tenant_config"]>,
  gaps: Set<string>,
): number | null {
  const raw = context.tenant_config?.[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    gaps.add(`tenant_config.${String(key)}`);
    return null;
  }
  return raw;
}

function maxClarifications(context: EscalationContext): number {
  const configured = context.tenant_config?.max_clarifications;
  // v1.6 freezes MAX_CLARIFICATIONS=1. A tenant config cannot expand it.
  if (typeof configured === "number" && Number.isInteger(configured)) {
    return Math.max(0, Math.min(MAX_CLARIFICATIONS, configured));
  }
  return MAX_CLARIFICATIONS;
}

function shouldClarify(context: EscalationContext, gaps: Set<string>): boolean {
  signalGap("clarification_attempts", context.clarification_attempts, gaps);
  if (!isAvailable(context.clarification_attempts)) return false;
  return context.clarification_attempts.value < maxClarifications(context);
}

function evaluateE2(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  signalGap("threat_flag", context.threat_flag, gaps);
  signalGap(
    "compliance_jurisdiction_requires_human_review",
    context.compliance_jurisdiction_requires_human_review,
    gaps,
  );

  const match =
    (isAvailable(context.threat_flag) && context.threat_flag.value === true) ||
    (isAvailable(context.compliance_jurisdiction_requires_human_review) &&
      context.compliance_jurisdiction_requires_human_review.value === true);

  return match ? decision("E2", "handoff", "urgent", "compliance_trigger", gaps, warnings) : null;
}

function evaluateE1(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  signalGap("topic_risk_level", context.topic_risk_level, gaps);
  signalGap("rag_match_state", context.rag_match_state, gaps);

  if (!isAvailable(context.topic_risk_level) || context.topic_risk_level.value !== "high") return null;
  if (!isAvailable(context.rag_match_state)) return null;

  const rag = context.rag_match_state.value;

  // Frozen v1.6: unavailable must route to S0, never E1.
  if (rag === "unavailable") return null;

  const normalHighRiskGap = rag === "no_match" || rag === "partial_match" || rag === "conflict";
  const localNotChecked =
    rag === "not_checked" &&
    isAvailable(context.verified_local_risk_classification) &&
    context.verified_local_risk_classification.value === true;

  if (rag === "not_checked" && !isAvailable(context.verified_local_risk_classification)) {
    gaps.add("verified_local_risk_classification");
  }

  if (!(normalHighRiskGap || localNotChecked)) return null;

  if (isAvailable(context.high_value_order) && context.high_value_order.value === true) {
    warnings.push("E1_HIGH_VALUE_PRIORITY_ENHANCER");
  }

  return decision("E1", "handoff", "urgent", "high_risk_topic", gaps, warnings);
}

function evaluateR1(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  signalGap("explicit_request", context.explicit_request, gaps);
  if (!isAvailable(context.explicit_request) || context.explicit_request.value !== true) return null;

  if (isAvailable(context.pure_handoff_negation) && context.pure_handoff_negation.value === true) {
    return null;
  }

  return decision("R1", "handoff", "normal", "explicit_human_request", gaps, warnings);
}

function evaluateS0(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  // Explicit provider unavailable state is an S0-class failure even when a
  // numeric retry counter is not available.
  const ragUnavailable = isAvailable(context.rag_match_state) && context.rag_match_state.value === "unavailable";
  const policyUnavailable =
    isAvailable(context.policy_match_state) && context.policy_match_state.value === "unavailable";

  const failureType = isAvailable(context.failure_type) ? context.failure_type.value : null;
  const immediateLlmFailure =
    failureType === "LLM_TIMEOUT" ||
    failureType === "LLM_NETWORK_ERROR" ||
    failureType === "LLM_NON_2XX" ||
    failureType === "LLM_EMPTY_RESPONSE";

  if (ragUnavailable || policyUnavailable || immediateLlmFailure) {
    return decision("S0", "handoff", "high", "system_or_upstream_failure", gaps, warnings);
  }

  if (failureType) {
    signalGap("upstream_failure_count", context.upstream_failure_count, gaps);
    const maxRetries = threshold(context, "s0_max_retries", gaps);
    if (
      maxRetries !== null &&
      isAvailable(context.upstream_failure_count) &&
      context.upstream_failure_count.value >= maxRetries
    ) {
      return decision("S0", "handoff", "high", "system_or_upstream_failure", gaps, warnings);
    }
  }

  return null;
}

function evaluateR2(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  signalGap("same_intent_repeated", context.same_intent_repeated, gaps);
  signalGap("consecutive_no_answer", context.consecutive_no_answer, gaps);
  signalGap("rag_match_state", context.rag_match_state, gaps);

  if (!isAvailable(context.rag_match_state)) return null;
  if (context.rag_match_state.value === "unavailable") return null;
  if (context.rag_match_state.value === "confident_match") return null; // G-5

  const maxNoAnswer = threshold(context, "max_consecutive_no_answer", gaps);
  if (maxNoAnswer === null) return null;

  const repeated = isAvailable(context.same_intent_repeated) && context.same_intent_repeated.value === true;
  const noAnswerCount = isAvailable(context.consecutive_no_answer) ? context.consecutive_no_answer.value : null;
  const ragGap = context.rag_match_state.value === "no_match" || context.rag_match_state.value === "partial_match";

  if (!repeated || noAnswerCount === null || !ragGap) return null;

  const clarificationAttempts = isAvailable(context.clarification_attempts)
    ? context.clarification_attempts.value
    : null;
  const clarificationCap = maxClarifications(context);

  if (noAnswerCount < maxNoAnswer && shouldClarify(context, gaps)) {
    return decision("R2", "clarify", null, "clarification_required_before_r2", gaps, warnings);
  }

  // G2 closure: after the one allowed clarification, an exact repeated intent
  // with the same unresolved RAG gap must not loop back to AI merely because
  // the assistant clarification reset consecutive_no_answer.
  if (clarificationAttempts !== null && clarificationCap > 0 && clarificationAttempts >= clarificationCap) {
    return decision("R2", "handoff", "high", "repeated_after_clarification", gaps, warnings);
  }

  if (noAnswerCount < maxNoAnswer) return null;

  return decision("R2", "handoff", "high", "repeated_unanswered_query", gaps, warnings);
}

function evaluateR3(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  if (greetingSuppressesNonCritical(context)) return null; // G-1

  if (isAvailable(context.sentiment_recovered_same_turn) && context.sentiment_recovered_same_turn.value === true) {
    return null; // G-4
  }

  signalGap("anger_flag", context.anger_flag, gaps);
  signalGap("sentiment_score", context.sentiment_score, gaps);
  signalGap("sentiment_trend", context.sentiment_trend, gaps);

  const sentimentThreshold = threshold(context, "sentiment_score_threshold", gaps);

  const anger = isAvailable(context.anger_flag) && context.anger_flag.value === true;
  const lowSentiment =
    sentimentThreshold !== null &&
    isAvailable(context.sentiment_score) &&
    context.sentiment_score.value < sentimentThreshold;
  const falling = isAvailable(context.sentiment_trend) && trendHasTwoConsecutiveDrops(context.sentiment_trend.value);

  if (!(anger || lowSentiment || falling)) return null;

  return decision("R3", "recommend_handoff", "high", "sentiment_deterioration", gaps, warnings);
}

function evaluateP2(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  signalGap("conversation_duration_sec", context.conversation_duration_sec, gaps);
  signalGap("unresolved_turns", context.unresolved_turns, gaps);

  const slaWarning = threshold(context, "sla_warning_sec", gaps);
  const maxUnresolved = threshold(context, "max_unresolved_turns", gaps);

  const durationMatch =
    slaWarning !== null &&
    isAvailable(context.conversation_duration_sec) &&
    context.conversation_duration_sec.value > slaWarning;

  const turnsMatch =
    maxUnresolved !== null && isAvailable(context.unresolved_turns) && context.unresolved_turns.value > maxUnresolved;

  if (!(durationMatch || turnsMatch)) return null;

  return decision("P2", "recommend_handoff", "high", "sla_breach_risk", gaps, warnings);
}

function evaluateR4(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  signalGap("policy_match_state", context.policy_match_state, gaps);
  if (!isAvailable(context.policy_match_state)) return null;

  const state = context.policy_match_state.value;
  if (state === "unavailable") return null; // must route S0
  if (state === "conflict") {
    return decision("R4", "recommend_handoff", "normal", "policy_gap_detected", gaps, warnings);
  }

  if (!(state === "no_match" || state === "partial_match")) return null;

  signalGap("policy_match_confidence", context.policy_match_confidence, gaps);
  const policyThreshold = threshold(context, "policy_confidence_threshold", gaps);

  if (
    policyThreshold !== null &&
    isAvailable(context.policy_match_confidence) &&
    context.policy_match_confidence.value < policyThreshold
  ) {
    if (shouldClarify(context, gaps)) {
      return decision("R4", "clarify", null, "clarification_required_before_r4", gaps, warnings);
    }
    return decision("R4", "recommend_handoff", "normal", "policy_gap_detected", gaps, warnings);
  }

  return null;
}

function evaluateP1(context: EscalationContext, gaps: Set<string>, warnings: string[]): EscalationDecision | null {
  if (greetingSuppressesNonCritical(context)) return null; // G-1

  signalGap("predicted_csat", context.predicted_csat, gaps);
  signalGap("churn_risk", context.churn_risk, gaps);
  signalGap("escalation_score", context.escalation_score, gaps);

  const csatThreshold = threshold(context, "predicted_csat_threshold", gaps);
  const churnThreshold = threshold(context, "churn_risk_threshold", gaps);
  const escalationThreshold = threshold(context, "escalation_score_threshold", gaps);

  const lowCsat =
    csatThreshold !== null && isAvailable(context.predicted_csat) && context.predicted_csat.value < csatThreshold;

  const highChurn =
    churnThreshold !== null && isAvailable(context.churn_risk) && context.churn_risk.value > churnThreshold;

  const highEscalation =
    escalationThreshold !== null &&
    isAvailable(context.escalation_score) &&
    context.escalation_score.value > escalationThreshold;

  if (!(lowCsat || highChurn || highEscalation)) return null;

  return decision("P1", "suggest_handoff", "normal", "proactive_handoff", gaps, warnings);
}

const RULES: Record<
  EscalationRuleId,
  (context: EscalationContext, gaps: Set<string>, warnings: string[]) => EscalationDecision | null
> = {
  E2: evaluateE2,
  E1: evaluateE1,
  R1: evaluateR1,
  S0: evaluateS0,
  R2: evaluateR2,
  R3: evaluateR3,
  P2: evaluateP2,
  R4: evaluateR4,
  P1: evaluateP1,
};

export function evaluateFullEscalationRuleset(
  context: EscalationContext,
  options: FullRulesetEvaluationOptions,
): EscalationDecision {
  const validation = validateEscalationContext(context);
  const gaps = new Set(validation.signal_gaps);
  const warnings = [...validation.warnings];

  if (validation.fallback_to_r1_only) {
    warnings.push(...validation.errors);
    const r1 = evaluateR1(context, gaps, warnings);
    if (r1) return r1;
    return decision(null, "fallback_r1_only", null, "provider_integrity_fallback", gaps, warnings);
  }

  // G-7 and G-6 apply before all escalation rules.
  if (isResolved(context)) {
    return decision(null, "continue_ai", null, "resolved_no_escalation", gaps, warnings);
  }
  if (isExistingHumanControl(context)) {
    return decision(null, "continue_ai", null, "already_under_human_control", gaps, warnings);
  }

  for (const ruleId of ESCALATION_FIRST_MATCH_ORDER) {
    if (!options.activation.enabled.has(ruleId)) continue;
    const result = RULES[ruleId](context, gaps, warnings);
    if (result) return result;
  }

  return decision(null, "continue_ai", null, "no_escalation", gaps, warnings);
}
