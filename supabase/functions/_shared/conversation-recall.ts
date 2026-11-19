import { customerRequestedQuantity } from "./customer-journey-orchestration.ts";
/** C3: deterministic, read-only fact ownership routing. No KB, model or state writes. */
import type {
  CommerceEntity,
  ConversationCommerceState,
} from "./commerce-state-contract.ts";
import { splitCustomerOperationClauses, hasRequirementsRecapCue, isCurrentRequirementsRecap, isReadOnlyMemoryOrCurrentStateRecall, withoutExcludedLookups } from "./commerce-state-authority.ts";
import type { CanonicalConversationMemory } from "./conversation-long-memory.ts";
import { industryEntityLabel, industryEntityQuantityUnit } from "./industry-runtime-adapter.ts";
import { renderEnglishRequirement } from "./commerce-capability-runtime.ts";
import { classifyCanonicalConversationTurn } from "./conversation-semantic-contract.ts";

export type RecallFact =
  | "quantity"
  | "budget"
  | "date"
  | "time"
  | "name"
  | "size"
  | "customer_fact"
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
  | "CURRENT_CUSTOMER_MEMORY"
  | "HISTORICAL_CUSTOMER_MEMORY";
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
  temporal_scope: "current" | "excluded" | "historical";
  source_kind: string;
  /** Customer field label only; never a merchant or transaction authority. */
  attribute_key?: string;
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
  /** Server-read, unrecalled Visitor messages from this same authorized conversation.
   * Required order: newest first, using created_at DESC then id DESC.
   * Source text is proof to compare with current customer Memory, not a new value authority.
   * Never accept rows supplied by a widget, model output or client metadata. */
  trusted_visitor_source_rows?: ReadonlyArray<{ id: string; content: string }>;
  /** Existing accepted understanding result, bound to this server-owned turn.
   * Selects a recall field only; fact values still require Visitor-source proof. */
  customer_recall_proposal?: RecallScope & {
    intent: "customer_fact_recall";
    requested_facts: readonly string[];
    subject_refs: readonly string[];
  };
  explicit_handoff?: boolean;
  /** True only after both scoped DB reads succeed and return no row. */
  empty_state_verified?: boolean;
  /** Private server-derived DB lineage only; never customer/request metadata or transcript facts. */
  trusted_persisted_memory_readback?: TrustedPersistedMemoryReadback | null;
}

export interface TrustedPersistedMemoryReadback {
  contract: "persisted-memory-readback-v1";
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  memory_revision: number;
  commerce_state_revision: number;
  memory_hash: string;
}

