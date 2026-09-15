import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import {
  projectConversationRuntimeState,
  type RuntimeHistoryRow,
} from "./conversation-runtime-state-core.ts";

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
  const prior = args.previous &&
      args.previous.conversation_id === args.conversation_id &&
      args.previous.company_id === args.company_id
    ? args.previous
    : null;
  const currentRegions = [
    ...(runtime.current_requirements.current_market
      ? [{ region: runtime.current_requirements.current_market, temporal_scope: "current" as const }]
      : []),
    ...runtime.current_requirements.future_markets.map((region) => ({ region, temporal_scope: "future" as const })),
  ].filter((item, index, all) => all.findIndex((x) => x.region === item.region && x.temporal_scope === item.temporal_scope) === index)
    .slice(0, MAX_REGIONS);
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
    historical_facts: stableFacts([...(prior?.historical_facts ?? []), ...commerce.historical_facts], MAX_HISTORY),
    cancelled_or_superseded: stableFacts([...(prior?.cancelled_or_superseded ?? []), ...commerce.cancelled_or_superseded], MAX_HISTORY),
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

export function resolveStructuredMemoryResponse(
  latestInput: string,
  memory: CanonicalConversationMemory | null,
): string | null {
  if (!memory) return null;
  const latest = clean(latestInput, 800);
  if (!latest || /(?:請記住|请记住|please\s+remember|remember\s+that)/i.test(latest)) return null;
  const asksFirst = /(?:一開始|一开始|最初).*(?:問|需求)|(?:first|original).*(?:question|request|goal)/i.test(latest);
  if (asksFirst && memory.current_goal) return memory.current_goal;
  const asksCorrection = /(?:最新|最後|最后|之前).*(?:更正|改正)|latest\s+correction|what.*correct/i.test(latest);
  if (asksCorrection && memory.latest_corrections.length) return memory.latest_corrections[0];
  const asksSummary = /(?:總結|总结|整理|summari[sz]e).*(?:需求|對話|对话|conversation|requirements?|state)|(?:目前|現在|现在|current).*(?:需求|狀態|状态|requirements?|state)/i.test(latest);
  if (asksSummary) return buildConversationMemoryMarkdown(memory);
  return null;
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
    memoryBlock ? "Canonical structured conversation memory (derived; lower authority than commerce state and current KB):\n" + memoryBlock : "",
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
  if (error) return { ok: false, reason: "memory_commit_transport" };
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
    if (retry.error) return { ok: false, reason: "memory_retry_transport" };
    if (clean(retry.data?.result, 80) !== "success") {
      return { ok: false, reason: clean(retry.data?.result, 80) || "memory_retry_failed" };
    }
    return { ok: true, memory: retryMemory, markdown: retryMarkdown, revision: Number(retry.data.current_revision ?? retry.data.applied_revision), idempotent: Boolean(retry.data.idempotent) };
  }
  if (result !== "success") return { ok: false, reason: result || "memory_commit_unknown" };
  return { ok: true, memory, markdown, revision: Number(data.current_revision ?? data.applied_revision), idempotent: Boolean(data.idempotent) };
}
