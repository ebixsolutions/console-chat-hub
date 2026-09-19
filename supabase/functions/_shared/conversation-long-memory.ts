import { resolveConversationRecall, renderConversationRecall } from "./conversation-recall.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import {
  projectConversationRuntimeState,
  type RuntimeHistoryRow,
} from "./conversation-runtime-state-core.ts";
import { readExactConversationMemoryCommit } from "./authoritative-commit-readback.ts";

export const CONVERSATION_MEMORY_VERSION = "conversation-memory-1.0.0" as const;
export const C3_CONTEXT_INPUT_CHAR_BUDGET = 32_768;
export const C3_MEMORY_JSON_CHAR_BUDGET = 16_384;
export const C3_MEMORY_CONTEXT_CHAR_BUDGET = 12_000;
export const C3_RECENT_CONTEXT_CHAR_BUDGET = 10_000;
export const C3_RECENT_RAW_TURN_LIMIT = 12;

const MAX_CORRECTIONS = 8;
const MAX_FACTS = 16;
const MAX_CONSTRAINTS = 12;
const MAX_REGIONS = 8;
const MAX_HISTORY = 16;
const MAX_OPEN = 12;
const MAX_ACTIONS = 12;
const MAX_TOPICS = 12;
const MAX_LINEAGE = 12;
const CUSTOMER_ROLES = new Set(["visitor", "customer", "user"]);

export type MemoryAuthority = "canonical_commerce" | "customer" | "current_kb" | "historical";

export interface ConversationMemoryFact {
  key: string;
  value: unknown;
  authority: MemoryAuthority;
  source_message_id?: string | null;
  entity_id?: string | null;
  region?: string | null;
}
export interface ConversationMemoryEntity {
  entity_id: string;
  type: string;
  brand: string | null;
  model: string | null;
  quantity: number | null;
  status: "active";
  region: string | null;
  current_requirements: Record<string, unknown>;
  transaction_state: Record<string, unknown>;
}

export interface CanonicalConversationMemory {
  version: typeof CONVERSATION_MEMORY_VERSION;
  memory_revision: number;
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  commerce_state_revision: number | null;
  current_goal: string | null;
  active_entities: ConversationMemoryEntity[];
  latest_corrections: string[];
  current_customer_facts: ConversationMemoryFact[];
  customer_preferences: string[];
  active_constraints: string[];
  current_regions: Array<{ region: string; temporal_scope: "current" | "future" }>;
  transaction_summary: {
    quotation: string;
    order: string;
    payment: string;
    delivery: string;
    installation: string;
  };
  historical_facts: ConversationMemoryFact[];
  cancelled_or_superseded: ConversationMemoryFact[];
  open_questions: string[];
  pending_actions: string[];
  prior_topics: string[];
  current_topic: string | null;
  grounded_reference_lineage: Array<{
    document_id: string;
    evidence_chunk_ids: string[];
    source_message_id: string | null;
  }>;
  handoff_relevant_state: Record<string, unknown>;
  updated_from_turn: number;
  updated_at: string;
}

export interface MemoryHistoryRow extends RuntimeHistoryRow {
  id?: string;
}

export interface PersistedConversationMemory {
  conversation_id: string;
  company_id: string;
  revision: number;
  source_message_id: string;
  commerce_state_revision: number | null;
  memory: CanonicalConversationMemory;
  markdown_projection: string;
  memory_hash: string;
}

export interface LongMemoryDbClient {
  from(table: string): any;
  rpc(fn: string, params: Record<string, unknown>): Promise<{ data: any; error: unknown }>;
}

function clean(value: unknown, max = 800): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function uniqueStrings(values: unknown[], max: number, size = 500): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = clean(value, size);
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

function stableFacts(values: ConversationMemoryFact[], max: number): ConversationMemoryFact[] {
  const byKey = new Map<string, ConversationMemoryFact>();
  for (const fact of values) {
    const key = `${clean(fact.key, 120)}|${clean(fact.entity_id, 120)}|${clean(fact.region, 80)}`;
    if (!key || key === "||") continue;
    byKey.set(key, {
      key: clean(fact.key, 120),
      value: typeof fact.value === "string" ? clean(fact.value, 500) : fact.value,
      authority: fact.authority,
      source_message_id: clean(fact.source_message_id, 80) || null,
      entity_id: clean(fact.entity_id, 120) || null,
      region: clean(fact.region, 80) || null,
    });
  }
  return [...byKey.values()].slice(-max);
}

