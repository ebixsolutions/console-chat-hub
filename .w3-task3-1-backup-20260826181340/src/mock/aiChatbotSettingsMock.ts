// ============================================================================
// AI Chatbot Settings — Centralised Mock Data
// Source of truth: Base44 nexus-ai-spiritual-hub zip
//   src/mock/aiChatbotMockData.js (lines 457-493)
// DO NOT expand mock rows without Director approval. Director D5 = A:
// Recent Requests must remain exactly ONE row (Mary Lee / conv-8016).
// ============================================================================

export type ChannelType = "website_widget" | "whatsapp" | "email" | "line";
export type ChannelStatus = "mock_preview" | "coming_soon";

export interface ChannelConfig {
  id: string;
  channel_type: ChannelType;
  channel_name: string;
  status: ChannelStatus;
  is_active: boolean;
  phase: string;
  recall_supported: boolean;
  recall_time_limit_minutes: number;
  notes: string;
}

export const mockChannelConfigs: ChannelConfig[] = [
  {
    id: "ch-001",
    channel_type: "website_widget",
    channel_name: "Website Live Chat",
    status: "mock_preview",
    is_active: true,
    phase: "Phase 1 Mock",
    recall_supported: true,
    recall_time_limit_minutes: 10,
    notes: "Mock mode — no real messages received",
  },
  {
    id: "ch-002",
    channel_type: "whatsapp",
    channel_name: "WhatsApp Business",
    status: "coming_soon",
    is_active: false,
    phase: "Phase 3",
    recall_supported: false,
    recall_time_limit_minutes: 0,
    notes: "WhatsApp does not guarantee message recall",
  },
  {
    id: "ch-003",
    channel_type: "email",
    channel_name: "Email Support",
    status: "coming_soon",
    is_active: false,
    phase: "Phase 3",
    recall_supported: false,
    recall_time_limit_minutes: 0,
    notes: "Email cannot be truly recalled — correction message only",
  },
  {
    id: "ch-004",
    channel_type: "line",
    channel_name: "LINE Official",
    status: "coming_soon",
    is_active: false,
    phase: "Phase 3",
    recall_supported: false,
    recall_time_limit_minutes: 0,
    notes: "LINE does not guarantee message recall",
  },
];

// ---------------------------------------------------------------------------

export type RatingType = "stars_1_5" | "csat" | "nps" | "thumbs" | "ces" | "survey";

export interface FeedbackAutomationConfig {
  is_enabled: boolean;
  send_after_days: 1 | 3 | 7;
  channels_enabled: string[];
  rating_type: RatingType;
  message_template_zh: string;
  message_template_en: string;
  skip_if_negative_sentiment: boolean;
  updated_by: string;
  updated_at: string;
  message_templates?: Record<RatingType, MessageTemplate>;
}

export const mockFeedbackAutomationConfig: FeedbackAutomationConfig = {
  is_enabled: true,
  send_after_days: 1,
  channels_enabled: ["email", "website_widget"],
  rating_type: "stars_1_5",
  message_template_zh: "感謝您聯絡我們！請為今次的服務體驗評分，您的意見對我們非常重要。",
  message_template_en:
    "Thank you for contacting us! Please rate your service experience. Your feedback helps us improve.",
  skip_if_negative_sentiment: false,
  updated_by: "System",
  updated_at: new Date(Date.now() - 86400000).toISOString(),
};

// ---------------------------------------------------------------------------

export type FeedbackRequestStatus = "scheduled" | "sent" | "responded" | "failed";

export interface FeedbackRequest {
  id: string;
  conversation_id: string;
  customer_name: string;
  channel_sent: string;
  status: FeedbackRequestStatus;
  scheduled_at: string;
  is_mock: boolean;
}

// Director D5 = A: EXACTLY ONE row. Do not add John/Priya/failed/responded.
export const mockFeedbackRequests: FeedbackRequest[] = [
  {
    id: "fb-001",
    conversation_id: "conv-8016",
    customer_name: "Mary Lee",
    channel_sent: "email",
    status: "scheduled",
    scheduled_at: new Date(Date.now() + 24 * 3600000).toISOString(),
    is_mock: true,
  },
];

// ---------------------------------------------------------------------------

export const FEEDBACK_CHANNELS: Array<{ key: string; label: string; phase: string }> = [
  { key: "email", label: "Email", phase: "Phase 2" },
  { key: "website_widget", label: "Website Widget", phase: "Phase 2" },
  { key: "sms", label: "SMS", phase: "Phase 3" },
  { key: "whatsapp", label: "WhatsApp", phase: "Phase 3" },
  { key: "wechat", label: "WeChat", phase: "Phase 3" },
  { key: "line", label: "LINE", phase: "Phase 3" },
];

export const RATING_TYPES: Array<{
  key: RatingType;
  label: string;
  suffix: string | null;
  suffixStyle: "plain" | "badge_blue";
  tooltip: string;
}> = [
  { key: "stars_1_5", label: "1–5 Stars", suffix: null, suffixStyle: "plain", tooltip: "" },
  { key: "csat", label: "CSAT", suffix: null, suffixStyle: "plain", tooltip: "" },
  { key: "nps", label: "NPS", suffix: null, suffixStyle: "plain", tooltip: "" },
  { key: "thumbs", label: "👍/👎", suffix: null, suffixStyle: "plain", tooltip: "" },
  { key: "ces", label: "CES", suffix: "(CES)", suffixStyle: "plain", tooltip: "" },
  {
    key: "survey",
    label: "Survey",
    suffix: "Basic",
    suffixStyle: "badge_blue",
    tooltip: "Basic questionnaire with 3-5 fixed questions. No drag-and-drop builder. Phase 1: Template preview only.",
  },
];

