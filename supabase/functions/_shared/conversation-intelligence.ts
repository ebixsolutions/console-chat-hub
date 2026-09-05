import { classifyCanonicalConversationTurn, type SemanticLanguage } from "./conversation-semantic-contract.ts";

export type HandoffIntentKind =
  | "explicit_now"
  | "negated"
  | "conditional"
  | "future"
  | "reference"
  | "hypothetical"
  | "question_about_human_support"
  | "none";

export interface HandoffIntentClassification {
  kind: HandoffIntentKind;
  explicit_request: boolean;
  pure_negation: boolean;
  language: "zh-TW" | "zh-CN" | "en";
  reason: string;
}

export interface TurnClassification {
  kind: "trivial" | "underspecified" | "specific" | "follow_up" | "correction";
  should_clarify_before_kb: boolean;
  reason: string;
}

const HUMAN_ZH = /(真人|人工|客服)/;
const HUMAN_EN = /\b(human|live agent|human agent|real person|support agent|customer service)\b/i;
const NEG_HUMAN_ZH = /(?:唔好|不要|唔使|不用|毋須|毋需|別|别|未需要|未要|而家未|現在未|现在未|唔係要|不是要|並非要|并非要|未叫|冇叫|没有叫|沒有叫|禁止|不准|唔准).{0,8}(?:轉|转|接|搵|找|聯絡|联系|要|需要)?\s*(?:真人|人工|客服(?:人員|人员)?)|(?:真人|人工|客服(?:人員|人员)?).{0,8}(?:唔好|不要|唔使|不用|毋須|毋需|未需要|未要|禁止|不准|唔准)/;
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
const EXPLICIT_ZH = /(?:而家|現在|现在|即刻|立即).{0,8}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:請|请|麻煩|麻烦|幫我|帮我).{0,10}(轉|转|接|搵|找|聯絡|联系).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我要|我想|我需要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)|(?:我)?(?:而家|現在|现在|即刻|立即).{0,4}(?:要|想要|需要).{0,8}(真人|人工|客服(?:人員|人员)?)/;
const EXPLICIT_EN = /\b(please\s+)?(connect|transfer|put|let)\s+me\s+(to|through to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)|\b(i want|i need|let me speak to|i want to speak to|i need to speak to|connect me to)\s+(a\s+)?(human|live agent|human agent|real person|customer service)(\s+now)?\b/i;

function detectLanguage(text: string): "zh-TW" | "zh-CN" | "en" {
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  return /[转们为这没请]/.test(text) ? "zh-CN" : "zh-TW";
}

export function classifyHandoffIntent(text: string): HandoffIntentClassification {
  const t = text.normalize("NFKC").trim();
  const language = detectLanguage(t);
  const hasHuman = HUMAN_ZH.test(t) || HUMAN_EN.test(t);
  if (!hasHuman) return { kind: "none", explicit_request: false, pure_negation: false, language, reason: "no_human_support_reference" };

  // Target-aware contrast override: rejecting AI/bot while affirmatively asking
  // for a human is a present handoff request, not a human-handoff negation.
  if (AI_REJECT_HUMAN_REQUEST_ZH.test(t) || AI_REJECT_HUMAN_REQUEST_EN.test(t)) {
    return { kind: "explicit_now", explicit_request: true, pure_negation: false, language, reason: "ai_rejected_human_requested_now" };
  }
  if (NEG_HUMAN_ZH.test(t) || NEG_HUMAN_EN.test(t)) {
    return { kind: "negated", explicit_request: false, pure_negation: true, language, reason: "handoff_prohibited_or_negated" };
  }
  if (CONDITIONAL_ZH.test(t) || CONDITIONAL_EN.test(t)) {
    return { kind: "conditional", explicit_request: false, pure_negation: false, language, reason: "handoff_is_conditional" };
  }
  if (FUTURE_ZH.test(t) || FUTURE_EN.test(t)) {
    return { kind: "future", explicit_request: false, pure_negation: false, language, reason: "handoff_is_future_or_possible" };
  }
  if (REFERENCE_ZH.test(t) || REFERENCE_EN.test(t)) {
    return { kind: "reference", explicit_request: false, pure_negation: false, language, reason: "handoff_is_referenced_not_requested" };
  }
  if (HYPOTHETICAL_ZH.test(t) || HYPOTHETICAL_EN.test(t)) {
    return { kind: "hypothetical", explicit_request: false, pure_negation: false, language, reason: "handoff_is_hypothetical" };
  }
  if (QUESTION_ZH.test(t) || QUESTION_EN.test(t)) {
    return { kind: "question_about_human_support", explicit_request: false, pure_negation: false, language, reason: "question_about_human_support" };
  }
  if (EXPLICIT_ZH.test(t) || EXPLICIT_EN.test(t)) {
    return { kind: "explicit_now", explicit_request: true, pure_negation: false, language, reason: "unambiguous_present_handoff_request" };
  }
  return { kind: "none", explicit_request: false, pure_negation: false, language, reason: "human_support_mentioned_without_explicit_request" };
}

