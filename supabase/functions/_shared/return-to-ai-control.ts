export const RETURN_TO_AI_CONTROL_GUARD_VERSION = "return-to-ai-control-v1" as const;

export function buildReturnToAiGenerationGuard(
  latestHandoffReason: string | null | undefined,
  assignedAgentId: string | null | undefined,
): string {
  const reason = String(latestHandoffReason ?? "").trim().toLowerCase();
  if (reason !== "return to ai" || assignedAgentId) return "";
  return [
    "Conversation control state: AI_ACTIVE_AFTER_EXPLICIT_RETURN_TO_AI.",
    "- The conversation was explicitly returned from human control to AI control.",
    "- Do NOT tell the customer that a human agent will reply, contact them, take over, or follow up unless the CURRENT visitor turn independently triggers a new governed handoff.",
    "- Historical handoff messages are past state only; do not continue or restate them as current status.",
    "- Continue the current customer conversation normally under AI control.",
  ].join("\n");
}
