/**
 * TASK A3 — Commerce state runtime adapter.
 *
 * This module is the ONLY place where industry/appliance-specific extraction is
 * allowed. A1 (contract) and A2 (reducer + authority) stay frozen and universal.
 *
 * Responsibilities:
 *  - load persistent commerce state for (conversation_id, company_id)
 *  - derive events for the current customer turn (A2 universal derivation plus
 *    A3 runtime hints), reduce them, and persist through
 *    public.upsert_conversation_commerce_state_v1 with source_message_id and
 *    expected revision (one retry on revision_conflict, never a blind overwrite)
 *  - resolve the answer authority (A2) and build the customer-facing answer for
 *    CONVERSATION_STATE / DETERMINISTIC_CALCULATION / SAFE_PROFESSIONAL_CONFIRMATION
 *    and transaction-summary intents, while letting CURRENT_KB_REQUIRED fall
 *    through to the existing authoritative KB retrieval path.
 */

import {
  type ConversationCommerceState,
  createEmptyConversationCommerceState,
  isConversationCommerceState,
} from "./commerce-state-contract.ts";
import {
  type CommerceStateEvent,
  type CommerceTurnEntityHint,
  deriveCommerceEventsFromCustomerTurn,
  reduceCommerceState,
} from "./commerce-state-reducer.ts";
import {
  type CommerceAnswerAuthority,
  type CommerceCalculationTerm,
  resolveCommerceAnswerAuthority,
} from "./commerce-state-authority.ts";

export type CommerceLanguage = "zh-TW" | "zh-CN" | "en";

export interface CommerceStateQueryResult {
  data: unknown;
  error: unknown;
}

export interface CommerceStateDbClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<CommerceStateQueryResult>;
      };
    };
  };
  rpc(fn: string, params: Record<string, unknown>): Promise<CommerceStateQueryResult>;
}

export interface CommerceHistoryTurn {
  role: string;
  content: string;
}

export interface CommerceRuntimeInput {
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  text: string;
  language: CommerceLanguage;
  history?: CommerceHistoryTurn[];
  occurred_at?: string | null;
}

export interface CommerceRuntimeOutcome {
  authority: CommerceAnswerAuthority;
  reply: string | null;
  revision: number;
  persist_result: string;
  reason: string;
  state_path?: string | null;
  calculation?: { expression: string; result: number; currency?: string | null } | null;
  route: "commerce_state_answer" | "commerce_transaction_summary" | "commerce_kb_required";
}

const COMMERCE_STATE_RPC = "upsert_conversation_commerce_state_v1" as const;
const MAX_HISTORY_TURNS = 24;

function clean(value: unknown, max = 1600): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * A3 runtime extraction (industry-specific, intentionally NOT in A2)
 * ------------------------------------------------------------------ */

interface CategorySpec {
  key: string;
  label: Record<CommerceLanguage, string>;
  aliases: string[];
}

interface RoomSpec {
  key: string;
  label: Record<CommerceLanguage, string>;
  aliases: string[];
}

const CATEGORY_SPECS: CategorySpec[] = [
  {
    key: "air_conditioner",
    label: { "zh-TW": "冷氣機", "zh-CN": "空调", en: "air conditioner" },
    aliases: ["冷氣", "冷气", "空調", "空调", "air con", "aircon", "air-con", "air conditioner", "ac unit"],
  },
  {
    key: "refrigerator",
    label: { "zh-TW": "雪櫃", "zh-CN": "冰箱", en: "refrigerator" },
    aliases: ["雪櫃", "雪柜", "冰箱", "fridge", "refrigerator"],
  },
  {
    key: "washing_machine",
    label: { "zh-TW": "洗衣機", "zh-CN": "洗衣机", en: "washing machine" },
    aliases: ["洗衣機", "洗衣机", "washer", "washing machine"],
  },
  {
    key: "water_heater",
    label: { "zh-TW": "熱水爐", "zh-CN": "热水器", en: "water heater" },
    aliases: ["熱水爐", "热水器", "water heater"],
  },
  {
    key: "television",
    label: { "zh-TW": "電視", "zh-CN": "电视", en: "television" },
    aliases: ["電視", "电视", "television", " tv"],
  },
];

