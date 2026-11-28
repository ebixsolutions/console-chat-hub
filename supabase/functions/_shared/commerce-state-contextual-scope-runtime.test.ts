import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { loadCommerceState, persistCommerceTurn, runCommerceStateRuntime,
  type CommerceRuntimeInput, type CommerceStateDbClient, type CommerceStateQueryResult } from "./commerce-state-runtime-base.ts";
import { normalizeCommerceSemanticFrame, type CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { SourceBoundContextualGoal, SourceBoundScopeFact, ScopedCustomerValue } from "./contextual-customer-update.ts";
import { evaluateB2BeforeCommit } from "./pre-send-conversion-supervisor.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const owner = { company_id: "company-a", conversation_id: "ticket-a" };
function baseFrame(): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language: "en", operation: "UPDATE_ITEM",
    intent: "customer_guidance", topic: "Training sessions", entities: [], referents: [],
    requested_facts: [], customer_correction: false, additive: false, explicit_negations: [],
    transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.99 };
}
function scopeTurn(source = "source-t1", subject = "Training sessions", count = 2,
  correction = false): CommerceRuntimeInput {
  const text = `${subject} for ${count} teams and 1 lobby. Please offer general planning advice.`;
  const semantic = baseFrame(); semantic.topic = subject; semantic.customer_correction = correction;
  semantic.customer_facts = [{ key: "contextual_scope_counts", value: [
    { scope: "teams", count, source_text: `${count} teams`, subject_label: subject },
    { scope: "lobby", count: 1, source_text: "1 lobby", subject_label: subject },
  ] }];
  semantic.demands = [{ question: text, source_quote: text, subject_refs: [subject], source_type: "general",
    requested_facts: [], constraints: {}, customer_correction: correction, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  const frame = normalizeCommerceSemanticFrame(semantic);
  assert(frame, "Scope producer payload must normalize under the canonical typed contract");
  return { ...owner, source_message_id: source, language: "en", text, semantic_frame: frame };
}
function allocation(goal: SourceBoundContextualGoal, source = "source-t2", entityRef?: string): CommerceRuntimeInput {
  const semantic = baseFrame(); semantic.intent = "scoped allocation"; semantic.topic = goal.subject_label;
  semantic.entities = [{ entity_ref: entityRef ?? goal.goal_id, name: goal.subject_label,
    kind: "service", category_hint: goal.subject_label, model: null, sku: null, quantity: null, unit: "slots",
    attributes: { scoped_customer_updates: [
      { scope: "lobby", source_text: "lobby 1 slots", unit: "slots", value: 1, attribute: "quantity", action: "set" },
      { scope: "teams", source_text: "teams 2 slots each", unit: "slots", value: 2, per_scope_quantity: 2,
        scope_count: null, attribute: "quantity", action: "set" },
    ] }, constraints: {}, capabilities: { requires_delivery: false, supports_pickup: false,
      requires_installation: false, requires_booking: false, requires_quote: false, requires_site_check: false,
      digital_fulfilment: false, recurring_billing: false, rental_return: false, customization: false }, confidence: 0.99 }];
  semantic.referents = [{ ref: entityRef ?? goal.goal_id, source: "persistent_state", confidence: 0.99 }];
  const frame = normalizeCommerceSemanticFrame(semantic);
  assert(frame, "Allocation producer payload must normalize under the canonical typed contract");
  return { ...owner, source_message_id: source, text: "lobby 1 slots, teams 2 slots each",
    language: "en", semantic_frame: frame };
}

/** Native reducer/runtime contract harness. This is neither Hosted nor Auth/RLS evidence. */
function storage() {
  const live = { state: createEmptyConversationCommerceState(), revision: 0, writes: 0,
    company_id: owner.company_id, conversation_id: owner.conversation_id,
    seen: new Set<string>(), calls: [] as Record<string, unknown>[],
    intercept: null as ((params: Record<string, unknown>) => CommerceStateQueryResult | null) | null };
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: live.revision === 0 ? null : { company_id: live.company_id, conversation_id: live.conversation_id,
        revision: live.revision, state: structuredClone(live.state) }, error: null,
    }) }) }) }),
    rpc: async (_name, params) => {
      live.writes++; live.calls.push(structuredClone(params));
      const intercepted = live.intercept?.(params); if (intercepted) return intercepted;
      if (params.p_company_id !== live.company_id || params.p_conversation_id !== live.conversation_id)
        return { data: { result: "scope_mismatch" }, error: null };
      if (params.p_expected_revision !== live.revision) return { data: { result: "revision_conflict" }, error: null };
      const source = String(params.p_source_message_id);
      if (live.seen.has(source)) return { data: { result: "source_message_already_applied", applied_revision: live.revision }, error: null };
      live.state = structuredClone(params.p_state as ConversationCommerceState);
      live.revision++; live.seen.add(source);
      return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  return { live, db };
}
function savedGoal(state: ConversationCommerceState): SourceBoundContextualGoal {
  return state.customer_constraints.contextual_goal as SourceBoundContextualGoal;
}

