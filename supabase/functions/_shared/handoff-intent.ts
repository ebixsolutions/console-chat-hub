/**
 * Task 3.3 — Canonical deterministic handoff-intent classifier.
 *
 * Single source of truth for "does the customer explicitly ask, right now, to be
 * transferred to a human agent?". Used by BOTH generate-reply paths
 * (legacyGenerateReply + orchestrationGenerateReply), by widget-live-ai-test and
 * by the escalation live/shadow contexts, so R1 semantics cannot drift.
 *
 * Conservative by contract:
 * - ONLY an unambiguous present-tense explicit request may trigger R1.
 * - Negation / prohibition ("唔好轉真人", "我未叫你轉真人") NEVER triggers R1 and
 *   sets pure_handoff_negation.
 * - Conditional / future / reference / hypothetical / question mentions
 *   ("如果...之後先考慮搵真人", "你頭先話可以轉真人", "真人客服係咪24小時?")
 *   NEVER trigger R1.
 *
 * Pure module: no IO, no env, no DB.
 */

export type HandoffIntentCategory =
  | "explicit_request"
  | "negated_request"
  | "conditional_or_future"
  | "reference_or_report"
  | "informational_question"
  | "mention_only"
  | "no_mention";

export interface HandoffIntentClassification {
  category: HandoffIntentCategory;
  /** true only for an unambiguous present-tense explicit request (R1 eligible). */
  explicit_request: boolean;
  /** true when the customer mentions human handoff only to refuse/deny/prohibit it. */
  pure_handoff_negation: boolean;
  mentions_human_handoff: boolean;
  language: "zh-TW" | "zh-CN" | "en";
  matched_terms: string[];
}

const HUMAN_TERMS_ZH = [
  "轉真人",
  "转真人",
  "轉人工",
  "转人工",
  "真人客服",
  "人工客服",
  "搵真人",
  "找真人",
  "找人工",
  "真人",
  "人工",
];

const HUMAN_TERMS_EN = [
  "human agent",
  "live agent",
  "real person",
  "human support",
  "human being",
  "speak to human",
  "speak to a human",
  "talk to human",
  "talk to a human",
  "speak to someone",
  "talk to someone",
  "customer service agent",
  "support agent",
  "real agent",
  // Bare mentions: alone they are only a mention; category precedence still
  // suppresses negated, conditional, referenced and informational uses.
  "human",
  "agent",
  "operator",
  "representative",
];


const NEGATION_MARKERS = [
  "唔好",
  "唔係",
  "唔需要",
  "唔想",
  "唔使",
  "唔用",
  "不要",
  "不用",
  "不需要",
  "不想",
  "別",
  "别",
  "未叫",
  "沒叫",
  "没叫",
  "沒有叫",
  "没有叫",
  "無叫",
  "无叫",
  "沒要求",
  "没要求",
  "停止",
  "取消",
  "don't",
  "do not",
  "dont",
  "no need",
  "not asking",
  "never asked",
  "didn't ask",
  "did not ask",
  "i am not asking",
  "stop transferring",
  "no human",
];

const CONDITIONAL_MARKERS = [
  "如果",
  "假如",
  "萬一",
  "万一",
  "倘若",
  "要係",
  "之後",
  "之后",
  "稍後",
  "稍后",
  "待會",
  "待会",
  "遲啲",
  "迟点",
  "下次",
  "先考慮",
  "先考虑",
  "再考慮",
  "再考虑",
  "或者",
  "可能需要",
  "if ",
  "later",
  "maybe",
  "might need",
  "in case",
  "afterwards",
  "eventually",
];

const REFERENCE_MARKERS = [
  "頭先",
  "头先",
  "剛才",
  "刚才",
  "剛剛",
  "刚刚",
  "之前你",
  "你話",
  "你说",
  "你說",
  "你講",
  "你讲",
  "上次",
  "系統話",
  "系统说",
  "you said",
  "you mentioned",
  "earlier you",
  "last time",
];

