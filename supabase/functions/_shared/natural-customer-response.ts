import { classifyConversationalRoute } from "./conversational-routing.ts";

export type NaturalResponseLanguage = "zh-TW" | "zh-CN" | "en";

export type ProductFactualFacet =
  | "features"
  | "horsepower"
  | "suitability"
  | "price"
  | "specification"
  | "model_info";

export type NaturalCustomerIntent =
  | { kind: "greeting"; product: null }
  | { kind: "product_shopping"; product: string | null }
  | {
    kind: "product_guidance";
    product: string | null;
    two_bedrooms_and_living_room?: boolean;
  }
  | { kind: "product_availability"; product: string | null }
  | {
    kind: "product_factual_query";
    product: string;
    fact: ProductFactualFacet;
    facts: ProductFactualFacet[];
  }
  | {
    kind: "product_factual_clarification";
    product: null;
    candidates: string[];
    reason: string;
  }
  | { kind: "none"; product: null };

const MAX_PRODUCT_LABEL_LENGTH = 80;

/** Product-like codes must contain letters and a meaningful numeric part. */
export function exactProductIdentifiers(product: string | null): string[] {
  if (!product) return [];
  const tokens = product.normalize("NFKC").match(
    /(?<![A-Z0-9])(?:[A-Z][A-Z0-9]*-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{2,}[A-Z0-9]*\d{2,}[A-Z0-9]*|[A-Z]\d{3,}[A-Z0-9]*)(?![A-Z0-9])/giu,
  ) ?? [];
  return [
    ...new Set(
      tokens.filter((token) =>
        token.length >= 5 && /\d/u.test(token) && /[A-Z]/iu.test(token)
      ),
    ),
  ];
}

/** A specific model and an actual merchant fact request are both required. */
export function classifyProductFactualQuery(
  text: string,
): Extract<NaturalCustomerIntent, { kind: "product_factual_query" }> | null {
  const normalized = text.normalize("NFKC").trim();
  const models = exactProductIdentifiers(normalized);
  if (models.length !== 1 || isProductSupportProblem(normalized)) return null;
  const facts = productFactualFacets(normalized);
  if (!facts.length) return null;
  return productFactualIntent(models[0], facts);
}

function productFactualFacets(text: string): ProductFactualFacet[] {
  const matchers: Array<[ProductFactualFacet, RegExp]> = [
    ["features", /(?:功能|feature|特點|特点|特色)/i],
    [
      "horsepower",
      /(?:幾多匹|几多匹|多少匹|幾匹|几匹|匹數|匹数|horsepower|\bHP\b)/i,
    ],
    ["price", /(?:售價|售价|幾錢|几钱|價錢|价钱|price|how\s+much)/i],
    [
      "specification",
      /(?:規格|规格|specs?|尺寸|dimension|capacity|容量|重量|weight|功率|power|電壓|电压|voltage|噪音)/i,
    ],
    [
      "model_info",
      /(?:型號|型号|model|產品資料|产品资料|product\s+(?:information|details))/i,
    ],
    [
      "suitability",
      /(?:適合|适合|適唔適合|适不适合|夠用|够用|夠唔夠|够不够|啱用|合用|合唔合適|合不合适|suitab|enough|work\s+for|fit\s+(?:in|for)|appropriate\s+for)/i,
    ],
  ];
  return matchers.filter(([, pattern]) => pattern.test(text)).map(([fact]) =>
    fact
  );
}

function productFactualIntent(
  product: string,
  facts: ProductFactualFacet[],
): Extract<NaturalCustomerIntent, { kind: "product_factual_query" }> {
  // Keep the legacy single-fact precedence for existing consumers while also
  // exposing every compatible facet so renderers cannot silently drop one.
  const fact = facts.includes("suitability")
    ? "suitability"
    : facts.includes("price")
    ? "price"
    : facts.includes("horsepower")
    ? "horsepower"
    : facts[0];
  return { kind: "product_factual_query", product, fact, facts };
}

export interface ProductFollowUpHistoryMessage {
  role: string;
  content: string;
  conversation_id?: string;
  company_id?: string;
}

export interface ProductFollowUpScope {
  conversation_id: string;
  company_id: string;
}

