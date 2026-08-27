/**
 * PR-5 Full Escalation shadow adapter.
 *
 * Product-ready safety invariant:
 * CE/customer-risk signals are advisory-only and may never become a required
 * live handoff from this module. They are accepted only with tenant/provider
 * provenance. Missing provenance fails closed by leaving the signal unavailable.
 */

import {
  availableSignal,
  createEscalationContextBase,
  escalationFeatureFlagsFromEnv,
  type EscalationContext,
  type EscalationRuleId,
  type RagMatchState,
  type PolicyMatchState,
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
  threat_flag?: { value: true; reason: string; provider_version: string };
  compliance_jurisdiction_requires_human_review?: {
    value: boolean;
    reason: string;
    provider_version: string;
  };
  topic_risk_level?: "high";
  verified_local_risk_classification?: true;

  // CE-derived advisory signals. All provenance fields are required together.
  anger_flag?: true;
  sentiment_score?: number;
  sentiment_trend?: number[];
  sentiment_recovered_same_turn?: true;
  sentiment_provider_version?: string;
  sentiment_evaluation_id?: string;

  conversation_duration_sec?: number;
  tenant_config?: EscalationContext["tenant_config"];
  policy_match_state?: PolicyMatchState;
  policy_provider_version?: string;
  policy_provider_reason?: string;

  // P1 advisory prediction signals.
  predicted_csat?: number;
  churn_risk?: number;
  escalation_score?: number;
  p1_provider_version?: string;
  p1_provider_source?: "customer360" | "risk_engine";
}

export interface EscalationShadowResult {
  evaluated: boolean;
  matched_rule: EscalationRuleId | null;
  decision: string;
  reason_code: string;
  signal_gaps: string[];
  provider_warnings: string[];
}

function hasCeProvenance(input: EscalationShadowInput): boolean {
  return Boolean(
    input.expected_tenant_id &&
    input.sentiment_provider_version?.trim() &&
    input.sentiment_evaluation_id?.trim(),
  );
}

function hasP1Provenance(input: EscalationShadowInput): boolean {
  return Boolean(
    input.expected_tenant_id &&
    input.p1_provider_version?.trim() &&
    (input.p1_provider_source === "customer360" ||
      input.p1_provider_source === "risk_engine"),
  );
}

