/**
 * W19 generic lifecycle Memory and final reply integrity coverage.
 * Complements the frozen safety twins without changing or parking originals.
 * Native runtime with deterministic persistence adapters is not Hosted,
 * authenticated database concurrency, or end-to-end dialogue acceptance.
 */
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceRuntimeInput, type CommerceStateDbClient } from "../../supabase/functions/_shared/commerce-state-runtime-base.ts";
import { buildCanonicalConversationMemory, verifyCommittedLifecycleMemory } from "../../supabase/functions/_shared/conversation-long-memory.ts";
import { evaluateB2BeforeCommit, executeB2PersistenceGate, type B2DatabaseClient, type B2EvaluationInput } from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const owner = { company_id: "integrity-company", conversation_id: "integrity-ticket" };
const source = "integrity-lifecycle-source";
const text = "Pause Display stand; focus on Training sessions.";

async function fixture() {
  const initial = createEmptyConversationCommerceState();
  initial.language = "en"; initial.current_topic = "training";
  initial.entities = [
    { entity_id: "training:owned", category: "training", quantity: 3, status: "researching",
      attributes: { product_name: "Training sessions", unit: "sessions", quantity_basis: "customer_explicit" },
      constraints: { schedule: "Saturday" }, provenance: { source_type: "customer", source_message_id: "training-source" } },
    { entity_id: "display:owned", category: "display", quantity: 1, status: "tentative",
      attributes: { product_name: "Display stand", unit: "stands", quantity_basis: "customer_explicit" },
      constraints: { max_width_mm: 595 }, provenance: { source_type: "customer", source_message_id: "display-source" } },
  ];
  initial.conversion.tentative_entity_ids = ["display:owned"];
  const live = { state: structuredClone(initial), revision: 4, writes: 0 };
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { ...owner, revision: live.revision, state: structuredClone(live.state) }, error: null,
    }) }) }) }),
    rpc: async (_name, args) => {
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id &&
        args.p_source_message_id === source && args.p_expected_revision === live.revision,
        "actual runtime writer detached from owner, source or current revision");
      live.state = structuredClone(args.p_state as ConversationCommerceState); live.revision++; live.writes++;
      return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  const input: CommerceRuntimeInput = {
    ...owner, source_message_id: source, text, language: "en",
    semantic_frame: {
      version: "commerce-semantic-1.0.0", language: "en", operation: "DEFER", intent: "lifecycle", topic: "display",
      entities: [], referents: [{ ref: "display:owned", source: "persistent_state", confidence: .99 }],
      customer_facts: [], requested_facts: [], customer_correction: false, additive: false, explicit_negations: [],
      transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
      ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: .99,
    },
  };
  const outcome = await runCommerceStateRuntime(db, input);
  assert(outcome?.trusted_lifecycle_commit && outcome.reply && outcome.persist_result === "success" &&
    live.writes === 1 && live.revision === 5, "generic lifecycle fixture did not actually commit: " + JSON.stringify(outcome));
  const receipt = outcome.trusted_lifecycle_commit;
  const memory = buildCanonicalConversationMemory({
    ...owner, source_message_id: source, commerce_state_revision: live.revision, commerce_state: live.state,
    newest_first: [{ id: source, role: "visitor", content: text }], visitor_turn_count: 3,
    source_created_at: "2026-11-24T00:00:00.000Z", next_memory_revision: 3,
  });
  const parity = { memory, receipt, commerce: { company_id: owner.company_id,
    source_message_id: source, revision: live.revision, state: live.state } };
  const evaluation: B2EvaluationInput = {
    proposed_response: outcome.reply, persistence_kind: "ai_reply",
    snapshot: { ...owner, source_message_id: source, source_message_content: text,
      commerce_state_revision: live.revision, commerce_state_source_message_id: source, state: structuredClone(live.state) },
    metadata: { response_route: outcome.route, commerce_reason: outcome.reason, commerce_authority: outcome.authority,
      commerce_state_revision: outcome.revision, commerce_state_persist_result: outcome.persist_result,
      commerce_state_persistence_classification: "COMMITTED" }, trusted_lifecycle_commit: structuredClone(receipt),
  };
  return { initial, live, outcome, parity, evaluation };
}

Deno.test("P1TW-W19 integrity positive: actual generic lifecycle receipt agrees with canonical Memory", async () => {
  const f = await fixture(), before = JSON.stringify(f.live.state);
  assert(verifyCommittedLifecycleMemory(f.parity), "actual source-bound Memory rejected the committed lifecycle");
  const active = f.parity.memory.active_entities, inactive = f.parity.memory.cancelled_or_superseded;
  assert(active.length === 1 && active[0].entity_id === "training:owned" && active[0].quantity === 3 &&
    active[0].current_requirements.schedule === "Saturday" &&
    inactive.filter(row => row.key === "entity:display:owned" && row.value === "deferred").length === 1,
    "Memory changed retained quantity/requirements or lost the deferred item");
  assert(JSON.stringify(f.live.state.entities[0]) === JSON.stringify(f.initial.entities[0]) &&
    JSON.stringify(f.live.state) === before && f.live.writes === 1, "Memory construction or parity changed committed Commerce");
  assert(f.parity.memory.transaction_summary.order === "none" && f.parity.memory.transaction_summary.payment === "none" &&
    f.parity.memory.transaction_summary.quotation === "none", "Memory promoted lifecycle into a transaction");
});

