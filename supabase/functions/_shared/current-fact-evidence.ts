export type CurrentFactKnowledgeState =
  | "not_needed"
  | "lookup_required"
  | "available"
  | "no_match"
  | "conflict"
  | "tool_failure";

export type CurrentFactEvidenceDecision =
  | { kind: "current_evidence" }
  | { kind: "no_current_evidence"; historical_only: boolean }
  | { kind: "operational_failure" };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalTenantScopeFromAuthoritativeCompany(
  companyId: unknown,
): {
  mode: "canonical";
  aiCompanyId: string;
  singaporeTenantId: string;
} | null {
  if (typeof companyId !== "string" || !UUID_RE.test(companyId)) return null;
  return {
    mode: "canonical",
    aiCompanyId: companyId,
    singaporeTenantId: companyId,
  };
}

export function classifyDeterministicSearchOutcome(input: {
  market_resolved: boolean;
  query_length: number;
  rpc_failed?: boolean;
  row_count?: number;
  ambiguous_match?: boolean;
}): CurrentFactEvidenceDecision["kind"] {
  if (input.rpc_failed === true) return "operational_failure";
  if (!input.market_resolved || input.query_length < 2) {
    return "no_current_evidence";
  }
  if (
    input.row_count !== undefined &&
    (input.row_count === 0 || input.ambiguous_match === true)
  ) {
    return "no_current_evidence";
  }
  return "current_evidence";
}

export function classifyCurrentFactEvidence(input: {
  knowledge_state: CurrentFactKnowledgeState;
  current_evidence_count: number;
  historical_evidence_count?: number;
  operational_failure?: boolean;
}): CurrentFactEvidenceDecision {
  if (input.operational_failure === true) {
    return { kind: "operational_failure" };
  }
  if (input.knowledge_state !== "lookup_required") {
    return { kind: "current_evidence" };
  }
  if (input.current_evidence_count > 0) return { kind: "current_evidence" };
  return {
    kind: "no_current_evidence",
    historical_only: (input.historical_evidence_count ?? 0) > 0,
  };
}

export function canAnswerBoundedNoCurrentEvidence(input: {
  decision: CurrentFactEvidenceDecision;
  high_risk: boolean;
  explicit_human_request: boolean;
  threat: boolean;
  compliance_requires_human_review: boolean;
}): boolean {
  return input.decision.kind === "no_current_evidence" &&
    !input.high_risk &&
    !input.explicit_human_request &&
    !input.threat &&
    !input.compliance_requires_human_review;
}

export const NO_CURRENT_EVIDENCE_ROUTE = "kb_no_current_evidence";

export function renderBoundedNoCurrentEvidence(
  language: "zh-TW" | "zh-CN" | "en",
): string {
  if (language === "zh-CN") {
    return "我目前没有可核实的当前资料，所以答案是：目前不知道／无法确认。历史资料不能当作当前事实，我也不会猜测。";
  }
  if (language === "en") {
    return "I do not have verifiable current information, so the bounded answer is: unknown / not currently confirmed. Historical information is not treated as a current fact, and I will not guess.";
  }
  return "我目前沒有可核實的現行資料，所以答案是：目前不知道／未能確認。歷史資料不能當作目前事實，我也不會猜測。";
}
