/**
 * Task 3.3 — Canonical human-control state, shared by every AI reply path and by
 * the Live AI Test preview.
 *
 * When a conversation is under human control, AI generation is suppressed and the
 * customer-facing surface shows a normal "waiting for a human agent" state — not
 * an error, and not a silent dead end.
 *
 * Pure module: no IO, no env, no DB.
 */

export const HUMAN_CONTROL_STATUSES: readonly string[] = [
  "human_control",
  "human_needed",
  "pending_human",
  "transferred",
  "assigned",
];

export type HumanControlState = "none" | "waiting" | "assigned";

export interface HumanControlInput {
  status?: string | null;
  assigned_agent_id?: string | null;
}

export interface HumanControlAssessment {
  human_control: boolean;
  /** AI must not generate or persist a reply while true. */
  ai_suppressed: boolean;
  state: HumanControlState;
  status: string | null;
}

export function assessHumanControl(input: HumanControlInput): HumanControlAssessment {
  const status = (input.status ?? null) as string | null;
  const assigned = Boolean(input.assigned_agent_id);
  const statusControlled = status !== null && HUMAN_CONTROL_STATUSES.includes(status);
  const humanControl = statusControlled || assigned;

  return {
    human_control: humanControl,
    ai_suppressed: humanControl,
    state: humanControl ? (assigned ? "assigned" : "waiting") : "none",
    status,
  };
}

export function isHumanControlled(input: HumanControlInput): boolean {
  return assessHumanControl(input).human_control;
}

export const HUMAN_CONTROL_CUSTOMER_NOTICE: Record<"zh-TW" | "zh-CN" | "en", Record<"waiting" | "assigned", string>> = {
  "zh-TW": {
    waiting: "已為你安排真人客服跟進，請稍等一下。",
    assigned: "真人客服已接手這個對話，會直接回覆你。",
  },
  "zh-CN": {
    waiting: "已为你安排真人客服跟进，请稍等一下。",
    assigned: "真人客服已接手这个对话，会直接回复你。",
  },
  en: {
    waiting: "A human agent is being arranged for you — please hold on a moment.",
    assigned: "A human agent has taken over this conversation and will reply to you directly.",
  },
};
