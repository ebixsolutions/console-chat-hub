/**
 * Additive generic coverage for the original named journey failures.
 * Native runtime/B2 and deterministic persistence harness only. These callbacks
 * do not retire originals, grant a CI exemption, or establish Hosted/model
 * quality. The companion coverage ledger records remaining equivalence gaps.
 */
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceRuntimeInput, type CommerceRuntimeOutcome, type CommerceStateDbClient } from "../../supabase/functions/_shared/commerce-state-runtime.ts";
import { normalizeCommerceSemanticFrame, type CommerceSemanticFrame } from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import { type SourceBoundContextualGoal, type SourceBoundScopeFact, type ScopedCustomerValue } from "../../supabase/functions/_shared/contextual-customer-update.ts";
import { evaluateB2BeforeCommit } from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";
import { buildCanonicalConversationMemory } from "../../supabase/functions/_shared/conversation-long-memory.ts";
import { classifyHandoffIntent } from "../../supabase/functions/_shared/handoff-intent.ts";
import { classifyNaturalCustomerIntent, requiresCurrentMerchantEvidence, arbitrateAnaphoricProductFollowUp } from "../../supabase/functions/_shared/natural-customer-response.ts";
import { resolveCanonicalCommerceResolution } from "../../supabase/functions/_shared/conversation-resolution-contract.ts";
import { deriveTypedCustomerCalculation, isHistoricalOrConditionalCustomerCalculationRequest } from "../../supabase/functions/_shared/conversation-service-runtime.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const owner = { company_id: "generic-journey-company", conversation_id: "generic-journey-ticket" };
const capabilities = { requires_delivery: false, supports_pickup: false, requires_installation: false,
  requires_booking: false, requires_quote: false, requires_site_check: false,
  digital_fulfilment: false, recurring_billing: false, rental_return: false, customization: false };