function languagePreference(text: string): string | null {
  if (/(?:prefer|reply|answer).{0,20}(?:english)|(?:用|以)英文(?:回答|回覆|回复)/i.test(text)) return "English";
  if (/(?:繁體|繁体|traditional chinese)/i.test(text)) return "Traditional Chinese";
  if (/(?:簡體|简体|simplified chinese)/i.test(text)) return "Simplified Chinese";
  return null;
}

function customerPreferences(rows: MemoryHistoryRow[]): string[] {
  const result: string[] = [];
  for (const row of [...rows].reverse()) {
    if (!CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase())) continue;
    const text = clean(row.content, 700);
    const language = languagePreference(text);
    if (language) result.push(`response_language:${language}`);
    if (/(?:我(?:偏好|喜歡|喜欢)|prefer|preference|i like)/i.test(text)) result.push(text);
  }
  return uniqueStrings(result.reverse(), MAX_FACTS);
}

function smallCustomerCount(raw: string): number | null {
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  return ({ 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 } as Record<string, number>)[raw] ?? null;
}

function retainedRoomSizes(text: string): Array<{
  member_id: string;
  group: "room" | "living_room";
  label: string;
  value: string;
}> {
  const facts: Array<{
    member_id: string;
    group: "room" | "living_room";
    label: string;
    value: string;
  }> = [];
  const groupCounts = new Map<string, number>();
  for (const clause of text.split(/[，,。;；]/)) {
    const label = clause.match(
      /([^，,。;；]{0,20}?(?:客廳|客厅|兩間房|两间房|房間|房间|間房|间房|細房|细房|大房|睡房|廳|厅|living\s+room|bedrooms?|rooms?))/i,
    )?.[1]?.trim();
    if (!label) continue;
    const group = /(?:客廳|客厅|廳|厅|living\s+room)/i.test(label)
      ? "living_room" as const
      : "room" as const;
    for (
      const measurement of clause.matchAll(
        /(\d+(?:\.\d+)?)\s*(?:平方呎|平方尺|sq\s*ft|sqft|呎|尺)/gi,
      )
    ) {
      const index = (groupCounts.get(group) ?? 0) + 1;
      groupCounts.set(group, index);
      facts.push({
        member_id: `${group}:${index}`,
        group,
        label,
        value: `${measurement[1]}平方呎`,
      });
    }
  }
  return facts;
}

