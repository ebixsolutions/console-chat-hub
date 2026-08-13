/**
 * PR-5 Task 1 — Canonical Escalation Signal Model
 *
 * Authoritative ruleset:
 * SU_COACHAI_ESCALATION_FULL_HANDOFF_PACKAGE v1.6
 *
 * This module is intentionally PURE:
 * - no database writes
 * - no network calls
 * - no live routing changes
 * - no R2–P1 enablement
 * - no tenant fallback
 *
 * R1 / S0 live behavior remains owned by generate-reply + existing RPCs.
 */

export const ESCALATION_SIGNAL_CONTRACT_VERSION = "SU-CoachAI-Escalation-Signals-v1.0" as const;
export const ESCALATION_RULESET_VERSION = "SU-CoachAI-Escalation-Ruleset-v1.6" as const;

export const ESCALATION_FIRST_MATCH_ORDER = [
  "E2",
  "E1",
  "R1",
  "S0",
  "R2",
  "R3",
  "P2",
  "R4",
  "P1",
] as const;

export type EscalationRuleId = (typeof ESCALATION_FIRST_MATCH_ORDER)[number];

export type SignalAvailability =
  | "available"
  | "not_checked"
  | "unavailable"
  | "invalid"
  | "stale";

export type SignalSource =
  | "local_classifier"
  | "conversation_history"
  | "conversation_evaluation"
  | "kb_rag"
  | "policy_engine"
  | "coach_ai"
  | "customer360"
  | "tenant_config"
  | "runtime"
  | "unknown";

export interface SignalProvenance {
  source: SignalSource;
  availability: SignalAvailability;
  provider_version?: string;
  observed_at?: string;
  tenant_id?: string;
  reason?: string;
}

export interface SignalValue<T> {
  value: T | null;
  provenance: SignalProvenance;
}

export type RagMatchState =
  | "not_checked"
  | "no_match"
  | "partial_match"
  | "confident_match"
  | "conflict"
  | "unavailable";

export type PolicyMatchState =
  | "not_checked"
  | "no_match"
  | "partial_match"
  | "confident_match"
  | "conflict"
  | "unavailable";

export type TopicRiskLevel = "low" | "medium" | "high" | "unknown";

export interface TenantEscalationConfig {
  max_consecutive_no_answer?: number;
  sentiment_score_threshold?: number;
  anger_score_threshold?: number;
  policy_confidence_threshold?: number;
  predicted_csat_threshold?: number;
  churn_risk_threshold?: number;
  escalation_score_threshold?: number;
  sla_warning_sec?: number;
  max_unresolved_turns?: number;
  high_value_threshold?: number;
  currency?: string;
  max_clarifications?: number;
  s0_max_retries?: number;
}

export interface EscalationContext {
  conversation_id: string;
  source_message_id: string;
  latest_message_content: string;

  // Conversation/control state used by frozen guardrails G-1/G-2/G-6/G-7.
  conversation_status: SignalValue<string>;
  assigned_agent_id: SignalValue<string | null>;
  greeting_or_trivial: SignalValue<boolean>;
  pure_handoff_negation: SignalValue<boolean>;
  clarification_attempts: SignalValue<number>;
  sentiment_recovered_same_turn: SignalValue<boolean>;
  verified_local_risk_classification: SignalValue<boolean>;

  // Runtime/S0 signals.
  upstream_failure_count: SignalValue<number>;
  failure_type: SignalValue<string>;

  // Local / R1
  explicit_request: SignalValue<boolean>;

  // CoachAI / remote scoring signals
  sentiment_score: SignalValue<number>;
  anger_score: SignalValue<number>;
  anger_flag: SignalValue<boolean>;
  sentiment_trend: SignalValue<number[]>;
  detected_intent: SignalValue<string>;
  predicted_csat: SignalValue<number>;
  escalation_score: SignalValue<number>;
  churn_risk: SignalValue<number>;
  threat_flag: SignalValue<boolean>;
  confidence_score: SignalValue<number>;

  // Compliance / tenant
  compliance_jurisdiction_requires_human_review: SignalValue<boolean>;