function reading(): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language: "en", operation: "UPDATE_ITEM",
    intent: "customer_guidance", topic: "Training sessions", entities: [], referents: [], customer_facts: [],
    requested_facts: [], customer_correction: false, additive: false, explicit_negations: [],
    transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: .99 };
}
function normalized(frame: CommerceSemanticFrame): CommerceSemanticFrame {
  const actual = normalizeCommerceSemanticFrame(frame); assert(actual, "invalid new generic Reading fixture"); return actual;
}
function scope(source = "scope-source", subject = "Training sessions", count = 2, correction = false): CommerceRuntimeInput {
  const text = `${subject} for ${count} teams and 1 lobby. Please offer general planning advice.`;
  const frame = reading(); frame.topic = subject; frame.customer_correction = correction;
  frame.customer_facts = [{ key: "contextual_scope_counts", value: [
    { scope: "teams", count, source_text: `${count} teams`, subject_label: subject },
    { scope: "lobby", count: 1, source_text: "1 lobby", subject_label: subject },
  ] }];
  frame.demands = [{ question: text, source_quote: text, subject_refs: [subject], source_type: "general",
    requested_facts: [], constraints: {}, customer_correction: correction, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  return { ...owner, source_message_id: source, text, language: "en", semantic_frame: normalized(frame) };
}
function allocate(goal: SourceBoundContextualGoal, source = "allocation-source", unit = "slots", ref = goal.goal_id): CommerceRuntimeInput {
  const frame = reading(); frame.intent = "scoped allocation"; frame.topic = goal.subject_label;
  frame.entities = [{ entity_ref: ref, name: goal.subject_label, kind: "service", category_hint: null,
    model: null, sku: null, quantity: null, unit, attributes: { scoped_customer_updates: [
      { scope: "lobby", source_text: `lobby 1 ${unit}`, unit, value: 1, attribute: "quantity", action: "set" },
      { scope: "teams", source_text: `teams 1 ${unit} each`, unit, value: 1, per_scope_quantity: 1,
        scope_count: null, attribute: "quantity", action: "set" },
    ] }, constraints: {}, capabilities, confidence: .99 }];
  frame.referents = [{ ref, source: "persistent_state", confidence: .99 }];
  return { ...owner, source_message_id: source, text: `lobby 1 ${unit}, teams 1 ${unit} each`, language: "en",
    semantic_frame: normalized(frame) };
}
function context(source: string, key: string, amount: number, unit: string): CommerceRuntimeInput {
  const frame = reading(); frame.intent = "customer_context_update";
  frame.customer_facts = [{ key, value: { amount, unit } }];
  return { ...owner, source_message_id: source, text: `${key.replaceAll("_", " ")} ${amount} ${unit}.`,
    language: "en", semantic_frame: normalized(frame) };
}
function storage() {
  const initial = createEmptyConversationCommerceState();
  // The conversation already has a known UI locale. This isolates denied
  // business mutations from the legitimate first-write locale bookkeeping.
  initial.language = "en";
  const live = { state: initial, revision: 1, writes: 0, source: "known-locale-source",
    history: [] as { id: string; role: string; content: string }[], seen: new Set<string>(),
    reject: false, lastInput: null as CommerceRuntimeInput | null };
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: live.revision ? { ...owner, source_message_id: live.source, revision: live.revision,
        state: structuredClone(live.state) } : null, error: null,
    }) }) }) }),
    rpc: async (_name, args) => {
      live.writes++;
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id,
        "wrong owner reached the writer");
      if (live.reject) return { data: null, error: { message: "synthetic unavailable persistence" } };
      if (args.p_expected_revision !== live.revision) return { data: { result: "revision_conflict" }, error: null };
      const id = String(args.p_source_message_id);
      if (live.seen.has(id)) return { data: { result: "source_message_already_applied", applied_revision: live.revision }, error: null };
      live.state = structuredClone(args.p_state as ConversationCommerceState); live.revision++; live.source = id;
      live.seen.add(id); return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  const ask = async (input: CommerceRuntimeInput) => {
    const out = await runCommerceStateRuntime(db, { ...input, history: live.history.slice().reverse() });
    live.history.push({ id: input.source_message_id, role: "visitor", content: input.text });
    live.lastInput = input; return out;
  };
  return { db, live, ask };
}
function goal(state: ConversationCommerceState): SourceBoundContextualGoal {
  const result = state.customer_constraints.contextual_goal as SourceBoundContextualGoal;
  assert(result?.goal_id, "canonical goal missing"); return result;
}
function noTransaction(state: ConversationCommerceState): void {
  assert(state.conversion.order_status === "none" && state.conversion.payment_status === "none" &&
    state.conversion.quotation_status === "none" && state.quotes.length === 0, "customer requirements promoted a transaction");
}
function memory(s: ReturnType<typeof storage>) {
  return buildCanonicalConversationMemory({ ...owner, source_message_id: s.live.source,
    // Same actual generate-reply caller argument: current semantic customer
    // facts enter Memory explicitly; they are never re-parsed from old text.
    customer_fact_delta: (s.live.lastInput?.semantic_frame?.customer_facts ?? []).map(fact => ({
      ...fact, authority: "customer" as const, source_message_id: s.live.lastInput!.source_message_id,
    })),
    commerce_state_revision: s.live.revision, commerce_state: s.live.state,
    newest_first: s.live.history.slice().reverse(), visitor_turn_count: s.live.history.length,
    source_created_at: "2026-11-24T00:00:00Z", next_memory_revision: s.live.history.length });
}
function b2(s: ReturnType<typeof storage>, input: CommerceRuntimeInput, out: CommerceRuntimeOutcome) {
  return { proposed_response: out.reply ?? "", persistence_kind: "ai_reply" as const,
    snapshot: { ...owner, source_message_id: input.source_message_id, source_message_content: input.text,
      commerce_state_source_message_id: input.source_message_id, commerce_state_revision: s.live.revision, state: s.live.state },
    metadata: { response_route: out.route, commerce_reason: out.reason, commerce_authority: out.authority,
      commerce_state_revision: out.revision, commerce_state_persist_result: out.persist_result,
      commerce_state_persistence_classification: "COMMITTED", contextual_decision: out.contextual_decision },
    trusted_journey_progress: out.trusted_journey_progress };
}