const ROOM_SPECS: RoomSpec[] = [
  {
    key: "living_room",
    label: { "zh-TW": "客廳", "zh-CN": "客厅", en: "living room" },
    aliases: ["客廳", "客厅", "living room", "lounge"],
  },
  {
    key: "bedroom",
    label: { "zh-TW": "睡房", "zh-CN": "卧室", en: "bedroom" },
    aliases: ["睡房", "臥室", "卧室", "房間", "房间", "bedroom"],
  },
  {
    key: "kitchen",
    label: { "zh-TW": "廚房", "zh-CN": "厨房", en: "kitchen" },
    aliases: ["廚房", "厨房", "kitchen"],
  },
];

function matchedAliases(lower: string, aliases: string[]): string[] {
  return aliases.filter((alias) => alias.trim().length >= 2 && lower.includes(alias.trim().toLowerCase()));
}

function detectCategories(text: string): CategorySpec[] {
  const lower = clean(text).toLowerCase();
  return CATEGORY_SPECS.filter((spec) => matchedAliases(lower, spec.aliases).length > 0);
}

function detectRooms(text: string): RoomSpec[] {
  const lower = clean(text).toLowerCase();
  return ROOM_SPECS.filter((spec) => matchedAliases(lower, spec.aliases).length > 0);
}

function entityLabel(entityId: string, language: CommerceLanguage): string {
  const [categoryKey, roomKey] = entityId.split(":");
  const category = CATEGORY_SPECS.find((x) => x.key === categoryKey);
  const room = ROOM_SPECS.find((x) => x.key === roomKey);
  const categoryText = category ? category.label[language] : clean(categoryKey, 60);
  if (!room) return categoryText;
  return language === "en"
    ? `${room.label.en} ${categoryText}`
    : `${room.label[language]}${categoryText}`;
}

/** Build entity hints from the whole conversation so state survives topic drift. */
export function buildCommerceEntityHints(texts: string[]): CommerceTurnEntityHint[] {
  const hints = new Map<string, CommerceTurnEntityHint>();
  for (const raw of texts) {
    const text = clean(raw);
    if (!text) continue;
    const categories = detectCategories(text);
    if (!categories.length) continue;
    const rooms = detectRooms(text);
    for (const category of categories) {
      const scopes = rooms.length ? rooms : [null];
      for (const room of scopes) {
        const entityId = room ? `${category.key}:${room.key}` : `${category.key}:unscoped`;
        if (hints.has(entityId)) continue;
        hints.set(entityId, {
          entity_id: entityId,
          category: category.key,
          aliases: [...category.aliases, ...(room ? room.aliases : [])],
        });
      }
    }
  }
  return [...hints.values()];
}

function hintsMentionedInTurn(text: string, hints: CommerceTurnEntityHint[]): CommerceTurnEntityHint[] {
  const lower = clean(text).toLowerCase();
  const rooms = detectRooms(text);
  const categories = detectCategories(text).map((x) => x.key);
  return hints.filter((hint) => {
    if (!categories.includes(hint.category)) return false;
    const [, roomKey] = hint.entity_id.split(":");
    if (!rooms.length) return true;
    if (roomKey === "unscoped") return false;
    return rooms.some((room) => room.key === roomKey) || Boolean(lower) === false;
  });
}

const COUNT_TOKEN = "[一二兩两三四五六七八九十]|\\d{1,4}";
const COUNT_UNIT = "部|台|件|個|个|套|張|张|units?|pcs?|pieces?";

