// Task J: AI Suggestion Safety Contract — INVARIANT
// This file codifies the safety rules that ALL AI Suggestion implementations must follow.
// These rules are elevated from Inbox 4 Tabs PRD v1.4 as architectural invariants.
// Violating any rule is equivalent to violating Production Ready Standard v1.2 INV-4b.

export const AI_SUGGESTION_SAFETY_RULES = {
  DRAFT_ONLY: "Suggestions are draft-only. The system must NEVER auto-send any suggested reply.",
  HUMAN_SEND_REQUIRED: "Human agent explicit send action is the ONLY legitimate send pathway.",
  NO_BYPASS: "No configuration, feature flag, or admin override may bypass the draft-only rule.",
  PREFILL_ONLY: "Clicking 'Use' on a suggestion may ONLY prefill the ChatPanel input box. It must NOT trigger send.",
  COACH_FLAG_RESPECT: "Before C1-B approval, AI Suggestion must NOT use live Coach prompt. Only static fallback tone profile or empty coach_prompt_hint allowed.",
} as const;

export type AISuggestionSafetyRuleKey = keyof typeof AI_SUGGESTION_SAFETY_RULES;
