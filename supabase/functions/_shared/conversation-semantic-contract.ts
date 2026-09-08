export type SemanticLanguage = "zh-TW" | "zh-CN" | "en";

export type ConversationOperation =
  | "NEW_FACTUAL_QUERY"
  | "FOLLOW_UP_FACTUAL"
  | "PRONOUN_OR_ELLIPSIS"
  | "SIMPLIFY"
  | "REPHRASE"
  | "TRANSLATE"
  | "SUMMARIZE"
  | "CORRECTION"
  | "TOPIC_SWITCH"
  | "RETURN_TO_PRIOR_TOPIC"
  | "CONVERSATION_MEMORY"
  | "CUSTOMER_CONTEXT_UPDATE"
  | "UNDERSPECIFIED"
  | "TRIVIAL"
  | "EXPLICIT_HANDOFF";

export type EvidenceAuthority =
  | "CURRENT_KB_REQUIRED"
  | "PRIOR_GROUNDED_ANSWER"
  | "CONVERSATION_MEMORY"
  | "NONE";

export type TopicAction = "KEEP" | "SWITCH" | "RETURN" | "CORRECT" | "NONE";

export type SemanticHistoryRow = {
  role?: string;
  content?: string | null;
  metadata?: unknown;
};

export interface GroundedAnswerAnchor {
  content: string;
  document_id: string;
  chunk_ids: string[];
  source_message_id: string | null;
}

export interface CanonicalConversationTurn {
  operation: ConversationOperation;
  language: SemanticLanguage;
  latest: string;
  needs_history: boolean;
  requires_new_kb_retrieval: boolean;
  may_reuse_prior_grounded_answer: boolean;
  evidence_authority: EvidenceAuthority;
  topic_action: TopicAction;
  explicit_handoff: boolean;
  prior_grounded_answer: GroundedAnswerAnchor | null;
  reason: string;
}