/** Deterministic customer-owned C3 facts, projected oldest-to-newest. */
function retainedCustomerFacts(rows: MemoryHistoryRow[]): {
  current: ConversationMemoryFact[];
  historical: ConversationMemoryFact[];
  superseded: ConversationMemoryFact[];
} {
  const current: ConversationMemoryFact[] = [];
  const historical: ConversationMemoryFact[] = [];
  const superseded: ConversationMemoryFact[] = [];
  const add = (target: ConversationMemoryFact[], key: string, value: unknown, row: MemoryHistoryRow, entity_id?: string | null, region?: string | null) =>
    target.push({ key, value, authority: target === historical ? "historical" : "customer", source_message_id: clean(row.id, 80) || null, entity_id: entity_id ?? null, region: region ?? null });

  for (const row of [...rows].reverse()) {
    if (!CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase())) continue;
    const text = clean(row.content, 1000);
    if (!text || /[?？]/.test(text)) continue;
    const region = /(?:香港|hong\s*kong|\bhk\b)/i.test(text) ? "hong_kong"
      : /(?:台灣|台湾|taiwan)/i.test(text) ? "taiwan"
      : /(?:澳門|澳门|macau|macao)/i.test(text) ? "macau"
      : /(?:新加坡|singapore)/i.test(text) ? "singapore" : null;
    const total = text.match(/(?:合共|總共|总共|目前要買|目前要买|currently(?:\s+need|\s+buy)?)\s*([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|units?)/i)
      ?? text.match(/只保留[^。!?！？]{0,60}?([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|units?)/i);
    if (total?.[1]) {
      const value = smallCustomerCount(total[1]);
      if (value !== null) add(current, "quantity", value, row, null, region);
    }
    const cancelled = text.match(/([^，。,.!?！？]{1,30}?)(?:那部|嗰部|那個|那个)?\s*(?:暫時|暂时)?\s*(?:取消|唔要|不要)/i);
    if (cancelled?.[1]) add(superseded, "cancelled item", cancelled[1].replace(/^(?:更正|correction)[:：]?\s*/i, "").trim(), row);
    const correctedAddress = text.match(/(?:不是|唔係)\s*[^，,。]{1,60}[，,]\s*(?:而)?(?:是|係)\s*([^。!?！？]{2,180})/i)
      ?? text.match(/(?:更正|改為|改为|改成)\s*(?:地址)?\s*(?:為|为|是|係|=|:|：)?\s*([^。!?！？]{3,180})/i);
    const address = correctedAddress?.[1] ?? text.match(/(?:送貨地址|送货地址|地址)\s*(?:是|係|為|为|=|:|：)?\s*([^。!?！？]{3,180})/i)?.[1];
    if (address) add(current, correctedAddress ? "corrected_delivery_address" : "delivery_address", address.trim(), row);
    const roomFacts = retainedRoomSizes(text);
    if (roomFacts.length) add(current, "room_size", roomFacts, row);
    const horsepowerFacts = [...text.matchAll(/([^，,。]{1,16}?(?:房|客廳|客厅|型號|型号|model))\s*(?:要|是|係|為|为)?\s*(\d+(?:\.\d+)?)\s*匹/gi)].map((m) => `${m[1].trim()} ${m[2]}匹`);
    if (horsepowerFacts.length) add(current, "horsepower", horsepowerFacts, row);
    if (/(?:品牌)\s*(?:不是|並非|并非|唔係)\s*(?:必須|必须)|(?:品牌不限|不指定品牌|no\s+brand\s+(?:is\s+)?(?:required|mandatory))/i.test(text)) add(current, "brand_required", false, row);
    if (/(?:偏好|希望|prefer).{0,30}(?:送貨|送货|delivery)|(?:送貨|送货|delivery).{0,30}(?:偏好|希望|prefer)/i.test(text)) add(current, "delivery_preference", text, row);
    const oldQuote = text.match(/(?:港幣|港币|HKD|HK\$)\s*([0-9][0-9,]*(?:\.\d+)?)/i);
    if (oldQuote?.[1] && /(?:以前|之前|舊|旧|歷史|历史|口頭報價|口头报价|previous|historical|old)/i.test(text)) add(historical, "historical_quote", { amount: Number(oldQuote[1].replace(/,/g, "")), currency: "HKD", reusable_as_current: false }, row);
  }
  return { current: stableFacts(current, MAX_FACTS), historical: stableFacts(historical, MAX_HISTORY), superseded: stableFacts(superseded, MAX_HISTORY) };
}

function retainedCustomerRegions(rows: MemoryHistoryRow[]): CanonicalConversationMemory["current_regions"] {
  let current: string | null = null;
  const future = new Set<string>();
  for (const row of [...rows].reverse()) {
    if (!CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase())) continue;
    const text = clean(row.content, 1000);
    if (!text || /[?？]/.test(text) || /^(?:請|请).{0,12}(?:讀回|读回|說明|说明|核對|核对|總結|总结)/i.test(text)) continue;
    const region = /(?:香港|hong\s*kong|\bhk\b)/i.test(text) ? "hong_kong"
      : /(?:台灣|台湾|taiwan)/i.test(text) ? "taiwan"
      : /(?:澳門|澳门|macau|macao)/i.test(text) ? "macau"
      : /(?:新加坡|singapore)/i.test(text) ? "singapore" : null;
    if (!region) continue;
    if (/(?:之後|之后|以後|以后|未來|未来|明年|next\s+year|later|future).{0,40}(?:可能|maybe|may|might|plan|做|進入|进入|need|discussion)/i.test(text)) future.add(region);
    else if (/(?:目前|而家|現在|现在|這次|这次|currently|current)/i.test(text)) current = region;
  }
  if (current) future.delete(current);
  return [
    ...(current ? [{ region: current, temporal_scope: "current" as const }] : []),
    ...[...future].map((region) => ({ region, temporal_scope: "future" as const })),
  ].slice(0, MAX_REGIONS);
}