// These two callbacks preserve source wording and actual units independently;
// no translation to a canonical appliance room/category/unit is supplied.
for (const [id, subject, unit] of [
  ["W9-1", "Training sessions", "slots"], ["W9-2", "Workspace subscriptions", "licences"],
] as const) {
  Deno.test(`P1 twin ${id}: literal scoped allocation commits three source-owned requirements`, async () => {
    const s = storage(); const first = await s.ask(scope("scope-source", subject));
    assert(first?.route === "product_guidance" && s.live.state.entities.length === 0, "scope became a phantom item");
    const input = allocate(goal(s.live.state), "allocation-source", unit);
    const result = await s.ask(input); const entity = s.live.state.entities[0];
    assert(result?.route === "contextual_scoped_update" && result.persist_result === "success" &&
      s.live.state.entities.length === 1 && entity.quantity === 3 && entity.attributes.product_name === subject,
      JSON.stringify(result));
    const rows = entity.attributes.scoped_customer_updates as ScopedCustomerValue[];
    assert(rows.length === 3 && rows.every(row => row.value === 1 && row.source_message_id === input.source_message_id &&
      row.source_revision === s.live.revision), JSON.stringify(rows));
    assert(result.reply?.includes(`Total 3 ${unit}`) && result.reply.includes(`lobby 1 ${unit}`) &&
      result.reply.includes(`teams 1 ${unit} each`) && !/contextual-item|contextual-goal|teams#/u.test(result.reply), String(result.reply));
    assert(resolveCanonicalCommerceResolution({ outcome: result, authoritative_address_correction: false }).bypass_service_plan,
      "accepted scoped answer lost canonical precedence");
    assert(evaluateB2BeforeCommit(b2(s, input, result)).decision === "allow", "scoped accepted reply did not pass B2");
    const m = memory(s); assert(m.commerce_state_revision === s.live.revision &&
      m.active_entities.some(item => item.entity_id === entity.entity_id && item.quantity === 3), "Memory lost the committed quantity");
    noTransaction(s.live.state);
    const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
    const replay = await s.ask(input);
    assert(replay?.persist_result === "no_semantic_change" && s.live.writes === writes && s.live.revision === revision &&
      JSON.stringify(s.live.state) === before, "same-source replay changed state or provenance");
  });
  for (const bad of ["missing", "count", "per-scope", "source-quote", "goal", "unit", "total"] as const) {
    Deno.test(`P1 twin ${id} negative ${bad}: invalid Reading cannot mutate`, async () => {
      const s = storage(); await s.ask(scope("scope-source", subject));
      const input = allocate(goal(s.live.state), "bad-allocation", unit), frame = input.semantic_frame!;
      const rows = frame.entities[0].attributes.scoped_customer_updates as Record<string, unknown>[];
      if (bad === "missing") input.semantic_frame = null;
      if (bad === "count") rows[1].scope_count = 9;
      if (bad === "per-scope") { rows[1].value = 4; rows[1].per_scope_quantity = 4; }
      if (bad === "source-quote") rows[1].source_text = "another unspoken source";
      if (bad === "goal") { frame.entities[0].entity_ref = "foreign-goal"; frame.referents[0].ref = "foreign-goal"; }
      if (bad === "unit") { frame.entities[0].unit = "packages"; for (const row of rows) row.unit = "packages"; }
      if (bad === "total") frame.entities[0].quantity = 7;
      const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
      const result = await s.ask(input);
      assert(result?.route !== "contextual_scoped_update" && s.live.writes === writes && s.live.revision === revision &&
        JSON.stringify(s.live.state) === before, `${bad}: ${JSON.stringify({result,before:JSON.parse(before),after:s.live.state})}`);
    });
  }
}

Deno.test("P1 twin W9: three intervening customer details retain first-turn scope and exact provenance", async () => {
  const s = storage(); await s.ask(scope());
  const scopeRevision = s.live.revision;
  const originalGoal = structuredClone(goal(s.live.state));
  const originalFacts = structuredClone(s.live.state.customer_constraints.contextual_scope_facts);
  const details = [context("detail-duration", "session_duration", 80, "minutes"),
    context("detail-break", "break_duration", 10, "minutes"),
    context("detail-material", "practice_pages", 12, "pages")];
  for (const input of details) {
    const result = await s.ask(input);
    assert(result?.persist_result === "success" && s.live.state.entities.length === 0, JSON.stringify(result));
    assert(JSON.stringify(goal(s.live.state)) === JSON.stringify(originalGoal) &&
      JSON.stringify(s.live.state.customer_constraints.contextual_scope_facts) === JSON.stringify(originalFacts),
      "intervening detail rewrote original source binding");
  }
  const retained = JSON.stringify(s.live.state.customer_constraints.customer_reported_facts);
  for (const input of details) assert(retained.includes(input.source_message_id), "intervening detail source lost: " + input.source_message_id);
  const input = allocate(goal(s.live.state), "fifth-source"), result = await s.ask(input);
  assert(result?.route === "contextual_scoped_update" && s.live.state.entities[0].quantity === 3, JSON.stringify(result));
  const rows = s.live.state.entities[0].attributes.scoped_customer_updates as ScopedCustomerValue[];
  assert(rows.filter(row => row.group_scope === "teams").every(row =>
    row.scope_count_source?.source_message_id === "scope-source" && row.scope_count_source.source_revision === scopeRevision),
    "allocation borrowed recent text instead of original committed count");
  assert(JSON.stringify(s.live.state.customer_constraints.customer_reported_facts) === retained, "allocation erased intervening detail");
  noTransaction(s.live.state);
});

Deno.test("P1 twin W13 positive: sequential accepted quantity uses bounded current-source B2 receipt", async () => {
  const s = storage(); await s.ask(scope());
  await s.ask(scope("scope-correction", "Training sessions", 3, true));
  const acceptedPriorRevision = s.live.revision;
  const input = allocate(goal(s.live.state), "after-correction"), result = await s.ask(input);
  assert(result?.trusted_journey_progress && s.live.state.entities[0].quantity === 4, JSON.stringify(result));
  const verdict = evaluateB2BeforeCommit(b2(s, input, result));
  assert(verdict.decision === "allow" && verdict.code === "B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE",
    JSON.stringify(verdict));
  assert(result.trusted_journey_progress.previous_revision === acceptedPriorRevision &&
    result.trusted_journey_progress.committed_revision === acceptedPriorRevision + 1 &&
    result.trusted_journey_progress.source_message_id === input.source_message_id, "proof did not follow accepted commit");
  const facts = s.live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[];
  assert(facts.find(fact => fact.scope === "teams")?.source_message_id === "scope-correction" &&
    facts.find(fact => fact.scope === "lobby")?.source_message_id === "scope-source", "correction rewrote unrelated provenance");
  noTransaction(s.live.state);
});

for (const mode of ["transport", "revision-conflict"] as const) {
  Deno.test(`P1 twin journey negative ${mode}: failed persistence cannot acknowledge requirements`, async () => {
    const s = storage(); await s.ask(scope()); const input = allocate(goal(s.live.state));
    const before = JSON.stringify(s.live.state), revision = s.live.revision;
    if (mode === "transport") s.live.reject = true;
    else s.db.rpc = async () => ({ data: { result: "revision_conflict" }, error: null });
    const result = await s.ask(input);
    assert(result?.reply === null && !result.trusted_journey_progress && result.persist_result !== "success" &&
      s.live.revision === revision && JSON.stringify(s.live.state) === before, JSON.stringify(result));
  });
}

Deno.test("P1 twin W15: current merchant facts keep evidence authority after a generic journey", async () => {
  const s = storage(); await s.ask(scope()); await s.ask(allocate(goal(s.live.state)));
  const before = JSON.stringify(s.live.state);
  const text = "What features does COURSE-X91 have?";
  const intent = classifyNaturalCustomerIntent(text);
  assert(intent.kind === "product_factual_query" && requiresCurrentMerchantEvidence(intent), JSON.stringify(intent));
  // Keep the original W15 follow-up speech act; only its customer subject is
  // changed to a non-appliance identifier. New unseen English grammar is not
  // silently substituted for the original obligation under this mapping.
  const follow = arbitrateAnaphoricProductFollowUp("咁呢部而家賣幾錢？", [{ role: "visitor", content: text }]);
  assert(follow.kind === "resolved" && follow.intent.product === "COURSE-X91" &&
    follow.intent.fact === "price" && requiresCurrentMerchantEvidence(follow.intent), JSON.stringify(follow));
  assert(JSON.stringify(s.live.state) === before, "current merchant inquiry changed customer state");
  const second = await s.ask(scope("second-subject", "Festival catering", 4));
  assert(second?.route === "product_guidance" && s.live.state.entities.length === 1 &&
    s.live.state.entities[0].quantity === 3 && s.live.state.entities[0].attributes.product_name === "Training sessions",
    "new research subject invented an item or inherited the first quantity: " + JSON.stringify({second,state:s.live.state}));
  const retained = JSON.stringify(s.live.state.entities[0]);
  const latestGoal = goal(s.live.state), input = allocate(latestGoal, "second-subject-allocation", "portions");
  const allocated = await s.ask(input);
  const next = s.live.state.entities.find(entity => entity.attributes.product_name === "Festival catering");
  assert(allocated?.route === "contextual_scoped_update" && Number(s.live.state.entities.length) === 2 && next?.quantity === 5 &&
    JSON.stringify(s.live.state.entities[0]) === retained, "new source-bound allocation changed the sibling or borrowed its count");
  assert(evaluateB2BeforeCommit(b2(s, input, allocated)).decision === "allow", "second subject receipt failed B2");
  const replayBefore = JSON.stringify(s.live.state), replayRevision = s.live.revision, replayWrites = s.live.writes;
  const replay = await s.ask(input);
  assert(replay?.route === "contextual_scoped_update" && replay.persist_result === "no_semantic_change" &&
    s.live.revision === replayRevision && s.live.writes === replayWrites && JSON.stringify(s.live.state) === replayBefore,
    "same-source second-subject replay lost its committed receipt or changed state: " + JSON.stringify(replay));
  noTransaction(s.live.state);
});

for (const mode of ["missing-reading", "forged-quote", "wrong-count", "old-referent", "mixed-subject", "unproved-correction"] as const) {
  Deno.test(`P1 twin new-subject negative ${mode}: another item cannot grant planning authority`, async () => {
    const s = storage(); await s.ask(scope()); await s.ask(allocate(goal(s.live.state)));
    const input = scope("unproved-new-topic", "Festival catering", 4), frame = input.semantic_frame!;
    if (mode === "missing-reading") input.semantic_frame = null;
    if (mode === "forged-quote") frame.demands![0].source_quote = "Festival catering for 8 teams.";
    if (mode === "wrong-count") (frame.customer_facts![0].value as Record<string, unknown>[])[0].count = 2;
    if (mode === "old-referent") frame.referents = [{ ref: s.live.state.entities[0].entity_id, source: "persistent_state", confidence: .99 }];
    if (mode === "mixed-subject") { input.text += " Keep Training sessions in the same plan."; frame.demands![0].source_quote = input.text; }
    if (mode === "unproved-correction") frame.demands![0].customer_correction = true;
    const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
    const result = await s.ask(input);
    assert(result?.persist_result !== "success" && s.live.writes === writes && s.live.revision === revision &&
      JSON.stringify(s.live.state) === before, mode + ": " + JSON.stringify(result));
  });
}
for (const mode of ["borrowed-old-goal", "borrowed-old-count", "future-count", "foreign-count", "inactive-target"] as const) {
  Deno.test(`P1 twin new-allocation negative ${mode}: new source cannot borrow earlier item authority`, async () => {
    const s = storage(); await s.ask(scope()); const originalGoal = structuredClone(goal(s.live.state));
    await s.ask(allocate(originalGoal)); await s.ask(scope("new-topic", "Festival catering", 4));
    const latestGoal = goal(s.live.state);
    const input = allocate(latestGoal, "new-allocation", "portions");
    const facts = s.live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[];
    const relevant = facts.find(fact => fact.goal_id === latestGoal.goal_id && fact.scope === "teams")!;
    if (mode === "borrowed-old-goal") {
      input.semantic_frame!.entities[0].entity_ref = originalGoal.goal_id;
      input.semantic_frame!.referents[0].ref = originalGoal.goal_id;
    }
    if (mode === "borrowed-old-count") s.live.state.customer_constraints.contextual_scope_facts = facts.filter(fact =>
      !(fact.goal_id === latestGoal.goal_id && fact.scope === "teams"));
    if (mode === "future-count") relevant.recorded_revision = s.live.revision + 1;
    if (mode === "foreign-count") relevant.company_id = "foreign-company";
    if (mode === "inactive-target") {
      const accepted = await s.ask(allocate(latestGoal, "accepted-before-cancellation", "portions"));
      assert(accepted?.route === "contextual_scoped_update", "negative setup never reached materialization");
      s.live.state.entities.find(entity => entity.attributes.contextual_goal_id === latestGoal.goal_id)!.status = "cancelled";
    }
    const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
    const result = await s.ask(input);
    assert(result?.route !== "contextual_scoped_update" && s.live.writes === writes && s.live.revision === revision &&
      JSON.stringify(s.live.state) === before, mode + ": " + JSON.stringify(result));
  });
}

for (const mode of ["different-source", "altered-allocation", "duplicate-goal", "extra-referent"] as const) {
  Deno.test(`P1 twin second-subject replay negative ${mode}: a committed receipt grants no new authority`, async () => {
    const s = storage(); await s.ask(scope()); await s.ask(allocate(goal(s.live.state)));
    await s.ask(scope("second-replay-scope", "Festival catering", 4));
    const input = allocate(goal(s.live.state), "second-replay-allocation", "portions");
    const accepted = await s.ask(input);
    assert(accepted?.route === "contextual_scoped_update" && s.live.state.entities.length === 2,
      "replay negative setup never reached two committed items");
    if (mode === "different-source") input.source_message_id = "new-source-reusing-old-goal";
    if (mode === "altered-allocation") {
      input.text = "lobby 2 portions, teams 1 portions each";
      const row = (input.semantic_frame!.entities[0].attributes.scoped_customer_updates as Record<string, unknown>[])[0];
      row.source_text = "lobby 2 portions"; row.value = 2;
    }
    if (mode === "duplicate-goal") {
      const copied = structuredClone(s.live.state.entities[1]); copied.entity_id += ":duplicate";
      s.live.state.entities.push(copied);
    }
    if (mode === "extra-referent") input.semantic_frame!.referents.push({
      ref: s.live.state.entities[0].entity_id, source: "persistent_state", confidence: .99,
    });
    const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
    const result = await s.ask(input);
    assert(result?.route !== "contextual_scoped_update" && !result?.trusted_journey_progress &&
      s.live.writes === writes && s.live.revision === revision && JSON.stringify(s.live.state) === before,
      mode + ": " + JSON.stringify(result));
  });
}

for (const mode of ["old-text-new-goal", "new-text-old-entity", "new-text-old-name-and-ref",
  "unnamed-old-entity", "old-text-contradictory-name", "old-text-foreign-ref", "old-text-extra-referent",
  "multiple-active-old-text-new-goal"] as const) {
  Deno.test(`P1 twin second-subject target negative ${mode}: contradictory identity cannot mutate a sibling`, async () => {
    const s = storage(); await s.ask(scope()); await s.ask(allocate(goal(s.live.state)));
    await s.ask(scope("target-new-goal", "Festival catering", 4));
    if (mode === "multiple-active-old-text-new-goal") {
      await s.ask(allocate(goal(s.live.state), "target-second-allocation", "slots"));
      await s.ask(scope("target-third-goal", "Community workshops", 4));
    }
    const latestGoal = goal(s.live.state), old = s.live.state.entities[0];
    const input = allocate(latestGoal, "conflicting-target", "slots"), frame = input.semantic_frame!;
    const item = frame.entities[0], rows = item.attributes.scoped_customer_updates as Record<string, unknown>[];
    input.text = "Training sessions, lobby 1 slots, 4 teams 1 slots each";
    rows[1].source_text = "4 teams 1 slots each"; rows[1].scope_count = 4;
    if (mode !== "old-text-new-goal" && mode !== "multiple-active-old-text-new-goal") {
      item.entity_ref = old.entity_id; frame.referents[0].ref = old.entity_id;
    }
    if (mode === "new-text-old-entity" || mode === "new-text-old-name-and-ref")
      input.text = "Festival catering, lobby 1 slots, 4 teams 1 slots each";
    if (mode === "new-text-old-name-and-ref" || mode === "unnamed-old-entity" ||
      mode === "old-text-foreign-ref" || mode === "old-text-extra-referent") item.name = "Training sessions";
    if (mode === "unnamed-old-entity") input.text = "lobby 1 slots, 4 teams 1 slots each";
    if (mode === "old-text-foreign-ref") {
      item.entity_ref = "foreign-item"; frame.referents[0].ref = "foreign-item";
    }
    if (mode === "old-text-extra-referent") frame.referents.push({
      ref: latestGoal.goal_id, source: "persistent_state", confidence: .99,
    });
    const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
    const result = await s.ask(input);
    assert(result?.route !== "contextual_scoped_update" && !result?.trusted_journey_progress &&
      s.live.writes === writes && s.live.revision === revision && JSON.stringify(s.live.state) === before,
      mode + ": " + JSON.stringify(result));
  });
}

Deno.test("P1 twin second-subject target positive: an explicitly named old item may receive its own sourced allocation", async () => {
  const s = storage(); await s.ask(scope()); const firstGoal = structuredClone(goal(s.live.state));
  await s.ask(allocate(firstGoal)); await s.ask(scope("different-current-goal", "Festival catering", 4));
  const old = s.live.state.entities[0], input = allocate(firstGoal, "explicit-old-target", "slots", old.entity_id);
  input.text = "Training sessions, lobby 2 slots, 2 teams 1 slots each";
  const rows = input.semantic_frame!.entities[0].attributes.scoped_customer_updates as Record<string, unknown>[];
  rows[0].source_text = "lobby 2 slots"; rows[0].value = 2;
  rows[1].source_text = "2 teams 1 slots each"; rows[1].scope_count = 2;
  const result = await s.ask(input);
  assert(result?.route === "contextual_scoped_update" && result.persist_result === "success" &&
    s.live.state.entities.length === 1 && s.live.state.entities[0].entity_id === old.entity_id &&
    s.live.state.entities[0].quantity === 4, JSON.stringify(result));
  assert(evaluateB2BeforeCommit(b2(s, input, result)).decision === "allow", "valid named old target lost its receipt");
  noTransaction(s.live.state);
});

Deno.test("P1 twin W11 switch: correction keeps unrelated scopes and an old goal cannot cross a new subject", async () => {
  const s = storage(); await s.ask(scope());
  const oldGoal = structuredClone(goal(s.live.state));
  const untouched = structuredClone((s.live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[1]);
  await s.ask(scope("correct-team-count", "Training sessions", 3, true));
  assert(JSON.stringify((s.live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[1]) ===
    JSON.stringify(untouched), "scoped correction rewrote unrelated lobby count");
  await s.ask(scope("new-topic", "Festival catering", 4));
  const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
  const denied = await s.ask(allocate(oldGoal, "old-topic-allocation"));
  assert(denied?.reason === "contextual_targeted_clarification" && s.live.writes === writes && s.live.revision === revision &&
    JSON.stringify(s.live.state) === before, "old subject allocation inherited the new subject context");
  noTransaction(s.live.state);
});

Deno.test("P1 twin compound start: multiple customer scope facts remain context until an actual allocation", async () => {
  const s = storage(); const input = scope("compound-source", "Community workshops", 2);
  const result = await s.ask(input), saved = goal(s.live.state);
  assert(result?.route === "product_guidance" && result.reply === null && result.persist_result === "success" &&
    s.live.state.entities.length === 0, JSON.stringify(result));
  const facts = s.live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[];
  assert(saved.subject_label === "Community workshops" && facts.length === 2 &&
    facts.every(fact => fact.source_message_id === input.source_message_id && fact.recorded_revision === s.live.revision),
    "compound context lost its source or invented a quantity");
  const m = memory(s);
  assert(m.current_customer_facts.some(fact => fact.key === "contextual_scope_counts"), "compound facts absent from canonical Memory");
  noTransaction(s.live.state);
});

Deno.test("P1 twin natural dialogue subset: historical calculation is read-only and explicit human request is recognized", async () => {
  const s = storage(); await s.ask(scope()); await s.ask(allocate(goal(s.live.state)));
  const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
  const result = await s.ask({ ...owner, source_message_id: "historical-calculation", language: "en",
    text: "Using only my assumed old price of HK$4,750 per session, calculate three sessions plus HK$960. This is not a current quote." });
  assert(result?.calculation?.result === 15210 && result.persist_result === "read_only" &&
    s.live.writes === writes && s.live.revision === revision && JSON.stringify(s.live.state) === before,
    JSON.stringify(result));
  assert(classifyHandoffIntent("我想轉真人客服接手，請同事睇返呢段對話。").explicit_request,
    "explicit human request became another requirement questionnaire");
  noTransaction(s.live.state);
});

for (const [id, text, status] of [
  ["missing-basis", "Using my old price HK$4,750 plus HK$960, calculate three sessions.", "missing_explicit_basis"],
  ["mixed-currency", "Using my old price USD 100 per session plus HKD 960, calculate three sessions.", "mixed_currency"],
] as const) {
  Deno.test(`P1 twin historical negative ${id}: unproved arithmetic stays read-only without an answer`, async () => {
    const s = storage(); await s.ask(scope()); await s.ask(allocate(goal(s.live.state)));
    const typed = deriveTypedCustomerCalculation({ question: text, current_source_message_id: "invalid-arithmetic" });
    assert(typed.status === status, JSON.stringify(typed));
    const before = JSON.stringify(s.live.state), revision = s.live.revision, writes = s.live.writes;
    const result = await s.ask({ ...owner, source_message_id: "invalid-arithmetic", text, language: "en" });
    assert(result?.persist_result === "read_only" && !result.calculation && result.reply === null &&
      s.live.writes === writes && s.live.revision === revision && JSON.stringify(s.live.state) === before,
      JSON.stringify(result));
  });
}
Deno.test("P1 twin historical negative current-price and transaction requests are not arithmetic authorization", () => {
  for (const text of ["What is the current price of COURSE-X91?",
    "Using an old price of HKD100 per session, calculate three sessions and place an order."]) {
    assert(!isHistoricalOrConditionalCustomerCalculationRequest(text) &&
      deriveTypedCustomerCalculation({ question: text }).status === "not_requested", "calculation swallowed current fact or transaction");
  }
});
