// Contract 08 §1.2 failure message catalog constants (L8A)
// KEY REFERENCES only — actual translations live in i18n system (deferred).
// Inline EN fallback strings provided for components without i18n.

export const MSG = {
  CONNECTING_SPECIALIST: "error.connecting_specialist",
  NOT_ENOUGH_INFO: "error.not_enough_info",
  SAFE_GENERIC: "error.safe_generic",
  TOO_MANY_MESSAGES: "error.too_many_messages",
  WIDGET_CONFIG: "error.widget_config",
  CONNECTION_LOST: "error.connection_lost",
  CONNECTION_FAILED: "error.connection_failed",
  PLEASE_RETRY: "error.please_retry",
  TEMPORARY_ISSUE: "error.temporary_issue",
  PAGE_NOT_FOUND: "error.page_not_found",
  WELCOME_BACK: "greeting.welcome_back",
  DEFERRED_SAVE: "Config save available after L7B binding.",
} as const;

export const MSG_EN = {
  CONNECTING_SPECIALIST:
    "We're experiencing a temporary issue. Let me connect you with a team member.",
  NOT_ENOUGH_INFO:
    "I don't have enough information to answer accurately. Let me transfer you.",
  SAFE_GENERIC:
    "I can help you with product and service questions. How can I assist you?",
  TOO_MANY_MESSAGES: "Too many messages. Please wait a moment.",
  WIDGET_CONFIG:
    "Widget configuration error. Please contact site administrator.",
  CONNECTION_LOST: "Connection lost. Reconnecting...",
  CONNECTION_FAILED: "Unable to connect. Please refresh the page.",
  PLEASE_RETRY: "Something went wrong. Please try again.",
  PAGE_NOT_FOUND: "Page not found.",
  WELCOME_BACK: "Welcome back! How can I help you today?",
  CUSTOMER_DEGRADED: "Customer information temporarily unavailable.",
  CUSTOMER_CONSENT_WITHDRAWN:
    "Customer has requested data privacy. Contact information is not available.",
  CUSTOMER_DO_NOT_PROFILE: "Profiling is disabled for this customer.",
  ANALYTICS_AGENT_SCOPE: "Showing your assigned conversations only.",
  ANALYTICS_EXPORT_ADMIN_ONLY: "Export available for admin only.",
} as const;

export type MsgKey = keyof typeof MSG;