function countTokenValue(raw: string): number | null {
  const map: Record<string, number> = {
    一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (/^\d+$/.test(raw)) return Number(raw);
  return map[raw] ?? null;
}

export function detectQuantityCorrectionSignal(text: string): boolean {
  const t = clean(text);
  return /(?:更正|改(?:做|成|為|为|返)?|變成|变成|唔係.+?(?:而係|係|系)|不是.+?(?:而是|是)|不係.+?(?:而係|係)|actually|change(?:\s+it)?\s+to|make\s+it)/i.test(t);
}

function parseCount(text: string): number | null {
  const t = clean(text);
  if (!t) return null;

  const correctionPatterns = [
    new RegExp(`(?:唔係|唔系|不是|不係)\\s*(?:${COUNT_TOKEN})\\s*(?:${COUNT_UNIT})?.{0,24}?(?:而係|而系|而是|係|系|是)\\s*(${COUNT_TOKEN})\\s*(?:${COUNT_UNIT})`, "i"),
    new RegExp(`(?:更正|改(?:做|成|為|为|返)?|變成|变成|change(?:\\s+it)?\\s+to|make\\s+it|actually)\\s*[:：,，]?\\s*(${COUNT_TOKEN})\\s*(?:${COUNT_UNIT})`, "i"),
  ];
  for (const pattern of correctionPatterns) {
    const correction = t.match(pattern);
    if (correction?.[1]) return countTokenValue(correction[1]);
  }

  const m = t.match(
    /(?:改(?:做|成|返)?|變成|变成|change to|要|need|order)?\s*([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|張|张|units?|pcs?|pieces?)/i,
  );
  if (!m?.[1]) return null;
  return countTokenValue(m[1]);
}

function detectCancellation(text: string): boolean {
  return /(?:取消|唔要|不要|唔買|不买|不買|cancel|remove it|drop it)/i.test(text);
}

function detectDeferral(text: string): boolean {
  return /(?:暫時唔|暫時不|暂时不|稍後先|稍后再|later|hold off|defer)/i.test(text);
}

const SITE_CHECK_PATTERNS: Array<[RegExp, string]> = [
  [/(?:窗口|窗台|window opening)/i, "window_opening_check"],
  [/(?:牆|墙|承重|wall strength|structural)/i, "wall_structure_check"],
  [/(?:電壓|电压|電力|电力|voltage|power supply|安培|amp)/i, "electrical_supply_check"],
  [/(?:排水|drainage|drain pipe|冷凝水)/i, "drainage_check"],
  [/(?:安裝|安装|installation|拆機|拆机|dismantle)/i, "installation_site_check"],
];

function detectSiteChecks(text: string): string[] {
  return SITE_CHECK_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, key]) => key);
}

function requiresProfessionalSiteCheck(text: string): boolean {
  return (
    /(?:啲|個|个)?(?:窗口|窗台|牆|墙|電壓|电压|排水|承重)/i.test(text) &&
    /(?:得唔得|可以嗎|可以吗|夠唔夠|够不够|安全|裝得|装得|OK嗎|ok\?|feasible|可行|支持|support)/i.test(text)
  ) || /(?:上門|上门|師傅|师傅|onsite|on-site|site (?:visit|survey)|technician)/i.test(text);
}

/* ------------------------------------------------------------------ *
 * Negation-aware transaction statement handling
 * A negated statement ("未正式落單", "not paid yet") must never be read as a
 * positive confirmation of order / payment / booking.
 * ------------------------------------------------------------------ */

const NEGATED_TX_PATTERNS: RegExp[] = [
  /(?:尚未|還未|还未|暫未|暂未|未|唔係|唔系|唔|冇|沒有|没有|沒|没|不是|不係|不)(?:係|系|會|会|有|想|要)?\s*(?:正式)?(?:落單|落单|下單|下单|確認落單|确认下单|確認訂單|确认订单|落實|落实|訂單|订单|確認|确认)/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|不)(?:係|系)?\s*正式/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|冇|沒有|没有|沒|没|不)\s*(?:付款|付錢|付钱|支付|畀錢|畀钱|付)/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|冇|沒有|没有|沒|没|不)\s*(?:預約|预约|約定|约定|約|约|安排|落實時間|落实时间)/gi,
  /\b(?:not|no|never|haven'?t|hasn'?t|have\s+not|has\s+not|didn'?t|did\s+not|don'?t|do\s+not|won'?t)\b[^.,;!?]{0,24}?\b(?:order(?:ed|s)?|paid|pay(?:ment|ing)?|confirm(?:ed)?|book(?:ed|ing)?|schedul(?:ed|e|ing))\b/gi,
  /\b(?:order|payment|booking|delivery|installation)\b[^.,;!?]{0,16}?\bnot\b\s*(?:yet\s*)?(?:been\s*)?(?:made|confirmed|placed|paid|booked|scheduled)?/gi,
];

interface NegatedTransactionScan {
  positive: string;
  negated_order: boolean;
  negated_payment: boolean;
  negated_booking: boolean;
}

function scanNegatedTransaction(text: string): NegatedTransactionScan {
  let positive = text;
  const removed: string[] = [];
  for (const pattern of NEGATED_TX_PATTERNS) {
    positive = positive.replace(pattern, (match) => {
      removed.push(match);
      return " ";
    });
  }
  const negated = removed.join(" ");
  return {
    positive,
    negated_order: /(?:落單|落单|下單|下单|訂單|订单|正式|確認|确认|order|confirm)/i.test(negated),
    negated_payment: /(?:付|支付|pay|paid)/i.test(negated),
    negated_booking: /(?:預約|预约|約|约|安排|book|schedul)/i.test(negated),
  };
}