function hasTrustedPersistedMemoryReadback(input: ConversationRecallInput): boolean {
  const p = input.trusted_persisted_memory_readback, m = input.memory, c = input.commerce;
  return Boolean(p && m && c && p.contract === "persisted-memory-readback-v1" &&
    p.conversation_id === input.conversation_id && p.company_id === input.company_id &&
    m.conversation_id === input.conversation_id && m.company_id === input.company_id &&
    c.conversation_id === input.conversation_id && c.company_id === input.company_id &&
    typeof m.source_message_id === "string" && m.source_message_id.trim().length > 0 &&
    p.source_message_id === m.source_message_id &&
    Number.isInteger(p.memory_revision) && p.memory_revision > 0 &&
    p.memory_revision === m.memory_revision &&
    Number.isInteger(p.commerce_state_revision) && p.commerce_state_revision >= 0 &&
    p.commerce_state_revision === m.commerce_state_revision &&
    m.commerce_state_revision === c.revision &&
    typeof p.memory_hash === "string" && /^[a-f0-9]{64}$/i.test(p.memory_hash));
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
    "幾多件", "几多件", "幾多份", "几多份",
    "幾多堂", "几多堂", "幾多課", "几多课",
    "幾多套", "几多套", "幾多盒", "几多盒",
    "幾堂", "几堂", "幾課", "几课", "幾份", "几份",
  ],
  address: ["address", "地址", "邊座", "哪座", "邊度收貨", "哪里收货", "收貨資料", "收货资料", "delivery details"],
  recipient: ["recipient", "收貨人", "收货人", "收件人", "誰收", "誰人收", "收貨資料", "收货资料", "delivery details"],
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
    "收貨資料",
    "收货资料",
    "delivery details",
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
    "而家要求",
    "現在要求",
    "要求係點",
    "要求是什麼",
    "需求係點",
    "需求是什么",
    "current requirements",
    "what are my requirements",
    "recap my requirements",
    "requirements recap",
    "recap",
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
  retainedTargets: string[] = [],
  completedCompoundRecap = false,
): { facts: RecallFact[]; stop?: ConversationRecallDecision } {
  if (!q.trim() || q.length > 2400) {
    return {
      facts: [],
      stop: fail("NOT_A_RECALL_QUERY", "EMPTY_OR_OVERSIZED_INPUT"),
    };
  }
  const owner = any(q, OWNER), question = /[?？]|呢$/.test(q) || any(q, ASK);
  const summary = completedCompoundRecap || isCurrentRequirementsRecap(q, retainedTargets);
  // A rejected recap-containing turn cannot be partially answered as another
  // recalled slot while silently dropping the rest of the customer request.
  if (!summary && (hasField(q, "summary") || hasRequirementsRecapCue(q))) {
    const identifier = q.match(/^(?:please )?recap ([a-z][a-z0-9]*-[a-z0-9-]+)[.!?]?$/i)?.[1];
    if (identifier && isCurrentRequirementsRecap(q, [identifier]))
      return { facts: [], stop: fail("AMBIGUOUS", "ENTITY_REFERENCE_AMBIGUOUS", ["summary"]) };
    return { facts: [], stop: fail("NOT_A_RECALL_QUERY", "RECAP_WHOLE_TURN_NOT_PROVEN") };
  }
  let facts = (Object.keys(FIELDS) as RecallFact[]).filter((f) =>
    f !== "summary" && hasField(q, f)
  );
  if (summary) facts = ["summary"];
  // Domain-neutral quantity slots across commerce and service industries.
  // This identifies a fact type, never a customer source or its value;
  // ownership, external-fact and same-ticket provenance remain mandatory.
  if (!facts.length && owner && question &&
      /(?:幾多|几多|多少|幾|几|how many)\s*(?:部|台|件|套|份|盒|箱|堂|課|课|位|張|张|units?|items?|pieces?|sets?|boxes?|sessions?|lessons?|licenses?|licences?|seats?|nights?)/iu.test(q)) facts = ["quantity"];
  if (!facts.length && /[?？][\s\S]+[?？]/u.test(q)) {
    return { facts: [], stop: fail("NOT_A_RECALL_QUERY", "MULTIPLE_UNRESOLVED_QUESTIONS") };
  }
  if (!facts.length && isReadOnlyMemoryOrCurrentStateRecall(q)) {
    facts = [
      /(?:狀態|状态|status|係咪取消|是否取消|仲要|仍然要|still active|cancelled|canceled)/i.test(q)
        ? "entity_status"
        : "quantity",
    ];
  }
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
  const external = any(withoutExcludedLookups(q), EXTERNAL);
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
    e.category.replace(/_/g, " "),
    ...(["en", "zh-TW", "zh-CN"] as const).map(language => industryEntityLabel(e.entity_id, language)),
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
/** Existing entity/referent vocabulary, shared by recap consumers. */
export function retainedRecapTargets(state: ConversationCommerceState): string[] {
  return state.entities.flatMap(entityAliases);
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

/** Current-turn scope is authoritative; fallback focus never turns a global recap into a scoped one. */
function summarySelection(input: ConversationRecallInput, entities: CommerceEntity[]): {
  provenance: "explicit_identity" | "explicit_category" | "trusted_referent" | "global";
  entities: CommerceEntity[];
} {
  const identity = entities.filter(e => any(input.question, [e.entity_id, e.model,
    ...["product_name", "display_name", "original_name", "sku"].map(k => e.attributes[k])]
    .filter((v): v is string => typeof v === "string" && v.length > 0)));
  if (identity.length) return { provenance: "explicit_identity", entities: identity };
  // An explicitly named but unknown identifier cannot fall back to a portfolio recap.
  // This is identifier syntax, independent of category, tenant and fixture values.
  const identifiers = input.question.match(/\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gi) ?? [];
  if (identifiers.length) return { provenance: "explicit_identity", entities: [] };
  const explicit = entities.filter(e => any(input.question, entityAliases(e)));
  if (explicit.length) {
    // A canonical aggregate owns its category; subordinate room projections are not competing purchase goals.
    const categories = new Set(explicit.filter(e => e.entity_id.endsWith(":unscoped")).map(e => e.category));
    return { provenance: "explicit_category", entities: explicit.filter(e => e.entity_id.endsWith(":unscoped") || !categories.has(e.category)) };
  }
  if (/(?:\bit\b|\bthat\b|\bthis\b|嗰|呢|這|这)/iu.test(input.question)) {
    const hinted = entities.filter(e => (input.referents ?? []).some(r =>
      r.confidence >= 0.85 && !!r.source && r.source !== "unknown" &&
      entityAliases(e).some(a => keyNorm(a) === keyNorm(r.ref))));
    if (hinted.length) return { provenance: "trusted_referent", entities: hinted };
  }
  return { provenance: "global", entities };
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

/** Scalar customer-owned fields. These map concepts/keys, not industries or
 * accepted customer sentences. Unknown fields can be selected by the existing
 * semantic requested_facts only when the same key exists in current Memory. */
const CUSTOMER_RECALL_FIELDS: Array<{fact: RecallFact; keys: string[]; words: string[]}> = [
  {fact:"budget",keys:["budget","budget_amount","maximum_budget","max_budget"],words:["budget","預算","预算"]},
  {fact:"date",keys:["date","preferred_date","requested_date","appointment_date","delivery_date"],words:["date","日期","哪天","邊日","哪一天"]},
  {fact:"time",keys:["time","preferred_time","requested_time","appointment_time","preferred_window"],words:["time","時間","时间","幾點","几点","時段","时段"]},
  {fact:"name",keys:["name","customer_name","preferred_name"],words:["name","姓名","稱呼","称呼","call me"]},
  {fact:"size",keys:["size","requested_size","preferred_size"],words:["size","尺寸","大小"]},
  {fact:"preferences",keys:["preference","preferences","customer_preference","preferred_environment"],words:["preference","preferences","prefer","偏好","喜好"]},
  {fact:"quantity",keys:["quantity","requested_quantity","item_quantity","count"],words:["quantity","count","how many","數量","数量"]},
];
const UNSAFE_CUSTOMER_RECALL_KEY = /(?:price|cost|stock|inventory|policy|entitlement|refund|status|payment|order|booking_state|confirmed|availability|現價|售价|售價|庫存|库存|退款|權益|权益)/iu;
function sourceClauses(text: string): string[] {
  return text.normalize("NFKC").split(/(?<!\d)[,，]|[,，](?!\d)|[;；。!?！？\n]+|\.(?!\d)/u).map(x=>x.trim()).filter(Boolean);
}
function literalNumber(token: string): number | null {
  if (/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(token)) return Number(token.replace(/,/g,""));
  const digits:Record<string,number>={"零":0,"〇":0,"一":1,"二":2,"兩":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9};
  const scales:Record<string,number>={"十":10,"百":100,"千":1000,"萬":10000,"万":10000};
  let value=0,part=0,current=0;
  for(const ch of token){
    if(ch in digits){current=digits[ch];continue;}
    const scale=scales[ch];if(!scale)return null;
    if(scale===10000){value+=(part+current)*scale;part=0;current=0;}
    else{part+=(current||1)*scale;current=0;}
  }
  return value+part+current;
}
function numberTokens(text:string):Array<{value:number;start:number;end:number}> {
  return [...text.matchAll(/(?<![\dA-Za-z_])(?:\d+(?:,\d{3})*(?:\.\d+)?|[零〇一二兩两三四五六七八九十百千萬万]+)(?![\dA-Za-z_])/gu)]
    .map(m=>({value:literalNumber(m[0]),start:m.index!,end:m.index!+m[0].length}))
    .filter((m):m is {value:number;start:number;end:number}=>m.value!==null&&Number.isFinite(m.value));
}
function quantitySubject(question:string):string|null {
  const english=question.match(/\bhow\s+many\s+(.{1,70}?)(?=\s+(?:did|do|have|was|were|are|is|would|will|i|we|you|the|there)\b|[?!.,]|$)/iu)?.[1]?.trim();
  const chinese=question.match(/(?:幾多|几多|多少|幾|几)\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{0,24})(?=[?？。，,；;！!]|$)/u)?.[1]?.trim();
  return english||chinese||null;
}
function scalarInSource(value:unknown,clause:string):boolean {
  if(typeof value==="number")return numberTokens(clause).some(n=>n.value===value);
  return typeof value==="string" && value.trim().length>0 && value.length<=300 && phrase(clause,value);
}
type CustomerRecallField = typeof CUSTOMER_RECALL_FIELDS[number];
/** Clause speech acts are checked independently: a recall question cannot erase
 * a later imperative. Reuse the canonical classifier for corrections/updates;
 * the remaining vocabulary names transaction/lifecycle actions, not fixtures. */
function customerRecallHasAction(text: string): boolean {
  const action = /\b(?:buy|purchase|book|reserve|schedule|order|subscribe|renew|upgrade|downgrade|pay|checkout|cancel|remove|delete|defer|pause|postpone|reschedule|change|replace|update|add|set)\b|購買|购买|買|买|預約|预约|訂購|订购|下單|下单|落單|落单|續訂|续订|續約|续约|付款|支付|取消|刪除|删除|移除|暫緩|暂缓|暫停|暂停|改期|更正|改做|改成|改為|改为|新增|加多|再加/iu;
  const historical = /^(?:what|which|how many|how much|when|where|did|had|have)\b.{0,70}\b(?:i|we)\b|^(?:我|我們|我们).{0,12}(?:之前|頭先|头先|剛才|刚才|啱啱|曾經|曾经).{0,65}(?:幾|几|多少|邊|哪|甚麼|什麼|什么|咩|有冇|是否)|^(?:remind me|do you remember)\b/iu;
  const imperative = /^(?:(?:and|also|then|please|kindly)\s+)*(?:(?:can|could|would|will)\s+you\s+|(?:i|we)\s+(?:want|need|would like)\s+(?:you\s+)?to\s+)?(?:buy|purchase|book|reserve|schedule|order|subscribe|renew|upgrade|downgrade|pay|checkout|cancel|remove|delete|defer|pause|postpone|reschedule|change|replace|update|add|set)\b|(?:幫我|帮我|替我|請|请|麻煩|麻烦|同埋|並且|并且|我要|我想|我需要).{0,16}(?:book\b|order\b|buy\b|cancel\b|購買|购买|買|买|預約|预约|訂|订|下單|下单|落單|落单|續|续|付款|支付|取消|刪除|删除|移除|暫緩|暂缓|暫停|暂停|改期|更正|改做|改成|改為|改为|新增|加多|再加)|^(?:先|而家|現在|现在)?(?:取消|暫緩|暂缓|暫停|暂停|改期|更正|改做|改成|改為|改为|新增|加多|再加)/iu;
  // Conjunctions before actions delimit speech acts without splitting noun lists.
  const separated = text.replace(/\b(?:and|also|then)\s+(?=(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:buy|purchase|book|reserve|schedule|order|subscribe|renew|upgrade|downgrade|pay|checkout|cancel|remove|delete|defer|pause|postpone|reschedule|change|replace|update|add|set)\b)/giu, "; ")
    .replace(/(?:同埋|並且|并且)(?=(?:幫我|帮我|請|请|預約|预约|訂|订|取消|更正|改|暫|暂|加))/gu, "；");
  return splitCustomerOperationClauses(separated).some(clause => {
    const speech = classifyCanonicalConversationTurn(clause, []);
    if (["CORRECTION", "CUSTOMER_CONTEXT_UPDATE"].includes(speech.operation)) return true;
    // Passive lifecycle labels describe a retained state, not a new command.
    const actionClause = clause.replace(/(?:被|已(?:經|经)?)\s*(?:取消|暫緩|暂缓|暫停|暂停)/gu, "retained status");
    if (!action.test(actionClause)) return false;
    if (imperative.test(clause)) return true;
    // A historical action in a pure question remains a read. Unclear action
    // clauses fail closed here; this function never authorizes a transaction.
    return !historical.test(clause) && !/[?？]/u.test(clause) &&
      !/^(?:i|we)\s+(?:already|previously|earlier|had|have|did)\b|^(?:我|我們|我们).{0,8}(?:之前|頭先|头先|剛才|刚才|已經|已经|曾經|曾经)/iu.test(clause);
  });
}
function scalarSourceSpans(value: unknown, text: string): Array<{start: number; end: number}> {
  if (typeof value === "number") return numberTokens(text).filter(token => token.value === value);
  if (typeof value !== "string" || !value.trim() || value.length > 300) return [];
  const source = text.normalize("NFKC").toLowerCase(), needle = value.normalize("NFKC").toLowerCase();
  const found: Array<{start: number; end: number}> = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) {
    if (/^[a-z0-9]/iu.test(needle) && /[a-z0-9]/iu.test(source[at - 1] ?? "")) continue;
    if (/[a-z0-9]$/iu.test(needle) && /[a-z0-9]/iu.test(source[at + needle.length] ?? "")) continue;
    found.push({start: at, end: at + needle.length});
  }
  return found;
}
/** A field label and value must share an assignment, not merely a sentence.
 * This verifies the existing Memory value; it never extracts a replacement. */
function scalarFieldSourceBound(field: CustomerRecallField, value: unknown, clause: string): boolean {
  const text = clause.normalize("NFKC");
  const labels = [...new Set([...field.words, ...field.keys.map(k => k.replace(/_/g, " "))])];
  if (field.fact === "name") labels.push("call me", "我叫", "叫我", "稱呼我", "称呼我");
  const assignment = /^\s*(?:(?:is|was|are|be|of|at|to|now|currently|exactly|about|around|approximately|maximum|max|up to|no more than|should be|will be)\b\s*|[:=]|係|是|為|为|要|有|改為|改为|改做|改成|大約|大约|約|约|最多|上限|\s)*(?:(?:HK\$|HKD|USD|TWD|NTD|CNY|[$€£¥]|港幣|港币|台幣|台币)\s*)?$/iu;
  return scalarSourceSpans(value, text).some(span => {
    const prefix = text.slice(0, span.start), suffix = text.slice(span.end);
    if (/(?:\b(?:but|instead|actually|correction|change|now)\b|但係|但是|但|不過|不过|改為|改为|改成|改做|而家|現在|现在).{0,60}(?:\d|[一二兩两三四五六七八九十]|budget|date|time|name|size|預算|预算|日期|時間|时间|姓名|尺寸)/iu.test(suffix)) return false;
    for (const label of labels) {
      for (const anchor of scalarSourceSpans(label, prefix)) {
        if (!assignment.test(prefix.slice(anchor.end))) continue;
        const owner = prefix.slice(0, anchor.start).trim();
        // Every general scalar requires the customer's own field assignment.
        // Name/date/time retain their stricter ownership rules below.
        if (!["name", "date", "time"].includes(field.fact) &&
            !/^(?:(?:my|our)(?:\s+|$))?(?:(?:current|total|monthly|annual|yearly|maximum|max|preferred|requested|desired)(?:\s+|$))*$|^(?:i|we)(?:\s+(?:have|need|want|prefer|request|specified)(?:\s+(?:a|the))?)?$|^(?:(?:我|我們|我们)(?:嘅|的)?(?:希望|要求|想要|要|有)?)?(?:目前|最新|總|总|每月|每年|最大|首選|首选|偏好)*$/iu.test(owner)) continue;
        if (field.fact === "name" && /^(?:call me|我叫|叫我|稱呼我|称呼我)$/iu.test(label) &&
            !/^(?:please|kindly|請|请|麻煩|麻烦)?$/iu.test(owner)) continue;
        if (field.fact === "name" && !/^(?:call me|我叫|叫我|稱呼我|称呼我)$/iu.test(label) &&
            !/^(?:my|our)(?:\s+(?:preferred|customer))?$|^(?:我|我們|我们)(?:嘅|的)?(?:首選|首选)?$/iu.test(owner) &&
            !(owner === "" && /^\s*[:=]/u.test(prefix.slice(anchor.end)))) continue;
        if (["date", "time"].includes(field.fact) &&
            !/^(?:(?:my|our)(?:\s+|$))?(?:(?:preferred|requested|appointment|delivery|booking)(?:\s+|$))*$|^(?:我|我們|我们)(?:嘅|的)?(?:首選|首选|希望|要求|預約|预约)?$/iu.test(owner)) continue;
        return true;
      }
    }
    // A requested scheduling value is customer-owned; an expiry/end date is not.
    if (["date", "time"].includes(field.fact) &&
        /^(?:(?:please\s+)?(?:book|schedule|reserve)\s+(?:me\s+)?(?:for|on|at)?\s*|(?:i|we)\s+(?:prefer|request|would like|want|need)\s+(?:(?:to\s+)?(?:book|schedule|reserve)\s+)?(?:for|on|at)?\s*|(?:我|我們|我们)(?:想|要|希望|需要|要求|偏好)(?:預約|预约|安排|訂|订)?(?:喺|在|於|于)?\s*)$/iu.test(prefix.trim())) return true;
    return false;
  });
}
/** Raw subject slots supplement entity/referent selection when the model omits
 * a named subject. A missing/unknown subject cannot silently become old focus. */
function explicitRecallSubjects(question: string, field: CustomerRecallField): string[] {
  const refs: string[] = [];
  const add = (ref: string | undefined) => {
    const v = ref?.trim().replace(/^(?:the|my|our)\s+/iu, "");
    if (v && v.length <= 160 && !/^(?:me|us|myself|ourselves|just now|now|earlier|before|previously|today|yesterday|我|我們|我们)$/iu.test(v) &&
        !/^(?:我|我們|我们)(?:(?:之前|頭先|头先|剛才|刚才|啱啱|目前|而家|現在|现在|最後|最后|先前|早前)?(?:講|讲|說|说|提|提過|提过|提供|要求|需要|要|講過|讲过|記錄|记录))$/u.test(v)) refs.push(v);
  };
  add(question.match(/\b(?:for|about|regarding)\s+([^?？.!。;,，；]{1,100}?)(?=\s*(?:[?？.!。;,，；]|$))/iu)?.[1]);
  for (const label of field.words) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    add(question.match(new RegExp("\\b" + escaped + "\\s+(?:of|for)\\s+(.{1,80}?)(?=\\s+(?:did|do|have|was|were|are|is|would|will|i|we|you)\\b|[?!.,;]|$)", "iu"))?.[1]);
    if (/[\p{Script=Han}]/u.test(label)) add(question.match(new RegExp("([^?？。;,，；]{1,50}?)(?:的|嘅)" + escaped, "u"))?.[1]?.replace(/^(?:請|请|提醒我|我之前講|我之前讲|我剛才講|我刚才讲)/u, ""));
  }
  if (field.fact === "quantity") add(quantitySubject(question) ?? undefined);
  return [...new Set(refs)];
}
function laterCustomerSourceConflicts(input: ConversationRecallInput, sourceId: string, field: CustomerRecallField,
  subjects: string[], entity: CommerceEntity | null, applicableClause: string, remainingClauses: string[]): boolean {
  const rows = input.trusted_visitor_source_rows!;
  const sourceIndex = rows.findIndex(row => row.id === sourceId);
  // Caller supplies authenticated server rows in created_at/id DESC order.
  // Later messages only veto stale evidence; none may supply an answer value.
  const later = [...remainingClauses, ...rows.slice(0, sourceIndex).map(row => row.content)];
  const currentAliases = entity ? entityAliases(entity) : subjects;
  const otherEntities = input.commerce?.state.entities.filter(e => e.entity_id !== entity?.entity_id) ?? [];
  const sourceUnits = field.fact === "quantity" ? numberTokens(applicableClause).flatMap(token => {
    const unit = applicableClause.slice(token.end).trim().match(/^[\p{Script=Han}]|^[a-z]+\b/iu)?.[0];
    return unit ? [unit] : [];
  }) : [];
  return later.some(text => sourceClauses(text).some(clause => {
    if (!clause.trim() || /[?？]/u.test(clause)) return false;
    const mentionsCandidate = currentAliases.some(ref => phrase(clause, ref));
    const mentionsOther = otherEntities.some(e => entityAliases(e).some(ref => phrase(clause, ref)));
    if (mentionsOther && !mentionsCandidate) return false;
    const fieldMention = any(clause, [...field.words, ...field.keys.map(k => k.replace(/_/g, " "))]);
    const otherField = CUSTOMER_RECALL_FIELDS.some(f => f.fact !== field.fact && any(clause, f.words));
    const correction = classifyCanonicalConversationTurn(clause, []).operation === "CORRECTION" ||
      /\b(?:actually|instead|correction|change|cancel|remove|delete|defer|pause|postpone|no longer)\b|更正|改做|改成|改為|改为|改返|取消|刪除|删除|移除|暫緩|暂缓|暫停|暂停|唔要|不要/iu.test(clause);
    if (fieldMention) return true;
    if (otherField && !mentionsCandidate) return false;
    if (field.fact === "quantity" && numberTokens(clause).length &&
        (mentionsCandidate || sourceUnits.some(unit => phrase(clause, unit)))) return true;
    // Unresolved corrections/cancellations cannot certify an older value.
    return correction && (mentionsCandidate || !mentionsOther);
  }));
}