export type ProductFollowUpArbitration =
  | { kind: "not_applicable" }
  | {
    kind: "resolved";
    intent: Extract<NaturalCustomerIntent, { kind: "product_factual_query" }>;
    grounded_question: string;
    source_turn_offset: number;
    resolved_topic: string | null;
    resolution_strategy:
      | "RECENT_GLOBAL_REFERENT"
      | "PER_TOPIC_REFERENT_HISTORY";
  }
  | {
    kind: "clarification";
    intent: Extract<
      NaturalCustomerIntent,
      { kind: "product_factual_clarification" }
    >;
  };

const PRODUCT_ANAPHOR =
  /(?:呢|這|这|嗰|那)(?:一)?(?:部|款|個|个)|(?:佢|它)(?!們|们)|\b(?:this\s+one|that\s+(?:one|model)|it)\b/iu;
const PRODUCT_CONTEXT_SWITCH =
  /(?:轉(?:去|睇|問)|转(?:去|看|问)|講返|讲回|switch(?:ing)?\s+to|move(?:ing)?\s+to|back\s+to)\s*(?:另一|另一个|another|the)?\s*(?:產品|产品|product|category)?|(?:雪櫃|冰箱|refrigerator|fridge|洗衣機|洗衣机|washer|washing\s+machine|電視|电视|television|\bTV\b|焗爐|烤箱|oven)/iu;
const INACTIVE_REFERENT =
  /(?:取消|唔要|不要|刪除|删除|暫緩|暂缓|遲啲先|迟点再|cancel(?:led)?|defer(?:red)?|no\s+longer|not\s+that)/iu;

const PRODUCT_TOPIC_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["air_conditioner", /(?:冷氣(?:機)?|冷气(?:机)?|空調|空调|air\s*conditioner|\bAC\b)/iu],
  ["refrigerator", /(?:雪櫃|雪柜|冰箱|refrigerator|fridge)/iu],
  ["washing_machine", /(?:洗衣機|洗衣机|washing\s*machine|washer)/iu],
  ["television", /(?:電視|电视|television|\bTV\b)/iu],
  ["oven", /(?:焗爐|焗炉|烤箱|oven)/iu],
];

function explicitProductTopics(text: string): string[] {
  return PRODUCT_TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(text))
    .map(([topic]) => topic);
}

function inferredProductTopic(text: string): string | null {
  const explicit = explicitProductTopics(text);
  if (explicit.length === 1) return explicit[0];
  if (/(?:幾多匹|几多匹|多少匹|幾匹|几匹|匹數|匹数|horsepower|\bHP\b|冷房|製冷|制冷)/iu.test(text)) {
    return "air_conditioner";
  }
  return null;
}

function scopedProductHistory(
  history: ProductFollowUpHistoryMessage[],
  scope?: ProductFollowUpScope,
): ProductFollowUpHistoryMessage[] {
  if (!scope) return history;
  return history.filter((row) =>
    (row.conversation_id === undefined || row.conversation_id === scope.conversation_id) &&
    (row.company_id === undefined || row.company_id === scope.company_id)
  );
}

function arbitratePerTopicProductReferent(
  normalized: string,
  facts: ProductFactualFacet[],
  visitors: ProductFollowUpHistoryMessage[],
): ProductFollowUpArbitration | null {
  const requestedTopics = explicitProductTopics(normalized);
  if (!requestedTopics.length) return null;
  if (requestedTopics.length !== 1) {
    return { kind: "clarification", intent: { kind: "product_factual_clarification", product: null, candidates: [], reason: "MULTIPLE_REQUESTED_PRODUCT_TOPICS" } };
  }
  const requestedTopic = requestedTopics[0];
  const activeByTopic = new Map<string, Map<string, number>>();
  let focusTopic: string | null = null;
  for (let offset = visitors.length - 1; offset >= 0; offset -= 1) {
    const prior = visitors[offset].content.normalize("NFKC");
    const explicitTopics = explicitProductTopics(prior);
    if (explicitTopics.length === 1) focusTopic = explicitTopics[0];
    else if (explicitTopics.length > 1) focusTopic = null;
    const topic = explicitTopics.length === 1 ? explicitTopics[0] : inferredProductTopic(prior) ?? focusTopic;
    if (!topic) continue;
    const models = exactProductIdentifiers(prior);
    const bucket = activeByTopic.get(topic) ?? new Map<string, number>();
    activeByTopic.set(topic, bucket);
    if (INACTIVE_REFERENT.test(prior)) {
      if (models.length) for (const model of models) bucket.delete(model);
      else if (explicitTopics.length === 1 && (PRODUCT_ANAPHOR.test(prior) || /(?:產品|产品|product|item)/iu.test(prior))) bucket.clear();
      continue;
    }
    for (const model of models) bucket.set(model, offset);
  }
  const candidates = [...(activeByTopic.get(requestedTopic)?.keys() ?? [])];
  if (candidates.length !== 1) {
    return { kind: "clarification", intent: { kind: "product_factual_clarification", product: null, candidates, reason: candidates.length > 1 ? "MULTIPLE_COMPATIBLE_PRODUCT_REFERENTS_FOR_TOPIC" : "NO_ACTIVE_PRODUCT_REFERENT_FOR_REQUESTED_TOPIC" } };
  }
  const product = candidates[0];
  return {
    kind: "resolved",
    intent: productFactualIntent(product, facts),
    grounded_question: `${product} ${normalized}`,
    source_turn_offset: activeByTopic.get(requestedTopic)?.get(product) ?? visitors.length,
    resolved_topic: requestedTopic,
    resolution_strategy: "PER_TOPIC_REFERENT_HISTORY",
  };
}