function explicitOrderConfirmation(text: string): boolean {
  return /(?:已付款|已付|付咗|paid\b|正式落單|正式下单|確認落單|确认下单|confirm(?:ed)? (?:the )?order|已預約|已预约|booked)/i.test(text);
}

function explicitPaymentConfirmation(text: string): boolean {
  return /(?:已付款|已付|付咗|已支付|paid\b)/i.test(text);
}

function explicitBookingConfirmation(text: string): boolean {
  return /(?:已預約|已预约|已約|已约|已安排|booked|scheduled)/i.test(text);
}

function quotationOnlySignal(text: string): boolean {
  return /(?:報價|报价|quotation|quote|未落單|未下单|未正式|唔係落單|不是下单|先問價|先问价)/i.test(text);
}

export function detectTransactionSummaryIntent(text: string): boolean {
  return /(?:落單|下單|下单|落单|報價|报价|quotation|quote|付款|payment|checkout|幫我總結|帮我总结|總結一下|总结一下|整理(?:一下)?(?:比|畀|給|给)?同事|同事跟進|同事跟进|summar(?:y|ise|ize)|recap|hand over to)/i.test(clean(text));
}

function parseMoneyTerms(text: string): number[] {
  const amounts: number[] = [];
  const re = /(?:HK\$|HKD|\$|元|價|价|費|费|收費|收费|fee|price)\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?)|((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?)\s*(?:元|蚊|dollars?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) amounts.push(value);
  }
  return amounts;
}

export function detectExplicitCalculationRequest(text: string): boolean {
  return /(?:加埋|合共|總共|总共|一共|總數|总数|埋一齊|埋一起|total|altogether|calculate|計下|计下|算下|計算|计算|how much.*(?:total|altogether))/i.test(clean(text));
}

export function extractCommerceCalculationTerms(
  texts: string[],
  state: ConversationCommerceState,
  options?: { include_historical_state?: boolean },
): { terms: CommerceCalculationTerm[]; currency: string | null } {
  const amounts: number[] = [];
  for (const raw of texts) {
    const text = clean(raw);
    if (!text) continue;
    for (const amount of parseMoneyTerms(text)) amounts.push(amount);
  }
  if (options?.include_historical_state) {
    const textAmounts = new Set(amounts);
    for (const quote of state.quotes) {
      if (quote.quote_type !== "customer_reported_historical") continue;
      if (textAmounts.has(quote.amount)) continue;
      amounts.push(quote.amount);
    }
  }
  const unique: number[] = [];
  const seen = new Map<number, number>();
  for (const amount of amounts) {
    const count = seen.get(amount) ?? 0;
    if (count < 2) {
      seen.set(amount, count + 1);
      unique.push(amount);
    }
  }
  if (!unique.length) return { terms: [], currency: null };

  const currentTurnMultiplier = parseCount(texts[0] ?? "");
  const activeEntities = state.entities.filter(
    (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
  );
  const stateMultiplier = activeEntities.length === 1
    ? Math.max(1, activeEntities[0].quantity)
    : activeEntities.reduce((sum, entity) => sum + Math.max(0, entity.quantity), 0) || 1;
  const multiplier = currentTurnMultiplier ?? stateMultiplier;

  const currency = state.quotes.find((q) => q.currency)?.currency ?? "HKD";
  return {
    terms: unique.map((amount, index) => ({ label: `customer_term_${index + 1}`, value: amount, multiplier })),
    currency,
  };
}

function calculationExplicitlyUsesHistory(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return /(?:(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier).{0,40}(?:數字|数字|價|价|報價|报价|price|quote|figure|amount).{0,40}(?:計|计|算|calculate|total|合共|總共|总共)|(?:計|计|算|calculate|total|合共|總共|总共).{0,40}(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier))/i.test(t);
}

interface LoadedCommerceState {
  state: ConversationCommerceState;
  revision: number;
}

export async function loadCommerceState(
  db: CommerceStateDbClient,
  conversation_id: string,
): Promise<LoadedCommerceState> {
  const { data, error } = await db.from("conversation_commerce_state").select("revision, state").eq("conversation_id", conversation_id).maybeSingle();
  if (error || !isRecord(data)) return { state: createEmptyConversationCommerceState(), revision: 0 };
  const revision = typeof data["revision"] === "number" ? data["revision"] : Number(data["revision"] ?? 0);
  const state = data["state"];
  return {
    state: isConversationCommerceState(state) ? state : createEmptyConversationCommerceState(),
    revision: Number.isFinite(revision) && revision > 0 ? revision : 0,
  };
}

function deriveA3RuntimeEvents(
  input: CommerceRuntimeInput,
  hints: CommerceTurnEntityHint[],
  previous: ConversationCommerceState,
): CommerceStateEvent[] {
  const text = clean(input.text);
  const events: CommerceStateEvent[] = [];
  const provenance = {
    source_type: "customer" as const,
    source_message_id: input.source_message_id,
    recorded_at: input.occurred_at ?? null,
  };
  const mentioned = hintsMentionedInTurn(text, hints);
  const quantity = parseCount(text);
  const cancelled = detectCancellation(text);
  const deferred = detectDeferral(text);
  const additive = detectAdditiveEntityCreationSignal(text);
  const explicitCreation = detectExplicitEntityCreationSignal(text);
  const correction = detectQuantityCorrectionSignal(text);

  if (correction && quantity !== null && mentioned.length === 0) {
    const active = previous.entities.filter(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (active.length === 1) {
      events.push({
        type: "SET_ENTITY_QUANTITY",
        entity_id: active[0].entity_id,
        quantity,
        provenance,
      });
    }
  }

  for (const hint of mentioned) {
    if (cancelled) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "cancelled", provenance });
      continue;
    }
    if (deferred) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "deferred", provenance });
      continue;
    }
    if (quantity !== null && (additive || mentioned.length === 1)) {
      const existing = previous.entities.find((entity) => entity.entity_id === hint.entity_id);
      const nextQuantity = additive && existing ? existing.quantity + quantity : quantity;
      events.push({ type: "SET_ENTITY_QUANTITY", entity_id: hint.entity_id, quantity: nextQuantity, provenance });
    }
    if (quantity !== null || explicitCreation) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "tentative", provenance });
    }
  }

  const checks = detectSiteChecks(text);
  if (checks.length) events.push({ type: "SET_PENDING_CHECKS", checks });
  return events;
}

