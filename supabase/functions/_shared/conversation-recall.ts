/** C3: deterministic, read-only fact ownership routing. No KB, model or state writes. */
import type {
  CommerceEntity,
  ConversationCommerceState,
} from "./commerce-state-contract.ts";
import type { CanonicalConversationMemory } from "./conversation-long-memory.ts";

export type RecallFact =
  | "quantity"
  | "address"
  | "recipient"
  | "contact"
  | "room_size"
  | "horsepower"
  | "brand_constraint"
  | "delivery_preference"
  | "quotation_status"
  | "order_status"
  | "payment_status"
  | "delivery_status"
  | "installation_status"
  | "constraints"
  | "preferences"
  | "region"
  | "goal"
  | "correction"
  | "summary"
  | "historical_exclusion"
  | "entity_status";
export type RecallAuthority =
  | "CANONICAL_COMMERCE_STATE"
  | "CURRENT_CUSTOMER_MEMORY";
export interface RecallScope {
  conversation_id: string;
  company_id: string;
  source_message_id: string;
}
export interface RecallCommerceSnapshot extends RecallScope {
  revision: number;
  state: ConversationCommerceState;
}
export interface RecallEvidence {
  fact_type: RecallFact;
  state_path: string;
  value: unknown;
  authority: RecallAuthority;
  entity_id: string | null;
  entity_label?: string | null;
  region: string | null;
  evidence_source_message_id: string | null;
  temporal_scope: "current" | "excluded";
  source_kind: string;
}
export interface RecallProvenance extends RecallScope {
  memory_revision: number | null;
  commerce_state_revision: number | null;
  commerce_source_message_id: string | null;
  evidence: RecallEvidence[];
}
export type ConversationRecallDecision =
  | {
    handled: true;
    authority: RecallAuthority;
    fact_type: string;
    state_path?: string;
    value: unknown;
    provenance: RecallProvenance;
  }
  | {
    handled: false;
    reason: "CURRENT_KB_REQUIRED" | "AMBIGUOUS" | "NOT_A_RECALL_QUERY";
    detail: string;
    requested_facts: RecallFact[];
  };
export interface ConversationRecallInput extends RecallScope {
  question: string;
  memory: CanonicalConversationMemory | null;
  commerce: RecallCommerceSnapshot | null;
  /** Hints may select an existing entity; they can never supply a fact value. */
  referents?: Array<{ ref: string; confidence: number; source?: string }>;
  recent_questions?: string[];
  explicit_handoff?: boolean;
}

// A single declarative fact vocabulary, shared by query classification and key matching.
// These are field concepts, not fixture-specific replies or an industry router.
const FIELDS: Partial<Record<RecallFact, string[]>> = {
  quantity: [
    "quantity",
    "count",
    "how many",
    "數量",
    "数量",
    "幾部",
    "几部",
    "幾台",
    "几台",
    "幾件",
    "几件",
    "幾多部",
    "几多部",
  ],
  address: ["address", "地址", "邊座", "哪座", "邊度收貨", "哪里收货"],
  recipient: ["recipient", "收貨人", "收货人", "收件人", "誰收", "誰人收"],
  contact: [
    "phone",
    "telephone",
    "contact",
    "電話",
    "电话",
    "聯絡",
    "联络",
    "手機號",
    "手机号",
  ],
  room_size: [
    "room size",
    "room area",
    "room_size",
    "room_area",
    "area_sqft",
    "square feet",
    "sq ft",
    "sqft",
    "面積",
    "面积",
    "平方呎",
    "平方尺",
    "幾呎",
    "几呎",
    "房間大小",
    "房间大小",
    "客廳幾大",
    "間房幾大",
    "room dimensions",
    "living room area",
  ],
  horsepower: [
    "horsepower",
    "horse power",
    "horse_power",
    "hp",
    "匹數",
    "匹数",
    "幾匹",
    "几匹",
  ],
  brand_constraint: ["brand", "品牌", "牌子"],
  delivery_preference: [
    "preferred_date",
    "preferred_window",
    "delivery preference",
    "delivery date",
    "delivery day",
    "delivery time",
    "哪天送",
    "邊日送",
    "送貨日期",
    "送货日期",
    "送貨時間",
    "送货时间",
    "星期",
    "週六",
    "周六",
    "saturday",
    "送貨安排",
    "送货安排",
  ],
  quotation_status: ["quotation", "quote", "報價", "报价"],
  order_status: ["order", "訂單", "订单", "落單", "落单", "下單", "下单"],
  payment_status: ["payment", "paid", "付款", "支付"],
  delivery_status: [
    "delivery status",
    "delivery state",
    "送貨狀態",
    "送货状态",
    "安排送貨",
    "安排送货",
  ],
  installation_status: [
    "installation status",
    "installation state",
    "安裝狀態",
    "安装状态",
    "安排安裝",
    "安排安装",
  ],
  constraints: [
    "constraints",
    "limits",
    "限制",
    "條件",
    "条件",
    "不能",
    "唔可以",
  ],
  preferences: ["preferences", "preference", "偏好", "喜好"],
  region: ["region", "market", "jurisdiction", "地區", "地区", "市場", "市场"],
  goal: ["goal", "目的", "目標", "目标"],
  correction: ["correction", "corrected", "更正", "改正"],
  summary: [
    "summarize",
    "summarise",
    "summary",
    "總結",
    "总结",
    "整理需求",
    "目前需求",
    "current requirements",
    "分開說明",
    "分开说明",
  ],
  entity_status: [
    "item status",
    "cancelled item",
    "canceled item",
    "deferred",
    "取消的",
    "被取消",
    "暫緩",
    "暂缓",
    "延後",
    "延后",
  ],
};
const KEY_ALIASES: Partial<Record<RecallFact, string[]>> = {
  quantity: ["quantity", "requested_quantity", "item_quantity"],
  address: ["address", "delivery_address", "shipping_address", "corrected_delivery_address"],
  recipient: ["recipient", "recipient_name", "contact_name", "收貨人姓名"],
  contact: [
    "recipient_phone",
    "phone",
    "contact_number",
    "phone_number",
    "telephone",
  ],
  room_size: [
    "room_size",
    "room_area",
    "room_area_sqft",
    "room_size_sqft",
    "area_sqft",
    "living_room_size",
    "living_room_area",
    "room_size_sq_ft",
    "客廳面積",
    "客厅面积",
  ],
  horsepower: [
    "horsepower",
    "hp",
    "horse_power",
    "required_horsepower",
    "horsepower_requirement",
    "匹數需求",
  ],
  brand_constraint: [
    "brand_required",
    "brand_mandatory",
    "brand_not_required",
    "brand_optional",
    "required_brand",
    "brand_preference",
    "brand_constraint",
    "brand_flexible",
  ],
  delivery_preference: [
    "preferred_date",
    "preferred_window",
    "preferred_delivery_day",
    "delivery_preference",
    "delivery_day",
    "delivery_date",
    "delivery_time",
  ],
};
const OWNER = [
  "my",
  "our",
  "i said",
  "i asked",
  "i wanted",
  "we said",
  "you remember",
  "did i",
  "did we",
  "i need",
  "i require",
  "read back",
  "readback",
  "recall",
  "我",
  "我們",
  "你記錄",
  "you recorded",
  "之前講",
  "頭先",
  "剛才",
  "记得",
  "記得",
  "需求",
  "偏好",
  "要求",
  "更正",
  "改正",
];
const EXTERNAL = [
  "price",
  "pricing",
  "cost",
  "stock",
  "inventory",
  "warranty",
  "policy",
  "eligibility",
  "eligible",
  "specification",
  "official",
  "published",
  "supported",
  "available",
  "in stock",
  "價錢",
  "价钱",
  "現價",
  "现价",
  "售價",
  "售价",
  "收費",
  "收费",
  "庫存",
  "库存",
  "現貨",
  "现货",
  "保養",
  "保养",
  "保固",
  "政策",
  "資格",
  "资格",
  "官方",
  "規格",
  "规格",
  "可否送貨",
  "能否送貨",
];
const HISTORICAL = [
  "historical",
  "old quote",
  "previous quote",
  "prior quote",
  "舊報價",
  "旧报价",
  "歷史",
  "历史",
  "之前報價",
  "之前的報價",
];
const EXCLUSION = [
  "not reuse",
  "do not treat",
  "not treat",
  "not use",
  "do not use",
  "don't use",
  "not current",
  "not carry",
  "不再用",
  "不要用",
  "唔好用",
  "不能用",
  "不應沿用",
  "不要沿用",
  "不可沿用",
  "不是現價",
  "不當作",
  "不要當作",
];
const ASK = [
  "what",
  "which",
  "who",
  "where",
  "when",
  "how",
  "did i",
  "did we",
  "is it",
  "are we",
  "have i",
  "have we",
  "remind",
  "recall",
  "read back",
  "readback",
  "tell me",
  "說明",
  "说明",
  "確認一下",
  "核對",
  "核对",
  "讀出",
  "讀返",
  "讀回",
  "記得",
  "記住了什麼",
  "幾多",
  "多少",
  "幾部",
  "幾台",
  "幾匹",
  "係咪",
  "是否",
  "還是",
  "还是",
  "哪",
  "邊個",
  "邊日",
  "邊度",
  "什麼",
  "什么",
];
const STATUS = [
  "status",
  "state",
  "stage",
  "confirmed",
  "yet",
  "paid",
  "placed",
  "scheduled",
  "arranged",
  "狀態",
  "状态",
  "階段",
  "阶段",
  "確認",
  "确认",
  "落實",
  "落实",
  "已",
  "未",
  "是否",
  "係咪",
  "還是",
  "还是",
];
const norm = (x: unknown) =>
  typeof x === "string"
    ? x.normalize("NFKC").toLowerCase().replace(/[_-]+/g, " ").replace(
      /\s+/g,
      " ",
    ).trim()
    : "";