/** Keep effective quantities on the existing canonical/lifecycle proof path.
 * The parser owns the fact and read-only scope; temporal words distinguish the
 * present retained state from the customer's earlier quoted statement. */
export function isCurrentEffectiveQuantityRecall(question: string): boolean {
  const parsed = parseQuery(question);
  if (parsed.stop || !parsed.facts.includes("quantity") ||
      !isReadOnlyMemoryOrCurrentStateRecall(question) || customerRecallHasAction(question)) return false;
  return asksRetainedQuantity(question) ||
    /(?:目前|現在|现在|而家|現時|现时|實際|实际|最新|更正後|更正后|取消後|取消后)|\b(?:current|currently|now|actual|latest|remaining)\b/iu
      .test(question.replace(/\bjust\s+now\b/giu, ""));
}

/** The semantic label opens this read route, but never supplies a value/source.
 * Keep transactions, merchant claims and mixed requests on their original path. */
function resolveSemanticCustomerRecall(input:ConversationRecallInput):ConversationRecallDecision|null {
  const proposal=input.customer_recall_proposal;
  if(!proposal||proposal.intent!=="customer_fact_recall")return null;
  if(proposal.company_id!==input.company_id || proposal.conversation_id!==input.conversation_id ||
     proposal.source_message_id!==input.source_message_id || !input.company_id || !input.conversation_id || !input.source_message_id)
    return fail("AMBIGUOUS","CUSTOMER_RECALL_PROPOSAL_SCOPE_MISMATCH");
  const q=withoutExcludedLookups(input.question);
  if(customerRecallHasAction(input.question)||any(q,EXTERNAL)|| /(?:幾錢|几钱|多少錢|多少钱|how much does|can you book|place (?:an? )?order|幫我(?:預約|下單)|帮我(?:预约|下单))/iu.test(q)||
     proposal.requested_facts.some(k=>UNSAFE_CUSTOMER_RECALL_KEY.test(k)))return fail("CURRENT_KB_REQUIRED","EXTERNAL_OR_MIXED_FACT");
  // A semantic recall label cannot replace effective state with a quote.
  // The original resolver keeps canonical conflict and lifecycle checks.
  if(isCurrentEffectiveQuantityRecall(input.question))return null;
  const m=input.memory,c=input.commerce,rows=input.trusted_visitor_source_rows;
  if(!m||m.version!=="conversation-memory-1.0.0"||m.company_id!==input.company_id||m.conversation_id!==input.conversation_id||
     m.source_message_id!==input.source_message_id||!Number.isInteger(m.memory_revision)||m.memory_revision<1)
    return fail("AMBIGUOUS","MEMORY_SCOPE_OR_SOURCE_MISMATCH");
  if(!c) return fail("AMBIGUOUS","MISSING_COMMERCE_REVISION");
  if(c&&(c.company_id!==input.company_id||c.conversation_id!==input.conversation_id||
     c.state.version!=="commerce-state-1.0.0"||!Number.isInteger(c.revision)||c.revision<0||m.commerce_state_revision!==c.revision))
    return fail("AMBIGUOUS","STALE_COMMERCE_MEMORY_REVISION");
  if(!rows?.length||rows.length>500)return fail("AMBIGUOUS","CUSTOMER_SOURCE_NOT_AVAILABLE");
  const requested=proposal.requested_facts.map(keyNorm);
  let fields=CUSTOMER_RECALL_FIELDS.filter(field=>requested.length
    ? field.keys.some(key=>requested.includes(keyNorm(key)))
    : any(q,field.words));
  if(!requested.length&&!fields.length&&/(?:幾多|几多|多少|幾|几|how many)/iu.test(q))
    fields=CUSTOMER_RECALL_FIELDS.filter(f=>f.fact==="quantity");
  // Existing typed Memory keys may name other scalar customer attributes.
  // A model-proposed field can select an existing key, never create one.
  for(const key of proposal.requested_facts){
    if(!UNSAFE_CUSTOMER_RECALL_KEY.test(key)&&!fields.some(f=>f.keys.some(k=>keyNorm(k)===keyNorm(key)))&&
       m.current_customer_facts.some(f=>f.authority==="customer"&&keyNorm(f.key)===keyNorm(key)))
      fields.push({fact:"customer_fact",keys:[key],words:[key]});
  }
  if(fields.length!==1)return fail("AMBIGUOUS","CUSTOMER_RECALL_FIELD_AMBIGUOUS");
  const field=fields[0],evidence:RecallEvidence[]=[];
  const named=[...new Set([...proposal.subject_refs.filter(ref=>ref.length>0&&ref.length<=160&&phrase(q,ref)), ...explicitRecallSubjects(q,field)])];
  const activeEntities=c?.state.entities.filter(isCurrentEntity)??[];
  const selection=summarySelection(input,activeEntities);
  for(let i=0;i<m.current_customer_facts.length;i++){
    const fact=m.current_customer_facts[i];
    if(fact.authority!=="customer"||!field.keys.some(k=>keyNorm(k)===keyNorm(fact.key))||
       UNSAFE_CUSTOMER_RECALL_KEY.test(fact.key)||!fact.source_message_id||fact.source_message_id===input.source_message_id||
       !["string","number"].includes(typeof fact.value))continue;
    if(m.cancelled_or_superseded.some(old=>old.authority==="customer" &&
      field.keys.some(k=>keyNorm(k)===keyNorm(old.key.replace(/^(?:superseded|cancelled)_/u,""))) &&
      old.value===fact.value && (old.source_message_id===fact.source_message_id ||
        (!old.source_message_id && old.entity_id===fact.entity_id))))continue;
    const matching=rows.filter(row=>row.id===fact.source_message_id&&typeof row.content==="string"&&row.content.length>0&&row.content.length<=2400);
    if(matching.length!==1)continue;
    const source=matching[0].content.normalize("NFKC");
    const clauses=sourceClauses(source);
    const entity=fact.entity_id?activeEntities.find(e=>e.entity_id===fact.entity_id):null;
    if(fact.entity_id&&!entity)continue;
    if(selection.provenance!=="global" && (selection.entities.length!==1 ||
      entity && selection.entities[0].entity_id!==entity.entity_id))continue;
    if(entity && selection.provenance==="global" && activeEntities.length>1 && !named.length)continue;
    const subjects=named.length?named:entity?entityAliases(entity):[];
    const matchesSubject=(clause:string,ref:string)=>phrase(clause,ref) || Boolean(entity &&
      entityAliases(entity).some(alias=>keyNorm(alias)===keyNorm(ref)) && entityAliases(entity).some(alias=>phrase(clause,alias)));
    const scopedSubject=(clause:string)=>named.length?named.every(ref=>matchesSubject(clause,ref)):
      !subjects.length||subjects.some(ref=>matchesSubject(clause,ref));
    const applicable=clauses.filter(clause=>{
      if(!scalarInSource(fact.value,clause))return false;
      if(field.fact==="quantity"){
        if(typeof fact.value!=="number"||!Number.isInteger(fact.value)||fact.value<0||fact.value>1000)return false;
        // Exclude another field's number in this clause (budget, size, date,
        // time, phone), even when it happens to equal the stored quantity.
        if(CUSTOMER_RECALL_FIELDS.some(f=>f.fact!=="quantity"&&any(clause,f.words))||any(clause,["phone","電話","电话","匹","sqft"]))return false;
        const total=/(?:合共|總共|总共|共計|共计|一共|總數|总数|in total|altogether|total(?: of)?)/iu.test(clause);
        const numbers=numberTokens(clause);
        if(new Set(numbers.map(n=>n.value)).size!==1)return false;
        const valueToken=numbers.find(n=>n.value===fact.value)!;
        const after=clause.slice(valueToken.end).trim();
        const before=clause.slice(0,valueToken.start);
        if(/(?:[$€£¥]|HKD|USD|TWD|NTD|CNY)\s*$/iu.test(before)||/^(?:元|蚊|%|percent|dollars?|港幣|港币|台幣|台币)/iu.test(after))return false;
        // Unit/subject is read from this question/source, not a unit whitelist.
        // A total may inherit the one explicitly named subject in the same row.
        const sourceHasSubject = (ref:string):boolean => phrase(source,ref) ||
          (/^[\p{Script=Han}]{2,}/u.test(ref) && after.startsWith([...ref][0]) &&
            phrase(source,ref.slice([...ref][0].length)));
        const totalSubject = total && (named.length ? subjects.every(sourceHasSubject) : subjects.some(sourceHasSubject));
        const crossLanguageGenericUnit = subjects.length === 1 && /^(?:units?|items?)$/iu.test(subjects[0]) &&
          activeEntities.filter(e=>e.provenance.source_message_id===fact.source_message_id &&
            entityAliases(e).some(alias=>phrase(source,alias))).length === 1 && total;
        if(subjects.length && !scopedSubject(clause) &&
           !totalSubject && !crossLanguageGenericUnit)return false;
        if(!subjects.length&&!any(clause,field.words))return false;
        return /[\p{L}]/u.test(after)||any(before,field.words);
      }
      if(!scopedSubject(clause))return false;
      return scalarFieldSourceBound(field,fact.value,clause);
    });
    if(applicable.length!==1)continue;
    if(laterCustomerSourceConflicts(input,fact.source_message_id,field,subjects,entity??null,
      applicable[0],clauses.slice(clauses.indexOf(applicable[0])+1)))continue;
    evidence.push({fact_type:field.fact,state_path:`current_customer_facts.${i}.value`,value:fact.value,
      authority:"CURRENT_CUSTOMER_MEMORY",entity_id:fact.entity_id??null,region:fact.region??null,
      evidence_source_message_id:fact.source_message_id,temporal_scope:"current",source_kind:"attested_customer_utterance",attribute_key:fact.key});
  }
  if(evidence.length!==1)return fail("AMBIGUOUS",evidence.length?"CUSTOMER_RECALL_SOURCE_AMBIGUOUS":"CUSTOMER_RECALL_SOURCE_NOT_ATTESTED",[field.fact]);
  return {handled:true,authority:"CURRENT_CUSTOMER_MEMORY",fact_type:field.fact,state_path:evidence[0].state_path,value:evidence[0].value,
    provenance:{conversation_id:input.conversation_id,company_id:input.company_id,source_message_id:input.source_message_id,
      memory_revision:m.memory_revision,commerce_state_revision:c?.revision??m.commerce_state_revision,
      commerce_source_message_id:c?.source_message_id??null,evidence}};
}

