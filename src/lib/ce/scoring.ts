/**
 * Canonical CE scoring rules — AI Chatbot is the evaluation owner.
 *
 * Weights: accuracy .25, policy .20, tone .20, sales .15, context .10,
 * hallucination .10 (applied to hallucination QUALITY = 100 - risk).
 * Severity: <60 critical, 60-<70 high, 70-<80 medium, >=80 low.
 * Training eligible: overall < 70 AND a verified human response exists.
 *
 * Mirrors public.complete_evaluation() exactly so UI and DB never disagree.
 */

export const CE_CONTRACT_VERSION = "ce-1.0.0";

export const CE_WEIGHTS = {
  accuracy: 0.25,
  policy: 0.2,
  tone: 0.2,
  sales: 0.15,
  context: 0.1,
  hallucination: 0.1,
} as const;

export type CeEvaluatorKey = keyof typeof CE_WEIGHTS;

export type CeRawScores = {
  accuracy: number;
  policy: number;
  tone: number;
  sales: number;
  context: number;
  /** risk, 0 = no hallucination risk */
  hallucination_risk: number;
};

export type CeSeverity = "critical" | "high" | "medium" | "low";

export type CeScoreResult = {
  overall: number;
  severity: CeSeverity;
  hallucinationQuality: number;
  weighted: Record<CeEvaluatorKey, number>;
  trainingEligible: boolean;
};

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function assertValidScores(s: CeRawScores): void {
  const keys: (keyof CeRawScores)[] = [
    "accuracy",
    "policy",
    "tone",
    "sales",
    "context",
    "hallucination_risk",
  ];
  for (const k of keys) {
    const v = s[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`CE_INVALID_SCORES: ${k} is not numeric`);
    }
    if (v < 0 || v > 100) throw new Error(`CE_INVALID_SCORES: ${k} out of range`);
    if (round2(v) !== v) throw new Error(`CE_INVALID_SCORES: ${k} precision exceeded`);
  }
  if (Object.keys(s).length !== keys.length) {
    throw new Error("CE_INVALID_SCORES: wrong key count");
  }
}

export function severityFor(overall: number): CeSeverity {
  if (overall < 60) return "critical";
  if (overall < 70) return "high";
  if (overall < 80) return "medium";
  return "low";
}

export function computeCeScore(scores: CeRawScores, hasVerifiedHumanResponse: boolean): CeScoreResult {
  assertValidScores(scores);
  const hallucinationQuality = round2(100 - scores.hallucination_risk);

  const weighted: Record<CeEvaluatorKey, number> = {
    accuracy: round2(scores.accuracy * CE_WEIGHTS.accuracy),
    policy: round2(scores.policy * CE_WEIGHTS.policy),
    tone: round2(scores.tone * CE_WEIGHTS.tone),
    sales: round2(scores.sales * CE_WEIGHTS.sales),
    context: round2(scores.context * CE_WEIGHTS.context),
    hallucination: round2(hallucinationQuality * CE_WEIGHTS.hallucination),
  };

  const overall = round2(
    scores.accuracy * CE_WEIGHTS.accuracy +
      scores.policy * CE_WEIGHTS.policy +
      scores.tone * CE_WEIGHTS.tone +
      scores.sales * CE_WEIGHTS.sales +
      scores.context * CE_WEIGHTS.context +
      hallucinationQuality * CE_WEIGHTS.hallucination,
  );

  return {
    overall,
    severity: severityFor(overall),
    hallucinationQuality,
    weighted,
    trainingEligible: overall < 70 && hasVerifiedHumanResponse,
  };
}
