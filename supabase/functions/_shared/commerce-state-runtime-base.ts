/**
 * TASK A3 — Commerce state runtime adapter.
 *
 * This module owns capability-driven commerce extraction plus optional industry
 * profiles. A1 (contract) and A2 (reducer + authority) stay frozen and universal.
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
  parseAddressReplacementCorrection,
  reduceCommerceState,
} from "./commerce-state-reducer.ts";
import {
  type CommerceAnswerAuthority,
  type CommerceCalculationTerm,
  resolveCommerceAnswerAuthority,
} from "./commerce-state-authority.ts";
import {
  buildCapabilityAwarePreorderNextStep,
  buildGenericCommerceEntityHints,
  genericEntityLabelFromId,
} from "./commerce-capability-runtime.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import {
  mergeCommerceEntityHints,
  semanticFrameToEntityHints,
  semanticFrameToStateEvents,
} from "./commerce-semantic-adapter.ts";
import { industryEntityLabel, resolveIndustryRuntime } from "./industry-runtime-adapter.ts";
import {
  HOME_APPLIANCE_CATEGORIES as CATEGORY_SPECS,
  HOME_APPLIANCE_ROOMS as ROOM_SPECS,
} from "./industry-profiles/home-appliance-v1.ts";

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
  semantic_frame?: CommerceSemanticFrame | null;
  industry_identifier?: string | null;
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
 * A3 runtime extraction (generic capability layer + optional industry profiles)
 * ------------------------------------------------------------------ */

function matchedAliases(lower: string, aliases: readonly string[]): string[] {
  return aliases.filter((alias) => alias.trim().length >= 2 && lower.includes(alias.trim().toLowerCase()));
}

function detectCategories(text: string) {
  const lower = clean(text).toLowerCase();
  return CATEGORY_SPECS.filter((spec) => matchedAliases(lower, spec.aliases).length > 0);
}

function detectRooms(text: string) {
  const lower = clean(text).toLowerCase();
  return ROOM_SPECS.filter((spec) => matchedAliases(lower, spec.aliases).length > 0);
}

function entityLabel(entityId: string, language: CommerceLanguage): string {
  const generic = genericEntityLabelFromId(entityId);
  if (generic) return generic;
  const industry = industryEntityLabel(entityId, language);
  if (industry) return industry;
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
    if (categories.length) {
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
      continue;
    }
    for (const hint of buildGenericCommerceEntityHints([text])) {
      const existing = hints.get(hint.entity_id);
      if (!existing) hints.set(hint.entity_id, hint);
      else hints.set(hint.entity_id, {
        ...existing,
        aliases: [...new Set([...(existing.aliases ?? []), ...(hint.aliases ?? [])])],
        attributes: { ...(existing.attributes ?? {}), ...(hint.attributes ?? {}) },
      });
    }
  }
  return [...hints.values()];
}

function hintsMentionedInTurn(text: string, hints: CommerceTurnEntityHint[]): CommerceTurnEntityHint[] {
  const lower = clean(text).toLowerCase();
  const rooms = detectRooms(text);
  const categories = detectCategories(text).map((x) => x.key);
  return hints.filter((hint) => {
    if (hint.entity_id.startsWith("generic:")) {
      return (hint.aliases ?? []).some((alias) => {
        const normalized = clean(alias, 80).toLowerCase();
        return normalized.length >= 2 && lower.includes(normalized);
      });
    }
    const [, roomKey] = hint.entity_id.split(":");
    if (!categories.includes(hint.category)) {
      // A scoped follow-up can refer to an already-known commerce entity by
      // room alone (for example, cancelling "the living-room one").
      return rooms.length > 0 && roomKey !== "unscoped" &&
        rooms.some((room) => room.key === roomKey);
    }
    if (!rooms.length) return true;
    if (roomKey === "unscoped") return false;
    return rooms.some((room) => room.key === roomKey) || Boolean(lower) === false;
  });
}

function hintRequiresBookingWithoutDelivery(hint: CommerceTurnEntityHint): boolean {
  const attributes = hint.attributes;
  if (!isRecord(attributes)) return false;
  const capabilities = attributes["capabilities"];
  if (!isRecord(capabilities)) return false;
  return capabilities["requires_booking"] === true
    && capabilities["requires_delivery"] !== true
    && capabilities["requires_installation"] !== true;
}