Deno.test("Task3C runtime stores background scope counts before allocating source-bound quantities", async () => {
  for (const subject of ["Training sessions", "Festival catering", "Equipment rental"]) {
    const { live, db } = storage();
    const first = await runCommerceStateRuntime(db, scopeTurn("source-t1", subject));
    assert(first?.route === "product_guidance" && first.reply === null && first.persist_result === "success", JSON.stringify(first));
    assert(live.revision === 1 && live.state.entities.length === 0, "A background scope count became a product quantity");
    const goal = savedGoal(live.state), facts = live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[];
    assert(goal.subject_label === subject && goal.recorded_revision === 1 && goal.source_message_id === "source-t1", JSON.stringify(goal));
    assert(facts.length === 2 && facts.every(fact => fact.company_id === owner.company_id &&
      fact.conversation_id === owner.conversation_id && fact.recorded_revision === 1 && fact.source_message_id === "source-t1"), JSON.stringify(facts));
    const second = await runCommerceStateRuntime(db, allocation(goal));
    assert(second?.route === "contextual_scoped_update" && second.persist_result === "success" &&
      second.reply?.includes("teams 2 slots each") && second.reply.includes("Total 5 slots") && !second.reply.includes("#"), JSON.stringify(second));
    assert(Number(live.revision) === 2 && Number(live.state.entities.length) === 1 && live.state.entities[0].quantity === 5,
      JSON.stringify(live.state.entities));
    const rows = live.state.entities[0].attributes.scoped_customer_updates as ScopedCustomerValue[];
    assert(rows.length === 3 && rows.every(row => row.source_message_id === "source-t2" && row.source_revision === 2), JSON.stringify(rows));
    assert(rows.filter(row => row.scope.startsWith("teams#")).every(row =>
      row.scope_count_source?.source_message_id === "source-t1" && row.scope_count_source.source_revision === 1), JSON.stringify(rows));
    assert(live.state.conversion.order_status === "none" && live.state.conversion.payment_status === "none", "Allocation promoted a transaction");
  }
});