const keyNorm = (x: string) => norm(x).replace(/[^\p{L}\p{N}]/gu, "");
const object = (x: unknown): Record<string, unknown> | null =>
  x && typeof x === "object" && !Array.isArray(x)
    ? x as Record<string, unknown>
    : null;
function phrase(text: string, word: string): boolean {
  const q = norm(text), w = norm(word);
  if (!w) return false;
  let at = q.indexOf(w);
  while (at >= 0) {
    if (
      !/^[a-z0-9 ]+$/i.test(w) ||
      (!/[a-z0-9]/i.test(q[at - 1] ?? "") &&
        !/[a-z0-9]/i.test(q[at + w.length] ?? ""))
    ) return true;
    at = q.indexOf(w, at + 1);
  }
  return false;
}
const any = (text: string, words: readonly string[]) =>
  words.some((w) => phrase(text, w));
const aliases = (
  f: RecallFact,
) => [...(FIELDS[f] ?? []), ...(KEY_ALIASES[f] ?? [])];
const hasField = (text: string, f: RecallFact) => any(text, aliases(f));
function keyMatches(key: string, f: RecallFact): boolean {
  const k = keyNorm(key);
  return aliases(f).some((a) => keyNorm(a) === k) ||
    (f === "room_size" &&
      /(?:room|livingroom)(?:area|size)(?:sqft|sqfeet|squarefeet|sqm)?/.test(
        k,
      )) ||
    (f === "horsepower" &&
      /^(?:required|preferred|requested)?horsepower(?:requirement)?$/.test(k));
}
function usable(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return true;
  if (typeof v === "string") return v.trim().length > 0 && v.length <= 1200;
  if (Array.isArray(v)) {
    return v.length > 0 && v.length <= 24 && v.every(usable);
  }
  const o = object(v);
  return !!o && Object.keys(o).length <= 24 && JSON.stringify(o).length <= 2400;
}
function fail(
  reason: "CURRENT_KB_REQUIRED" | "AMBIGUOUS" | "NOT_A_RECALL_QUERY",
  detail: string,
  requested_facts: RecallFact[] = [],
): ConversationRecallDecision {
  return { handled: false, reason, detail, requested_facts };
}
function parseQuery(
  q: string,
  recentQuestions: string[] = [],
): { facts: RecallFact[]; stop?: ConversationRecallDecision } {
  if (!q.trim() || q.length > 2400) {
    return {
      facts: [],
      stop: fail("NOT_A_RECALL_QUERY", "EMPTY_OR_OVERSIZED_INPUT"),
    };
  }
  const owner = any(q, OWNER), question = /[?？]|呢$/.test(q) || any(q, ASK);
  const summary = hasField(q, "summary");
  let facts = (Object.keys(FIELDS) as RecallFact[]).filter((f) =>
    hasField(q, f)
  );
  // A compact slot question is a recall request, not an instruction to change state.
  const compact = q.replace(/[?？:：\s]/g, "").length <= 24 &&
    facts.length > 0 &&
    !/(?:\d|[一二兩两三四五六七八九十])\s*(?:部|台|匹|件)|\b(?:set|change|cancel|add|update|was|is|are|have|has)\b|改為|改成|取消|記住|记住|已經|已经|已付|未付|是|係|我想|我要|我偏好/i
      .test(q);
  if (
    !question &&
    /^(?:please\s+)?(?:remember|set|change|update|cancel|add)\b|^(?:請|请)?(?:記住|记住|改為|改成)|(?:已經|已经)(?:付款|落單|下单)/i
      .test(q)
  ) {
    return {
      facts,
      stop: fail("NOT_A_RECALL_QUERY", "CUSTOMER_MUTATION_NOT_RECALL", facts),
    };
  }
  if (!question && !summary && !compact) {
    return {
      facts,
      stop: fail("NOT_A_RECALL_QUERY", "CUSTOMER_STATEMENT_NOT_QUERY", facts),
    };
  }
  const exclusion = any(q, HISTORICAL) && any(q, EXCLUSION);
  // A question about validity, official price, or a mixed external fact always reaches C1.
  const validity = any(q, [
    "valid",
    "validity",
    "有效",
    "仍有效",
    "仍然有效",
    "現價多少",
    "現時售價",
  ]);
  const external = any(q, EXTERNAL);
  if (
    exclusion && !validity &&
    !any(q, ["stock", "warranty", "policy", "official", "庫存", "保養", "官方"])
  ) return { facts: ["historical_exclusion"] };
  if (
    external || validity ||
    ((hasField(q, "horsepower") || hasField(q, "brand_constraint")) && !owner &&
      !compact && any(q, ["model", "spec", "does", "型號", "本身"]))
  ) {
    return {
      facts,
      stop: fail("CURRENT_KB_REQUIRED", "EXTERNAL_OR_MIXED_FACT", facts),
    };
  }
  if (
    hasField(q, "quotation_status") && !any(q, STATUS) &&
    !hasField(q, "order_status") && !summary && !compact
  ) {
    return {
      facts,
      stop: fail("CURRENT_KB_REQUIRED", "QUOTE_AMOUNT_OR_BUSINESS_FACT", facts),
    };
  }
  if (summary) return { facts: ["summary"] };
  if (facts.includes("delivery_preference")) {
    facts = facts.filter((f) => f !== "preferences");
  }
  if (facts.includes("brand_constraint")) {
    facts = facts.filter((f) => f !== "constraints" && f !== "preferences");
  }
  if (facts.length > 1) facts = facts.filter((f) => f !== "correction");
  const compactSizeQuestion = /^(?:幾大|几大|多大|大小)(?:呢)?[?？]?$|^(?:what\s+size|how\s+big)(?:\s+(?:is|are)\s+(?:it|that|they|those))?[?？]?$/i
    .test(q.trim());
  const contextualSizeReferent = recentQuestions.slice(0, 12).some((text) =>
    hasField(text, "room_size") ||
    /(?:房|房間|房间|客廳|客厅|廳|厅|room|bedroom|living\s+room|space|area|dimensions?).{0,24}(?:幾大|几大|多大|大小|size|big|dimensions?)/i
      .test(text)
  );
  if (!facts.length && compactSizeQuestion && contextualSizeReferent) {
    facts = ["room_size"];
  }
  if (
    !facts.length &&
    /^(?:咁|那|那個|那个|這個|这个|嗰個|它|幾多|多少|what about it|what about that|how many|and that|that one)[^。.!！]{0,30}[?？呢]?$/i
      .test(q.trim())
  ) {
    for (const previous of recentQuestions.slice(0, 12)) {
      const prior = parseQuery(previous);
      if (
        prior.stop && !prior.stop.handled &&
        prior.stop.reason === "CURRENT_KB_REQUIRED"
      ) {
        return {
          facts,
          stop: fail("CURRENT_KB_REQUIRED", "PRIOR_EXTERNAL_REFERENT"),
        };
      }
      if (prior.facts.length === 1 && !prior.stop) {
        return { facts: prior.facts };
      }
      if (prior.facts.length > 1) break;
    }
    return { facts, stop: fail("AMBIGUOUS", "SHORT_RECALL_FACT_UNRESOLVED") };
  }
  if (!facts.length) {
    return {
      facts,
      stop: fail("NOT_A_RECALL_QUERY", "NO_SUPPORTED_FACT_SLOT"),
    };
  }
  return { facts };
}