/**
 * Resolve product identity and requested factual attribute independently.
 * This is deliberately read-only: it may bind a recent explicit model to a
 * factual KB query, but it cannot create a product, revive an inactive item,
 * or choose between competing models.
 */
export function arbitrateAnaphoricProductFollowUp(
  text: string,
  newestFirstHistory: ProductFollowUpHistoryMessage[],
  scope?: ProductFollowUpScope,
): ProductFollowUpArbitration {
  const normalized = text.normalize("NFKC").trim();
  if (
    !PRODUCT_ANAPHOR.test(normalized) || isProductSupportProblem(normalized)
  ) {
    return { kind: "not_applicable" };
  }
  const facts = productFactualFacets(normalized);
  if (!facts.length || exactProductIdentifiers(normalized).length > 0) {
    return { kind: "not_applicable" };
  }

  const visitors = scopedProductHistory(newestFirstHistory, scope).filter((row) =>
    row.role === "visitor" && row.content.trim().length > 0
  ).slice(0, 8);
  const perTopic = arbitratePerTopicProductReferent(normalized, facts, visitors);
  if (perTopic) return perTopic;
  let focusBarrier = false;
  for (let offset = 0; offset < visitors.length; offset += 1) {
    const prior = visitors[offset].content.normalize("NFKC");
    const models = exactProductIdentifiers(prior);
    if (!models.length) {
      // A later category switch without an explicit model invalidates an older
      // model focus. It must not inherit the previous category's product.
      if (PRODUCT_CONTEXT_SWITCH.test(prior)) focusBarrier = true;
      continue;
    }
    if (focusBarrier) {
      return {
        kind: "clarification",
        intent: {
          kind: "product_factual_clarification",
          product: null,
          candidates: [],
          reason: "INCOMPATIBLE_RECENT_PRODUCT_CONTEXT",
        },
      };
    }
    if (models.length !== 1) {
      return {
        kind: "clarification",
        intent: {
          kind: "product_factual_clarification",
          product: null,
          candidates: models,
          reason: "MULTIPLE_COMPATIBLE_PRODUCT_REFERENTS",
        },
      };
    }
    const product = models[0];
    if (INACTIVE_REFERENT.test(prior)) {
      return {
        kind: "clarification",
        intent: {
          kind: "product_factual_clarification",
          product: null,
          candidates: [],
          reason: "INACTIVE_OR_SUPERSEDED_PRODUCT_REFERENT",
        },
      };
    }
    const newerTurns = visitors.slice(0, offset).map((row) => row.content).join(
      "\n",
    );
    if (
      INACTIVE_REFERENT.test(newerTurns) &&
      (newerTurns.includes(product) || PRODUCT_ANAPHOR.test(newerTurns))
    ) {
      return {
        kind: "clarification",
        intent: {
          kind: "product_factual_clarification",
          product: null,
          candidates: [],
          reason: "INACTIVE_OR_SUPERSEDED_PRODUCT_REFERENT",
        },
      };
    }
    return {
      kind: "resolved",
      intent: productFactualIntent(product, facts),
      grounded_question: `${product} ${normalized}`,
      source_turn_offset: offset,
      resolved_topic: inferredProductTopic(prior),
      resolution_strategy: "RECENT_GLOBAL_REFERENT",
    };
  }
  return {
    kind: "clarification",
    intent: {
      kind: "product_factual_clarification",
      product: null,
      candidates: [],
      reason: "NO_RECENT_EXPLICIT_PRODUCT_REFERENT",
    },
  };
}