  // Local / derived conversation signals
  unresolved_turns: SignalValue<number>;
  consecutive_no_answer: SignalValue<number>;
  same_intent_repeated: SignalValue<boolean>;
  turn_count: SignalValue<number>;
  conversation_duration_sec: SignalValue<number>;

  // KB / Policy
  rag_match_state: SignalValue<RagMatchState>;
  policy_match_state: SignalValue<PolicyMatchState>;
  policy_match_confidence: SignalValue<number>;

  // Local risk
  topic_risk_level: SignalValue<TopicRiskLevel>;

  // Customer360 / optional routing enhancer
  customer_tier: SignalValue<string>;
  order_value: SignalValue<number>;
  currency: SignalValue<string>;
  high_value_order: SignalValue<boolean>;

  tenant_config: TenantEscalationConfig | null;

  // Provider/contract integrity
  signal_contract_version: string;
  provider_tenant_id?: string;
  expected_tenant_id?: string;
}

export type EscalationDecisionKind =
  | "continue_ai"
  | "clarify"
  | "handoff"
  | "recommend_handoff"
  | "suggest_handoff"
  | "fallback_r1_only";

export type EscalationPriority = "normal" | "high" | "urgent" | null;

export interface EscalationDecision {
  ruleset_version: string;
  matched_rule: EscalationRuleId | null;
  decision: EscalationDecisionKind;
  priority: EscalationPriority;
  reason_code: string;
  signal_gaps: string[];
  provider_warnings: string[];
}

export interface EscalationDecisionProvider {
  readonly version: string;
  evaluate(context: EscalationContext): Promise<EscalationDecision>;
}

export interface EscalationFeatureFlags {
  enable_full_ruleset: boolean;
  enable_e2: boolean;
  enable_e1: boolean;
  enable_r2: boolean;
  enable_r3: boolean;
  enable_p2: boolean;
  enable_r4: boolean;
  enable_p1: boolean;
  shadow_mode: boolean;
}

/**
 * Safety default: every new PR-5 rule remains OFF unless explicitly enabled.
 * Existing R1/S0 flags stay owned by generate-reply and are intentionally not
 * duplicated here.
 */
export function escalationFeatureFlagsFromEnv(
  env: { get(name: string): string | undefined },
): EscalationFeatureFlags {
  const on = (name: string) => env.get(name) === "true";
  return {
    enable_full_ruleset: on("ESC_ENABLE_FULL_RULESET"),
    enable_e2: on("ESC_ENABLE_E2"),
    enable_e1: on("ESC_ENABLE_E1"),
    enable_r2: on("ESC_ENABLE_R2"),
    enable_r3: on("ESC_ENABLE_R3"),
    enable_p2: on("ESC_ENABLE_P2"),
    enable_r4: on("ESC_ENABLE_R4"),
    enable_p1: on("ESC_ENABLE_P1"),
    shadow_mode: on("ESC_SHADOW_MODE"),
  };
}

export function unavailableSignal<T>(
  source: SignalSource,
  reason: string,
): SignalValue<T> {
  return {
    value: null,
    provenance: {
      source,
      availability: "unavailable",
      reason,
    },
  };
}

export function notCheckedSignal<T>(
  source: SignalSource,
  reason?: string,
): SignalValue<T> {
  return {
    value: null,
    provenance: {
      source,
      availability: "not_checked",
      ...(reason ? { reason } : {}),
    },
  };
}

export function availableSignal<T>(
  value: T,
  source: SignalSource,
  extra?: Omit<SignalProvenance, "source" | "availability">,
): SignalValue<T> {
  return {
    value,
    provenance: {
      source,
      availability: "available",
      ...extra,
    },
  };
}

export interface EscalationContextValidation {
  valid: boolean;
  fallback_to_r1_only: boolean;
  errors: string[];
  warnings: string[];
  signal_gaps: string[];
}

/**
 * Validates provider/contract integrity without inventing missing values.
 *
 * v1.6 behavior:
 * - provider unavailable => fallback R1-only
 * - stale contract => reject provider output, fallback R1-only
 * - cross-tenant provider output => reject provider output, fallback R1-only
 * - missing required signal => rule non-match + signal gap (Task 2 consumes gaps)
 * - unavailable is NOT equivalent to false/no_match
 */
