// Task J: Static error type extension map. No logic.

export const ERROR_MAP_AI_SUGGESTION = {
  SUGGESTION_SERVICE_UNAVAILABLE: "AI Suggestion service is temporarily unavailable",
  SUGGESTION_EF_NOT_DEPLOYED: "suggest-agent-reply Edge Function is not deployed (reserved for Task J-B)",
  SUGGESTION_LLM_TIMEOUT: "LLM request timed out during suggestion generation (reserved for Task J-B)",
  SUGGESTION_LLM_AUTH_FAILED: "LLM authentication failed (reserved for Task J-B)",
  SUGGESTION_EMPTY: "No suggestions could be generated for this conversation context",
  SUGGESTION_COACH_FLAG_BLOCKED: "Coach prompt adapter flag is disabled; using static fallback only",
};