const COUNT_TOKEN = "[一二兩两三四五六七八九十]|\\d{1,4}";
const COUNT_UNIT = "部|台|件|個|个|套|張|张|盒|箱|包|袋|樽|瓶|支|枝|本|冊|册|對|对|雙|双|條|条|份|位|席|間|间|晚|次|堂|課|课|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?";

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
    /(?:改(?:做|成|返)?|變成|变成|change to|要|need|order)?\s*([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|張|张|盒|箱|包|袋|樽|瓶|支|枝|本|冊|册|對|对|雙|双|條|条|份|位|席|間|间|晚|次|堂|課|课|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?)/i,
  );
  if (!m?.[1]) return null;
  return countTokenValue(m[1]);
}

function isAllocationBreakdown(text: string): boolean {
  const matches = clean(text).match(
    /(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|units?|items?)/gi,
  );
  return (matches?.length ?? 0) > 1;
}

/**
 * A room counter is not itself a product-unit counter.  For room-scoped
 * appliances, however, an explicit allocation such as "two rooms plus a
 * living room" is authoritative evidence for the requested aggregate.  Keep
 * this separate from parseCount so isolated room sizes/counts never become a
 * product quantity, and require both a recognised commerce category and at
 * least one explicitly counted room group.
 */
export function parseSpaceScopedCommerceQuantity(text: string): number | null {
  const t = clean(text);
  if (!t || detectCategories(t).length === 0) return null;

  const countedRoom = t.match(
    /([一二兩两三四五六七八九十]|\d{1,2})\s*(?:間|间)\s*(?:睡房|臥室|卧室|房間|房间|客房|房)/i,
  );
  const base = countedRoom?.[1] ? countTokenValue(countedRoom[1]) : null;
  if (base === null || base < 1) return null;

  const remainder = t.slice((countedRoom?.index ?? 0) + countedRoom![0].length);
  const additionalSpaces = [
    /(?:一\s*(?:個|个|間|间)|(?:個|个))?\s*(?:客廳|客厅|廳|厅)/i,
    /(?:一\s*(?:個|个|間|间)|(?:個|个))?\s*(?:廚房|厨房)/i,
    /(?:an?\s+)?(?:living\s+room|lounge|kitchen)/i,
  ].reduce((sum, pattern) => sum + (pattern.test(remainder) ? 1 : 0), 0);

  return additionalSpaces > 0 ? base + additionalSpaces : null;
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

export function requiresProfessionalSiteCheck(text: string): boolean {
  const structural = /(?:啲|個|个)?(?:窗口|窗台|牆|墙|電壓|电压|排水|承重|wall strength|structural|voltage|drainage)/i.test(text)
    && /(?:得唔得|可以嗎|可以吗|夠唔夠|够不够|安全|裝得|装得|OK嗎|ok\?|feasible|可行|支持|support)/i.test(text);
  const installation = /(?:安裝|安装|installation|install|mount|拆機|拆机|dismantle)/i.test(text)
    && /(?:上門|上门|師傅|师傅|onsite|on-site|site (?:visit|survey)|technician|安全|可行|feasible)/i.test(text);
  return structural || installation;
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
  return /(?:幫我總結|帮我总结|總結一下|总结一下|幫我整理|帮我整理|整理(?:一下)?(?:比|畀|給|给)?同事|同事跟進|同事跟进|summar(?:y|ise|ize)|recap|hand over to)/i.test(clean(text));
}

export function detectCurrentPriceValidityQuestion(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  const historical = /(?:之前|以前|以往|舊|旧|歷史|历史|previous|earlier|old)/i.test(t);
  const price = /(?:報價|报价|價|价|price|quote|quotation|收費|收费|fee)/i.test(t);
  const current = /(?:而家|現在|现在|目前|最新|仲係|还是|仍然|current|latest|still)/i.test(t);
  const validity = /(?:一定|作準|作准|有效|同價|同价|一樣|一样|same|valid|guarantee|guaranteed)/i.test(t);
  return historical && price && (current || validity);
}

export function detectPreorderUnpaidIntent(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  const preorder = /(?:想預訂|想预订|想訂|想订|要預訂|要预订|預訂|预订|想預約|想预约|要預約|要预约|預約|预约|reserve|reservation|book(?:ing)?|pre[- ]?order|want to order|place an order)/i.test(t);
  return preorder && scanNegatedTransaction(t).negated_payment;
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
  const quantity = parseSpaceScopedCommerceQuantity(text) ?? parseCount(text);
  const cancelled = detectCancellation(text);
  const deferred = detectDeferral(text);
  const semanticAuthoritative = Boolean(
    input.semantic_frame && input.semantic_frame.confidence >= 0.72,
  );
  const activeAggregates = previous.entities.filter((entity) =>
    entity.entity_id.endsWith(":unscoped") &&
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  const additive = detectAdditiveEntityCreationSignal(text);
  const explicitCreation = detectExplicitEntityCreationSignal(text);
  const correction = detectQuantityCorrectionSignal(text);
  const allocationBreakdown = correction && isAllocationBreakdown(text);
  const addressCorrection = parseAddressReplacementCorrection(text);

  // The semantic adapter owns entity mutation when its frame is authoritative,
  // but B2 still needs the customer's exact correction ledger. Record explicit
  // quantity corrections here so a later, superseded tentative statement cannot
  // remain the apparent "latest" correction merely because semantic extraction
  // handled the entity updates.
  if (correction || addressCorrection) {
    events.push({ type: "ADD_CORRECTION", correction: text });
  }

  if (addressCorrection) {
    events.push({
      type: "SET_DELIVERY",
      patch: {},
      address_update: addressCorrection,
      provenance,
    });
  }

  if (
    correction && !allocationBreakdown && quantity !== null &&
    mentioned.length === 0
  ) {
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

  if (additive && quantity !== null && mentioned.length === 0) {
    const active = previous.entities.filter(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (active.length === 1) {
      events.push({
        type: "SET_ENTITY_QUANTITY",
        entity_id: active[0].entity_id,
        quantity: active[0].quantity + quantity,
        provenance,
      });
      events.push({ type: "SET_ENTITY_STATUS", entity_id: active[0].entity_id, status: "tentative", provenance });
    }
  }

  for (const hint of mentioned) {
    const existing = previous.entities.find((entity) =>
      entity.entity_id === hint.entity_id
    );
    const aggregate = previous.entities.find((entity) =>
      entity.category === hint.category &&
      entity.entity_id.endsWith(":unscoped") &&
      entity.status !== "cancelled" && entity.status !== "deferred"
    );
    const scopedEntity = hint.entity_id.startsWith(`${hint.category}:`) &&
      !hint.entity_id.endsWith(":unscoped");
    const canMaterializeSemanticScope = semanticAuthoritative && !existing &&
      scopedEntity && activeAggregates.length === 1 &&
      activeAggregates[0].category === hint.category;

    if ((cancelled || deferred) && canMaterializeSemanticScope) {
      events.push({
        type: "ENSURE_ENTITY",
        entity: {
          entity_id: hint.entity_id,
          category: hint.category,
          brand: hint.brand ?? null,
          model: hint.model ?? null,
          quantity: hint.quantity ?? 1,
          status: "tentative",
          attributes: { ...(hint.attributes ?? {}) },
          constraints: { ...(hint.constraints ?? {}) },
          provenance,
        },
      });
    }

    if (cancelled) {
      // A semantic-authoritative mutation may only target a durable entity or
      // the uniquely materialized scoped entity above. Ambiguous references
      // stay read-only so downstream clarification remains fail-closed.
      if (semanticAuthoritative && !existing && !canMaterializeSemanticScope) continue;
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "cancelled", provenance });
      if (!existing && aggregate && aggregate.quantity > 0) {
        events.push({
          type: "SET_ENTITY_QUANTITY",
          entity_id: aggregate.entity_id,
          quantity: Math.max(0, aggregate.quantity - (hint.quantity ?? 1)),
          provenance,
        });
      }
      continue;
    }
    if (deferred) {
      if (semanticAuthoritative && !existing && !canMaterializeSemanticScope) continue;
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "deferred", provenance });
      if (!existing && aggregate && aggregate.quantity > 0) {
        events.push({
          type: "SET_ENTITY_QUANTITY",
          entity_id: aggregate.entity_id,
          quantity: Math.max(0, aggregate.quantity - (hint.quantity ?? 1)),
          provenance,
        });
      }
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

function materializeRoomOnlyReferenceHints(
  text: string,
  state: ConversationCommerceState,
  hints: CommerceTurnEntityHint[],
): CommerceTurnEntityHint[] {
  const rooms = detectRooms(text);
  if (
    rooms.length === 0 || detectCategories(text).length > 0 ||
    (!detectCancellation(text) && !detectDeferral(text))
  ) return hints;

  const aggregateCategories = [...new Set(
    state.entities.filter((entity) =>
      entity.entity_id.endsWith(":unscoped") &&
      entity.status !== "cancelled" && entity.status !== "deferred"
    ).map((entity) => entity.category),
  )];
  // A room-only reference is resolvable only when the current state supplies
  // one authoritative aggregate category. Multiple active categories remain
  // ambiguous and must not be guessed here.
  if (aggregateCategories.length !== 1) return hints;

  const category = aggregateCategories[0];
  const canonicalEntityIds = new Set(rooms.map((room) => `${category}:${room.key}`));
  const roomAliases = rooms.flatMap((room) => room.aliases)
    .map((alias) => clean(alias, 80).toLowerCase())
    .filter(Boolean);
  // A semantic frame can describe the same scoped phrase with a generated
  // entity id (for example, generic:<room phrase>). Once the aggregate and
  // room make the reference deterministic, discard that non-persisted shadow
  // before events are built; otherwise it can fail mutation before the
  // canonical scoped entity is materialized and leave reply routing unaware
  // that the requested action was successfully resolved.
  const next = new Map(hints.filter((hint) => {
    if (hint.category !== category || canonicalEntityIds.has(hint.entity_id)) return true;
    if (state.entities.some((entity) => entity.entity_id === hint.entity_id)) return true;
    return !(hint.aliases ?? []).some((alias) => {
      const normalized = clean(alias, 80).toLowerCase();
      return normalized && roomAliases.some((roomAlias) =>
        normalized.includes(roomAlias) || roomAlias.includes(normalized)
      );
    });
  }).map((hint) => [hint.entity_id, hint]));
  for (const room of rooms) {
    const entity_id = `${category}:${room.key}`;
    if (!next.has(entity_id)) {
      next.set(entity_id, {
        entity_id,
        category,
        quantity: 1,
        aliases: [...room.aliases],
      });
    }
  }
  return [...next.values()];
}

export function reduceTurn(
  previous: ConversationCommerceState,
  input: CommerceRuntimeInput,
  rawHints: CommerceTurnEntityHint[],
): ConversationCommerceState {
  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const resolvedHints = calculationTurn
    ? []
    : materializeRoomOnlyReferenceHints(input.text, previous, rawHints);
  const hints = calculationTurn
    ? []
    : filterGhostUnscopedHints(input.text, previous, resolvedHints);
  const mentioned = calculationTurn ? [] : hintsMentionedInTurn(input.text, hints);
  const bookingWithoutDelivery = mentioned.some(hintRequiresBookingWithoutDelivery);
  const semanticAuthoritative = !calculationTurn && Boolean(input.semantic_frame && input.semantic_frame.confidence >= 0.72);
  const semanticEventsRaw = semanticAuthoritative
    ? semanticFrameToStateEvents(input.semantic_frame, previous, hints, input.source_message_id, input.occurred_at ?? null)
    : [];
  const semanticEvents = bookingWithoutDelivery
    ? semanticEventsRaw.filter((event) => event.type !== "SET_DELIVERY")
    : semanticEventsRaw;
  const deterministicEvents = calculationTurn ? [] : deriveCommerceEventsFromCustomerTurn({
    text: input.text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    entity_hints: hints,
    current_language: input.language,
  });
  // Semantic interpretation owns entity mutations, but it has no address
  // component contract. Keep deterministic delivery events so a complete
  // address is present before a later scoped correction is merged.
  const derivedRaw = semanticAuthoritative
    ? deterministicEvents.filter((event) => event.type === "SET_DELIVERY")
    : deterministicEvents;
  const allocationBreakdown = detectQuantityCorrectionSignal(input.text) &&
    isAllocationBreakdown(input.text);
  const derivedWithoutAllocationOverwrite = allocationBreakdown
    ? derivedRaw.filter((event) => event.type !== "SET_ENTITY_QUANTITY")
    : derivedRaw;
  const derived = bookingWithoutDelivery
    ? derivedWithoutAllocationOverwrite.filter((event) =>
      event.type !== "SET_DELIVERY"
    )
    : derivedWithoutAllocationOverwrite;
  const runtimeEvents = calculationTurn ? [] : deriveA3RuntimeEvents(input, hints, previous);
  const industryEvent: CommerceStateEvent[] = input.industry_identifier
    ? [{ type: "SET_CONTEXT", language: input.language, industry: input.industry_identifier }]
    : [];
  const reduced = reduceCommerceState(previous, [...industryEvent, ...semanticEvents, ...derived, ...runtimeEvents]);
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
    tail: { "zh-TW": "最新價格、適用費用同相關條件仍然要確認之後先作準。", "zh-CN": "最新价格、适用费用及相关条件仍需确认后才作准。", en: "Latest pricing, applicable fees and relevant conditions still need to be confirmed." },
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
  const orderConfirmed = state.conversion.order_status === "confirmed" || state.conversion.order_status === "completed";
  const paymentPaid = state.conversion.payment_status === "paid";
  if (language === "en") {
    lines.push(orderConfirmed ? "Order: confirmed." : "Order: not yet confirmed.");
    lines.push(paymentPaid ? "Payment: received." : "Payment: no confirmed payment on record yet.");
  } else if (language === "zh-CN") {
    lines.push(orderConfirmed ? "订单：已确认。" : "订单：尚未确认。");
    lines.push(paymentPaid ? "付款：已确认收到。" : "付款：目前未有已付款记录。");
  } else {
    lines.push(orderConfirmed ? "訂單：已確認。" : "訂單：尚未確認。");
    lines.push(paymentPaid ? "付款：已確認收到。" : "付款：目前未有已付款記錄。");
  }
  lines.push(t.tail[language]);
  return lines.join("\n");
}

function buildQuantityAnswer(state: ConversationCommerceState, language: CommerceLanguage): string | null {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  if (!active.length) return null;
  const total = active.reduce((sum, e) => sum + e.quantity, 0);
  const breakdown = active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、");
  if (language === "en") return `You currently have ${total} unit(s) in total: ${breakdown}.`;
  if (language === "zh-CN") return `你目前合共 ${total} 个单位：${breakdown}。`;
  return `你而家合共 ${total} 個單位：${breakdown}。`;
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

function buildResolvedEntityStatusChangeAnswer(input: CommerceRuntimeInput, state: ConversationCommerceState): string | null {
  if (!detectCancellation(input.text) && !detectDeferral(input.text)) return null;
  const changed = state.entities.filter((entity) =>
    ["cancelled", "deferred"].includes(entity.status) &&
    entity.provenance.source_message_id === input.source_message_id
  );
  // Only this turn's uniquely resolved entity may bypass clarification.
  if (changed.length !== 1) return null;
  const entity = changed[0];
  const activeQuantity = state.entities.filter((candidate) =>
    candidate.category === entity.category &&
    !["cancelled", "deferred"].includes(candidate.status)
  ).reduce((total, candidate) => total + candidate.quantity, 0);
  const label = entityLabel(entity.entity_id, input.language);
  const status = statusLabel(entity.status, input.language);
  if (input.language === "en") return `${label} is ${status}. The current active quantity is ${activeQuantity}.`;
  if (input.language === "zh-CN") return `${label}${status}；目前有效数量为 ${activeQuantity} 部。`;
  return `${label}${status}；而家有效數量係 ${activeQuantity} 部。`;
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
  if (language === "en") return `Based only on the figures in this calculation: ${rendered} (${currency}). Latest prices, applicable fees and conditions still need to be confirmed.`;
  if (language === "zh-CN") return `只按你这次提供的数字计算：${rendered}（${currency}）。最新价格、适用费用及相关条件仍需确认。`;
  return `只按你今次提供嘅數字計：${rendered}（${currency}）。最新價格、適用費用同相關條件仍然要確認。`;
}

function buildProfessionalConfirmationAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  if (language === "en") return `${known ? `I still have your details on record: ${known}. ` : ""}For safety and accuracy, our technician needs to inspect the site in person before we can confirm whether the installation is suitable.`;
  if (language === "zh-CN") return `${known ? `我们已保留您之前提供的资料：${known}。` : ""}为确保安全和准确，需要师傅上门检查窗口尺寸、承托及安装环境后再确认是否适合安装。`;
  return `${known ? `我哋已保留您之前提供嘅資料：${known}。` : ""}為確保安全同準確，需要師傅上門檢查窗口尺寸、承托同安裝環境後先可以確認是否適合安裝。`;
}

export function buildCurrentPriceValidityAnswer(language: CommerceLanguage): string {
  if (language === "en") return "Not necessarily. A previous quote is only a reference and does not guarantee the current price. The latest price, applicable fees and relevant conditions need to be confirmed again before they are final.";
  if (language === "zh-CN") return "未必。你之前看到的报价只可作为参考，并不代表目前仍是同一价格。最新价格、适用费用及相关条件需要重新确认后才作准。";
  return "未必。你之前見過嘅報價只可以作參考，唔代表而家仍然係同一個價。最新價格、適用費用同相關條件需要重新確認後先作準。";
}

export function buildPreorderUnpaidAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  const nextStep = buildCapabilityAwarePreorderNextStep(state, language);
  if (language === "en") return `${known ? `Got it — you want to reserve ${known}. ` : "Got it — you want to proceed. "}Since payment has not been made yet, this is not a completed or confirmed order. ${nextStep}`;
  if (language === "zh-CN") return `${known ? `好的，我知道你想预订${known}。` : "好的，我知道你想继续预订。"}由于目前还未付款，所以现在还不算已完成或已确认订单。${nextStep}`;
  return `${known ? `好，我知道你想預訂${known}。` : "好，我知道你想繼續預訂。"}因為你仲未付款，所以而家未算完成或已確認訂單。${nextStep}`;
}

export async function runCommerceStateRuntime(
  db: CommerceStateDbClient,
  input: CommerceRuntimeInput,
): Promise<CommerceRuntimeOutcome | null> {
  const text = clean(input.text);
  if (!text || !input.conversation_id || !input.company_id || !input.source_message_id) return null;

  const language = input.language;
  if (detectPreorderUnpaidIntent(text)) {
    const loaded = await loadCommerceState(db, input.conversation_id);
    const hasActiveEntity = loaded.state.entities.some(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (hasActiveEntity) {
      return {
        authority: "CONVERSATION_STATE",
        reply: buildPreorderUnpaidAnswer(language, loaded.state),
        revision: loaded.revision,
        persist_result: "read_only",
        reason: "preorder_intent_acknowledged_without_order_or_payment_promotion",
        route: "commerce_state_answer",
      };
    }
  }

  const historyTexts = (input.history ?? []).filter((turn) => turn.role === "visitor" || turn.role === "user" || turn.role === "customer").slice(0, MAX_HISTORY_TURNS).map((turn) => clean(turn.content));
  const conversationTexts = [text, ...historyTexts];
  const deterministicHints = buildCommerceEntityHints(conversationTexts);
  const semanticHints = semanticFrameToEntityHints(input.semantic_frame);
  const industry = resolveIndustryRuntime({
    texts: conversationTexts,
    semantic_frame: input.semantic_frame,
    industry_identifier: input.industry_identifier,
  });
  const hints = mergeCommerceEntityHints(
    semanticHints,
    mergeCommerceEntityHints(industry.hints, deterministicHints),
  );
  const runtimeInput = industry.industry_id && !input.industry_identifier
    ? { ...input, industry_identifier: industry.industry_id }
    : input;

  const persisted = await persistCommerceTurn(db, runtimeInput, hints);
  const state = persisted.state;

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

  const resolvedStatusChangeReply = persisted.result === "success"
    ? buildResolvedEntityStatusChangeAnswer(runtimeInput, state)
    : null;
  if (resolvedStatusChangeReply) {
    return {
      ...base,
      authority: "CONVERSATION_STATE",
      reason: "explicit_entity_status_change_applied",
      reply: resolvedStatusChangeReply,
      route: "commerce_state_answer",
    };
  }

  if (decision.authority === "SAFE_PROFESSIONAL_CONFIRMATION") {
    return { ...base, authority: decision.authority, reply: buildProfessionalConfirmationAnswer(language, state), route: "commerce_state_answer" };
  }

  if (detectPreorderUnpaidIntent(text)) {
    return { ...base, authority: "CONVERSATION_STATE", reason: "preorder_intent_acknowledged_without_order_or_payment_promotion", reply: buildPreorderUnpaidAnswer(language, state), route: "commerce_state_answer" };
  }

  if (decision.authority === "CONVERSATION_STATE" && decision.state_path) {
    return { ...base, authority: decision.authority, state_path: decision.state_path, reply: buildKnownStateAnswer(language, decision.state_path, decision.known_value, state), route: "commerce_state_answer" };
  }

  if (decision.authority === "DETERMINISTIC_CALCULATION" && decision.calculation) {
    return { ...base, authority: decision.authority, calculation: decision.calculation, reply: buildCalculationAnswer(language, decision.calculation), route: "commerce_state_answer" };
  }

  if (detectCurrentPriceValidityQuestion(text)) {
    return { ...base, authority: "CURRENT_KB_REQUIRED", reason: "previous_quote_not_authoritative_for_current_price", reply: buildCurrentPriceValidityAnswer(language), route: "commerce_state_answer" };
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
