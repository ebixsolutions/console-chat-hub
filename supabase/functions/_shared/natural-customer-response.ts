import { classifyConversationalRoute } from "./conversational-routing.ts";

export type NaturalResponseLanguage = "zh-TW" | "zh-CN" | "en";

export type NaturalCustomerIntent =
  | { kind: "greeting"; product: null }
  | { kind: "product_shopping"; product: string | null }
  | { kind: "product_guidance"; product: string | null; two_bedrooms_and_living_room?: boolean }
  | { kind: "product_availability"; product: string | null }
  | { kind: "none"; product: null };

const MAX_PRODUCT_LABEL_LENGTH = 80;

/** Product-like codes must contain letters and a meaningful numeric part. */
export function exactProductIdentifiers(product: string | null): string[] {
  if (!product) return [];
  const tokens = product.normalize("NFKC").match(
    /(?<![A-Z0-9])(?:[A-Z][A-Z0-9]*-[A-Z0-9]+(?:-[A-Z0-9]+)*|[A-Z]{2,}[A-Z0-9]*\d{2,}[A-Z0-9]*|[A-Z]\d{3,}[A-Z0-9]*)(?![A-Z0-9])/giu,
  ) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 5 && /\d/u.test(token) && /[A-Z]/iu.test(token)))];
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
  const english = text.match(
    /(?:help|advice|guidance|recommendation)s?\s+(?:with|on|for)\s+([^,.!?]{1,48})/i,
  );
  return cleanProductLabel(english?.[1]);
}

function looksLikeProductGuidance(text: string): boolean {
  return /(?:買咩|买什么|揀邊|选哪|點揀|点选|點選|邊款|哪款|邊種|哪种|幾大|几大|幾多匹|几匹|合適|合适|推薦|推荐|建議|建议|what\s+should\s+i\s+(?:buy|choose|get)|which\s+(?:model|size|option)|recommend|advi[cs]e)/iu
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

  if (/^(?:(?:你(?:哋|們|们)?|店內|店内|呢度|這裡|这里)\s*)?(?:有冇|有無|有沒有|有没有|是否有)\s*[?？!！.。]*$/iu.test(meaningful) ||
    /^(?:do\s+you|does\s+(?:the\s+)?(?:shop|store))\s+(?:have|carry|sell|stock)\s*[?!.]*$/iu.test(meaningful)) {
    return { kind: "product_availability", product: null };
  }

  const availabilityProduct = extractAvailabilityProduct(meaningful);
  if (availabilityProduct) {
    return { kind: "product_availability", product: availabilityProduct };
  }

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
    if (
      !product &&
      !/(?:想問|想问|想了解|想睇|想看|請教|请教|推薦|推荐|建議|建议|help|advice|guidance|recommend|what\s+should\s+i\s+(?:buy|choose|get)|which\s+(?:model|option))/iu
        .test(
          meaningful,
        )
    ) return { kind: "none", product: null };
    return {
      kind: "product_guidance",
      product,
      two_bedrooms_and_living_room: /(?:兩|两|2)\s*間?房.{0,20}(?:廳|厅|客廳|客厅)/i.test(meaningful),
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
  return intent.kind === "product_availability";
}

export function renderNaturalImmediateResponse(
  intent: NaturalCustomerIntent,
  language: NaturalResponseLanguage,
): string | null {
  if (intent.kind === "product_availability" && !intent.product) {
    if (language === "en") return "Which product or model would you like me to check?";
    if (language === "zh-CN") return "你想查哪类产品或哪个型号？";
    return "你想查邊類產品或邊個型號？";
  }
  if (intent.kind === "greeting") {
    if (language === "en") return "Hi! How can I help?";
    if (language === "zh-CN") return "你好！有什么可以帮你？";
    return "你好！有咩可以幫你？";
  }
  if (intent.kind === "product_guidance") {
    if (intent.product && /冷氣|冷气|air\s*condition/i.test(intent.product)) {
      if (language === "en") return "I can help size the AC. What is each room's area, does it get strong afternoon sun, and are you considering window or split units?";
      if (language === "zh-CN") return intent.two_bedrooms_and_living_room
        ? "两间房和客厅都要考虑冷气匹数。各有多少平方呎？有西晒吗？窗口位适合窗口机还是分体机？"
        : "可以帮你估算冷气匹数。空间各有多少平方呎？有西晒吗？是窗口机还是分体机？";
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