function lineage(rows: MemoryHistoryRow[]) {
  const result: CanonicalConversationMemory["grounded_reference_lineage"] = [];
  for (const row of rows) {
    const metadata = record(row.metadata);
    const citation = record(metadata?.citation_lineage);
    const documentId = clean(citation?.selected_document_id, 160);
    const chunkIds = Array.isArray(citation?.evidence_chunk_ids)
      ? uniqueStrings(citation!.evidence_chunk_ids as unknown[], 12, 160)
      : [];
    if (!documentId || !chunkIds.length) continue;
    result.push({
      document_id: documentId,
      evidence_chunk_ids: chunkIds,
      source_message_id: clean(metadata?.source_message_id, 80) || null,
    });
  }
  return result.slice(0, MAX_LINEAGE);
}

function projectCommerce(
  state: ConversationCommerceState | null,
): Pick<CanonicalConversationMemory,
  "active_entities" | "transaction_summary" | "historical_facts" |
  "cancelled_or_superseded" | "pending_actions"> {
  if (!state) {
    return {
      active_entities: [],
      transaction_summary: {
        quotation: "unknown", order: "unknown", payment: "unknown",
        delivery: "unknown", installation: "unknown",
      },
      historical_facts: [], cancelled_or_superseded: [], pending_actions: [],
    };
  }
  const activeEntities = state.entities
    .filter((entity) => !["cancelled", "deferred"].includes(entity.status))
    .map((entity) => ({
      entity_id: clean(entity.entity_id, 120),
      type: clean(entity.category, 120) || "unknown",
      brand: clean(entity.brand, 120) || null,
      model: clean(entity.model, 120) || null,
      quantity: Number.isFinite(entity.quantity) ? entity.quantity : null,
      status: "active" as const,
      region: clean(entity.attributes?.region, 80) || null,
      current_requirements: { ...entity.attributes, ...entity.constraints },
      transaction_state: {
        confirmed: state.conversion.confirmed_entity_ids.includes(entity.entity_id),
        tentative: state.conversion.tentative_entity_ids.includes(entity.entity_id),
      },
    }))
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
    .slice(0, 24);
  const historical = state.quotes
    .filter((quote) => quote.quote_type.includes("historical") || ["historical", "expired", "superseded", "invalid"].includes(quote.validity_status))
    .map((quote) => ({
      key: `quote:${quote.quote_id}`,
      value: { amount: quote.amount, currency: quote.currency, status: quote.validity_status },
      authority: "historical" as const,
      source_message_id: quote.provenance.source_message_id ?? null,
      entity_id: quote.entity_id ?? null,
    }));
  const cancelled = state.entities
    .filter((entity) => ["cancelled", "deferred"].includes(entity.status))
    .map((entity) => ({
      key: `entity:${entity.entity_id}`,
      value: entity.status,
      authority: "canonical_commerce" as const,
      source_message_id: entity.provenance.source_message_id ?? null,
      entity_id: entity.entity_id,
    }));
  const installation = state.installation.items.length === 0
    ? "unknown"
    : state.installation.items.some((item) => item.status === "pending")
    ? "pending"
    : state.installation.items.every((item) => item.status === "confirmed" || item.status === "not_required")
    ? "confirmed"
    : "not_confirmed";
  return {
    active_entities: activeEntities,
    transaction_summary: {
      quotation: state.conversion.quotation_status,
      order: state.conversion.order_status,
      payment: state.conversion.payment_status,
      delivery: state.delivery.confirmed ? "confirmed" : "not_confirmed",
      installation,
    },
    historical_facts: stableFacts(historical, MAX_HISTORY),
    cancelled_or_superseded: stableFacts(cancelled, MAX_HISTORY),
    pending_actions: uniqueStrings([
      ...state.unresolved_items,
      ...state.installation.pending_checks,
      state.conversion.next_best_action,
    ], MAX_ACTIONS),
  };
}