/**
 * Returns null unless ESC_SHADOW_MODE=true.
 * This module performs zero writes and zero handoff RPCs.
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

  const providerWarnings: string[] = [];

  const context: EscalationContext = createEscalationContextBase({
    conversation_id: input.conversation_id,
    source_message_id: input.source_message_id,
    latest_message_content: input.latest_message_content,
    explicit_request: input.explicit_request,
    expected_tenant_id: input.expected_tenant_id,
  });

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

  if (input.threat_flag) {
    context.threat_flag = availableSignal(input.threat_flag.value, "local_classifier", {
      provider_version: input.threat_flag.provider_version,
      reason: input.threat_flag.reason,
      ...(input.expected_tenant_id ? { tenant_id: input.expected_tenant_id } : {}),
    });
  }

  if (input.compliance_jurisdiction_requires_human_review) {
    const compliance = input.compliance_jurisdiction_requires_human_review;
    context.compliance_jurisdiction_requires_human_review = availableSignal(
      compliance.value,
      "tenant_config",
      {
        provider_version: compliance.provider_version,
        reason: compliance.reason,
        ...(input.expected_tenant_id ? { tenant_id: input.expected_tenant_id } : {}),
      },
    );
  }

  if (input.rag_match_state) {
    context.rag_match_state = availableSignal(input.rag_match_state, "kb_rag");
  }

  if (input.topic_risk_level === "high") {
    context.topic_risk_level = availableSignal("high", "local_classifier", {
      reason: "verified_high_risk_topic",
    });
  }
  if (input.verified_local_risk_classification === true) {
    context.verified_local_risk_classification = availableSignal(
      true,
      "local_classifier",
    );
  }

  // CE signals fail closed unless tenant + provider version + evaluation id are
  // present. This prevents unscoped/stale-looking ad-hoc values from entering R3.
  const ceProvenanceOk = hasCeProvenance(input);
  const ceSignalPresent =
    input.anger_flag === true ||
    typeof input.sentiment_score === "number" ||
    Array.isArray(input.sentiment_trend) ||
    input.sentiment_recovered_same_turn === true;

  if (ceSignalPresent && !ceProvenanceOk) {
    providerWarnings.push("CE_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE");
  }

  if (ceProvenanceOk) {
    const ceMeta = {
      provider_version: input.sentiment_provider_version,
      reason: `evaluation_id:${input.sentiment_evaluation_id}`,
      tenant_id: input.expected_tenant_id,
    };

    if (input.anger_flag === true) {
      context.anger_flag = availableSignal(
        true,
        "conversation_evaluation",
        ceMeta,
      );
    }
    if (
      typeof input.sentiment_score === "number" &&
      Number.isFinite(input.sentiment_score)
    ) {
      context.sentiment_score = availableSignal(
        input.sentiment_score,
        "conversation_evaluation",
        ceMeta,
      );
    }
    if (
      Array.isArray(input.sentiment_trend) &&
      input.sentiment_trend.length >= 2 &&
      input.sentiment_trend.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      context.sentiment_trend = availableSignal(
        input.sentiment_trend,
        "conversation_evaluation",
        ceMeta,
      );
    }
    if (input.sentiment_recovered_same_turn === true) {
      context.sentiment_recovered_same_turn = availableSignal(
        true,
        "conversation_evaluation",
        {
          ...ceMeta,
          reason: `evaluation_id:${input.sentiment_evaluation_id}:recovery`,
        },
      );
    }
  }

  if (
    typeof input.conversation_duration_sec === "number" &&
    Number.isFinite(input.conversation_duration_sec)
  ) {
    context.conversation_duration_sec = availableSignal(
      input.conversation_duration_sec,
      "conversation_history",
      {
        ...(input.expected_tenant_id ? { tenant_id: input.expected_tenant_id } : {}),
        reason: "conversation_created_at_elapsed_seconds",
      },
    );
  }

  if (input.tenant_config) context.tenant_config = input.tenant_config;

  if (input.policy_match_state) {
    context.policy_match_state = availableSignal(
      input.policy_match_state,
      "policy_engine",
      {
        provider_version: input.policy_provider_version,
        reason: input.policy_provider_reason ?? "agent_assist_policy_contract",
        ...(input.expected_tenant_id ? { tenant_id: input.expected_tenant_id } : {}),
      },
    );
  }

  const p1SignalPresent =
    typeof input.predicted_csat === "number" ||
    typeof input.churn_risk === "number" ||
    typeof input.escalation_score === "number";
  const p1ProvenanceOk = hasP1Provenance(input);

  if (p1SignalPresent && !p1ProvenanceOk) {
    providerWarnings.push("P1_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE");
  }

  if (p1ProvenanceOk) {
    const p1Source =
      input.p1_provider_source === "risk_engine" ? "scoring_engine" : "customer360";
    const p1Meta = {
      provider_version: input.p1_provider_version,
      tenant_id: input.expected_tenant_id,
    };

    if (
      typeof input.predicted_csat === "number" &&
      Number.isFinite(input.predicted_csat)
    ) {
      context.predicted_csat = availableSignal(
        input.predicted_csat,
        p1Source,
        { ...p1Meta, reason: "authoritative_predicted_csat" },
      );
    }
    if (
      typeof input.churn_risk === "number" &&
      Number.isFinite(input.churn_risk)
    ) {
      context.churn_risk = availableSignal(
        input.churn_risk,
        p1Source,
        { ...p1Meta, reason: "authoritative_churn_risk" },
      );
    }
    if (
      typeof input.escalation_score === "number" &&
      Number.isFinite(input.escalation_score)
    ) {
      context.escalation_score = availableSignal(
        input.escalation_score,
        p1Source,
        { ...p1Meta, reason: "authoritative_escalation_score" },
      );
    }
  }

  if (input.failure_type) {
    context.failure_type = availableSignal(input.failure_type, "runtime");
  }

  const enabled = new Set<EscalationRuleId>();
  enabled.add("R1");

  if (flags.enable_full_ruleset || flags.enable_e2) enabled.add("E2");
  if (flags.enable_full_ruleset || flags.enable_e1) enabled.add("E1");
  if (flags.enable_full_ruleset || flags.enable_r2) enabled.add("R2");
  if (flags.enable_full_ruleset || flags.enable_r3) enabled.add("R3");
  if (flags.enable_full_ruleset || flags.enable_p2) enabled.add("P2");
  if (flags.enable_full_ruleset || flags.enable_r4) enabled.add("R4");
  if (flags.enable_full_ruleset || flags.enable_p1) enabled.add("P1");

  if (input.failure_type || input.rag_match_state === "unavailable") {
    enabled.add("S0");
  }

  const result = evaluateFullEscalationRuleset(context, {
    activation: { enabled },
  });

  /*
   * Product-ready hard boundary:
   * CE/R3 and predictive/P1 are advisory. Even if a future rules regression
   * accidentally returns "handoff", shadow output is downgraded so callers can
   * never interpret it as a required human transfer.
   */
  if (result.matched_rule === "R3" || result.matched_rule === "P1") {
    const advisoryDecision =
      result.matched_rule === "R3" ? "recommend_handoff" : "suggest_handoff";
    if (result.decision !== advisoryDecision) {
      providerWarnings.push("ADVISORY_RULE_DECISION_DOWNGRADED");
    }
    return {
      evaluated: true,
      matched_rule: result.matched_rule,
      decision: advisoryDecision,
      reason_code: result.reason_code,
      signal_gaps: result.signal_gaps,
      provider_warnings: [...result.provider_warnings, ...providerWarnings],
    };
  }

  return {
    evaluated: true,
    matched_rule: result.matched_rule,
    decision: result.decision,
    reason_code: result.reason_code,
    signal_gaps: result.signal_gaps,
    provider_warnings: [...result.provider_warnings, ...providerWarnings],
  };
}
