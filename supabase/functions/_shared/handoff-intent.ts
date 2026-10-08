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
  "請安排",
  "请安排",
  "安排真人",
  "安排人工",
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
  "我想轉",
  "我想转",
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

const HUMAN_ZH = /(真人|人工|客服)/;
const HUMAN_EN = /\b(human|live agent|human agent|real person|support agent|customer service)\b/i;
const NEG_HUMAN_ZH = /(?:唔好|不要|不需要|唔需要|不想|唔想|唔使|不用|毋須|毋需|別|别|未需要|未要|而家未|現在未|现在未|唔係要|不是要|並非要|并非要|未叫|冇叫|没有叫|沒有叫|禁止|不准|唔准).{0,8}(?:轉|转|接|搵|找|聯絡|联系|要|需要)?\s*(?:真人|人工|客服(?:人員|人员)?)|(?:真人|人工|客服(?:人員|人员)?).{0,8}(?:唔好|不要|唔使|不用|毋須|毋需|未需要|未要|禁止|不准|唔准)/;
const NEG_HUMAN_EN = /\b(?:don't|do not|didn't|did not|not asking|not ask|no need|don't need|do not need|not yet|never)\b.{0,28}\b(?:connect|transfer|put|speak|want|need)?\b.{0,12}\b(?:human|live agent|human agent|real person|support agent|customer service)\b|\b(?:human|live agent|human agent|real person|support agent|customer service)\b.{0,20}\b(?:not needed|not required|no need|not yet)\b/i;
const AI_REJECT_HUMAN_REQUEST_ZH = /(?:唔好|不要|唔使|不用|毋須|毋需)\s*(?:AI|人工智能|機器人|机器人|bot).{0,24}(?:(?:我)?(?:而家|現在|现在|即刻|立即)?(?:要|想要|需要).{0,8}(?:真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(?:轉|转|接|搵|找|聯絡|联系).{0,8}(?:真人|人工|客服(?:人員|人员)?))/i;
const AI_REJECT_HUMAN_REQUEST_EN = /\b(?:don't|do not|no longer want|stop using)\b.{0,16}\b(?:ai|bot|robot|automation)\b.{0,40}\b(?:i want|i need|please connect|please transfer|connect me|transfer me|let me speak to)\b.{0,16}\b(?:a\s+)?(?:human|live agent|human agent|real person|customer service)\b/i;
const CONDITIONAL_ZH = /(如果|若果|如果.*先|先至|才|除非|答唔到|答不到|查唔到|查不到)/;
const CONDITIONAL_EN = /\b(if|only if|unless|in case)\b/i;
const FUTURE_ZH = /(之後|之后|遲啲|迟点|遲些|稍後|稍后|日後|以后|以後|到時|到时|再考慮|再考虑|可能)/;
const FUTURE_EN = /\b(later|afterwards|after that|eventually|maybe later|might later|in the future)\b/i;
const REFERENCE_ZH = /(你頭先|你刚才|你剛才|你之前|頭先話|刚才说|剛才說|提過|提过|講過|讲过|所謂|所谓|引用)/;
const REFERENCE_EN = /\b(you said|you mentioned|earlier|previously|before|quote|quoted)\b/i;
const QUESTION_ZH = /(係咪|是不是|是否|幾點|几点|幾時|何時|多久|幾耐|邊個|哪个|點樣|怎样|怎樣|可以嗎|可唔可以).*(真人|人工|客服)|(真人|人工|客服).*(係咪|是不是|是否|幾點|几点|幾時|何時|多久|幾耐|邊個|哪个|點樣|怎样|怎樣|可以嗎|可唔可以)/;
const QUESTION_EN = /\b(when|what|who|where|how|hours|available|open|close|can i|could i)\b.*\b(human|agent|customer service|support)\b|\b(human|agent|customer service|support)\b.*\b(when|what|who|where|how|hours|available|open|close)\b/i;
const HYPOTHETICAL_ZH = /(假如|假設|假设|例如|譬如|可唔可以轉|可不可以转|如果我要|如果想)/;
const HYPOTHETICAL_EN = /\b(hypothetically|suppose|what if|could i|would i be able to)\b/i;
const EXPLICIT_ZH = /(?:而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我要|我想|我需要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即).{0,4}(?:要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即)?(?:正式|明確|明确|確定|确定)(?:要|要求|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)/;
const EXPLICIT_EN = /\b(please\s+)?(connect|transfer|put|let)\s+me\s+(to|through to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)|\b(i want|i need|let me speak to|i want to speak to|i need to speak to|connect me to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)(\s+now)?\b/i;

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

function hasScopedHandoffNegation(raw: string): boolean {
  return raw.split(/[，,。.!！?？;；]+/).some((clause) => {
    const lower = clause.toLowerCase();
    const mentionsHuman = matches(lower, clause, [
      ...HUMAN_TERMS_ZH,
      ...HUMAN_TERMS_EN,
    ]).length > 0;
    return mentionsHuman && matches(lower, clause, NEGATION_MARKERS).length > 0;
  });
}

/**
 * Canonical classifier. Category precedence is deliberate and conservative:
 * negation > conditional/future > reference/report > informational question >
 * explicit present request > bare mention.
 */
function classifyHandoffClause(text: string): HandoffIntentClassification {
  const raw = normalize(text);
  const lower = raw.toLowerCase();
  const language = detectHandoffLanguageHint(raw);

  const mentionTerms = [
    ...matches(lower, raw, HUMAN_TERMS_ZH),
    ...matches(lower, raw, HUMAN_TERMS_EN),
  ];
  const mentions = mentionTerms.length > 0 || HUMAN_ZH.test(raw) || HUMAN_EN.test(raw);

  const base: HandoffIntentClassification = {
    category: "no_mention",
    explicit_request: false,
    pure_handoff_negation: false,
    mentions_human_handoff: mentions,
    language,
    matched_terms: mentionTerms,
  };

  if (!mentions) return base;

  if (AI_REJECT_HUMAN_REQUEST_ZH.test(raw) || AI_REJECT_HUMAN_REQUEST_EN.test(raw))
    return {...base,category:"explicit_request",explicit_request:true};
  const handoffText = raw.replace(/(?:不需要|不要|唔需要|唔要)\s*(?:手機|手机|mobile\s*)?(?:App|付款|訂單|订单)|(?:do not|don't) (?:need|want|pay for) (?:an? )?(?:app|payment|order)/gi, "");
  if (NEG_HUMAN_ZH.test(handoffText) || NEG_HUMAN_EN.test(handoffText))
    return {...base,category:"negated_request",pure_handoff_negation:true};
  if (CONDITIONAL_ZH.test(raw) || CONDITIONAL_EN.test(raw) || FUTURE_ZH.test(raw) || FUTURE_EN.test(raw) || HYPOTHETICAL_ZH.test(raw) || HYPOTHETICAL_EN.test(raw))
    return {...base,category:"conditional_or_future"};
  if (REFERENCE_ZH.test(raw) || REFERENCE_EN.test(raw))
    return {...base,category:"reference_or_report"};
  if (QUESTION_ZH.test(raw) || QUESTION_EN.test(raw))
    return {...base,category:"informational_question"};
  const request = EXPLICIT_ZH.test(raw) || EXPLICIT_EN.test(raw) ||
    /(?:請|请|麻煩|麻烦|幫我|帮我|現在|现在|而家)?(?:安排|聯絡|联系).{0,12}(?:真人|人工|客服).{0,12}(?:接手|轉接|转接|協助|协助)|(?:please )?(?:arrange|contact).{0,20}(?:human|live agent).{0,20}(?:take over|help|support)/i.test(raw);
  if (request) return {...base,category:"explicit_request",explicit_request:true};
  return { ...base, category: "mention_only" };
}

/** Shared clause boundaries for routing and business projection. */
export function splitHandoffClauses(text: string): string[] {
  return text.split(/[，,。!！;；\n]+|(?<!\d)\.(?!\d)|(?:並|并|而且|同時|同时)(?=.{0,12}(?:真人|人工))|\b(?:and|but)\s+(?=(?:please|transfer|connect|I (?:want|need))\b)/i).map((part) => part.trim()).filter(Boolean);
}

export function classifyHandoffIntent(text: string): HandoffIntentClassification {
  const language = detectHandoffLanguageHint(text);
  const clauses = splitHandoffClauses(text);
  const decisions = (clauses.length ? clauses : [text]).map(classifyHandoffClause);
  // A conditional antecedent governs the request in the same sentence, even
  // when punctuation separates the antecedent from its consequent.
  if (/^(?:如果|假如|萬一|万一|倘若|if\b|in case\b)/i.test(text.trim()) && !/[。.!！]\s*(?:請|请|現在|现在|而家|please|now|I want)/i.test(text))
    return {...(decisions.find(d=>d.mentions_human_handoff) ?? classifyHandoffClause(text)),language,category:"conditional_or_future",explicit_request:false,pure_handoff_negation:false};
  const explicit = decisions.find((decision) => decision.explicit_request);
  const negated = decisions.find((decision) => decision.pure_handoff_negation);
  if (explicit && negated) return { ...negated, language };
  if (explicit) return { ...explicit, language };
  if (negated) return { ...negated, language };
  const mentioned = decisions.find((decision) => decision.mentions_human_handoff);
  return mentioned ? { ...mentioned, language } : classifyHandoffClause(text);
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
