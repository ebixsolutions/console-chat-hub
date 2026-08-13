/**
 * PR-5 R4 — authoritative policy evidence classifier.
 *
 * Uses the same frozen four-state semantics as Agent Assist check_policy:
 * compliant | warning | violation | insufficient_evidence.
 *
 * Safety:
 * - evidence only; never invent policy
 * - no DB writes / no handoff persistence
 * - provider failure => unavailable
 * - does not produce policy_match_confidence
 */
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

const VALID_POLICY_STATUS = new Set<PolicyAssessmentStatus>([
  "compliant",
  "warning",
  "violation",
  "insufficient_evidence",
]);

const POLICY_PROVIDER_VERSION = "agent-assist-policy-contract-v1.0";

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

function parseProviderJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim(),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function assessPolicyEvidenceForR4(
  content: string,
  items: PolicyEvidenceItem[],
  config: { anthropic_api_key?: string; timeout_ms?: number },
): Promise<R4PolicyAssessment | undefined> {
  const evidence = cleanPolicyEvidence(items);
  if (evidence.length === 0) return undefined;

  if (!config.anthropic_api_key) {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: "policy_provider_key_unavailable",
    };
  }

  const block = evidence.map((item) => `[${item.label}]\n${item.content}`).join("\n\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeout_ms ?? 15000);

  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropic_api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system:
          'Assess policy compliance based ONLY on the provided sources. Do NOT invent rules not in the sources. ' +
          'If sources lack relevant policy, set status to "insufficient_evidence". ' +
          'Return ONLY JSON: {"status":"compliant|warning|violation|insufficient_evidence","summary":"..."}',
        messages: [{
          role: "user",
          content: `Text to check:\n${content.slice(0, 2000)}\n\nPolicy sources:\n${block}`,
        }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason:
        error instanceof DOMException && error.name === "AbortError"
          ? "policy_provider_timeout"
          : "policy_provider_fetch_error",
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: `policy_provider_http_${response.status}`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: "policy_provider_invalid_json",
    };
  }

  const text =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { content?: unknown }).content) &&
    typeof (body as { content: Array<{ text?: unknown }> }).content[0]?.text === "string"
      ? String((body as { content: Array<{ text: string }> }).content[0].text)
      : "";

  if (!text) {
    return {
      match_state: "unavailable",
      provider_version: POLICY_PROVIDER_VERSION,
      reason: "policy_provider_empty_output",
    };
  }

  const parsed = parseProviderJson(text);
  const rawStatus = parsed?.status;
  if (typeof rawStatus !== "string" || !VALID_POLICY_STATUS.has(rawStatus as PolicyAssessmentStatus)) {
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
