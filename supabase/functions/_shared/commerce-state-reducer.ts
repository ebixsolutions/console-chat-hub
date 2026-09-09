import {
  COMMERCE_STATE_VERSION,
  createEmptyConversationCommerceState,
  type CommerceEntity,
  type CommerceEntityStatus,
  type CommerceFunnelStage,
  type CommerceInstallationItem,
  type CommerceOrderStatus,
  type CommercePaymentStatus,
  type CommerceProvenance,
  type CommerceQuote,
  type CommerceQuotationStatus,
  type ConversationCommerceState,
} from "./commerce-state-contract.ts";

export type CommerceStateEvent =
  | { type: "SET_CONTEXT"; language?: "zh-TW" | "zh-CN" | "en" | null; intent?: string | null; topic?: string | null; industry?: string | null }
  | { type: "ADD_ENTITY"; entity: CommerceEntity }
  | { type: "UPDATE_ENTITY"; entity_id: string; patch: Partial<Omit<CommerceEntity, "entity_id">>; provenance?: CommerceProvenance }
  | { type: "SET_ENTITY_STATUS"; entity_id: string; status: CommerceEntityStatus; provenance: CommerceProvenance }
  | { type: "SET_ENTITY_QUANTITY"; entity_id: string; quantity: number; provenance: CommerceProvenance }
  | { type: "SET_ENTITY_ATTRIBUTE"; entity_id: string; key: string; value: unknown; provenance: CommerceProvenance }
  | { type: "SET_ENTITY_CONSTRAINT"; entity_id: string; key: string; value: unknown; provenance: CommerceProvenance }
  | { type: "REMOVE_ENTITY_CONSTRAINT"; entity_id: string; key: string; provenance: CommerceProvenance }
  | { type: "ADD_QUOTE"; quote: CommerceQuote }
  | { type: "SET_QUOTE_VALIDITY"; quote_id: string; validity_status: CommerceQuote["validity_status"] }
  | { type: "SET_DELIVERY"; patch: Partial<ConversationCommerceState["delivery"]>; provenance: CommerceProvenance }
  | { type: "UPSERT_INSTALLATION_ITEM"; item: CommerceInstallationItem }
  | { type: "SET_SITE_CONDITION"; key: string; value: unknown }
  | { type: "SET_PENDING_CHECKS"; checks: string[] }
  | { type: "SET_CONVERSION"; patch: Partial<ConversationCommerceState["conversion"]> }
  | { type: "ADD_CORRECTION"; correction: string }
  | { type: "SET_UNRESOLVED_ITEMS"; items: string[] }
  | { type: "SET_CUSTOMER_CONSTRAINT"; key: string; value: unknown }
  | { type: "REMOVE_CUSTOMER_CONSTRAINT"; key: string };

export interface CommerceTurnEntityHint {
  entity_id: string;
  category: string;
  aliases?: string[];
  status?: CommerceEntityStatus;
  quantity?: number;
  brand?: string | null;
  model?: string | null;
  attributes?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
}

export interface CommerceTurnInterpretationInput {
  text: string;
  source_message_id: string;
  occurred_at?: string | null;
  currency?: string;
  entity_hints?: CommerceTurnEntityHint[];
  current_industry?: string | null;
  current_language?: "zh-TW" | "zh-CN" | "en" | null;
}

const MAX_CORRECTIONS = 50;
const MAX_UNRESOLVED = 100;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clean(value: unknown, max = 1200): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((x) => clean(x, 300)).filter(Boolean))];
}

function provenance(source_message_id: string, occurred_at?: string | null): CommerceProvenance {
  return {
    source_type: "customer",
    source_message_id,
    recorded_at: occurred_at ?? null,
  };
}

function findEntityIndex(state: ConversationCommerceState, entityId: string): number {
  return state.entities.findIndex((x) => x.entity_id === entityId);
}