function fitMemory(memory: CanonicalConversationMemory): CanonicalConversationMemory {
  let fitted = memory;
  const size = () => JSON.stringify(fitted).length;
  if (size() <= C3_MEMORY_JSON_CHAR_BUDGET) return fitted;
  fitted = { ...fitted, historical_facts: fitted.historical_facts.slice(-8), prior_topics: fitted.prior_topics.slice(-6) };
  if (size() <= C3_MEMORY_JSON_CHAR_BUDGET) return fitted;
  fitted = { ...fitted, current_customer_facts: fitted.current_customer_facts.slice(-8), grounded_reference_lineage: fitted.grounded_reference_lineage.slice(0, 6) };
  if (size() <= C3_MEMORY_JSON_CHAR_BUDGET) return fitted;
  fitted = { ...fitted, open_questions: fitted.open_questions.slice(0, 6), pending_actions: fitted.pending_actions.slice(0, 6), active_constraints: fitted.active_constraints.slice(0, 6) };
  return fitted;
}

export function buildCanonicalConversationMemory(args: {
  previous?: CanonicalConversationMemory | null;
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  commerce_state_revision: number | null;
  commerce_state: ConversationCommerceState | null;
  newest_first: MemoryHistoryRow[];
  visitor_turn_count: number;
  source_created_at: string;
  next_memory_revision: number;
}): CanonicalConversationMemory {
  const runtime = projectConversationRuntimeState(args.newest_first);
  const commerce = projectCommerce(args.commerce_state);
  const retained = retainedCustomerFacts(args.newest_first);
  const retainedRegions = retainedCustomerRegions(args.newest_first);
  const prior = args.previous &&
      args.previous.conversation_id === args.conversation_id &&
      args.previous.company_id === args.company_id
    ? args.previous
    : null;
  const runtimeRegions = [
    ...(runtime.current_requirements.current_market
      ? [{ region: runtime.current_requirements.current_market, temporal_scope: "current" as const }]
      : []),
    ...runtime.current_requirements.future_markets.map((region) => ({ region, temporal_scope: "future" as const })),
  ].filter((item, index, all) => all.findIndex((x) => x.region === item.region && x.temporal_scope === item.temporal_scope) === index)
    .slice(0, MAX_REGIONS);
  const currentRegions = retainedRegions.length ? retainedRegions : runtimeRegions;
  const requirementFacts: ConversationMemoryFact[] = Object.entries(runtime.current_requirements)
    .filter(([, value]) => value !== null && (!Array.isArray(value) || value.length > 0))
    .map(([key, value]) => ({ key, value, authority: "customer", source_message_id: args.source_message_id }));
  const memory: CanonicalConversationMemory = {
    version: CONVERSATION_MEMORY_VERSION,
    memory_revision: args.next_memory_revision,
    conversation_id: args.conversation_id,
    company_id: args.company_id,
    source_message_id: args.source_message_id,
    commerce_state_revision: args.commerce_state_revision,
    current_goal: clean(args.commerce_state?.current_intent, 800) || runtime.current_intent || prior?.current_goal || runtime.first_customer_turn,
    active_entities: commerce.active_entities,
    latest_corrections: uniqueStrings([
      ...runtime.latest_corrections,
      ...(args.commerce_state?.latest_corrections ?? []),
      ...(prior?.latest_corrections ?? []),
    ], MAX_CORRECTIONS),
    current_customer_facts: stableFacts([
      ...(prior?.current_customer_facts ?? []),
      ...requirementFacts,
      ...retained.current,
    ], MAX_FACTS),
    customer_preferences: uniqueStrings([
      ...customerPreferences(args.newest_first),
      ...(prior?.customer_preferences ?? []),
    ], MAX_FACTS),
    active_constraints: uniqueStrings([
      ...runtime.active_constraints,
      ...Object.entries(args.commerce_state?.customer_constraints ?? {}).map(([key, value]) => `${key}:${JSON.stringify(value)}`),
      ...(prior?.active_constraints ?? []),
    ], MAX_CONSTRAINTS),
    current_regions: currentRegions.length ? currentRegions : (prior?.current_regions ?? []).slice(0, MAX_REGIONS),
    transaction_summary: commerce.transaction_summary,
    historical_facts: stableFacts([...(prior?.historical_facts ?? []), ...commerce.historical_facts, ...retained.historical], MAX_HISTORY),
    cancelled_or_superseded: stableFacts([...(prior?.cancelled_or_superseded ?? []), ...commerce.cancelled_or_superseded, ...retained.superseded], MAX_HISTORY),
    open_questions: uniqueStrings([...runtime.unresolved_questions, ...(args.commerce_state?.unresolved_items ?? [])], MAX_OPEN),
    pending_actions: commerce.pending_actions,
    prior_topics: uniqueStrings([...runtime.prior_topics.slice().reverse(), ...(prior?.prior_topics ?? [])], MAX_TOPICS).reverse(),
    current_topic: clean(args.commerce_state?.current_topic, 300) || runtime.current_topic || prior?.current_topic || null,
    grounded_reference_lineage: lineage(args.newest_first).length ? lineage(args.newest_first) : (prior?.grounded_reference_lineage ?? []).slice(0, MAX_LINEAGE),
    handoff_relevant_state: {
      current_goal: clean(args.commerce_state?.current_intent, 800) || runtime.current_intent || prior?.current_goal || null,
      active_entity_ids: commerce.active_entities.map((entity) => entity.entity_id),
      open_questions: uniqueStrings([...runtime.unresolved_questions, ...(args.commerce_state?.unresolved_items ?? [])], 6),
      pending_actions: commerce.pending_actions.slice(0, 6),
    },
    updated_from_turn: Math.max(0, args.visitor_turn_count),
    updated_at: args.source_created_at,
  };
  return fitMemory(memory);
}

