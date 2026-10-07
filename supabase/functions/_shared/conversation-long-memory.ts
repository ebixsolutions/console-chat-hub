import { customerRequestedQuantity } from "./customer-journey-orchestration.ts";
import { resolveConversationRecall, renderConversationRecall } from "./conversation-recall.ts";
import { isConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { classifyHandoffIntent } from "./handoff-intent.ts";
import { classifySocialTurn } from "./natural-customer-response.ts";
import { isCurrentRequirementsRecap } from "./commerce-state-authority.ts";
import { industryEntityLabel } from "./industry-runtime-adapter.ts";
import { deriveTypedCustomerMoneyFacts } from "./customer-money-facts.ts";
import { sameCanonicalJson } from "./canonical-json.ts";
import { type B2TrustedCorrectionCommit, type B2TrustedLifecycleCommit, verifyEntityLifecycleTransition, resolveEntityLifecyclePlan } from "./b2-journey-progress-contract.ts";
import {
  projectConversationRuntimeState,
  type RuntimeHistoryRow,
} from "./conversation-runtime-state-core.ts";
import { readExactMemoryReplyLifecycle } from "./memory-reply-lifecycle-readback.ts";
import { readExactConversationMemoryCommit } from "./authoritative-commit-readback.ts";
import {
  applyAddressReplacementCorrection,
  parseAddressReplacementCorrection,
} from "./commerce-state-reducer.ts";

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

/** Exact post-commit Memory ↔ Commerce parity; a reply cannot supply its own proof. */
export function verifyCommittedRoomCorrectionMemory(input: {
  memory: CanonicalConversationMemory | null;
  receipt: B2TrustedCorrectionCommit | null;
  commerce: { company_id: string; source_message_id: string | null; revision: number } | null;
}): boolean {
  const { memory, receipt, commerce } = input;
  if (!memory || !receipt || !commerce ||
    memory.company_id !== receipt.company_id ||
    commerce.company_id !== receipt.company_id ||
    memory.source_message_id !== receipt.source_message_id ||
    commerce.source_message_id !== receipt.source_message_id ||
    memory.commerce_state_revision !== receipt.committed_revision ||
    commerce.revision !== receipt.committed_revision ||
    !memory.latest_corrections.includes(receipt.correction)) return false;
  const scopeMatches = (label: string) =>
    receipt.scope === "large_bedroom" ? /(?:大房|large\s*bedroom)/i.test(label)
    : receipt.scope === "small_bedroom" ? /(?:細房|细房|小房|small\s*bedroom)/i.test(label)
    : receipt.scope === "living_room" ? /(?:客廳|客厅|個廳|个厅|living\s*room)/i.test(label)
    : false;
  const current = memory.current_customer_facts.find((fact) =>
    fact.key === "room_size" &&
    fact.source_message_id === receipt.source_message_id &&
    Array.isArray(fact.value) &&
    fact.value.some((item: unknown) =>
      Boolean(item && typeof item === "object" &&
        "label" in item && "value" in item &&
        typeof item.label === "string" &&
        scopeMatches(item.label) &&
        item.value === receipt.current_value))
  );
  const superseded = memory.cancelled_or_superseded.some((fact) =>
    fact.key === "superseded_room_size" &&
    fact.source_message_id === receipt.source_message_id &&
    fact.value !== null && typeof fact.value === "object" &&
    "label" in fact.value && "value" in fact.value &&
    typeof fact.value.label === "string" &&
    scopeMatches(fact.value.label) &&
    fact.value.value === receipt.previous_value
  );
  return Boolean(current && superseded);
}

export function verifyCommittedLifecycleMemory(input: {
  memory: CanonicalConversationMemory | null;
  receipt: B2TrustedLifecycleCommit | null;
  commerce: { company_id: string; source_message_id: string | null; revision: number; state: ConversationCommerceState } | null;
}): boolean {
  const { memory, receipt, commerce } = input;
  if (!memory || !receipt || !commerce || memory.company_id !== receipt.company_id ||
    commerce.company_id !== receipt.company_id ||
    memory.source_message_id !== receipt.source_message_id ||
    commerce.source_message_id !== receipt.source_message_id ||
    memory.commerce_state_revision !== receipt.committed_revision ||
    commerce.revision !== receipt.committed_revision ||
    !sameCanonicalJson(commerce.state, receipt.committed_state) ||
    !verifyEntityLifecycleTransition(receipt.source_text, receipt.previous_state,
      commerce.state, receipt.source_message_id).valid) return false;
  return commerce.state.entities.every((entity) => {
    const active = memory.active_entities.filter((item) => item.entity_id === entity.entity_id);
    const inactive = memory.cancelled_or_superseded.filter((item) =>
      item.key === `entity:${entity.entity_id}` && item.value === entity.status);
    return entity.status === "cancelled" || entity.status === "deferred"
      ? active.length === 0 && inactive.length === 1
      : active.length === 1 && active[0].quantity === entity.quantity &&
        sameCanonicalJson(active[0].current_requirements,
          { ...entity.attributes, ...entity.constraints });
  });
}
export interface ConversationMemoryEntity {
  entity_id: string;
  type: string;
  brand: string | null;
  model: string | null;
  /** Canonical entity/container count. Purchase quantity is separate. */
  quantity: number | null;
  requested_quantity?: number | null;
  status: "active";
  region: string | null;
  current_requirements: Record<string, unknown>;
  transaction_state: Record<string, unknown>;
}

export interface MemoryQuestionLifecycle {
  source_message_id: string; text: string; status: "pending" | "resolved" | "superseded";
  entity_id: string | null; resolution_source_message_id?: string | null; resolution?: string;
}

export interface CanonicalConversationMemory {
  question_lifecycle?: MemoryQuestionLifecycle[];
  /** Server-derived receipt kept in the existing bounded memory row for same-source reply retry. */
  pending_lifecycle_reply?: B2TrustedLifecycleCommit;
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

export function retainedRoomSizes(text: string): Array<{
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
  for (const clause of text.split(/[，,。;；]|、(?=\s*(?:細房|细房|小房|大房|客廳|客厅|書房|书房|living\s+room|study|(?:small|large)\s+bedroom))/i)) {
    const label = clause.match(
        /([^，,。;；]{0,20}?(?:客廳|客厅|兩間房|两间房|房間|房间|間房|间房|細房|细房|大房|睡房|書房|书房|廳|厅|living\s+room|study|bedrooms?|rooms?))/i,
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

export function roomSizeCorrection(text: string): { label: string; old_value: string; new_value: string } | null {
  const match = text.normalize("NFKC").match(
    /([^，,。;；]{0,20}?(?:客廳|客厅|細房|细房|大房|睡房|房間|房间|living\s+room|bedroom|room))[^。!?！？]{0,32}?(?:唔係|不是|並非|并非|not)\s*(\d+(?:\.\d+)?)\s*(?:平方呎|平方尺|sq\s*ft|sqft|呎|尺)[^。!?！？]{0,24}?(?:應該係|应该是|而係|而是|係|是|改為|改为|更正為|更正为|to)\s*(\d+(?:\.\d+)?)\s*(?:平方呎|平方尺|sq\s*ft|sqft|呎|尺)/iu,
  );
  if (!match) return null;
  return { label: match[1].trim(), old_value: `${match[2]}平方呎`, new_value: `${match[3]}平方呎` };
}

/** Deterministic customer-owned C3 facts, projected oldest-to-newest. */
function retainedCustomerFacts(rows: MemoryHistoryRow[], state: ConversationCommerceState | null): {
  current: ConversationMemoryFact[];
  historical: ConversationMemoryFact[];
  superseded: ConversationMemoryFact[];
} {
  const current: ConversationMemoryFact[] = [];
  const historical: ConversationMemoryFact[] = [];
  const superseded: ConversationMemoryFact[] = [];
  const add = (target: ConversationMemoryFact[], key: string, value: unknown, row: MemoryHistoryRow, entity_id?: string | null, region?: string | null) =>
    target.push({ key, value, authority: target === historical ? "historical" : "customer", source_message_id: clean(row.id, 80) || null, entity_id: entity_id ?? null, region: region ?? null });
  let currentAddress: ConversationMemoryFact | null = null;
  let currentRoomSizes: ConversationMemoryFact | null = null;

  for (const row of [...rows].reverse()) {
    if (!CUSTOMER_ROLES.has(String(row.role ?? "").toLowerCase())) continue;
    const text = clean(row.content, 1000);
    if (!text) continue;
    const money = deriveTypedCustomerMoneyFacts(text);
    if (money.historical) for (const [index,fact] of money.facts.entries()) {
      const matches=(state?.entities ?? []).filter(entity=>[entity.model,entity.attributes.product_name,entity.category.replace(/_/g," "),industryEntityLabel(entity.entity_id,"zh-TW"),industryEntityLabel(entity.entity_id,"en")]
        .some(name=>typeof name === "string" && text.toLowerCase().includes(name.toLowerCase())));
      const target=matches.length===1 ? matches[0] : null;
      add(historical, `money:${row.id}:${index}`, {...fact, semantic_role:fact.role,
        authority:"customer_historical_or_hypothetical",reusable_as_current:false,
        category:target?.category ?? null}, row,target?.entity_id ?? null);
    }
    if (/[?？]/.test(text)) continue;
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
    const addressCorrection = parseAddressReplacementCorrection(text);
    const statedAddress = text.match(/(?:送貨地址|送货地址|地址)\s*(?:是|係|為|为|=|:|：)?\s*([^。!?！？]{3,180})/i)?.[1];
    const address: string = addressCorrection
      ? applyAddressReplacementCorrection(
        typeof currentAddress?.value === "string" ? currentAddress.value : null,
        addressCorrection,
      )
      : clean(statedAddress, 180);
    if (address) {
      if (currentAddress && currentAddress.value !== address) {
        superseded.push({
          ...currentAddress,
          key: "superseded_delivery_address",
        });
        const index = current.indexOf(currentAddress);
        if (index >= 0) current.splice(index, 1);
      }
      currentAddress = {
        key: addressCorrection
          ? "corrected_delivery_address"
          : "delivery_address",
        value: address,
        authority: "customer",
        source_message_id: clean(row.id, 80) || null,
        entity_id: null,
        region,
      };
      current.push(currentAddress);
    }
    const correction = roomSizeCorrection(text);
    const roomFacts = retainedRoomSizes(text);
    if (correction && currentRoomSizes && Array.isArray(currentRoomSizes.value)) {
      const previous = currentRoomSizes.value as Array<{ member_id: string; group: "room" | "living_room"; label: string; value: string }>;
      const correctedIndex = previous.findIndex((fact) => fact.label.normalize("NFKC").includes(correction.label) || correction.label.includes(fact.label.normalize("NFKC")) || fact.value === correction.old_value);
      if (correctedIndex >= 0) {
        const next = previous.map((fact, index) => index === correctedIndex ? { ...fact, value: correction.new_value } : { ...fact });
        superseded.push({ key: "superseded_room_size", value: { label: previous[correctedIndex].label, value: previous[correctedIndex].value }, authority: "customer", source_message_id: clean(row.id, 80) || null, entity_id: null, region });
        const currentIndex = current.indexOf(currentRoomSizes);
        if (currentIndex >= 0) current.splice(currentIndex, 1);
        currentRoomSizes = { key: "room_size", value: next, authority: "customer", source_message_id: clean(row.id, 80) || null, entity_id: null, region };
        current.push(currentRoomSizes);
      }
    } else if (roomFacts.length) {
      if (currentRoomSizes) {
        const currentIndex = current.indexOf(currentRoomSizes);
        if (currentIndex >= 0) current.splice(currentIndex, 1);
      }
      currentRoomSizes = { key: "room_size", value: roomFacts, authority: "customer", source_message_id: clean(row.id, 80) || null, entity_id: null, region };
      current.push(currentRoomSizes);
    }
    const horsepowerFacts = [...text.matchAll(/(?:([^，,。]{1,16}?(?:房|客廳|客厅|型號|型号|model))\s*(?:要|是|係|為|为)?\s*)?(\d+(?:\.\d+)?)\s*匹/gi)].map((m) => `${m[1]?.trim() ? `${m[1].trim()} ` : ""}${m[2]}匹`);
    if (horsepowerFacts.length) add(current, "horsepower", horsepowerFacts, row);
    if (/(?:品牌)\s*(?:不是|並非|并非|唔係)\s*(?:必須|必须)|(?:品牌不限|不指定品牌|no\s+brand\s+(?:is\s+)?(?:required|mandatory))|(?:[\p{L}\p{N}-]+[、,，]){1,}[\p{L}\p{N}-]+(?:都得|均可|皆可|any\s+(?:is|are)\s+fine)/iu.test(text)) add(current, "brand_required", false, row);
    if (/(?:偏好|希望|prefer).{0,30}(?:送貨|送货|delivery)|(?:送貨|送货|delivery).{0,30}(?:偏好|希望|prefer)/i.test(text)) add(current, "delivery_preference", text, row);
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
      requested_quantity: customerRequestedQuantity(entity),
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
      ...state.entities.filter(e=>e.entity_id.startsWith("generic:") && !["deferred","cancelled"].includes(e.status) &&
        record(e.attributes.capabilities)?.requires_booking === true && !state.conversion.confirmed_entity_ids.includes(e.entity_id))
        .map(e=>`${e.attributes.product_name ?? e.category}: requested booking needs staff confirmation`),
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
  fitted = { ...fitted, question_lifecycle: fitted.question_lifecycle?.slice(-12).map(item=>({...item,text:item.text.slice(0,400)})), historical_facts: fitted.historical_facts.slice(-8), prior_topics: fitted.prior_topics.slice(-6) };
  if (size() <= C3_MEMORY_JSON_CHAR_BUDGET) return fitted;
  fitted = { ...fitted, current_customer_facts: fitted.current_customer_facts.slice(-8), grounded_reference_lineage: fitted.grounded_reference_lineage.slice(0, 6) };
  if (size() <= C3_MEMORY_JSON_CHAR_BUDGET) return fitted;
  fitted = { ...fitted, open_questions: fitted.open_questions.slice(0, 6), pending_actions: fitted.pending_actions.slice(0, 6), active_constraints: fitted.active_constraints.slice(0, 6) };
  return fitted;
}

/** Existing memory projection owns unresolved lifecycle; transcript questions are not a queue. */
function questionLifecycle(rows: MemoryHistoryRow[], state: ConversationCommerceState | null,
  prior: CanonicalConversationMemory | null): MemoryQuestionLifecycle[] {
  const items = new Map((prior?.question_lifecycle ?? []).map(item=>[item.source_message_id,{...item}]));
  const entities = state?.entities ?? [];
  for (const row of [...rows].reverse()) {
    const content=clean(row.content,1600);
    const meta = record(row.metadata);
    if (CUSTOMER_ROLES.has(String(row.role ?? "")) && row.id && !classifySocialTurn(content) &&
      /[?？]|(?:what|how|why|can|could|幾多|有冇|夠唔夠)/i.test(content) && !items.has(row.id)) {
      const matches = entities.filter(entity=>[entity.model,entity.attributes.product_name,entity.category.replace(/_/g," "),industryEntityLabel(entity.entity_id,"zh-TW"),industryEntityLabel(entity.entity_id,"en")]
        .some(name=>typeof name === "string" && content.toLowerCase().includes(name.toLowerCase())));
      items.set(row.id,{source_message_id:row.id,text:content,status:"pending",entity_id:matches.length===1?matches[0].entity_id:null});
    }
    if (row.role !== "assistant" || !meta || meta.control_commit !== "ai" || typeof meta.source_message_id !== "string") continue;
    let item = items.get(meta.source_message_id);
    const clarification = /^(?:targeted_clarification|partial_answer_then_question|offer_handoff_or_reframe|customer_issue_next_step)$/.test(String(meta.service_action)) && /[?？]$/.test(content.trim());
    const site = meta.response_route === "canonical_kb_direct_answer" && /cannot confirm|未能確認|不能确认/i.test(content) && /suitable room|適用面積|适用面积|site assessment|現場評估/i.test(content);
    const stockUnknown = meta.response_route === "canonical_kb_direct_answer" && (meta.answer_kind === "stock_unknown" ||
      Array.isArray(meta.unresolved_fact_fields) && meta.unresolved_fact_fields.includes("stock"));
    const missingCustomerDecision = meta.response_route === "product_guidance" && /[?？]$/.test(content);
    if (!item && (clarification || site || stockUnknown || missingCustomerDecision)) {
      const source=rows.find(row=>row.id===meta.source_message_id && CUSTOMER_ROLES.has(String(row.role)));
      if (!source || classifySocialTurn(clean(source.content))) continue;
      const matches=entities.filter(entity=>[entity.model,entity.attributes.product_name,entity.category.replace(/_/g," "),industryEntityLabel(entity.entity_id,"zh-TW"),industryEntityLabel(entity.entity_id,"en")]
        .some(name=>typeof name === "string" && clean(source.content).toLowerCase().includes(name.toLowerCase())));
      item={source_message_id:meta.source_message_id,text:clean(source.content,1600),status:"pending",entity_id:matches.length===1?matches[0].entity_id:null};
      items.set(item.source_message_id,item);
    }
    if (!item) continue;
    item.status = clarification || site || stockUnknown || missingCustomerDecision || meta.degraded === true ? "pending" : "resolved";
    item.resolution_source_message_id = row.id ?? null;
    item.resolution = stockUnknown ? "merchant stock confirmation pending" : site ? "professional/site confirmation pending" : clarification || missingCustomerDecision ? "customer information required" : String(meta.response_route ?? "delivered_answer");
    if (site) {
      const target=entities.filter(entity=>entity.model && content.includes(entity.model));
      if(target.length===1) item.entity_id=target[0].entity_id;
      for (const old of items.values()) if(item.entity_id!==null && old.source_message_id!==item.source_message_id && old.status==="pending" &&
        old.entity_id===item.entity_id && old.resolution?.includes("professional")) {
        old.status="superseded";old.resolution="later scoped assessment request";old.resolution_source_message_id=item.source_message_id;
      }
      item.text = `${target[0]?.model ?? "Product"} suitability and site assessment need authoritative professional confirmation`;
    } else if (stockUnknown) {
      const facts=Array.isArray(meta.authoritative_kb_facts)?meta.authoritative_kb_facts:[];
      const sku=facts.find(f=>record(f)?.authority==="CURRENT_KB" && record(f)?.currentness_at_answer==="current")?.model;
      const target=entities.filter(entity=>[entity.model,entity.attributes.sku].some(id=>typeof id==="string" && (id===sku || content.includes(id))));
      if (target.length === 1) item.entity_id=target[0].entity_id;
      item.text = `${sku ?? target[0]?.model ?? target[0]?.attributes.sku ?? "Product"} live stock quantity needs merchant confirmation`;
    } else if (missingCustomerDecision || clarification) {
      item.text=content.split(/(?<=[。.!])/).filter(Boolean).at(-1)?.trim() ?? content;
    }
  }
  for (const item of items.values()) if (item.status === "pending" && item.entity_id &&
    entities.some(entity=>entity.entity_id===item.entity_id && ["cancelled","deferred"].includes(entity.status))) {
    item.status="superseded";item.resolution="entity inactive";
    item.resolution_source_message_id=entities.find(entity=>entity.entity_id===item.entity_id)?.provenance.source_message_id ?? null;
  }
  return [...items.values()].slice(-24);
}

/** Business projection only: never grants R1 authority or changes its classifier.
 * Drop the transfer directive and its collection-control clauses, retaining any
 * separate business clauses for the existing canonical reducers/projection.
 */
function businessMessageText(value: unknown): string {
  const text=clean(value,1600);
  const isControl=(clause:string)=> {
    const intent=classifyHandoffIntent(clause);
    return intent.explicit_request || intent.category==="mention_only" &&
      /(?:我想|請|请|麻煩|麻烦|唔該|接手|轉接|转接|speak|talk|transfer|connect)/i.test(clause);
  };
  if(!text || !isControl(text)) return text;
  return text.split(/[，,。;；!！\n]|(?<!\d)\.(?!\d)/).map(clause=>clause.trim()).filter(clause=>
    clause && !isControl(clause) && !/(?:唔好|不要|别|別|stop|do not|don't).{0,16}(?:再問|再问|問需求|问需求|ask|question)|(?:no more|不要|唔要).{0,8}(?:AI|機器人|机器人)/i.test(clause)
  ).join("; ");
}

export function buildCanonicalConversationMemory(args: {
  pending_lifecycle_reply?: B2TrustedLifecycleCommit | null;
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
  const businessRows = args.newest_first.map(row=>CUSTOMER_ROLES.has(String(row.role ?? ""))
    ? {...row,content:businessMessageText(row.content)} : row)
    .filter(row=>!CUSTOMER_ROLES.has(String(row.role ?? "")) || clean(row.content) && !classifySocialTurn(clean(row.content,1600)));
  const runtime = projectConversationRuntimeState(businessRows);
  const commerce = projectCommerce(args.commerce_state);
  const retained = retainedCustomerFacts(businessRows,args.commerce_state);
  const retainedRegions = retainedCustomerRegions(businessRows);
  const prior = args.previous &&
      args.previous.conversation_id === args.conversation_id &&
      args.previous.company_id === args.company_id
    ? args.previous
    : null;
  const lifecycle = questionLifecycle(businessRows,args.commerce_state,prior);
  const open = uniqueStrings(lifecycle.filter(item=>item.status === "pending").map(item=>item.text),MAX_OPEN);
  const genericEntities = (args.commerce_state?.entities ?? []).filter(e=>e.entity_id.startsWith("generic:"));
  const genericGoal = genericEntities.length ? genericEntities.map(e=>`${e.attributes.product_name ?? e.category}: ${e.quantity} ${e.attributes.unit ?? "units"}${["cancelled","deferred"].includes(e.status)?` (${args.commerce_state?.language==="en"?e.status:e.status==="deferred"?"已暫緩":"已取消"})`:""}${e.attributes.requested_date?`, requested date ${e.attributes.requested_date}`:""}`).join("; ") : null;
  const entityGoal = !genericEntities.length && args.commerce_state?.entities.length ? args.commerce_state.entities.map(entity=> {
    const label=industryEntityLabel(entity.entity_id,"en") ?? entity.category.replace(/_/g," ");
    const rooms=record(entity.attributes.room_sizes);
    const requirements=rooms?Object.entries(rooms).map(([room,size])=>`${room.replace(/_/g," ")} ${size}`).join(", "):"";
    const width=typeof entity.constraints.max_width_mm === "number"?`, maximum width ${entity.constraints.max_width_mm} mm`:"";
    return `${entity.model?entity.model+" ":""}${label}: ${customerRequestedQuantity(entity) === null ? "quantity not yet confirmed" : `${entity.quantity} units`}${requirements?", "+requirements:""}${width}${record(entity.attributes.room_sunlight) ? ", afternoon sun: " + Object.keys(record(entity.attributes.room_sunlight)!).map(room=>room.replace(/_/g," ")).join(", ") : entity.attributes.sunlight === "strong_afternoon_sun" ? ", afternoon sun (scope unspecified)" : ""}${entity.attributes.installation_type === "window_unit" ? ", window units" : ""}${["deferred","cancelled"].includes(entity.status)?` (${entity.status})`:""}`;
  }).join("; "):null;
  const fallbackGoal=businessMessageText(prior?.current_goal) || businessMessageText(args.commerce_state?.current_intent) || runtime.first_customer_turn || null;
  const businessGoal = genericGoal || entityGoal || (fallbackGoal && !classifyHandoffIntent(fallbackGoal).explicit_request ? fallbackGoal : null);
  const runtimeRegions = [
    ...(runtime.current_requirements.current_market
      ? [{ region: runtime.current_requirements.current_market, temporal_scope: "current" as const }]
      : []),
    ...runtime.current_requirements.future_markets.map((region) => ({ region, temporal_scope: "future" as const })),
  ].filter((item, index, all) => all.findIndex((x) => x.region === item.region && x.temporal_scope === item.temporal_scope) === index)
    .slice(0, MAX_REGIONS);
  const currentRegions = retainedRegions.length ? retainedRegions : runtimeRegions;
  const addressKeys = new Set([
    "address",
    "delivery_address",
    "shipping_address",
    "corrected_delivery_address",
  ]);
  const deliveryPreferenceKeys = new Set([
    "delivery_preference",
    "preferred_date",
    "preferred_delivery_day",
    "delivery_day",
    "delivery_date",
  ]);
  const commerceAddress = clean(args.commerce_state?.delivery.address, 300);
  const retainedAddress = [...retained.current].reverse().find((fact) =>
    addressKeys.has(clean(fact.key, 120)) && typeof fact.value === "string"
  );
  // Customer correction history is the source of truth when it contains a
  // newer scoped replacement. The commerce reducer should converge to the same
  // value, but a stale projection must never overwrite the correction while
  // memory is being rebuilt.
  const retainedAddressValue = clean(retainedAddress?.value, 300);
  const commerceCoversRetainedCorrection = Boolean(
    retainedAddressValue && commerceAddress &&
      commerceAddress.toLocaleLowerCase().includes(
        retainedAddressValue.toLocaleLowerCase(),
      ),
  );
  const currentAddress = commerceCoversRetainedCorrection
    ? commerceAddress
    : retainedAddressValue || commerceAddress;
  const priorAddressFacts = (prior?.current_customer_facts ?? []).filter((fact) =>
    addressKeys.has(clean(fact.key, 120))
  );
  const currentAddressFact: ConversationMemoryFact | null = currentAddress
    ? {
      key: retainedAddressValue && retainedAddress
        ? retainedAddress.key
        : "delivery_address",
      value: currentAddress,
      authority: retainedAddressValue && !commerceCoversRetainedCorrection
        ? "customer"
        : "canonical_commerce",
      source_message_id: retainedAddressValue && !commerceCoversRetainedCorrection
        ? retainedAddress?.source_message_id ?? null
        : clean(args.commerce_state?.delivery.provenance?.source_message_id, 80) ||
          null,
      entity_id: null,
      region: retainedAddress?.region ?? null,
    }
    : null;
  const commerceDeliveryPreference = clean(
    args.commerce_state?.delivery.preferred_date,
    180,
  );
  const currentDeliveryPreferenceFact: ConversationMemoryFact | null =
    commerceDeliveryPreference
      ? {
          key: "delivery_preference",
          value: commerceDeliveryPreference,
          authority: "canonical_commerce",
          source_message_id:
            clean(args.commerce_state?.delivery.provenance?.source_message_id, 80) || null,
          entity_id: null,
          region: null,
        }
      : null;
  const supersededPriorAddresses = priorAddressFacts
    .filter((fact) => clean(fact.value, 300) && clean(fact.value, 300) !== currentAddress)
    .map((fact) => ({ ...fact, key: "superseded_delivery_address" }));
  const requirementFacts: ConversationMemoryFact[] = Object.entries(runtime.current_requirements)
    .filter(([, value]) => value !== null && (!Array.isArray(value) || value.length > 0))
    .map(([key, value]) => ({ key, value, authority: "customer", source_message_id: args.source_message_id }));
  const canonicalEntityFacts: ConversationMemoryFact[] = (args.commerce_state?.entities ?? []).filter(e=>!['deferred','cancelled'].includes(e.status)).flatMap(e=>[
    ...(customerRequestedQuantity(e) === null ? [] : [{key:`entity:${e.entity_id}:quantity`,value:e.quantity,authority:"canonical_commerce" as const,entity_id:e.entity_id,source_message_id:e.provenance.source_message_id}]),
    ...(typeof e.attributes.requested_date === "string" ? [{key:`entity:${e.entity_id}:requested_date`,value:e.attributes.requested_date,authority:"customer" as const,entity_id:e.entity_id,source_message_id:e.provenance.source_message_id}] : [])]);
  const memory: CanonicalConversationMemory = {
    version: CONVERSATION_MEMORY_VERSION,
    memory_revision: args.next_memory_revision,
    conversation_id: args.conversation_id,
    company_id: args.company_id,
    source_message_id: args.source_message_id,
    commerce_state_revision: args.commerce_state_revision,
    current_goal: businessGoal,
    question_lifecycle: lifecycle,
    active_entities: commerce.active_entities,
    latest_corrections: uniqueStrings([
      ...runtime.latest_corrections,
      ...(args.commerce_state?.latest_corrections ?? []),
      ...(prior?.latest_corrections ?? []),
    ], MAX_CORRECTIONS),
    current_customer_facts: stableFacts([
      ...(prior?.current_customer_facts ?? []).filter((fact) =>
        !fact.key.startsWith("entity:") && !addressKeys.has(clean(fact.key, 120)) &&
        !(currentDeliveryPreferenceFact &&
          deliveryPreferenceKeys.has(clean(fact.key, 120)))
      ),
      ...requirementFacts,
      ...canonicalEntityFacts,
      ...retained.current.filter((fact) =>
        !addressKeys.has(clean(fact.key, 120)) &&
        !(currentDeliveryPreferenceFact &&
          deliveryPreferenceKeys.has(clean(fact.key, 120)))
      ),
      ...(currentAddressFact ? [currentAddressFact] : []),
      ...(currentDeliveryPreferenceFact ? [currentDeliveryPreferenceFact] : []),
    ], MAX_FACTS),
    customer_preferences: uniqueStrings([
      ...customerPreferences(businessRows),
      ...(prior?.customer_preferences ?? []),
    ], MAX_FACTS),
    active_constraints: uniqueStrings([
      ...runtime.active_constraints,
      ...Object.entries(args.commerce_state?.customer_constraints ?? {}).map(([key, value]) => `${key}:${JSON.stringify(value)}`),
      ...(prior?.active_constraints ?? []),
    ].map(businessMessageText), MAX_CONSTRAINTS),
    current_regions: currentRegions.length ? currentRegions : (prior?.current_regions ?? []).slice(0, MAX_REGIONS),
    transaction_summary: commerce.transaction_summary,
    historical_facts: stableFacts([...(prior?.historical_facts ?? []), ...commerce.historical_facts, ...retained.historical], MAX_HISTORY),
    cancelled_or_superseded: stableFacts([
      ...(prior?.cancelled_or_superseded ?? []),
      ...supersededPriorAddresses,
      ...commerce.cancelled_or_superseded,
      ...retained.superseded,
    ], MAX_HISTORY),
    open_questions: open,
    pending_actions: uniqueStrings([...commerce.pending_actions,...lifecycle.filter(item=>item.status === "pending" && item.resolution?.includes("professional")).map(item=>item.text)],MAX_ACTIONS),
    prior_topics: uniqueStrings([...runtime.prior_topics.slice().reverse(), ...(prior?.prior_topics ?? [])], MAX_TOPICS).reverse(),
    current_topic: !businessMessageText(args.newest_first.find(row=>row.id===args.source_message_id)?.content)
      ? businessMessageText(prior?.current_topic) || businessMessageText(args.commerce_state?.current_topic) || runtime.current_topic || null
      : businessMessageText(args.commerce_state?.current_topic) || runtime.current_topic || businessMessageText(prior?.current_topic) || null,
    grounded_reference_lineage: lineage(args.newest_first).length ? lineage(args.newest_first) : (prior?.grounded_reference_lineage ?? []).slice(0, MAX_LINEAGE),
    handoff_relevant_state: {
      current_goal: businessGoal,
      active_entity_ids: commerce.active_entities.map((entity) => entity.entity_id),
      open_questions: open.slice(0,6),
      pending_actions: uniqueStrings([...commerce.pending_actions,...lifecycle.filter(item=>item.status === "pending" && item.resolution?.includes("professional")).map(item=>item.text)],6),
    },
    updated_from_turn: Math.max(0, args.visitor_turn_count),
    updated_at: args.source_created_at,
  };
  const fitted = fitMemory(memory);
  if (args.pending_lifecycle_reply) {
    fitted.pending_lifecycle_reply = structuredClone(args.pending_lifecycle_reply);
    if (JSON.stringify(fitted).length > C3_MEMORY_JSON_CHAR_BUDGET) {
      fitted.prior_topics = fitted.prior_topics.slice(-4);
      fitted.open_questions = fitted.open_questions.slice(0, 3);
      fitted.grounded_reference_lineage = fitted.grounded_reference_lineage.slice(0, 3);
    }
    if (JSON.stringify(fitted).length > C3_MEMORY_JSON_CHAR_BUDGET) {
      throw new Error("C3_LIFECYCLE_RECEIPT_EXCEEDS_MEMORY_BUDGET");
    }
  }
  return fitted;
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
  pending_lifecycle_reply?: B2TrustedLifecycleCommit | null;
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

/** Finalise a delivered lifecycle under its own assistant receipt; customer receipt stays immutable. */
export async function reconcileDeliveredMemoryReply(client: LongMemoryDbClient, args: {
  conversation_id:string; source_message_id:string; reply_message_id:string;
}): Promise<boolean> {
  const {data:reply,error:replyError} = await client.from("messages").select("id,conversation_id,role,content,is_recalled,metadata")
    .eq("id",args.reply_message_id).eq("conversation_id",args.conversation_id).maybeSingle();
  if(replyError || !reply || reply.is_recalled===true || reply.role!=="assistant" || reply.metadata?.source_message_id!==args.source_message_id ||
    reply.metadata?.control_commit!=="ai" || reply.metadata?.b2_gate_contract!=="executeB2PersistenceGate:allow_after_revalidation") return false;
  // Read-only recap/calculation do not introduce a semantic question or mutate memory.
  if(reply.metadata.recap_read_only===true || reply.metadata.transaction_mutation==="NONE" || classifySocialTurn(String(reply.content)) || reply.metadata.response_route==="natural_greeting" || reply.metadata.response_route==="natural_social_acknowledgement" || reply.metadata.response_route==="natural_conversation_closure") return true;
  if(reply.metadata.response_route === "conversation_closure") {
    const {data:social,error:socialError}=await client.from("messages").select("id,role,content").eq("id",args.source_message_id).eq("conversation_id",args.conversation_id).maybeSingle();
    if(!socialError && social?.role==="visitor" && classifySocialTurn(String(social.content))) return true;
  }
  const {data:stored,error} = await client.from("conversation_memory_state").select("*")
    .eq("conversation_id",args.conversation_id).eq("company_id",reply.metadata.b2_expected_company_id).maybeSingle();
  if(error) return false;
  if(!stored) return true; // Social-only and pure read-only turns have no business memory.
  // Unknown-scope recap clarification acknowledges unchanged canonical state,
  // not a new Memory source. Metadata identifies the class; persisted source
  // and a fresh canonical resolver decision independently prove it.
  if(reply.metadata.response_route==="canonical_memory_clarification" &&
    reply.metadata.recall_reason==="ENTITY_REFERENCE_AMBIGUOUS" &&
    reply.metadata.clarification_target==="specific_product_or_item" &&
    reply.metadata.service_action==="partial_answer_then_question") {
    const {data:source,error:sourceError}=await client.from("messages").select("id,conversation_id,role,content")
      .eq("id",args.source_message_id).eq("conversation_id",args.conversation_id).maybeSingle();
    const {data:commerce,error:commerceError}=await client.from("conversation_commerce_state").select("conversation_id,company_id,source_message_id,revision,state")
      .eq("conversation_id",args.conversation_id).eq("company_id",reply.metadata.b2_expected_company_id).maybeSingle();
    if(sourceError || commerceError || !source || source.id!==args.source_message_id ||
      source.conversation_id!==args.conversation_id || !CUSTOMER_ROLES.has(String(source.role)) ||
      !isCurrentRequirementsRecap(String(source.content)) || !commerce || !isConversationCommerceState(commerce.state) ||
      commerce.conversation_id!==args.conversation_id || commerce.company_id!==reply.metadata.b2_expected_company_id ||
      !Number.isInteger(Number(commerce.revision)) || Number(commerce.revision)<0 ||
      reply.metadata.b2_expected_revision!==Number(commerce.revision) || !isCanonicalConversationMemory(stored.memory) ||
      stored.company_id!==reply.metadata.b2_expected_company_id || stored.conversation_id!==args.conversation_id ||
      stored.memory.company_id!==stored.company_id || stored.memory.conversation_id!==args.conversation_id ||
      stored.memory.source_message_id!==stored.source_message_id ||
      stored.memory.memory_revision!==Number(stored.revision) ||
      stored.memory.commerce_state_revision!==Number(commerce.revision) ||
      Number(stored.commerce_state_revision)!==Number(commerce.revision) ||
      reply.metadata.conversation_memory_revision!==Number(stored.revision)) return false;
    const decision=resolveConversationRecall({
      conversation_id:args.conversation_id,company_id:stored.company_id,source_message_id:args.source_message_id,
      question:String(source.content),memory:stored.memory,
      commerce:{conversation_id:commerce.conversation_id,company_id:commerce.company_id,
        source_message_id:commerce.source_message_id,revision:Number(commerce.revision),state:commerce.state},
    });
    return !decision.handled && decision.reason==="AMBIGUOUS" &&
      decision.detail==="ENTITY_REFERENCE_AMBIGUOUS" && decision.requested_facts.includes("summary");
  }
  // Read-only lifecycle clarification/repetition intentionally keeps the last
  // canonical Memory source. Revalidate the actual customer command and current
  // scoped Commerce/Memory revisions before acknowledging its delivered reply.
  if(reply.metadata.response_route==="commerce_state_answer" &&
    ["ambiguous_lifecycle_target","read_only_lifecycle_already_applied"].includes(String(reply.metadata.commerce_reason)) &&
    reply.metadata.commerce_state_persist_result==="read_only" &&
    reply.metadata.commerce_state_persistence_classification==="NO_SEMANTIC_CHANGE") {
    const {data:source,error:sourceError}=await client.from("messages").select("id,role,content").eq("id",args.source_message_id).eq("conversation_id",args.conversation_id).maybeSingle();
    const {data:commerce,error:commerceError}=await client.from("conversation_commerce_state").select("revision,state").eq("conversation_id",args.conversation_id).eq("company_id",reply.metadata.b2_expected_company_id).maybeSingle();
    if(sourceError || commerceError || source?.role!=="visitor" || !commerce || !isConversationCommerceState(commerce.state) || !isCanonicalConversationMemory(stored.memory) ||
      stored.memory.company_id!==stored.company_id || stored.memory.conversation_id!==args.conversation_id ||
      stored.memory.memory_revision!==Number(stored.revision) || stored.memory.commerce_state_revision!==Number(commerce.revision) ||
      Number(stored.commerce_state_revision)!==Number(commerce.revision) || Number(reply.metadata.b2_expected_revision)!==Number(commerce.revision))return false;
    const currentState:ConversationCommerceState=commerce.state;
    const plan=resolveEntityLifecyclePlan(String(source.content),currentState);
    if(reply.metadata.commerce_reason==="ambiguous_lifecycle_target")return plan.kind==="ambiguous";
    return plan.kind==="mutation" && plan.plans.every(p=>currentState.entities.some(e=>(p.target_entity_id?e.entity_id===p.target_entity_id:e.category===p.target_category) && e.status===p.action)) && !plan.plans.some(p=>p.focus_category && p.focus_category!==currentState.current_topic);
  }
  if(!isCanonicalConversationMemory(stored.memory) || stored.source_message_id!==args.source_message_id ||
    stored.memory.memory_revision!==Number(stored.revision)) return false;
  const {data:source,error:sourceError} = await client.from("messages").select("id,role,content")
    .eq("id",args.source_message_id).eq("conversation_id",args.conversation_id).maybeSingle();
  const {data:commerce,error:commerceError}=await client.from("conversation_commerce_state").select("revision,state")
    .eq("conversation_id",args.conversation_id).eq("company_id",stored.company_id).maybeSingle();
  if(sourceError || !source || commerceError || (commerce?.revision??null)!==stored.commerce_state_revision) return false;
  const prior: CanonicalConversationMemory=stored.memory;
  const lifecycle=questionLifecycle([reply,source],commerce?.state??null,prior);
  const open=uniqueStrings(lifecycle.filter(item=>item.status==="pending").map(item=>item.text),MAX_OPEN);
  const professional=prior.question_lifecycle?.filter(item=>item.resolution?.includes("professional")).map(item=>item.text)??[];
  const pending=uniqueStrings([...prior.pending_actions.filter(item=>!professional.includes(item)),...lifecycle.filter(item=>item.status==="pending"&&item.resolution?.includes("professional")).map(item=>item.text)],MAX_ACTIONS);
  const readback = async (memory: CanonicalConversationMemory, markdown: string, parentRevision: number, parentHash: string) =>
    await readExactMemoryReplyLifecycle(client, {
      ...args, company_id: stored.company_id, parent_revision: parentRevision, parent_hash: parentHash,
      commerce_state_revision: stored.commerce_state_revision, memory, markdown_projection: markdown,
      reply_content: String(reply.content),
    });
  if(sameCanonicalJson(lifecycle,prior.question_lifecycle??[]) && sameCanonicalJson(open,prior.open_questions) && sameCanonicalJson(pending,prior.pending_actions)) {
    // Retrying a finalized reply still has to prove its separate receipt. A
    // genuinely unchanged lifecycle can instead prove the original customer commit.
    const {data:receipt,error:receiptError}=await client.from("c3_memory_reply_lifecycle_receipt")
      .select("parent_revision,parent_hash").eq("reply_message_id",args.reply_message_id)
      .eq("conversation_id",args.conversation_id).eq("company_id",stored.company_id).maybeSingle();
    if(receiptError)return false;
    if(receipt)return (await readback(prior,String(stored.markdown_projection),Number(receipt.parent_revision),String(receipt.parent_hash))).status==="committed";
    return (await readExactConversationMemoryCommit(client,{conversation_id:args.conversation_id,company_id:stored.company_id,
      source_message_id:args.source_message_id,revision:Number(stored.revision),commerce_state_revision:stored.commerce_state_revision,
      memory:prior,markdown_projection:String(stored.markdown_projection)})).status==="committed";
  }
  const memory={...prior,memory_revision:Number(stored.revision)+1,question_lifecycle:lifecycle,open_questions:open,pending_actions:pending,
    handoff_relevant_state:{...prior.handoff_relevant_state,open_questions:open.slice(0,6),pending_actions:pending.slice(0,6)}};
  const markdown=buildConversationMemoryMarkdown(memory);
  // No fallback to rewriting the original source receipt. An ambiguous network
  // acknowledgement succeeds only if the distinct durable receipt and full state agree.
  try {
    await client.rpc("c3_finalize_memory_reply_tx",{
      p_conversation_id:args.conversation_id,p_company_id:stored.company_id,p_source_message_id:args.source_message_id,
      p_reply_message_id:args.reply_message_id,p_expected_memory_revision:Number(stored.revision),
      p_expected_memory_hash:String(stored.memory_hash),p_memory:memory,p_markdown_projection:markdown,
    });
  } catch {
    // Continue to exact readback; a thrown transport error is never itself success.
  }
  return (await readback(memory,markdown,Number(stored.revision),String(stored.memory_hash))).status==="committed";
}