export const TEMPLATE_TABS: Array<{ key: RatingType; label: string }> = [
  { key: "stars_1_5", label: "1-5 Stars" },
  { key: "csat", label: "CSAT" },
  { key: "nps", label: "NPS" },
  { key: "thumbs", label: "Thumbs" },
  { key: "ces", label: "CES" },
  { key: "survey", label: "Survey" },
];

export interface MessageTemplate {
  subject: string;
  bodyEn: string;
  bodyZh: string;
  ctaEn: string;
  thankEn: string;
  thankZh: string;
  lowRatingEn: string;
  lowRatingZh: string;
}

// EXACT wording from Base44 zip line 36-43. Do not paraphrase.
export const DEFAULT_TEMPLATES: Record<RatingType, MessageTemplate> = {
  stars_1_5: {
    subject: "Please rate your recent service experience",
    bodyEn: "Thank you for contacting us! Please rate your service experience from 1 to 5 stars.",
    bodyZh: "感謝您聯絡我們！請為今次的服務體驗評分（1至5星）。",
    ctaEn: "Rate Now",
    thankEn: "Thank you for your feedback! We'll use your rating to improve our service.",
    thankZh: "感謝您的評分！我們會利用您的意見改善服務。",
    lowRatingEn: "We're sorry to hear that. A member of our team will contact you within 24 hours.",
    lowRatingZh: "我們非常抱歉！我們的客服將在24小時內聯絡您跟進。",
  },
  csat: {
    subject: "How satisfied were you with our service?",
    bodyEn: "Please rate your satisfaction: Very Satisfied / Satisfied / Neutral / Dissatisfied / Very Dissatisfied.",
    bodyZh: "請評估您的滿意度：非常滿意 / 滿意 / 一般 / 不滿意 / 非常不滿意。",
    ctaEn: "Rate Now",
    thankEn: "Thank you for your CSAT feedback!",
    thankZh: "感謝您的 CSAT 評分！",
    lowRatingEn: "We apologise and will follow up with you.",
    lowRatingZh: "我們深感抱歉，將盡快跟進。",
  },
  nps: {
    subject: "Would you recommend us to a friend?",
    bodyEn: "On a scale of 0–10, how likely are you to recommend our service to a friend or colleague?",
    bodyZh: "以0至10分，您有多大可能向朋友或同事推薦我們的服務？",
    ctaEn: "Rate Now",
    thankEn: "Thank you for your NPS feedback!",
    thankZh: "感謝您的 NPS 評分！",
    lowRatingEn: "We are sorry to hear this. We will reach out to understand your concerns.",
    lowRatingZh: "我們很遺憾聽到這個消息，將主動聯絡了解您的想法。",
  },
  thumbs: {
    subject: "Quick feedback on your recent support",
    bodyEn: "Was your issue resolved? 👍 Yes / 👎 No",
    bodyZh: "您的問題有被解決嗎？👍 是 / 👎 否",
    ctaEn: "Give Feedback",
    thankEn: "Thanks for your quick feedback!",
    thankZh: "感謝您的快速回饋！",
    lowRatingEn: "Sorry about that! We will look into your case.",
    lowRatingZh: "非常抱歉！我們將跟進您的個案。",
  },
  ces: {
    subject: "How easy was it to resolve your issue?",
    bodyEn: "Rate the effort required to resolve your issue: 1 (Very Easy) — 7 (Very Difficult).",
    bodyZh: "請評估解決問題所需的努力程度：1（非常容易）— 7（非常困難）。",
    ctaEn: "Rate Now",
    thankEn: "Thank you for your CES feedback!",
    thankZh: "感謝您的 CES 評分！",
    lowRatingEn: "We will work on making things easier for you.",
    lowRatingZh: "我們將努力讓流程更加順暢。",
  },
  survey: {
    subject: "We value your feedback — Quick Survey",
    bodyEn: "Please take 2 minutes to complete our short survey.",
    bodyZh: "請花2分鐘完成我們的短問卷。",
    ctaEn: "Start Survey",
    thankEn: "Thank you for completing the survey!",
    thankZh: "感謝您完成問卷！",
    lowRatingEn: "We appreciate your detailed feedback.",
    lowRatingZh: "感謝您的詳細意見。",
  },
};

export interface SurveyQuestion {
  id: number;
  text: string;
  type: "text" | "yes_no" | "rating";
  fixed: boolean;
}

export const DEFAULT_SURVEY_QUESTIONS: SurveyQuestion[] = [
  { id: 1, text: "Overall service rating", type: "rating", fixed: true },
  { id: 2, text: "Was your issue fully resolved?", type: "yes_no", fixed: true },
  { id: 3, text: "What can we improve?", type: "text", fixed: true },
  { id: 4, text: "", type: "text", fixed: false },
  { id: 5, text: "", type: "text", fixed: false },
];