const TRIVIAL = /^(hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|ok|okay|好的|好|嗯|謝謝|谢谢|thanks|thank you)[!！。.？?，,\s]*$/i;
const CORRECTION = /(我講錯|我说错|我說錯|更正|其實係|其实是|唔係.*係|不是.*是|改返|改成|actually|correction|i meant|not .* but )/i;
const FOLLOW_UP_ZH = /^(咁|那|那麼|那么|所以|另外|仲有|还有|咁如果|那如果)/;
const FOLLOW_UP_EN = /^(then|so|also|what about|and what about|in that case)\b/i;
const DOMAIN_ONLY = /^(我有|我想問|我想问|想問|想问|請問|请问)?\s*(一個|一个|個|个)?\s*(訂單|订单|退款|退貨|退货|換貨|换货|送貨|送货|物流|付款|產品|产品|保養|保修|維修|维修|問題|问题)\s*(問題|问题|嘅問題|的問題)?[。.!！?？\s]*$/;
const VAGUE_REFERENCE = /^(之前嗰樣嘢|之前那件事|之前那个|嗰樣嘢|那個事情|那个事情|same thing|that thing|the previous thing)[。.!！?？\s]*$/i;

export function classifyConversationTurn(text: string): TurnClassification {
  const t = text.normalize("NFKC").trim();
  const handoff = classifyHandoffIntent(t);
  const semantic = classifyCanonicalConversationTurn(t, [], { explicit_handoff: handoff.explicit_request });
  switch (semantic.operation) {
    case "TRIVIAL":
      return { kind: "trivial", should_clarify_before_kb: false, reason: semantic.reason };
    case "UNDERSPECIFIED":
      return { kind: "underspecified", should_clarify_before_kb: true, reason: semantic.reason };
    case "CORRECTION":
      return { kind: "correction", should_clarify_before_kb: false, reason: semantic.reason };
    case "FOLLOW_UP_FACTUAL":
    case "PRONOUN_OR_ELLIPSIS":
    case "SIMPLIFY":
    case "REPHRASE":
    case "TRANSLATE":
    case "SUMMARIZE":
    case "RETURN_TO_PRIOR_TOPIC":
    case "CONVERSATION_MEMORY":
    case "CUSTOMER_CONTEXT_UPDATE":
      return { kind: "follow_up", should_clarify_before_kb: false, reason: semantic.reason };
    default:
      return { kind: "specific", should_clarify_before_kb: false, reason: semantic.reason };
  }
}

export function isHumanControlState(status: string | null | undefined, assignedAgentId: string | null | undefined): boolean {
  if (typeof assignedAgentId === "string" && assignedAgentId.length > 0) return true;
  return new Set(["pending", "transferred", "human_needed", "human_control"]).has(String(status ?? ""));
}

export function hasUsableFullContentEvidence(chunks: Array<{ chunk_type?: string; content?: string; score?: number }>, minScore: number): boolean {
  return chunks.some((c) => c.chunk_type === "full_content" && typeof c.content === "string" && c.content.trim().length > 0 && typeof c.score === "number" && c.score >= minScore);
}

export const CUSTOMER_CONVERSATION_POLICY = `Customer conversation policy (customer-facing):
- Speak naturally like a capable support representative, not like a diagnostic system.
- Continue the conversation across turns. Respect the newest correction when it supersedes an earlier fact or request.
- Never expose internal implementation terms such as Knowledge Base, KB, RAG, retrieval, evidence score, confidence score, provider, routing, matched rule, model, prompt, vector search, or full-content chunk.
- If the customer's request is incomplete or ambiguous, ask exactly one concise, context-specific question needed to continue. Do not offer a human merely because details are missing.
- If you cannot verify a fact from the available information, say naturally that you do not have enough information to confirm it and avoid guessing.
- Distinguish asking about whether an action is possible from actually requesting the action. Never claim an order/refund/cancellation/compensation was executed unless an authorized tool actually completed it.
- Anger, complaints, poor ratings, VIP status, high order value, or negative sentiment alone do not mean the customer asked for a human.
- A human handoff occurs only when the governed escalation layer has already decided it; do not invent or promise a handoff yourself.`;

