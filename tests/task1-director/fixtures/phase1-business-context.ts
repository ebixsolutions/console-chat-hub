/** Deterministic native adapters; no Hosted, model, Auth/RLS or concurrency claim. */
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "../../../supabase/functions/_shared/commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceRuntimeInput, type CommerceRuntimeOutcome, type CommerceStateDbClient } from "../../../supabase/functions/_shared/commerce-state-runtime-base.ts";
import { type CommerceSemanticFrame } from "../../../supabase/functions/_shared/commerce-semantic-frame.ts";
import { buildCanonicalConversationMemory, type CanonicalConversationMemory } from "../../../supabase/functions/_shared/conversation-long-memory.ts";
import { executeB2PersistenceGate, type B2DatabaseClient, type B2EvaluationInput } from "../../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";
import type { B2TrustedScopedJourneyProgress } from "../../../supabase/functions/_shared/b2-journey-progress-contract.ts";

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export function unchanged(actual: unknown, expected: unknown, reason: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), reason);
}
export function noTransaction(state: ConversationCommerceState): void {
  assert(state.quotes.length === 0 && state.conversion.order_status === "none" &&
    state.conversion.payment_status === "none" && state.conversion.quotation_status === "none",
    "customer requirements acquired merchant transaction authority");
}
export function reading(operation: CommerceSemanticFrame["operation"], topic: string,
  language: "en" | "zh-TW" = "en"): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language, operation, intent: "customer_guidance", topic,
    entities: [], referents: [], customer_facts: [], requested_facts: [], customer_correction: false,
    additive: false, explicit_negations: [], transaction_state: "none", payment_state: "none",
    booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: .99 };
}
export function storage(key: string, initial = createEmptyConversationCommerceState(), revision = 1) {
  const owner = { company_id: `business-${key}-company`, conversation_id: `business-${key}-ticket` };
  initial.language ??= "en";
  const live = { ...owner, state: structuredClone(initial), revision, source: "customer-fixture-source",
    writes: 0, attempts: 0, seen: new Set<string>(), reject: false,
    history: [] as { id: string; role: string; content: string }[] };
  const db: CommerceStateDbClient = {
    from: () => {
      const query = { select: (_columns: string) => query, eq: (_key: string, _value: unknown) => query,
        maybeSingle: async () => ({ data: { company_id: live.company_id, conversation_id: live.conversation_id,
          source_message_id: live.source, revision: live.revision, state: structuredClone(live.state) }, error: null }) };
      return query;
    },
    rpc: async (_name, args) => {
      live.attempts++;
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id,
        "Commerce writer changed company or ticket");
      if (live.reject) return { data: null, error: { message: "synthetic unavailable persistence" } };
      if (args.p_expected_revision !== live.revision) return { data: { result: "revision_conflict" }, error: null };
      const source = String(args.p_source_message_id);
      if (live.seen.has(source)) return { data: { result: "source_message_already_applied", applied_revision: live.revision }, error: null };
      live.state = structuredClone(args.p_state as ConversationCommerceState); live.revision++; live.writes++;
      live.source = source; live.seen.add(source);
      return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  const turn = (text: string, semantic_frame: CommerceSemanticFrame | null, source: string,
    language: "en" | "zh-TW" = "en"): CommerceRuntimeInput =>
    ({ ...owner, text, semantic_frame, source_message_id: source, language });
  const ask = async (input: CommerceRuntimeInput) => {
    const out = await runCommerceStateRuntime(db, { ...input, history: live.history.slice().reverse() });
    live.history.push({ id: input.source_message_id, role: "visitor", content: input.text });
    return out;
  };
  return { owner, live, db, turn, ask };
}
export type BusinessStorage = ReturnType<typeof storage>;
export function evaluation(h: BusinessStorage, input: CommerceRuntimeInput, out: CommerceRuntimeOutcome): B2EvaluationInput {
  assert(out.reply, "actual committed runtime produced no reply");
  return { proposed_response: out.reply, persistence_kind: "ai_reply",
    snapshot: { ...h.owner, source_message_id: input.source_message_id, source_message_content: input.text,
      commerce_state_revision: h.live.revision, commerce_state_source_message_id: h.live.source,
      state: structuredClone(h.live.state) },
    metadata: { response_route: out.route, commerce_reason: out.reason, commerce_authority: out.authority,
      commerce_state_revision: out.revision, commerce_state_persist_result: out.persist_result,
      commerce_state_persistence_classification: out.persist_result === "success" ? "COMMITTED" : "NO_SEMANTIC_CHANGE",
      contextual_decision: out.contextual_decision },
    trusted_journey_progress: structuredClone(out.trusted_journey_progress),
    trusted_lifecycle_commit: structuredClone(out.trusted_lifecycle_commit) };
}
export async function gate(h: BusinessStorage, input: CommerceRuntimeInput, e: B2EvaluationInput,
  mode: "normal" | "revision-drift" | "tenant-drift" | "source-drift" = "normal") {
  let stateReads = 0, commits = 0;
  const client: B2DatabaseClient = { from(table) {
    const filters: Record<string, string> = {};
    const query = { select: (_columns: string) => query,
      eq: (key: string, value: string) => { filters[key] = value; return query; }, maybeSingle: async () => {
        if (table === "conversations") {
          assert(filters.id === h.owner.conversation_id, "B2 conversation lookup changed owner");
          return { data: { id: h.owner.conversation_id, company_id: h.owner.company_id }, error: null };
        }
        if (table === "messages") {
          assert(filters.id === input.source_message_id && filters.conversation_id === h.owner.conversation_id,
            "B2 current Visitor lookup changed source/ticket");
          return { data: { id: input.source_message_id, conversation_id: h.owner.conversation_id,
            role: "visitor", content: input.text }, error: null };
        }
        assert(table === "conversation_commerce_state" && filters.company_id === h.owner.company_id &&
          filters.conversation_id === h.owner.conversation_id, "B2 Commerce lookup changed scope");
        stateReads++;
        return { data: { ...h.owner,
          company_id: mode === "tenant-drift" && stateReads > 1 ? "other-company" : h.owner.company_id,
          source_message_id: mode === "source-drift" && stateReads > 1 ? "newer-source" : h.live.source,
          revision: h.live.revision + (mode === "revision-drift" && stateReads > 1 ? 1 : 0),
          state: structuredClone(h.live.state) }, error: null };
      } };
    return query;
  } };
  const before = structuredClone(h.live.state);
  const result = await executeB2PersistenceGate({ client, conversation_id: h.owner.conversation_id,
    source_message_id: input.source_message_id, proposed_response: e.proposed_response, persistence_kind: "ai_reply",
    metadata: e.metadata, trusted_journey_progress: e.trusted_journey_progress,
    trusted_lifecycle_commit: e.trusted_lifecycle_commit, expected_commerce_state_revision: h.live.revision,
    commit: async snapshot => {
      commits++;
      assert(snapshot.company_id === h.owner.company_id && snapshot.conversation_id === h.owner.conversation_id &&
        snapshot.source_message_id === input.source_message_id && snapshot.commerce_state_revision === h.live.revision,
        "reply callback detached from bound owner/source/revision");
      unchanged(snapshot.state, h.live.state, "reply callback received changed Commerce");
      return "native-bound-reply";
    } });
  unchanged(h.live.state, before, "B2 reads changed canonical Commerce");
  return { result, stateReads, commits };
}
export function memoryArgs(h: BusinessStorage, input: CommerceRuntimeInput,
  receipt: B2TrustedScopedJourneyProgress | null = null) {
  return { ...h.owner, source_message_id: input.source_message_id, commerce_state_revision: h.live.revision,
    commerce_state: h.live.state, newest_first: h.live.history.slice().reverse(),
    customer_fact_delta: (input.semantic_frame?.customer_facts ?? []).map(fact => ({ ...fact,
      authority: "customer" as const, source_message_id: input.source_message_id })),
    committed_scoped_correction: receipt, visitor_turn_count: h.live.history.length,
    source_created_at: "2026-11-25T00:00:00Z" };
}
export function memory(h: BusinessStorage, input: CommerceRuntimeInput) {
  return buildCanonicalConversationMemory({ ...memoryArgs(h, input), next_memory_revision: h.live.history.length });
}
export async function memoryStorage(h: BusinessStorage, previous: CanonicalConversationMemory) {
  const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(value))))).map(value => value.toString(16).padStart(2, "0")).join("");
  const previousHash = await digest(previous);
  const live = { row: { ...h.owner, revision: previous.memory_revision, source_message_id: previous.source_message_id,
    commerce_state_revision: previous.commerce_state_revision, memory: structuredClone(previous),
    markdown_projection: "prior", memory_hash: previousHash },
    event: { ...h.owner, source_message_id: previous.source_message_id, applied_revision: previous.memory_revision,
      commerce_state_revision: previous.commerce_state_revision, memory_hash: previousHash }, writes: 0, reads: 0 };
  const client = { from: (table: string) => {
    const filters: Record<string, unknown> = {};
    const query = { select: (_columns: string) => query, eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      maybeSingle: async () => {
        live.reads++;
        const row = table === "conversation_memory_state_event" ? live.event : live.row;
        return { data: Object.entries(filters).every(([key, value]) => (row as Record<string, unknown>)[key] === value)
          ? structuredClone(row) : null, error: null };
      } };
    return query;
  }, rpc: async (name: string, args: Record<string, unknown>) => {
    live.writes++;
    assert(name === "c3_commit_conversation_memory_tx" && args.p_company_id === h.owner.company_id &&
      args.p_conversation_id === h.owner.conversation_id, "Memory writer changed tenant/ticket");
    if (args.p_expected_memory_revision !== live.row.revision) return { data: { result: "revision_conflict" }, error: null };
    const actual = structuredClone(args.p_memory as CanonicalConversationMemory), hash = await digest(actual);
    live.row = { ...h.owner, revision: live.row.revision + 1, source_message_id: String(args.p_source_message_id),
      commerce_state_revision: Number(args.p_expected_commerce_revision), memory: actual,
      markdown_projection: String(args.p_markdown_projection), memory_hash: hash };
    live.event = { ...h.owner, source_message_id: live.row.source_message_id, applied_revision: live.row.revision,
      commerce_state_revision: live.row.commerce_state_revision, memory_hash: hash };
    return { data: { result: "success", current_revision: live.row.revision }, error: null };
  } };
  return { client, live };
}
