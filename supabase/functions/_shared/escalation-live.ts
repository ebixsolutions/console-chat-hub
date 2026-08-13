/**
 * PR-5 — Required-rule live handoff adapter.
 *
 * Only E2 / E1 / R2 may use this adapter.
 * R1 remains on explicit_handoff_tx.
 * S0 remains on s0_handoff_tx.
 *
 * This module does not decide whether a rule matches; it persists a decision
 * already produced by the canonical first-match engine.
 */

import type { EscalationDecision } from "./escalation-signals.ts";

export type RequiredLiveRule = "E2" | "E1" | "R2";

export interface RequiredHandoffRpcClient {
  rpc(
    fn: "required_escalation_handoff_tx",
    args: {
      p_conversation_id: string;
      p_source_message_id: string;
      p_escalation_rule: RequiredLiveRule;
      p_priority: "normal" | "high" | "urgent";
      p_safe_reply_content: string;
      p_reason_code: string;
    },
  ): Promise<{ data: Record<string, unknown> | null; error: { message?: string } | null }>;
}

export interface PersistRequiredHandoffInput {
  conversation_id: string;
  source_message_id: string;
  decision: EscalationDecision;
  safe_reply_content: string;
}

export type RequiredHandoffResult =
  | { ok: true; result: "success" | "already_handled"; data: Record<string, unknown> }
  | {
      ok: false;
      result:
        | "not_required_rule"
        | "invalid_priority"
        | "invalid_safe_reply"
        | "already_resolved"
        | "already_under_human_control"
        | "invalid_source_message"
        | "invalid_input"
        | "invalid_rule"
        | "rpc_transport_error"
        | "unexpected_result";
      detail?: string;
      data?: Record<string, unknown>;
    };

const REQUIRED_LIVE_RULES = new Set<RequiredLiveRule>(["E2", "E1", "R2"]);

export function isRequiredLiveRule(rule: string | null): rule is RequiredLiveRule {
  return rule !== null && REQUIRED_LIVE_RULES.has(rule as RequiredLiveRule);
}

export async function persistRequiredEscalationHandoff(
  client: RequiredHandoffRpcClient,
  input: PersistRequiredHandoffInput,
): Promise<RequiredHandoffResult> {
  if (input.decision.decision !== "handoff" || !isRequiredLiveRule(input.decision.matched_rule)) {
    return { ok: false, result: "not_required_rule" };
  }

  const priority = input.decision.priority;
  if (priority !== "normal" && priority !== "high" && priority !== "urgent") {
    return { ok: false, result: "invalid_priority" };
  }

  const safeReply = input.safe_reply_content.trim();
  if (!safeReply || safeReply === "__THINKING__" || safeReply.length > 2000) {
    return { ok: false, result: "invalid_safe_reply" };
  }

  const { data, error } = await client.rpc("required_escalation_handoff_tx", {
    p_conversation_id: input.conversation_id,
    p_source_message_id: input.source_message_id,
    p_escalation_rule: input.decision.matched_rule,
    p_priority: priority,
    p_safe_reply_content: safeReply,
    p_reason_code: input.decision.reason_code,
  });

  if (error) {
    return {
      ok: false,
      result: "rpc_transport_error",
      detail: error.message ?? "rpc_error",
    };
  }

  const payload = data ?? {};
  const result = String(payload.result ?? "unexpected_result");

  switch (result) {
    case "success":
    case "already_handled":
      return { ok: true, result, data: payload };
    case "already_resolved":
    case "already_under_human_control":
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
      return { ok: false, result, data: payload };
    default:
      return {
        ok: false,
        result: "unexpected_result",
        detail: result,
        data: payload,
      };
  }
}
