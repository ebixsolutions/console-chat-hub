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
  ): PromiseLike<{ data: Record<string, unknown> | null; error: { message?: string } | null }>;
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
        | "not_found"
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
    case "invalid_priority":
    case "not_found":
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

export interface RequiredClarificationRpcClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: Record<string, unknown> | null; error: { message?: string } | null }>;
}

export type RequiredClarificationResult =
  | { ok: true; result: "success" | "already_handled"; data: Record<string, unknown> }
  | {
      ok: false;
      result:
        | "not_r2_clarification"
        | "invalid_clarification"
        | "already_resolved"
        | "already_under_human_control"
        | "max_clarifications_reached"
        | "invalid_source_message"
        | "invalid_input"
        | "invalid_rule"
        | "not_found"
        | "rpc_transport_error"
        | "unexpected_result";
      detail?: string;
      data?: Record<string, unknown>;
    };

async function persistNewIntentClarificationThroughAiGate(
  client: RequiredClarificationRpcClient,
  input: PersistRequiredHandoffInput,
  clarification: string,
): Promise<RequiredClarificationResult> {
  const { data, error } = await client.rpc("commit_ai_reply_tx", {
    p_conversation_id: input.conversation_id,
    p_source_message_id: input.source_message_id,
    p_content: clarification,
    p_metadata: {
      escalation_rule: "R2",
      escalation_action: "new_intent_clarification",
      response_route: "kb_no_match_recovery",
      handoff_required: false,
      reason_code: input.decision.reason_code,
    },
  });

  if (error) {
    return { ok: false, result: "rpc_transport_error", detail: error.message ?? "rpc_error" };
  }

  const payload = data ?? {};
  const result = String(payload.result ?? "unexpected_result");
  switch (result) {
    case "success":
    case "idempotent":
      return { ok: true, result: "success", data: payload };
    case "human_control":
      return { ok: false, result: "already_under_human_control", data: payload };
    case "resolved":
      return { ok: false, result: "already_resolved", data: payload };
    case "invalid_source_message":
    case "invalid_input":
    case "not_found":
      return { ok: false, result, data: payload };
    default:
      return { ok: false, result: "unexpected_result", detail: result, data: payload };
  }
}

export async function persistRequiredEscalationClarification(
  client: RequiredClarificationRpcClient,
  input: PersistRequiredHandoffInput,
): Promise<RequiredClarificationResult> {
  if (input.decision.decision !== "clarify" || input.decision.matched_rule !== "R2") {
    return { ok: false, result: "not_r2_clarification" };
  }

  const clarification = input.safe_reply_content.trim();
  if (!clarification || clarification === "__THINKING__" || clarification.length > 1200) {
    return { ok: false, result: "invalid_clarification" };
  }

  const { data, error } = await client.rpc("required_escalation_clarification_tx", {
    p_conversation_id: input.conversation_id,
    p_source_message_id: input.source_message_id,
    p_escalation_rule: "R2",
    p_clarification_content: clarification,
    p_reason_code: input.decision.reason_code,
  });

  if (error) {
    return { ok: false, result: "rpc_transport_error", detail: error.message ?? "rpc_error" };
  }

  const payload = data ?? {};
  const result = String(payload.result ?? "unexpected_result");

  switch (result) {
    case "success":
    case "already_handled":
      return { ok: true, result, data: payload };

    case "max_clarifications_reached":
      /*
       * The legacy RPC cap is conversation-wide. Product-ready behavior is
       * intent-scoped: a different normal question must not be transferred
       * merely because an earlier question already used its clarification.
       * We therefore persist the current safe clarification through the same
       * atomic AI-control gate. Same-intent repeats never reach this branch:
       * the rules engine produces R2 handoff for them.
       */
      if (input.decision.reason_code === "clarification_new_intent_no_kb_match") {
        return await persistNewIntentClarificationThroughAiGate(
          client,
          input,
          clarification,
        );
      }
      return { ok: false, result, data: payload };

    case "already_resolved":
    case "already_under_human_control":
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "not_found":
      return { ok: false, result, data: payload };

    default:
      return { ok: false, result: "unexpected_result", detail: result, data: payload };
  }
}
