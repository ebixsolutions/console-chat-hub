/**
 * PR-5 R4 — authoritative policy evidence classifier.
 *
 * Uses the same frozen four-state semantics as Agent Assist check_policy:
 * compliant | warning | violation | insufficient_evidence.
 *
 * Safety:
 * - evidence only; never invent policy
 * - no DB writes / no handoff persistence
 * - governed LLM router is the only provider call site
 * - provider failure => unavailable
 * - does not produce policy_match_confidence
 */
import { callModel, parseJsonObject } from "./llm-router.ts";

export type PolicyAssessmentStatus =
  | "compliant"
  | "warning"
  | "violation"
  | "insufficient_evidence";

export type R4PolicyMatchState =
  | "confident_match"
  | "partial_match"
  | "conflict"
  | "no_match"
  | "unavailable";

export interface PolicyEvidenceItem {
  label: string;
  content: string;
  source_type: string;
}

export interface R4PolicyAssessment {
  match_state: R4PolicyMatchState;
  provider_version: string;
  reason: string;
}

export interface R4PolicyRouterContext {
  company_id: string | null;
  conversation_id: string | null;
  operation_id: string;
}

const VALID_POLICY_STATUS = new Set<PolicyAssessmentStatus>([
  "compliant",
  "warning",
  "violation",
  "insufficient_evidence",
]);

const POLICY_PROVIDER_VERSION = "governed-policy-router-v1.0";

const POLICY_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    status: {
      type: "STRING",
      enum: ["compliant", "warning", "violation", "insufficient_evidence"],
    },
    summary: { type: "STRING" },
  },
  required: ["status", "summary"],
};

export function mapPolicyStatusToR4State(status: PolicyAssessmentStatus): R4PolicyMatchState {
  switch (status) {
    case "compliant": return "confident_match";
    case "warning": return "partial_match";
    case "violation": return "conflict";
    case "insufficient_evidence": return "no_match";
  }
}

function cleanPolicyEvidence(items: PolicyEvidenceItem[]): PolicyEvidenceItem[] {
  return items
    .filter((item) =>
      typeof item.label === "string" &&
      typeof item.content === "string" &&
      typeof item.source_type === "string" &&
      item.label.trim().length > 0 &&
      item.content.trim().length > 0 &&
      item.source_type.trim().length > 0
    )
    .slice(0, 3)
    .map((item) => ({
      label: item.label.trim().slice(0, 120),
      content: item.content.trim().slice(0, 800),
      source_type: item.source_type.trim().slice(0, 40),
    }));
}

export async function assessPolicyEvidenceForR4(
  content: string,
  items: PolicyEvidenceItem[],
  context: R4PolicyRouterContext,
): Promise<R4PolicyAssessment | undefined> {
  const evidence = cleanPolicyEvidence(items);
  if (evidence.length === 0) return undefined;

  const block = evidence
    .map((item) => `[${item.label}]\n${item.content}`)
    .join("\n\n");

  const result = await callModel({
    purpose: "generation",
    system:
      'Assess policy compliance based ONLY on the provided sources. Do NOT invent rules not in the sources. ' +
      'If sources lack relevant policy, set status to "insufficient_evidence". ' +
      'Return ONLY JSON with status and summary.',
    user: `Text to check:\n${content.slice(0, 2000)}\n\nPolicy sources:\n${block}`,
    maxTokens: 500,
    operationId: context.operation_id,
    companyId: context.company_id,
    conversationId: context.conversation_id,
    tag: "generate-reply-r4-policy",
    responseFormat: "json",
    responseSchema: POLICY_RESPONSE_SCHEMA,
  });

  if (!result.ok) {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: `policy_provider_${result.code.toLowerCase()}`,
    };
  }

  const parsed = parseJsonObject(result.text);
  const rawStatus = parsed?.status;
  if (
    typeof rawStatus !== "string" ||
    !VALID_POLICY_STATUS.has(rawStatus as PolicyAssessmentStatus)
  ) {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: "policy_provider_invalid_status",
    };
  }

  const status = rawStatus as PolicyAssessmentStatus;
  return {
    match_state: mapPolicyStatusToR4State(status),
    provider_version: POLICY_PROVIDER_VERSION,
    reason: `policy_status:${status}`,
  };
}