export function validateEscalationContext(
  context: EscalationContext,
): EscalationContextValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const signalGaps: string[] = [];

  if (!context.conversation_id) errors.push("conversation_id_missing");
  if (!context.source_message_id) errors.push("source_message_id_missing");

  if (context.signal_contract_version !== ESCALATION_SIGNAL_CONTRACT_VERSION) {
    errors.push("signal_contract_version_mismatch");
  }

  if (
    context.expected_tenant_id &&
    context.provider_tenant_id &&
    context.expected_tenant_id !== context.provider_tenant_id
  ) {
    errors.push("cross_tenant_provider_response");
  }

  const entries = Object.entries(context).filter(
    ([, value]) =>
      value &&
      typeof value === "object" &&
      "provenance" in (value as Record<string, unknown>),
  ) as Array<[string, SignalValue<unknown>]>;

  for (const [name, signal] of entries) {
    const availability = signal.provenance.availability;

    if (availability === "unavailable") {
      warnings.push(`${name}:unavailable`);
      signalGaps.push(name);
    } else if (availability === "invalid") {
      warnings.push(`${name}:invalid`);
      signalGaps.push(name);
    } else if (availability === "stale") {
      errors.push(`${name}:stale`);
    } else if (availability === "not_checked") {
      signalGaps.push(name);
    }

    if (availability !== "available" && signal.value !== null) {
      errors.push(`${name}:non_null_value_with_${availability}`);
    }
  }

  validateBoundedScore(context.predicted_csat, "predicted_csat", 1, 5, errors);
  validateUnitInterval(context.escalation_score, "escalation_score", errors);
  validateUnitInterval(context.churn_risk, "churn_risk", errors);
  validateUnitInterval(context.confidence_score, "confidence_score", errors);
  validateUnitInterval(context.policy_match_confidence, "policy_match_confidence", errors);

  validateBoundedScore(context.sentiment_score, "sentiment_score", -1, 1, errors);
  validateBoundedScore(context.anger_score, "anger_score", 0, 1, errors);

  validateNonNegativeInteger(context.upstream_failure_count, "upstream_failure_count", errors);
  validateNonNegativeInteger(context.clarification_attempts, "clarification_attempts", errors);
  validateNonNegativeInteger(context.unresolved_turns, "unresolved_turns", errors);
  validateNonNegativeInteger(context.consecutive_no_answer, "consecutive_no_answer", errors);
  validateNonNegativeInteger(context.turn_count, "turn_count", errors);
  validateNonNegativeNumber(context.conversation_duration_sec, "conversation_duration_sec", errors);

  const providerIntegrityFailure = errors.some(
    (e) =>
      e === "signal_contract_version_mismatch" ||
      e === "cross_tenant_provider_response" ||
      e.endsWith(":stale"),
  );

  return {
    valid: errors.length === 0,
    fallback_to_r1_only: providerIntegrityFailure,
    errors,
    warnings,
    signal_gaps: [...new Set(signalGaps)],
  };
}

function validateUnitInterval(
  signal: SignalValue<number>,
  name: string,
  errors: string[],
): void {
  validateBoundedScore(signal, name, 0, 1, errors);
}

function validateBoundedScore(
  signal: SignalValue<number>,
  name: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (signal.provenance.availability !== "available") return;
  if (
    signal.value === null ||
    !Number.isFinite(signal.value) ||
    signal.value < min ||
    signal.value > max
  ) {
    errors.push(`${name}:out_of_range`);
  }
}

function validateNonNegativeInteger(
  signal: SignalValue<number>,
  name: string,
  errors: string[],
): void {
  if (signal.provenance.availability !== "available") return;
  if (
    signal.value === null ||
    !Number.isInteger(signal.value) ||
    signal.value < 0
  ) {
    errors.push(`${name}:invalid_non_negative_integer`);
  }
}

function validateNonNegativeNumber(
  signal: SignalValue<number>,
  name: string,
  errors: string[],
): void {
  if (signal.provenance.availability !== "available") return;
  if (
    signal.value === null ||
    !Number.isFinite(signal.value) ||
    signal.value < 0
  ) {
    errors.push(`${name}:invalid_non_negative_number`);
  }
}

/**
 * Canonical empty context for providers that are not yet integrated.
 * It deliberately uses unavailable/not_checked instead of false/0/no_match.
 */
