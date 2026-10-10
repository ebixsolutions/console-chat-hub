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

export interface HumanServiceDiscussion {
  kind: "immediate" | "control_or_process" | "merchant_evidence" | "business_or_mixed" | "none";
  handoff: HandoffIntentClassification;
  process_question: boolean;
}

/** Read-only turn classification. Never infers a booking, availability or R1.
 * Unknown non-service clauses retain the normal semantic/KB path. In particular,
 * a service mention cannot remove factual work elsewhere in the same turn.
 */
export function classifyHumanServiceDiscussion(input: string): HumanServiceDiscussion {
  const text = String(input ?? "").normalize("NFKC").trim();
  let handoff = classifyHandoffIntent(text);
  const result = (kind: HumanServiceDiscussion["kind"], process_question = false) =>
    ({ kind, handoff, process_question });
  if (handoff.explicit_request) return result("immediate");
  if (!handoff.mentions_human_handoff) return result("none");
  // Clarify a denied quotation's meaning without changing R1 eligibility.
  if (/(?:引用|引述|quoted?|quotation|reported speech)/i.test(text) &&
      /(?:唔係|不是|並非|并非|唔好|不要|\bnot\b)/i.test(text)) {
    handoff = { ...handoff, category: "reference_or_report" };
  }
  // Bare commercial uses of 'agent' or '人工' are not support control.
  const serviceSubject = /真人|人工客服|人工服务|人工服務|转人工|轉人工|(?:human|live|support|customer service)\s+(?:agent|support)|real person|(?:transfer|connect|talk|speak).{0,25}(?:human|agent|representative)/i;
  if (!serviceSubject.test(text)) return result("business_or_mixed");
  const merchantEvidence = /(?:服務|服务|營業|营业|開放|开放|辦公|办公).{0,6}(?:時間|时间|時段|时段)|(?:真人|人工|客服).{0,25}(?:24\s*(?:小時|小时)|幾點|几点|幾時|几点|幾耐|多久|有冇人|有人嗎|有人吗|上班|收費|收费|免費|免费)|(?:hours|available|availability|opening|wait(?:ing)? time|\bETA\b|\bSLA\b|entitlement|eligib|收费|收費|保障|承諾|承诺|響應時間|响应时间)/i;
  const business = /(?:型號|型号|價錢|价钱|價格|价格|幾錢|多少钱|庫存|库存|送貨|送货|運費|运费|維修|维修|回收|冷氣|空調|空调|訂單|订单|付款|退款|退貨|退货|預算|预算|尺寸|面積|面积|清單|清单|總結|总结|回顧|回顾|記得|记得|\bprice\b|\bcost\b|\bstock\b|\bdelivery\b|\border\b|\brefund\b|\bproduct\b|\bmodel\b|\brecap\b|\bsummari[sz]e\b|\bremember\b|[A-Z]{2,}[- ]?\d{2,})/i;
  if (business.test(text)) return result("business_or_mixed");
  if (merchantEvidence.test(text)) return result("merchant_evidence");
  const process = /點(?:安排|處理|处理|樣|样)|怎(?:樣|样|麼|么)|如何|通常|流程|安排|處理|处理|\bhow\b|\bprocess\b|\bworkflow\b|\bwhat happens\b/i.test(text);
  // Keep unknown independent clauses for semantic interpretation. Control
  // corrections and reported-speech continuations can refer to a prior clause.
  const controlContinuation = /(?:唔係|不是|唔好|不要|並非|并非|唔使|不用|而家|現在|现在|引用|舊對話|旧对话|要求|轉交|转交|安排|處理|处理|\bnot\b|\brequest\b|\bquote\b|\bnow\b|\blater\b|\bprocess\b|\bhandoff\b|\bhow\b|\bwhat happens\b|通常)/i;
  const clauses = text.split(/[，,。!?！？;；\n]+|\b(?:and|but)\b/i).map(s => s.trim()).filter(Boolean);
  if (clauses.some(clause => !serviceSubject.test(clause) &&
    !controlContinuation.test(clause) && !/^(?:如果|假設|假设|假如|若果|若|明天|下次|等聽日|等听日|if|suppose|imagine|assuming|tomorrow|next|通常|可以點|可以点)/i.test(clause))) {
    return result("business_or_mixed");
  }
  // A closed control/process vocabulary is deliberately conservative: a new
  // business object in the SAME clause must not disappear behind 'how support
  // works'. Unknown words retain the semantic path, rather than being dropped.
  const remainder = text.toLowerCase()
    .replace(/\b(?:human|live|support|customer|service|agent|representative|real|person|friend|colleague|he|she|they|cancel|withdraw|revoke|tomorrow|next|week|month|day|time|year|imagine|assuming|fails?|failed|unresolved|resolved|problem|issue|transfer|connect|handoff|request|asks?|asking|quoted?|quotation|reported|speech|conversation|previous|old|earlier|said|wrote|mentioned|that|this|the|a|an|i|me|my|you|your|is|was|are|am|do|does|did|not|no|don't|please|to|for|of|in|if|suppose|assuming|hypothetically|later|future|now|need|want|would|could|can|only|how|what|happens|usually|process|workflow|work|works|it|and|but)\b/gi, "")
    .replace(/真人客服|人工客服|客服人員|客服人员|真人|人工|剛才|刚才|頭先|头先|之前|舊對話|旧对话|嗰句|那句話|那句话|客人|客戶|客户|引用|引述|唔係|不是|並非|并非|唔好|不要|不需要|唔使|不用|唔識答|唔识答|未解決|未解决|一直|如果|假設|假设|假如|若果|通常|日後|日后|以後|以后|之後|之后|取消|撤回|遲啲|迟点|聽日|听日|明天|下次|稍後|稍后|而家|現在|现在|轉交|转交|跟進|跟进|接手|可唔可以|可以|需要|要求|安排|處理|处理|流程|點樣|点样|怎樣|怎样|怎麼|怎么|如何|講清楚|讲清楚|資料|资料|資訊|资讯|信息|知道|了解|問|问|想|可能|考慮|考虑|轉|转|搵|找|幫|帮|請|请|我|你|佢|他|這|这|的|係|是|話|话|說|说|要|再|先|等|點|点|唔/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  if (remainder) return result("business_or_mixed");
  if (process || handoff.category !== "mention_only") return result("control_or_process", process);
  return result("business_or_mixed");
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

const HUMAN_ZH = /(真人|人工|客服|職員|职员)/;
const HUMAN_EN = /\b(human|live agent|human agent|real person|support agent|customer service)\b/i;
const NEG_HUMAN_ZH = /(?:取消|撤回|唔好|不要|不需要|唔需要|不想|唔想|唔使|不用|毋須|毋需|別|别|未需要|未要|而家未|現在未|现在未|唔係(?:而家|現在|现在)?(?:要求|要)|不是(?:現在|现在)?(?:要求|要)|並非(?:現在|现在)?(?:要求|要)|并非(?:現在|现在)?(?:要求|要)|未叫|冇叫|没有叫|沒有叫|禁止|不准|唔准).{0,8}(?:轉|转|接|搵|找|聯絡|联系|要|需要)?\s*(?:真人|人工|職員|职员|客服(?:人員|人员)?)|(?:真人|人工|職員|职员|客服(?:人員|人员)?).{0,8}(?:唔好|不要|唔使|不用|毋須|毋需|未需要|未要|禁止|不准|唔准)/;
const NEG_HUMAN_EN = /\b(?:cancel|withdraw|revoke|don't|do not|didn't|did not|not asking|not ask|no need|don't need|do not need|not yet|never)\b.{0,28}\b(?:connect|transfer|put|speak|want|need)?\b.{0,12}\b(?:human|live agent|human agent|real person|support agent|customer service)\b|\b(?:human|live agent|human agent|real person|support agent|customer service)\b.{0,20}\b(?:not needed|not required|no need|not yet)\b/i;
const AI_REJECT_HUMAN_REQUEST_ZH = /(?:唔好|不要|唔使|不用|毋須|毋需)\s*(?:AI|人工智能|機器人|机器人|bot).{0,24}(?:(?:我)?(?:而家|現在|现在|即刻|立即)?(?:要|想要|需要).{0,8}(?:真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(?:轉|转|接|搵|找|聯絡|联系).{0,8}(?:真人|人工|客服(?:人員|人员)?))/i;
const AI_REJECT_HUMAN_REQUEST_EN = /\b(?:don't|do not|no longer want|stop using)\b.{0,16}\b(?:ai|bot|robot|automation)\b.{0,40}\b(?:i want|i need|please connect|please transfer|connect me|transfer me|let me speak to)\b.{0,16}\b(?:a\s+)?(?:human|live agent|human agent|real person|customer service)\b/i;
const CONDITIONAL_ZH = /(如果|若果|如果.*先|先至|才|除非|答唔到|答不到|查唔到|查不到)/;
const CONDITIONAL_EN = /\b(if|only if|unless|in case)\b/i;
const FUTURE_ZH = /(之後|之后|遲啲|迟点|遲些|稍後|稍后|日後|以后|以後|到時|到时|聽日|听日|明天|下次|再考慮|再考虑|可能)/;
const FUTURE_EN = /\b(later|afterwards|after that|eventually|maybe later|might later|in the future|tomorrow|next (?:week|month|day|time|year))\b/i;
const REFERENCE_ZH = /(你頭先|你刚才|你剛才|你之前|頭先話|刚才说|剛才說|提過|提过|講過|讲过|所謂|所谓|引用)/;
const REFERENCE_EN = /\b(you said|you mentioned|earlier|previously|before|quote|quoted)\b/i;
const QUESTION_ZH = /(係咪|是不是|是否|幾點|几点|幾時|何時|多久|幾耐|邊個|哪个|點樣|怎样|怎樣|可以嗎|可唔可以).*(真人|人工|職員|职员|客服)|(真人|人工|職員|职员|客服).*(係咪|是不是|是否|幾點|几点|幾時|何時|多久|幾耐|邊個|哪个|點樣|怎样|怎樣|可以嗎|可唔可以)/;
const QUESTION_EN = /\b(when|what|who|where|how|hours|available|open|close|can i|could i)\b.*\b(human|agent|customer service|support)\b|\b(human|agent|customer service|support)\b.*\b(when|what|who|where|how|hours|available|open|close)\b/i;
const HYPOTHETICAL_ZH = /(假如|假設|假设|例如|譬如|可唔可以轉|可不可以转|如果我要|如果想)/;
const HYPOTHETICAL_EN = /\b(hypothetically|suppose|imagine|assuming|what if|could i|would i be able to)\b/i;
const EXPLICIT_ZH = /(?:而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我要|我想|我需要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即).{0,4}(?:要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即)?(?:正式|明確|明确|確定|确定)(?:要|要求|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)/;
const EXPLICIT_EN = /\b(please\s+)?(connect|transfer|put|let)\s+me\s+(to|through to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)|\b(i want|i need|let me speak to|i want to speak to|i need to speak to|connect me to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)(\s+now)?\b/i;

// Imperatives in a coordinated customer request can become a new clause after
// "and / 並".  A bare imperative ("轉真人客服跟進") is still an explicit request,
// even when a preceding clause asks for a correction or recap.  Keep this
// anchored so descriptions of a transfer are not mistaken for commands.
const DIRECT_HANDOFF_IMPERATIVE_ZH = /^(?:(?:請|请|麻煩|麻烦|唔該|唔该)\s*)?(?:(?:幫我|帮我|替我|直接|而家|現在|现在|即刻|立即)\s*){0,2}(?:轉交|转交|轉|转|接|搵|找|聯絡|联系|交畀|交俾|交給|交给|安排)\s*(?:我|呢單|這單|这单|個案|案件|問題|问题)?\s*(?:去|畀|俾|給|给|到)?\s*(?:真人|人工|客服(?:人員|人员)?)/;
const FIRST_PERSON_HANDOFF_ACTION_ZH = /^(?:我想|我希望|我要|我需要|想|希望)\s*(?:轉交|转交|轉|转|接|搵|找|聯絡|联系|安排|交畀|交俾|交給|交给)\s*(?:去|畀|俾|給|给|到)?\s*(?:真人|人工|客服(?:人員|人员)?)/;
const DIRECT_HANDOFF_IMPERATIVE_EN = /^(?:please\s+)?(?:(?:now|immediately)\s+)?(?:transfer|connect|route|put|hand\s*off|send)\s+(?:(?:me|this\s+(?:conversation|chat|request|issue)|the\s+(?:conversation|chat|request|issue))\s+)?(?:over\s+)?(?:to|through\s+to)\s+(?:a\s+|an\s+)?(?:human|live agent|human agent|real person|customer service|support agent)\b/i;
// Quoted/reported imperatives describe someone's words, not a fresh request.
const QUOTED_ONLY_HANDOFF = /^(?:「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|'[^']*')\s*[。.!！?？]?$/;
const ATTRIBUTED_QUOTE_ZH = /^(?:客人|顧客|顾客|用戶|用户|職員|职员|佢|他|她|同事).{0,8}(?:話|话|說|说|表示|提到)\s*[：:]?\s*[「『“"]/;
const ATTRIBUTED_QUOTE_EN = /^(?:(?:the|my|a)\s+)?(?:customer|user|client|friend|colleague|he|she|they)\s+(?:said|asked|wrote|mentioned)\s*[:：]?\s*["“]/i;
const REPORTED_INTRO_ZH = /^(?:客人|顧客|顾客|用戶|用户|職員|职员|佢|他|她|同事).{0,8}(?:話|话|說|说|表示|提到)\s*[，,：:]/;
const REPORTED_INTRO_EN = /^(?:(?:the|my|a)\s+)?(?:customer|user|client|friend|colleague|he|she|they)\s+(?:said|asked|wrote|mentioned)\s*[:,]/i;

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

  if (QUOTED_ONLY_HANDOFF.test(raw) || ATTRIBUTED_QUOTE_ZH.test(raw) || ATTRIBUTED_QUOTE_EN.test(raw))
    return { ...base, category: "reference_or_report" };

  if (AI_REJECT_HUMAN_REQUEST_ZH.test(raw) || AI_REJECT_HUMAN_REQUEST_EN.test(raw))
    return {...base,category:"explicit_request",explicit_request:true};
  const handoffText = raw.replace(/(?:不需要|不要|唔需要|唔要)\s*(?:手機|手机|mobile\s*)?(?:App|付款|訂單|订单)|(?:do not|don't) (?:need|want|pay for) (?:an? )?(?:app|payment|order)/gi, "");
  if (NEG_HUMAN_ZH.test(handoffText) || NEG_HUMAN_EN.test(handoffText))
    return {...base,category:"negated_request",pure_handoff_negation:true};
  if (CONDITIONAL_ZH.test(raw) || CONDITIONAL_EN.test(raw) || FUTURE_ZH.test(raw) || FUTURE_EN.test(raw) || HYPOTHETICAL_ZH.test(raw) || HYPOTHETICAL_EN.test(raw))
    return {...base,category:"conditional_or_future"};
  if (REFERENCE_ZH.test(raw) || REFERENCE_EN.test(raw))
    return {...base,category:"reference_or_report"};
  // Asking for information ABOUT human support is not asking for a human.
  // Direct transfer/contact actions retain their existing interpretation; a
  // separately explicit clause is classified independently below.
  const asksServiceInformation = /(?:想知道|想了解|想問|想问|查詢|查询|介紹|介绍).{0,12}(?:真人|人工|客服)|(?:我要|我想|我需要).{0,8}(?:真人客服|人工客服)(?:嘅|的)?(?:服務時間|服务时间|流程|資料|资料|資訊|资讯)|\b(?:i want|i need)\s+(?:a\s+)?(?:human support|human agent)(?:'s)?\s+(?:information|hours|availability|process|workflow)\b/i.test(raw);
  const directContactAction = /(?:轉|转|接駁|接驳|聯絡|联系|搵|找).{0,8}(?:真人|人工|客服)|\b(?:transfer|connect|contact|speak to|talk to).{0,16}\b(?:human|agent)\b/i.test(raw);
  if (!directContactAction && /(?:請|请|想|要).{0,8}(?:介紹|介绍|解釋|解释|總結|总结|了解).{0,12}(?:真人|人工|客服).{0,12}(?:流程|時間|时间|渠道)|\b(?:explain|describe|summari[sz]e)\b.{0,30}\b(?:human|support)\b.{0,20}\b(?:process|workflow|hours)\b/i.test(raw))
    return {...base,category:"informational_question"};
  if ((!directContactAction && asksServiceInformation) || QUESTION_ZH.test(raw) || QUESTION_EN.test(raw))
    return {...base,category:"informational_question"};
  const request = EXPLICIT_ZH.test(raw) || EXPLICIT_EN.test(raw) ||
    DIRECT_HANDOFF_IMPERATIVE_ZH.test(raw) || FIRST_PERSON_HANDOFF_ACTION_ZH.test(raw) ||
    DIRECT_HANDOFF_IMPERATIVE_EN.test(raw) ||
    /(?:請|请|麻煩|麻烦|幫我|帮我|現在|现在|而家)?(?:安排|聯絡|联系).{0,12}(?:真人|人工|客服).{0,12}(?:接手|轉接|转接|協助|协助)|(?:please )?(?:arrange|contact).{0,20}(?:human|live agent).{0,20}(?:take over|help|support)/i.test(raw) ||
    // Action-object grammar accepts the case/enquiry as the transfer object,
    // and a human as its recipient; neither a bare staff mention nor a request
    // for support information authorizes R1.
    /(?:請|请|麻煩|麻烦|唔該|唔该).{0,20}(?:由)?(?:真人|人工|客服(?:人員|人员)?).{0,8}(?:接手|處理|处理)|(?:然後|然后|再|並|并)\s*(?:轉|转|轉交|转交).{0,6}(?:真人|人工|客服)|(?:我想|我要|我需要).{0,4}(?:同|與|与)(?:職員|职员).{0,6}(?:直接傾|直接谈|直接談|傾|交談|交谈)/i.test(raw) ||
    /\b(?:please\s+)?(?:transfer|connect|hand\s+over)\s+(?:this|the|my|our)\s+[^.!?;]{1,80}\s+to\s+(?:a\s+)?(?:human(?:\s+support)?\s+agent|live\s+agent|real\s+person)\b/i.test(raw);
  if (request) return {...base,category:"explicit_request",explicit_request:true};
  return { ...base, category: "mention_only" };
}

/** Shared clause boundaries for routing and business projection. */
export function splitHandoffClauses(text: string): string[] {
  return text.split(/[，,。!！;；\n]+|(?<!\d)\.(?!\d)|(?:並|并|而且|同時|同时)(?=.{0,12}(?:真人|人工))|\b(?:and|but)\s+(?=(?:please|transfer|connect|I (?:want|need))\b)/i).map((part) => part.trim()).filter(Boolean);
}

export function classifyHandoffIntent(text: string): HandoffIntentClassification {
  const language = detectHandoffLanguageHint(text);
  // Quoted commands are data, including third-party quotations whose author
  // is not in the bounded reported-speech lexicon. Never execute their verbs.
  // Apostrophes inside English words are not quotation delimiters.
  let quotedHuman = false;
  const unquoted = text.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|‘[^’]*’|(?<!\w)'[^']*'(?!\w)/g, quote => {
    if (HUMAN_ZH.test(quote) || HUMAN_EN.test(quote)) quotedHuman = true;
    return " ";
  });
  if (quotedHuman) {
    if (!HUMAN_ZH.test(unquoted) && !HUMAN_EN.test(unquoted)) {
      return { ...classifyHandoffClause(text), language, category: "reference_or_report",
        explicit_request: false, pure_handoff_negation: false };
    }
    // Recognised reported introductions retain the existing fresh first-person
    // override. Other attributions classify only the remaining live clauses.
    if (!REPORTED_INTRO_ZH.test(text.trim()) && !REPORTED_INTRO_EN.test(text.trim()))
      return classifyHandoffIntent(unquoted);
  }
  // A reported instruction remains reported even if its attribution and the
  // quoted imperative are separated by punctuation.
  if (REPORTED_INTRO_ZH.test(text.trim()) || REPORTED_INTRO_EN.test(text.trim())) {
    const reportedClauses = splitHandoffClauses(text);
    // A first-person, present-tense request AFTER the attributed quotation is
    // a new customer instruction; the quotation itself must never trigger R1.
    const quotedClauseEnd = classifyHandoffClause(reportedClauses[0] ?? "").mentions_human_handoff ? 1 : 2;
    const fresh = reportedClauses.slice(quotedClauseEnd).map((clause) =>
      clause.replace(/^(?:(?:但係|但|不過|另外|but|and)\s*)+/i, "").trim()
    ).find((clause) =>
      /^(?:我(?:而家|現在|现在|即刻)?(?:要|想|需要)|(?:而家|現在|现在)我(?:要|想|需要)|I\s+(?:want|need))/i.test(clause) &&
      classifyHandoffClause(clause).explicit_request
    );
    if (fresh) return { ...classifyHandoffClause(fresh), language };
    const reported = classifyHandoffClause(text);
    return { ...reported, language, category: "reference_or_report", explicit_request: false };
  }
  const clauses = splitHandoffClauses(text);
  const decisions = (clauses.length ? clauses : [text]).map(classifyHandoffClause);
  // A conditional antecedent governs the request in the same sentence, even
  // when punctuation separates the antecedent from its consequent.
  if (/^(?:如果|假如|假設|假设|若果|萬一|万一|倘若|除非|if\b|in case\b|suppose\b|imagine\b|assuming\b|hypothetically\b|tomorrow\b|next (?:week|month|day|time|year)\b|明天|下次|等聽日|等听日|之後|之后|遲啲|迟点)/i.test(text.trim()) && !/[。.!！]\s*(?:請|请|現在|现在|而家|please|now|I want)/i.test(text))
    return {...(decisions.find(d=>d.mentions_human_handoff) ?? classifyHandoffClause(text)),language,category:"conditional_or_future",explicit_request:false,pure_handoff_negation:false};
  const explicit = decisions.find((decision) => decision.explicit_request);
  const negated = decisions.find((decision) => decision.pure_handoff_negation);
  if (explicit && negated) {
    // A separately stated latest present-tense instruction can correct an
    // earlier refusal/reference. A comma-bound ambiguous reversal stays closed.
    const latest = decisions.at(-1);
    if (latest?.explicit_request && /[。;；.!！]\s*(?:我(?:而家|現在|现在|即刻)?(?:要|想|需要)|(?:請|请|麻煩|麻烦)|I\s+(?:want|need)|please)/i.test(text))
      return { ...latest, language };
    return { ...negated, language };
  }
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