export const NATURAL_CLARIFICATION: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW": "可以，想確認一下你主要想處理哪一方面？例如送貨、付款、取消，還是退換貨？",
  "zh-CN": "可以，想确认一下你主要想处理哪一方面？例如送货、付款、取消，还是退换货？",
  en: "Sure — which part would you like help with, for example delivery, payment, cancellation, or a return/refund?",
};

export function buildCustomerContextRequirementsResponse(
  language: SemanticLanguage,
  newestFirstMessages: ConversationHistoryRow[],
): string {
  const customerTurns = newestFirstMessages
    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))
    .map((row) => cleanContinuityText(row.content))
    .filter(Boolean)
    .slice(0, 12);
  const joined = customerTurns.join(" ");
  const missingModel = /(?:沒有|没有|冇|不知道|唔知).{0,8}(?:型號|型号)|(?:don't|do not) have (?:the )?(?:model|model number)/i.test(joined);
  const hasBrand = /(?:品牌(?:是|係)|brand is|\bpanasonic\b|\bsamsung\b|\blg\b|\bsony\b|\bwhirlpool\b)/i.test(joined);
  const hasApplianceType = /(?:冷氣|空調|空调|洗衣機|洗衣机|雪櫃|冰箱|電視|电视|家用電器|家用电器|air conditioner|washing machine|refrigerator|fridge|television|\btv\b)/i.test(joined);

  if (language === "en") {
    const known = missingModel ? "You’ve already told me you don’t have the model number, so you don’t need to repeat that. " : "";
    const asks = [];
    if (!hasApplianceType) asks.push("what type of appliance it is");
    if (!hasBrand) asks.push("the brand, if you know it");
    asks.push("roughly when you bought it", "what is happening now");
    return known + "Please tell me " + asks.join(", ") + ".";
  }
  const known = missingModel
    ? (language === "zh-CN" ? "你已经说目前没有型号，不用重复提供。" : "你已經說目前沒有型號，不用重複提供。")
    : "";
  if (language === "zh-CN") {
    return known + `请告诉我${hasApplianceType ? "更具体是哪一类家用电器" : "是哪一类家用电器"}${hasBrand ? "" : "、品牌（如果知道）"}、大约购买时间，以及目前出现的情况。`;
  }
  return known + `請告訴我${hasApplianceType ? "更具體是哪一類家用電器" : "是哪一類家用電器"}${hasBrand ? "" : "、品牌（如果知道）"}、大約購買時間，以及目前出現的情況。`;
}

export function buildCustomerContextAcknowledgement(language: SemanticLanguage): string {
  if (language === "en") {
    return "Got it. I’ll keep using the details you’ve provided and won’t guess anything that hasn’t been confirmed. If I need anything else, I’ll ask you directly.";
  }
  if (language === "zh-CN") {
    return "收到。我会继续使用你已提供的资料，未确认的部分不会自行猜测；如果还需要其他资料，我会直接告诉你。";
  }
  return "收到。我會繼續使用你已提供的資料，未確認的部分不會自行猜測；如果還需要其他資料，我會直接告訴你。";
}

export type ConversationHistoryRow = {
  role?: string;
  content?: string | null;
  metadata?: unknown;
};

function cleanContinuityText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