for (const mode of ["missing-memory", "missing-receipt", "missing-commerce", "memory-tenant", "commerce-tenant",
  "memory-source", "commerce-source", "memory-revision", "commerce-revision", "missing-active", "missing-deferred",
  "active-quantity", "active-requirements", "duplicate-active", "duplicate-deferred", "inactive-as-active"] as const) {
  Deno.test(`P1TW-W19 Memory negative: ${mode}`, async () => {
    const f = await fixture(), original = JSON.stringify(f.parity);
    const p: Parameters<typeof verifyCommittedLifecycleMemory>[0] = structuredClone(f.parity);
    if (mode === "missing-memory") p.memory = null;
    if (mode === "missing-receipt") p.receipt = null;
    if (mode === "missing-commerce") p.commerce = null;
    if (mode === "memory-tenant") p.memory!.company_id = "foreign-company";
    if (mode === "commerce-tenant") p.commerce!.company_id = "foreign-company";
    if (mode === "memory-source") p.memory!.source_message_id = "other-source";
    if (mode === "commerce-source") p.commerce!.source_message_id = "other-source";
    if (mode === "memory-revision") {
      const memory = p.memory;
      assert(memory && typeof memory.commerce_state_revision === "number" &&
        Number.isInteger(memory.commerce_state_revision) && memory.commerce_state_revision > 0,
        "memory-revision negative requires a real committed numeric revision");
      memory.commerce_state_revision--;
    }
    if (mode === "commerce-revision") p.commerce!.revision--;
    if (mode === "missing-active") p.memory!.active_entities = [];
    if (mode === "missing-deferred") p.memory!.cancelled_or_superseded = [];
    if (mode === "active-quantity") p.memory!.active_entities[0].quantity = 2;
    if (mode === "active-requirements") p.memory!.active_entities[0].current_requirements.schedule = "Sunday";
    if (mode === "duplicate-active") p.memory!.active_entities.push(structuredClone(p.memory!.active_entities[0]));
    if (mode === "duplicate-deferred") p.memory!.cancelled_or_superseded.push(structuredClone(
      p.memory!.cancelled_or_superseded.find(row => row.key === "entity:display:owned")!));
    if (mode === "inactive-as-active") p.memory!.active_entities.push({ ...structuredClone(p.memory!.active_entities[0]), entity_id: "display:owned" });
    assert(!verifyCommittedLifecycleMemory(p), "invalid Memory passed lifecycle parity: " + mode);
    assert(JSON.stringify(f.parity) === original && f.live.writes === 1, "negative verification mutated the original receipt/state");
  });
}

// W19 also requires B2 to reject a wrong target, changed retained quantity and
// fabricated sibling even when tenant/source/revision appear unchanged.
for (const mode of ["wrong-target", "retained-quantity", "ghost-entity"] as const) {
  Deno.test(`P1TW-W19 B2 negative: ${mode} cannot reach reply persistence`, async () => {
    const f = await fixture(), e = f.evaluation, initial = JSON.stringify(f.live.state);
    assert(evaluateB2BeforeCommit(e).code === "B2_ALLOW_COMMITTED_SCOPED_LIFECYCLE", "valid B2 setup failed");
    if (mode === "wrong-target") e.trusted_lifecycle_commit!.target_entity_ids = ["training:owned"];
    if (mode === "retained-quantity") e.snapshot.state.entities[0].quantity = 2;
    if (mode === "ghost-entity") e.snapshot.state.entities.push({ ...structuredClone(e.snapshot.state.entities[0]), entity_id: "training:ghost" });
    assert(evaluateB2BeforeCommit(e).decision !== "allow", "tampered lifecycle passed initial B2: " + mode);
    let callbacks = 0, reads = 0;
    const client: B2DatabaseClient = {
      from(table) {
        const filters: Record<string, string> = {};
        const q = { select: (_columns: string) => q, eq: (key: string, value: string) => { filters[key] = value; return q; },
          maybeSingle: async () => {
            if (table === "conversations") {
              assert(filters.id === owner.conversation_id, "B2 lookup changed conversation");
              return { data: { id: owner.conversation_id, company_id: owner.company_id }, error: null };
            }
            if (table === "messages") {
              assert(filters.id === source && filters.conversation_id === owner.conversation_id, "B2 lookup changed current message");
              return { data: { id: source, conversation_id: owner.conversation_id, role: "visitor", content: text }, error: null };
            }
            assert(table === "conversation_commerce_state" && filters.conversation_id === owner.conversation_id &&
              filters.company_id === owner.company_id, "B2 lookup changed Commerce owner");
            reads++;
            return { data: { ...owner, revision: f.live.revision, source_message_id: source, state: structuredClone(e.snapshot.state) }, error: null };
          } };
        return q;
      },
    };
    const gated = await executeB2PersistenceGate({ client, conversation_id: owner.conversation_id, source_message_id: source,
      proposed_response: e.proposed_response, persistence_kind: "ai_reply", metadata: e.metadata,
      trusted_lifecycle_commit: e.trusted_lifecycle_commit, expected_commerce_state_revision: f.live.revision,
      commit: async () => { callbacks++; return { unexpected: true }; } });
    assert(!gated.committed && gated.decision.decision !== "allow" && callbacks === 0 && reads === 1,
      "invalid same-revision lifecycle reached reply persistence: " + JSON.stringify({ mode, gated, callbacks, reads }));
    assert(JSON.stringify(f.live.state) === initial && f.live.writes === 1, "B2 changed canonical lifecycle state");
  });
}
