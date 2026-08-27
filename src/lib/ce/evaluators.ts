/**
 * Conversation Evaluation evaluator interfaces.
 *
 * PRODUCT-READY RULE:
 * Canonical CE scores MUST come from the governed server-side multi-agent
 * evaluation path (`conversation-evaluate` / `ce-automation-engine`) using the
 * six dimension prompts, model router, response schema validation, grounding,
 * tenant guards and canonical completion RPCs.
 *
 * The deterministic heuristics below are retained ONLY as explicit test/dev
 * fixtures. They must never be selected implicitly as a production scorer.
 */

import type { CeRawScores } from "./scoring";
import type { CeReplayBundle } from "./replay";

export type CeEvaluatorInput = {
  bundle: CeReplayBundle;
  /** Grounding already validated fail-closed before this point. */
  groundingVerified: boolean;
};

export type CeEvaluatorId =
  | "accuracy"
  | "policy"
  | "tone"
  | "sales"
  | "context"
  | "hallucination";

export interface CeEvaluator {
  id: CeEvaluatorId;
  /** 0-100. For `hallucination` this is RISK (higher = worse). */
  score(input: CeEvaluatorInput): Promise<number>;
  justify(input: CeEvaluatorInput): Promise<string>;
}

function reply(input: CeEvaluatorInput): string {
  const id = input.bundle.evaluated_reply_message_id;
  const turn = input.bundle.transcript_redacted.find((t) => t.message_id === id);
  return turn?.content_redacted ?? "";
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
}

/**
 * TEST/DEV ONLY.
 *
 * This object is deliberately NOT used as a default by runEvaluators().
 * A caller must opt in explicitly, which prevents a legacy UI/local path from
 * silently presenting heuristic values as canonical Conversation Evaluation.
 */
export const deterministicEvaluatorsForTests: Record<CeEvaluatorId, CeEvaluator> = {
  accuracy: {
    id: "accuracy",
    async score(input) {
      if (!input.groundingVerified) return 0;
      const text = reply(input);
      if (!text) return 0;
      const cited = input.bundle.grounding.filter((c) =>
        text.includes(c.chunk_text_redacted.slice(0, 24)),
      ).length;
      return clamp(
        50 +
          (input.bundle.grounding.length
            ? (cited / input.bundle.grounding.length) * 50
            : 0),
      );
    },
    async justify(input) {
      return input.groundingVerified
        ? "Test heuristic scored against verified grounding evidence."
        : "Grounding unverified — test heuristic accuracy fails closed at 0.";
    },
  },
  policy: {
    id: "policy",
    async score(input) {
      const text = reply(input).toLowerCase();
      const risky = ["guarantee", "100% refund", "保證", "一定可以"];
      const hits = risky.filter((r) => text.includes(r)).length;
      return clamp(100 - hits * 25);
    },
    async justify() {
      return "Test-only deterministic policy phrase check.";
    },
  },
  tone: {
    id: "tone",
    async score(input) {
      const text = reply(input);
      if (!text) return 0;
      const shouty = text === text.toUpperCase() && /[A-Z]{4,}/.test(text);
      return clamp(shouty ? 55 : 85);
    },
    async justify() {
      return "Test-only deterministic tone heuristic.";
    },
  },
  sales: {
    id: "sales",
    async score(input) {
      const text = reply(input).toLowerCase();
      const cues = ["would you like", "we also offer", "推薦", "另外"];
      return clamp(60 + cues.filter((c) => text.includes(c)).length * 10);
    },
    async justify() {
      return "Test-only deterministic next-step / offer-cue detection.";
    },
  },
  context: {
    id: "context",
    async score(input) {
      const t = input.bundle.truncation_manifest;
      if (!t.turns_total) return 0;
      return clamp((t.turns_included / t.turns_total) * 100);
    },
    async justify() {
      return "Test-only transcript coverage heuristic.";
    },
  },
  hallucination: {
    id: "hallucination",
    async score(input) {
      if (!input.groundingVerified) return 100;
      if (input.bundle.grounding.length === 0) return 60;
      return 10;
    },
    async justify(input) {
      return input.groundingVerified
        ? "Test heuristic grounding verified; residual risk baseline applied."
        : "Grounding unverified — test heuristic returns maximum risk.";
    },
  },
};

/**
 * Explicit evaluator runner.
 *
 * There is intentionally NO default evaluator set. Product code that needs
 * canonical CE must call the server-side CE function, not this helper.
 */
export async function runEvaluators(
  input: CeEvaluatorInput,
  evaluators: Record<CeEvaluatorId, CeEvaluator>,
): Promise<CeRawScores> {
  if (!evaluators) {
    throw new Error(
      "CE_EVALUATORS_REQUIRED: canonical CE must use the governed server-side multi-agent runtime",
    );
  }

  const required: CeEvaluatorId[] = [
    "accuracy",
    "policy",
    "tone",
    "sales",
    "context",
    "hallucination",
  ];
  for (const id of required) {
    if (!evaluators[id] || evaluators[id].id !== id) {
      throw new Error(`CE_EVALUATOR_SET_INCOMPLETE:${id}`);
    }
  }

  const [accuracy, policy, tone, sales, context, hallucinationRisk] =
    await Promise.all([
      evaluators.accuracy.score(input),
      evaluators.policy.score(input),
      evaluators.tone.score(input),
      evaluators.sales.score(input),
      evaluators.context.score(input),
      evaluators.hallucination.score(input),
    ]);

  return {
    accuracy,
    policy,
    tone,
    sales,
    context,
    hallucination_risk: hallucinationRisk,
  };
}