Deno.test("Task3C accepted scope readback supplies one exact receipt to metadata and unchanged B2", async () => {
  const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
  const input = allocation(savedGoal(live.state));
  const outcome = await runCommerceStateRuntime(db, input);
  const proof = outcome?.trusted_journey_progress;
  assert(outcome?.contextual_decision?.route === "contextual_scoped_update" &&
    proof?.update_kind === "contextual_scoped_update", JSON.stringify(outcome));
  const metadata = { response_route: outcome.route, commerce_reason: outcome.reason,
    commerce_authority: outcome.authority, commerce_state_revision: outcome.revision,
    commerce_state_persist_result: outcome.persist_result, commerce_state_persistence_classification: "COMMITTED",
    contextual_decision: outcome.contextual_decision };
  const evaluation = { proposed_response: outcome.reply ?? "", persistence_kind: "ai_reply" as const,
    snapshot: { ...owner, source_message_id: input.source_message_id, source_message_content: input.text,
      commerce_state_revision: live.revision, commerce_state_source_message_id: input.source_message_id,
      state: live.state }, metadata, trusted_journey_progress: proof };
  const allowed = evaluateB2BeforeCommit(evaluation);
  assert(allowed.decision === "allow" && allowed.code === "B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE",
    JSON.stringify(allowed));
  assert(JSON.stringify(metadata.contextual_decision.updates) === JSON.stringify(proof.accepted_updates) &&
    proof.accepted_updates.every(update => update.source_message_id === "source-t2" && update.source_revision === 2 &&
      proof.committed_updates.some(row => JSON.stringify(row) === JSON.stringify(update))),
    "Proposal and committed source rows diverged at the B2 handoff");
  const changedMetadata = structuredClone(metadata);
  delete changedMetadata.contextual_decision.updates[0].source_message_id;
  delete changedMetadata.contextual_decision.updates[0].source_revision;
  assert(evaluateB2BeforeCommit({ ...evaluation, metadata: changedMetadata }).decision !== "allow",
    "B2 accepted unbound proposal metadata in place of committed rows");
  const changedProof = structuredClone(proof);
  changedProof.accepted_updates[0].source_revision = 1;
  assert(evaluateB2BeforeCommit({ ...evaluation, trusted_journey_progress: changedProof }).decision !== "allow",
    "B2 accepted an altered source revision");
});

Deno.test("Task3C runtime keeps replay idempotent and preserves the original source revisions", async () => {
  const { live, db } = storage(); const firstInput = scopeTurn();
  await runCommerceStateRuntime(db, firstInput);
  const firstSnapshot = JSON.stringify(live.state);
  await runCommerceStateRuntime(db, firstInput);
  assert(live.writes === 1 && live.revision === 1 && JSON.stringify(live.state) === firstSnapshot,
    "First-turn replay rewrote the scope/source receipt");
  const secondInput = allocation(savedGoal(live.state));
  await runCommerceStateRuntime(db, secondInput);
  const secondSnapshot = JSON.stringify(live.state), writes = live.writes;
  const replay = await runCommerceStateRuntime(db, secondInput);
  assert(live.writes === writes && Number(live.revision) === 2 && JSON.stringify(live.state) === secondSnapshot, "Allocation replay mutated state");
  assert(replay?.route === "contextual_scoped_update" && replay.persist_result === "no_semantic_change", JSON.stringify(replay));
});

