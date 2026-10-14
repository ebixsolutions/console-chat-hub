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
  | { kind: "clarify"; language: "zh-TW" | "zh-CN" | "en"; reason: "noise_only" }
  | {
      kind: "underspecified";
      language: "zh-TW" | "zh-CN" | "en";
      reason: "semantic_intent_underspecified";
    };

const GREETING_TOKEN = "(?:hi|hello|hey|你好|您好|嗨|哈囉|哈啰|早晨|早安|午安|晚安|good\\s*(?:morning|afternoon|evening))";
const GREETING_SEPARATOR = "[\\s\\p{P}~～]+";
const GREETING = new RegExp(
  String.raw`^${GREETING_TOKEN}(?:${GREETING_SEPARATOR}${GREETING_TOKEN})*[\s\p{P}~～]*$`,
  "iu",
);
/** Whole-turn grammar only. Every constituent must be recognised; an unknown
 * remainder (including a merchant question/correction) keeps the normal path.
 * This recognises conversational acts, not a list of three customer sentences. */
export type NonFactualConversation = "opening" | "acknowledgement" | "wellbeing" | "identity";
const SOCIAL_ACTS: Array<[NonFactualConversation, RegExp]> = [
  ["opening", new RegExp(`^${GREETING_TOKEN}(?=$|[\\s\\p{P}~～]|你|您)`, "iu")],
  ["wellbeing", /^(?:how\s+(?:are|r)\s+(?:you|u)(?:\s+doing)?(?:\s+(?:today|this\s+(?:morning|afternoon|evening)))?|how(?:'s| is)\s+it\s+going|how\s+have\s+you\s+been|你(?:今日|今天|最近)?(?:好嗎|好吗|好唔好|點呀|點啊|點樣|点样|近排點|最近怎麼樣|最近怎么样)|最近(?:好嗎|好吗)|食咗飯未)(?=$|[\s\p{P}])/iu],
  ["identity", /^(?:who\s+(?:are|r)\s+(?:you|u)|what(?:['’]s| is)\s+your\s+(?:name|role)|what\s+(?:is|are)\s+you(?:r\s+(?:name|role))?|what\s+do\s+you\s+do|what\s+can\s+you\s+(?:do|help(?:\s+me)?\s+with)|(?:are|r)\s+(?:you|u)\s+(?:an?\s+)?(?:ai(?:\s+(?:assistant|customer\s+support\s+assistant))?|bot|chatbot|robot|human|person|real\s+person)|你(?:係|是)(?:邊個|誰|谁|咩|什麼|什么|真人|人類|人类|機械人|机器人|AI|人工智能)(?:嗎|吗|呀|啊)?|你(?:叫|嘅名係|的名字是)(?:咩|什麼|什么)(?:名(?:字)?)?|你(?:有咩|有什麼|有什么)(?:職責|职责)|你(?:是|係)做(?:什麼|什么|咩)(?:的|嘅)?)(?=$|[\s\p{P}])/iu],
  ["acknowledgement", /^(?:thanks(?:\s+(?:a lot|you))?|thank\s+you|ok(?:ay)?|got\s+it|understood|明白(?:了|啦)?|知道了|收到|好(?:的|呀|啊)?|多謝(?:你)?|謝謝(?:你)?|谢谢(?:你)?)(?=$|[\s\p{P}])/iu],
];
export function classifyNonFactualConversation(text: string): NonFactualConversation | null {
  let rest = text.normalize("NFKC").trim().replace(/[’]/g, "'");
  if (!rest) return null;
  const acts: NonFactualConversation[] = [];
  // Do not slice input: unconsumed business text can never become a social turn.
  while (rest && acts.length < 12) {
    const found = SOCIAL_ACTS.map(([act, re]) => ({act, match: rest.match(re)}))
      .find(x => x.match);
    if (!found?.match) return null;
    acts.push(found.act);
    rest = rest.slice(found.match[0].length).replace(/^[\s\p{P}~～]+/u, "");
    if (rest) rest = rest.replace(/^(?:and\s+|同埋|以及|仲有)/iu, "");
  }
  if (rest) return null;
  return acts.includes("identity") ? "identity" : acts.includes("wellbeing") ? "wellbeing"
    : acts.includes("opening") ? "opening" : "acknowledgement";
}

const THANKS = /^(thanks|thank you|thx|謝謝|谢谢|多謝|多谢)[\s!！。.？?，,~～]*$/i;
const ACK = /^(ok|okay|好的|好|明白|收到|嗯|唔該|唔该)[\s!！。.？?，,~～]*$/i;

/** Support-domain topics that are meaningful but not yet actionable on their own. */
const DOMAIN_TOPICS = [
  "訂單",
  "订单",
  "退款",
  "退貨",
  "退货",
  "換貨",
  "换货",
  "送貨",
  "送货",
  "運費",
  "运费",
  "付款",
  "付費",
  "付费",
  "帳戶",
  "账户",
  "會員",
  "会员",
  "優惠",
  "优惠",
  "發票",
  "发票",
  "維修",
  "维修",
  "保養",
  "保养",
  "order",
  "refund",
  "return",
  "exchange",
  "delivery",
  "shipping",
  "payment",
  "account",
  "invoice",
  "warranty",
  "repair",
  "coupon",
];

/** Vague back-references with no resolvable target on their own. */
const VAGUE_REFERENCES = [
  "之前嗰樣",
  "之前那個",
  "之前那个",
  "嗰樣嘢",
  "嗰个",
  "嗰個",
  "上次那個",
  "上次那个",
  "那件事",
  "件事",
  "個問題",
  "个问题",
  "that thing",
  "the previous one",
  "the other thing",
  "my issue",
];

/** Markers that make an intent specific enough to attempt a grounded answer. */
const SPECIFICITY_MARKERS = [
  "甚麼",
  "什麼",
  "什么",
  "怎樣",
  "怎样",
  "怎麼",
  "怎么",
  "點樣",
  "点样",
  "邊個",
  "哪個",
  "哪个",
  "幾",
  "几",
  "多少",
  "可以嗎",
  "可以吗",
  "條件",
  "条件",
  "期限",
  "政策",
  "規定",
  "规定",
  "流程",
  "what",
  "how",
  "when",
  "where",
  "which",
  "why",
  "can i",
  "do i",
  "policy",
  "condition",
  "deadline",
  "process",
];


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

  if (isUnderspecifiedIntent(raw, semantic)) {
    return {
      kind: "underspecified",
      language: languageOf(raw),
      reason: "semantic_intent_underspecified",
    };
  }

  return { kind: "normal" };
}

function hasTerm(raw: string, terms: string[]): boolean {
  const lower = raw.toLowerCase();
  return terms.some((t) => (/[a-z]/.test(t) ? lower.includes(t) : raw.includes(t)));
}

/**
 * Short, meaningful-but-incomplete intents ("我有個訂單問題", "我想問退款",
 * "之前嗰樣嘢") must get ONE natural clarification question, never a handoff and
 * never a fabricated answer. Anything with a concrete question, number or
 * condition is treated as normal and grounded as usual.
 */
export function isUnderspecifiedIntent(text: string, semanticOverride?: string): boolean {
  const raw = (text ?? "").normalize("NFKC").trim();
  if (!raw) return false;

  const semantic =
    semanticOverride ??
    raw
      .replace(/\s+/g, "")
      .replace(/[\p{P}\p{S}\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
  if (semantic.length === 0) return false;

  if (hasTerm(raw, SPECIFICITY_MARKERS)) return false;
  if (/\d/.test(semantic)) return false;

  const isShort = /[\u4e00-\u9fff]/.test(semantic)
    ? semantic.length <= 12
    : semantic.split(/\s+/).length <= 8 && raw.split(/\s+/).length <= 8;
  if (!isShort) return false;

  return hasTerm(raw, VAGUE_REFERENCES) || hasTerm(raw, DOMAIN_TOPICS);
}

export const NOISE_CLARIFICATION: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW": "我收到你的訊息了 🙂 你可以再告訴我想了解或處理甚麼嗎？我會盡量直接幫你。",
  "zh-CN": "我收到你的消息了 🙂 你可以再告诉我想了解或处理什么吗？我会尽量直接帮你。",
  en: "I got your message 🙂 Could you tell me what you'd like to know or get help with? I'll do my best to help directly.",
};

/** ONE natural question for an underspecified but meaningful intent. */
export const UNDERSPECIFIED_CLARIFICATION: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW": "好的，我幫你跟進 🙂 可以說明一下具體是哪一項，或現在遇到甚麼情況嗎？",
  "zh-CN": "好的，我帮你跟进 🙂 可以说明一下具体是哪一项，或现在遇到什么情况吗？",
  en: "Sure, I can help with that 🙂 Could you tell me which one it is, or what's happening right now?",
};