export function enforceQuotationNotOrderEvents(
  text: string,
  state: ConversationCommerceState,
): CommerceStateEvent[] {
  const scan = scanNegatedTransaction(text);
  const positiveOrder = explicitOrderConfirmation(scan.positive);
  const positivePayment = explicitPaymentConfirmation(scan.positive);
  const positiveBooking = explicitBookingConfirmation(scan.positive);
  const events: CommerceStateEvent[] = [];

  if (scan.negated_booking && !positiveBooking && state.delivery.confirmed) {
    events.push({ type: "SET_DELIVERY", patch: { confirmed: false }, provenance: { source_type: "derived" } });
  }
  if (positiveOrder) return events;

  const promoted = state.conversion.order_status === "confirmed" || state.conversion.order_status === "completed" || state.conversion.funnel_stage === "order_confirmed";
  const paidDrift = !positivePayment && scan.negated_payment && (state.conversion.payment_status === "paid" || state.conversion.payment_status === "pending_payment");

  if (!promoted && !paidDrift) {
    if (quotationOnlySignal(text) && state.conversion.quotation_status === "none") {
      events.push({ type: "SET_CONVERSION", patch: { funnel_stage: "quotation", quotation_status: "draft" } });
    }
    return events;
  }

  const patch: Partial<ConversationCommerceState["conversion"]> = {
    funnel_stage: "quotation",
    quotation_status: state.conversion.quotation_status === "none" ? "draft" : state.conversion.quotation_status,
  };
  if (promoted) patch.order_status = "draft";
  if (paidDrift) patch.payment_status = "pending_quote";
  events.push({ type: "SET_CONVERSION", patch });
  return events;
}

export function detectExplicitEntityCreationSignal(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  if (parseCount(t) !== null) return true;
  return /(?:另外|再加|再要|加多|加一|加個|加个|多要|多買|多买|新增|想買|想买|要買|要买|購買|购买|訂購|订购|落單|下單|下单|需要|我要|加裝|加装|安裝多|添置|add\s|buy\s|purchase|order\s|need\s|want\s|another|extra|additional)/i.test(t);
}

export function detectAdditiveEntityCreationSignal(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return /(?:另外\s*(?:加|要|買|买|訂|订|新增|加裝|加装)|再加|再要|加多|多要|多買|多买|新增多|加裝多|加装多|another|extra|additional|add\s+(?:another|one|two|three|\d))/i.test(t);
}

