import { classifyNonFactualConversation } from "./conversational-routing.ts";
import { isExplicitHandoffRequest } from "./handoff-intent.ts";
/** Closed zero-paid console-preview inputs. Ordinary customer traffic is unchanged. */
export const ORDINARY_PREVIEW_CONTRACT = "ordinary-widget-control-v1";
export const ORDINARY_PREVIEW_INPUTS = [
  "你是誰？", "Who are you?", "請轉真人客服", "Please connect me to a human.",
] as const;
export function ordinaryPreviewInputAllowed(value: unknown): boolean {
  return typeof value === "string" && (ORDINARY_PREVIEW_INPUTS as readonly string[]).includes(value.trim()) &&
    (classifyNonFactualConversation(value) !== null || isExplicitHandoffRequest(value));
}