export function isCanonicalConversationMemory(value: unknown): value is CanonicalConversationMemory {
  const row = record(value);
  if (!row || row.version !== CONVERSATION_MEMORY_VERSION) return false;
  if (!Number.isInteger(row.memory_revision) || Number(row.memory_revision) < 1) return false;
  for (const key of ["conversation_id", "company_id", "source_message_id", "updated_at"]) {
    if (!clean(row[key], 100)) return false;
  }
  for (const key of ["active_entities", "latest_corrections", "current_customer_facts", "customer_preferences", "active_constraints", "current_regions", "historical_facts", "cancelled_or_superseded", "open_questions", "pending_actions", "prior_topics", "grounded_reference_lineage"]) {
    if (!Array.isArray(row[key])) return false;
  }
  return Boolean(record(row.transaction_summary) && record(row.handoff_relevant_state)) && JSON.stringify(value).length <= C3_MEMORY_JSON_CHAR_BUDGET;
}

export function buildConversationMemoryMarkdown(memory: CanonicalConversationMemory): string {
  const entityLines = memory.active_entities.map((entity) =>
    `- ${entity.entity_id}: ${entity.quantity ?? "—"} (${entity.type})`
  );
  const tx = memory.transaction_summary;
  return [
    "### Current Goal", memory.current_goal || "—", "",
    "### Active Entities", ...(entityLines.length ? entityLines : ["- —"]), "",
    "### Latest Corrections", ...(memory.latest_corrections.length ? memory.latest_corrections.map((x) => `- ${x}`) : ["- —"]), "",
    "### Transaction State",
    `- Quotation: ${tx.quotation}`,
    `- Order: ${tx.order}`,
    `- Payment: ${tx.payment}`,
    `- Delivery: ${tx.delivery}`,
    `- Installation: ${tx.installation}`, "",
    "### Open Questions", ...(memory.open_questions.length ? memory.open_questions.map((x) => `- ${x}`) : ["- —"]), "",
    "### Pending Actions", ...(memory.pending_actions.length ? memory.pending_actions.map((x) => `- ${x}`) : ["- —"]), "",
    "### Historical / Superseded", ...(memory.historical_facts.concat(memory.cancelled_or_superseded).length
      ? memory.historical_facts.concat(memory.cancelled_or_superseded).map((x) => `- ${x.key}: ${typeof x.value === "string" ? x.value : JSON.stringify(x.value)}`)
      : ["- —"]),
  ].join("\n").slice(0, C3_MEMORY_CONTEXT_CHAR_BUDGET);
}

/** Compatibility API; all classification and selection live in one resolver. */
export function resolveStructuredMemoryResponse(latestInput: string, memory: CanonicalConversationMemory | null): string | null {
  if (!memory) return null;
  const decision = resolveConversationRecall({
    question: latestInput, memory, commerce: null,
    conversation_id: memory.conversation_id, company_id: memory.company_id,
    source_message_id: memory.source_message_id,
  });
  return renderConversationRecall(decision, /[\u4e00-\u9fff]/.test(latestInput) ? "zh-TW" : "en");
}