export function filterGhostUnscopedHints(
  text: string,
  state: ConversationCommerceState,
  hints: CommerceTurnEntityHint[],
): CommerceTurnEntityHint[] {
  const explicitCreation = detectExplicitEntityCreationSignal(text);
  const additive = detectAdditiveEntityCreationSignal(text);
  const categories = new Set(detectCategories(text).map((category) => category.key));
  const rooms = detectRooms(text);

  return hints.filter((hint) => {
    if (!categories.has(hint.category)) return true;
    const roomKey = hint.entity_id.split(":")[1];
    if (rooms.length > 0 && roomKey === "unscoped") return false;
    if (additive && rooms.length === 0) return roomKey === "unscoped";
    if (roomKey !== "unscoped") return true;
    if (state.entities.some((e) => e.entity_id === hint.entity_id)) return true;
    if (!explicitCreation) return false;
    const hasConcreteSameCategory = state.entities.some(
      (entity) => entity.category === hint.category && !entity.entity_id.endsWith(":unscoped") && entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (rooms.length === 0 && hasConcreteSameCategory) return false;
    return true;
  });
}

export function reduceTurn(
  previous: ConversationCommerceState,
  input: CommerceRuntimeInput,
  rawHints: CommerceTurnEntityHint[],
): ConversationCommerceState {
  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const hints = calculationTurn ? [] : filterGhostUnscopedHints(input.text, previous, rawHints);
  const derived = calculationTurn ? [] : deriveCommerceEventsFromCustomerTurn({
    text: input.text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    entity_hints: hints,
    current_language: input.language,
  });
  const runtimeEvents = calculationTurn ? [] : deriveA3RuntimeEvents(input, hints, previous);
  const reduced = reduceCommerceState(previous, [...derived, ...runtimeEvents]);
  const guard = enforceQuotationNotOrderEvents(clean(input.text), reduced);
  return guard.length ? reduceCommerceState(reduced, guard) : reduced;
}

function rpcResult(data: unknown): { result: string; applied_revision: number | null } {
  if (!isRecord(data)) return { result: "rpc_transport_error", applied_revision: null };
  const result = typeof data["result"] === "string" ? data["result"] : "rpc_unknown_result";
  const applied = data["applied_revision"];
  return { result, applied_revision: typeof applied === "number" ? applied : null };
}

export async function persistCommerceTurn(
  db: CommerceStateDbClient,
  input: CommerceRuntimeInput,
  hints: CommerceTurnEntityHint[],
): Promise<{ state: ConversationCommerceState; revision: number; result: string }> {
  const loaded = await loadCommerceState(db, input.conversation_id);
  let expected = loaded.revision;
  let next = reduceTurn(loaded.state, input, hints);

  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await db.rpc(COMMERCE_STATE_RPC, {
      p_conversation_id: input.conversation_id,
      p_company_id: input.company_id,
      p_expected_revision: expected,
      p_source_message_id: input.source_message_id,
      p_state: next,
    });
    if (error) return { state: next, revision: expected, result: "rpc_transport_error" };
    const parsed = rpcResult(data);
    if (parsed.result === "success") return { state: next, revision: parsed.applied_revision ?? expected + 1, result: "success" };
    if (parsed.result === "revision_conflict" && attempt === 0) {
      const reloaded = await loadCommerceState(db, input.conversation_id);
      expected = reloaded.revision;
      next = reduceTurn(reloaded.state, input, hints);
      continue;
    }
    return { state: next, revision: expected, result: parsed.result };
  }
  return { state: next, revision: expected, result: "revision_conflict" };
}

function statusLabel(status: string, language: CommerceLanguage): string {
  const table: Record<string, Record<CommerceLanguage, string>> = {
    cancelled: { "zh-TW": "已取消", "zh-CN": "已取消", en: "cancelled" },
    deferred: { "zh-TW": "暫緩", "zh-CN": "暂缓", en: "deferred" },
    confirmed: { "zh-TW": "已確認", "zh-CN": "已确认", en: "confirmed" },
    tentative: { "zh-TW": "初步", "zh-CN": "初步", en: "tentative" },
    researching: { "zh-TW": "考慮中", "zh-CN": "考虑中", en: "under consideration" },
  };
  return table[status]?.[language] ?? status;
}