export function isProductSupportProblem(text: string): boolean {
  return isProductOperationFailure(text) ||
    /(?:故障|維修|维修|壞咗|坏了|損壞|损坏|缺少功能|缺失功能|功能失效|兼容問題|兼容问题|相容問題|賣家投訴|卖家投诉|malfunction|broken|damaged|missing\s+(?:advertised\s+)?(?:features?|parts?)|compatibility\s+issue|seller\s+(?:problem|complaint)|product\s+support)/i
      .test(text);
}

/** A reported operating failure, distinct from a question about product features. */
export function isProductOperationFailure(text: string): boolean {
  return /(?:開唔到機|开不了机|開不了機|不能開機|无法开机|唔著|(?:機|机|產品|产品).{0,8}(?:開唔到|开不了|唔著)|not\s+working|won['’]?t\s+(?:start|turn\s+on)|(?:does\s+not|doesn['’]?t)\s+turn\s+on)/i
    .test(text);
}

function chineseProductPrefix(product: string): string {
  return /^[\p{Script=Latin}\d]/u.test(product) ? ` ${product}` : product;
}

function chinesePossessiveParticle(
  product: string,
  particle: "嘅" | "的",
): string {
  return /^[\p{Script=Latin}\d]/u.test(product) ? ` ${particle}` : particle;
}

function cleanProductLabel(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .normalize("NFKC")
    .replace(/^[\s,，:：;；一個一部一件一款]+/u, "")
    .replace(
      /(?:嘅)?(?:產品|商品)?(?:資料)?(?:嗎|呢|呀|啊)?[?？!！.。\s]*$/u,
      "",
    )
    .replace(/^(?:an?|any|some|the)\s+/i, "")
    .replace(/\s+(?:available|in stock|for sale)$/i, "")
    .replace(/[?？!！.。]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length > MAX_PRODUCT_LABEL_LENGTH) return null;
  if (
    /^(?:產品|商品|貨|嘢|東西|东西|product|item|something|anything)$/i.test(
      cleaned,
    )
  ) return null;
  return cleaned;
}

function extractShoppingProduct(text: string): string | null {
  const chinese = text.match(
    /(?:我|本人)?(?:想|要|打算|準備|准备|考慮|考虑|希望)(?:買|买|購買|购买|訂購|订购|訂|订|入手)\s*(.+?)[?？!！.。]*$/iu,
  );
  if (chinese) return cleanProductLabel(chinese[1]);

  const english = text.match(
    /(?:i\s+)?(?:want|would like|need|plan|hope|am looking)(?:\s+to)?\s+(?:buy|purchase|order|get)\s+(.+?)[?!.]*$/i,
  );
  return cleanProductLabel(english?.[1]);
}

function stripLeadingGreeting(text: string): string {
  return text.replace(
    /^(?:(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))|(?:你好|您好|嗨|哈囉|哈啰|早晨|早安|午安|晚安))[\s,，:：!！。.]*/iu,
    "",
  ).trim();
}

function extractGuidanceProduct(text: string): string | null {
  const chinese = text.match(
    /(?:想問|想问|想了解|想睇|想看|請教|请教)\s*([^，,。.!！?？]{1,48}?)(?=\s*(?:，|,|。|\?|？|點揀|点选|點選|揀邊|选哪|買咩|买什么|邊款|哪款|邊種|哪种|要幾|要几))/iu,
  );
  if (chinese) return cleanProductLabel(chinese[1]);
  const chineseSelection = text.match(
    /(?:想|要|打算|準備|准备|考慮|考虑|希望)?(?:幫|帮)?(?:屋企|家裡|家里|公司|辦公室|办公室)?\s*(?:換|换|買|买|選購|选购|揀|選|选|搵|找)\s*(?:一部|一台|個|个)?\s*([^，,。.!！?？]{1,32}?)(?=\s*(?:，|,|。|\?|？|俾|給|给|for|兩|两|2|三|3|點樣|怎样|怎樣|如何|邊款|哪款|$))/iu,
  );
  if (chineseSelection) return cleanProductLabel(chineseSelection[1]);
  const chineseHow = text.match(
    /(?:點樣|怎样|怎樣|如何|怎么)\s*(?:揀|選|选|選擇|选择|挑選|挑选)\s*(?:一部|一台|個|个)?\s*([^，,。.!！?？]{1,32})/iu,
  );
  if (chineseHow) return cleanProductLabel(chineseHow[1]);
  const english = text.match(
    /(?:help|advice|guidance|recommendation)s?\s+(?:with|on|for)\s+([^,.!?]{1,48})/i,
  );
  if (english) return cleanProductLabel(english[1]);
  const englishSelection = text.match(
    /(?:how\s+(?:should|can|do)\s+i\s+)?(?:choose|select|pick|shop\s+for)\s+(?:an?|the|some)?\s*([^,.!?]{1,48}?)(?=\s+for\s+(?:two|three|the|my|our|a|an|\d)|[,.!?]|$)/i,
  );
  return cleanProductLabel(englishSelection?.[1]);
}