const CUSTOMER_ROLES = new Set(["visitor", "customer", "user"]);
const CORRECTION_OR_CONSTRAINT = /(我講錯|我说错|我說錯|更正|其實係|其实是|唔係.*係|不是.*是|改返|改成|唔好|不要|不准|唔准|只係想知|只是想知道|只想知道|actually|i meant|correction|don't|do not|not .* but|only asking|just asking)/i;

/**
 * Lightweight multi-turn state projection. This is deliberately deterministic,
 * bounded and in-memory: it does not invent facts and does not add a schema.
 * The newest customer statements are shown first so corrections and prohibitions
 * visibly supersede earlier context in the model's attention window.
 */
export function buildConversationContinuityBlock(
  newestFirstMessages: ConversationHistoryRow[],
): string {
  const customerTurns = newestFirstMessages
    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))
    .map((row) => cleanContinuityText(row.content))
    .filter(Boolean)
    .slice(0, 20);

  if (customerTurns.length < 2) return "";

  const corrections = customerTurns.filter((text) => CORRECTION_OR_CONSTRAINT.test(text)).slice(0, 6);
  const recent = customerTurns.slice(0, 8);
  const lines = [
    "Conversation continuity (internal guidance; never quote this block):",
    "- Treat the newest customer statement as authoritative when it corrects, narrows, cancels, or forbids an earlier request.",
    "- Do not re-ask a detail already supplied unless the customer made it ambiguous or contradictory.",
    "- Keep unresolved follow-up questions in context; do not pretend an action was requested when the customer only asked whether it is possible.",
  ];
  if (corrections.length) {
    lines.push("Latest corrections / constraints (newest first):");
    corrections.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  }
  const firstCustomerTurn = customerTurns[customerTurns.length - 1] ?? "";
  if (firstCustomerTurn) {
    lines.push("First customer turn in this conversation (oldest anchor):");
    lines.push(`1. ${firstCustomerTurn}`);
  }
  lines.push("Recent customer turns (newest first):");
  recent.forEach((text, i) => lines.push(`${i + 1}. ${text}`));
  return lines.join("\n").slice(0, 5000);
}

export interface ContextualRetrievalQuery {
  query: string;
  mode: "standalone" | "contextual";
  latest: string;
  context_turns: string[];
}

const CONTEXTUAL_FOLLOW_UP = /^(?:咁|那|那麼|那么|所以|另外|仲有|还有|咁如果|那如果|如果|再|又|而|同埋|還有|还有|what about|and what about|then|so|also|in that case|how about)/i;
const CONTEXTUAL_PRONOUN_START = /^(?:那個|那个|這個|这个|它|佢|他|她|嗰個|呢個|上述|剛才|刚才|之前|前面)(?:[的嘅呢那這这\s，,。.!！?？]|$)/i;
const CONTEXTUAL_PRONOUN_EN = /(?:^|[\s,.;!?])(that|this|it|they|them|those|these|the one|earlier|above)(?:$|[\s,.;!?])/i;
const CONTEXTUAL_STYLE_REQUEST = /^(?:(?:請|请)?(?:再)?(?:簡單|简单)(?:一點|一点|啲|些|點|点)?(?:地)?(?:解釋|解释|講|讲|說|说|介紹|介绍)?(?:給我聽|给我听|一下|啲|些)?|(?:請|请)?(?:再)?(?:詳細|详细)(?:一點|一点|啲|些|點|点)?(?:解釋|解释|講|讲|說|说)?(?:給我聽|给我听|一下)?|(?:用|改用)(?:繁體中文|繁体中文|簡體中文|简体中文|英文)(?:再)?(?:講|讲|解釋|解释|說|说)?(?:一次|一下)?|in english|explain(?: it| that)? (?:more )?simply|make it simpler|more detail|more details|simpler|shorter)(?:[。.!！?？\s].*)?$/i;
const CONTEXTUAL_ELLIPSIS = /(?:呢|嗎|吗|about that|and that|same one|same thing)[。.!！?？\s]*$/i;

function isRetrievalNoise(text: string): boolean {
  const t = text.trim();
  if (!t || TRIVIAL.test(t)) return true;
  const handoff = classifyHandoffIntent(t);
  return handoff.kind !== "none" && !handoff.pure_negation;
}

/**
 * Builds a bounded retrieval query before RAG. It never invents entities or facts:
 * contextual mode only combines the current customer request with prior customer
 * statements from the same trusted conversation history. Newest corrections remain
 * visible and old assistant/system text is never used as factual context.
 */