Deno.test("Task3C runtime corrections retain unrelated scopes and cannot borrow raw history", async () => {
  const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
  const lobby = structuredClone((live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[1]);
  await runCommerceStateRuntime(db, scopeTurn("source-correction", "Training sessions", 3, true));
  const facts = live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[];
  assert(facts[0].count === 3 && facts[0].source_message_id === "source-correction" && facts[0].recorded_revision === 2,
    JSON.stringify(facts));
  assert(JSON.stringify(facts[1]) === JSON.stringify(lobby), "Unchanged scope was relabelled with correction provenance");
  assert(live.state.entities.length === 0, "A corrected background count created a product");
  const next = await runCommerceStateRuntime(db, allocation(savedGoal(live.state)));
  assert(next?.reply?.includes("Total 7 slots") && live.state.entities[0].quantity === 7, JSON.stringify(next));

  const missing = storage(); await runCommerceStateRuntime(missing.db, scopeTurn());
  const input = allocation(savedGoal(missing.live.state));
  missing.live.state.customer_constraints.contextual_scope_facts = [];
  input.history = [{ id: "source-t1", role: "visitor", content: scopeTurn().text }];
  const before = JSON.stringify(missing.live.state), writes = missing.live.writes;
  const denied = await runCommerceStateRuntime(missing.db, input);
  assert(denied?.reason === "contextual_targeted_clarification" && missing.live.writes === writes &&
    JSON.stringify(missing.live.state) === before, "Raw history became a scope count receipt");
});

Deno.test("Task3C a full allocation after a scope-count correction replaces superseded members and totals", async () => {
  for (const count of [1, 3]) {
    const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
    const goal = savedGoal(live.state); await runCommerceStateRuntime(db, allocation(goal));
    const entityId = live.state.entities[0].entity_id;
    await runCommerceStateRuntime(db, scopeTurn("scope-count-correction", "Training sessions", count, true));
    assert(live.state.entities[0].quantity === 5, "Background scope count alone fabricated a product quantity");
    const current = allocation(goal, "redistribute", entityId);
    const result = await runCommerceStateRuntime(db, current);
    const rows = live.state.entities[0].attributes.scoped_customer_updates as ScopedCustomerValue[];
    assert(result?.route === "contextual_scoped_update" && result.reply?.includes(`Total ${1 + 2 * count} slots`) &&
      live.state.entities[0].quantity === 1 + 2 * count && rows.length === 1 + count &&
      rows.filter(row => row.scope.startsWith("teams#")).length === count,
      JSON.stringify({ result, rows, quantity: live.state.entities[0].quantity }));
    const before = JSON.stringify(live.state), writes = live.writes, revision = live.revision;
    const replay = await runCommerceStateRuntime(db, current);
    assert(replay?.persist_result === "no_semantic_change" && live.writes === writes && live.revision === revision &&
      JSON.stringify(live.state) === before, "Replacement replay changed original member provenance");
  }
});

Deno.test("Task3C a partial group replacement preserves unrelated source and does not reconfirm the total", async () => {
  const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
  const goal = savedGoal(live.state); await runCommerceStateRuntime(db, allocation(goal));
  const entityId = live.state.entities[0].entity_id;
  const lobby = structuredClone((live.state.entities[0].attributes.scoped_customer_updates as ScopedCustomerValue[])
    .find(row => row.scope === "lobby"));
  await runCommerceStateRuntime(db, scopeTurn("scope-count-correction", "Training sessions", 1, true));
  const partial = allocation(goal, "partial-redistribution", entityId);
  partial.text = "teams 2 slots each";
  (partial.semantic_frame!.entities[0].attributes.scoped_customer_updates as unknown[]).shift();
  const result = await runCommerceStateRuntime(db, partial);
  const rows = live.state.entities[0].attributes.scoped_customer_updates as ScopedCustomerValue[];
  assert(result?.route === "contextual_scoped_update" && result.reply?.includes("total") &&
    /not (?:been )?reconfirmed|unconfirmed|not recalculated/i.test(result.reply) &&
    !result.reply.includes("Total 3 slots") && live.state.entities[0].quantity === 5 && rows.length === 2,
    JSON.stringify({ result, rows, quantity: live.state.entities[0].quantity }));
  assert(JSON.stringify(rows.find(row => row.scope === "lobby")) === JSON.stringify(lobby),
    "Partial group replacement rebound an unrelated scope to the current source");
});

Deno.test("Task3C runtime refuses foreign, future, switched and inactive scope receipts", async () => {
  for (const change of ["company", "ticket", "future", "topic", "cancelled", "deferred", "invented-count"] as const) {
    const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
    const goal = savedGoal(live.state), input = allocation(goal);
    if (change === "company") goal.company_id = "company-b";
    if (change === "ticket") goal.conversation_id = "ticket-b";
    if (change === "future") (live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0].recorded_revision = 2;
    if (change === "topic") live.state.current_topic = "Festival catering";
    if (change === "cancelled" || change === "deferred") goal.status = change;
    if (change === "invented-count") {
      const rows = input.semantic_frame!.entities[0].attributes.scoped_customer_updates as Record<string, unknown>[];
      rows[1].scope_count = 2;
    }
    const before = JSON.stringify(live.state), writes = live.writes;
    const result = await runCommerceStateRuntime(db, input);
    assert(result?.reason === "contextual_targeted_clarification" && live.writes === writes &&
      JSON.stringify(live.state) === before, change + ": " + JSON.stringify(result));
  }
});

Deno.test("Task3C runtime verifies returned snapshot identity without weakening existing caller contracts", async () => {
  for (const field of ["company_id", "conversation_id"] as const) {
    const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
    live[field] = "foreign-owner";
    let denied = false;
    try { await loadCommerceState(db, owner.conversation_id, owner.company_id); }
    catch (error) { denied = error instanceof Error && error.message === "commerce_state_scope_mismatch"; }
    assert(denied, "Returned " + field + " mismatch was consumed");
  }
});

Deno.test("Task3C runtime commits goal cancellation and deferral without a phantom product", async () => {
  for (const action of ["CANCEL_ITEM", "DEFER"] as const) {
    const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
    const goal = savedGoal(live.state), semantic = baseFrame();
    semantic.operation = action; semantic.intent = "lifecycle";
    semantic.referents = [{ ref: goal.goal_id, source: "persistent_state", confidence: 0.99 }];
    const result = await runCommerceStateRuntime(db, { ...owner, source_message_id: "source-lifecycle",
      language: "en", text: (action === "DEFER" ? "Pause " : "Cancel ") + goal.subject_label,
      semantic_frame: semantic });
    const stored = savedGoal(live.state);
    assert(result?.reason === "contextual_goal_lifecycle_committed" && result.reply === null &&
      stored.status === (action === "DEFER" ? "deferred" : "cancelled") &&
      stored.status_source_message_id === "source-lifecycle" && stored.status_recorded_revision === 2 &&
      live.state.entities.length === 0, JSON.stringify({ result, stored }));
    const writes = live.writes;
    const denied = await runCommerceStateRuntime(db, allocation(goal));
    assert(denied?.reason === "contextual_targeted_clarification" && live.writes === writes, JSON.stringify(denied));
  }
});

Deno.test("Task3C materialized allocation retains the existing B2 lifecycle boundary", async () => {
  for (const action of ["CANCEL_ITEM", "DEFER"] as const) {
    const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
    const goal = savedGoal(live.state); await runCommerceStateRuntime(db, allocation(goal));
    const entity = live.state.entities[0], semantic = baseFrame();
    semantic.operation = action; semantic.intent = "lifecycle";
    semantic.referents = [{ ref: entity.entity_id, source: "persistent_state", confidence: 0.99 }];
    const goalBefore = JSON.stringify(savedGoal(live.state));
    const result = await runCommerceStateRuntime(db, { ...owner, source_message_id: "source-item-lifecycle",
      language: "en", text: (action === "DEFER" ? "Pause " : "Cancel ") + goal.subject_label,
      semantic_frame: semantic });
    assert(result?.reason === "authoritative_scoped_lifecycle_applied" && result.trusted_lifecycle_commit &&
      live.state.entities[0].status === (action === "DEFER" ? "deferred" : "cancelled") &&
      live.state.entities[0].quantity === 5 && JSON.stringify(savedGoal(live.state)) === goalBefore,
      JSON.stringify(result));
    const writes = live.writes;
    const denied = await runCommerceStateRuntime(db, allocation(goal, "attempt-reuse", entity.entity_id));
    assert(denied?.reason === "contextual_targeted_clarification" && live.writes === writes &&
      live.state.entities.length === 1, "Inactive item was recreated from an older active goal");
  }
});

Deno.test("Task3C source-quoted topic changes prevent inherited scope leakage and can start a new goal", async () => {
  const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
  const oldGoal = savedGoal(live.state), guidance = baseFrame();
  const text = "Festival catering: please give general planning guidance.";
  guidance.operation = "ASK_FACT"; guidance.topic = "Festival catering";
  guidance.demands = [{ question: text, source_quote: text, subject_refs: ["Festival catering"],
    source_type: "general", requested_facts: [], constraints: {}, customer_correction: false,
    explicit_negations: [], ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  await runCommerceStateRuntime(db, { ...owner, source_message_id: "switch-topic", language: "en", text,
    semantic_frame: guidance });
  assert(live.state.current_topic === "Festival catering", "New literal subject did not change canonical focus");
  const writes = live.writes;
  const denied = await runCommerceStateRuntime(db, allocation(oldGoal));
  assert(denied?.reason === "contextual_targeted_clarification" && live.writes === writes,
    "Implicit allocation reused the old subject after a topic change");
  await runCommerceStateRuntime(db, scopeTurn("new-subject-scope", "Festival catering", 3));
  const nextGoal = savedGoal(live.state);
  assert(nextGoal.goal_id !== oldGoal.goal_id && nextGoal.subject_label === "Festival catering", JSON.stringify(nextGoal));
  const next = await runCommerceStateRuntime(db, allocation(nextGoal, "new-subject-allocation"));
  assert(next?.reply?.includes("Total 7 slots") && live.state.entities.length === 1 &&
    live.state.entities[0].attributes.product_name === "Festival catering", JSON.stringify(next));
});

Deno.test("Task3C runtime never acknowledges transport, CAS or invalid revision failures", async () => {
  for (const failure of ["transport", "conflict", "wrong-revision", "false-dedup"] as const) {
    const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
    const input = allocation(savedGoal(live.state)), before = JSON.stringify(live.state);
    live.intercept = () => failure === "transport" ? { data: null, error: { message: "unavailable" } }
      : { data: { result: failure === "conflict" ? "revision_conflict" : failure === "false-dedup"
        ? "source_message_already_applied" : "success", applied_revision: 90 }, error: null };
    const result = await runCommerceStateRuntime(db, input);
    assert(result?.reply === null && result.route !== "contextual_scoped_update" &&
      !result.trusted_journey_progress && JSON.stringify(live.state) === before,
      failure + ": " + JSON.stringify(result));
    if (failure === "conflict") assert(live.writes === 3, "CAS retry was not bounded to one retry");
  }
});

Deno.test("Task3C runtime recomputes allocation and reply from the winning CAS snapshot", async () => {
  const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
  const input = allocation(savedGoal(live.state)); let conflict = true;
  live.intercept = () => {
    if (!conflict) return null;
    conflict = false;
    const fact = (live.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0];
    fact.count = 3; fact.source_text = "3 teams"; fact.source_message_id = "concurrent-correction";
    fact.source_message_text = "Training sessions for 3 teams; keep the other requirements.";
    fact.recorded_revision = 2; live.revision = 2;
    return { data: { result: "revision_conflict" }, error: null };
  };
  const result = await runCommerceStateRuntime(db, input);
  assert(live.revision === 3 && live.state.entities[0]?.quantity === 7 && result?.reply?.includes("Total 7 slots") &&
    !result.reply.includes("Total 5 slots") && result.trusted_journey_progress?.previous_revision === 2,
    JSON.stringify(result));
  assert(live.calls.map(call => call.p_expected_revision).join(",") === "0,1,2", "CAS did not use the reloaded revision");
});

Deno.test("Task3C runtime does not acknowledge a superseded target after a CAS retry", async () => {
  const { live, db } = storage(); await runCommerceStateRuntime(db, scopeTurn());
  const input = allocation(savedGoal(live.state)); let conflict = true;
  live.intercept = () => {
    if (!conflict) return null;
    conflict = false; live.state.current_topic = "Festival catering"; live.revision = 2;
    return { data: { result: "revision_conflict" }, error: null };
  };
  const result = await runCommerceStateRuntime(db, input);
  assert(result?.reason === "contextual_targeted_clarification" && result.route !== "contextual_scoped_update" &&
    live.revision === 2 && live.state.entities.length === 0 && live.writes === 2,
    JSON.stringify(result));
});

Deno.test("Task3C runtime blocks invalid reserved facts before the general semantic writer", async () => {
  for (const invalid of ["count", "quote", "operation", "reserved-receipt", "no-reading"] as const) {
    const { live, db } = storage(), input = scopeTurn();
    if (invalid === "no-reading") input.semantic_frame = null;
    else if (invalid === "operation") input.semantic_frame!.operation = "ASK_FACT";
    else if (invalid === "reserved-receipt") input.semantic_frame!.customer_facts![0].key = "contextual_goal";
    else {
      const rows = input.semantic_frame!.customer_facts![0].value as Record<string, unknown>[];
      if (invalid === "count") rows[0].count = 3; else rows[0].source_text = "three teams";
    }
    const result = await persistCommerceTurn(db, input, []);
    // Existing no-reading language/audit persistence remains lawful; it must
    // not manufacture a goal, scope count or product quantity.
    assert((invalid === "no-reading" || live.writes === 0) && result.state.entities.length === 0 &&
      result.state.customer_constraints.contextual_scope_facts === undefined,
      invalid + ": " + JSON.stringify(result));
  }
});