function looksLikeProductGuidance(text: string): boolean {
  return /(?:買咩|买什么|揀邊|选哪|點(?:樣)?揀|怎樣選|怎样选|如何選|如何选|怎么选|點選|邊款|哪款|邊種|哪种|幾大|几大|幾多匹|几匹|合適|合适|推薦|推荐|建議|建议|what\s+should\s+i\s+(?:buy|choose|get)|how\s+(?:should|can|do)\s+i\s+(?:choose|select|pick)|which\s+(?:model|size|option)|recommend|advi[cs]e)/iu
    .test(
      text,
    );
}

function extractAvailabilityProduct(text: string): string | null {
  const chinesePatterns = [
    /(?:你(?:哋|們|们)?|店內|店内|呢度|這裡|这里)?\s*(?:有冇|有無|有沒有|有没有|是否有)\s*(.+?)(?:賣|卖|售賣|售卖|出售|現貨|现货|庫存|库存)?[?？!！.。]*$/iu,
    /(?:你(?:哋|們|们)?|店內|店内|呢度|這裡|这里)?\s*(?:賣唔賣|卖不卖|有售)\s*(.+?)[?？!！.。]*$/iu,
    /(.+?)(?:有冇|有沒有|有没有)(?:現貨|现货|庫存|库存|售賣|售卖)?[?？!！.。]*$/iu,
  ];
  for (const pattern of chinesePatterns) {
    const match = text.match(pattern);
    const product = cleanProductLabel(match?.[1]);
    if (product) return product;
  }

  const englishPatterns = [
    /(?:do\s+you|does\s+(?:the\s+)?(?:shop|store)|have\s+you)\s+(?:have|carry|sell|stock)\s+(.+?)[?!.]*$/i,
    /(?:is|are)\s+(?:there\s+)?(?:any\s+)?(.+?)\s+(?:available|in stock|for sale)[?!.]*$/i,
    /(?:do\s+you\s+have)\s+(.+?)[?!.]*$/i,
  ];
  for (const pattern of englishPatterns) {
    const match = text.match(pattern);
    const product = cleanProductLabel(match?.[1]);
    if (product) return product;
  }
  return null;
}