const REGION_ALIASES: Record<string, string[]> = {
  hong_kong: ["hong_kong", "hong kong", "hk", "香港"],
  taiwan: ["taiwan", "tw", "台灣", "台湾"],
  macau: ["macau", "macao", "澳門", "澳门"],
  singapore: ["singapore", "sg", "新加坡"],
};
function regionId(value: string): string {
  return Object.entries(REGION_ALIASES).find(([, names]) =>
    names.some((n) => keyNorm(n) === keyNorm(value))
  )?.[0] ?? keyNorm(value);
}
function requestedRegions(question: string): string[] {
  return Object.entries(REGION_ALIASES).filter(([, names]) =>
    any(question, names)
  ).map(([id]) => id);
}
function fieldValue(field: RecallFact, key: string, value: unknown): unknown {
  return field === "brand_constraint" &&
      ["brandnotrequired", "brandoptional", "brandflexible"].includes(
        keyNorm(key),
      ) && typeof value === "boolean"
    ? !value
    : value;
}
const TYPE_ALIASES: string[][] = [
  [
    "aircon",
    "air conditioner",
    "air conditioning",
    "ac",
    "冷氣",
    "冷氣機",
    "冷气",
    "空調",
    "空调",
  ],
  ["washer", "washing machine", "洗衣機", "洗衣机"],
];
function entityAliases(e: CommerceEntity): string[] {
  const values = [
    e.entity_id,
    e.category,
    e.brand,
    e.model,
    ...["name", "product_name", "display_name", "original_name", "sku"].map(
      (k) => e.attributes?.[k],
    ),
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  for (const group of TYPE_ALIASES) {
    if (values.some((v) => group.some((a) => keyNorm(a) === keyNorm(v)))) {
      values.push(...group);
    }
  }
  return [...new Set(values)];
}
function selectEntities(
  input: ConversationRecallInput,
  entities: CommerceEntity[],
): CommerceEntity[] {
  const regions = requestedRegions(input.question);
  if (regions.length === 1) {
    entities = entities.filter((e) =>
      typeof e.attributes.region === "string" &&
      regionId(e.attributes.region) === regions[0]
    );
  }
  const explicit = entities.filter((e) =>
    any(input.question, entityAliases(e))
  );
  if (explicit.length) return explicit;
  const hinted = entities.filter((e) =>
    (input.referents ?? []).some((r) =>
      r.confidence >= 0.85 && r.source !== "unknown" &&
      entityAliases(e).some((a) => keyNorm(a) === keyNorm(r.ref))
    )
  );
  if (hinted.length === 1) return hinted;
  // Recent questions resolve a referent only. No fact is extracted from raw history.
  for (const q of (input.recent_questions ?? []).slice(0, 12)) {
    const matches = entities.filter((e) => any(q, entityAliases(e)));
    if (matches.length === 1) return matches;
  }
  const topic = input.commerce?.state.current_topic ||
    input.memory?.current_topic || "";
  const focused = entities.filter((e) => any(topic, entityAliases(e)));
  if (focused.length === 1) return focused;
  const active = entities.filter((e) =>
    !["cancelled", "deferred"].includes(e.status)
  );
  return active.length === 1 ? active : [];
}

function isCurrentEntity(entity: CommerceEntity): boolean {
  return !["cancelled", "deferred"].includes(entity.status);
}
function correctedValue(text: string, f: RecallFact): unknown {
  if (!hasField(text, f) || /[?？]/.test(text)) return null;
  // One assignment grammar for retained corrections; never parse the incoming question as a value.
  const assigned = text.match(
    /(?:而是|而係|而系|改為|改为|改成|改做|更改為|(?:不是|唔係)[^，,。]{1,80}[，,]\s*(?:而)?(?:是|係)|\bto\b)\s*([^;；。]+)[。.!！]?$/i,
  )?.[1];
  const matched =
    aliases(f).map((a) => ({ a, at: norm(text).indexOf(norm(a)) })).filter(
      (x) => x.at >= 0,
    ).sort((a, b) => a.at - b.at || b.a.length - a.a.length)[0];
  let v = assigned ??
    (matched ? text.slice(matched.at + matched.a.length) : "");
  v = v.replace(/^\s*(?:是|為|为|係|is|was|=|:|：)\s*/i, "").replace(
    /[,，]\s*(?:not\b|唔係|不是|並非|而不是)[\s\S]*$/i,
    "",
  ).trim();
  if (f === "quantity") {
    return /^\d+(?:\s*(?:部|台|件|units?))?[.!。！]?$/i.test(v)
      ? Number(v.match(/\d+/)![0])
      : null;
  }
  if (["room_size", "horsepower"].includes(f)) return /\d/.test(v) ? v : null;
  if (f === "brand_constraint") {
    if (
      any(text, [
        "not required",
        "not mandatory",
        "optional",
        "不限",
        "不一定",
        "不是必須",
        "非必要",
        "無指定",
        "不強制",
        "唔一定",
      ])
    ) return false;
  }
  return usable(v) ? v : null;
}

function retainedQuantity(text: string): number | null {
  const match = norm(text).match(
    /(?:只|僅|仅|目前|現在|现在|而家|實際|实际)?\s*(?:保留|留下|剩下|剩餘|剩余|餘下|余下|keep|kept|retain|retained|remain(?:ing)?)\D{0,48}?([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|units?|items?)/i,
  );
  if (!match?.[1]) return null;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  return ({
    一: 1,
    二: 2,
    兩: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  } as Record<string, number>)[match[1]] ?? null;
}

function asksRetainedQuantity(question: string): boolean {
  return hasField(question, "quantity") &&
    /(?:實際|实际|目前|現在|现在|而家|current|actual)?\s*(?:保留|留下|剩下|剩餘|剩余|餘下|余下|keep|kept|retain|retained|remain(?:ing)?)/i
      .test(norm(question));
}

function asksInactiveEntityStatus(question: string): boolean {
  return hasField(question, "entity_status") &&
    /(?:被)?(?:取消|暫緩|暂缓)|cancelled item|canceled item|deferred/i.test(
      norm(question),
    );
}

function latestRetainedQuantity(
  memory: CanonicalConversationMemory | null,
): { value: number; index: number } | null {
  if (!memory) return null;
  for (let index = 0; index < memory.latest_corrections.length; index++) {
    const value = retainedQuantity(memory.latest_corrections[index]);
    if (value !== null) return { value, index };
  }
  return null;
}

function correctedInactiveEntityLabel(
  input: ConversationRecallInput,
  entity: CommerceEntity,
): string | null {
  if (!["cancelled", "deferred"].includes(entity.status)) return null;
  const inactive = input.commerce?.state.entities.filter((candidate) =>
    ["cancelled", "deferred"].includes(candidate.status)
  ) ?? [];
  if (inactive.length !== 1 || inactive[0].entity_id !== entity.entity_id) {
    return null;
  }
  for (const correction of input.memory?.latest_corrections ?? []) {
    const match = correction.match(
      /(?:更正\s*[:：,，]?\s*)?([^，,。;；]{1,60}?)(?:暫時|暂时)?\s*(?:取消|暫緩|暂缓|cancel(?:led|ed)?|defer(?:red)?)/i,
    );
    const label = match?.[1]?.replace(/^(?:更正\s*[:：,，]?\s*)/i, "")
      .trim();
    if (label) return label;
  }
  return null;
}
interface Candidate extends RecallEvidence {
  rank: number;
}
interface ScopedCollectionMember {
  member_id: string;
  group: string;
  value: unknown;
}
function scopedCollectionMembers(value: unknown): ScopedCollectionMember[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = object(entry);
    return typeof row?.member_id === "string" &&
        typeof row.group === "string" && usable(row.value)
      ? [{
        member_id: row.member_id,
        group: row.group,
        value: row.value,
      }]
      : [];
  });
}
function contextualRoomSizeGroup(input: ConversationRecallInput): string | null {
  for (const text of [input.question, ...(input.recent_questions ?? []).slice(0, 12)]) {
    if (/(?:客廳|客厅|廳|厅|living\s+room)/i.test(text)) return "living_room";
    if (/(?:房|房間|房间|room|bedroom)/i.test(text)) return "room";
  }
  return null;
}
function resolvedRoomSizeCollection(
  input: ConversationRecallInput,
  candidates: Candidate[],
): Candidate | null {
  const group = contextualRoomSizeGroup(input);
  if (!group) return null;
  const collections = candidates.map((candidate) => ({
    candidate,
    members: candidate.entity_id === null
      ? scopedCollectionMembers(candidate.value)
      : [],
  })).filter((entry) => entry.members.length > 0);
  if (collections.length !== 1) return null;
  const applicable = collections[0].members.filter((member) =>
    member.group === group
  );
  if (applicable.length === 0) return null;
  return {
    ...collections[0].candidate,
    value: applicable.map((member) => ({
      member_id: member.member_id,
      value: member.value,
    })),
  };
}
function canonicalCandidates(
  input: ConversationRecallInput,
  f: RecallFact,
  selected: CommerceEntity[],
): Candidate[] {
  const snapshot = input.commerce;
  if (!snapshot) return [];
  const s = snapshot.state;
  const out: Candidate[] = [];
  const add = (
    path: string,
    v: unknown,
    entity: CommerceEntity | null = null,
    kind = "canonical_state",
    rank = 0,
  ) => {
    if (!usable(v)) return;
    out.push({
      fact_type: f,
      value: v,
      state_path: path,
      authority: rank === 0
        ? "CANONICAL_COMMERCE_STATE"
        : "CURRENT_CUSTOMER_MEMORY",
      entity_id: entity?.entity_id ?? null,
      entity_label: entity
        ? String(
          entity.attributes?.display_name ?? entity.attributes?.name ??
            correctedInactiveEntityLabel(input, entity) ?? entity.category,
        )
        : null,
      region: typeof entity?.attributes?.region === "string"
        ? entity.attributes.region
        : null,
      evidence_source_message_id: entity?.provenance.source_message_id ??
        (path.startsWith("delivery.")
          ? s.delivery.provenance?.source_message_id
          : null) ??
        null,
      temporal_scope: "current",
      source_kind: kind,
      rank,
    });
  };
  const delivery: Partial<Record<RecallFact, keyof typeof s.delivery>> = {
    address: "address",
    recipient: "recipient_name",
    contact: "recipient_phone",
    delivery_status: "confirmed",
  };
  if (delivery[f]) add(`delivery.${delivery[f]}`, s.delivery[delivery[f]!]);
  if (f === "delivery_preference") {
    const dates = [s.delivery.preferred_date, s.delivery.preferred_window]
      .filter(usable);
    if (dates.length) {
      add("delivery.preferred_date|delivery.preferred_window", dates);
    }
  }
  if (["quotation_status", "order_status", "payment_status"].includes(f)) {
    add(
      `conversion.${f}`,
      s.conversion[f as "quotation_status" | "order_status" | "payment_status"],
    );
  }
  if (f === "installation_status") {
    add(
      "installation.items",
      s.installation.items.map((x) => ({ kind: x.kind, status: x.status })),
    );
  }
  if (f === "entity_status") {
    for (const e of selected) {
      add(`entities.${s.entities.indexOf(e)}.status`, e.status, e);
    }
  }
  if (f === "quantity") {
    for (
      const e of selected.filter((e) =>
        !["cancelled", "deferred"].includes(e.status)
      )
    ) add(`entities.${s.entities.indexOf(e)}.quantity`, e.quantity, e);
  }
  if (["room_size", "horsepower", "brand_constraint"].includes(f)) {
    const scan = (
      o: Record<string, unknown>,
      path: string,
      entity: CommerceEntity | null,
    ) => {
      for (const [key, raw] of Object.entries(o)) {
        if (keyMatches(key, f)) {
          const v = fieldValue(f, key, raw);
          add(
            `${path}.${key}`,
            v,
            entity,
            "customer_owned_canonical_property",
            2,
          );
        }
      }
    };
    for (
      const e of selected.filter((e) =>
        !["cancelled", "deferred"].includes(e.status) &&
        e.provenance.source_type === "customer"
      )
    ) {
      scan(e.constraints, `entities.${s.entities.indexOf(e)}.constraints`, e);
      scan(e.attributes, `entities.${s.entities.indexOf(e)}.attributes`, e);
    }
    scan(s.customer_constraints, "customer_constraints", null);
    if (f === "room_size") {
      scan(
        s.installation.site_conditions,
        "installation.site_conditions",
        null,
      );
    }
  }
  return out;
}
function memoryCandidates(
  input: ConversationRecallInput,
  f: RecallFact,
  selected: CommerceEntity[],
): Candidate[] {
  const m = input.memory;
  if (!m) return [];
  const out: Candidate[] = [];
  const selectedIds = new Set(selected.map((e) => e.entity_id));
  const excluded = new Set(
    m.cancelled_or_superseded.filter((x) => x.entity_id).map((x) =>
      x.entity_id!
    ),
  );
  const currentRegion =
    m.current_regions.find((r) => r.temporal_scope === "current")?.region ??
      null;
  const add = (
    path: string,
    value: unknown,
    rank: number,
    entity: string | null = null,
    region: string | null = null,
    source: string | null = null,
    sourceKind = "retained_customer_fact",
  ) => {
    if (
      !usable(value) ||
      (entity && (excluded.has(entity) || !selectedIds.has(entity)))
    ) return;
    if (
      region && currentRegion && regionId(region) !== regionId(currentRegion)
    ) return;
    out.push({
      fact_type: f,
      value,
      state_path: path,
      authority: "CURRENT_CUSTOMER_MEMORY",
      entity_id: entity,
      region,
      evidence_source_message_id: source,
      temporal_scope: "current",
      source_kind: sourceKind,
      rank,
    });
  };
  if (f === "quantity" && asksRetainedQuantity(input.question)) {
    const retained = latestRetainedQuantity(m);
    if (retained) {
      add(
        `latest_corrections.${retained.index}.retained_quantity`,
        retained.value,
        1,
        null,
        null,
        null,
        "retained_customer_correction_checkpoint",
      );
    }
  }
  for (let i = 0; i < m.latest_corrections.length; i++) {
    const text = m.latest_corrections[i];
    const namedEntities = (input.commerce?.state.entities ?? []).filter((e) =>
      any(text, entityAliases(e))
    );
    if (namedEntities.some((e) => !selectedIds.has(e.entity_id))) continue;
    const value = correctedValue(text, f);
    if (usable(value)) {
      add(
        `latest_corrections.${i}`,
        value,
        1,
        namedEntities[0]?.entity_id ?? null,
        null,
        null,
        "retained_customer_correction_checkpoint",
      );
      break;
    }
  }
  for (let i = 0; i < m.current_customer_facts.length; i++) {
    const x = m.current_customer_facts[i];
    if (x.authority !== "customer" || !keyMatches(x.key, f)) continue;
    const value = fieldValue(f, x.key, x.value);
    add(
      `current_customer_facts.${i}.value`,
      value,
      keyNorm(x.key).startsWith("corrected") ? -1 : 2,
      x.entity_id ?? null,
      x.region ?? null,
      x.source_message_id ?? null,
    );
  }
  for (
    const e of m.active_entities.filter((e) => selectedIds.has(e.entity_id))
  ) {
    for (const [key, value] of Object.entries(e.current_requirements)) {
      if (keyMatches(key, f)) {
        add(
          `active_entities.${
            m.active_entities.indexOf(e)
          }.current_requirements.${key}`,
          fieldValue(f, key, value),
          2,
          e.entity_id,
          e.region,
        );
      }
    }
  }
  // Legacy retained preference/constraint statements are evidence, not free-form instructions.
  for (
    const bucket of ["customer_preferences", "active_constraints"] as const
  ) {
    for (let i = 0; i < m[bucket].length; i++) {
      const text = m[bucket][i];
      const named = (input.commerce?.state.entities ?? []).filter((e) =>
        any(text, entityAliases(e))
      );
      if (named.some((e) => !selectedIds.has(e.entity_id))) continue;
      if (
        f === "delivery_preference" &&
        any(text, ["送貨", "送货", "delivery"]) &&
        any(text, ["偏好", "希望", "prefer", "星期", "週", "周", "saturday"]) &&
        !/[?？]/.test(text)
      ) add(`${bucket}.${i}`, text, 3);
      else if (hasField(text, f)) {
        add(
          `${bucket}.${i}`,
          correctedValue(text, f),
          3,
          named[0]?.entity_id ?? null,
        );
      }
    }
  }
  if (f === "constraints") add("active_constraints", m.active_constraints, 2);
  if (f === "preferences") {
    add("customer_preferences", m.customer_preferences, 2);
  }
  if (f === "region") add("current_regions", m.current_regions, 2);
  if (f === "goal") add("current_goal", m.current_goal, 2);
  if (f === "correction") {
    add("latest_corrections.0", m.latest_corrections[0], 1);
  }
  if (f === "entity_status") {
    for (let i = 0; i < m.cancelled_or_superseded.length; i++) {
      const fact = m.cancelled_or_superseded[i];
      if (fact.authority !== "customer" && fact.authority !== "canonical_commerce") continue;
      add(`cancelled_or_superseded.${i}`, fact.entity_id ?? fact.value, 1, null, fact.region ?? null, fact.source_message_id ?? null);
    }
  }
  return out;
}