export function buildBoundedConversationContext(
  memory: CanonicalConversationMemory | null,
  newestFirst: MemoryHistoryRow[],
) {
  const recent: string[] = [];
  let recentChars = 0;
  for (const row of newestFirst.slice(0, C3_RECENT_RAW_TURN_LIMIT).reverse()) {
    const content = clean(row.content, 1600);
    if (!content) continue;
    const line = `${CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase()) ? "Customer" : "Assistant"}: ${content}`;
    if (recentChars + line.length > C3_RECENT_CONTEXT_CHAR_BUDGET) continue;
    recent.push(line);
    recentChars += line.length;
  }
  const memoryBlock = memory ? buildConversationMemoryMarkdown(memory).slice(0, C3_MEMORY_CONTEXT_CHAR_BUDGET) : "";
  const block = [
    memoryBlock ? "Canonical structured conversation memory (customer-owned facts: canonical commerce, latest valid correction, current customer memory; external business facts still require current published KB):\n" + memoryBlock : "",
    recent.length ? "Recent raw turns (bounded; latest nuance only):\n" + recent.join("\n") : "",
  ].filter(Boolean).join("\n\n");
  return {
    block: block.slice(0, C3_MEMORY_CONTEXT_CHAR_BUDGET + C3_RECENT_CONTEXT_CHAR_BUDGET + 300),
    memory_chars: memoryBlock.length,
    recent_chars: recentChars,
    total_chars: Math.min(block.length, C3_MEMORY_CONTEXT_CHAR_BUDGET + C3_RECENT_CONTEXT_CHAR_BUDGET + 300),
    recent_turns: recent.length,
  };
}

export function composeBoundedGenerationEnvelope(args: {
  required_parts: string[];
  memory_part: string;
  continuity_part: string;
  user: string;
  budget?: number;
}): { system: string; user: string; total_chars: number; memory_included: boolean } {
  const budget = Math.max(8_192, args.budget ?? C3_CONTEXT_INPUT_CHAR_BUDGET);
  const user = clean(args.user, 2_400);
  const required = args.required_parts.map((part) => String(part ?? "").trim()).filter(Boolean);
  const requiredText = required.join("\n\n");
  const separatorReserve = 8;
  const available = budget - user.length - requiredText.length - separatorReserve;
  if (available < 0) {
    throw new Error("C3_REQUIRED_CONTEXT_BUDGET_EXCEEDED");
  }
  const memory = String(args.memory_part ?? "").slice(0, available);
  const continuityAvailable = Math.max(0, available - memory.length - (memory ? 2 : 0));
  const continuity = String(args.continuity_part ?? "").slice(0, continuityAvailable);
  const system = [...required, memory, continuity].filter(Boolean).join("\n\n");
  if (system.length + user.length > budget) throw new Error("C3_CONTEXT_BUDGET_EXCEEDED");
  return { system, user, total_chars: system.length + user.length, memory_included: Boolean(memory) };
}