function reconcileConversionEntityLists(state: ConversationCommerceState): void {
  const confirmed: string[] = [];
  const tentative: string[] = [];
  const cancelled: string[] = [];
  for (const entity of state.entities) {
    if (entity.status === "confirmed") confirmed.push(entity.entity_id);
    else if (entity.status === "tentative") tentative.push(entity.entity_id);
    else if (entity.status === "cancelled") cancelled.push(entity.entity_id);
  }
  state.conversion.confirmed_entity_ids = uniq(confirmed);
  state.conversion.tentative_entity_ids = uniq(tentative);
  state.conversion.cancelled_entity_ids = uniq(cancelled);
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid_${label}`);
}

function assertStateShape(state: ConversationCommerceState): void {
  if (state.version !== COMMERCE_STATE_VERSION) throw new Error("commerce_state_version_mismatch");
  const ids = new Set<string>();
  for (const entity of state.entities) {
    if (!entity.entity_id || ids.has(entity.entity_id)) throw new Error("duplicate_or_empty_entity_id");
    ids.add(entity.entity_id);
    assertFiniteNonNegative(entity.quantity, "entity_quantity");
  }
  const quoteIds = new Set<string>();
  for (const quote of state.quotes) {
    if (!quote.quote_id || quoteIds.has(quote.quote_id)) throw new Error("duplicate_or_empty_quote_id");
    quoteIds.add(quote.quote_id);
    assertFiniteNonNegative(quote.amount, "quote_amount");
  }
}

export function reduceCommerceState(
  previous: ConversationCommerceState | null | undefined,
  events: CommerceStateEvent[],
): ConversationCommerceState {
  const next = clone(previous ?? createEmptyConversationCommerceState());
  assertStateShape(next);

  for (const event of events) {
    switch (event.type) {
      case "SET_CONTEXT": {
        if (event.language !== undefined) next.language = event.language;
        if (event.intent !== undefined) next.current_intent = event.intent;
        if (event.topic !== undefined) next.current_topic = event.topic;
        if (event.industry !== undefined) next.current_industry = event.industry;
        break;
      }
      case "ADD_ENTITY": {
        assertFiniteNonNegative(event.entity.quantity, "entity_quantity");
        const idx = findEntityIndex(next, event.entity.entity_id);
        if (idx >= 0) {
          next.entities[idx] = {
            ...next.entities[idx],
            ...clone(event.entity),
            attributes: { ...next.entities[idx].attributes, ...clone(event.entity.attributes) },
            constraints: { ...next.entities[idx].constraints, ...clone(event.entity.constraints) },
          };
        } else {
          next.entities.push(clone(event.entity));
        }
        break;
      }
      case "UPDATE_ENTITY": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        const old = next.entities[idx];
        const patch = clone(event.patch);
        if (patch.quantity !== undefined) assertFiniteNonNegative(patch.quantity, "entity_quantity");
        next.entities[idx] = {
          ...old,
          ...patch,
          entity_id: old.entity_id,
          attributes: patch.attributes ? { ...old.attributes, ...patch.attributes } : old.attributes,
          constraints: patch.constraints ? { ...old.constraints, ...patch.constraints } : old.constraints,
          provenance: event.provenance ?? patch.provenance ?? old.provenance,
        };
        break;
      }
      case "SET_ENTITY_STATUS": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        next.entities[idx] = { ...next.entities[idx], status: event.status, provenance: clone(event.provenance) };
        break;
      }
      case "SET_ENTITY_QUANTITY": {
        assertFiniteNonNegative(event.quantity, "entity_quantity");
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        next.entities[idx] = { ...next.entities[idx], quantity: event.quantity, provenance: clone(event.provenance) };
        break;
      }
      case "SET_ENTITY_ATTRIBUTE": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        next.entities[idx] = {
          ...next.entities[idx],
          attributes: { ...next.entities[idx].attributes, [event.key]: clone(event.value) },
          provenance: clone(event.provenance),
        };
        break;
      }
      case "SET_ENTITY_CONSTRAINT": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        next.entities[idx] = {
          ...next.entities[idx],
          constraints: { ...next.entities[idx].constraints, [event.key]: clone(event.value) },
          provenance: clone(event.provenance),
        };
        break;
      }
      case "REMOVE_ENTITY_CONSTRAINT": {
        const idx = findEntityIndex(next, event.entity_id);
        if (idx < 0) throw new Error("commerce_entity_not_found");
        const constraints = { ...next.entities[idx].constraints };
        delete constraints[event.key];
        next.entities[idx] = { ...next.entities[idx], constraints, provenance: clone(event.provenance) };
        break;
      }
      case "ADD_QUOTE": {
        assertFiniteNonNegative(event.quote.amount, "quote_amount");
        const idx = next.quotes.findIndex((x) => x.quote_id === event.quote.quote_id);
        if (idx >= 0) next.quotes[idx] = clone(event.quote);
        else next.quotes.push(clone(event.quote));
        break;
      }
      case "SET_QUOTE_VALIDITY": {
        const idx = next.quotes.findIndex((x) => x.quote_id === event.quote_id);
        if (idx < 0) throw new Error("commerce_quote_not_found");
        next.quotes[idx] = { ...next.quotes[idx], validity_status: event.validity_status };
        break;
      }
      case "SET_DELIVERY": {
        next.delivery = { ...next.delivery, ...clone(event.patch), provenance: clone(event.provenance) };
        break;
      }
      case "UPSERT_INSTALLATION_ITEM": {
        const idx = next.installation.items.findIndex((x) => x.item_id === event.item.item_id);
        if (idx >= 0) next.installation.items[idx] = clone(event.item);
        else next.installation.items.push(clone(event.item));
        break;
      }
      case "SET_SITE_CONDITION": {
        next.installation.site_conditions = {
          ...next.installation.site_conditions,
          [event.key]: clone(event.value),
        };
        break;
      }
      case "SET_PENDING_CHECKS": {
        next.installation.pending_checks = uniq(event.checks);
        break;
      }
      case "SET_CONVERSION": {
        next.conversion = { ...next.conversion, ...clone(event.patch) };
        break;
      }
      case "ADD_CORRECTION": {
        next.latest_corrections = uniq([...next.latest_corrections, event.correction]).slice(-MAX_CORRECTIONS);
        break;
      }
      case "SET_UNRESOLVED_ITEMS": {
        next.unresolved_items = uniq(event.items).slice(0, MAX_UNRESOLVED);
        break;
      }
      case "SET_CUSTOMER_CONSTRAINT": {
        next.customer_constraints = { ...next.customer_constraints, [event.key]: clone(event.value) };
        break;
      }
      case "REMOVE_CUSTOMER_CONSTRAINT": {
        const constraints = { ...next.customer_constraints };
        delete constraints[event.key];
        next.customer_constraints = constraints;
        break;
      }
      default: {
        const _never: never = event;
        throw new Error(`unsupported_commerce_event:${String(_never)}`);
      }
    }
  }

  reconcileConversionEntityLists(next);
  assertStateShape(next);
  return next;
}

function normalizedAliases(hint: CommerceTurnEntityHint): string[] {
  return uniq([hint.entity_id, hint.category, hint.brand ?? "", hint.model ?? "", ...(hint.aliases ?? [])])
    .map((x) => x.toLowerCase());
}

function mentionedHints(text: string, hints: CommerceTurnEntityHint[]): CommerceTurnEntityHint[] {
  const lower = text.toLowerCase();
  return hints.filter((hint) => normalizedAliases(hint).some((alias) => alias.length >= 2 && lower.includes(alias)));
}

function ensureHintEntityEvents(input: CommerceTurnInterpretationInput, hints: CommerceTurnEntityHint[]): CommerceStateEvent[] {
  const p = provenance(input.source_message_id, input.occurred_at);
  return hints.map((hint) => ({
    type: "ADD_ENTITY" as const,
    entity: {
      entity_id: hint.entity_id,
      category: hint.category,
      brand: hint.brand ?? null,
      model: hint.model ?? null,
      quantity: hint.quantity ?? 1,
      status: hint.status ?? "researching",
      attributes: clone(hint.attributes ?? {}),
      constraints: clone(hint.constraints ?? {}),
      provenance: p,
    },
  }));
}

function parseExplicitQuantity(text: string): number | null {
  const m = text.match(/(?:qty|quantity|數量|数量|共|總共|总共|要|需要|買|买|訂|订)\s*(?:係|是|=|:|：)?\s*(\d{1,4})\s*(?:件|個|个|部|台|份|位|張|张|套|間|间|晚|night|nights|pcs?|pieces?|units?|items?)?/i)
    ?? text.match(/\b(\d{1,4})\s*(?:pcs?|pieces?|units?|items?)\b/i);
  return m?.[1] ? Number(m[1]) : null;
}

function parseMoney(text: string): { amount: number; currency: string } | null {
  const m = text.match(/(?:HK\$|US\$|NT\$|TWD\s*|USD\s*|HKD\s*|\$)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i)
    ?? text.match(/(?:價|价|報價|报价|quote|quoted|price)\s*(?:係|是|為|为|=|:|：)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  if (!m?.[1]) return null;
  const amount = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const prefix = m[0].toUpperCase();
  const currency = prefix.includes("US$") || prefix.includes("USD") ? "USD"
    : prefix.includes("NT$") || prefix.includes("TWD") ? "TWD"
    : "HKD";
  return { amount, currency };
}

function detectEntityStatus(text: string): CommerceEntityStatus | null {
  if (/(?:取消|唔要|不要|不買|不买|唔買|cancel(?:led)?|remove it|drop it)/i.test(text)) return "cancelled";
  if (/(?:暫時唔|暫時不|暂时不|稍後先|稍后再|defer|later|hold off)/i.test(text)) return "deferred";
  if (/(?:確認要|确认要|確定要|确定要|就要|confirmed?|keep it|take it)/i.test(text)) return "confirmed";
  if (/(?:考慮|考虑|睇下|看看|研究|research|consider)/i.test(text)) return "researching";
  return null;
}

function detectFunnel(text: string): { funnel_stage?: CommerceFunnelStage; quotation_status?: CommerceQuotationStatus; order_status?: CommerceOrderStatus; payment_status?: CommercePaymentStatus } | null {
  if (/(?:已付款|已付|paid\b)/i.test(text)) return { funnel_stage: "order_confirmed", order_status: "confirmed", payment_status: "paid" };
  if (/(?:正式落單|正式下单|confirm(?:ed)? order|order confirmed)/i.test(text)) return { funnel_stage: "order_confirmed", order_status: "confirmed" };
  if (/(?:未正式落單|未正式下单|唔係正式落單|不是正式下单|not (?:a )?confirmed order|quotation only|只係報價|只是报价)/i.test(text)) {
    return { funnel_stage: "quotation", quotation_status: "draft", order_status: "draft", payment_status: "pending_quote" };
  }
  if (/(?:準備落單|准备下单|ready to order|準備下單|准备落单)/i.test(text)) return { funnel_stage: "checkout_ready", order_status: "pending_confirmation" };
  if (/(?:報價|报价|quotation|quote)/i.test(text)) return { funnel_stage: "quotation", quotation_status: "draft" };
  return null;
}

function correctionText(text: string): string | null {
  if (/(?:更正|改返|改成|最新|記住|记住|唔係|不是|actually|i meant|correction)/i.test(text)) return text;
  return null;
}

function explicitDeliveryPatch(text: string): Partial<ConversationCommerceState["delivery"]> | null {
  const patch: Partial<ConversationCommerceState["delivery"]> = {};
  const phone = text.match(/(?:電話|电话|phone|contact)\s*(?:係|是|=|:|：)?\s*([+\d][\d\s-]{6,20})/i);
  if (phone?.[1]) patch.recipient_phone = phone[1].replace(/\s+/g, " ").trim();
  const recipient = text.match(/(?:收貨人|收货人|recipient)\s*(?:係|是|=|:|：)?\s*([^，。,.!?！？]{1,40})/i);
  if (recipient?.[1]) patch.recipient_name = recipient[1].trim();
  const address = text.match(/(?:地址|送貨地址|送货地址|delivery address)\s*(?:係|是|=|:|：)?\s*([^。!?！？]{3,180})/i);
  if (address?.[1]) patch.address = address[1].trim();
  const date = text.match(/(?:送貨|送货|delivery|deliver|appointment|預約|预约).{0,20}(星期[一二三四五六日天]|週[一二三四五六日天]|周[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})/i);
  if (date?.[1]) patch.preferred_date = date[1];
  return Object.keys(patch).length ? patch : null;
}

/**
 * Deterministic, industry-neutral interpreter. It only emits events for facts
 * explicitly present in the customer turn or supplied through trusted entity hints.
 * It deliberately does not infer product-domain facts from model knowledge.
 */
export function deriveCommerceEventsFromCustomerTurn(input: CommerceTurnInterpretationInput): CommerceStateEvent[] {
  const text = clean(input.text);
  if (!text || !input.source_message_id) return [];
  const p = provenance(input.source_message_id, input.occurred_at);
  const hints = input.entity_hints ?? [];
  const mentioned = mentionedHints(text, hints);
  const events: CommerceStateEvent[] = [
    { type: "SET_CONTEXT", language: input.current_language, industry: input.current_industry },
    ...ensureHintEntityEvents(input, mentioned),
  ];

  const correction = correctionText(text);
  if (correction) events.push({ type: "ADD_CORRECTION", correction });

  const status = detectEntityStatus(text);
  const quantity = parseExplicitQuantity(text);
  if (mentioned.length === 1) {
    const entityId = mentioned[0].entity_id;
    if (status) events.push({ type: "SET_ENTITY_STATUS", entity_id: entityId, status, provenance: p });
    if (quantity !== null) events.push({ type: "SET_ENTITY_QUANTITY", entity_id: entityId, quantity, provenance: p });
  }

  const money = parseMoney(text);
  if (money) {
    const entityId = mentioned.length === 1 ? mentioned[0].entity_id : null;
    const historical = /(?:之前|上次|舊價|旧价|歷史|历史|previous|historical|last time)/i.test(text);
    const unverified = /(?:唔肯定|不確定|不确定|未confirm|未確認|未确认|unverified|not sure)/i.test(text);
    events.push({
      type: "ADD_QUOTE",
      quote: {
        quote_id: `customer:${input.source_message_id}:0`,
        entity_id: entityId,
        amount: money.amount,
        currency: input.currency ?? money.currency,
        quote_type: unverified ? "unverified" : "customer_reported_historical",
        validity_status: unverified ? "unknown" : historical ? "historical" : "unknown",
        source_label: "customer_reported",
        conditions: {},
        provenance: p,
      },
    });
  }

  const delivery = explicitDeliveryPatch(text);
  if (delivery) events.push({ type: "SET_DELIVERY", patch: delivery, provenance: p });

  const conversion = detectFunnel(text);
  if (conversion) events.push({ type: "SET_CONVERSION", patch: conversion });

  return events;
}
