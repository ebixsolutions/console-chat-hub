// Product-ready static configuration for AI Chatbot settings UI.
//
// These are UI capability definitions and editable template defaults, not
// customer/demo/mock records. Runtime rows must come from live backend services.

export type ChannelType = "website_widget" | "whatsapp" | "email" | "line";

export type RatingType =
  | "stars_1_5"
  | "csat"
  | "nps"
  | "thumbs"
  | "ces"
  | "survey";

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

export interface SurveyQuestion {
  id: number;
  text: string;
  type: "text" | "yes_no" | "rating";
  fixed: boolean;
}

export const FEEDBACK_CHANNELS: Array<{
  key: string;
  label: string;
  phase: string;
}> = [
  { key: "email", label: "Email", phase: "Provider required" },
  { key: "website_widget", label: "Website Widget", phase: "Production" },
  { key: "sms", label: "SMS", phase: "Coming Soon" },
  { key: "whatsapp", label: "WhatsApp", phase: "Coming Soon" },
  { key: "wechat", label: "WeChat", phase: "Coming Soon" },
  { key: "line", label: "LINE", phase: "Coming Soon" },
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
    tooltip: "Basic questionnaire with 3–5 fixed questions.",
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

export const DEFAULT_SURVEY_QUESTIONS: SurveyQuestion[] = [
  { id: 1, text: "Overall service rating", type: "rating", fixed: true },
  { id: 2, text: "Was your issue fully resolved?", type: "yes_no", fixed: true },
  { id: 3, text: "What can we improve?", type: "text", fixed: true },
  { id: 4, text: "", type: "text", fixed: false },
  { id: 5, text: "", type: "text", fixed: false },
];