const CUSTOMER = new Set(["visitor", "customer", "user"]);
const ASSISTANT = new Set(["assistant", "ai"]);
const TRIVIAL = /^(hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|ok|okay|好的|好|嗯|謝謝|谢谢|thanks|thank you)[!！。.？?，,\s]*$/i;
const CORRECTION = /(我講錯|我说错|我說錯|我要更正|我想更正|更正一下|其實係|其实是|改返|改成|actually[,\s]+i meant|\bi meant\b|correction\s*[:：]|不是.+(?:而)?是|唔係.+係|(?:唔係|不是).{0,60}(?:我要問|我想問|想問|想问)|not .+ but .+)/i;
const SIMPLIFY = /(?:簡單|简单)(?:一點|一点|啲|些|點|点)?(?:[。.!！?？\s]*$|.*(?:解釋|解释|講|讲|說|说|介紹|介绍))|(?:講|讲|說|说)(?:得|得再)?(?:簡單|简单)(?:一點|一点|啲|些|點|点)?|(?:用|講|讲|說|说)(?:香港客戶|香港客户|一般客戶|一般客户|客戶|客户)?(?:聽得懂|听得懂|明白|易明)?(?:的|嘅)?(?:人話|人话|白話|白话|口語|口语|貼地|贴地)(?:回答|講|讲|說|说)?|(?:講|讲|說|说|回答)(?:得)?(?:自然|口語|口语|貼地|贴地)(?:一點|一点|啲)?|explain(?: it| that)? (?:more )?simply|make it simpler|\bsimpler\b|\bshorter\b|(?:say|explain|answer).*(?:plain|natural|everyday|customer-friendly) (?:language|words|terms)/i;
const REPHRASE = /(換句話|换句话|另一種講法|另一种说法|改寫|改写|重新講|重新说|rephrase|rewrite|say that another way|word it differently)/i;
const TRANSLATE = /(?:用|改用)(?:廣東話|广东话|繁體中文|繁体中文|簡體中文|简体中文|英文).*(?:講|讲|回答|答|解釋|解释|說|说|一次)?|\b(?:in|into)\s+(?:english|chinese|cantonese|traditional chinese|simplified chinese)\b|translate(?: that| it)?/i;
const SUMMARY = /(?:總結|总结|概括|歸納|归纳).*(?:剛才|刚才|以上|之前|我們|我们|內容|内容|三點|三点)?|(?:根據|根据)?(?:已確認|已确认)(?:資料|资料).*(?:列|分成|整理成)?\s*(?:[一二兩两三四五六七八九十]|\d{1,2})\s*(?:點|点|項|项|條|条)|summari[sz]e(?: that| it| this| the above| what we discussed| our conversation)?/i;
const MEMORY = /(一開始|一开始|第一個問題|第一个问题|最初).*(?:問|問題|问题)|(?:剛才|刚才).*(?:主要)?(?:問|问).*(?:什麼|什么|咩)|(?:主要)(?:問|问).*(?:什麼|什么|咩)|剛才.*(?:建議|建议|叫我|要我)|刚才.*(?:建议|叫我|要我)|之前.*(?:建議|建议|提供)|what\s+(?:did\s+i\s+ask|was\s+(?:my\s+)?first)|what\s+(?:was|is)\s+(?:my\s+)?(?:main|mainly|primary).*(?:question|asking|ask)|what\s+did\s+you\s+(?:recommend|suggest)|what\s+information\s+have\s+i\s+already\s+given|what\s+have\s+i\s+already\s+given|我(?:現在|现在|目前).*(?:哪個|哪个|什麼|什么).*(?:地區|地区).*(?:哪個|哪个|什麼|什么).*(?:項目|项目)|what(?:\x27s| is)?\s+(?:the\s+)?(?:current\s+)?(?:region|jurisdiction).*(?:item|product)|what.*still\s+missing/i;
const RETURN_PRIOR = /(回到|返回|返去|回返|講返|讲回|回香港|回到香港|back to|return to|go back to|back on).{0,50}/i;
const TOPIC_SWITCH = /^(?:算了|算啦|另外|轉個話題|转个话题|換個話題|换个话题|不談|不谈|forget that|never mind|different topic|another question)/i;
const FOLLOW = /^(?:咁|那|那麼|那么|所以|另外|仲有|还有|如果|再|又|而|同埋|what about|and what about|then|so|also|in that case|how about)/i;
const PRONOUN = /^(?:那個|那个|這個|这个|它|佢|他|她|嗰個|呢個|上述|剛才|刚才|之前|same|that|this|it|its|earlier|previous)|(?:呢|嗎|吗|about that|and that|same one|same thing)[。.!！?？\s]*$/i;
const DOMAIN_ONLY = /^(?:我有|我想問|我想问|想問|想问|請問|请问)?\s*(?:一個|一个|個|个)?\s*(?:訂單|订单|退款|退貨|退货|換貨|换货|送貨|送货|物流|付款|產品|产品|保養|保修|維修|维修|問題|问题)\s*(?:問題|问题|嘅問題|的問題)?[。.!！?？\s]*$/;
const QUESTIONISH = /[?？]|^(?:什麼|什么|如何|怎樣|怎样|哪|哪些|多久|幾耐|几耐|why|what|which|how|when|where)/i;
const CUSTOMER_CONTEXT_REQUIREMENTS = /(?:你|妳|您).{0,12}(?:還|还)?需要(?:我)?(?:再)?提供(?:什麼|什么|哪些|咩)(?:資料|资料|資訊|信息|details|information)|(?:還|还)需要(?:我)?提供(?:什麼|什么|哪些|咩)(?:資料|资料|資訊|信息)|what (?:information|details) do you (?:still )?need from me|what else do you need from me/i;
const CUSTOMER_CONTEXT_UPDATE = /(?:^|[，,。.!！\s])(?:我只知道|我只知|我目前只知道|我現在只知道|我现在只知道|我沒有|我没有|我冇|不知道型號|不知道型号|唔知型號|型號(?:是|係)?未知|型号(?:是)?未知|品牌(?:是|係)|大約.{0,24}(?:買|购买|購買)|大概.{0,24}(?:買|购买|購買)|現在.{0,32}(?:不冷|唔凍|不能|無法|无法)|现在.{0,32}(?:不冷|不能|无法)|i only know|i (?:do not|don't) have (?:the )?(?:model|model number|order number)|the brand is|brand is|i bought (?:it )?.{0,40}ago|it (?:powers|turns) on but)/i;
const CUSTOMER_OWNED_STATE_FIELD = /(?:sku|商品(?:數量|数量)?|產品(?:數量|数量)?|产品(?:数量)?|貨品(?:數量|数量)?|件(?:商品|產品|产品)?|staff|員工|员工|人手|同事|市場|市场|主要市場|主要市场|地區|地区|region|market|app(?:需求|需要|要求)?|push(?:需求|需要|要求)?|crm(?:需求|需要|要求)?|會員等級|会员等级)/i;
const CUSTOMER_OWNED_STATE_CORRECTION = /(?:記住|记住|最新|目前|現在|现在|其實|其实|更正|改返|改成|更新(?:一下)?|actually|correction).{0,45}(?:唔係|不是|并非|並非|而家係|現在係|现在是|改為|改为|最新係|最新是|而係|而是|not .+ but|instead)/i;
const BARE_LATEST_NUMERIC_CORRECTION = /(?:記住|记住).{0,20}(?:最新)?(?:係|是)?\s*\d+(?:\.\d+)?\s*[，,。.!！\s]*(?:唔係|不是|而唔係|而不是)\s*\d+(?:\.\d+)?/i;
const FACTUAL_TOPIC_OR_KB_SWITCH = /(?:Growth|Basic|Pro|plan|方案|型號|型号|model|價錢|价钱|價格|价格|price|費用|费用|收費|收费|limit|上限|支援|支持|包括|包含|功能|feature|保養|保修|送貨|送货|退款|退貨|退货|付款|政策|policy|terms?\b|T&C|我要問|我想問|想問|想问|ask about)/i;
const CUSTOMER_OWNED_STATE_DECLARATION_CUE = /(?:^|[，,。.!！\s])(?:我|目前|現在|现在|而家|暫時|暂时|之後|之后|未來|未来|年尾|只做|主要做|再諗|再想|再加|得我|亦|都會|都会|可能|大約|大概|only|currently|right now|for now|later|future|i (?:have|need|want|use|am|currently))/i;
const CUSTOMER_OWNED_STATE_PREFERENCE_CUE = /(?:有興趣|有兴趣|想要|想用|要用|會用|会用|需要|唔需要|不需要|不用|過時|过时|管理|一齊|一起|加\s*[一二兩两三四五六七八九十\d]+|only|interested|need|want|use|have)/i;
const CUSTOMER_OWNED_LOCATION_DECLARATION = /(?:只做|主要做|目前(?:主要市場|主要市场)?(?:仍然|還是|还是)?|現在(?:主要市場|主要市场)?|现在(?:主要市场)?|之後可能做|之后可能做|未來可能做|未来可能做).{0,24}(?:香港|台灣|台湾|澳門|澳门|Hong Kong|Taiwan|Macau)/i;

function recentCustomerStateField(newestFirst: SemanticHistoryRow[], currentLatest: string): boolean {
  let skippedCurrent = false;
  let customerTurns = 0;
  for (const row of newestFirst) {
    const role = String(row.role ?? "").toLowerCase();
    if (!CUSTOMER.has(role)) continue;
    const content = clean(row.content);
    if (!content) continue;
    if (!skippedCurrent && content === currentLatest) {
      skippedCurrent = true;
      continue;
    }
    customerTurns += 1;
    if (CUSTOMER_OWNED_STATE_FIELD.test(content)) return true;
    if (customerTurns >= 4) break;
  }
  return false;
}

export function isCustomerOwnedStateCorrection(text: string, newestFirst: SemanticHistoryRow[] = []): boolean {
  const latest = clean(text);
  if (!latest || QUESTIONISH.test(latest) || /[?？]/.test(latest)) return false;
  if (FACTUAL_TOPIC_OR_KB_SWITCH.test(latest)) return false;
  if (CUSTOMER_OWNED_STATE_FIELD.test(latest) && (CORRECTION.test(latest) || CUSTOMER_OWNED_STATE_CORRECTION.test(latest))) return true;
  return BARE_LATEST_NUMERIC_CORRECTION.test(latest) && recentCustomerStateField(newestFirst, latest);
}

export function isCustomerOwnedStateUpdate(text: string): boolean {
  const latest = clean(text);
  if (!latest || QUESTIONISH.test(latest) || /[?？]/.test(latest)) return false;
  if (FACTUAL_TOPIC_OR_KB_SWITCH.test(latest)) return false;

  if (CUSTOMER_OWNED_LOCATION_DECLARATION.test(latest)) return true;
  if (!CUSTOMER_OWNED_STATE_FIELD.test(latest)) return false;

  if (/\d+(?:\.\d+)?\s*(?:件|sku|staff|員工|员工)/i.test(latest)) return true;
  return CUSTOMER_OWNED_STATE_DECLARATION_CUE.test(latest) || CUSTOMER_OWNED_STATE_PREFERENCE_CUE.test(latest);
}

export function isCustomerContextUpdate(text: string): boolean {
  const latest = clean(text);
  if (!latest || QUESTIONISH.test(latest) || /[?？]/.test(latest)) return false;
  return CUSTOMER_CONTEXT_UPDATE.test(latest);
}

function clean(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 1200) : "";
}

export function detectSemanticLanguage(text: string): SemanticLanguage {
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  return /[转们为这没请台]/.test(text) ? "zh-CN" : "zh-TW";
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function findPriorGroundedAnswer(newestFirst: SemanticHistoryRow[], currentLatest?: string): GroundedAnswerAnchor | null {
  const latest = clean(currentLatest);
  let skippedCurrent = false;
  for (const row of newestFirst) {
    const role = String(row.role ?? "").toLowerCase();
    const content = clean(row.content);
    if (!content || content === "__THINKING__") continue;
    if (!skippedCurrent && latest && CUSTOMER.has(role) && content === latest) {
      skippedCurrent = true;
      continue;
    }
    if (!ASSISTANT.has(role)) continue;
    const meta = metadataRecord(row.metadata);
    const lineage = metadataRecord(meta?.citation_lineage);
    const selected = typeof lineage?.selected_document_id === "string" ? lineage.selected_document_id : "";
    const ids = Array.isArray(lineage?.evidence_chunk_ids)
      ? lineage.evidence_chunk_ids.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    if (!selected || ids.length === 0) continue;
    const source = typeof meta?.source_message_id === "string" ? meta.source_message_id : null;
    return { content, document_id: selected, chunk_ids: ids, source_message_id: source };
  }
  return null;
}

export function classifyCanonicalConversationTurn(
  latestInput: string,
  newestFirst: SemanticHistoryRow[],
  options: { explicit_handoff?: boolean } = {},
): CanonicalConversationTurn {
  const latest = clean(latestInput);
  const language = detectSemanticLanguage(latest);
  const priorGrounded = findPriorGroundedAnswer(newestFirst, latest);
  const base = (operation: ConversationOperation, reason: string, overrides: Partial<CanonicalConversationTurn> = {}): CanonicalConversationTurn => ({
    operation,
    language,
    latest,
    needs_history: false,
    requires_new_kb_retrieval: true,
    may_reuse_prior_grounded_answer: false,
    evidence_authority: "CURRENT_KB_REQUIRED",
    topic_action: "NONE",
    explicit_handoff: false,
    prior_grounded_answer: priorGrounded,
    reason,
    ...overrides,
  });

  if (options.explicit_handoff === true) {
    return base("EXPLICIT_HANDOFF", "governed_explicit_handoff", {
      explicit_handoff: true,
      requires_new_kb_retrieval: false,
      evidence_authority: "NONE",
    });
  }
  if (!latest || TRIVIAL.test(latest)) {
    return base("TRIVIAL", "trivial_or_greeting", { requires_new_kb_retrieval: false, evidence_authority: "NONE" });
  }
  if (MEMORY.test(latest)) {
    return base("CONVERSATION_MEMORY", "conversation_memory_request", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "KEEP",
    });
  }
  const transform = SIMPLIFY.test(latest) ? "SIMPLIFY" : TRANSLATE.test(latest) ? "TRANSLATE" : REPHRASE.test(latest) ? "REPHRASE" : SUMMARY.test(latest) ? "SUMMARIZE" : null;
  if (transform) {
    return base(transform, priorGrounded ? "transform_of_prior_grounded_answer" : "transform_requires_history_without_grounded_anchor", {
      needs_history: true,
      requires_new_kb_retrieval: !priorGrounded,
      may_reuse_prior_grounded_answer: Boolean(priorGrounded),
      evidence_authority: priorGrounded ? "PRIOR_GROUNDED_ANSWER" : "CURRENT_KB_REQUIRED",
      topic_action: "KEEP",
    });
  }
  if (isCustomerOwnedStateCorrection(latest, newestFirst)) {
    return base("CUSTOMER_CONTEXT_UPDATE", "customer_owned_state_correction", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      may_reuse_prior_grounded_answer: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "CORRECT",
    });
  }
  if (isCustomerOwnedStateUpdate(latest)) {
    return base("CUSTOMER_CONTEXT_UPDATE", "customer_owned_state_update", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      may_reuse_prior_grounded_answer: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "KEEP",
    });
  }
  if (CORRECTION.test(latest)) {
    return base("CORRECTION", "latest_turn_supersedes_prior_context", { needs_history: true, topic_action: "CORRECT" });
  }
  if (CUSTOMER_CONTEXT_REQUIREMENTS.test(latest)) {
    return base("CUSTOMER_CONTEXT_UPDATE", "customer_context_requirements_request", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      evidence_authority: "CONVERSATION_MEMORY",
      topic_action: "KEEP",
    });
  }
  if (isCustomerContextUpdate(latest)) {
    return base("CUSTOMER_CONTEXT_UPDATE", "customer_supplied_context_without_factual_request", {
      needs_history: true,
      requires_new_kb_retrieval: false,
      evidence_authority: "NONE",
      topic_action: "KEEP",
    });
  }
  if (RETURN_PRIOR.test(latest)) {
    return base("RETURN_TO_PRIOR_TOPIC", "explicit_return_to_prior_topic", { needs_history: true, topic_action: "RETURN" });
  }
  if (TOPIC_SWITCH.test(latest)) {
    return base("TOPIC_SWITCH", "explicit_topic_switch", { needs_history: true, topic_action: "SWITCH" });
  }
  if (PRONOUN.test(latest)) {
    return base("PRONOUN_OR_ELLIPSIS", "referential_follow_up_requires_history", { needs_history: true, topic_action: "KEEP" });
  }
  if (FOLLOW.test(latest)) {
    return base("FOLLOW_UP_FACTUAL", "follow_up_requires_history", { needs_history: true, topic_action: "KEEP" });
  }
  if (DOMAIN_ONLY.test(latest)) {
    return base("UNDERSPECIFIED", "semantic_intent_present_but_required_detail_missing", { requires_new_kb_retrieval: false, evidence_authority: "NONE" });
  }
  if (QUESTIONISH.test(latest)) {
    return base("NEW_FACTUAL_QUERY", "standalone_factual_request");
  }
  return base("NEW_FACTUAL_QUERY", "specific_standalone_request");
}