export function classifyNaturalCustomerIntent(
  text: string,
): NaturalCustomerIntent {
  const normalized = (text ?? "").normalize("NFKC").trim();
  if (!normalized) return { kind: "none", product: null };

  // A greeting may prefix a real customer goal.  Classify the meaningful
  // remainder first so "Hi, I need help choosing ..." cannot be reduced to a
  // greeting-only response or fall through to generic clarification.
  const meaningful = stripLeadingGreeting(normalized) || normalized;

  if (
    /^(?:(?:你(?:哋|們|们)?|店內|店内|呢度|這裡|这里)\s*)?(?:有冇|有無|有沒有|有没有|是否有)\s*[?？!！.。]*$/iu
      .test(meaningful) ||
    /^(?:do\s+you|does\s+(?:the\s+)?(?:shop|store))\s+(?:have|carry|sell|stock)\s*[?!.]*$/iu
      .test(meaningful)
  ) {
    return { kind: "product_availability", product: null };
  }

  const availabilityProduct = extractAvailabilityProduct(meaningful);
  if (availabilityProduct) {
    return { kind: "product_availability", product: availabilityProduct };
  }

  const factualQuery = classifyProductFactualQuery(meaningful);
  if (factualQuery) return factualQuery;

  const shoppingProduct = extractShoppingProduct(meaningful);
  if (
    shoppingProduct ||
    /(?:想|要|打算|準備|准备|考慮|考虑|希望)(?:買|买|購買|购买|訂購|订购|入手)|(?:want|would like|plan|hope|looking)(?:\s+to)?\s+(?:buy|purchase|order|get)/i
      .test(meaningful)
  ) {
    return { kind: "product_shopping", product: shoppingProduct };
  }

  if (looksLikeProductGuidance(meaningful)) {
    const product = extractGuidanceProduct(meaningful);
    // Bare sizing shorthand such as "how big?" may be a contextual recall
    // query and must remain available to the state resolver. A model-free turn
    // is guidance only when the customer actually asks to choose/recommend.
    if (
      !product &&
      !/(?:想問|想问|想了解|想睇|想看|請教|请教|推薦|推荐|建議|建议|點(?:樣)?揀|怎樣選|怎样选|如何選|如何选|怎么选|help|advice|guidance|recommend|what\s+should\s+i\s+(?:buy|choose|get)|how\s+(?:should|can|do)\s+i\s+(?:choose|select|pick)|which\s+(?:model|option))/iu
        .test(meaningful)
    ) {
      return { kind: "none", product: null };
    }
    return {
      kind: "product_guidance",
      product,
      two_bedrooms_and_living_room:
        /(?:兩|两|2)\s*間?房.{0,20}(?:廳|厅|客廳|客厅)/i.test(meaningful),
    };
  }

  const conversational = classifyConversationalRoute(normalized);
  if (
    conversational.kind === "conversational" &&
    conversational.subtype === "greeting"
  ) {
    return { kind: "greeting", product: null };
  }

  return { kind: "none", product: null };
}

export function requiresCurrentMerchantEvidence(
  intent: NaturalCustomerIntent,
): boolean {
  // Product-specific facts must use the same current, tenant-scoped KB gate.
  return intent.kind === "product_availability" ||
    intent.kind === "product_factual_query";
}

export function renderNaturalImmediateResponse(
  intent: NaturalCustomerIntent,
  language: NaturalResponseLanguage,
): string | null {
  if (intent.kind === "product_availability" && !intent.product) {
    if (language === "en") {
      return "Which product or model would you like me to check?";
    }
    if (language === "zh-CN") return "你想查哪类产品或哪个型号？";
    return "你想查邊類產品或邊個型號？";
  }
  if (intent.kind === "product_factual_clarification") {
    if (intent.candidates.length > 1) {
      const choices = intent.candidates.join(" / ");
      if (language === "en") return `Which model do you mean: ${choices}?`;
      if (language === "zh-CN") return `你指的是哪个型号：${choices}？`;
      return `你指邊個型號：${choices}？`;
    }
    if (language === "en") return "Which current product or model do you mean?";
    if (language === "zh-CN") return "你指的是哪个当前产品或型号？";
    return "你指邊個現行產品或型號？";
  }
  if (intent.kind === "greeting") {
    if (language === "en") return "Hi! How can I help?";
    if (language === "zh-CN") return "你好！有什么可以帮你？";
    return "你好！有咩可以幫你？";
  }
  if (intent.kind === "product_guidance") {
    if (intent.product && /冷氣|冷气|air\s*condition/i.test(intent.product)) {
      if (language === "en") {
        return "I can help size the AC. What is each room's area, does it get strong afternoon sun, and are you considering window or split units?";
      }
      if (language === "zh-CN") {
        return intent.two_bedrooms_and_living_room
          ? "两间房和客厅都要考虑冷气匹数。各有多少平方呎？有西晒吗？窗口位适合窗口机还是分体机？"
          : "可以帮你估算冷气匹数。空间各有多少平方呎？有西晒吗？是窗口机还是分体机？";
      }
      return intent.two_bedrooms_and_living_room
        ? "兩間房同客廳三個空間要分別估冷氣匹數。你提供各自面積、日照情況同窗口／安裝方式，我就可以幫你縮窄選擇。"
        : "可以幫你估冷氣匹數。你提供空間面積、日照情況同窗口／安裝方式，我就可以幫你縮窄選擇。";
    }
    if (language === "en") {
      return intent.product
        ? `Sure — I can help narrow down the right ${intent.product}. Tell me the intended use, relevant size or space, and any budget or installation limits, and I’ll work from those details.`
        : "Sure — I can help narrow down the right option. Tell me the intended use, relevant size or space, and any budget or installation limits.";
    }
    if (language === "zh-CN") {
      return intent.product
        ? `可以，我可以帮你筛选合适的${
          chineseProductPrefix(intent.product)
        }。告诉我用途、相关尺寸或空间，以及预算或安装限制，我会按这些资料帮你整理。`
        : "可以，我可以帮你筛选合适的选择。告诉我用途、相关尺寸或空间，以及预算或安装限制。";
    }
    return intent.product
      ? `可以，我可以幫你揀合適嘅${
        chineseProductPrefix(intent.product)
      }。你話我知用途、相關尺寸或空間，同埋預算或安裝限制，我會按呢啲資料幫你整理。`
      : "可以，我可以幫你揀合適嘅選擇。你話我知用途、相關尺寸或空間，同埋預算或安裝限制。";
  }
  if (intent.kind !== "product_shopping") return null;

  if (language === "en") {
    return intent.product
      ? `Sure. Which ${intent.product} model are you looking for? If you have not decided yet, I can first check whether the store has relevant product information.`
      : "Sure. What kind of product are you looking for? I can first check what relevant product information the store currently has.";
  }
  if (language === "zh-CN") {
    return intent.product
      ? `可以。你想找哪一款${
        chineseProductPrefix(intent.product)
      }？如果还没决定，我可以先帮你查目前店内有没有相关产品资料。`
      : "可以。你想找哪一类产品？我可以先帮你查目前店内有没有相关产品资料。";
  }
  return intent.product
    ? `可以。你想搵邊款${
      chineseProductPrefix(intent.product)
    }？如果你未決定，我可以先幫你查目前店內有冇相關產品資料。`
    : "可以。你想搵邊類產品？我可以先幫你查目前店內有冇相關產品資料。";
}