const QUESTION_MARKERS = [
  "係咪",
  "是不是",
  "是否",
  "嗎",
  "吗",
  "呢",
  "幾點",
  "几点",
  "有無",
  "有没有",
  "可以嗎",
  "可以吗",
  "is there",
  "are there",
  "do you have",
  "does your",
  "what time",
  "how long",
  "available",
  "opening hours",
];

const PRESENT_REQUEST_MARKERS = [
  "而家",
  "現在",
  "现在",
  "即刻",
  "立即",
  "馬上",
  "马上",
  "請直接",
  "请直接",
  "請轉",
  "请转",
  "要轉",
  "要转",
  "麻煩轉",
  "麻烦转",
  "唔該轉",

  "直接轉",
  "直接转",
  "幫我轉",
  "帮我转",
  "幫我搵",
  "帮我找",
  "幫我接",
  "帮我接",
  "我要",
  "我想要",
  "我需要",
  "轉我",
  "转我",
  "接我",
  "正式",
  "please transfer",
  "transfer me",
  "connect me",
  "get me",
  "put me through",
  "i want",
  "i need",
  "i would like",
  "let me speak",
  "let me talk",
];

function normalize(text: string): string {
  return (text ?? "").normalize("NFKC").trim();
}

export function detectHandoffLanguageHint(text: string): "zh-TW" | "zh-CN" | "en" {
  const raw = normalize(text);
  if (!/[\u4e00-\u9fff]/.test(raw)) return "en";
  return /[转们队为说讲刚迟点边]/.test(raw) ? "zh-CN" : "zh-TW";
}

function matches(haystackLower: string, raw: string, terms: string[]): string[] {
  const hit: string[] = [];
  for (const term of terms) {
    if (/[a-z]/.test(term) ? haystackLower.includes(term) : raw.includes(term)) hit.push(term);
  }
  return hit;
}

/**
 * Canonical classifier. Category precedence is deliberate and conservative:
 * negation > conditional/future > reference/report > informational question >
 * explicit present request > bare mention.
 */
export function classifyHandoffIntent(text: string): HandoffIntentClassification {
  const raw = normalize(text);
  const lower = raw.toLowerCase();
  const language = detectHandoffLanguageHint(raw);

  const mentionTerms = [
    ...matches(lower, raw, HUMAN_TERMS_ZH),
    ...matches(lower, raw, HUMAN_TERMS_EN),
  ];
  const mentions = mentionTerms.length > 0;

  const base: HandoffIntentClassification = {
    category: "no_mention",
    explicit_request: false,
    pure_handoff_negation: false,
    mentions_human_handoff: mentions,
    language,
    matched_terms: mentionTerms,
  };

  if (!mentions) return base;

  if (matches(lower, raw, NEGATION_MARKERS).length > 0) {
    return { ...base, category: "negated_request", pure_handoff_negation: true };
  }

  if (matches(lower, raw, CONDITIONAL_MARKERS).length > 0) {
    return { ...base, category: "conditional_or_future" };
  }

  if (matches(lower, raw, REFERENCE_MARKERS).length > 0) {
    return { ...base, category: "reference_or_report" };
  }

  const isQuestion = /[?？]$/.test(raw) || matches(lower, raw, QUESTION_MARKERS).length > 0;
  const hasPresentRequest = matches(lower, raw, PRESENT_REQUEST_MARKERS).length > 0;

  if (isQuestion && !hasPresentRequest) {
    return { ...base, category: "informational_question" };
  }

  if (hasPresentRequest) {
    return { ...base, category: "explicit_request", explicit_request: true };
  }

  return { ...base, category: "mention_only" };
}

/** Backwards-compatible boolean gate: R1 eligibility only. */
export function isExplicitHandoffRequest(text: string): boolean {
  return classifyHandoffIntent(text).explicit_request;
}

/** True when the only handoff mention is a refusal/denial of handoff. */
export function isPureHandoffNegation(text: string): boolean {
  return classifyHandoffIntent(text).pure_handoff_negation;
}

/** Language for safe handoff wording; null when no R1-eligible request. */
export function explicitHandoffLanguage(text: string): "zh-TW" | "zh-CN" | "en" | null {
  const result = classifyHandoffIntent(text);
  return result.explicit_request ? result.language : null;
}