export function createEscalationContextBase(input: {
  conversation_id: string;
  source_message_id: string;
  latest_message_content: string;
  explicit_request: boolean;
  expected_tenant_id?: string;
}): EscalationContext {
  return {
    conversation_id: input.conversation_id,
    source_message_id: input.source_message_id,
    latest_message_content: input.latest_message_content,

    conversation_status: notCheckedSignal("conversation_history"),
    assigned_agent_id: notCheckedSignal("conversation_history"),
    greeting_or_trivial: notCheckedSignal("local_classifier"),
    pure_handoff_negation: notCheckedSignal("local_classifier"),
    clarification_attempts: notCheckedSignal("conversation_history"),
    sentiment_recovered_same_turn: unavailableSignal(
      "conversation_evaluation",
      "no_current_evaluation_data",
    ),
    verified_local_risk_classification: notCheckedSignal("local_classifier"),

    upstream_failure_count: notCheckedSignal("runtime"),
    failure_type: notCheckedSignal("runtime"),

    explicit_request: availableSignal(
      input.explicit_request,
      "local_classifier",
    ),

    sentiment_score: unavailableSignal("conversation_evaluation", "no_current_evaluation_data"),
    anger_score: unavailableSignal("coach_ai", "provider_contract_unverified"),
    anger_flag: unavailableSignal("conversation_evaluation", "no_current_evaluation_data"),
    sentiment_trend: unavailableSignal("conversation_evaluation", "no_current_evaluation_data"),
    detected_intent: unavailableSignal("coach_ai", "provider_contract_unverified"),
    predicted_csat: unavailableSignal("coach_ai", "provider_contract_unverified"),
    escalation_score: unavailableSignal("coach_ai", "provider_contract_unverified"),
    churn_risk: unavailableSignal("coach_ai", "provider_contract_unverified"),
    threat_flag: unavailableSignal("coach_ai", "provider_contract_unverified"),
    confidence_score: unavailableSignal("coach_ai", "provider_contract_unverified"),

    compliance_jurisdiction_requires_human_review: unavailableSignal(
      "tenant_config",
      "provider_contract_unverified",
    ),

    unresolved_turns: notCheckedSignal("conversation_history"),
    consecutive_no_answer: notCheckedSignal("conversation_history"),
    same_intent_repeated: unavailableSignal(
      "conversation_history",
      "detected_intent_unavailable",
    ),
    turn_count: notCheckedSignal("conversation_history"),
    conversation_duration_sec: notCheckedSignal("conversation_history"),

    rag_match_state: unavailableSignal("kb_rag", "kb_contract_unverified"),
    policy_match_state: unavailableSignal(
      "policy_engine",
      "provider_contract_unverified",
    ),
    policy_match_confidence: unavailableSignal(
      "policy_engine",
      "provider_contract_unverified",
    ),

    topic_risk_level: notCheckedSignal("local_classifier"),

    customer_tier: unavailableSignal("customer360", "provider_contract_unverified"),
    order_value: unavailableSignal("customer360", "provider_contract_unverified"),
    currency: unavailableSignal("customer360", "provider_contract_unverified"),
    high_value_order: unavailableSignal(
      "customer360",
      "provider_contract_unverified",
    ),

    tenant_config: null,

    signal_contract_version: ESCALATION_SIGNAL_CONTRACT_VERSION,
    expected_tenant_id: input.expected_tenant_id,
  };
}

/**
 * E2 signal contract is frozen by Director:
 * threat_flag OR compliance_jurisdiction_requires_human_review.
 *
 * This helper only evaluates signal availability/value. It does not perform
 * any handoff or persistence.
 */
export function evaluateE2SignalContract(context: EscalationContext): {
  match: boolean;
  signal_gap: boolean;
} {
  const threat = context.threat_flag;
  const jurisdiction =
    context.compliance_jurisdiction_requires_human_review;

  const threatKnown = threat.provenance.availability === "available";
  const jurisdictionKnown =
    jurisdiction.provenance.availability === "available";

  return {
    match:
      (threatKnown && threat.value === true) ||
      (jurisdictionKnown && jurisdiction.value === true),
    signal_gap: !threatKnown || !jurisdictionKnown,
  };
}
