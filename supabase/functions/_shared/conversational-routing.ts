/**
 * Product-ready conversational routing for widget input.
 *
 * Conservative by design:
 * - greeting/thanks/acknowledgement => conversational (skip KB, AI can answer naturally)
 * - emoji/punctuation/noise-only => clarify locally, never human-handoff
 * - any plausible semantic text => normal generate-reply path
 *
 * This module MUST NOT classify policy/product/order questions as noise.
 */

export type ConversationalRoute =
  | { kind: "normal" }
  | { kind: "conversational"; subtype: "greeting" | "thanks" | "ack" }
  | { kind: "clarify"; language: "zh-TW" | "zh-CN" | "en"; reason: "noise_only" };

const GREETING = /^(hi|hello|hey|你好|您好|嗨|哈囉|哈啰|早安|午安|晚安|good\s*(morning|afternoon|evening))[\s!！。.？?，,~～]*$/i;
const THANKS = /^(thanks|thank you|thx|謝謝|谢谢|多謝|多谢)[\s!！。.？?，,~～]*$/i;
const ACK = /^(ok|okay|好的|好|明白|收到|嗯|唔該|唔该)[\s!！。.？?，,~～]*$/i;

function languageOf(text: string): "zh-TW" | "zh-CN" | "en" {
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  return /[们这没请转为]/.test(text) ? "zh-CN" : "zh-TW";
}

export function classifyConversationalRoute(text: string): ConversationalRoute {
  const raw = text.trim();
  if (!raw) return { kind: "normal" };

  if (GREETING.test(raw)) return { kind: "conversational", subtype: "greeting" };
  if (THANKS.test(raw)) return { kind: "conversational", subtype: "thanks" };
  if (ACK.test(raw)) return { kind: "conversational", subtype: "ack" };

  // Remove whitespace, punctuation, symbols and emoji. If no letters/numbers/CJK
  // remain, there is no factual question to ground in KB and no reason to hand off.
  const semantic = raw
    .replace(/\s+/g, "")
    .replace(/[\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");

  if (semantic.length === 0) {
    return { kind: "clarify", language: languageOf(raw), reason: "noise_only" };
  }

  return { kind: "normal" };
}

export const NOISE_CLARIFICATION: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW": "我收到你的訊息了 🙂 你可以再告訴我想了解或處理甚麼嗎？我會盡量直接幫你。",
  "zh-CN": "我收到你的消息了 🙂 你可以再告诉我想了解或处理什么吗？我会尽量直接帮你。",
  en: "I got your message 🙂 Could you tell me what you'd like to know or get help with? I'll do my best to help directly.",
};