export function buildContextualRetrievalQuery(
  latestMessage: string,
  newestFirstMessages: ConversationHistoryRow[],
): ContextualRetrievalQuery {
  const latest = cleanContinuityText(latestMessage);
  if (!latest) return { query: "", mode: "standalone", latest: "", context_turns: [] };

  const turns = newestFirstMessages
    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))
    .map((row) => cleanContinuityText(row.content))
    .filter(Boolean)
    .slice(0, 20);

  let skippedCurrent = false;
  const previousTurns = turns.filter((text) => {
    if (!skippedCurrent && text === latest) {
      skippedCurrent = true;
      return false;
    }
    return true;
  });

  if (previousTurns.length === 0) {
    return { query: latest, mode: "standalone", latest, context_turns: [] };
  }

  const turnClass = classifyConversationTurn(latest);
  const shortContinuation = latest.length <= 40 && (
    CONTEXTUAL_FOLLOW_UP.test(latest) ||
    CONTEXTUAL_PRONOUN_START.test(latest) ||
    CONTEXTUAL_PRONOUN_EN.test(latest) ||
    CONTEXTUAL_STYLE_REQUEST.test(latest) ||
    CONTEXTUAL_ELLIPSIS.test(latest)
  );
  const needsContext = turnClass.kind === "follow_up" ||
    turnClass.kind === "correction" ||
    shortContinuation;

  if (!needsContext) {
    return { query: latest, mode: "standalone", latest, context_turns: [] };
  }

  const contextTurns = previousTurns
    .filter((text) => !isRetrievalNoise(text))
    .slice(0, 3);
  if (contextTurns.length === 0) {
    return { query: latest, mode: "standalone", latest, context_turns: [] };
  }

  const query = [
    "Current request: " + latest,
    "Relevant prior customer context: " + contextTurns.join(" / "),
  ].join("\n").slice(0, 1200);

  return { query, mode: "contextual", latest, context_turns: contextTurns };
}

export function buildConversationAssistRetrievalQuery(
  assistanceInput: string,
  newestFirstMessages: ConversationHistoryRow[],
): ContextualRetrievalQuery {
  const latest = cleanContinuityText(assistanceInput);
  if (!latest) return { query: "", mode: "standalone", latest: "", context_turns: [] };

  const customerTurns = newestFirstMessages
    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()))
    .map((row) => cleanContinuityText(row.content))
    .filter(Boolean);
  if (customerTurns.length === 0) {
    return { query: latest, mode: "standalone", latest, context_turns: [] };
  }

  const contextTurns = customerTurns
    .filter((text) => !isRetrievalNoise(text))
    .slice(0, 6);
  if (contextTurns.length === 0) {
    return { query: latest, mode: "standalone", latest, context_turns: [] };
  }

  const chronological = [...contextTurns].reverse();
  const query = [
    "Assistance input: " + latest,
    "Relevant customer conversation: " + chronological.join(" / "),
  ].join("\n").slice(0, 1200);

  return { query, mode: "contextual", latest, context_turns: contextTurns };
}

export interface CustomerAdvisorySignals {
  tier?: string | null;
  anger_flag?: boolean;
  sentiment_score?: number;
  churn_risk?: number;
  escalation_score?: number;
}

/** Advisory only: changes response strategy/tone, never creates a required handoff. */
export function buildCustomerAdvisoryContext(signals: CustomerAdvisorySignals): string {
  const lines: string[] = [];
  const tier = typeof signals.tier === "string" ? signals.tier.trim().slice(0, 80) : "";
  const angry = signals.anger_flag === true ||
    (typeof signals.sentiment_score === "number" && Number.isFinite(signals.sentiment_score) && signals.sentiment_score <= -0.5);
  const risk = typeof signals.churn_risk === "number" && Number.isFinite(signals.churn_risk)
    ? Math.max(0, Math.min(1, signals.churn_risk)) : null;
  const escalation = typeof signals.escalation_score === "number" && Number.isFinite(signals.escalation_score)
    ? Math.max(0, Math.min(1, signals.escalation_score)) : null;

  if (!tier && !angry && risk === null && escalation === null) return "";
  lines.push("Customer advisory context (internal, advisory only; never reveal scores or labels):");
  if (tier) lines.push(`- Customer tier is available (${tier}). Be attentive and efficient, but tier/VIP status alone must never trigger human handoff or unsupported promises.`);
  if (angry) lines.push("- Current/fresh signals indicate frustration or anger. Acknowledge the concern briefly, avoid repetitive apologies, answer the core issue first, and do not force a human handoff solely because of emotion.");
  if (risk !== null || escalation !== null) lines.push("- Predictive customer-risk signals are available. Use them only to improve clarity, urgency and helpfulness; they are not authorization for a required handoff or customer action.");
  return lines.join("\n");
}
