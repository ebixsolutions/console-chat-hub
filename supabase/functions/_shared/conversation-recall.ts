import { isLegacyRoomAreaKey } from "./conversation-long-memory.ts";
import { customerRequestedQuantity } from "./customer-journey-orchestration.ts";
import { PAIRED_SITE_KEY, SCOPED_AREA_KEY, readPairedSiteReceipt, pairedSiteMemoryValue,
  readScopedAreaReceipt, scopedAreaMemoryValue, scopedAreaSources, pairedSiteSourceMatches,
  type ContextualSourceContext } from "./contextual-customer-update.ts";
import { resolveSourceOwnedSubject,sourceOwnedSubjectLabels,customerOwnedDisplayLabel,safeCustomerDisplayText,canonicalUnitPartitions,renderUnitPartition,type CanonicalUnitPartition } from "./commerce-subject-resolution.ts";
/** C3: deterministic, read-only fact ownership routing. No KB, model or state writes. */
import type {
  CommerceEntity,
  ConversationCommerceState,
} from "./commerce-state-contract.ts";
import { splitCustomerOperationClauses, hasRequirementsRecapCue, isCurrentRequirementsRecap, isReadOnlyMemoryOrCurrentStateRecall, withoutExcludedLookups } from "./commerce-state-authority.ts";
import type { CanonicalConversationMemory } from "./conversation-long-memory.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
// Phase 1 recap never imports an industry-specific display vocabulary.
import { renderEnglishRequirement } from "./commerce-capability-runtime.ts";
import { classifyCanonicalConversationTurn } from "./conversation-semantic-contract.ts";
import { sameCanonicalJson } from "./canonical-json.ts";

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
  /** Exact sourced display unit; never a locale or industry default. */
  quantity_unit?: string;
  quantity_unit_source_kind?: "canonical_customer_attribute" | "current_customer_question";
  quantity_unit_source_message_id?: string;
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
  /** Explicit server-owned read result, never supplied by a model or widget. */
  trusted_visitor_source_status?: TrustedRecallReadStatus;
  /** Existing accepted understanding result, bound to this server-owned turn.
   * Selects a recall field only; fact values still require Visitor-source proof. */
  customer_recall_proposal?: RecallScope & {
    intent: "customer_fact_recall";
    requested_facts: readonly string[];
    subject_refs: readonly string[];
  };
  /** Private accepted current-turn Reading, bound by the server to the loaded Commerce revision. */
  quantity_reading?: RecallScope & { commerce_revision: number; frame: CommerceSemanticFrame;
    /** For a separated mixed recall, the exact server-owned complete Visitor turn. */
    full_question?: string;
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
/** A quantity question identifies a field, not a new amount or unit.
 * Use the existing same-ticket customer-owned subject, not a vocabulary of
 * classifiers/units. Accepted Reading can identify the field only after
 * exact current-turn scope and quote validation. Older explicit field cues
 * continue through the original compatibility parser. */
type QuantityQueryScope = Pick<ConversationRecallInput,
  "company_id" | "conversation_id" | "source_message_id" | "commerce" |
  "quantity_reading" | "explicit_handoff">;
/** S2: a Reading selects a customer-owned quantity field/subject only.
 * Whole-turn or independently separated mixed demands use the same source
 * binding. This is a candidate, never quantity authority or KB admission.
 * The old unframed compatibility reads remain unchanged until equivalence
 * is measured. Do not infer a new label, unit, industry or quantity. */
function selectStructuredQuantitySubject(
  input: QuantityQueryScope & { question: string },
): CommerceEntity | null {
  const c=input.commerce, r=input.quantity_reading, f=r?.frame;
  if(!c||!r||!f||input.explicit_handoff||!input.company_id||!input.conversation_id||
    !input.source_message_id||c.company_id!==input.company_id||c.conversation_id!==input.conversation_id||
    r.company_id!==input.company_id||r.conversation_id!==input.conversation_id||
    r.source_message_id!==input.source_message_id||r.commerce_revision!==c.revision||
    c.state.version!=="commerce-state-1.0.0"||!Number.isSafeInteger(c.revision)||c.revision<1||
    f.version!=="commerce-semantic-1.0.0"||f.operation!=="ASK_FACT"||f.confidence<0.72||
    f.ambiguity.is_ambiguous||f.customer_correction||f.additive||f.explicit_negations.length||
    f.customer_facts?.length||f.entities.length||
    [f.transaction_state,f.payment_state,f.booking_state,f.fulfillment_state].some(s=>s!=="none"&&s!=="unknown"))
    return null;
  const normalized=(s:string)=>s.normalize("NFKC").trim();
  const q=normalized(input.question), full=normalized(r.full_question??input.question);
  if(!q||q.length>2400||full.length>2400||sourceClauses(q).length!==1||
    customerRecallHasAction(q)||any(withoutExcludedLookups(q),EXTERNAL)||
    !isReadOnlyMemoryOrCurrentStateRecall(q,{operation:"ASK_FACT",requested_facts:["quantity"]}))return null;
  const demands=f.demands??[], quantity=demands.filter(d=>d.source_type==="general"&&
    d.requested_facts.length===1&&keyNorm(d.requested_facts[0])==="quantity");
  if(quantity.length!==1)return null;
  const d=quantity[0];
  if(d.ambiguity.is_ambiguous||d.customer_correction||d.explicit_negations.length||
    Object.keys(d.constraints).length||!d.subject_refs.length||
    normalized(d.source_quote)!==q||normalized(d.question)!==q)return null;
  // The initial S2 family covers a single count and an independent current
  // price demand. The latter still goes through the existing merchant route.
  // Verify complete, disjoint literal quote coverage, not a sentence pattern.
  const other=demands.filter(x=>x!==d);
  if(other.length===0){
    if(full!==q||f.intent!=="customer_fact_recall"||f.requested_facts.length!==1||
      keyNorm(f.requested_facts[0])!=="quantity")return null;
  }else{
    const p=other[0];
    if(other.length!==1||!r.full_question||full===q||p.source_type!=="product"||
      p.ambiguity.is_ambiguous||p.customer_correction||p.explicit_negations.length||
      Object.keys(p.constraints).length||!p.subject_refs.length||
      p.requested_facts.length!==1||keyNorm(p.requested_facts[0])!=="price"||
      f.requested_facts.length!==2||!f.requested_facts.includes("quantity")||
      !f.requested_facts.includes("price"))return null;
    const pq=normalized(p.source_quote);
    if(!pq||normalized(p.question)!==pq||pq.includes(q)||q.includes(pq)||
      full.split(q).length!==2||full.split(pq).length!==2)return null;
    const a=full.indexOf(q), b=full.indexOf(pq);
    if(a<b?a+q.length>b:b+pq.length>a)return null;
    // Only grammatical coordination may remain outside the two exact quotes.
    const gap=full.replace(q,"").replace(pq,"").replace(/[\s,，;；。.!！？?]+/gu," ")
      .replace(/\b(?:and|also)\b/giu,"").replace(/(?:同埋|以及|另外|並且|并且)/gu,"").trim();
    if(gap||customerRecallHasAction(full))return null;
  }
  const refs=[...d.subject_refs,...other.flatMap(x=>x.subject_refs)];
  const matches=(e:CommerceEntity,ref:string)=>ref===e.entity_id||
    sourceOwnedSubjectLabels(e).some(label=>keyNorm(label)===keyNorm(ref));
  const named=c.state.entities.filter(e=>refs.every(ref=>matches(e,ref)));
  if(named.length!==1||!f.referents.length||!f.referents.every(ref=>
    ["prior_turn","persistent_state"].includes(ref.source)&&ref.confidence>=0.72&&matches(named[0],ref.ref)))
    return null;
  const entity=named[0];
  if(["cancelled","deferred","superseded"].includes(entity.status)||
    entity.provenance.source_type!=="customer"||!entity.provenance.source_message_id||
    entity.provenance.source_message_id===input.source_message_id||
    entity.attributes.quantity_basis!=="customer_explicit"||
    !Number.isSafeInteger(entity.quantity)||entity.quantity<1||entity.quantity>1000)return null;
  const labelMatches=c.state.entities.filter(e=>sourceOwnedSubjectLabels(e).some(label=>phrase(q,label)));
  if(labelMatches.length>1||labelMatches.length===1&&labelMatches[0].entity_id!==entity.entity_id)return null;
  const literal=resolveSourceOwnedSubject(c.state,q,{include_inactive:true});
  if(literal.kind==="ambiguous"||literal.kind==="one"&&literal.entity.entity_id!==entity.entity_id)return null;
  if(literal.kind==="none"){
    const unit=canonicalCustomerQuantityUnit(entity)?.quantity_unit;
    if(!unit||!phrase(q,unit)||c.state.entities.filter(e=>
      canonicalCustomerQuantityUnit(e)?.quantity_unit&&
      keyNorm(canonicalCustomerQuantityUnit(e)!.quantity_unit!)===keyNorm(unit)).length!==1)return null;
  }
  return entity;
}

function sourceBoundQuantityQuery(q: string, input?: QuantityQueryScope): boolean {
  const c = input?.commerce;
  if (!input || !c || input.explicit_handoff || !input.company_id ||
      !input.conversation_id || !input.source_message_id ||
      c.company_id !== input.company_id || c.conversation_id !== input.conversation_id ||
      c.state.version !== "commerce-state-1.0.0" || !Number.isSafeInteger(c.revision) ||
      c.revision < 1 || sourceClauses(q).length !== 1 || customerRecallHasAction(q) ||
      any(withoutExcludedLookups(q), EXTERNAL) ||
      /(?:\b(?:and|or|but|then|also|if|unless)\b|同埋|以及|或者|還是|还是|如果)/iu.test(q))
    return false;
  const source = q.normalize("NFKC").trim();
  if (!/(?:幾多|几多|多少|幾|几|\bhow\s+many\b|\bquantity\b|\bcount\b)/iu.test(source))
    return false;
  const named = c.state.entities.filter(e =>
    e.provenance.source_type === "customer" && Boolean(e.provenance.source_message_id) &&
    sourceOwnedSubjectLabels(e).some(label => phrase(source, label)));
  if (named.length !== 1 || !isCurrentEntity(named[0])) return false;
  const entity = named[0], labels = sourceOwnedSubjectLabels(entity);
  const reading = input.quantity_reading;
  if (reading) {
    const frame = reading.frame;
    const demand = frame.demands?.[0];
    const matches = (ref: string) => ref === entity.entity_id ||
      labels.some(label => keyNorm(label) === keyNorm(ref));
    return reading.company_id === input.company_id &&
      reading.conversation_id === input.conversation_id &&
      reading.source_message_id === input.source_message_id &&
      reading.commerce_revision === c.revision &&
      frame.version === "commerce-semantic-1.0.0" &&
      frame.intent === "customer_fact_recall" && frame.operation === "ASK_FACT" &&
      frame.confidence >= 0.72 && !frame.ambiguity.is_ambiguous &&
      !frame.customer_correction && !frame.additive && !frame.explicit_negations.length &&
      !frame.customer_facts?.length &&
      [frame.transaction_state, frame.payment_state, frame.booking_state, frame.fulfillment_state]
        .every(status => status === "none" || status === "unknown") &&
      frame.requested_facts.length === 1 && keyNorm(frame.requested_facts[0]) === "quantity" &&
      frame.demands?.length === 1 && !!demand && demand.source_type === "general" &&
      typeof demand.source_quote === "string" &&
      demand.source_quote.normalize("NFKC").trim() === source &&
      demand.requested_facts.length === 1 && keyNorm(demand.requested_facts[0]) === "quantity" &&
      !demand.customer_correction && !demand.explicit_negations.length &&
      !demand.ambiguity.is_ambiguous && demand.subject_refs.length > 0 &&
      demand.subject_refs.every(matches) &&
      frame.referents.every(ref => ref.source === "persistent_state" &&
        ref.confidence >= 0.72 && matches(ref.ref)) &&
      frame.entities.every(e => e.entity_ref === entity.entity_id &&
        labels.some(label => keyNorm(label) === keyNorm(e.name)) &&
        (e.quantity == null || e.quantity === entity.quantity));
  }
  // In an unframed legacy turn, recognize an exact stored subject adjacent to
  // a count interrogative. A stored, source-owned unit may disambiguate the
  // grammar but is never inferred from the question.
  const esc = (value: string) => value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const stored = canonicalCustomerQuantityUnit(entity)?.quantity_unit;
  const unit = stored ? "(?:\\s*" + esc(stored.normalize("NFKC")) + ")?" : "";
  const count = "(?:幾多|几多|多少|幾|几)";
  const ending = "\\s*(?:呢|嗎|吗)?[?？]?$";
  const subject = quantitySubject(source);
  return labels.some(label => {
    const literal = esc(label.normalize("NFKC"));
    return new RegExp(literal + "\\s*(?:的|嘅)?\\s*(?:有|係|是|要)?\\s*" +
      count + unit + ending, "iu").test(source) ||
      new RegExp(count + unit + "\\s*" + literal + ending, "iu").test(source) ||
      (/\bhow\s+many\b/iu.test(source) && !!subject &&
        (keyNorm(subject) === keyNorm(label) ||
          !!stored && keyNorm(subject) === keyNorm(stored + " " + label)));
  });
}

function parseQuery(
  q: string,
  recentQuestions: string[] = [],
  retainedTargets: string[] = [],
  completedCompoundRecap = false,
  quantityScope?: QuantityQueryScope,
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
  if (!facts.length && sourceBoundQuantityQuery(q, quantityScope)) facts = ["quantity"];
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
  const compactSizeQuestion = compactDimensionQuestion(q);
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
const TYPE_ALIASES: string[][] = []; // No appliance/category alias table in Phase 1.
function entityAliases(e: CommerceEntity): string[] {
  const values = [
    e.entity_id,
    e.category,
    e.category.replace(/_/g, " "),
    // Explicit entity names come from source-bound canonical fields.
    e.brand,
    e.model,
    ...sourceOwnedSubjectLabels(e),
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
/** Literal receipts written only by the existing source-validated research
 * focus writer. These labels are read-only recap selectors, never inferred
 * category initials or general mutation aliases. */
function persistedRecapAliases(e: CommerceEntity, scope?: RecallScope): string[] {
  if(e.provenance.source_type!=="customer" || !e.provenance.source_message_id ||
    ["cancelled","deferred","superseded"].includes(e.status)) return [];
  const records=Array.isArray(e.attributes.source_owned_recap_aliases)
    ? e.attributes.source_owned_recap_aliases : [];
  if(records.length>8)return [];
  return records.flatMap(value=>{
    const record=object(value), alias=record?.alias;
    if(!record || record.contract!=="source-owned-recap-alias-v1" || typeof alias!=="string" ||
      alias.length<2 || alias.length>160 || record.entity_id!==e.entity_id || record.model!==e.model ||
      typeof record.company_id!=="string" || !record.company_id ||
      typeof record.conversation_id!=="string" || !record.conversation_id ||
      record.source_message_id!==e.provenance.source_message_id ||
      typeof record.source_quote!=="string" || record.source_quote.length>2400 ||
      !phrase(record.source_quote,alias) ||
      records.filter(other=>typeof object(other)?.alias==="string" &&
        keyNorm(String(object(other)!.alias))===keyNorm(alias)).length!==1 ||
      scope && (record.company_id!==scope.company_id || record.conversation_id!==scope.conversation_id))return [];
    return [alias];
  });
}
/** Existing canonical names and committed source literals only. */
export function retainedRecapTargets(state: ConversationCommerceState): string[] {
  return [...new Set(state.entities.flatMap(entity=>[...entityAliases(entity),...persistedRecapAliases(entity)]))];
}
/** The customer's latest retained quantity is an answerable *request*
 * only when one original, same-ticket Visitor row attests it. It cannot
 * certify a completed business cancellation or overwrite state. */
function verifiedRetainedCustomerCorrection(input:ConversationRecallInput):
  {value:number;unit:string;text:string;source_id:string}|null {
  const m=input.memory,c=input.commerce,rows=input.trusted_visitor_source_rows;
  if(!m||!c||input.trusted_visitor_source_status!=="verified"||!rows?.length||
    m.company_id!==input.company_id||m.conversation_id!==input.conversation_id||
    c.company_id!==input.company_id||c.conversation_id!==input.conversation_id||
    m.commerce_state_revision!==c.revision)return null;
  const latest=latestRetainedQuantity(m);
  if(!latest)return null;
  const text=m.latest_corrections[latest.index];
  const norm=(s:string)=>s.normalize("NFKC").replace(/\s+/gu," ").trim();
  const source=rows.filter(r=>r.id!==input.source_message_id &&
    typeof r.content==="string"&&norm(r.content)===norm(text));
  if(source.length!==1)return null;
  const at=rows.findIndex(r=>r.id===source[0].id);
  if(at<0||rows.slice(0,at).some(r=>r.id!==input.source_message_id &&
    retainedQuantity(r.content)!==null && retainedQuantity(r.content)!==latest.value))return null;
  const unit = retainedQuantityLiteral(text)?.unit;
  return unit ? {value:latest.value,unit,text,source_id:source[0].id} : null;
}

/** A canonical active portion and the cancelled legacy aggregate can
 * coexist after one source-proven partial cancellation. A current count is
 * attested by the same original correction; it is not the old aggregate. */

/** Accepted typed read selects an existing committed pair only. No industry
 * name/unit list, no parsed historical answer, and no model-proposed value.
 * This is deliberately a whole-turn, read-only quantity/status request. */
function selectSourceBoundPartitionRead(input:QuantityQueryScope & {question:string}):CanonicalUnitPartition|null {
  const c=input.commerce, r=input.quantity_reading, f=r?.frame, q=input.question;
  if (!c || !r || !f || input.explicit_handoff || !input.company_id || !input.conversation_id ||
      !input.source_message_id || c.company_id!==input.company_id || c.conversation_id!==input.conversation_id ||
      r.company_id!==input.company_id || r.conversation_id!==input.conversation_id ||
      r.source_message_id!==input.source_message_id || r.commerce_revision!==c.revision ||
      !Number.isSafeInteger(c.revision) || c.revision<1 ||
      f.version!=="commerce-semantic-1.0.0" || f.operation!=="ASK_FACT" ||
      f.intent!=="customer_fact_recall" || f.confidence<0.72 || f.ambiguity.is_ambiguous ||
      f.customer_correction || f.additive || f.explicit_negations.length || f.customer_facts?.length ||
      f.entities.length || [f.transaction_state,f.payment_state,f.booking_state,f.fulfillment_state]
        .some(s=>s!=="none"&&s!=="unknown") ||
      !isReadOnlyMemoryOrCurrentStateRecall(q,f) || any(withoutExcludedLookups(q),EXTERNAL)) return null;
  const fields=(values:readonly string[])=>values.length===2 && values.includes("quantity") && values.includes("entity_status");
  const d=f.demands?.[0];
  if (!fields(f.requested_facts) || f.demands?.length!==1 || !d || d.source_type!=="general" ||
      d.ambiguity.is_ambiguous || d.customer_correction || d.explicit_negations.length ||
      Object.keys(d.constraints).length || !fields(d.requested_facts) ||
      d.source_quote.normalize("NFKC").trim()!==q.normalize("NFKC").trim() ||
      d.question.normalize("NFKC").trim()!==q.normalize("NFKC").trim() || !d.subject_refs.length ||
      !f.referents.length) return null;
  // Keep the existing mutation detector. An interrogative status clause
  // (including a passive lifecycle question) is not a mutation solely
  // because it contains a lifecycle verb. Require the existing question cue
  // and read-only guard in that clause; do not admit an imperative tail.
  if (splitCustomerOperationClauses(q).some(clause =>
      ["CORRECTION","CUSTOMER_CONTEXT_UPDATE","EXPLICIT_HANDOFF"].includes(classifyCanonicalConversationTurn(clause,[]).operation) ||
      customerRecallHasAction(clause) && !( /[?？]$/u.test(clause) && any(clause,ASK) &&
        isReadOnlyMemoryOrCurrentStateRecall(clause,f)))) return null;
  const pairs=canonicalUnitPartitions(c.state,c.source_message_id).filter(pair=>{
    const refs=[pair.parent.entity_id,...sourceOwnedSubjectLabels(pair.parent)];
    const matches=(ref:string)=>refs.some(value=>keyNorm(value)===keyNorm(ref));
    if (!d.subject_refs.every(matches) || !f.referents.every(ref=>ref.confidence>=0.72 &&
      ["prior_turn","persistent_state"].includes(ref.source) && matches(ref.ref))) return false;
    const named=c.state.entities.filter(e=>sourceOwnedSubjectLabels(e).some(label=>phrase(q,label)));
    if (named.some(e=>e.entity_id!==pair.parent.entity_id&&e.entity_id!==pair.child.entity_id)) return false;
    // A short unit-only followup is safe only when the existing canonical
    // subject is unique. The unit is the committed literal, not an allowlist.
    return named.length>0 || c.state.entities.length===2 && phrase(q,pair.unit);
  });
  return pairs.length===1?pairs[0]:null;
}
export function isSourceBoundPartitionReadRequest(input:QuantityQueryScope & {question:string}):boolean {
  return selectSourceBoundPartitionRead(input)!==null;
}

/** Both portions must agree with the persisted Memory and current Commerce
 * revision. The original scoped Visitor correction is required; neither
 * latest_corrections nor a closed unit vocabulary supplies the authority. */
function resolveSourceVerifiedUnitPartition(input:ConversationRecallInput):ConversationRecallDecision|null {
  const pair=selectSourceBoundPartitionRead(input),m=input.memory,c=input.commerce;
  if (!pair || !m || !c || !hasTrustedPersistedMemoryReadback(input) ||
      input.trusted_visitor_source_status!=="verified" ||
      pair.source===input.source_message_id ||
      c.source_message_id!==pair.source) return null;
  // Memory's latest receipt may belong to a subsequent read-only question.
  // The parent quantity and excluded child must still point at the same
  // original correction and the exact current Commerce revision.
  const retainedFact=m.current_customer_facts.filter(f=>f.key==="entity:"+pair.parent.entity_id+":quantity");
  if(retainedFact.length!==1 || retainedFact[0].entity_id!==pair.parent.entity_id ||
      retainedFact[0].authority!=="canonical_commerce" || retainedFact[0].value!==pair.parent.quantity ||
      retainedFact[0].source_message_id!==pair.source) return null;
  const source=input.trusted_visitor_source_rows?.filter(row=>row.id===pair.source)??[];
  if (source.length!==1 || !source[0].content.trim() || source[0].content.length>2400 ||
      !phrase(source[0].content,pair.unit)) return null;
  const active=m.active_entities.filter(e=>e.entity_id===pair.parent.entity_id);
  const inactive=m.cancelled_or_superseded.filter(e=>e.key==="entity:"+pair.child.entity_id);
  if (active.length!==1 || active[0].status!=="active" || active[0].quantity!==pair.parent.quantity ||
      active[0].requested_quantity!==pair.parent.quantity ||
      !sameCanonicalJson(active[0].current_requirements,{...pair.parent.attributes,...pair.parent.constraints}) ||
      m.active_entities.some(e=>e.entity_id===pair.child.entity_id) ||
      inactive.length!==1 || inactive[0].entity_id!==pair.child.entity_id ||
      inactive[0].authority!=="canonical_commerce" || inactive[0].value!==pair.status ||
      inactive[0].source_message_id!==pair.source) return null;
  // The retained count and unit must occur in the exact verified source.
  // The inactive count is the committed linked portion, independently checked
  // against the parent's inactive constraint and Memory status above.
  const text=source[0].content.normalize("NFKC");
  const words:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
  const numbers=[...numberTokens(text),...Array.from(text.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/giu),
    match=>({value:words[match[1].toLowerCase()],start:match.index!,end:match.index!+match[0].length}))];
  if (!numbers.some(n=>n.value===pair.parent.quantity && phrase(text.slice(n.end).trimStart(),pair.unit) &&
    text.slice(n.end).trimStart().toLowerCase().startsWith(pair.unit.normalize("NFKC").toLowerCase()))) return null;
  const evidence=(entity:CommerceEntity,field:"quantity"|"entity_status",temporal_scope:"current"|"excluded"):RecallEvidence=>({
    fact_type:field,state_path:"entities."+c.state.entities.indexOf(entity)+"."+(field==="quantity"?"quantity":"status"),
    value:field==="quantity"?entity.quantity:entity.status,
    authority:"CANONICAL_COMMERCE_STATE",entity_id:entity.entity_id,entity_label:pair.label,
    region:typeof entity.attributes.region==="string"?entity.attributes.region:null,
    evidence_source_message_id:pair.source,temporal_scope,source_kind:"canonical_partial_unit_partition",
    ...(field==="quantity"?{quantity_unit:pair.unit,quantity_unit_source_kind:"canonical_customer_attribute" as const,
      quantity_unit_source_message_id:pair.source}:{})
  });
  const facts=[evidence(pair.parent,"quantity","current"),evidence(pair.child,"quantity","excluded"),
    evidence(pair.child,"entity_status","excluded")];
  return {handled:true,authority:"CANONICAL_COMMERCE_STATE",fact_type:"quantity+unit_partition",
    state_path:facts.map(e=>e.state_path).join("|"),value:facts.map(e=>({fact_type:e.fact_type,entity_id:e.entity_id,value:e.value})),
    provenance:{company_id:input.company_id,conversation_id:input.conversation_id,source_message_id:input.source_message_id,
      memory_revision:m.memory_revision,commerce_state_revision:c.revision,commerce_source_message_id:c.source_message_id,evidence:facts}};
}

function resolveSourceVerifiedCanonicalActiveRetention(
  input:ConversationRecallInput,
):ConversationRecallDecision|null {
  if(input.explicit_handoff||!isCurrentEffectiveQuantityRecall(input.question, input)||
    customerRecallHasAction(input.question)||
    input.trusted_visitor_source_status!=="verified"||
    !hasTrustedPersistedMemoryReadback(input))return null;
  const parsed=parseQuery(input.question, [], [], false, input);
  if(parsed.stop||parsed.facts.length!==2||
    !parsed.facts.includes("quantity")||
    !parsed.facts.includes("entity_status")||
    !asksRetainedQuantity(input.question)||
    !asksInactiveEntityStatus(input.question)||
    any(withoutExcludedLookups(input.question),EXTERNAL))return null;
  const m=input.memory,c=input.commerce;
  if(!m||!c||m.company_id!==input.company_id||c.company_id!==input.company_id||
    m.conversation_id!==input.conversation_id||c.conversation_id!==input.conversation_id||
    m.commerce_state_revision!==c.revision||
    m.source_message_id!==c.source_message_id)return null;
  const corrected=verifiedRetainedCustomerCorrection(input);
  if(!corrected||corrected.source_id!==m.source_message_id||
    !/(?:取消|cancel)/iu.test(corrected.text))return null;
  const active=c.state.entities.filter(isCurrentEntity);
  const cancelled=c.state.entities.filter(e=>e.status==="cancelled");
  if(c.state.entities.length!==2||active.length!==1||cancelled.length!==1||
    (active[0].status!=="tentative"&&active[0].status!=="researching"))return null;
  const current=active[0],historical=cancelled[0];
  // A formerly collapsed customer goal may have generic_product category
  // while its exactly matching customer-owned retained entity has a specific
  // category. Only byte-identical persisted customer product names allow
  // this cross-schema representation, never an inferred industry default.
  const sameSourceOwnedProduct=current.category===historical.category ||
    (historical.category==="generic_product" &&
      historical.entity_id.startsWith("generic:") &&
      typeof historical.attributes.product_name==="string" &&
      historical.attributes.product_name.length>=2 &&
      historical.attributes.product_name===current.attributes.product_name);
  // Match the user's short subject against the *stored customer source* using
  // the existing read-only resolver. A legacy collapsed name such as a named
  // set of items is not expected to be repeated verbatim in a quantity query.
  // The only acceptable ambiguity is precisely these two same-source records.
  const readSubject=resolveSourceOwnedSubject(c.state,input.question,
    {include_inactive:true,mode:"read"});
  const exactNamedPair=entityAliases(current).some(label=>
    phrase(input.question,label)) &&
    entityAliases(historical).some(label=>phrase(input.question,label));
  const legacySourcedPair=historical.category==="generic_product" &&
    sameSourceOwnedProduct && readSubject.kind==="ambiguous" &&
    readSubject.entity_ids.length===2 &&
    readSubject.entity_ids.includes(current.entity_id) &&
    readSubject.entity_ids.includes(historical.entity_id);
  const sourceBoundPairQuestionMatch=exactNamedPair||legacySourcedPair;
  if(current.entity_id===historical.entity_id||
    !sameSourceOwnedProduct||
    current.provenance.source_type!=="customer"||
    historical.provenance.source_type!=="customer"||
    current.provenance.source_message_id!==corrected.source_id||
    historical.provenance.source_message_id!==corrected.source_id||
    !Number.isInteger(current.quantity)||current.quantity!==corrected.value||
    !sourceBoundPairQuestionMatch)return null;
  const cancelledLabel=correctedInactiveEntityLabel(input,historical);
  if(!cancelledLabel||!phrase(corrected.text,cancelledLabel))return null;
  // Both records are customer-owned. The active number is independently
  // attested by the original correction, even if the cancelled aggregate
  // retained historical quantity_basis bookkeeping. No state is written.
  const facts:RecallEvidence[]=[
    {fact_type:"quantity",state_path:"entities."+c.state.entities.indexOf(current)+".quantity",
      quantity_unit: typeof current.attributes.unit === "string" ? current.attributes.unit : corrected.unit,
      value:current.quantity,authority:"CANONICAL_COMMERCE_STATE",
      entity_id:current.entity_id,
      entity_label:customerOwnedDisplayLabel(current),
      region:typeof current.attributes.region==="string"?current.attributes.region:null,
      evidence_source_message_id:corrected.source_id,
      temporal_scope:"current",source_kind:"canonical_state"},
    {fact_type:"entity_status",state_path:"entities."+c.state.entities.indexOf(historical)+".status",
      value:"cancelled",authority:"CANONICAL_COMMERCE_STATE",
      entity_id:historical.entity_id,entity_label:cancelledLabel,
      region:typeof historical.attributes.region==="string"?historical.attributes.region:null,
      evidence_source_message_id:corrected.source_id,
      temporal_scope:"current",source_kind:"canonical_state"},
  ];
  return {handled:true,authority:"CANONICAL_COMMERCE_STATE",
    fact_type:"quantity+entity_status",
    state_path:facts.map(e=>e.state_path).join("|"),
    value:facts.map(e=>({fact_type:e.fact_type,entity_id:e.entity_id,value:e.value})),
    provenance:{conversation_id:input.conversation_id,company_id:input.company_id,
      source_message_id:input.source_message_id,memory_revision:m.memory_revision,
      commerce_state_revision:c.revision,commerce_source_message_id:c.source_message_id,
      evidence:facts}};
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

/** A cross-language subject may be selected by one semantic referent,
 * never by a hard-coded product synonym. Verify current server-owned
 * Company/Ticket/revision and the original source row for this exact entity.
 * The ephemeral question phrase is NOT written as a customer alias. */
function verifiedSemanticRecapTarget(input:ConversationRecallInput):CommerceEntity|null {
  const c=input.commerce,m=input.memory;
  const proposal=input.customer_recall_proposal;
  const summaryInquiry=proposal?.requested_facts.length===1 && keyNorm(proposal.requested_facts[0])==="summary" &&
    parseQuery(input.question).facts.every(fact=>fact==="summary");
  if(!c||!m||input.explicit_handoff||
    input.trusted_visitor_source_status!=="verified"||
    !input.company_id||!input.conversation_id||!input.source_message_id||
    c.company_id!==input.company_id||c.conversation_id!==input.conversation_id||
    m.company_id!==input.company_id||m.conversation_id!==input.conversation_id||
    m.commerce_state_revision!==c.revision||
    (!hasRequirementsRecapCue(input.question)&&!summaryInquiry))return null;
  if(proposal && (proposal.company_id!==input.company_id || proposal.conversation_id!==input.conversation_id ||
    proposal.source_message_id!==input.source_message_id || proposal.intent!=="customer_fact_recall" ||
    proposal.requested_facts.some(fact=>fact!=="summary")))return null;
  const allowed=(input.referents??[]).filter(r=>r.confidence>=0.9&&
    ["persistent_state","prior_turn","canonical_commerce"].includes(r.source??""));
  if(allowed.length!==1)return null;
  const matches=c.state.entities.filter(e=>e.entity_id===allowed[0].ref&&
    e.provenance.source_type==="customer" &&
    !["cancelled","deferred","superseded"].includes(e.status) &&
    typeof e.provenance.source_message_id==="string"&&
    e.provenance.source_message_id.length>0);
  if(matches.length!==1)return null;
  const entity=matches[0];
  const sources=(input.trusted_visitor_source_rows??[]).filter(row=>
    row.id===entity.provenance.source_message_id);
  if(sources.length!==1||!entityAliases(entity).some(name=>
    phrase(sources[0].content,name)))return null;
  // The accepted hint cannot override an explicitly competing source-owned
  // identity or invent the binding of an unknown model-shaped identifier.
  if(c.state.entities.some(other=>other.entity_id!==entity.entity_id &&
    [other.entity_id,...sourceOwnedSubjectLabels(other)].some(name=>phrase(input.question,name))))return null;
  const identifiers=input.question.match(/\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gi)??[];
  if(identifiers.some(identifier=>!entityAliases(entity).some(name=>keyNorm(identifier)===keyNorm(name))))return null;
  return entity;
}
function verifiedSemanticRecapSelection(input:ConversationRecallInput):{entity:CommerceEntity;source_phrase:string}|null {
  const entity=verifiedSemanticRecapTarget(input);
  if(!entity || isCurrentRequirementsRecap(input.question))return null;
  // The existing whole-turn grammar below proves recap intent for both
  // imperatives and inquiries. A second keyword check would reject the same
  // source-verified target in "What are my ... requirements?".
  let sourcePhrase:string|null=null;
  const accepted=isCurrentRequirementsRecap(input.question,
    input.commerce?retainedRecapTargets(input.commerce.state):[],candidate=>{
      if(candidate.length<2||candidate.length>160||!phrase(input.question,candidate))return false;
      const proposal=input.customer_recall_proposal;
      // A scoped proposal must name a literal in this current grammar target.
      // Without one, retain only the already accepted exact-entity referent
      // contract above. No label or fact is stored from this ephemeral phrase.
      if(proposal && !proposal.subject_refs.some(ref=>ref.length>=2&&ref.length<=160&&
        phrase(candidate,ref)&&phrase(input.question,ref)))return false;
      sourcePhrase=candidate;
      return true;
    });
  return accepted&&sourcePhrase?{entity,source_phrase:sourcePhrase}:null;
}

/** Current-turn scope is authoritative; fallback focus never turns a global recap into a scoped one. */
function summarySelection(input: ConversationRecallInput, entities: CommerceEntity[]): {
  provenance: "explicit_identity" | "explicit_category" | "trusted_referent" | "global";
  entities: CommerceEntity[];
} {
  const semantic=verifiedSemanticRecapSelection(input);
  if(semantic)
    return {provenance:"trusted_referent",entities:entities.filter(e=>
      e.entity_id===semantic.entity.entity_id)};
  const literalAliases=entities.filter(entity=>persistedRecapAliases(entity).some(alias=>phrase(input.question,alias)));
  if(literalAliases.length){
    const current=input.commerce&&input.memory&&input.commerce.company_id===input.company_id&&
      input.commerce.conversation_id===input.conversation_id&&input.memory.company_id===input.company_id&&
      input.memory.conversation_id===input.conversation_id&&input.memory.commerce_state_revision===input.commerce.revision;
    const scoped=literalAliases.filter(entity=>persistedRecapAliases(entity,input).some(alias=>phrase(input.question,alias)));
    return {provenance:"explicit_identity",entities:current&&scoped.length===1?scoped:[]};
  }
  const identity = entities.filter(e => any(input.question, [e.entity_id, e.model,
    ...["product_name", "display_name", "original_name", "sku"].map(k => e.attributes[k])]
    .filter((v): v is string => typeof v === "string" && v.length > 0)));
  if (identity.length) return { provenance: "explicit_identity", entities: identity };
  // An explicitly named but unknown identifier cannot fall back to a portfolio recap.
  // This is identifier syntax, independent of category, tenant and fixture values.
  const identifiers = input.question.match(/\b(?=[a-z0-9-]*[a-z])(?=[a-z0-9-]*\d)[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gi) ?? [];
  if (identifiers.length) return { provenance: "explicit_identity", entities: [] };
  const resolved=input.commerce ? resolveSourceOwnedSubject(input.commerce.state,input.question,{include_inactive:true}) : {kind:"none"} as const;
  const explicit=resolved.kind==="one" ? entities.filter(e=>e.entity_id===resolved.entity.entity_id)
    : resolved.kind==="ambiguous" ? entities.filter(e=>resolved.entity_ids.includes(e.entity_id))
    : entities.filter(e=>any(input.question,entityAliases(e)));
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

function retainedQuantityLiteral(text: string): { quantity: number; unit: string } | null {
  const match = norm(text).match(
    /(?:只|僅|仅|目前|現在|现在|而家|實際|实际)?\s*(?:保留|留下|剩下|剩餘|剩余|餘下|余下|keep|kept|retain|retained|remain(?:ing)?)\D{0,48}?([一二兩两三四五六七八九十]|\d{1,4})\s*(部|台|件|個|个|套|units?|items?)/i,
  );
  if (!match?.[1] || !match[2]) return null;
  const quantity = /^\d+$/.test(match[1]) ? Number(match[1]) : ({
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
  return quantity === null ? null : { quantity, unit: match[2] };
}
function retainedQuantity(text: string): number | null {
  return retainedQuantityLiteral(text)?.quantity ?? null;
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
export function isCurrentEffectiveQuantityRecall(question: string, scope?: QuantityQueryScope): boolean {
  const parsed = parseQuery(question, [], [], false, scope);
  if (parsed.stop || !parsed.facts.includes("quantity") ||
      (!isReadOnlyMemoryOrCurrentStateRecall(question) && !sourceBoundQuantityQuery(question, scope)) ||
      customerRecallHasAction(question)) return false;
  return asksRetainedQuantity(question) ||
    /(?:目前|現在|现在|而家|現時|现时|實際|实际|最新|更正後|更正后|取消後|取消后)|\b(?:current|currently|now|actual|latest|remaining)\b/iu
      .test(question.replace(/\bjust\s+now\b/giu, ""));
}


/** Task3C D3: the only source-admission read used by both recall resolvers.
 * The caller must pass actual server-fetched history, never widget or model
 * rows. No model/KB traffic, at most five missing Visitor IDs in one DB read.
 * F1/F3/F8; S3/S2/S4. */
export type TrustedRecallReadStatus =
  "verified" | "not_requested" | "missing" | "failed" | "over_cap";
export interface TrustedRecallVisitorRow {
  id: string;
  conversation_id: string;
  role: string;
  is_recalled: boolean;
  content: string;
  created_at?: string | null;
}
export async function loadScopedRecallVisitorSources(input: {
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  question: string;
  memory: CanonicalConversationMemory | null;
  commerce: RecallCommerceSnapshot | null;
  requested_facts?: readonly string[];
  /** Caller supplies the accepted, exact-source status frame only for the
   * existing attributed enquiry-status read. This is not transaction authority. */
  quote_status_frame?: CommerceSemanticFrame | null;
  quantity_reading?: ConversationRecallInput["quantity_reading"];
  enabled: boolean;
  recent_rows: readonly TrustedRecallVisitorRow[] | null;
  fetch_missing: (ids: readonly string[]) => Promise<{
    rows: readonly TrustedRecallVisitorRow[] | null;
    error?: unknown;
  }>;
}): Promise<{
  status: TrustedRecallReadStatus;
  rows: ReadonlyArray<{ id: string; content: string }>;
  targeted_count: number;
}> {
  const denied = (status: TrustedRecallReadStatus, targeted_count = 0) =>
    ({ status, rows: [] as Array<{ id: string; content: string }>, targeted_count });
  const scope = input;
  if (!scope.company_id || !scope.conversation_id || !scope.source_message_id ||
      (scope.memory && (scope.memory.company_id !== scope.company_id ||
        scope.memory.conversation_id !== scope.conversation_id)) ||
      (scope.commerce && (scope.commerce.company_id !== scope.company_id ||
        scope.commerce.conversation_id !== scope.conversation_id)) ||
      (scope.memory && scope.commerce &&
        scope.memory.commerce_state_revision !== scope.commerce.revision)) {
    return denied("failed");
  }
  if (!Array.isArray(scope.recent_rows)) return denied("failed");
  const validRow = (row: TrustedRecallVisitorRow) =>
    row && typeof row.id === "string" && row.id !== scope.source_message_id &&
    row.conversation_id === scope.conversation_id && row.role === "visitor" &&
    row.is_recalled === false && typeof row.content === "string" &&
    row.content.length > 0 && row.content.length <= 2400 &&
    row.content !== "__THINKING__";
  const recent = scope.recent_rows.filter(validRow).map(row =>
    ({ id: row.id, content: row.content }));
  if (new Set(recent.map(row => row.id)).size !== recent.length) return denied("failed");
  const area=scope.commerce && scope.commerce.state.customer_constraints[SCOPED_AREA_KEY]!=null && (scope.requested_facts?.some(key=>keyNorm(key)==="roomsize") || isCurrentRequirementsRecap(scope.question) ||
    parseQuery(scope.question,[],[],false,scope).facts.some(f=>f==="summary" || f==="room_size"))
    ? readScopedAreaReceipt(scope.commerce.state,{...scope,state_revision:scope.commerce.revision}):null;
  if (!scope.enabled && !area) return { status: "not_requested", rows: recent, targeted_count: 0 };

  const originalFacts = parseQuery(scope.question, [], [], false, scope).facts;
  const names = new Set([...(scope.requested_facts ?? []).map(keyNorm),
    ...originalFacts.map(keyNorm)]);
  const interested = (key: string) => !names.size ||
    names.has(keyNorm(key)) || originalFacts.some(f => keyMatches(key, f));
  const ids: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && id !== scope.source_message_id && !ids.includes(id)) ids.push(id);
  };
  const quoteStatusRead=isSourceBoundQuoteStatusQuestion(scope.question,scope.quote_status_frame);
  if(area){
    for(const source of scopedAreaSources(area))add(source.id);
    for(const row of [...area.current,...area.superseded])add(row.prior_literal_source_id);
  }
  for (const fact of scope.memory?.current_customer_facts ?? []) {
    if (fact.authority === "customer" &&
        (interested(fact.key)||quoteStatusRead&&fact.key==="customer_reported_quote_request"&&quotationReportText(fact.value)))
      add(fact.source_message_id);
  }
  for (const entity of scope.commerce?.state.entities ?? []) {
    if (isCurrentEntity(entity) && originalFacts.some(f =>
      ["quantity", "room_size", "horsepower", "brand_constraint",
       "constraints", "preferences"].includes(f))) {
      add(entity.provenance.source_type === "customer"
        ? entity.provenance.source_message_id : null);
    }
  }
  if (originalFacts.some(f => ["address", "contact", "recipient",
      "delivery_preference", "delivery_status"].includes(f))) {
    add(scope.commerce?.state.delivery.provenance?.source_message_id);
  }
  // The effective retained count is a source-owned correction, even when the
  // prior multi-part goal was represented as one cancelled legacy entity.
  // Admit its exact Visitor source to the existing bounded scoped lookup,
  // not an unverified number or an inactive entity as a current quantity.
  const retainedSource=scope.memory?.source_message_id;
  if (originalFacts.includes("quantity") && asksRetainedQuantity(scope.question) &&
      scope.memory && scope.commerce &&
      scope.memory.commerce_state_revision===scope.commerce.revision &&
      retainedSource && retainedSource===scope.commerce.source_message_id &&
      scope.memory.latest_corrections.some(row=>retainedQuantity(row)!==null) &&
      scope.commerce.state.entities.some(e=>e.status==="cancelled" &&
        e.provenance.source_type==="customer" &&
        e.provenance.source_message_id===retainedSource))
    add(retainedSource);
  const structuredQuantity=selectStructuredQuantitySubject(scope);
  if(structuredQuantity)add(structuredQuantity.provenance.source_message_id);
  const partition=selectSourceBoundPartitionRead(scope);
  if(partition)add(partition.source);
  const needed = ids.filter(id => !recent.some(row => row.id === id));
  // Only absent source rows cost a targeted DB read. A long canonical source
  // lineage already present in verified recent history is not an over-cap read.
  if (needed.length > 5) return denied("over_cap", needed.length);
  // No candidate source ID is not a verified failed lookup: original
  // canonical transaction states remain under their separate authority.
  if (!needed.length) return { status: ids.length ? "verified" : "not_requested",
    rows: recent, targeted_count: 0 };
  let fetched: Awaited<ReturnType<typeof scope.fetch_missing>>;
  try {
    fetched = await scope.fetch_missing(needed);
  } catch {
    return denied("failed", needed.length);
  }
  if (fetched.error || !Array.isArray(fetched.rows)) return denied("failed", needed.length);
  if (fetched.rows.some(row => !validRow(row) || !needed.includes(row.id)) ||
      new Set(fetched.rows.map(row => row.id)).size !== fetched.rows.length) {
    return denied("failed", needed.length);
  }
  if (fetched.rows.length !== needed.length) return denied("missing", needed.length);
  return { status: "verified",
    rows: [...recent, ...fetched.rows.map(row => ({ id: row.id, content: row.content }))],
    targeted_count: needed.length };
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
  // A summary of the current canonical state is not a scalar claim about
  // words in this new Visitor turn. Delegate only a whole-turn recap to the
  // existing canonical resolver, which retains the original Company/Ticket,
  // committed Memory/Commerce source, revision and entity-selection checks.
  // All historical scalar facts still require the exact-source checks below.
  if(proposal.requested_facts.length===1 && keyNorm(proposal.requested_facts[0])==="summary") {
    const targets=input.commerce?retainedRecapTargets(input.commerce.state):[];
    const semantic=verifiedSemanticRecapSelection(input);
    if(semantic)targets.push(semantic.source_phrase);
    if(isCurrentRequirementsRecap(input.question,targets))return null;
  }
  // A semantic recall label cannot replace effective state with a quote.
  // The original resolver keeps canonical conflict and lifecycle checks.
  if(isCurrentEffectiveQuantityRecall(input.question, input))return null;
  // A caller without a server-owned source verification result cannot
  // establish historical customer speech, even if it supplies retained facts.
  if (input.trusted_visitor_source_status !== "verified")
    return fail("AMBIGUOUS","CUSTOMER_SOURCE_NOT_VERIFIED");
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
    if(!isLegacyRoomAreaKey(key)&&!keyMatches(key,"room_size")&&!UNSAFE_CUSTOMER_RECALL_KEY.test(key)&&!fields.some(f=>f.keys.some(k=>keyNorm(k)===keyNorm(key)))&&
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
    if(fact.authority!=="customer"||isLegacyRoomAreaKey(fact.key)||keyMatches(fact.key,"room_size")||!field.keys.some(k=>keyNorm(k)===keyNorm(fact.key))||
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
      ...(field.fact==="quantity"?attestedCanonicalQuantityUnit(input,fact.value,fact.source_message_id,fact.entity_id??null)??{}:{}),
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
type QuantityUnitEvidence = Pick<RecallEvidence,
  "quantity_unit" | "quantity_unit_source_kind" | "quantity_unit_source_message_id">;

/** Unit text comes from the same customer-owned canonical entity. It remains
 * literal display data; a category, translation or rendering locale supplies
 * no substitute. Bound the label without enumerating industries or units. */
function canonicalCustomerQuantityUnit(entity: CommerceEntity): QuantityUnitEvidence | null {
  const unit=entity.attributes.unit, source=entity.provenance.source_message_id;
  if(entity.provenance.source_type!=="customer" || typeof source!=="string" || !source.trim() ||
    typeof unit!=="string" || !unit.trim() || unit.length>64 ||
    !/^[\p{L}\p{N}\p{M}]+(?:[ ./_-][\p{L}\p{N}\p{M}]+)*$/u.test(unit))return null;
  return {quantity_unit:unit,quantity_unit_source_kind:"canonical_customer_attribute",
    quantity_unit_source_message_id:source};
}

/** An earlier-utterance count may display a current canonical unit only when
 * that same source, number and unit still agree. A newer unit cannot relabel
 * an older customer statement, and a source-free Memory scalar cannot borrow
 * another item's unit. This adds display provenance, never a fact candidate. */
function attestedCanonicalQuantityUnit(input:ConversationRecallInput,value:unknown,sourceId:string,entityId:string|null):QuantityUnitEvidence|null {
  const c=input.commerce,m=input.memory;
  if(!c||!m||typeof value!=="number"||!Number.isFinite(value)||
    input.trusted_visitor_source_status!=="verified"||
    c.company_id!==input.company_id||c.conversation_id!==input.conversation_id||
    m.company_id!==input.company_id||m.conversation_id!==input.conversation_id||m.commerce_state_revision!==c.revision)return null;
  const originals=(input.trusted_visitor_source_rows??[]).filter(row=>row.id===sourceId);
  if(originals.length!==1)return null;
  const candidates=c.state.entities.filter(entity=>(!entityId||entity.entity_id===entityId)&&
    isCurrentEntity(entity)&&entity.provenance.source_message_id===sourceId&&customerRequestedQuantity(entity)===value);
  if(candidates.length!==1)return null;
  const unit=canonicalCustomerQuantityUnit(candidates[0]);
  if(!unit?.quantity_unit)return null;
  const found=literalQuantityUnitTokens(originals[0].content,unit.quantity_unit);
  return found.length===1&&found[0].value===value?unit:null;
}

/** Reuse the exact source number/unit attestation, never an industry list. */
function literalQuantityUnitTokens(text:string,unit:string):Array<{value:number;start:number;end:number}> {
  const source=text.normalize("NFKC"),literal=unit.normalize("NFKC");
  const words:Record<string,number>={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
  const numbers=[...numberTokens(source),...Array.from(source.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/giu),
    match=>({value:words[match[1].toLowerCase()],start:match.index!,end:match.index!+match[0].length}))];
  return numbers.filter(number=>{
    const after=source.slice(number.end).trimStart();
    return after.toLowerCase().startsWith(literal.toLowerCase()) &&
      (/[\p{Script=Han}]$/u.test(literal)||!/[\p{L}\p{N}_]/u.test(after[literal.length]??""));
  });
}

/** An accepted subject/field is only a candidate until current Memory,
 * Commerce and one original same-ticket Visitor statement agree. Do not
 * borrow a historical quote, merchant value or model-proposed quantity.
 * The existing B2, read-only, source and CAS consumers remain authoritative. */
function structuredQuantityEvidence(input:ConversationRecallInput):RecallEvidence|null {
  const e=selectStructuredQuantitySubject(input),m=input.memory,c=input.commerce;
  if(!e||!m||!c||input.trusted_visitor_source_status!=="verified"||
    m.version!=="conversation-memory-1.0.0"||m.company_id!==input.company_id||
    m.conversation_id!==input.conversation_id||!Number.isSafeInteger(m.memory_revision)||m.memory_revision<1||
    m.commerce_state_revision!==c.revision||
    (m.source_message_id!==input.source_message_id&&!hasTrustedPersistedMemoryReadback(input)))return null;
  const sid=e.provenance.source_message_id;
  if(!sid)return null;
  const key="entity:"+e.entity_id+":quantity", facts=m.current_customer_facts.filter(f=>f.key===key);
  const active=m.active_entities.filter(a=>a.entity_id===e.entity_id);
  if(facts.length!==1||facts[0].authority!=="canonical_commerce"||facts[0].entity_id!==e.entity_id||
    facts[0].source_message_id!==sid||facts[0].value!==e.quantity||
    active.length!==1||active[0].status!=="active"||active[0].quantity!==e.quantity||
    active[0].requested_quantity!==e.quantity||
    active[0].current_requirements.unit!==e.attributes.unit||
    m.cancelled_or_superseded.some(f=>f.entity_id===e.entity_id&&f.source_message_id===sid))return null;
  const rows=input.trusted_visitor_source_rows??[];
  if(!rows.length||rows.length>500||new Set(rows.map(row=>row.id)).size!==rows.length)return null;
  const index=rows.findIndex(row=>row.id===sid);
  if(index<0||!rows[index].content.trim()||rows[index].content.length>2400)return null;
  const unit=attestedCanonicalQuantityUnit(input,e.quantity,sid,e.entity_id);
  if(!unit?.quantity_unit)return null;
  const label=sourceOwnedSubjectLabels(e);
  const clauses=sourceClauses(rows[index].content);
  const bound=clauses.filter(clause=>label.some(name=>phrase(clause,name))&&
    literalQuantityUnitTokens(clause,unit.quantity_unit!).some(token=>token.value===e.quantity&&
      !/(?:[$€£¥]|HKD|USD|TWD|NTD|CNY)\s*$/iu.test(clause.slice(0,token.start))));
  if(bound.length!==1)return null;
  // A later unaccounted correction or a different literal count/unit can
  // invalidate this source. Money-only historical reports never supply count.
  const later=[...clauses.slice(clauses.indexOf(bound[0])+1),...rows.slice(0,index).map(row=>row.content)];
  if(later.some(text=>{
    const ours=label.some(name=>phrase(text,name));
    const other=c.state.entities.some(x=>x.entity_id!==e.entity_id&&
      sourceOwnedSubjectLabels(x).some(name=>phrase(text,name)));
    if(other&&!ours)return false;
    return customerRecallHasAction(text)||
      literalQuantityUnitTokens(text,unit.quantity_unit!).some(token=>token.value!==e.quantity);
  }))return null;
  return {fact_type:"quantity",state_path:"entities."+c.state.entities.indexOf(e)+".quantity",
    value:e.quantity,authority:"CURRENT_CUSTOMER_MEMORY",entity_id:e.entity_id,
    entity_label:customerOwnedDisplayLabel(e),region:facts[0].region??null,
    evidence_source_message_id:sid,temporal_scope:"current",
    source_kind:"attested_customer_utterance",attribute_key:key,...unit};
}

/** Private routing proposal for two disjoint clauses. No count, price or
 * transaction authority leaves the existing attested recall reader. */
export function isStructuredMixedQuantityCandidate(input:ConversationRecallInput):boolean {
  return Boolean(input.quantity_reading?.full_question &&
    input.quantity_reading.frame.demands?.length===2 && selectStructuredQuantitySubject(input));
}
export function resolveStructuredMixedQuantityBinding(input:ConversationRecallInput):
  {quote:string;merchant_quote:string;subject:string;unit:string}|null {
  if(!isStructuredMixedQuantityCandidate(input))return null;
  const evidence=structuredQuantityEvidence(input),e=selectStructuredQuantitySubject(input);
  if(!evidence?.quantity_unit||!e)return null;
  const subject=e.attributes.product_name??e.model??e.attributes.name;
  const original=input.trusted_visitor_source_rows?.find(row=>row.id===e.provenance.source_message_id);
  const merchant=input.quantity_reading!.frame.demands!.find(d=>d.source_type==="product");
  if(typeof subject!=="string"||!subject.trim()||!original||!phrase(original.content,subject)||!merchant)return null;
  return {quote:input.question,merchant_quote:merchant.source_quote,subject,unit:evidence.quantity_unit};
}

/** A unit in this already resolved quantity question may label the displayed
 * canonical number. It is not a new canonical fact and cannot change quantity,
 * subject selection, source provenance, or any persisted state. */
function currentQuestionQuantityUnit(
  input: ConversationRecallInput, question: string, entity: CommerceEntity,
): Pick<RecallEvidence, "quantity_unit" | "quantity_unit_source_kind" | "quantity_unit_source_message_id"> | null {
  const snapshot = input.commerce;
  if (!snapshot || snapshot.company_id !== input.company_id ||
      snapshot.conversation_id !== input.conversation_id || !input.source_message_id?.trim() ||
      !Number.isInteger(snapshot.revision) || snapshot.revision <= 0 ||
      !isCurrentEntity(entity) || entity.provenance.source_type !== "customer" ||
      !entity.provenance.source_message_id || customerRequestedQuantity(entity) === null ||
      (!isReadOnlyMemoryOrCurrentStateRecall(question) && !sourceBoundQuantityQuery(input.question, input)) ||
      sourceClauses(input.question).length !== 1 || sourceClauses(question).length !== 1 ||
      sourceClauses(input.question)[0] !== sourceClauses(question)[0]) return null;
  const reading = input.quantity_reading, frame = reading?.frame;
  if (!reading || !frame ||
      reading.company_id !== input.company_id || reading.conversation_id !== input.conversation_id ||
      reading.source_message_id !== input.source_message_id || reading.commerce_revision !== snapshot.revision ||
      frame.version !== "commerce-semantic-1.0.0" || frame.intent !== "customer_fact_recall" ||
      frame.operation !== "ASK_FACT" || frame.confidence < 0.72 || frame.ambiguity.is_ambiguous ||
      frame.additive || frame.customer_correction || frame.customer_facts?.length || frame.explicit_negations.length ||
      frame.entities.length !== 1 || frame.demands?.length !== 1 ||
      [frame.transaction_state, frame.payment_state, frame.booking_state, frame.fulfillment_state]
        .some(status => status !== "none" && status !== "unknown") ||
      frame.requested_facts.some(f => keyNorm(f) !== "quantity")) return null;
  const proposed = frame.entities[0], demand = frame.demands[0];
  // The legacy slot parser strips terminal punctuation. Bind the proof to the
  // original server-owned whole turn, not the derived slot; the single-clause
  // equality guard above still excludes mixed or foreign clauses.
  const source = input.question.normalize("NFKC").trim();
  const name = proposed.name.normalize("NFKC").trim().toLowerCase();
  const unit = proposed.unit;
  if (!source ||
      typeof unit !== "string" || unit !== unit.trim() || unit.length > 64 ||
      !/^[\p{L}\p{M}][\p{L}\p{M}\p{N} ._\/-]*$/u.test(unit) ||
      proposed.quantity !== entity.quantity || proposed.confidence < 0.72 ||
      proposed.entity_ref !== entity.entity_id || ["superseded"].includes(entity.status) ||
      !sourceOwnedSubjectLabels(entity).includes(name) ||
      demand.source_type !== "general" || demand.ambiguity.is_ambiguous ||
      demand.customer_correction || demand.explicit_negations.length ||
      demand.requested_facts.some(f => keyNorm(f) !== "quantity") ||
      demand.source_quote.normalize("NFKC").trim() !== source ||
      !demand.subject_refs.length ||
      demand.subject_refs.some(ref => ref !== entity.entity_id && ref.normalize("NFKC").trim().toLowerCase() !== name) ||
      frame.referents.some(ref => ref.ref !== entity.entity_id || ref.confidence < 0.72) ||
      /(?:\bor\b|\beither\b|或者|抑或|還是|还是|定係)/iu.test(source)) return null;
  const selected = selectEntities({ ...input, question: source, recent_questions: [], referents: [] }, snapshot.state.entities);
  if (selected.length !== 1 || selected[0].entity_id !== entity.entity_id ||
      snapshot.state.entities.some(other => other.entity_id !== entity.entity_id &&
        sourceOwnedSubjectLabels(other).some(label => phrase(input.question, label)))) return null;
  const owners = snapshot.state.entities.filter(other => isCurrentEntity(other) &&
    sourceOwnedSubjectLabels(other).includes(name));
  if (owners.length !== 1 || owners[0].entity_id !== entity.entity_id) return null;
  // A Reading proposes a unit; it never provides quantity authority.
  // Match a whole numeric token and the exact customer-written unit in
  // the same noun phrase as the committed label; do not infer unit aliases.
  const literalUnit = unit.normalize("NFKC");
  const numbers = numberTokens(source);
  if (numbers.length !== 1 || numbers[0].value !== entity.quantity) return null;
  const token = numbers[0];
  const following = source.slice(token.end);
  const leading = following.length - following.trimStart().length;
  const written = following.slice(leading, leading + literalUnit.length);
  if (written.toLowerCase() !== literalUnit.toLowerCase()) return null;
  const finish = token.end + leading + written.length;
  const lower = source.toLowerCase(), at = lower.indexOf(name);
  if (at < 0 || lower.indexOf(name, at + name.length) >= 0) return null;
  const gap = at + name.length <= token.start ? source.slice(at + name.length, token.start)
    : finish <= at ? source.slice(finish, at) : null;
  if (gap === null || !/^[\s:：()（）\[\]「」『』]*$/u.test(gap)) return null;
  if (!/[\p{Script=Han}]$/u.test(written) &&
      /[\p{L}\p{N}_]/u.test(source[finish] ?? "") && finish !== at) return null;
  return { quantity_unit: written, quantity_unit_source_kind: "current_customer_question",
    quantity_unit_source_message_id: input.source_message_id };
}

function attestedCustomerQuantity(
  input: ConversationRecallInput,
): Candidate | null {
  const memory = input.memory;
  const rows = input.trusted_visitor_source_rows;
  if (!memory || !rows?.length || rows.length > 500 ||
      !any(input.question, OWNER) ||
      !/(?:剛才|刚才|頭先|头先|之前|先前|曾經|曾经|講過|讲过|說過|说过|提過|提过|記得|记得|提到|mentioned|previously|earlier|told you|did (?:i|we) (?:say|mention|state)|(?:i|we) said)/iu.test(input.question)) return null;
  // A prior quantity may be attested without a display unit. Read a whole
  // source number and its scoped noun phrase/explicit total; a literal label
  // is not promoted into a measurement unit unless canonical proof supplies it.
  const subject = quantitySubject(input.question);
  const countsIn = (value: string, storedUnit?: string): number[] => {
    const source = value.normalize("NFKC");
    const named = subject?.normalize("NFKC").trim() ?? "";
    const totals: number[] = [], counts: number[] = [];
    const totalCue = /(?:合共|總共|总共|共計|共计|一共|總數|总数|in total|altogether|total(?: of)?)\s*(?:需|要|有|是|為|为|:|：)?\s*$/iu;
    const startsWithLabel = (text: string, label: string) => {
      if (!label || !text.toLowerCase().startsWith(label.toLowerCase())) return false;
      return /[\p{Script=Han}]$/u.test(label) || !/[\p{L}\p{N}_]/u.test(text[label.length] ?? "");
    };
    for (const clause of sourceClauses(source)) {
      for (const token of numberTokens(clause)) {
        if (!Number.isInteger(token.value) || token.value < 0 || token.value > 1000) continue;
        const before = clause.slice(0, token.start), after = clause.slice(token.end).trimStart();
        if (/(?:[$€£¥]|HKD|USD|TWD|NTD|CNY)\s*$/iu.test(before) ||
            /^(?:元|蚊|%|percent|dollars?|港幣|港币|台幣|台币)/iu.test(after)) continue;
        const direct = named && startsWithLabel(after, named);
        const saved = storedUnit && startsWithLabel(after, storedUnit) &&
          (!named || phrase(source, named));
        if (direct || saved) counts.push(token.value);
        if (!totalCue.test(before)) continue;
        // Chinese quantified noun phrases can repeat the counter in the
        // total clause and the subject elsewhere in this same source row.
        // Verify both literal spans, not a hard-coded counter vocabulary.
        const splitSubject = named && /^[\p{Script=Han}]{2,}$/u.test(named) &&
          Array.from(named).slice(1,-1).some((_,i) => {
            const n=i+1;
            return startsWithLabel(after,named.slice(0,n)) && phrase(source,named.slice(n));
          });
        if ((named ? direct || saved || splitSubject || phrase(clause,named) : !!after || hasField(before,"quantity")) &&
            (!named || direct || saved || splitSubject || phrase(source,named))) totals.push(token.value);
      }
    }
    return totals.length === 1 ? totals : totals.length > 1 ? [] : [...new Set(counts)];
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
    const savedUnit = attestedCanonicalQuantityUnit(input, fact.value, fact.source_message_id, fact.entity_id ?? null);
    const exact = countsIn(matching[0].content, savedUnit?.quantity_unit);
    if (exact.length !== 1 || exact[0] !== fact.value) continue;
    candidates.push({
      fact_type: "quantity", value: fact.value,
      ...attestedCanonicalQuantityUnit(input,fact.value,fact.source_message_id,fact.entity_id??null)??{},
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
  // D4-3: current canonical quantity can be attested by its ORIGINAL
  // same-tenant Visitor row when Memory has no duplicate quantity fact.
  // A provider-proposed amount or current merchant KB must never suffice.
  const commerce=input.commerce;
  if(!candidates.length&&commerce&&input.memory&&
    input.trusted_visitor_source_status==="verified"&&
    input.memory.commerce_state_revision===commerce.revision&&
    commerce.company_id===input.company_id&&commerce.conversation_id===input.conversation_id&&
    !input.memory.current_customer_facts.some(f=>f.authority==="customer"&&keyNorm(f.key)==="quantity")){
    const active=commerce.state.entities.filter(isCurrentEntity);
    const named=active.filter(e=>[e.model,e.attributes.product_name].some(v=>
      typeof v==="string"&&v.length>1&&phrase(input.question,v)));
    const selected=named.length===1?named:active.length===1?active:[];
    if(selected.length===1){
      const e=selected[0],id=e.provenance.source_message_id;
      const original=rows.filter(row=>row.id===id);
      const labels=[e.model,e.attributes.product_name].filter(
        (v):v is string=>typeof v==="string"&&v.length>1);
      const unit=canonicalCustomerQuantityUnit(e);
      // A prior-count question may name the customer's measurement unit
      // rather than repeat the item name. Only one active canonical item,
      // its exact stored unit and the same original source can resolve it.
      // A unit is never added as an entity alias or used to change state.
      const unitReference=active.length===1 && unit?.quantity_unit &&
        keyNorm(quantitySubject(input.question)??"")===keyNorm(unit.quantity_unit);
      // A literal shortened Han subject after the original counter is a
      // read-only reference, never a new alias or an inferred industry label.
      // Require one active entity and uniqueness even against inactive items.
      const writtenUnit=unit?.quantity_unit?.normalize("NFKC")??"";
      const writtenSubject=quantitySubject(input.question)?.normalize("NFKC")??"";
      const suffix=writtenUnit&&writtenSubject.startsWith(writtenUnit)
        ? writtenSubject.slice(writtenUnit.length):"";
      const matchesSuffix=(entity:CommerceEntity)=>
        [entity.model,entity.attributes.product_name].some(name=>
          typeof name==="string"&&name.normalize("NFKC").endsWith(suffix));
      const suffixReference=active.length===1&&/^\p{Script=Han}{2,24}$/u.test(suffix)&&
        labels.some(name=>name.normalize("NFKC").length>suffix.length&&
          name.normalize("NFKC").endsWith(suffix))&&
        commerce.state.entities.filter(matchesSuffix).length===1&&
        sourceClauses(input.question).length===1&&!customerRecallHasAction(input.question)&&
        !any(withoutExcludedLookups(input.question),EXTERNAL);
      if(e.provenance.source_type==="customer"&&id&&id!==input.source_message_id&&
        original.length===1&&labels.some(n=>phrase(original[0].content,n))&&
        (labels.some(n=>phrase(input.question,n))||unitReference||suffixReference)&&Number.isInteger(e.quantity)&&
        e.quantity>=0&&e.quantity<=1000){
        const attestedUnit=attestedCanonicalQuantityUnit(input,e.quantity,id,e.entity_id);
        const sourceIndex=rows.findIndex(row=>row.id===id);
        const superseded=sourceIndex<0||rows.slice(0,sourceIndex).some(row=>
          (labels.some(n=>phrase(row.content,n))||(suffixReference&&phrase(row.content,suffix)))&&
          /更正|改為|改为|取消|暫緩|暂缓|change|correct|cancel|defer/iu.test(row.content));
        if(attestedUnit&&!superseded){
          candidates.push({fact_type:"quantity",value:e.quantity,
            ...attestedUnit,
            state_path:"entities."+commerce.state.entities.indexOf(e)+".quantity",
            authority:"CURRENT_CUSTOMER_MEMORY",entity_id:e.entity_id,region:null,
            evidence_source_message_id:id,temporal_scope:"current",
            source_kind:"attested_customer_utterance",rank:-2});
        }
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function canonicalCandidates(
  input: ConversationRecallInput,
  f: RecallFact,
  selected: CommerceEntity[],
  question = input.question,
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
    const storedUnit=f==="quantity"&&entity?canonicalCustomerQuantityUnit(entity):null;
    out.push({
      fact_type: f,
      value: v,
      ...(storedUnit
        ? storedUnit
        : f === "quantity" && entity && selected.length === 1
          ? currentQuestionQuantityUnit(input, question, entity) ?? {} : {}),
      state_path: path,
      authority: rank === 0
        ? "CANONICAL_COMMERCE_STATE"
        : "CURRENT_CUSTOMER_MEMORY",
      entity_id: entity?.entity_id ?? null,
      entity_label: entity
        ? customerOwnedDisplayLabel(entity) ?? safeCustomerDisplayText(correctedInactiveEntityLabel(input, entity), entity.entity_id)
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
  if (["horsepower", "brand_constraint"].includes(f)) {
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

// Resolve references against the labels in the source receipt. Consume the
// complete request: an unmatched modifier or a second unknown referent must
// not borrow the first match's measurement.
function compactDimensionQuestion(q:string){return /^(?:幾大|几大|多大|大小)(?:呢)?[?？]?$|^(?:what\s+size|how\s+big)(?:\s+(?:is|are)\s+(?:it|that|they|those))?[?？]?$/i.test(q.trim());}
function selectAreaScopes(receipt:NonNullable<ReturnType<typeof readScopedAreaReceipt>>,input:ConversationRecallInput){
  const rows=receipt.current;
  if(input.trusted_visitor_source_status!=="verified" || !rows.length)return [];
  const labels=new Map<string,typeof rows>();
  for(const row of rows){
    const key=norm(row.scope);
    if(!key || labels.has(key))return [];
    labels.set(key,[row]);
  }
  // Group aliases derive only from the source-attested member labels.
  const groups=new Map<string,typeof rows>();
  for(const row of rows){
    const group=norm(row.scope).match(/^(.+?)\s+(?:[a-z]|[0-9]+)$/u)?.[1];
    if(group)groups.set(group,[...(groups.get(group)??[]),row]);
  }
  for(const [label,members] of groups)if(members.length>1&&!labels.has(label))labels.set(label,members);
  const resolve=(ref:string)=>{
    const label=norm(ref);
    if(labels.has(label))return labels.get(label)!;
    const count=label.match(/^([0-9一二兩两三四五六七八九十]+)(?:間|间|個|个|處|处)(.+)$/u);
    if(!count)return [];
    const members=rows.filter(row=>norm(row.scope).endsWith(count[2]));
    return members.length===literalNumber(count[1])?members:[];
  };
  const field={fact:"room_size" as const,keys:["room_size"],words:FIELDS.room_size??[]};
  const previous=input.recent_questions?.[0];
  const trustedPrevious=previous && input.trusted_visitor_source_rows?.filter(row=>row.content===previous).length===1;
  const implicit=compactDimensionQuestion(input.question);
  const target=implicit && trustedPrevious?previous!:input.question;
  const literalRefs=explicitRecallSubjects(target,field);
  const directlyNamed=[...labels.keys()].filter(label=>phrase(target,label));
  const literalMembers=(refs:readonly string[])=>{
    const chosen=new Set<typeof rows[number]>();
    for(const ref of refs){
      const members=resolve(ref);
      if(!members.length){
        const parts=ref.split(/(?:及|與|与|和|同埋|同|、|\band\b)/iu).map(x=>x.trim());
        if(parts.length<2 || parts.some(part=>!resolve(part).length))return null;
        for(const part of parts)resolve(part).forEach(row=>chosen.add(row));
        continue;
      }
      members.forEach(row=>chosen.add(row));
    }
    return chosen;
  };
  // Extract only the subject slot. A named or compound slot with an unknown
  // member cannot inherit a neighbouring member's value.
  function literalSelection(){
    if(implicit && !trustedPrevious)return [];
    const exactLabel=resolve(norm(target));
    if(exactLabel.length)return exactLabel;
    const namedPrefix=target.match(/^(.+?)(?=之前|頭先|头先)/u)?.[1];
    const possessive=target.match(/^(.+?)(?:的|嘅)(?:面積|面积)/u)?.[1];
    const slot=namedPrefix && namedPrefix!=="我"?namedPrefix:possessive;
    if(slot){
      const refs=slot.split(/(?:及|與|与|和|同埋|同|、|\band\b)/iu).map(ref=>ref.trim());
      const selected=literalMembers(refs);
      if(selected?.size)return [...selected];
      // A contextual selection can name multiple exact members in a single
      // source sentence. Require the entire joined member span.
      if(!implicit || refs.length<2)return [];
      const first=refs[0],ends=[...labels.keys()].filter(label=>first.endsWith(label));
      if(ends.length!==1)return [];
      const contextual=literalMembers([ends[0],...refs.slice(1)]);
      return contextual?[...contextual]:[];
    }
    const exact=literalMembers(literalRefs);
    if(exact?.size)return [...exact];
    if(implicit && trustedPrevious && directlyNamed.length===1){
      const group=directlyNamed[0];
      if(groups.has(group) && phrase(target,group+" size"))return resolve(group);
    }
    // A field-only historical question can address a verified owner-level
    // property. Never use cardinality alone to select a named sub-scope.
    if(rows.length===1 && !implicit){
      const row=rows[0],owner=input.commerce?.state.entities.find(e=>e.entity_id===receipt.subject_ref);
      const ownerField=owner && entityAliases(owner).some(alias=>norm(alias)===norm(row.scope));
      const sourceField=norm(row.scope).includes(norm(target.split(/是|係|系|[?？]/u)[0]));
      const fieldOnly=/^(?:我)?(?:之前|頭先|头先)(?:提供的|講|讲)/u.exec(target);
      if(fieldOnly && (ownerField||sourceField)){
        const fieldText=target.slice(fieldOnly[0].length).split(/(?:是|係|系|[?？])/u)[0];
        const fieldName=norm(fieldText);
        if(fieldName && (field.words.some(word=>norm(word)===fieldName) ||
            LABELS.room_size?.some(label=>norm(label).split("的").at(-1)===fieldName)))return rows;
      }
    }
    return [];
  }
  const p=input.customer_recall_proposal;
  let chosen:Set<typeof rows[number]>;
  if(p){
    if(p.intent!=="customer_fact_recall"||!input.company_id||!input.conversation_id||!input.source_message_id||
      p.company_id!==input.company_id||p.conversation_id!==input.conversation_id||p.source_message_id!==input.source_message_id||
      p.requested_facts.some(key=>!keyMatches(key,"room_size")))return [];
    // The accepted current-turn Reading owns semantic selection. Its refs
    // must resolve to actual receipt scopes; a previous utterance alone
    // cannot select a different scope or create a value.
    const refs=[...new Set(p.subject_refs.map(ref=>norm(ref)))];
    if(!refs.length){
      chosen=new Set(literalSelection());
    }else{
      const selected=literalMembers(refs);
      if(!selected?.size)return [];
      const groupProof=literalMembers(literalRefs);
      if(literalRefs.length && !groupProof &&
          (/[a-z]/iu.test(target) && literalRefs.some(ref=>!hasField(ref,"room_size") && !literalMembers([ref])) ||
           literalRefs.some(ref=>/(?:及|與|与|和|同埋|、|\band\b)/iu.test(ref))))return [];
      for(const ref of refs){
        if(phrase(input.question,ref))continue;
        const members=resolve(ref);
        if(groupProof && members.every(row=>groupProof.has(row)))continue;
        const priorReferent=input.referents?.some(h=>norm(h.ref)===ref&&h.confidence>=.9&&h.source==="prior_turn");
        if(!implicit||!trustedPrevious||!priorReferent||!phrase(previous!,ref))return [];
      }
      // A Reading may not omit another explicitly present known scope.
      if(rows.some(row=>phrase(input.question,row.scope)&&!selected.has(row)))return [];
      if(groupProof?.size && [...groupProof].some(row=>!selected.has(row)))return [];
      chosen=selected;
    }
  }else{
    // No Reading: only the existing literal subject extraction and exact
    // source-label pairing are admissible. No singleton or guessed scope.
    chosen=new Set(literalSelection());
    if(!chosen.size)return [];
  }
  const currentLabels=new Set(rows.map(row=>norm(row.scope)));
  if(receipt.superseded.some(row=>!currentLabels.has(norm(row.scope))&&phrase(input.question,row.scope)))return [];
  const selected=rows.filter(row=>chosen.has(row));
  if(selected.some(row=>selected.some(other=>other!==row&&
      (phrase(row.scope,other.scope)||phrase(other.scope,row.scope)))))return [];
  return selected;
}
function scopedAreaReadValue(receipt:NonNullable<ReturnType<typeof readScopedAreaReceipt>>,input:ConversationRecallInput){
  const selected=selectAreaScopes(receipt,input);
  if(!selected.length)return null;
  // Named scope replies keep the source label, even when only one value is
  // available. Cardinality must never silently retarget a measurement.
  return selected.map(row=>row.clause).join("；");
}

function originalSourceAttests(input:ConversationRecallInput,e:RecallEvidence,unsupportedTypedField:boolean):boolean {
  if(e.fact_type==="room_size" && e.state_path==="customer_constraints.scoped_area_observations"){
    const c=input.commerce;
    if(!c || input.trusted_visitor_source_status!=="verified" || e.temporal_scope!=="current")return false;
    const receipt=readScopedAreaReceipt(c.state,{...input,state_revision:c.revision});
    if(!receipt || receipt.source_message_id!==e.evidence_source_message_id ||
      e.entity_id!==(receipt.owner_kind==="persistent_state"?receipt.subject_ref:null))return false;
    const history=(input.trusted_visitor_source_rows??[]).map(row=>({...row,role:"visitor"}));
    const value=scopedAreaMemoryValue(receipt,history,c.state.language==="en"?"en":c.state.language==="zh-CN"?"zh-CN":"zh-TW");
    return !!value && e.value===scopedAreaReadValue(receipt,input);
  }
  const visitor=input.trusted_visitor_source_rows??[];
    if (e.fact_type === "room_size" || (e.attribute_key && (isLegacyRoomAreaKey(e.attribute_key)||keyMatches(e.attribute_key,"room_size"))) || e.temporal_scope !== "current") return false;
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
      // A number followed by a declared horsepower unit is a customer
      // requirement only when tied to an explicit request verb in the
      // original Visitor utterance. "1.5匹" alone may be product specs.
      const requestedHorsepower=e.fact_type==="horsepower" && typeof e.value==="number" &&
        Number.isFinite(e.value) && e.value>0 && e.value<=100 &&
        sourceClauses(row.content).some(clause=>{
          const escaped=String(e.value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
          return new RegExp("(?:要|需要|想要|指定|要求|預計|期望|希望|need|want|request)\\s*"+
            escaped+"\\s*匹(?![\\d.])","iu").test(clause);
        });
      if (!hasField(row.content,e.fact_type) && !requestedHorsepower) return false;
      // R1: retained customer projection and canonical typed property must
      // BOTH match the literal Visitor VALUE, not merely the field label.
      if (e.source_kind === "customer_owned_canonical_property" ||
          e.source_kind === "retained_customer_fact") {
        // T50: room-size collection projects member_id/value; canonical
        // Memory retains the original member label. Prove EACH label/value
        // together in one original Visitor clause, never merely two numbers.
        if (typeof e.value === "number") return numberTokens(row.content)
          .some(token => token.value === e.value);
        if (typeof e.value === "string") {
          const normalize = (value: string) => value.normalize("NFKC")
            .toLowerCase().replace(/\s+/gu, "");
          const value = normalize(e.value);
          return value.length > 0 && normalize(row.content).includes(value);
        }
        if (typeof e.value === "boolean" && e.fact_type === "brand_constraint") {
          const mandatory = /(?:品牌.{0,8}(?:必須|必须|指定)|brand.{0,10}(?:required|mandatory))/iu;
          const optional = /(?:品牌.{0,8}(?:不是|並非|并非|唔係|不限|無須|无需).{0,8}(?:必須|必须|指定)?|brand.{0,10}(?:not|optional|flexible))/iu;
          return e.value ? mandatory.test(row.content) && !optional.test(row.content)
            : optional.test(row.content);
        }
        return false;
      }
      return true;
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
}

/** Original Visitor evidence may validate an unlabelled read-only customer
 * fact. This predicate is source verification, not a second classifier. */
export function hasAttestedUnlabelledCustomerRecall(input:ConversationRecallInput,decision:ConversationRecallDecision):boolean {
  if(input.trusted_visitor_source_status!=="verified"||!decision.handled||
     decision.provenance.company_id!==input.company_id||
     decision.provenance.conversation_id!==input.conversation_id||
     decision.provenance.source_message_id!==input.source_message_id||
     input.memory?.commerce_state_revision!==input.commerce?.revision||
     !decision.provenance.evidence.length)return false;
  // S2: independently reconstruct the entire structured receipt before
  // accepting it at the existing mixed/pure recall caller. A same numeric
  // value and source ID alone cannot attest another entity, unit or revision.
  const structured=structuredQuantityEvidence(input);
  const claimsStructuredQuantity=decision.provenance.evidence.some(e=>
    e.fact_type==="quantity"&&typeof e.attribute_key==="string"&&
    e.attribute_key.startsWith("entity:")&&e.attribute_key.endsWith(":quantity"));
  if(claimsStructuredQuantity||structured&&decision.fact_type==="quantity"){
    return Boolean(structured&&decision.fact_type==="quantity"&&
      decision.provenance.evidence.length===1&&
      decision.authority===structured.authority&&decision.value===structured.value&&
      decision.state_path===structured.state_path&&
      decision.provenance.memory_revision===input.memory?.memory_revision&&
      decision.provenance.commerce_state_revision===input.commerce?.revision&&
      decision.provenance.commerce_source_message_id===input.commerce?.source_message_id&&
      sameCanonicalJson(decision.provenance.evidence[0],structured));
  }
  if(decision.provenance.evidence.some(e=>e.source_kind==="source_bound_scoped_area")){
    const [e]=decision.provenance.evidence;
    return decision.provenance.evidence.length===1 && decision.fact_type==="room_size" &&
      decision.authority==="CANONICAL_COMMERCE_STATE" && e.authority===decision.authority &&
      decision.state_path===e.state_path && decision.value===e.value &&
      decision.provenance.memory_revision===input.memory?.memory_revision &&
      decision.provenance.commerce_state_revision===input.commerce?.revision &&
      decision.provenance.commerce_source_message_id===input.commerce?.source_message_id &&
      originalSourceAttests(input,e,false);
  }
  const quoted=attestedCustomerQuantity(input);
  const typed=sourceAttestedTypedCustomerAttribute(input);
  return decision.provenance.evidence.every(e=>e.temporal_scope==="current"&&(
    (e.source_kind==="customer_owned_canonical_property"||
     e.source_kind==="retained_customer_fact")&&originalSourceAttests(input,e,false)||
    e.source_kind==="attested_customer_utterance"&&e.fact_type==="quantity"&&quoted!==null&&
       quoted.evidence_source_message_id===e.evidence_source_message_id&&quoted.value===e.value||
    e.source_kind==="attested_customer_utterance"&&e.fact_type==="customer_fact"&&
       typed!==null&&typed.handled&&typed.provenance.evidence.some(t=>
         t.evidence_source_message_id===e.evidence_source_message_id&&t.state_path===e.state_path&&t.value===e.value)));
}

/** D4-3: source-bound customer-owned numeric attribute recall.
 * Selection is allowed by an existing model proposal, but the fact must
 * agree between current Memory, canonical Commerce and one original Visitor
 * clause for exactly one named subject; merchant/transaction data is excluded. */
function sourceAttestedTypedCustomerAttribute(
  input:ConversationRecallInput,
):ConversationRecallDecision | null {
  const p=input.customer_recall_proposal,m=input.memory,c=input.commerce;
  if(!p||!m||!c||input.trusted_visitor_source_status!=="verified"||
    p.intent!=="customer_fact_recall"||p.requested_facts.length!==1||
    p.company_id!==input.company_id||p.conversation_id!==input.conversation_id||
    p.source_message_id!==input.source_message_id||
    c.company_id!==input.company_id||c.conversation_id!==input.conversation_id||
    m.commerce_state_revision!==c.revision||
    !/(?:之前|頭先|头先|剛才|刚才|曾經|曾经|要求|提過|提过|did\s+i|i\s+(?:request|ask|mention)|earlier|previously)/iu.test(input.question))return null;
  const key=p.requested_facts[0];
  if(isLegacyRoomAreaKey(key)||keyMatches(key,"room_size")||!/^[a-z][a-z0-9_]{1,60}$/iu.test(key)||
    /(?:price|stock|availability|order|payment|refund|policy|tier|entitlement|warranty|delivery|booking|identity|email|phone)/iu.test(key))return null;
  const named=c.state.entities.filter(isCurrentEntity).filter(e=>
    [e.model,e.attributes.product_name].some(v=>typeof v==="string"&&v.length>1&&
      phrase(input.question,v)));
  if(named.length!==1)return null;
  const e=named[0];
  const facts=m.current_customer_facts.filter(f=>f.authority==="customer"&&
    !isLegacyRoomAreaKey(f.key)&&!keyMatches(f.key,"room_size")&&keyNorm(f.key)===keyNorm(key)&&f.entity_id===e.entity_id&&
    typeof f.value==="string"&&!!f.source_message_id&&f.source_message_id!==input.source_message_id);
  if(facts.length!==1)return null;
  const fact=facts[0];
  const declaration=String(fact.value).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([\p{L}][\p{L}\p{N}-]{0,31})$/u);
  if(!declaration)return null;
  const number=Number(declaration[1]),unit=declaration[2];
  if(!Number.isFinite(number)||number<0||number>1000000||
    typeof e.attributes[key]!=="number"||e.attributes[key]!==number)return null;
  const rows=input.trusted_visitor_source_rows??[];
  const originals=rows.filter(row=>row.id===fact.source_message_id&&row.content.length<=2400);
  if(originals.length!==1)return null;
  const source=originals[0].content.normalize("NFKC");
  const labels=[e.model,e.attributes.product_name].filter(
    (v):v is string=>typeof v==="string"&&v.length>1&&phrase(source,v));
  if(!labels.length)return null;
  const valuePattern=new RegExp(declaration[1].replace(".","\\.")+"\\s*"+
    unit.replace(/[.*+?^$(){}|[\]\\]/g,"\\$&"),"iu");
  const sourceProves=labels.some(label=>{
    const at=source.toLowerCase().indexOf(label.toLowerCase());
    if(at<0)return false;
    const after=source.slice(at+label.length).split(/[，,。;；]/u)[0].slice(0,24);
    const before=source.slice(Math.max(0,at-40),at).split(/[，,。;；]/u).at(-1)??"";
    const forward=after.match(valuePattern),backward=before.match(valuePattern);
    return Boolean(forward&&forward.index!==undefined&&forward.index<=8||
      backward&&backward.index!==undefined&&
        /(?:for|of)\s*$/iu.test(before.slice(backward.index+backward[0].length)));
  });
  const sourceIndex=rows.findIndex(row=>row.id===fact.source_message_id);
  const superseded=sourceIndex<0||rows.slice(0,sourceIndex).some(row=>
    labels.some(label=>phrase(row.content,label))&&
    /更正|改為|改为|取消|暫緩|暂缓|change|correct|cancel|defer/iu.test(row.content));
  if(!sourceProves||superseded)return null;
  const index=m.current_customer_facts.indexOf(fact);
  const evidence:RecallEvidence={fact_type:"customer_fact",
    state_path:"current_customer_facts."+index+".value",value:fact.value,
    authority:"CURRENT_CUSTOMER_MEMORY",entity_id:e.entity_id,
    entity_label:labels[0],region:fact.region??null,
    evidence_source_message_id:fact.source_message_id??null,temporal_scope:"current",
    source_kind:"attested_customer_utterance",attribute_key:key};
  return {handled:true,authority:"CURRENT_CUSTOMER_MEMORY",
    fact_type:"customer_fact",state_path:evidence.state_path,value:fact.value,
    provenance:{conversation_id:input.conversation_id,company_id:input.company_id,
      source_message_id:input.source_message_id,memory_revision:m.memory_revision,
      commerce_state_revision:c.revision,commerce_source_message_id:c.source_message_id,
      evidence:[evidence]}};
}

/** Semantic understanding proposes a field, not an exclusive answer route.
 * F1/S3 + F3/S4: preserve the preexisting typed resolver for unsupported
 * or compound recalls, while scope/source/merchant protections fail closed. */
export function resolveConversationRecall(
  input: ConversationRecallInput,
): ConversationRecallDecision {
  if (input.explicit_handoff) return fail("NOT_A_RECALL_QUERY", "HANDOFF_PRECEDENCE");
  const partition=resolveSourceVerifiedUnitPartition(input);
  if(partition)return partition;
  const canonicalActiveRetention=resolveSourceVerifiedCanonicalActiveRetention(input);
  if(canonicalActiveRetention)return canonicalActiveRetention;
  const structuredQuantity=structuredQuantityEvidence(input);
  if(structuredQuantity)return {handled:true,authority:"CURRENT_CUSTOMER_MEMORY",
    fact_type:"quantity",state_path:structuredQuantity.state_path,value:structuredQuantity.value,
    provenance:{company_id:input.company_id,conversation_id:input.conversation_id,
      source_message_id:input.source_message_id,memory_revision:input.memory!.memory_revision,
      commerce_state_revision:input.commerce!.revision,
      commerce_source_message_id:input.commerce!.source_message_id,evidence:[structuredQuantity]}};
  const typedCustomer=sourceAttestedTypedCustomerAttribute(input);
  if(typedCustomer) return typedCustomer;
  // Historical customer speech must not fall back to an unverified stored
  // number (the original 6 vs 3 defect). Operational current status/quantity
  // is separately governed by canonical lifecycle and revision controls.
  const historicalCustomerQuantity = any(input.question, OWNER) &&
    (hasField(input.question, "quantity") || sourceBoundQuantityQuery(input.question, input)) &&
    /(?:剛才|刚才|頭先|头先|之前|先前|曾經|曾经|說過|说过|講過|讲过|提過|提过|previously|earlier|did (?:i|we) (?:say|mention|state)|told you)/iu.test(input.question);
  if (historicalCustomerQuantity &&
      input.trusted_visitor_source_status !== "verified") {
    return fail("AMBIGUOUS", "CUSTOMER_SOURCE_NOT_VERIFIED");
  }
  const semantic = resolveSemanticCustomerRecall(input);
  if (!semantic) {
    const legacy = resolveConversationRecallLegacy(input);
    // A canonical current-state recap or an already-reduced correction
    // checkpoint is an operational state read, NOT a claim about the exact
    // words in a historical Visitor turn. Preserve its original revision/
    // lifecycle proof; require a verified original only for speech-owned facts.
    const canonicalCurrentState = legacy.handled &&
      (legacy.fact_type === "summary" ||
        legacy.provenance.evidence.every(e =>
          e.authority === "CANONICAL_COMMERCE_STATE" ||
          e.source_kind === "retained_customer_correction_checkpoint"));
    if (legacy.handled && !canonicalCurrentState &&
        input.trusted_visitor_source_status !== "verified" &&
        legacy.provenance.evidence.some(e => e.authority === "CURRENT_CUSTOMER_MEMORY" ||
          e.source_kind === "customer_owned_canonical_property" ||
          e.source_kind === "attested_customer_utterance"))
      return fail("AMBIGUOUS", "CUSTOMER_SOURCE_NOT_VERIFIED");
    if (historicalCustomerQuantity && legacy.handled &&
        !attestedCustomerQuantity(input)) return fail("AMBIGUOUS", "CUSTOMER_QUANTITY_NOT_ATTESTED");
    return legacy;
  }
  if (semantic.handled) return semantic;
  // A missing Visitor-source list cannot certify a supported scalar.
  // An independently authenticated canonical field is different: allow
  // the original resolver to verify unsupported typed fields (address,
  // room, contact, constraints) or compound fields without extra model/KB.
  const supportedScalar = (fact: RecallFact) =>
    CUSTOMER_RECALL_FIELDS.some(field => field.fact === fact);
  const parsedFields = parseQuery(input.question, [], [], false, input).facts;
  const unsupportedTypedField = parsedFields.some(f => !supportedScalar(f)) ||
    (input.customer_recall_proposal?.requested_facts ?? []).some(key =>
      !CUSTOMER_RECALL_FIELDS.some(f => f.keys.some(k =>
        keyNorm(k) === keyNorm(key))));
  if (input.trusted_visitor_source_status !== "verified" &&
      input.customer_recall_proposal && semantic.reason !== "CURRENT_KB_REQUIRED")
    return fail("AMBIGUOUS", "CUSTOMER_SOURCE_NOT_VERIFIED");
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
  // A null/empty source list never certifies a customer-owned canonical
  // attribute. Existing verified operational CANONICAL_COMMERCE_STATE
  // projections remain under the original tenant/revision/lifecycle guards.
  const canonicalProof = previous.provenance.evidence.length > 0 &&
    previous.provenance.evidence.every(e =>
      e.authority === "CANONICAL_COMMERCE_STATE" ||
      (e.source_kind === "customer_owned_canonical_property" && originalSourceAttests(input,e,unsupportedTypedField)));
  const legacyPersonalProof = unsupportedTypedField &&
    previous.provenance.evidence.length > 0 &&
    previous.provenance.evidence.every(e => e.authority === "CURRENT_CUSTOMER_MEMORY" && originalSourceAttests(input,e,unsupportedTypedField));
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
        (e.authority === "CANONICAL_COMMERCE_STATE" || originalSourceAttests(input,e,unsupportedTypedField))) &&
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
  const semantic=verifiedSemanticRecapSelection(input);
  if(semantic) retainedTargets.push(semantic.source_phrase);
  const resolved = summarySelection(input, input.commerce?.state.entities ?? []);
  if (resolved.provenance === "trusted_referent" && resolved.entities.length === 1) retainedTargets.push("it", "that", "this");
  const recap = isCurrentRequirementsRecap(input.question, retainedTargets);
  const lexical = parseQuery(input.question, input.recent_questions, retainedTargets, hasSourceBoundCompletedRecap(input), input);
  // Use the accepted field on the same read-only request. The subsequent
  // selector checks each Visitor reference, receipt and original source.
  // External, mutation, compound and lifecycle stops retain precedence.
  const request=input.customer_recall_proposal;
  const scopedReading=request?.intent==="customer_fact_recall" &&
    request.company_id===input.company_id && request.conversation_id===input.conversation_id &&
    request.source_message_id===input.source_message_id && request.requested_facts.length===1 &&
    keyNorm(request.requested_facts[0])==="roomsize" && request.subject_refs.length>0 &&
    input.trusted_visitor_source_status==="verified" && !customerRecallHasAction(input.question) &&
    (!lexical.stop || (!lexical.stop.handled && lexical.stop.detail==="NO_SUPPORTED_FACT_SLOT")) &&
    lexical.facts.every(f=>f==="room_size" || f==="constraints" && !hasField(input.question.replace(/(\p{Script=Han}{1,2})(?:不|唔)\1/gu,"$1"),"constraints"));
  const parsed=scopedReading?{facts:["room_size" as RecallFact],stop:undefined}:lexical;
  const m = input.memory, c = input.commerce;
  // A current effective quantity read may legitimately target a previous
  // committed correction. Its memory source is not this question's source.
  // Do not relax the original source guard for historical speech or any
  // read lacking exact persisted CAS lineage and original Visitor proof.
  const verifiedCorrection = isCurrentEffectiveQuantityRecall(input.question, input)
    ? verifiedRetainedCustomerCorrection(input) : null;
  const persistedEffectiveRead = Boolean(verifiedCorrection && m && c &&
    hasTrustedPersistedMemoryReadback(input) &&
    m.source_message_id===c.source_message_id &&
    c.state.entities.some(e=>e.status==="cancelled" &&
      e.provenance.source_type==="customer" &&
      e.provenance.source_message_id===verifiedCorrection.source_id));
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
        !((recap || persistedEffectiveRead) && c &&
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
    const sourceCorrection=(
      f==="quantity"&&asksRetainedQuantity(slot.question) ||
      f==="entity_status"&&asksInactiveEntityStatus(slot.question))
      ?verifiedRetainedCustomerCorrection(input):null;
    if(sourceCorrection){
      // Prefer one exact-source, current canonical projection when present:
      // the retained active item quantity and the cancelled item's lifecycle
      // are distinct facts. Never reuse an inactive aggregate as current qty.
      const canonical=canonicalCandidates(input,f,selected.filter(e=>
        f==="quantity"?isCurrentEntity(e):["cancelled","deferred"].includes(e.status)
      )).filter(row=>row.source_kind==="canonical_state" &&
        row.authority==="CANONICAL_COMMERCE_STATE" &&
        row.evidence_source_message_id===sourceCorrection.source_id &&
        (f==="quantity"?row.value===sourceCorrection.value:row.value==="cancelled"));
      if(canonical.length===1){
        const {rank:unusedRank,...attested}=canonical[0];
        evidence.push(attested);
        continue;
      }
      if(f==="quantity"){
        // A contradictory active canonical quantity from this very correction
        // must be clarified; the older checkpoint must not mask the conflict.
        if(selected.some(e=>isCurrentEntity(e) &&
          customerRequestedQuantity(e)!==null &&
          e.provenance.source_message_id===sourceCorrection.source_id &&
          e.quantity!==sourceCorrection.value))
          return fail("AMBIGUOUS","CONFLICTING_CURRENT_QUANTITY",facts);
        evidence.push({fact_type:"quantity",value:sourceCorrection.value,quantity_unit:sourceCorrection.unit,
          state_path:"latest_corrections.source_verified_quantity",
          authority:"CURRENT_CUSTOMER_MEMORY",entity_id:null,region:null,
          evidence_source_message_id:sourceCorrection.source_id,
          temporal_scope:"current",source_kind:"retained_customer_correction_checkpoint"});
      }else{
        evidence.push({fact_type:"entity_status",value:sourceCorrection.text,
          state_path:"latest_corrections.source_verified_customer_request",
          authority:"CURRENT_CUSTOMER_MEMORY",entity_id:null,region:null,
          evidence_source_message_id:sourceCorrection.source_id,
          temporal_scope:"current",source_kind:"attested_customer_utterance"});
      }
      continue;
    }
    if(f==="quantity"&&!asksRetainedQuantity(slot.question)&&
      selected.length===1&&selected[0].provenance.source_type==="customer"&&
      typeof selected[0].attributes.product_name==="string"&&
      /[：:].+[,，、]/u.test(selected[0].attributes.product_name)&&
      !phrase(slot.question,selected[0].attributes.product_name)){
      // A named part cannot inherit a legacy collapsed multi-part total.
      return fail("AMBIGUOUS","UNBOUND_NAMED_PART",facts);
    }
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
      // Attribute an area to an entity only when its original Visitor rows
      // and the current active owner still match the scoped Commerce receipt.
      const areaReceipt = c && input.trusted_visitor_source_status === "verified"
        ? readScopedAreaReceipt(c.state, { ...input, state_revision: c.revision }) : null;
      const areaOwner = areaReceipt?.owner_kind === "persistent_state"
        ? summaryEntities.find(entity => entity.entity_id === areaReceipt.subject_ref) : null;
      const areaHistory = input.trusted_visitor_source_rows?.map(row => ({ ...row, role: "visitor" })) ?? [];
      const areaValue = areaReceipt ? scopedAreaMemoryValue(areaReceipt, areaHistory,
        c?.state.language === "en" ? "en" : c?.state.language === "zh-CN" ? "zh-CN" : "zh-TW") : null;
      const areaRows = areaOwner && areaReceipt && areaValue ? areaReceipt.current : [];
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
          ...(areaRows.length && areaOwner ? { entity_area: { entity_id: areaOwner.entity_id, rows: areaRows.map(
            ({ scope, amount, unit, approximate }) => ({ scope, amount, unit, approximate })) } } : {}),
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
          customer_facts: scope.provenance === "global" ? [
            ...m.current_customer_facts.filter(f=>!isLegacyRoomAreaKey(f.key) && f.key!=="site_observation" && f.key!==SCOPED_AREA_KEY),
            ...(!areaOwner && areaReceipt && areaValue ? [{ key: SCOPED_AREA_KEY, authority: "canonical_commerce",
              source_message_id: areaReceipt.source_message_id, value: areaValue }] : []),
            ...Object.entries(c?.state.customer_constraints.customer_reported_facts ?? {}).flatMap(([key,value])=>{
              if(key!=="site_observation" || !value || typeof value!=="object" || Array.isArray(value))return [];
              const record=value as Record<string,unknown>;
              const provenance=record.provenance as Record<string,unknown>|undefined;
              return provenance?.source_type==="customer" && typeof provenance.source_message_id==="string" && typeof record.source_text==="string"
                ? [{key,value:record.source_text,authority:"customer",source_message_id:provenance.source_message_id}] : [];
            }),
          ] : [],
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
    if(f==="room_size"){
      const firstQuestion=input.question.match(/^([^?？]*[?？])\s*\S/u)?.[1];
      if(firstQuestion && !parseQuery(firstQuestion,[],[],false,input).facts.includes("room_size"))
        return fail("NOT_A_RECALL_QUERY","NO_SUPPORTED_FACT_SLOT",facts);
      const receipt=c && input.trusted_visitor_source_status==="verified" ? readScopedAreaReceipt(c.state,{...input,state_revision:c.revision}) : null;
      const history=(input.trusted_visitor_source_rows??[]).map(row=>({...row,role:"visitor"}));
      const value=receipt && scopedAreaMemoryValue(receipt,history,c?.state.language==="en"?"en":c?.state.language==="zh-CN"?"zh-CN":"zh-TW");
      const legacyValues=new Set([
        ...selected.filter(isCurrentEntity).map(entity=>entity.attributes.room_size),
        ...(m?.current_customer_facts??[]).filter(fact=>fact.key==="room_size" && selected.some(entity=>entity.entity_id===fact.entity_id)).map(fact=>fact.value),
      ].filter(v=>typeof v==="string").map(v=>v.trim().toLowerCase()));
      if(legacyValues.size>1)return fail("AMBIGUOUS","CONFLICTING_ROOM_SIZE",facts);
      if(!receipt || !value)return fail("AMBIGUOUS","MISSING_ROOM_SIZE",facts);
      const selection=summarySelection(input,c?.state.entities??[]);
      if(selection.provenance!=="global" && !selection.entities.some(e=>e.entity_id===receipt.subject_ref))return fail("AMBIGUOUS","ENTITY_REFERENCE_AMBIGUOUS",facts);
      const single=receipt.current.length===1?receipt.current[0]:null;
      const literal=scopedAreaReadValue(receipt,input);
      if(!literal)return fail("AMBIGUOUS","AREA_SCOPE_NOT_VERIFIED",facts);
      if(single && [...legacyValues].some(proposed=>{
        const old=String(proposed).match(/^([0-9]+(?:\.[0-9]+)?)\s*(.*)$/u);
        return !old || Number(old[1])!==single.amount ||
          (single.unit==="sq_ft"?!/^(?:平方[呎尺]|sq\.?\s*ft|square feet|ft2)$/iu.test(old[2]):!/^(?:平方米|平方公尺|sq\.?\s*m|square met(?:er|re)s?|m2)$/iu.test(old[2]));
      }))return fail("AMBIGUOUS","CONFLICTING_ROOM_SIZE",facts);
      evidence.push({fact_type:f,state_path:"customer_constraints.scoped_area_observations",value:literal??value,authority:"CANONICAL_COMMERCE_STATE",entity_id:receipt.owner_kind==="persistent_state"?receipt.subject_ref:null,region:null,evidence_source_message_id:receipt.source_message_id,temporal_scope:"current",source_kind:"source_bound_scoped_area"});
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
      ...canonicalCandidates(input, f, selected, slot.question),
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
    const unique = new Map(
      best.map((x) => [`${x.entity_id ?? ""}|${JSON.stringify(x.value)}`, x]),
    );
    if (unique.size > 1) {
      // A global customer-fact projection, its per-entity attribute, and
      // Memory's source-free view can describe the SAME literal Visitor fact.
      // Accept only when one exact independently fetched Visitor source
      // proves every source-bearing candidate, all values are byte-equal,
      // and at most one concrete entity is involved. Otherwise preserve
      // the original multi-entity ambiguity and tenant/revision protections.
      const attested=best.filter(e=>e.evidence_source_message_id &&
        originalSourceAttests(input,e,false));
      const ids=new Set(attested.map(e=>e.evidence_source_message_id));
      const entities=new Set(best.map(e=>e.entity_id).filter(Boolean));
      const equivalent= input.trusted_visitor_source_status==="verified" &&
        attested.length>0 && ids.size===1 && entities.size<=1 &&
        best.every(e=>JSON.stringify(e.value)===JSON.stringify(attested[0].value) &&
          (e.evidence_source_message_id===attested[0].evidence_source_message_id ||
           !e.evidence_source_message_id &&
             /^active_entities\.\d+\.current_requirements\./u.test(e.state_path) &&
             !!e.entity_id && entities.has(e.entity_id)));
      // Single-customer-source numeric/unit projection: long Memory may
      // retain a customer statement as ["1.5匹"] while canonical Commerce
      // carries numeric 1.5. This is not competing customer evidence when
      // the one actual Visitor request and all three current projections
      // independently agree. Multi-unit, multi-source or value disagreement
      // remains a hard conflict, not a loose numeric match.
      const hpNumber = f === "horsepower" && selected.length === 1 &&
        input.trusted_visitor_source_status === "verified"
        ? best.find(e => e.source_kind === "customer_owned_canonical_property" &&
            typeof e.value === "number" && Number.isFinite(e.value) &&
            e.value > 0 && e.value <= 100 && e.entity_id === selected[0].entity_id &&
            !!e.evidence_source_message_id && originalSourceAttests(input,e,false))
        : undefined;
      const hpSource = hpNumber && input.trusted_visitor_source_rows?.filter(
        row => row.id === hpNumber.evidence_source_message_id &&
          typeof row.content === "string" && row.content.length <= 2400);
      const hpSourceUnits = hpSource?.length === 1
        ? [...hpSource[0].content.matchAll(/(\d+(?:\.\d+)?)\s*匹(?![\d.])/gu)]
        : [];
      const hpEquivalent = !!hpNumber && hpSource?.length === 1 &&
        hpSourceUnits?.length === 1 && Number(hpSourceUnits[0][1]) === hpNumber.value &&
        best.every(e => e.temporal_scope === "current" &&
          ["customer_owned_canonical_property","retained_customer_fact"].includes(e.source_kind) &&
          (!e.entity_id || e.entity_id === hpNumber.entity_id) &&
          (e.evidence_source_message_id === hpNumber.evidence_source_message_id ||
            !e.evidence_source_message_id && e.entity_id === hpNumber.entity_id &&
            /^active_entities\.\d+\.current_requirements\./u.test(e.state_path)) &&
          (typeof e.value === "number" ? e.value === hpNumber.value :
            Array.isArray(e.value) && e.value.length === 1 &&
            typeof e.value[0] === "string" &&
            (e.value[0].match(/(?:^|\s)(\d+(?:\.\d+)?)\s*匹$/u) !== null) &&
            Number(e.value[0].match(/(?:^|\s)(\d+(?:\.\d+)?)\s*匹$/u)![1]) === hpNumber.value));
      if (!equivalent && !hpEquivalent) {
        // R1/D3: source-only, value-free conflict trace for actual failed
        // candidate sets. Do not relax the ambiguity/tenant/subject guards.
        if (f === "horsepower") console.info("[conversation-recall] c3_horsepower_candidate_conflict", {
          selected_count:selected.length, best_count:best.length,
          value_groups:best.map(e=>best.findIndex(x=>JSON.stringify(x.value)===JSON.stringify(e.value))),
          paths:best.map(e=>e.state_path),
          kinds:best.map(e=>e.source_kind),
          entity_count:entities.size, attested_count:attested.length,
          attested_source_count:ids.size, source_status:input.trusted_visitor_source_status,
          source_in_verified_rows:best.map(e=>!!e.evidence_source_message_id &&
            (input.trusted_visitor_source_rows??[]).filter(row=>row.id===e.evidence_source_message_id).length===1),
        });
        return fail("AMBIGUOUS", `CONFLICTING_${f.toUpperCase()}`, facts);
      }
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
  if(decision.fact_type==="quantity+unit_partition"){
    const facts=decision.provenance.evidence;
    const a=facts.find(e=>e.fact_type==="quantity"&&e.temporal_scope==="current");
    const b=facts.find(e=>e.fact_type==="quantity"&&e.temporal_scope==="excluded");
    const s=facts.find(e=>e.fact_type==="entity_status"&&e.temporal_scope==="excluded");
    if(facts.length!==3 || !a || !b || !s || !a.entity_id || !b.entity_id ||
       a.entity_id===b.entity_id || b.entity_id!==s.entity_id ||
       !a.entity_label || a.entity_label!==b.entity_label || a.entity_label!==s.entity_label ||
       !a.quantity_unit || a.quantity_unit!==b.quantity_unit ||
       typeof a.value!=="number" || typeof b.value!=="number" ||
       !Number.isSafeInteger(a.value) || a.value<1 || !Number.isSafeInteger(b.value) || b.value<1 ||
       (s.value!=="cancelled"&&s.value!=="deferred") ||
       facts.some(e=>e.authority!=="CANONICAL_COMMERCE_STATE" || e.source_kind!=="canonical_partial_unit_partition" ||
         !e.evidence_source_message_id || e.evidence_source_message_id!==a.evidence_source_message_id)) return null;
    return renderUnitPartition({label:a.entity_label,unit:a.quantity_unit,retained:a.value,inactive:b.value,status:s.value},language);
  }
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
    const quantityUnitSuffix=e.fact_type==="quantity"&&e.quantity_unit?` ${e.quantity_unit}`:"";
    if (e.source_kind === "attested_customer_utterance") {
      if(e.fact_type==="entity_status"){
        lines.push(l===2?`You said: ${v} (not proof of completed cancellation).`
          :l===1?`你表示：${v}（不代表取消手续已完成）。`
          :`你表示：${v}（不代表取消手續已完成）。`);
      }else {
        // Retain the source-attested subject in the existing quantity rendering.
        // The display label is canonical/sanitized, never a model-supplied alias.
        const label=e.fact_type==="quantity"?safeCustomerDisplayText(e.entity_label,e.entity_id):null;
        const subjectSuffix=label&&keyNorm(label)!==keyNorm(e.quantity_unit??"")
          ? " ("+label+")":"";
        lines.push(`${LABELS[e.fact_type]?.[l] ?? e.attribute_key ?? "Customer information"}${subjectSuffix}: ${v}${quantityUnitSuffix}`);
      }
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
    if (e.fact_type === "customer_fact" && e.source_kind === "attested_customer_utterance" && e.entity_label) {
      lines.push(l===2 ? "You previously stated "+e.entity_label+": "+String(e.value)+"."
        : l===1 ? "你之前提供的"+e.entity_label+"是："+String(e.value)+"。"
        : "你之前提過"+e.entity_label+"係："+String(e.value)+"。");
      continue;
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
        safeCustomerDisplayText(e.entity_label, e.entity_id) ? ` (${safeCustomerDisplayText(e.entity_label, e.entity_id)})` : ""
      }: ${v}${quantityUnitSuffix}`,
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

/** Read the customer's own quotation/enquiry report, never a merchant transaction.
 * The accepted frame only selects a source. The value must match the persisted
 * customer fact and original visitor text, and the current canonical lifecycle
 * must not contradict it. This is not a price/transaction authority or a B2 waiver. */
function quotationReportText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text=value.normalize("NFKC").trim();
  if (!text || text.length>600 || /[?？"“”「」『』\x60]|(?:\bbut\b|\bhowever\b|但是|不過|不过|但係)/iu.test(text)) return false;
  const exclusive= /^(?:I|we)\s+(?:(?:only|just)\s+(?:asked|requested|enquired|inquired)\b|(?:asked|requested|enquired|inquired)\b[^.!?;]{0,160}\b(?:only|just)\b)/iu.test(text) ||
    /^(?:我|我們|我们|我哋)\s*(?:只是|只係|只系|淨係|净系|只|僅|仅)\s*(?:要求|索取|詢問|询问|查詢|查询|問|问|想了解|想問|想问)/u.test(text);
  const enquiry= /(?:quotation|quote|\bprice\b|\bfee\b|\bfees\b|\basked\b|\benquired\b|\binquired\b|報價|报价|費用|费用|價錢|价钱|價格|价格|查詢|查询|索取)/iu.test(text);
  const negated= /(?:尚未|還未|还未|沒有|没有|未有|未確認|未确认|冇|並未|并未).{0,90}(?:付款|訂單|订单|下單|下单|落單|報名|报名|預約|预约|訂位|订位|訂閱|订阅|續約|续约|交易)|\b(?:no|not|never)\b[^.!?;]{0,130}\b(?:order|subscription|payment|renewal|booking|reservation|transaction|paid|shipping)\b|\b(?:no|not|never)\b[^.!?;]{0,130}\b(?:confirmed|placed|paid|completed|booked)\b/iu.test(text);
  // No affirmative second lifecycle clause may be hidden inside an enquiry.
  const contradictory= /(?:已經|已经|已)(?:下單|下单|落單|付款|確認訂單|确认订单|完成交易)|(?:^|[.!;。；]\s*)\s*(?:I|we)\s+(?:have\s+)?(?:paid|placed|confirmed|completed|renewed|subscribed|booked)\b/iu.test(text);
  return exclusive && enquiry && negated && !contradictory;
}
const quoteStatusFields = new Set(["quotation_status","quote_status","order_status","payment_status","transaction_status"]);
export function isSourceBoundQuoteStatusQuestion(question:string, frame:CommerceSemanticFrame|null|undefined):boolean {
  const source=question.normalize("NFKC").trim(), d=frame?.demands?.[0];
  if (!frame || frame.operation!=="ASK_FACT" || frame.confidence<.72 || frame.ambiguity.is_ambiguous ||
      frame.additive || frame.customer_correction || frame.explicit_negations.length || frame.entities.length ||
      frame.customer_facts?.length || frame.demands?.length!==1 || !d ||
      d.source_type!=="transaction" || d.ambiguity.is_ambiguous || d.customer_correction ||
      d.subject_refs.length || d.explicit_negations.length || Object.keys(d.constraints).length ||
      d.source_quote.normalize("NFKC").trim()!==source ||
      d.requested_facts.length===0 || !d.requested_facts.every(f=>quoteStatusFields.has(f)) ||
      !frame.requested_facts.length || !frame.requested_facts.every(f=>quoteStatusFields.has(f)) ||
      ![frame.transaction_state,frame.payment_state,frame.booking_state,frame.fulfillment_state].every(v=>v==="none"||v==="unknown")) return false;
  return /^(?:is\s+this\s+(?:(?:just|only)\s+)?(?:a\s+)?(?:quotation|quote|enquiry|inquiry)\s+or\s+(?:a\s+)?(?:completed|confirmed)\s+(?:transaction|order)|do\s+(?:i|we)\s+have\s+(?:an?\s+)?(?:accepted|confirmed)\s+(?:[\p{L}-]+\s+){0,3}(?:order|booking|subscription|transaction)\s+yet)[?]?$/iu.test(source) ||
    /^(?:(?:目前|現在|现在|而家|依家)\s*)?(?:只[是係系]|淨係|净系)?(?:查詢|查询|索取|要求)?(?:報價|报价)[,，\s]*(?:還是|还是|定係|定系|抑或)(?:已經|已经|已)?(?:完成|確認|确认)(?:交易|訂單|订单)[?]?$/u.test(source);
}
export function resolveSourceBoundQuoteConversation(input:ConversationRecallInput,
  frame:CommerceSemanticFrame|null|undefined, language:string):{reply:string;report_source_message_id:string;kind:"report"|"status"}|null {
  const m=input.memory,c=input.commerce;
  if (!m || !c || input.explicit_handoff || !input.company_id || !input.conversation_id || !input.source_message_id ||
      m.company_id!==input.company_id || m.conversation_id!==input.conversation_id ||
      c.company_id!==input.company_id || c.conversation_id!==input.conversation_id ||
      !Number.isSafeInteger(c.revision) || c.revision<1 || m.commerce_state_revision!==c.revision ||
      !Number.isSafeInteger(m.memory_revision) || m.memory_revision<1) return null;
  const s=c.state, conversion=s.conversion;
  if (!["none","draft","pending_verification"].includes(conversion.quotation_status) ||
      !["none","draft","pending_confirmation"].includes(conversion.order_status) ||
      !["none","pending_quote"].includes(conversion.payment_status) ||
      s.quotes.length || s.delivery.confirmed || conversion.confirmed_entity_ids.length ||
      s.entities.some(e=>e.status==="confirmed") || s.installation.items.some(e=>e.status==="confirmed")) return null;
  const exact=(v:unknown)=>typeof v==="string"?v.normalize("NFKC").replace(/\s+/gu," ").trim():"";
  const facts=m.current_customer_facts.filter(f=>f.key==="customer_reported_quote_request"&&f.authority==="customer"&&typeof f.value==="string");
  if (facts.length!==1 || !facts[0].source_message_id || !quotationReportText(facts[0].value)) return null;
  const fact=facts[0], source=exact(input.question);
  let kind:"report"|"status";
  if (fact.source_message_id===input.source_message_id) {
    if (!frame || !["NO_STATE_CHANGE","UPDATE_ITEM"].includes(frame.operation) || frame.confidence<.72 ||
        frame.ambiguity.is_ambiguous || frame.additive || frame.customer_correction || frame.entities.length ||
        frame.requested_facts.length || frame.demands?.length || !frame.explicit_negations.length ||
        !frame.explicit_negations.every(n=>!!exact(n)&&source.includes(exact(n))) ||
        ![frame.transaction_state,frame.payment_state,frame.booking_state,frame.fulfillment_state].every(v=>v==="none"||v==="unknown") ||
        !frame.customer_facts?.some(f=>f.key===fact.key&&exact(f.value)===source) ||
        m.source_message_id!==input.source_message_id || c.source_message_id!==input.source_message_id ||
        exact(fact.value)!==source) return null;
    kind="report";
  } else {
    // Only the immediately preceding, unrecalled server-owned visitor report.
    // Do not substitute an older quote report across a subsequent topic or turn.
    const prior=input.trusted_visitor_source_rows?.[0];
    if (!isSourceBoundQuoteStatusQuestion(input.question,frame) ||
        !hasTrustedPersistedMemoryReadback(input) || input.trusted_visitor_source_status!=="verified" ||
        !prior || prior.id!==fact.source_message_id || exact(prior.content)!==exact(fact.value)) return null;
    kind="status";
  }
  const reply=language==="en"
    ? "Based on what you told me, this was an enquiry only. I have no verified merchant record of an order or payment. I cannot verify your live account activity."
    : language==="zh-CN"
    ? "按你提供的资料，这只是咨询。此对话没有可核实的交易完成记录。我尚未核实金额或商户的实时交易资料。"
    : "按你提供的資料，這只是查詢。此對話未有可核實的交易完成記錄。我尚未核實金額或商戶的即時交易資料。";
  return {reply,report_source_message_id:fact.source_message_id,kind};
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
        ...(e.quantity_unit_source_kind ? {
          quantity_unit_source_kind: e.quantity_unit_source_kind,
          quantity_unit_source_message_id: e.quantity_unit_source_message_id,
        } : {}),
      }))
      : [],
  };
  return { decision, reply, metadata };
}

/** The single customer-facing boundary for typed summary evidence.
 * It renders current values and lifecycle, never an internal Markdown/JSON
 * projection, historical corrections, or the wording that requested recall.
 */
export const CUSTOMER_OBSERVATION_RECAP_CONTRACT="source-bound-customer-observation-recap-v1";
export interface CustomerObservationRecapContext extends ContextualSourceContext {
  state_source_message_id:string|null;
  history:readonly {id?:string|null;role:string;content:string}[];
}
export function hasCustomerObservationRecap(state:ConversationCommerceState):boolean {
  return state.entities.length===0&&(state.customer_constraints[SCOPED_AREA_KEY]!=null||
    state.customer_constraints[PAIRED_SITE_KEY]!=null);
}
/** Reconstruct only current canonical observations, not a mutation receipt. */
export function customerObservationRecapEvidence(state:ConversationCommerceState,language:string,c:CustomerObservationRecapContext) {
  if(!hasCustomerObservationRecap(state)||!c.company_id||!c.conversation_id||!c.source_message_id||
    !Number.isSafeInteger(c.state_revision)||c.state_revision<1||!c.state_source_message_id||
    c.history.length>50)return null;
  const l=language==="en"?"en":language==="zh-CN"?"zh-CN":"zh-TW";
  const facts:{key:string;value:string;authority:string;source_message_id:string}[]=[];
  const sources:{id:string;text:string;role?:"assistant"}[]=[];
  const measurementSources=new Set<string>();
  if(state.customer_constraints[SCOPED_AREA_KEY]!=null){
    const r=readScopedAreaReceipt(state,c);
    const value=r?scopedAreaMemoryValue(r,c.history.filter(h=>h.id!==c.source_message_id),l):null;
    if(!r||!value)return null;
    facts.push({key:SCOPED_AREA_KEY,value,authority:"canonical_commerce",source_message_id:r.source_message_id});
    for(const source of scopedAreaSources(r)){
      sources.push(source);
      if(!source.role && source.id!==r.owner_source_message_id)measurementSources.add(source.id);
    }
  }
  if(state.customer_constraints[PAIRED_SITE_KEY]!=null){
    const r=readPairedSiteReceipt(state,c);
    if(!r)return null;
    // Preserve the existing paired-site Memory freshness boundary.
    const latest=r.scope_source_message_id??r.source_message_id;
    if(r.recorded_revision===c.state_revision&&latest===c.state_source_message_id){
      const value=pairedSiteMemoryValue(r,c.history,l);
      if(!value)return null;
      facts.push({key:PAIRED_SITE_KEY,value:value+(r.scope_site_label?" — "+r.scope_site_label:""),
        authority:"canonical_commerce",source_message_id:latest});
      sources.push({id:r.owner_source_message_id,text:r.owner_source_text},{id:r.source_message_id,text:r.source_text});
      measurementSources.add(r.source_message_id);
      if(r.scope_source_message_id&&r.scope_source_text){
        sources.push({id:r.scope_source_message_id,text:r.scope_source_text});
        measurementSources.add(r.scope_source_message_id);
      }
      if(r.scope_site_source_message_id&&r.scope_site_source_text)
        sources.push({id:r.scope_site_source_message_id,text:r.scope_site_source_text});
    }
  }
  const byId=new Map<string,string>();
  for(const source of sources){
    if(!source.id||source.id===c.source_message_id||
      (byId.has(source.id)&&byId.get(source.id)!==source.text))return null;
    byId.set(source.id,source.text);
  }
  if(byId.size>40)return null;
  for(const [id,text] of byId){
    const role=sources.find(source=>source.id===id)?.role??"visitor";
    const rows=c.history.filter(h=>h.role===role&&h.id===id);
    if(rows.length!==1||!pairedSiteSourceMatches(rows[0].content,text))return null;
  }
  return {facts,sources:sources.filter((s,i)=>sources.findIndex(other=>other.id===s.id)===i),measurementSources};
}
export function renderCanonicalCustomerFactRecap(state:ConversationCommerceState,language:string,
  context?:CustomerObservationRecapContext):string|null {
  const observation=context&&hasCustomerObservationRecap(state)
    ? customerObservationRecapEvidence(state,language,context):null;
  if(context&&hasCustomerObservationRecap(state)&&!observation)return null;
  const values=object(state.customer_constraints.customer_reported_facts);
  const facts=Object.entries(values??{}).flatMap(([key,value])=>{
    const row=object(value),p=object(row?.provenance);
    if(observation&&([SCOPED_AREA_KEY,PAIRED_SITE_KEY].includes(key)||
      (["room_size","room_area","site_observation"].includes(key)&&typeof p?.source_message_id==="string"&&
        observation.measurementSources.has(p.source_message_id))))return [];
    return !isLegacyRoomAreaKey(key) && row && row.source_count_visibility!=="exact_recall_only" && Object.prototype.hasOwnProperty.call(row,"value") && p?.source_type==="customer" && typeof p.source_message_id==="string"
      ? [{key,value:row.value,authority:"customer",source_message_id:p.source_message_id}] : [];
  });
  const current=[...facts,...(observation?.facts??[])];
  return current.length ? renderCustomerRecap({customer_facts:current},language) : null;
}

function renderCustomerRecap(value: unknown, language: string): string {
  const v = object(value) ?? {};
  const l = language === "en" ? 2 : language === "zh-CN" ? 1 : 0;
  const entities = (Array.isArray(v.entity_details) ? v.entity_details : []) as CommerceEntity[];
  const active = entities.filter(e => !["deferred", "cancelled"].includes(e.status));
  const label = (e: CommerceEntity) => customerOwnedDisplayLabel(e) ??
    ["已記錄項目", "已记录项目", "recorded item"][l];
  const unitLabels: Record<string, [string, string]> = {
    seat: ["席", "席"], seats: ["席", "席"], session: ["節", "节"], sessions: ["節", "节"],
    item: ["個", "个"], items: ["個", "个"], unit: ["個", "个"], units: ["個", "个"],
  };
  const describe = (e: CommerceEntity): string => {
    const unit = typeof e.attributes.unit === "string" ? e.attributes.unit
      : "";
    const count = customerRequestedQuantity(e) === null ? ["機數待確認", "数量待确认", "quantity not yet confirmed"][l] : l === 2 ? `${e.quantity}${unit ? " " + (e.quantity === 1 ? unit.replace(/s$/, "") : unit) : ""}`
      : `${e.quantity}${unit ? (unitLabels[unit]?.[l] ?? display(unit)) : ""}`;
    const facts: string[] = [];
    if (typeof e.constraints.max_width_mm === "number") facts.push(l === 2 ? `maximum width ${e.constraints.max_width_mm} mm` : `最闊${e.constraints.max_width_mm} mm`);
    if (e.model && !label(e).includes(e.model)) facts.push(display(e.model));
    const area = object(v.entity_area);
    if (area?.entity_id === e.entity_id && Array.isArray(area.rows)) {
      for (const row of area.rows) {
        const measure = object(row);
        if (!measure || typeof measure.scope !== "string" || typeof measure.amount !== "number" ||
            !["sq_ft", "sq_m"].includes(String(measure.unit))) continue;
        const symbol = measure.unit === "sq_ft" ? ["平方呎", "平方呎", " sq ft"][l] : ["平方米", "平方米", " sq m"][l];
        const qualifier = measure.approximate ? ["約", "约", "about "][l] : "";
        facts.push(measure.scope + " " + qualifier + measure.amount + symbol);
      }
    }
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
    if(isLegacyRoomAreaKey(f.key))return [];
    if(f.key==="brand_required" && typeof f.value==="boolean")return [prefix+(f.value?["你要求指定品牌","你要求指定品牌","you require a specific brand"]:["你冇限定品牌","你没有限定品牌","you do not require a specific brand"])[l]];
    const names: Record<string, [string,string,string]> = {scoped_area_observations:["各範圍面積","各范围面积","Area by scope"],paired_site_observation:["現場尺寸","现场尺寸","Site dimensions"],site_observation:["客人提供的現場資料","客户提供的现场资料","Customer-provided observation"],team_size:["團隊人數","团队人数","team size"],monthly_budget:["每月預算","每月预算","monthly budget"],automatic_renewal:["自動續訂","自动续订","automatic renewal"],preferred_interface_language:["介面語言","界面语言","interface language"],business_type:["業務類型","业务类型","business type"],priority:["優先需求","优先需求","priority"],budget:["預算","预算","budget"],room_area:["面積","面积","room area"],product_count:["商品數量","商品数量","product count"],staff_count:["人手","人手","staff count"],app_interest:["App 需要","App 需要","app needed"],preferred_interface:["使用介面","使用界面","preferred interface"],current_market:["目前市場","目前市场","current market"],desired_features:["需要功能","需要功能","required features"],future_markets:["未來市場","未来市场","future markets"]};
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
    const value = f.key===SCOPED_AREA_KEY && l!==2 && typeof f.value==="string"
      ? f.value.replace(/(\d)\s+(平方[呎尺米])/gu,"$1$2") : renderValue(f.value);
    return value === undefined ? [] : [prefix+(names[String(f.key)]?.[l] ?? display(String(f.key).replace(/_/g," ")))+": "+value];
  });
  const retainedText=retained.length ? ["而家記低咗","目前已记录","I have noted " ][l]+retained.join(l===2?"; ":"；")+(l===2?".":"。") : "";
  const ownedCounts=(Array.isArray(v.customer_facts)?v.customer_facts:[])
    .map(object).filter(f=>f?.authority==="customer"&&f.key==="quantity"&&
      typeof f.value==="number"&&Number.isInteger(f.value));
  const ownedCount=ownedCounts.length===1?ownedCounts[0]?.value:null;
  const conflictingQuantity=active.length===1&&typeof ownedCount==="number"&&
    customerRequestedQuantity(active[0])!==null&&active[0].quantity!==ownedCount;
  // Current state must not certify which of two contradictory counts was spoken.
  const conflictNote=conflictingQuantity?[
    "目前記錄的數量有矛盾，尚未核實，請確認最終要求。",
    "目前记录的数量有矛盾，尚未核实，请确认最终要求。",
    "Conflicting quantities are currently recorded; the final requirement is unverified and needs confirmation.",
  ][l]:"";
  const first = l === 2
    ? [active.length ? `I've noted ${active.map(describe).join("; ")}.` : "",
        inactive.length ? inactive.map(describe).join("; ") + "." : "",
        !entities.length ? retainedText || "No specific requirements are available yet." : ""].filter(Boolean).join(" ")
    : entities.length ? ["而家記低咗", "目前已记录"][l] + entities.map(describe).join("；") + "。"
    : retainedText || ["暫時未記低任何具體要求。", "暂时没有记录具体要求。"][l];
  const confirmed = Array.isArray(v.confirmed_entity_ids) ? v.confirmed_entity_ids : [];
  const global = v.selection_provenance === "global";
  const items = (global && entities.length ? ["項目：", "项目：", "Items: "][l] + first : first) +
    (entities.length && retainedText ? (l === 2 ? " " : "") + retainedText : "") +
    (conflictNote ? (l === 2 ? " " : "") + conflictNote : "");
  const pendingBooking = active.some(e => object(e.attributes.capabilities)?.requires_booking === true && !confirmed.includes(e.entity_id));
  const qualifications: string[] = [];
  if (pendingBooking) qualifications.push(["預約要求仍需職員確認，未成為已確認預約。", "预约要求仍需职员确认，尚未成为已确认预约。", "The booking still needs staff confirmation and is not confirmed yet."][l]);
  const siteRequired=active.some(e=>
    object(e.attributes.capabilities)?.requires_site_check===true);
  const pending=global && Array.isArray(v.operational_pending_checks) &&
    v.operational_pending_checks.length>0;
  if(siteRequired)qualifications.push(["適用性仍要按現行資料及現場條件核對。",
    "适用性仍需按现行资料及现场条件核对。",
    "Suitability still needs current evidence and the relevant site checks."][l]);
  else if(pending)qualifications.push(["仍有記錄中的待核對事項，尚未完成確認。",
    "仍有记录中的待核对事项，尚未完成确认。",
    "Some recorded checks still need verification."][l]);
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
