export const HUMAN_CONTROL_STATUSES = new Set([
  "pending",
  "transferred",
  "human_needed",
  "human_control",
  "escalation_risk",
  "unresolved",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTIVE_THINKING_MAX_AGE_MS = 5 * 60 * 1000;

export function isHumanControlState(status: unknown, assignedAgentId?: unknown): boolean {
  return Boolean(assignedAgentId) || (typeof status === "string" && HUMAN_CONTROL_STATUSES.has(status));
}

export function hasActiveThinkingClaim(
  rows: Array<{ created_at?: unknown; metadata?: unknown }>,
  nowMs = Date.now(),
): boolean {
  return rows.some((row) => {
    if (typeof row.created_at !== "string") return false;
    const createdMs = Date.parse(row.created_at);
    if (!Number.isFinite(createdMs) || createdMs > nowMs || nowMs - createdMs > ACTIVE_THINKING_MAX_AGE_MS) return false;
    if (!row.metadata || typeof row.metadata !== "object" || Array.isArray(row.metadata)) return false;
    const sourceMessageId = (row.metadata as Record<string, unknown>).source_message_id;
    return typeof sourceMessageId === "string" && UUID_RE.test(sourceMessageId);
  });
}
