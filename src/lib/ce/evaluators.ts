/**
 * Six server-side CE evaluators.
 *
 * Each evaluator is a server-side scorer behind a provider-agnostic adapter.
 * The provider adapter is NOT invoked in this change set (no external LLM
 * calls are authorized); the deterministic heuristic evaluator below is the
 * default and is what the tests pin. Scoring/aggregation itself is canonical
 * and identical to public.complete_evaluation().
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

/** Deterministic, provider-free evaluators (fail-closed defaults). */
export const deterministicEvaluators: Record<CeEvaluatorId, CeEvaluator> = {
  accuracy: {
    id: "accuracy",
    async score(input) {
      if (!input.groundingVerified) return 0;
      const text = reply(input);
      if (!text) return 0;
      const cited = input.bundle.grounding.filter((c) =>
        text.includes(c.chunk_text_redacted.slice(0, 24)),
      ).length;
      return clamp(50 + (input.bundle.grounding.length ? (cited / input.bundle.grounding.length) * 50 : 0));
    },
    async justify(input) {
      return input.groundingVerified
        ? "Scored against verified grounding evidence."
        : "Grounding unverified — accuracy fails closed at 0.";
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
      return "Deterministic policy-phrase check.";
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
      return "Deterministic tone heuristic (register + shouting).";
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
      return "Deterministic next-step / offer-cue detection.";
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
      return "Share of conversation actually available to the evaluator.";
    },
  },
  hallucination: {
    id: "hallucination",
    async score(input) {
      // RISK: no verified grounding => maximum risk (fail closed).
      if (!input.groundingVerified) return 100;
      if (input.bundle.grounding.length === 0) return 60;
      return 10;
    },
    async justify(input) {
      return input.groundingVerified
        ? "Grounding verified; residual risk baseline applied."
        : "Grounding unverified — maximum hallucination risk.";
    },
  },
};

export async function runEvaluators(
  input: CeEvaluatorInput,
  evaluators: Record<CeEvaluatorId, CeEvaluator> = deterministicEvaluators,
): Promise<CeRawScores> {
  const [accuracy, policy, tone, sales, context, hallucinationRisk] = await Promise.all([
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
