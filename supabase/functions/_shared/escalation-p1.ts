/**
 * PR-5 P1 — proactive handoff signal contract.
 *
 * P1 consumes prediction signals only:
 * - predicted_csat
 * - churn_risk
 * - escalation_score
 *
 * Observed CSAT (e.g. feedback_request.rating) is intentionally NOT mapped to
 * predicted_csat. Missing providers stay unavailable.
 */
export interface P1PredictionInput {
  predicted_csat?: unknown;
  churn_risk?: unknown;
  escalation_score?: unknown;
  provider_version?: string;
  provider_source?: "customer360" | "risk_engine";
}

export interface P1PredictionSignals {
  predicted_csat?: number;
  churn_risk?: number;
  escalation_score?: number;
  provider_version: string;
  provider_source: "customer360" | "risk_engine";
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

export function validateP1PredictionSignals(
  input: P1PredictionInput | null | undefined,
): P1PredictionSignals | undefined {
  if (!input?.provider_version || !input.provider_source) return undefined;

  const predictedCsat = finiteNumber(input.predicted_csat);
  const churnRisk = finiteNumber(input.churn_risk);
  const escalationScore = finiteNumber(input.escalation_score);

  const validCsat =
    predictedCsat !== undefined && predictedCsat >= 1 && predictedCsat <= 5
      ? predictedCsat
      : undefined;
  const validChurn =
    churnRisk !== undefined && churnRisk >= 0 && churnRisk <= 1
      ? churnRisk
      : undefined;
  const validEscalation =
    escalationScore !== undefined && escalationScore >= 0 && escalationScore <= 1
      ? escalationScore
      : undefined;

  if (
    validCsat === undefined &&
    validChurn === undefined &&
    validEscalation === undefined
  ) return undefined;

  return {
    ...(validCsat !== undefined ? { predicted_csat: validCsat } : {}),
    ...(validChurn !== undefined ? { churn_risk: validChurn } : {}),
    ...(validEscalation !== undefined ? { escalation_score: validEscalation } : {}),
    provider_version: input.provider_version,
    provider_source: input.provider_source,
  };
}