export function renderNaturalNoCurrentEvidence(
  intent: NaturalCustomerIntent,
  language: NaturalResponseLanguage,
): string | null {
  if (intent.kind === "product_factual_query") {
    const model = intent.product;
    if (language === "en") {
      return `I cannot find verifiable current product information for ${model}, so I cannot confirm its features or suitability. I will not guess.`;
    }
    if (language === "zh-CN") {
      return `我目前找不到 ${model} 的可核实当前产品资料，所以无法确认功能或适用情况。我不会猜测。`;
    }
    return `我而家搵唔到 ${model} 嘅可核實現行產品資料，所以未能確認功能或適用情況。我唔會估。`;
  }
  if (intent.kind !== "product_availability") return null;
  const product = intent.product;
  const identifiers = exactProductIdentifiers(product);
  if (identifiers.length) {
    const subject = identifiers.length === 1 ? identifiers[0] : product!;
    if (language === "en") {
      return `I cannot find current product information for ${subject}, so I cannot confirm whether it is sold here. I will not guess.`;
    }
    if (language === "zh-CN") {
      return `我目前找不到${subject}的现行产品资料，所以暂时无法确认有没有售卖。我不会猜测。`;
    }
    return `我而家搵唔到${chineseProductPrefix(subject)}${
      chinesePossessiveParticle(subject, "嘅")
    }現行產品資料，所以暫時未能確認有冇售賣。我唔會估。`;
  }
  if (language === "en") {
    return product
      ? `I cannot find current store product information for ${product}, so I cannot confirm whether it is sold here. If you have a specific model, I can check again.`
      : "I cannot find relevant current store product information, so I cannot confirm availability. If you have a specific product or model, I can check again.";
  }
  if (language === "zh-CN") {
    return product
      ? `我目前找不到店内有${chineseProductPrefix(product)}${
        chinesePossessiveParticle(product, "的")
      }产品资料，所以暂时无法确认有没有售卖。如果你有指定型号，我可以再帮你查。`
      : "我目前找不到店内相关产品资料，所以暂时无法确认有没有售卖。如果你有指定产品或型号，我可以再帮你查。";
  }
  return product
    ? `我而家搵唔到店內有${chineseProductPrefix(product)}${
      chinesePossessiveParticle(product, "嘅")
    }產品資料，所以暫時未能確認有冇售賣。你有指定型號的話，我可以再幫你查。`
    : "我而家搵唔到店內相關產品資料，所以暫時未能確認有冇售賣。你有指定產品或型號的話，我可以再幫你查。";
}