export function resolveConversationRecall(
  input: ConversationRecallInput,
): ConversationRecallDecision {
  if (input.explicit_handoff) {
    return fail("NOT_A_RECALL_QUERY", "HANDOFF_PRECEDENCE");
  }
  const parsed = parseQuery(input.question, input.recent_questions);
  const m = input.memory, c = input.commerce;
  const requestedAmounts = (input.question.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((v) => Number(v.replace(/,/g, "")));
  const retainedHistoricalAmount = (m?.historical_facts ?? []).some((fact) => {
    const value = object(fact.value);
    return fact.authority === "historical" && /quote/i.test(fact.key) &&
      typeof value?.amount === "number" && requestedAmounts.includes(value.amount);
  });
  const historicalValidityReadback = Boolean(parsed.stop && !parsed.stop.handled &&
    parsed.stop.reason === "CURRENT_KB_REQUIRED") &&
    retainedHistoricalAmount &&
    any(input.question, ["當作", "当作", "treat as"]) &&
    any(input.question, ["現售價", "现售价", "current price"]);
  if (parsed.stop && !historicalValidityReadback) return parsed.stop;
  const facts = historicalValidityReadback ? ["historical_exclusion" as RecallFact] : parsed.facts;
  if (!input.company_id || !input.conversation_id || !input.source_message_id) {
    return fail("AMBIGUOUS", "MISSING_SCOPE", facts);
  }
  if (
    m &&
    (m.version !== "conversation-memory-1.0.0" ||
      m.company_id !== input.company_id ||
      m.conversation_id !== input.conversation_id ||
      m.source_message_id !== input.source_message_id ||
      !Number.isInteger(m.memory_revision) || m.memory_revision < 1)
  ) return fail("AMBIGUOUS", "MEMORY_SCOPE_OR_SOURCE_MISMATCH", facts);
  if (
    c &&
    (c.company_id !== input.company_id ||
      c.conversation_id !== input.conversation_id ||
      !Number.isInteger(c.revision) || c.revision < 0 ||
      c.state.version !== "commerce-state-1.0.0")
  ) return fail("AMBIGUOUS", "COMMERCE_SCOPE_MISMATCH", facts);
  if (m && c && m.commerce_state_revision !== c.revision) {
    return fail("AMBIGUOUS", "STALE_COMMERCE_MEMORY_REVISION", facts);
  }
  const regions = requestedRegions(input.question);
  const currentRegions =
    m?.current_regions.filter((r) => r.temporal_scope === "current").map((r) =>
      regionId(r.region)
    ) ?? [];
  if (
    regions.length && facts.some((f) =>
      [
        "address",
        "recipient",
        "contact",
        "delivery_preference",
        "order_status",
        "quotation_status",
        "payment_status",
        "delivery_status",
        "installation_status",
      ].includes(f)
    ) &&
    (regions.length !== 1 || currentRegions.length !== 1 ||
      currentRegions[0] !== regions[0])
  ) return fail("AMBIGUOUS", "TRANSACTION_REGION_NOT_PROVEN", facts);
  // Resolve field/entity pairs, not a global noun bag. Whole-query external facts
  // were rejected above, so this cannot partially answer a mixed KB request.
  const clauses = input.question.split(/[;；，,?!？！]|\s+and\s+/i).map((x) =>
    x.trim()
  ).filter(Boolean);
  if (clauses.length > 8) {
    return fail("AMBIGUOUS", "TOO_MANY_REQUESTED_CLAUSES", facts);
  }
  const slots: Array<{ fact: RecallFact; question: string }> = [];
  for (const f of facts) {
    const matching = clauses.filter((q) => hasField(q, f));
    const named = matching.filter((q) =>
      (c?.state.entities ?? []).some((e) => any(q, entityAliases(e)))
    );
    if (named.length) {
      for (const q of named) slots.push({ fact: f, question: q });
    } else slots.push({ fact: f, question: input.question });
  }
  const evidence: RecallEvidence[] = [];
  for (const slot of slots) {
    const f = slot.fact;
    let selected = selectEntities(
      { ...input, question: slot.question },
      c?.state.entities ?? [],
    );
    const selectedOnlyInactive = selected.length > 0 && selected.every(
      (entity) => !isCurrentEntity(entity),
    );
    if (
      f === "quantity" && selectedOnlyInactive &&
      !(asksRetainedQuantity(slot.question) && latestRetainedQuantity(m))
    ) {
      return fail(
        "AMBIGUOUS",
        "INACTIVE_ENTITY_NOT_CURRENT_QUANTITY",
        facts,
      );
    }
    if (f === "entity_status" && asksInactiveEntityStatus(slot.question)) {
      const inactive = selected.filter((entity) =>
        ["cancelled", "deferred"].includes(entity.status)
      );
      if (inactive.length) selected = inactive;
    } else {
      // Current-reference recall must classify ambiguity from current entities
      // only. An explicitly named or category-matched cancelled/deferred entity
      // remains historical evidence, but cannot compete with the authoritative
      // active aggregate and create a false current-reference ambiguity.
      selected = selected.filter(isCurrentEntity);
    }
    if (f === "historical_exclusion") {
      const amounts = (input.question.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(
        (v) => Number(v.replace(/,/g, "")),
      );
      const old = (c?.state.quotes ?? []).filter((q) =>
        (q.quote_type.includes("historical") ||
          ["historical", "expired", "superseded", "invalid"].includes(
            q.validity_status,
          )) && (!amounts.length || amounts.includes(q.amount))
      );
      const current = (c?.state.quotes ?? []).some((q) =>
        q.quote_type === "current_verified" &&
        q.validity_status === "current" &&
        (!amounts.length || amounts.includes(q.amount))
      );
      const retainedOld = (m?.historical_facts ?? []).filter((fact) => {
        const value = object(fact.value);
        const amount = typeof value?.amount === "number" ? value.amount : null;
        return fact.authority === "historical" && /quote/i.test(fact.key) &&
          (!amounts.length || (amount !== null && amounts.includes(amount)));
      });
      if ((!old.length && !retainedOld.length) || current) {
        return fail("AMBIGUOUS", "HISTORICAL_EXCLUSION_NOT_PROVEN", facts);
      }
      evidence.push({
        fact_type: f,
        state_path: "quotes.historical_excluded",
        value: {
          excluded_quote_ids: old.map((q) => q.quote_id),
          retained_historical_facts: retainedOld.map((fact) => fact.key),
          reusable_as_current: false,
        },
        authority: "CANONICAL_COMMERCE_STATE",
        entity_id: null,
        region: null,
        evidence_source_message_id: old.length === 1
          ? old[0].provenance.source_message_id ?? null
          : retainedOld.length === 1 ? retainedOld[0].source_message_id ?? null : null,
        temporal_scope: "excluded",
        source_kind: "canonical_quote_validity",
      });
      continue;
    }
    if (f === "summary") {
      if (!m) return fail("AMBIGUOUS", "MEMORY_UNAVAILABLE", facts);
      evidence.push({
        fact_type: f,
        state_path: "current_memory_projection",
        value: {
          goal: m.current_goal,
          entities: c
            ? c.state.entities.filter((e) =>
              !["cancelled", "deferred"].includes(e.status)
            ).map((e) => ({ entity_id: e.entity_id, quantity: e.quantity }))
            : m.active_entities.map((e) => ({
              entity_id: e.entity_id,
              quantity: e.quantity,
            })),
          transaction: c ? c.state.conversion : m.transaction_summary,
          preferences: m.customer_preferences,
          constraints: m.active_constraints,
          regions: m.current_regions,
          customer_facts: m.current_customer_facts,
        },
        authority: c ? "CANONICAL_COMMERCE_STATE" : "CURRENT_CUSTOMER_MEMORY",
        entity_id: null,
        region: null,
        evidence_source_message_id: null,
        temporal_scope: "current",
        source_kind: "bounded_structured_projection",
      });
      continue;
    }
    if (
      ["quantity", "horsepower", "brand_constraint", "room_size"].includes(f) &&
      c && c.state.entities.filter(isCurrentEntity).length > 1 &&
      selected.length !== 1 &&
      !any(input.question, ["all", "total", "全部", "合共", "總共", "分別", "分别", "兩間", "两间", "兩部", "两部"]) &&
      !(f === "quantity" && asksRetainedQuantity(slot.question))
    ) return fail("AMBIGUOUS", "ENTITY_REFERENCE_AMBIGUOUS", facts);
    if (
      f === "quantity" &&
      selected.some((e) => ["cancelled", "deferred"].includes(e.status)) &&
      !(asksRetainedQuantity(slot.question) && latestRetainedQuantity(m))
    ) return fail("AMBIGUOUS", "INACTIVE_ENTITY_NOT_CURRENT_QUANTITY", facts);
    if (
      f === "quantity" &&
      any(input.question, [
        "original",
        "initially",
        "一開始",
        "一开始",
        "最初",
      ]) &&
      (m?.latest_corrections.some((t) => hasField(t, "quantity")) ||
        m?.historical_facts.some((t) => keyMatches(t.key, "quantity")))
    ) return fail("AMBIGUOUS", "ORIGINAL_QUANTITY_SUPERSEDED", facts);
    if (
      any(input.question, [
        "old address",
        "old quantity",
        "舊地址",
        "旧地址",
        "舊數量",
        "旧数量",
      ]) && !any(input.question, ["current", "latest", "現在", "最新"])
    ) return fail("AMBIGUOUS", "HISTORICAL_VALUE_NOT_CURRENT", facts);
    const candidates = [
      ...canonicalCandidates(input, f, selected),
      ...memoryCandidates(input, f, selected),
    ].sort((a, b) => a.rank - b.rank);
    if (!candidates.length) {
      return fail("AMBIGUOUS", `MISSING_${f.toUpperCase()}`, facts);
    }
    const best = candidates.filter((x) => x.rank === candidates[0].rank);
    const resolvedCollection = f === "room_size"
      ? resolvedRoomSizeCollection(input, best)
      : null;
    if (resolvedCollection) {
      const fact: RecallEvidence = { ...resolvedCollection };
      delete (fact as Partial<Candidate>).rank;
      evidence.push(fact);
      continue;
    }
    const unique = new Map(
      best.map((x) => [`${x.entity_id ?? ""}|${JSON.stringify(x.value)}`, x]),
    );
    if (unique.size > 1) {
      return fail("AMBIGUOUS", `CONFLICTING_${f.toUpperCase()}`, facts);
    }
    const fact: RecallEvidence = { ...candidates[0] };
    delete (fact as Partial<Candidate>).rank;
    evidence.push(fact);
  }
  const authority: RecallAuthority =
    evidence.every((e) => e.authority === "CANONICAL_COMMERCE_STATE")
      ? "CANONICAL_COMMERCE_STATE"
      : "CURRENT_CUSTOMER_MEMORY";
  return {
    handled: true,
    authority,
    fact_type: facts.join("+"),
    state_path: evidence.map((e) => e.state_path).join("|"),
    value: evidence.length === 1 ? evidence[0].value : evidence.map((e) => ({
      fact_type: e.fact_type,
      entity_id: e.entity_id,
      value: e.value,
    })),
    provenance: {
      conversation_id: input.conversation_id,
      company_id: input.company_id,
      source_message_id: input.source_message_id,
      memory_revision: m?.memory_revision ?? null,
      commerce_state_revision: c?.revision ?? m?.commerce_state_revision ??
        null,
      commerce_source_message_id: c?.source_message_id ?? null,
      evidence,
    },
  };
}

const LABELS: Partial<Record<RecallFact, [string, string, string]>> = {
  quantity: ["數量", "数量", "Quantity"],
  address: ["收貨地址", "收货地址", "Delivery address"],
  recipient: ["收貨人", "收货人", "Recipient"],
  contact: ["聯絡電話", "联系电话", "Contact number"],
  room_size: ["你提供的房間面積", "你提供的房间面积", "Room size you provided"],
  horsepower: [
    "你提出的匹數需求",
    "你提出的匹数需求",
    "Your horsepower requirement",
  ],
  brand_constraint: ["品牌要求", "品牌要求", "Brand requirement"],
  delivery_preference: [
    "你提出的送貨偏好",
    "你提出的送货偏好",
    "Your delivery preference",
  ],
  quotation_status: ["報價階段", "报价阶段", "Quotation stage"],
  order_status: ["訂單階段", "订单阶段", "Order stage"],
  payment_status: ["付款記錄", "付款记录", "Payment record"],
  delivery_status: ["送貨記錄", "送货记录", "Delivery record"],
  installation_status: ["安裝記錄", "安装记录", "Installation record"],
  constraints: ["你提出的限制", "你提出的限制", "Your constraints"],
  preferences: ["你的偏好", "你的偏好", "Your preferences"],
  region: ["市場範圍", "市场范围", "Market scope"],
  goal: ["你的目標", "你的目标", "Your goal"],
  correction: ["最近更正記錄", "最近更正记录", "Latest correction record"],
  entity_status: ["項目記錄", "项目记录", "Item record"],
};
const STATUS_TEXT: Record<string, [string, string, string]> = {
  none: ["未建立", "未建立", "none recorded"],
  draft: ["草擬中", "草拟中", "draft"],
  pending_verification: ["待核實", "待核实", "pending verification"],
  verified: ["已核實", "已核实", "verified"],
  accepted: ["已接受", "已接受", "accepted"],
  expired: ["已過期", "已过期", "expired"],
  pending_confirmation: ["待確認", "待确认", "pending confirmation"],
  confirmed: ["已確認", "已确认", "confirmed"],
  cancelled: ["已取消", "已取消", "cancelled"],
  completed: ["完成", "完成", "completed"],
  pending_quote: [
    "等待金額核實",
    "等待金额核实",
    "awaiting amount verification",
  ],
  pending_payment: ["待付款", "待付款", "pending payment"],
  paid: ["已收款", "已收款", "paid"],
  failed: ["失敗", "失败", "failed"],
  refunded: ["已退款", "已退款", "refunded"],
  partially_refunded: ["部分退款", "部分退款", "partially refunded"],
  deferred: ["暫緩", "暂缓", "deferred"],
};
function display(v: unknown): string {
  if (typeof v === "string") {
    return [...v].map((char) => char.charCodeAt(0) < 32 ? " " : char).join("")
      .trim().slice(0, 1200);
  }
  if (Array.isArray(v)) return v.map(display).join("；");
  const o = object(v);
  if (o && usable(o.value)) {
    return `${display(o.value)}${
      typeof o.unit === "string" ? ` ${display(o.unit)}` : ""
    }`;
  }
  return o ? JSON.stringify(o) : String(v);
}
function displayRegions(value: unknown, languageIndex: number): string {
  if (!Array.isArray(value)) return display(value);
  const labels: Record<string, [string, string, string]> = {
    hong_kong: ["香港", "香港", "Hong Kong"],
    taiwan: ["台灣", "台湾", "Taiwan"],
    macau: ["澳門", "澳门", "Macau"],
    singapore: ["新加坡", "新加坡", "Singapore"],
  };
  return value.map((entry) => {
    const row = object(entry);
    const id = String(row?.region ?? "");
    const scope = String(row?.temporal_scope ?? "");
    const localizedScope = scope === "future"
      ? ["未來", "未来", "future"][languageIndex]
      : ["目前", "目前", "current"][languageIndex];
    return `${labels[id]?.[languageIndex] ?? id} (${localizedScope})`;
  }).join("；");
}
export function renderConversationRecall(
  decision: ConversationRecallDecision,
  language: string = "zh-TW",
): string | null {
  if (!decision.handled) return null;
  const l = language === "en" ? 2 : language === "zh-CN" ? 1 : 0;
  const lines: string[] = [];
  for (const e of decision.provenance.evidence) {
    if (e.fact_type === "historical_exclusion") {
      lines.push(
        [
          "舊金額只作歷史記錄，不列入這次交易金額。",
          "旧金额只作历史记录，不列入这次交易金额。",
          "The old amount is historical only and is not included in this transaction.",
        ][l],
      );
      continue;
    }
    if (e.fact_type === "summary") {
      const v = object(e.value)!;
      lines.push(
        "### Current Goal",
        display(v.goal ?? "—"),
        "### Active Entities",
        display(v.entities),
        "### Transaction State",
        display(v.transaction),
        "### Customer Preferences",
        display(v.preferences),
        "### Customer Constraints",
        display(v.constraints),
        "### Market Scope",
        displayRegions(v.regions, l),
        "### Customer Facts",
        display(v.customer_facts),
      );
      continue;
    }
    const retainedCorrectionQuantity = e.fact_type === "quantity" &&
      e.source_kind === "retained_customer_correction_checkpoint";
    const retainedNumberWords: Record<number, [string, string, string]> = {
      1: ["一", "一", "one"],
      2: ["兩", "两", "two"],
      3: ["三", "三", "three"],
      4: ["四", "四", "four"],
      5: ["五", "五", "five"],
      6: ["六", "六", "six"],
      7: ["七", "七", "seven"],
      8: ["八", "八", "eight"],
      9: ["九", "九", "nine"],
      10: ["十", "十", "ten"],
    };
    let v = retainedCorrectionQuantity && typeof e.value === "number" &&
        retainedNumberWords[e.value]
      ? retainedNumberWords[e.value][l]
      : display(e.value);
    if (e.fact_type.endsWith("_status") && typeof e.value === "string") {
      v = STATUS_TEXT[e.value]?.[l] ?? v;
    }
    if (e.fact_type === "brand_constraint" && typeof e.value === "boolean") {
      v = e.value
        ? ["品牌是必要條件", "品牌是必要条件", "a brand is required"][l]
        : [
          "品牌並非必要條件",
          "品牌并非必要条件",
          "a brand is not mandatory",
        ][l];
    }
    if (e.fact_type === "delivery_status" && typeof e.value === "boolean") {
      v = e.value
        ? ["已確認", "已确认", "confirmed"][l]
        : ["尚未確認", "尚未确认", "not confirmed"][l];
    }
    lines.push(
      `${
        retainedCorrectionQuantity
          ? ["實際保留", "实际保留", "Actually retained"][l]
          : LABELS[e.fact_type]?.[l] ?? e.fact_type
      }${
        e.entity_id ? ` (${e.entity_label ?? e.entity_id})` : ""
      }: ${v}${e.fact_type === "quantity" ? l === 2 ? " units" : " 部" : ""}`,
    );
    if (e.fact_type === "delivery_preference") {
      lines.push(
        [
          "這是偏好記錄，不代表配送排期已落實。",
          "这是偏好记录，不代表配送排期已落实。",
          "This records a preference, not a committed delivery schedule.",
        ][l],
      );
    }
  }
  // Avoid asserting an order merely because a quotation exists.
  const order = decision.provenance.evidence.find((e) =>
    e.fact_type === "order_status"
  );
  if (
    order &&
    ["none", "draft", "pending_confirmation"].includes(String(order.value))
  ) {
    lines.push(
      [
        "尚未形成正式訂單。",
        "尚未形成正式订单。",
        "This is not a confirmed purchase order.",
      ][l],
    );
  }
  return lines.join("\n").slice(0, 4096);
}
export function recallClarification(language = "zh-TW"): string {
  return language === "en"
    ? "Please specify the item or point in time to check; I will not substitute an old or inferred value."
    : language === "zh-CN"
    ? "请指明要核对的项目或时间点；我不会把旧记录或推测当作答案。"
    : "請指明要核對的項目或時間點；我不會把舊記錄或推測當作答案。";
}

/** Shared route preparation. Persistence stays exclusively with the caller's B2 gate. */
export function prepareConversationRecall(
  input: ConversationRecallInput,
  language = "zh-TW",
) {
  const decision = resolveConversationRecall(input);
  const reply = decision.handled
    ? renderConversationRecall(decision, language)
    : decision.reason === "AMBIGUOUS"
    ? recallClarification(language)
    : null;
  const metadata: Record<string, unknown> = {
    response_route: decision.handled
      ? "canonical_memory_recall"
      : "canonical_memory_clarification",
    factual_grounding_required: false,
    conversation_grounded: decision.handled,
    handoff_required: false,
    commerce_state_revision: input.commerce?.revision ?? null,
    conversation_memory_revision: input.memory?.memory_revision ?? null,
    recall_authority: decision.handled ? decision.authority : null,
    recall_fact_type: decision.handled ? decision.fact_type : null,
    recall_reason: decision.handled ? null : decision.detail,
    // Persist lineage, not another copy of addresses / phone numbers in metadata.
    recall_provenance: decision.handled
      ? decision.provenance.evidence.map((e) => ({
        fact_type: e.fact_type,
        state_path: e.state_path,
        authority: e.authority,
        source_message_id: e.evidence_source_message_id,
        entity_id: e.entity_id,
        region: e.region,
        temporal_scope: e.temporal_scope,
        source_kind: e.source_kind,
      }))
      : [],
  };
  return { decision, reply, metadata };
}