/** Verify a customer-owned count against the actual earlier Visitor utterance.
 * This is an evidence type, not a phrase-triggered answer. The model cannot
 * supply a count or source ID here, and a stale/conflicting canonical aggregate
 * is never used to overwrite the literal customer statement. */
function attestedCustomerQuantity(
  input: ConversationRecallInput,
): Candidate | null {
  const memory = input.memory;
  const rows = input.trusted_visitor_source_rows;
  if (!memory || !rows?.length || rows.length > 500 ||
      !any(input.question, OWNER) ||
      !/(?:剛才|刚才|頭先|头先|之前|先前|曾經|曾经|講過|讲过|說過|说过|提過|提过|記得|记得|提到|mentioned|previously|earlier|told you|did (?:i|we) say|(?:i|we) said)/iu.test(input.question)) return null;
  const readNumber = (token: string): number | null => {
    const numerals: Record<string, number> = {
      "零":0,"〇":0,"一":1,"二":2,"兩":2,"两":2,"三":3,
      "四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,
    };
    const n = /^[0-9]{1,4}$/.test(token) ? Number(token) : numerals[token];
    return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 1000 ? n : null;
  };
  const countsIn = (value: string): number[] => {
    const tokens = [...value.matchAll(
      /([0-9]{1,4}|[零〇一二兩两三四五六七八九十])\s*(?:部|台|件|套|份|盒|箱|堂|課|课|張|张|units?|items?|pieces?|sets?|boxes?|sessions?|lessons?|licenses?|licences?|seats?|nights?)(?![a-z])/giu,
    )].map((m) => readNumber(m[1])).filter((x): x is number => x !== null);
    const total = value.match(
      /(?:合共|總共|总共|共計|共计|一共|總數|总数|in total|altogether|total(?: of)?)\s*(?:需|要|有|是|為|为|:|：)?\s*([0-9]{1,4}|[零〇一二兩两三四五六七八九十])\s*(?:部|台|件|套|份|盒|箱|堂|課|课|units?|items?|pieces?|sets?|boxes?|sessions?|lessons?|licenses?|licences?|seats?|nights?)/iu,
    );
    const exact = total ? readNumber(total[1]) : null;
    return exact === null ? [...new Set(tokens)] : [exact];
  };
  const candidates: Candidate[] = [];
  for (let i = 0; i < memory.current_customer_facts.length; i++) {
    const fact = memory.current_customer_facts[i];
    if (fact.authority !== "customer" || keyNorm(fact.key) !== "quantity" ||
        typeof fact.value !== "number" || !Number.isInteger(fact.value) ||
        fact.value < 0 || fact.value > 1000 ||
        !fact.source_message_id || fact.source_message_id === input.source_message_id) continue;
    const matching = rows.filter((row) =>
      row.id === fact.source_message_id && typeof row.content === "string" &&
      row.content.length > 0 && row.content.length <= 2400,
    );
    if (matching.length !== 1) continue;
    const exact = countsIn(matching[0].content);
    if (exact.length !== 1 || exact[0] !== fact.value) continue;
    // Bind an explicit quantified subject to the same Visitor utterance.
    // A generic quantity from an AC discussion must never answer a separate
    // course/license/booking question. Unresolvable cross-language synonyms
    // remain ambiguous rather than becoming invented equivalence.
    const namedEnglish = input.question.match(/\bhow\s+many\s+(.{2,70}?)(?=\s+(?:did|do|have|was|were|are|is|would|will|i|we|you|the|there)\b|[?!.,]|$)/iu)?.[1]?.trim();
    const namedChinese = input.question.match(/(?:幾多|几多|多少)\s*(?:[0-9一二兩两三四五六七八九十]+\s*)?(?:部|台|件|套|份|盒|箱|堂|課|课|張|张|個|个)?\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{1,22})/u)?.[1]?.trim();
    const namedSubject = namedEnglish || namedChinese;
    if (namedSubject && !matching[0].content.normalize("NFKC").toLowerCase()
      .includes(namedSubject.normalize("NFKC").toLowerCase())) continue;
    candidates.push({
      fact_type: "quantity", value: fact.value,
      state_path: "current_customer_facts." + i + ".value",
      authority: "CURRENT_CUSTOMER_MEMORY",
      entity_id: fact.entity_id ?? null,
      region: fact.region ?? null,
      evidence_source_message_id: fact.source_message_id,
      temporal_scope: "current", source_kind: "attested_customer_utterance",
      rank: -2,
    });
  }
  // Multiple valid, distinct customer totals need a newer entity/source
  // disambiguation; a broad history search must never silently pick one.
  return candidates.length === 1 ? candidates[0] : null;
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
        !["cancelled", "deferred"].includes(e.status) && customerRequestedQuantity(e) !== null
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
  if (f === "constraints") {
    for (const entity of selected.filter(isCurrentEntity)) {
      if (Object.keys(entity.constraints).length > 0) {
        add(`entities.${s.entities.indexOf(entity)}.constraints`, entity.constraints, entity, "customer_owned_canonical_property", 0);
      }
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
      authority: path.startsWith("cancelled_or_superseded.") ? "HISTORICAL_CUSTOMER_MEMORY" : "CURRENT_CUSTOMER_MEMORY",
      entity_id: entity,
      region,
      evidence_source_message_id: source,
      temporal_scope: path.startsWith("cancelled_or_superseded.") ? "historical" : "current",
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
  if (f === "constraints") {
    const scoped = selectedIds.size === 0
      ? m.active_constraints
      : m.active_constraints.filter((text) => {
        const named = (input.commerce?.state.entities ?? []).filter((entity) => any(text, entityAliases(entity)));
        return named.length === 0 || named.some((entity) => selectedIds.has(entity.entity_id));
      });
    add("active_constraints", scoped, 2);
  }
  if (f === "preferences") {
    add("customer_preferences", m.customer_preferences, 2);
  }
  if (f === "region") add("current_regions", m.current_regions, 2);
  if (f === "goal") add("current_goal", m.current_goal, 2);
  if (f === "correction") {
    add("latest_corrections.0", m.latest_corrections[0], 1);
  }
  if (f === "entity_status" && asksInactiveEntityStatus(input.question)) {
    for (let i = 0; i < m.cancelled_or_superseded.length; i++) {
      const fact = m.cancelled_or_superseded[i];
      if (fact.authority !== "customer" && fact.authority !== "canonical_commerce") continue;
      // Requirement snapshots are not entity lifecycle records. Never render an
      // opaque superseded requirement object as a current item status.
      if (!fact.entity_id && !(fact.key === "cancelled item" && typeof fact.value === "string" && fact.source_message_id)) continue;
      add(`cancelled_or_superseded.${i}`, fact.entity_id ?? fact.value, 1, null, fact.region ?? null, fact.source_message_id ?? null);
    }
  }
  return out;
}

/** A compound correction is never a pre-mutation recap. Only an exact
 * same-source readback may acknowledge the closed, already-applied operations.
 * This compares state; it does not plan, infer, execute or discard a clause. */
function hasSourceBoundCompletedRecap(input: ConversationRecallInput): boolean {
  const {memory:m,commerce:c,question:q}=input;
  if (!m || !c || !q || q.length>2400 || /["“”「」『』`\n]/u.test(q) ||
    m.source_message_id!==input.source_message_id || c.source_message_id!==input.source_message_id ||
    m.commerce_state_revision!==c.revision) return false;
  const clauses=splitCustomerOperationClauses(q);
  if(clauses.length<2 || clauses.length>8 ||
    !isCurrentRequirementsRecap(clauses[clauses.length-1],retainedRecapTargets(c.state))) return false;
  const norm=(v:string)=>v.normalize("NFKC").toLowerCase().trim();
  const named=(label:string)=>c.state.entities.filter(e=>entityAliases(e).some(a=>norm(a)===norm(label)));
  let changed=false;
  for(const clause of clauses.slice(0,-1)){
    const lifecycle=clause.match(/^(?:please )?(defer|pause|cancel) (.+)$/i);
    const quantity=clause.match(/^(?:please )?change (.+) to (\d+(?:\.\d+)?) ([a-z]+)$/i);
    const focus=clause.match(/^(?:back to|return to) (.+)$/i);
    if(!lifecycle && !quantity && !focus) return false;
    const entities=named((lifecycle||quantity||focus)![lifecycle?2:1]);
    if(entities.length!==1) return false;
    const e=entities[0];
    if(e.provenance.source_message_id!==input.source_message_id) return false;
    if(lifecycle){
      if(e.status!==(/^cancel$/i.test(lifecycle[1])?"cancelled":"deferred")) return false;
      changed=true;
    }else if(quantity){
      if(["deferred","cancelled","superseded"].includes(e.status) ||
        e.quantity!==Number(quantity[2]) || typeof e.attributes.unit!=="string" ||
        norm(e.attributes.unit)!==norm(quantity[3])) return false;
      changed=true;
    }else if(c.state.current_topic!==e.category || ["deferred","cancelled","superseded"].includes(e.status)) return false;
  }
  return changed;
}

/** Semantic understanding proposes a field, not an exclusive answer route.
 * F1/S3 + F3/S4: preserve the preexisting typed resolver for unsupported
 * or compound recalls, while scope/source/merchant protections fail closed. */
export function resolveConversationRecall(
  input: ConversationRecallInput,
): ConversationRecallDecision {
  if (input.explicit_handoff) return fail("NOT_A_RECALL_QUERY", "HANDOFF_PRECEDENCE");
  const semantic = resolveSemanticCustomerRecall(input);
  if (!semantic) return resolveConversationRecallLegacy(input);
  if (semantic.handled) return semantic;
  // A missing Visitor-source list cannot certify a supported scalar.
  // An independently authenticated canonical field is different: allow
  // the original resolver to verify unsupported typed fields (address,
  // room, contact, constraints) or compound fields without extra model/KB.
  const supportedScalar = (fact: RecallFact) =>
    CUSTOMER_RECALL_FIELDS.some(field => field.fact === fact);
  const parsedFields = parseQuery(input.question).facts;
  const unsupportedTypedField = parsedFields.some(f => !supportedScalar(f)) ||
    (input.customer_recall_proposal?.requested_facts ?? []).some(key =>
      !CUSTOMER_RECALL_FIELDS.some(f => f.keys.some(k =>
        keyNorm(k) === keyNorm(key))));
  const canConsultLegacy = semantic.detail === "CUSTOMER_RECALL_FIELD_AMBIGUOUS" ||
    (unsupportedTypedField && [
      "CUSTOMER_SOURCE_NOT_AVAILABLE",
      "CUSTOMER_RECALL_SOURCE_NOT_ATTESTED",
    ].includes(semantic.detail));
  if (semantic.reason === "AMBIGUOUS" && !canConsultLegacy) return semantic;
  // The legacy resolver does its own intent, tenant and revision checks.
  const previous = resolveConversationRecallLegacy(input);
  if (!previous.handled) return semantic.reason === "CURRENT_KB_REQUIRED" ? semantic : previous;
  const visitor = input.trusted_visitor_source_rows ?? [];
  const originalSource = (e: RecallEvidence) => {
    if (e.temporal_scope !== "current") return false;
    if (e.evidence_source_message_id) {
      // T68/F1 (S3): independently verify the retained field against exactly
      // one server-read Visitor utterance; duplicate source IDs are unsafe.
      const matching = visitor.filter(x => x.id === e.evidence_source_message_id);
      if (matching.length !== 1) return false;
      const row = matching[0];
      if (e.fact_type === "horsepower" && Array.isArray(e.value)) {
        // Memory stores room/unit pairs, e.g. "small room 1匹". Verify each
        // pair against an original customer request, not a product spec or
        // an unrelated occurrence of the same number.
        if (!e.value.length || e.value.length > 8) return false;
        const source = sourceClauses(row.content);
        return e.value.every(raw => {
          if (typeof raw !== "string") return false;
          const pair = raw.normalize("NFKC").match(/^(.{1,60}?)\s+(\d+(?:\.\d+)?)\s*匹$/u);
          if (!pair) return false;
          const subject = pair[1].trim(), amount = pair[2].replace(".", "\\.");
          if (!subject) return false;
          const requested = new RegExp(
            "(?:要|需要|想要|指定|要求|預計|期望|希望|need|want|request)\\s*" +
              amount + "\\s*匹(?![\\d.])", "iu",
          );
          return source.some(clause => {
            const at = clause.indexOf(subject);
            return at >= 0 && requested.test(clause.slice(at + subject.length));
          });
        });
      }
      return hasField(row.content, e.fact_type);
    }
    const part = /^(customer_preferences|active_constraints|latest_corrections)\.(\d+)/u.exec(e.state_path);
    if (part) {
      const text = input.memory?.[part[1] as "customer_preferences" | "active_constraints" | "latest_corrections"]?.[Number(part[2])];
      if (typeof text === "string" && text.length > 0 &&
          visitor.some(x => x.content.includes(text))) return true;
    }
    // Retained per-entity requirements may omit a copied source ID.
    // Recover its original canonical entity provenance before any answer.
    const inherited = /^active_entities\.(\d+)\./u.exec(e.state_path);
    if (inherited) {
      const entityId = input.memory?.active_entities[Number(inherited[1])]?.entity_id;
      const entity = input.commerce?.state.entities.find(x => x.entity_id === entityId);
      if (entity?.provenance.source_type === "customer" &&
          entity.provenance.source_message_id &&
          visitor.some(x => x.id === entity.provenance.source_message_id &&
            hasField(x.content, e.fact_type))) return true;
    }
    // For unsupported typed fields only, a current value may also be
    // independently attested by the prior Visitor utterance itself.
    // Require both the corresponding field and every primitive value in
    // a single row; mere number equality in an unrelated topic is not proof.
    const primitives = (v: unknown): unknown[] =>
      Array.isArray(v) ? v.flatMap(primitives) :
      v && typeof v === "object" ? Object.values(v).flatMap(primitives) : [v];
    const values = primitives(e.value);
    return unsupportedTypedField && values.length > 0 && values.length <= 8 &&
      values.every(v => typeof v === "number" || typeof v === "string") &&
      visitor.some(row => hasField(row.content, e.fact_type) &&
        values.every(v => {
          if (typeof v === "number") return numberTokens(row.content).some(n => n.value === v);
          const needle = v.trim().normalize("NFKC").toLowerCase();
          return !!needle && row.content.normalize("NFKC").toLowerCase().includes(needle);
        }));
  };
  // Original typed-recall contract also accepts an authenticated,
  // source-revision-bound canonical customer field when the isolated fixture
  // has no separate Visitor-row projection. Do NOT use this exception if a
  // Visitor source list was provided but failed the independent check.
  const persistedOwnedField = (e: RecallEvidence): boolean => {
    if (e.source_kind !== "customer_owned_canonical_property") return false;
    const path = /^entities\.(\d+)\.(attributes|constraints)\.([A-Za-z0-9_]+)$/u.exec(e.state_path);
    if (!path) return false;
    const entity = input.commerce?.state.entities[Number(path[1])];
    if (!entity || !isCurrentEntity(entity) ||
        entity.entity_id !== e.entity_id ||
        entity.provenance.source_type !== "customer" ||
        !entity.provenance.source_message_id ||
        entity.provenance.source_message_id !== e.evidence_source_message_id ||
        !keyMatches(path[3], e.fact_type)) return false;
    const record = path[2] === "attributes" ? entity.attributes : entity.constraints;
    return Object.prototype.hasOwnProperty.call(record, path[3]) &&
      JSON.stringify(fieldValue(e.fact_type, path[3], record[path[3]])) === JSON.stringify(e.value);
  };
  const canonicalProof = previous.provenance.evidence.length > 0 &&
    previous.provenance.evidence.every(e =>
      e.authority === "CANONICAL_COMMERCE_STATE" ||
      (e.source_kind === "customer_owned_canonical_property" &&
        (originalSource(e) || (!visitor.length && persistedOwnedField(e)))));
  const legacyPersonalProof = unsupportedTypedField &&
    previous.provenance.evidence.length > 0 &&
    previous.provenance.evidence.every(e => e.authority === "CURRENT_CUSTOMER_MEMORY" && originalSource(e));
  const readOnly = !customerRecallHasAction(input.question);
  if (semantic.reason === "CURRENT_KB_REQUIRED") {
    // Never take price, stock, merchant policy or a requested transaction
    // from customer memory. A read-only customer delivery preference is
    // partial information and explicitly does NOT promise a booking.
    const statusOnly = canonicalProof && previous.provenance.evidence.every(e =>
      ["quotation_status", "order_status", "payment_status",
       "delivery_status", "installation_status"].includes(e.fact_type));
    const preferenceOnly = previous.fact_type === "delivery_preference" &&
      previous.provenance.evidence.length > 0 &&
      previous.provenance.evidence.every(e => e.temporal_scope === "current" &&
        (e.authority === "CANONICAL_COMMERCE_STATE" || originalSource(e))) &&
      (canonicalProof || legacyPersonalProof);
    return readOnly && (statusOnly || preferenceOnly) ? previous : semantic;
  }
  // Unsupported typed customer facts may reuse the old source-checked
  // canonical or current customer-text resolver. A selected quantity,
  // budget/date/name scalar with missing or mismatched Visitor proof may not.
  return readOnly && (canonicalProof || legacyPersonalProof) ? previous : semantic;
}
/** Original typed canonical resolver: its existing checks stay intact. */
function resolveConversationRecallLegacy(
  input: ConversationRecallInput,
): ConversationRecallDecision {
  if (input.explicit_handoff) {
    return fail("NOT_A_RECALL_QUERY", "HANDOFF_PRECEDENCE");
  }
  const retainedTargets = input.commerce ? retainedRecapTargets(input.commerce.state) : [];
  const resolved = summarySelection(input, input.commerce?.state.entities ?? []);
  if (resolved.provenance === "trusted_referent" && resolved.entities.length === 1) retainedTargets.push("it", "that", "this");
  const recap = isCurrentRequirementsRecap(input.question, retainedTargets);
  const parsed = parseQuery(input.question, input.recent_questions, retainedTargets, hasSourceBoundCompletedRecap(input));
  const m = input.memory, c = input.commerce;
  const requestedAmounts = (input.question.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((v) => Number(v.replace(/,/g, "")));
  const retainedHistoricalAmount = (m?.historical_facts ?? []).some((fact) => {
    const value = object(fact.value);
    return fact.authority === "historical" && (/quote/i.test(fact.key) || /^money:/.test(fact.key) && value?.reusable_as_current === false && value?.authority === "customer_historical_or_hypothetical") &&
      typeof value?.amount === "number" && requestedAmounts.includes(value.amount);
  });
  const historicalValidityReadback = retainedHistoricalAmount &&
    any(input.question, ["當作", "当作", "直接當", "可唔可以直接", "treat as", "apply to"]) &&
    any(input.question, ["價", "价", "price", "quote"]);
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
      (m.source_message_id !== input.source_message_id &&
        !(recap && c &&
          (m.source_message_id === c.source_message_id || (m.question_lifecycle ?? []).some(q =>
            q.source_message_id === m.source_message_id && q.status === "resolved" &&
            Boolean(q.resolution_source_message_id)) || hasTrustedPersistedMemoryReadback(input)) &&
          m.source_message_id !== input.source_message_id &&
          m.commerce_state_revision === c.revision)) ||
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
        return fact.authority === "historical" && (/quote/i.test(fact.key) || /^money:/.test(fact.key) && value?.reusable_as_current === false && value?.authority === "customer_historical_or_hypothetical") &&
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
      if (!m && !c && input.empty_state_verified === true) {
        evidence.push({ fact_type: f, state_path: "current_state.absent", value: { goal: null, entity_details: [] },
          authority: "CANONICAL_COMMERCE_STATE", entity_id: null, region: null,
          evidence_source_message_id: input.source_message_id, temporal_scope: "current", source_kind: "scoped_persisted_state_absence" });
        continue;
      }
      if (!m) return fail("AMBIGUOUS", "MEMORY_UNAVAILABLE", facts);
      const scope = summarySelection(input, c?.state.entities ?? []);
      if (scope.provenance !== "global" && (scope.entities.length === 0 || new Set(scope.entities.map(e => e.category)).size !== scope.entities.length)) return fail("AMBIGUOUS", "ENTITY_REFERENCE_AMBIGUOUS", facts);
      const scopedIds = new Set(scope.entities.map(e => e.entity_id));
      const rawSummaryEntities = c ? scope.entities.filter(isCurrentEntity) : [];
      const aggregateCategories = new Set(rawSummaryEntities.filter((entity) => entity.entity_id.endsWith(":unscoped")).map((entity) => entity.category));
      const summaryEntities = rawSummaryEntities.filter((entity) => entity.entity_id.endsWith(":unscoped") || !aggregateCategories.has(entity.category));
      const transaction = c ? {
        funnel_stage: c.state.conversion.funnel_stage,
        quotation_status: c.state.conversion.quotation_status,
        order_status: c.state.conversion.order_status,
        payment_status: c.state.conversion.payment_status,
      } : m.transaction_summary;
      evidence.push({
        fact_type: f,
        state_path: "current_memory_projection",
        value: {
          goal: scope.provenance === "global" ? m.current_goal : null,
          entities: c
            ? summaryEntities.map((e) => ({ entity_id: e.entity_id, quantity: customerRequestedQuantity(e) }))
            : m.active_entities.map((e) => ({
              entity_id: e.entity_id,
              quantity: e.quantity,
            })),
          // Rich, authority-bound values stay internal. The only visible
          // projection is the shared natural recap composer below.
          entity_details: c
            ? [...summaryEntities, ...scope.entities.filter(e => ["deferred", "cancelled"].includes(e.status))]
            : m.active_entities.map(e => ({
              entity_id: e.entity_id, category: e.type, quantity: e.quantity,
              status: e.transaction_state.confirmed === true ? "confirmed" : "tentative",
              model: e.model, brand: e.brand, attributes: e.current_requirements,
              constraints: {}, provenance: { source_type: "customer" },
            })),
          selection_provenance: scope.provenance,
          confirmed_entity_ids: (c?.state.conversion.confirmed_entity_ids ?? []).filter(id => scope.provenance === "global" || scopedIds.has(id)),
          pending_actions: scope.provenance === "global" ? m.pending_actions : [],
          operational_pending_checks: scope.provenance === "global" ? c?.state.installation.pending_checks ?? [] : [],
          transaction: scope.provenance === "global" ? transaction : null,
          preferences: scope.provenance === "global" ? m.customer_preferences : [],
          constraints: scope.provenance === "global" ? m.active_constraints : [],
          regions: scope.provenance === "global" ? m.current_regions : [],
          customer_facts: scope.provenance === "global" ? m.current_customer_facts : [],
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
    if (f === "quantity") {
      const spoken = attestedCustomerQuantity(input);
      if (spoken) {
        const quoted: RecallEvidence = { ...spoken };
        delete (quoted as Partial<Candidate>).rank;
        evidence.push(quoted);
        continue;
      }
      // If the same source has contradictory stored quantities, a mere
      // canonical ranking must not manufacture a safe answer. This condition
      // intentionally does not change historical/current Commerce state.
      const canonical = candidates.find((c) =>
        c.authority === "CANONICAL_COMMERCE_STATE" && c.rank === 0);
      const customer = candidates.find((c) =>
        c.authority === "CURRENT_CUSTOMER_MEMORY" &&
        c.source_kind === "retained_customer_fact" &&
        !!c.evidence_source_message_id);
      if (canonical && customer &&
          canonical.evidence_source_message_id === customer.evidence_source_message_id &&
          canonical.value !== customer.value) {
        return fail("AMBIGUOUS", "CONFLICTING_CUSTOMER_QUANTITY_SOURCE", facts);
      }
    }
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
  budget: ["你之前提供的預算", "你之前提供的预算", "Budget you stated"],
  date: ["你之前提供的日期", "你之前提供的日期", "Date you requested"],
  time: ["你之前提供的時間", "你之前提供的时间", "Time you requested"],
  name: ["你之前提供的稱呼", "你之前提供的称呼", "Name you provided"],
  size: ["你之前提供的尺寸", "你之前提供的尺寸", "Size you requested"],
  customer_fact: ["你之前提供的資料", "你之前提供的资料", "Information you provided"],
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
  none: ["未建立", "未建立", "none specified"],
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
      lines.push(renderCustomerRecap(e.value, language));
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
    if (e.source_kind === "attested_customer_utterance") {
      lines.push(`${LABELS[e.fact_type]?.[l] ?? e.attribute_key ?? "Customer information"}: ${v}`);
      continue;
    }
    if (e.temporal_scope === "historical") v = ["歷史記錄：", "历史记录：", "Historical record: "][l] + v;
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
    if (e.fact_type === "delivery_preference") {
      lines.push([
        `記低咗：${v}係你首選送貨日，不代表已確認配送安排。`,
        `已记录：${v}是首选送货日，不代表配送安排已确认。`,
        `I have ${v} as your preferred delivery day; the delivery is not booked.`,
      ][l]);
      continue;
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

/** The single customer-facing boundary for typed summary evidence.
 * It renders current values and lifecycle, never an internal Markdown/JSON
 * projection, historical corrections, or the wording that requested recall.
 */
export function renderCanonicalCustomerFactRecap(state:ConversationCommerceState,language:string):string|null {
  const values=object(state.customer_constraints.customer_reported_facts);
  const facts=Object.entries(values??{}).flatMap(([key,value])=>{
    const row=object(value),p=object(row?.provenance);
    return row && Object.prototype.hasOwnProperty.call(row,"value") && p?.source_type==="customer" && typeof p.source_message_id==="string"
      ? [{key,value:row.value,authority:"customer",source_message_id:p.source_message_id}] : [];
  });
  return facts.length ? renderCustomerRecap({customer_facts:facts},language) : null;
}

function renderCustomerRecap(value: unknown, language: string): string {
  const v = object(value) ?? {};
  const l = language === "en" ? 2 : language === "zh-CN" ? 1 : 0;
  const entities = (Array.isArray(v.entity_details) ? v.entity_details : []) as CommerceEntity[];
  const active = entities.filter(e => !["deferred", "cancelled"].includes(e.status));
  const label = (e: CommerceEntity) => typeof e.attributes.product_name === "string"
    ? display(e.attributes.product_name)
    : industryEntityLabel(e.entity_id, l === 2 ? "en" : l === 1 ? "zh-CN" : "zh-TW")
      ?? industryEntityLabel(e.category, l === 2 ? "en" : l === 1 ? "zh-CN" : "zh-TW")
      ?? (typeof e.attributes.name === "string" ? display(e.attributes.name) : null)
      ?? (e.model ? display(e.model) : display(e.category.replace(/_/g, " ")));
  const unitLabels: Record<string, [string, string]> = {
    seat: ["席", "席"], seats: ["席", "席"], session: ["節", "节"], sessions: ["節", "节"],
    item: ["個", "个"], items: ["個", "个"], unit: ["個", "个"], units: ["個", "个"],
  };
  const rooms: Record<string, [string, string, string]> = {
    study: ["書房", "书房", "study"], small_bedroom: ["細房", "小卧室", "small bedroom"],
    large_bedroom: ["大房", "大卧室", "large bedroom"], living_room: ["客廳", "客厅", "living room"],
  };
  const describe = (e: CommerceEntity): string => {
    const unit = typeof e.attributes.unit === "string" ? e.attributes.unit
      : industryEntityQuantityUnit(e.category, l === 2 ? "en" : l === 1 ? "zh-CN" : "zh-TW", e.quantity) ?? "items";
    const count = customerRequestedQuantity(e) === null ? ["機數待確認", "数量待确认", "quantity not yet confirmed"][l] : l === 2 ? `${e.quantity} ${e.quantity === 1 ? unit.replace(/s$/, "") : unit}`
      : `${e.quantity}${unitLabels[unit]?.[l] ?? display(unit)}`;
    const facts: string[] = [];
    const sizes = object(e.attributes.room_sizes);
    for (const [room, size] of Object.entries(sizes ?? {})) {
      if (typeof size !== "string") continue;
      facts.push(`${rooms[room]?.[l] ?? room.replace(/_/g, " ")}${l === 2 ? " " : ""}${l === 2 ? display(size).replace(/平方[呎尺]|[呎尺]/u, " sq ft") : display(size)}`);
    }
    if (typeof e.constraints.max_width_mm === "number") facts.push(l === 2 ? `maximum width ${e.constraints.max_width_mm} mm` : `最闊${e.constraints.max_width_mm} mm`);
    if (e.model && !label(e).includes(e.model)) facts.push(display(e.model));
    for (const [room, sun] of Object.entries(object(e.attributes.room_sunlight) ?? {})) {
      if (sun === "strong_afternoon_sun") facts.push(`${rooms[room]?.[l] ?? room.replace(/_/g," ")} ${["下午日照強", "下午日晒较强", "has strong afternoon sun"][l]}`);
    }
    if (e.attributes.sunlight === "strong_afternoon_sun") facts.push(["下午日照強", "下午日晒较强", "strong afternoon sun"][l]);
    if (e.attributes.sunlight === "none") facts.push(["客戶表示冇西斜", "客户表示没有西晒", "customer reports no afternoon sun"][l]);
    for(const [room,sun] of Object.entries(object(e.attributes.room_sunlight)??{}))if(sun==="none")facts.push(`${rooms[room]?.[l]??room.replace(/_/g," ")} ${["冇西斜","没有西晒","has no afternoon sun"][l]}`);
    const opening=object(e.attributes.window_opening_observation);
    if(opening&&typeof opening.width_mm==="number"&&typeof opening.height_mm==="number")facts.push(`${opening.width_mm} mm × ${opening.height_mm} mm${opening.scope?` (${rooms[String(opening.scope)]?.[l]??String(opening.scope)})`:["（所屬窗口未確認）","（所属窗口未确认）"," (opening scope not confirmed)"][l]}`);
    if (e.attributes.installation_type === "window_unit") facts.push(["窗口機", "窗口机", "window unit"][l]);
    if (Number.isInteger(e.attributes.door_count)) facts.push(l === 2 ? `${e.attributes.door_count} doors` : `${e.attributes.door_count}門`);
    if (l === 2) return renderEnglishRequirement(e,label(e)) + (facts.length ? ", "+facts.join(", ") : "");
    const date = typeof e.attributes.requested_date === "string" ? display(e.attributes.requested_date) : null;
    const details = `${label(e)} ${count}${date ? [ `，要求日期 ${date}`, `，要求日期 ${date}` ][l] : ""}${facts.length ? `，${facts.join("、")}` : ""}`;
    const lifecycle = e.status === "deferred" ? ["已暫緩", "已暂缓", " is paused"][l]
      : e.status === "cancelled" ? ["已取消", "已取消", " has been cancelled"][l] : "";
    return details + lifecycle;
  };
  const inactive = entities.filter(e => ["deferred", "cancelled"].includes(e.status));
  const regions=(Array.isArray(v.regions)?v.regions:[]).map(object).filter(r=>r!==null);
  const regionNames:Record<string,[string,string,string]>={hong_kong:["香港","香港","Hong Kong"],taiwan:["台灣","台湾","Taiwan"],macau:["澳門","澳门","Macau"],singapore:["新加坡","新加坡","Singapore"]};
  const retained = (Array.isArray(v.customer_facts)?v.customer_facts:[]).map(object).flatMap(f=>{
    // Canonical entity bookkeeping is already rendered by describe(). It is
    // not a customer-facing fact label and must not leak into the recap.
    if (String(f?.key).startsWith("entity:")) return [];
    // The existence of an entity does not prove it contains the customer fact.
    // In particular a deferred/undecided entity may have no area attributes.
    // Keep current customer facts rather than dropping them from the Summary.
    if(!f || !["customer","canonical_commerce"].includes(String(f.authority)) || regions.some(r=>r?.region===f.region && r.temporal_scope==="future"))return [];
    const region=regionNames[String(f.region)]?.[l];
    const prefix=region ? region+(l===2?": ":" "):"";
    if(f.key==="quantity" && typeof f.value==="number")return [prefix+["要求數量","要求数量","requested quantity " ][l]+f.value];
    if(f.key==="horsepower" && Array.isArray(f.value) && f.value.every(x=>typeof x==="string"))return [prefix+f.value.map(x=>l===2?String(x).replace(/匹/g," hp"):String(x)).join(l===2?", ":"、")];
    if(f.key==="room_size" && Array.isArray(f.value))return f.value.flatMap(x=>{const row=object(x);return row && typeof row.label==="string" && typeof row.value==="string" ? [prefix+display(row.label)+" "+display(row.value)] : [];});
    if(f.key==="brand_required" && typeof f.value==="boolean")return [prefix+(f.value?["你要求指定品牌","你要求指定品牌","you require a specific brand"]:["你冇限定品牌","你没有限定品牌","you do not require a specific brand"])[l]];
    const names: Record<string, [string,string,string]> = {team_size:["團隊人數","团队人数","team size"],monthly_budget:["每月預算","每月预算","monthly budget"],automatic_renewal:["自動續訂","自动续订","automatic renewal"],preferred_interface_language:["介面語言","界面语言","interface language"],business_type:["業務類型","业务类型","business type"],priority:["優先需求","优先需求","priority"],budget:["預算","预算","budget"],room_area:["面積","面积","room area"],product_count:["商品數量","商品数量","product count"],staff_count:["人手","人手","staff count"],app_interest:["App 需要","App 需要","app needed"],preferred_interface:["使用介面","使用界面","preferred interface"],current_market:["目前市場","目前市场","current market"],desired_features:["需要功能","需要功能","required features"],future_markets:["未來市場","未来市场","future markets"]};
    const renderValue = (raw:unknown):string|undefined => {
      if(raw===null)return ["未確認","未确认","unknown"][l];
      if(typeof raw==="boolean")return (raw?["需要","需要","yes"]:["不需要","不需要","no"])[l];
      if(typeof raw==="string")return regionNames[raw]?.[l] ?? ({'quiet operation':["安靜運作","安静运行","quiet operation"],quiet_operation_at_night:["夜間安靜","夜间安静","quiet operation at night"],energy_efficiency:["能源效益","能源效率","energy efficiency"],price:["價錢","价格","price"]} as Record<string,string[]>)[raw]?.[l] ?? display(raw.replace(/_/g," "));
      if(typeof raw==="number" && Number.isFinite(raw))return String(raw);
      if(Array.isArray(raw))return raw.map(renderValue).filter(x=>x!==undefined).join(l===2?", ":"、") || undefined;
      const typed=object(raw);
      const number=typed?.amount ?? typed?.quantity;
      if(typed && typeof number==="number" && Number.isFinite(number) && typeof typed.unit==="string") {
        const amount=number.toLocaleString('en-US',{maximumFractionDigits:20});
        const currency:Record<string,string>={HKD:'HK$',USD:'US$',TWD:'NT$'};
        const units:Record<string,string[]>={sq_ft:["平方呎","平方呎","sq ft"],person:["人","人","people"]};
        return currency[typed.unit] ? currency[typed.unit]+amount : amount+' '+(units[typed.unit]?.[l] ?? display(typed.unit.replace(/_/g," ")));
      }
      // A canonical customer fact may be a named dimensions/options record,
      // not only amount/unit. Render its typed values rather than dropping it
      // or exposing JSON. State/provenance envelopes never enter this value.
      if (typed) {
        const labels:Record<string,string[]>={width:["闊度","宽度","width"],height:["高度","高度","height"],unit:["單位","单位","unit"]};
        const parts=Object.entries(typed).flatMap(([key,child])=>{
          const value=renderValue(child);
          return value===undefined?[]:[(labels[key]?.[l] ?? display(key.replace(/_/g," ")))+": "+value];
        });
        return parts.length?parts.join(l===2?", ":"、"):undefined;
      }
      return undefined; // Never serialize an internal object as customer prose.
    };
    const value = renderValue(f.value);
    return value === undefined ? [] : [prefix+(names[String(f.key)]?.[l] ?? display(String(f.key).replace(/_/g," ")))+": "+value];
  });
  const retainedText=retained.length ? ["而家記低咗","目前已记录","I have noted " ][l]+retained.join(l===2?"; ":"；")+(l===2?".":"。") : "";
  const first = l === 2
    ? [active.length ? `I've noted ${active.map(describe).join("; ")}.` : "",
        inactive.length ? inactive.map(describe).join("; ") + "." : "",
        !entities.length ? retainedText || "No specific requirements are available yet." : ""].filter(Boolean).join(" ")
    : entities.length ? ["而家記低咗", "目前已记录"][l] + entities.map(describe).join("；") + "。"
    : retainedText || ["暫時未記低任何具體要求。", "暂时没有记录具体要求。"][l];
  const confirmed = Array.isArray(v.confirmed_entity_ids) ? v.confirmed_entity_ids : [];
  const global = v.selection_provenance === "global";
  const items = (global && entities.length ? ["項目：", "项目：", "Items: "][l] + first : first) +
    (entities.length && retainedText ? (l === 2 ? " " : "") + retainedText : "");
  const pendingBooking = active.some(e => object(e.attributes.capabilities)?.requires_booking === true && !confirmed.includes(e.entity_id));
  const qualifications: string[] = [];
  if (pendingBooking) qualifications.push(["預約要求仍需職員確認，未成為已確認預約。", "预约要求仍需职员确认，尚未成为已确认预约。", "The booking still needs staff confirmation and is not confirmed yet."][l]);
  if (active.some(e => e.category === "air_conditioner" || object(e.attributes.capabilities)?.requires_site_check === true) ||
    global && Array.isArray(v.operational_pending_checks) && v.operational_pending_checks.length > 0) qualifications.push(["適用性仍要按現行資料及現場條件核對。", "适用性仍需按现行资料及现场条件核对。", "Suitability still needs current evidence and the relevant site checks."][l]);
  // Only the global projection owns portfolio transaction status. Operational
  // qualifications never suppress it, and scoped projections never inherit it.
  let transactionText = "";
  const transaction = global ? object(v.transaction) : null;
  if (transaction) {
    const order = transaction.order_status ?? transaction.order;
    const payment = transaction.payment_status ?? transaction.payment;
      const orders: Record<string, [string, string, string]> = {
        none: ["未建立訂單", "尚未建立订单", "no order has been placed"],
        draft: ["訂單仍未確認", "订单尚未确认", "the order is not confirmed"],
        pending_confirmation: ["訂單仍待確認", "订单仍待确认", "the order is awaiting confirmation"],
        confirmed: ["訂單已確認", "订单已确认", "the order is confirmed"],
        completed: ["訂單已完成", "订单已完成", "the order is completed"],
        cancelled: ["訂單已取消", "订单已取消", "the order is cancelled"],
      };
      const payments: Record<string, [string, string, string]> = {
        none: ["未有付款記錄", "没有付款记录", "no payment record"],
        pending_quote: ["付款金額仍待核實", "付款金额仍待核实", "payment is awaiting a verified amount"],
        pending_payment: ["仍待付款", "仍待付款", "payment is pending"],
        paid: ["已有已收款記錄", "已有收款记录", "the payment record shows paid"],
        failed: ["付款未成功", "付款未成功", "payment was unsuccessful"],
        refunded: ["已有退款記錄", "已有退款记录", "the payment record shows a refund"],
        partially_refunded: ["已有部分退款記錄", "已有部分退款记录", "the payment record shows a partial refund"],
      };
      const quotation = transaction.quotation_status ?? transaction.quotation;
      const quotationText = STATUS_TEXT[String(quotation)]
        ? ["報價階段：", "报价阶段：", "Quotation stage: "][l] + STATUS_TEXT[String(quotation)][l] +
          (["none", "draft", "pending_confirmation"].includes(String(order))
            ? ["，唔係已確認訂單", "，不是已确认订单", "; not a confirmed order"][l] : "")
        : "";
      transactionText = [
        quotationText,
        orders[String(order)] ? (l === 2 ? "Order: " : "") + orders[String(order)][l] : "",
        payments[String(payment)] ? ["付款：", "付款：", "Payment: "][l] + payments[String(payment)][l] : "",
      ].filter(Boolean).join(l === 2 ? "; " : "，");
      if (transactionText) transactionText += l === 2 ? "." : "。";
  }
  const future=regions.filter(r=>r?.temporal_scope==="future").flatMap(r=>regionNames[String(r?.region)]?.[l]??[]);
  const futureText=future.length ? future.join(l===2?", ":"、")+["只屬未來討論，唔係目前已確認交易。","仅属未来讨论，并非目前已确认交易。"," is a future discussion only, not a confirmed current transaction."][l] : "";
  const sections = [transactionText, ...qualifications, futureText].filter(Boolean);
  const details = sections.length
    ? sections.map(section => section.replace(/[.。]$/, "")).join(l === 2 ? "; " : "；") + (l === 2 ? "." : "。")
    : "";
  return [items, details].filter(Boolean).join(l === 2 ? " " : "").slice(0, 4096);
}

/** Read-only pre-Semantic shortcut. Syntax alone never grants this route.
 * Reads use the authenticated caller's exact Company/Ticket, then reuse the
 * final resolver's source/revision/tenant checks. Commit still re-reads B2. */
export async function hasProvenCurrentRequirementsRecap(
  db: { from(table: string): any }, input: RecallScope & { question: string; explicit_handoff?: boolean },
): Promise<boolean> {
  if (input.explicit_handoff || !input.company_id || !input.conversation_id || !input.source_message_id ||
    !hasRequirementsRecapCue(input.question) && !isCurrentRequirementsRecap(input.question)) return false;
  try {
    const [mr, cr] = await Promise.all([
      db.from("conversation_memory_state").select("conversation_id,company_id,revision,source_message_id,commerce_state_revision,memory,memory_hash")
        .eq("conversation_id", input.conversation_id).eq("company_id", input.company_id).maybeSingle(),
      db.from("conversation_commerce_state").select("conversation_id,company_id,source_message_id,revision,state")
        .eq("conversation_id", input.conversation_id).eq("company_id", input.company_id).maybeSingle(),
    ]);
    if (mr.error || cr.error) return false;
    const m = mr.data, c = cr.data;
    if (m && (m.company_id !== input.company_id || m.conversation_id !== input.conversation_id ||
      m.memory?.source_message_id !== m.source_message_id || m.memory?.memory_revision !== m.revision ||
      m.memory?.commerce_state_revision !== m.commerce_state_revision ||
      !/^[a-f0-9]{64}$/i.test(String(m.memory_hash ?? "")))) return false;
    const decision = resolveConversationRecall({ ...input, memory: m?.memory ?? null, commerce: c ?? null,
      empty_state_verified: !m && !c,
      trusted_persisted_memory_readback: m ? { contract:"persisted-memory-readback-v1",
        company_id:m.company_id,conversation_id:m.conversation_id,source_message_id:m.source_message_id,
        memory_revision:m.revision,commerce_state_revision:m.commerce_state_revision,memory_hash:m.memory_hash } : null,
    });
    return decision.handled && decision.fact_type === "summary";
  } catch { return false; }
}