export async function refreshConversationLongMemory(client: LongMemoryDbClient, args: {
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  source_created_at: string;
  commerce_state_revision: number | null;
  commerce_state: ConversationCommerceState | null;
  newest_first: MemoryHistoryRow[];
  visitor_turn_count: number;
}): Promise<{ ok: true; memory: CanonicalConversationMemory; markdown: string; revision: number; idempotent: boolean } | { ok: false; reason: string }> {
  const { data: existing, error: existingError } = await client.from("conversation_memory_state")
    .select("conversation_id,company_id,revision,source_message_id,commerce_state_revision,memory,markdown_projection,memory_hash")
    .eq("conversation_id", args.conversation_id)
    .eq("company_id", args.company_id)
    .maybeSingle();
  if (existingError) return { ok: false, reason: "memory_lookup_failed" };
  if (existing?.source_message_id === args.source_message_id && isCanonicalConversationMemory(existing.memory)) {
    return { ok: true, memory: existing.memory, markdown: String(existing.markdown_projection ?? ""), revision: Number(existing.revision), idempotent: true };
  }
  const previous = isCanonicalConversationMemory(existing?.memory) ? existing.memory : null;
  const expectedRevision = Number(existing?.revision ?? 0);
  const memory = buildCanonicalConversationMemory({
    previous,
    ...args,
    next_memory_revision: expectedRevision + 1,
  });
  const markdown = buildConversationMemoryMarkdown(memory);
  const recoverAmbiguousCommit = async (
    candidateMemory: CanonicalConversationMemory,
    candidateMarkdown: string,
    revision: number,
  ) => {
    const receipt = await readExactConversationMemoryCommit(client, {
      conversation_id: args.conversation_id,
      company_id: args.company_id,
      source_message_id: args.source_message_id,
      revision,
      commerce_state_revision: args.commerce_state_revision,
      memory: candidateMemory,
      markdown_projection: candidateMarkdown,
    });
    if (receipt.status !== "committed" || !isCanonicalConversationMemory(receipt.value.memory)) {
      return null;
    }
    return {
      ok: true as const,
      memory: receipt.value.memory,
      markdown: receipt.value.markdown_projection,
      revision: receipt.value.revision,
      idempotent: true,
    };
  };
  const { data, error } = await client.rpc("c3_commit_conversation_memory_tx", {
    p_conversation_id: args.conversation_id,
    p_company_id: args.company_id,
    p_source_message_id: args.source_message_id,
    p_expected_commerce_revision: args.commerce_state_revision,
    p_expected_memory_revision: expectedRevision,
    p_memory: memory,
    p_markdown_projection: markdown,
    p_updated_from_turn: args.visitor_turn_count,
  });
  if (error) {
    return await recoverAmbiguousCommit(memory, markdown, expectedRevision + 1) ??
      { ok: false, reason: "memory_commit_transport" };
  }
  const result = clean(data?.result, 80);
  if (result === "revision_conflict") {
    const { data: fresh, error: freshError } = await client.from("conversation_memory_state")
      .select("conversation_id,company_id,revision,source_message_id,commerce_state_revision,memory,markdown_projection,memory_hash")
      .eq("conversation_id", args.conversation_id)
      .eq("company_id", args.company_id)
      .maybeSingle();
    if (freshError) return { ok: false, reason: "memory_retry_lookup_failed" };
    if (fresh?.source_message_id === args.source_message_id && isCanonicalConversationMemory(fresh.memory)) {
      return { ok: true, memory: fresh.memory, markdown: String(fresh.markdown_projection ?? ""), revision: Number(fresh.revision), idempotent: true };
    }
    const retryRevision = Number(fresh?.revision ?? 0);
    const retryMemory = buildCanonicalConversationMemory({
      previous: isCanonicalConversationMemory(fresh?.memory) ? fresh.memory : null,
      ...args,
      next_memory_revision: retryRevision + 1,
    });
    const retryMarkdown = buildConversationMemoryMarkdown(retryMemory);
    const retry = await client.rpc("c3_commit_conversation_memory_tx", {
      p_conversation_id: args.conversation_id,
      p_company_id: args.company_id,
      p_source_message_id: args.source_message_id,
      p_expected_commerce_revision: args.commerce_state_revision,
      p_expected_memory_revision: retryRevision,
      p_memory: retryMemory,
      p_markdown_projection: retryMarkdown,
      p_updated_from_turn: args.visitor_turn_count,
    });
    if (retry.error) {
      return await recoverAmbiguousCommit(retryMemory, retryMarkdown, retryRevision + 1) ??
        { ok: false, reason: "memory_retry_transport" };
    }
    if (clean(retry.data?.result, 80) !== "success") {
      return await recoverAmbiguousCommit(retryMemory, retryMarkdown, retryRevision + 1) ??
        { ok: false, reason: clean(retry.data?.result, 80) || "memory_retry_failed" };
    }
    return { ok: true, memory: retryMemory, markdown: retryMarkdown, revision: Number(retry.data.current_revision ?? retry.data.applied_revision), idempotent: Boolean(retry.data.idempotent) };
  }
  if (result !== "success") {
    return await recoverAmbiguousCommit(memory, markdown, expectedRevision + 1) ??
      { ok: false, reason: result || "memory_commit_unknown" };
  }
  return { ok: true, memory, markdown, revision: Number(data.current_revision ?? data.applied_revision), idempotent: Boolean(data.idempotent) };
}