export function buildTransactionSummary(
  state: ConversationCommerceState,
  language: CommerceLanguage,
): string {
  const lines: string[] = [];
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const inactive = state.entities.filter((e) => e.status === "cancelled" || e.status === "deferred");
  const historical = state.quotes.filter((q) => q.quote_type === "customer_reported_historical");

  const t = {
    head: { "zh-TW": "我幫你整理咗現時已確認嘅資料：", "zh-CN": "我帮你整理了目前已确认的资料：", en: "Here is what is on record so far:" },
    items: { "zh-TW": "項目", "zh-CN": "项目", en: "Items" },
    none: { "zh-TW": "暫時未有", "zh-CN": "暂时没有", en: "none yet" },
    removed: { "zh-TW": "已取消／暫緩", "zh-CN": "已取消／暂缓", en: "Cancelled / deferred" },
    delivery: { "zh-TW": "送貨安排", "zh-CN": "送货安排", en: "Delivery" },
    pending: { "zh-TW": "待師傅上門確認", "zh-CN": "待师傅上门确认", en: "Pending onsite professional checks" },
    quotes: { "zh-TW": "你提供嘅歷史報價（歷史數字，非現價）", "zh-CN": "你提供的历史报价（历史数字，非现价）", en: "Historical prices you provided (historical, not current)" },
    status: { "zh-TW": "目前狀態", "zh-CN": "目前状态", en: "Current status" },
    tail: { "zh-TW": "最新價格同工程費用仍然要同事確認之後才作準。", "zh-CN": "最新价格与工程费用仍需同事确认后才作准。", en: "Latest pricing and engineering fees still need to be confirmed by our team." },
  } as const;

  lines.push(t.head[language]);
  lines.push(`${t.items[language]}: ${active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity} (${statusLabel(e.status, language)})`).join("、") : t.none[language]}`);
  if (inactive.length) lines.push(`${t.removed[language]}: ${inactive.map((e) => `${entityLabel(e.entity_id, language)} (${statusLabel(e.status, language)})`).join("、")}`);
  const delivery = state.delivery;
  const deliveryParts = [delivery.preferred_date, delivery.preferred_window, delivery.address, delivery.recipient_name, delivery.recipient_phone].map((x) => clean(x, 180)).filter(Boolean);
  lines.push(`${t.delivery[language]}: ${deliveryParts.length ? deliveryParts.join(" / ") : t.none[language]}`);
  const pending = [...state.installation.pending_checks, ...state.installation.items.filter((i) => i.status === "pending").map((i) => i.kind)];
  if (pending.length) lines.push(`${t.pending[language]}: ${[...new Set(pending)].join("、")}`);
  if (historical.length) lines.push(`${t.quotes[language]}: ${historical.map((q) => `${q.currency} ${q.amount}`).join("、")}`);
  lines.push(`${t.status[language]}: ${state.conversion.funnel_stage} / quotation=${state.conversion.quotation_status} / order=${state.conversion.order_status} / payment=${state.conversion.payment_status}`);
  lines.push(t.tail[language]);
  return lines.join("\n");
}

function buildQuantityAnswer(state: ConversationCommerceState, language: CommerceLanguage): string | null {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  if (!active.length) return null;
  const total = active.reduce((sum, e) => sum + e.quantity, 0);
  const breakdown = active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、");
  if (language === "en") return `You currently have ${total} unit(s) in total: ${breakdown}.`;
  if (language === "zh-CN") return `你目前合共 ${total} 部：${breakdown}。`;
  return `你而家合共 ${total} 部：${breakdown}。`;
}

function buildKnownStateAnswer(language: CommerceLanguage, statePath: string, value: unknown, state: ConversationCommerceState): string {
  if (statePath.startsWith("entities.") && statePath.endsWith(".quantity")) {
    const answer = buildQuantityAnswer(state, language);
    if (answer) return answer;
  }
  const rendered = typeof value === "object" ? JSON.stringify(value) : clean(String(value), 300);
  if (language === "en") return `From what you already told me: ${rendered}.`;
  if (language === "zh-CN") return `按你之前提供的资料：${rendered}。`;
  return `按你之前提供嘅資料：${rendered}。`;
}

function formatCalculationNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function renderCalculationExpression(calculation: { expression: string; result: number }): string {
  const parsed = calculation.expression.split(" + ").map((part) => {
    const match = part.match(/^[^:]+:([0-9.]+)×([0-9.]+)$/);
    return match ? { value: Number(match[1]), multiplier: Number(match[2]) } : null;
  });
  if (parsed.length && parsed.every(Boolean)) {
    const terms = parsed as Array<{ value: number; multiplier: number }>;
    const multiplier = terms[0].multiplier;
    if (terms.every((term) => term.multiplier === multiplier)) {
      const values = terms.map((term) => formatCalculationNumber(term.value)).join(" + ");
      return `${formatCalculationNumber(multiplier)} × (${values}) = ${formatCalculationNumber(calculation.result)}`;
    }
  }
  return `${calculation.expression} = ${formatCalculationNumber(calculation.result)}`;
}

function buildCalculationAnswer(language: CommerceLanguage, calculation: { expression: string; result: number; currency?: string | null }): string {
  const currency = calculation.currency ?? "HKD";
  const rendered = renderCalculationExpression(calculation);
  if (language === "en") return `Based only on the figures in this calculation: ${rendered} (${currency}). Latest prices and engineering fees still need to be confirmed by our team.`;
  if (language === "zh-CN") return `只按你这次提供的数字计算：${rendered}（${currency}）。最新价格与工程费用仍需同事确认。`;
  return `只按你今次提供嘅數字計：${rendered}（${currency}）。最新價格同工程費用仍然要同事確認。`;
}

function buildProfessionalConfirmationAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  if (language === "en") return `${known ? `I still have your details on record: ${known}. ` : ""}For safety and accuracy, our technician needs to inspect the site in person before we can confirm whether the installation is suitable.`;
  if (language === "zh-CN") return `${known ? `我们已保留您之前提供的资料：${known}。` : ""}为确保安全和准确，需要师傅上门检查窗口尺寸、承托及安装环境后再确认是否适合安装。`;
  return `${known ? `我哋已保留您之前提供嘅資料：${known}。` : ""}為確保安全同準確，需要師傅上門檢查窗口尺寸、承托同安裝環境後先可以確認是否適合安裝。`;
}

export async function runCommerceStateRuntime(
  db: CommerceStateDbClient,
  input: CommerceRuntimeInput,
): Promise<CommerceRuntimeOutcome | null> {
  const text = clean(input.text);
  if (!text || !input.conversation_id || !input.company_id || !input.source_message_id) return null;

  const historyTexts = (input.history ?? []).filter((turn) => turn.role === "visitor" || turn.role === "user" || turn.role === "customer").slice(0, MAX_HISTORY_TURNS).map((turn) => clean(turn.content));
  const conversationTexts = [text, ...historyTexts];
  const hints = buildCommerceEntityHints(conversationTexts);

  const persisted = await persistCommerceTurn(db, input, hints);
  const state = persisted.state;
  const language = input.language;

  const summaryIntent = detectTransactionSummaryIntent(text);
  const wantsCalculation = detectExplicitCalculationRequest(text);
  const historicalCalculation = wantsCalculation && calculationExplicitlyUsesHistory(text);
  const calculationTexts = historicalCalculation ? conversationTexts : [text];
  const calculation = wantsCalculation
    ? extractCommerceCalculationTerms(calculationTexts, state, { include_historical_state: historicalCalculation })
    : { terms: [] as CommerceCalculationTerm[], currency: null };
  const decision = resolveCommerceAnswerAuthority({
    question: text,
    state,
    calculation_terms: calculation.terms,
    calculation_currency: calculation.currency,
    requires_professional_site_check: requiresProfessionalSiteCheck(text),
  });

  const base = { revision: persisted.revision, persist_result: persisted.result, reason: decision.reason };

  if (decision.authority === "SAFE_PROFESSIONAL_CONFIRMATION") {
    return { ...base, authority: decision.authority, reply: buildProfessionalConfirmationAnswer(language, state), route: "commerce_state_answer" };
  }

  if (decision.authority === "CONVERSATION_STATE" && decision.state_path) {
    return { ...base, authority: decision.authority, state_path: decision.state_path, reply: buildKnownStateAnswer(language, decision.state_path, decision.known_value, state), route: "commerce_state_answer" };
  }

  if (decision.authority === "DETERMINISTIC_CALCULATION" && decision.calculation) {
    return { ...base, authority: decision.authority, calculation: decision.calculation, reply: buildCalculationAnswer(language, decision.calculation), route: "commerce_state_answer" };
  }

  if (summaryIntent && (state.entities.length > 0 || state.quotes.length > 0)) {
    return { ...base, authority: "CONVERSATION_STATE", reply: buildTransactionSummary(state, language), route: "commerce_transaction_summary" };
  }

  return {
    ...base,
    authority: decision.authority === "CURRENT_KB_REQUIRED" ? "CURRENT_KB_REQUIRED" : decision.authority,
    reply: null,
    route: "commerce_kb_required",
  };
}
