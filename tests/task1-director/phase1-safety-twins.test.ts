/**
 * Phase1 generic safety twins for four named legacy appliance callbacks.
 * Original tests remain unchanged and blocking. These native component tests
 * are not Hosted, Auth/RLS, real-provider, or full journey acceptance evidence.
 * Every adverse variant has its own Deno registration: a failing positive must
 * never hide an unexecuted negative behind the same callback's first assertion.
 */
import {
  createEmptyConversationCommerceState,
  type ConversationCommerceState,
} from "../../supabase/functions/_shared/commerce-state-contract.ts";
import {
  loadCommerceState,
  runCommerceStateRuntime,
  type CommerceRuntimeInput,
  type CommerceStateDbClient,
  type CommerceStateQueryResult,
} from "../../supabase/functions/_shared/commerce-state-runtime-base.ts";
import {
  normalizeCommerceSemanticFrame,
  type CommerceSemanticFrame,
} from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import type { SourceBoundContextualGoal } from "../../supabase/functions/_shared/contextual-customer-update.ts";
import {
  evaluateB2BeforeCommit,
  executeB2PersistenceGate,
  type B2DatabaseClient,
  type B2EvaluationInput,
} from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const owner = { company_id: "twin-company", conversation_id: "twin-ticket" };
const unchanged = (actual: unknown, expected: unknown, why: string) =>
  assert(JSON.stringify(actual) === JSON.stringify(expected), why);

function frame(operation: CommerceSemanticFrame["operation"] = "ASK_FACT", topic = "Training sessions"): CommerceSemanticFrame {
  return {
    version: "commerce-semantic-1.0.0", language: "en", operation, intent: "customer_guidance", topic,
    entities: [], referents: [], requested_facts: [], customer_correction: false, additive: false,
    explicit_negations: [], transaction_state: "none", payment_state: "none", booking_state: "none",
    fulfillment_state: "none", ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
    confidence: 0.99,
  };
}
function turn(text: string, semantic: CommerceSemanticFrame | null, source = "twin-source"): CommerceRuntimeInput {
  return { ...owner, text, semantic_frame: semantic, source_message_id: source, language: "en" };
}
function harness(initial = createEmptyConversationCommerceState(), revision = 0) {
  const live = {
    state: structuredClone(initial), revision, writes: 0, attempts: 0,
    company_id: owner.company_id, conversation_id: owner.conversation_id,
    sources: new Set<string>(),
    intercept: null as ((args: Record<string, unknown>) => CommerceStateQueryResult | null) | null,
  };
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: live.revision === 0 ? null : { company_id: live.company_id, conversation_id: live.conversation_id,
        revision: live.revision, state: structuredClone(live.state) }, error: null,
    }) }) }) }),
    rpc: async (_name, args) => {
      live.attempts++;
      const intercepted = live.intercept?.(args);
      if (intercepted) return intercepted;
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id,
        "runtime writer changed tenant or ticket");
      if (args.p_expected_revision !== live.revision)
        return { data: { result: "revision_conflict", current_revision: live.revision }, error: null };
      const source = String(args.p_source_message_id);
      if (live.sources.has(source))
        return { data: { result: "source_message_already_applied", applied_revision: live.revision }, error: null };
      live.state = structuredClone(args.p_state as ConversationCommerceState);
      live.revision++; live.writes++; live.sources.add(source);
      return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  return { live, db };
}
function noTransaction(state: ConversationCommerceState) {
  assert(state.quotes.length === 0 && state.conversion.order_status === "none" &&
    state.conversion.payment_status === "none" && state.conversion.quotation_status === "none",
    "customer facts promoted a transaction");
}

function scopeInput(): CommerceRuntimeInput {
  const text = "Training sessions for 2 teams and 1 lobby. Please offer general planning advice.";
  const semantic = frame("UPDATE_ITEM");
  semantic.customer_facts = [{ key: "contextual_scope_counts", value: [
    { scope: "teams", count: 2, source_text: "2 teams", subject_label: "Training sessions" },
    { scope: "lobby", count: 1, source_text: "1 lobby", subject_label: "Training sessions" },
  ] }];
  semantic.demands = [{ question: text, source_quote: text, subject_refs: ["Training sessions"],
    source_type: "general", requested_facts: [], constraints: {}, customer_correction: false,
    explicit_negations: [], ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  return turn(text, semantic, "twin-scope");
}
function allocationInput(goal: SourceBoundContextualGoal): CommerceRuntimeInput {
  const semantic = frame("UPDATE_ITEM"); semantic.intent = "scoped allocation";
  semantic.entities = [{ entity_ref: goal.goal_id, name: goal.subject_label, kind: "service",
    category_hint: goal.subject_label, model: null, sku: null, quantity: null, unit: "slots",
    attributes: { scoped_customer_updates: [
      { scope: "lobby", source_text: "lobby 1 slots", unit: "slots", value: 1, attribute: "quantity", action: "set" },
      { scope: "teams", source_text: "teams 2 slots each", unit: "slots", value: 2,
        per_scope_quantity: 2, scope_count: null, attribute: "quantity", action: "set" },
    ] }, constraints: {}, capabilities: { requires_delivery: false, supports_pickup: false,
      requires_installation: false, requires_booking: false, requires_quote: false, requires_site_check: false,
      digital_fulfilment: false, recurring_billing: false, rental_return: false, customization: false }, confidence: 0.99 }];
  semantic.referents = [{ ref: goal.goal_id, source: "persistent_state", confidence: 0.99 }];
  const normalized = normalizeCommerceSemanticFrame(semantic);
  assert(normalized, "generic allocation Reading did not satisfy the original typed contract");
  return turn("lobby 1 slots, teams 2 slots each", normalized, "twin-allocation");
}
async function acceptedJourney() {
  const h = harness();
  const first = await runCommerceStateRuntime(h.db, scopeInput());
  assert(first?.persist_result === "success" && h.live.state.entities.length === 0,
    "scope count became an invented product instead of a committed background fact");
  const goal = h.live.state.customer_constraints.contextual_goal as SourceBoundContextualGoal;
  const input = allocationInput(goal);
  const outcome = await runCommerceStateRuntime(h.db, input);
  assert(outcome?.trusted_journey_progress?.update_kind === "contextual_scoped_update" &&
    outcome.contextual_decision && outcome.reply && outcome.persist_result === "success",
    "generic accepted-update setup failed: " + JSON.stringify(outcome));
  const evaluation: B2EvaluationInput = {
    proposed_response: outcome.reply, persistence_kind: "ai_reply",
    snapshot: { ...owner, source_message_id: input.source_message_id, source_message_content: input.text,
      commerce_state_revision: h.live.revision, commerce_state_source_message_id: input.source_message_id,
      state: structuredClone(h.live.state) },
    metadata: { response_route: outcome.route, commerce_reason: outcome.reason,
      commerce_authority: outcome.authority, commerce_state_revision: outcome.revision,
      commerce_state_persist_result: outcome.persist_result, commerce_state_persistence_classification: "COMMITTED",
      contextual_decision: structuredClone(outcome.contextual_decision) },
    trusted_journey_progress: structuredClone(outcome.trusted_journey_progress),
  };
  return { ...h, input, outcome, evaluation };
}

Deno.test("P1TW-W13 positive: committed generic allocation carries bounded B2 authority", async () => {
  const h = await acceptedJourney();
  const result = evaluateB2BeforeCommit(h.evaluation);
  assert(result.decision === "allow" && result.code === "B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE", JSON.stringify(result));
  assert(h.live.revision === 2 && h.live.writes === 2 && h.live.state.entities.length === 1 &&
    h.live.state.entities[0].quantity === 5 && h.outcome.reply!.includes("Total 5 slots"), "committed quantity or source identity drift");
  noTransaction(h.live.state);
});

for (const variant of ["missing-receipt", "tenant", "revision", "entity", "replay", "source-text",
  "cancelled", "deferred", "transaction-drift", "accepted-source-revision", "known-quantity-reask",
  "known-product-reask", "fake-next-step", "superseded-value", "false-order", "false-payment"] as const) {
  Deno.test(`P1TW-W13 negative: ${variant}`, async () => {
    const h = await acceptedJourney(), e = h.evaluation, proof = e.trusted_journey_progress!;
    if (variant === "missing-receipt") e.trusted_journey_progress = null;
    if (variant === "tenant") proof.company_id = "foreign-company";
    if (variant === "revision") proof.committed_revision++;
    if (variant === "entity") { proof.entity_id = "unrelated-entity"; proof.category = "unrelated-service"; }
    if (variant === "replay") proof.source_message_id = "source-from-another-turn";
    if (variant === "source-text") proof.source_text = "another customer request";
    if (variant === "cancelled" || variant === "deferred") e.snapshot.state.entities[0].status = variant;
    if (variant === "transaction-drift") e.snapshot.state.conversion.order_status = "confirmed";
    if (variant === "accepted-source-revision") {
      assert(proof.update_kind === "contextual_scoped_update", "wrong receipt class");
      proof.accepted_updates[0].source_revision = 1;
    }
    if (variant === "known-quantity-reask" || variant === "fake-next-step") {
      e.proposed_response = "Next, please confirm the Training sessions quantity again?";
      e.trusted_journey_progress = null;
    }
    if (variant === "known-product-reask") {
      e.proposed_response = "Please confirm which product you mean again?";
      e.trusted_journey_progress = null;
    }
    if (variant === "superseded-value") {
      e.snapshot.state.latest_corrections = ["change from 5 slots to 7 slots"];
      e.proposed_response = "Your quantity is 5 slots."; e.trusted_journey_progress = null;
    }
    if (variant === "false-order") e.proposed_response = "Your order is confirmed.";
    if (variant === "false-payment") e.proposed_response = "Payment received.";
    const before = structuredClone(h.live.state), result = evaluateB2BeforeCommit(e);
    assert(result.decision !== "allow", variant + " acquired B2 authority: " + JSON.stringify(result));
    if (variant === "false-order") assert(result.code === "ORDER_CONFIRMATION_NOT_PROVEN", JSON.stringify(result));
    if (variant === "false-payment") assert(result.code === "PAYMENT_COMPLETION_NOT_PROVEN", JSON.stringify(result));
    if (variant === "superseded-value") assert(result.code === "SUPERSEDED_VALUE_REUSED", JSON.stringify(result));
    unchanged(h.live.state, before, "read-only B2 evaluation changed committed state");
  });
}

for (const variant of ["missing-reading", "fabricated-quote", "wrong-subject", "wrong-operation", "low-confidence"] as const) {
  Deno.test(`P1TW-W13 input negative: ${variant}`, async () => {
    const h = harness(); await runCommerceStateRuntime(h.db, scopeInput());
    // This new fixture has already established English. The original reducer
    // lawfully records language without a Reading; that audit write must not
    // be confused with committing the unverified business allocation below.
    h.live.state.language = "en";
    const input = allocationInput(h.live.state.customer_constraints.contextual_goal as SourceBoundContextualGoal);
    if (variant === "missing-reading") input.semantic_frame = null;
    else if (variant === "fabricated-quote")
      (input.semantic_frame!.entities[0].attributes.scoped_customer_updates as Record<string, unknown>[])[0].source_text = "invented source";
    else if (variant === "wrong-subject") input.semantic_frame!.referents[0].ref = "unknown-subject";
    else if (variant === "wrong-operation") input.semantic_frame!.operation = "ASK_FACT";
    else input.semantic_frame!.confidence = 0.3;
    const before = structuredClone(h.live.state), writes = h.live.writes;
    const result = await runCommerceStateRuntime(h.db, input);
    assert(h.live.writes === writes && !result?.trusted_journey_progress && result?.route !== "contextual_scoped_update",
      "invalid proposal committed: " + JSON.stringify({ result, before, after: h.live.state, writes: h.live.writes - writes }));
    unchanged(h.live.state, before, "invalid allocation changed state");
  });
}
for (const field of ["company_id", "conversation_id"] as const) {
  Deno.test(`P1TW-W13 input negative: foreign snapshot ${field}`, async () => {
    const h = harness(); await runCommerceStateRuntime(h.db, scopeInput()); h.live[field] = "foreign-owner";
    const before = structuredClone(h.live.state); let rejected = false;
    try { await loadCommerceState(h.db, owner.conversation_id, owner.company_id); }
    catch (error) { rejected = error instanceof Error && error.message === "commerce_state_scope_mismatch"; }
    assert(rejected && h.live.writes === 1, "foreign snapshot acquired authority");
    unchanged(h.live.state, before, "foreign snapshot rejection changed state");
  });
}
for (const failure of ["transport", "cas", "wrong-revision", "false-dedup"] as const) {
  Deno.test(`P1TW-W13 commit negative: ${failure}`, async () => {
    const h = harness(); await runCommerceStateRuntime(h.db, scopeInput());
    const input = allocationInput(h.live.state.customer_constraints.contextual_goal as SourceBoundContextualGoal);
    h.live.intercept = () => failure === "transport" ? { data: null, error: { message: "synthetic transport failure" } }
      : { data: { result: failure === "cas" ? "revision_conflict" : failure === "false-dedup" ? "source_message_already_applied" : "success",
        applied_revision: 90 }, error: null };
    const before = structuredClone(h.live.state), result = await runCommerceStateRuntime(h.db, input);
    assert(h.live.writes === 1 && !result?.trusted_journey_progress && !result?.reply && result?.route !== "contextual_scoped_update",
      "failed commit was acknowledged: " + JSON.stringify(result));
    unchanged(h.live.state, before, "failed commit changed canonical state");
  });
}

function lifecycleState() {
  const state = createEmptyConversationCommerceState(); state.current_topic = "training"; state.language = "en";
  state.entities = [
    { entity_id: "training:owned", category: "training", quantity: 3, status: "researching",
      attributes: { product_name: "Training sessions", unit: "sessions", quantity_basis: "customer_explicit" },
      constraints: { schedule: "Saturday" }, provenance: { source_type: "customer", source_message_id: "training-source" } },
    { entity_id: "display:owned", category: "display", quantity: 1, status: "tentative",
      attributes: { product_name: "Display stand", unit: "stands", quantity_basis: "customer_explicit" },
      constraints: { max_width_mm: 595, max_height_mm: 1800, max_depth_mm: 650 },
      provenance: { source_type: "customer", source_message_id: "display-source" } },
  ];
  // The fixture must obey the reducer's status-derived conversion invariant.
  // A researching entity is not a tentative entity.
  state.conversion.tentative_entity_ids = state.entities.filter(entity => entity.status === "tentative").map(entity => entity.entity_id);
  return state;
}
function lifecycleInput(text: string, operation: "DEFER" | "CANCEL_ITEM", ref?: string) {
  const semantic = frame(operation, ref?.startsWith("training") ? "training" : "display");
  semantic.intent = "lifecycle";
  semantic.referents = ref ? [{ ref, source: "persistent_state", confidence: 0.99 }] : [];
  return turn(text, semantic, "twin-lifecycle");
}
for (const mode of ["reading", "literal-no-reading"] as const) for (const variant of ["forward", "reverse", "both", "cancel"] as const) {
  Deno.test(`P1TW-W21 positive ${mode}: ${variant}`, async () => {
    const initial = lifecycleState(), h = harness(initial, 4);
    const input = variant === "forward" ? lifecycleInput("Pause Display stand; focus on Training sessions.", "DEFER", "display:owned")
      : variant === "reverse" ? lifecycleInput("Pause Training sessions; focus on Display stand.", "DEFER", "training:owned")
      : variant === "both" ? lifecycleInput("Pause both.", "DEFER")
      : lifecycleInput("Cancel Display stand.", "CANCEL_ITEM", "display:owned");
    if (variant === "both") input.semantic_frame!.referents = [
      { ref: "training:owned", source: "persistent_state", confidence: 0.99 },
      { ref: "display:owned", source: "persistent_state", confidence: 0.99 },
    ];
    if (mode === "literal-no-reading") input.semantic_frame = null;
    const result = await runCommerceStateRuntime(h.db, input), receipt = result?.trusted_lifecycle_commit;
    const targets = variant === "both" ? [0, 1] : [variant === "reverse" ? 0 : 1];
    assert(receipt && h.live.writes === 1 && h.live.revision === 5 && h.live.state.entities.length === 2 &&
      receipt.target_entity_ids.length === targets.length, JSON.stringify(result));
    for (let i = 0; i < 2; i++) {
      const entity = h.live.state.entities[i];
      if (targets.includes(i)) {
        assert(entity.status === (variant === "cancel" ? "cancelled" : "deferred") &&
          entity.provenance.source_message_id === input.source_message_id && receipt.target_entity_ids.includes(entity.entity_id), "wrong lifecycle target");
        assert(entity.quantity === initial.entities[i].quantity, "lifecycle invented quantity");
        unchanged(entity.attributes, initial.entities[i].attributes, "lifecycle changed unrelated attributes");
        unchanged(entity.constraints, initial.entities[i].constraints, "lifecycle changed constraints");
      } else unchanged(entity, initial.entities[i], "lifecycle changed retained sibling");
    }
    if (variant === "forward") assert(h.live.state.current_topic === "training", "wrong retained topic");
    if (variant === "reverse") assert(h.live.state.current_topic === "display", "wrong reversed topic");
    unchanged(receipt.transaction_before, receipt.transaction_after, "lifecycle crossed transaction boundary");
    noTransaction(h.live.state);
  });
}
for (const variant of ["ambiguous", "missing-reading", "weak-reading", "wrong-operation", "failed-commit", "deferred-return", "replay"] as const) {
  Deno.test(`P1TW-W21 negative: ${variant}`, async () => {
    const h = harness(lifecycleState(), 4);
    const input = lifecycleInput("Pause Display stand; focus on Training sessions.", "DEFER", "display:owned");
    if (variant === "ambiguous") { input.text = "Pause it."; input.semantic_frame!.ambiguity.is_ambiguous = true; }
    if (variant === "missing-reading") { input.text = "Pause it."; input.semantic_frame = null; }
    if (variant === "weak-reading") input.semantic_frame!.confidence = 0.4;
    if (variant === "wrong-operation") input.semantic_frame!.operation = "ASK_FACT";
    if (variant === "failed-commit") h.live.intercept = () => ({ data: null, error: { message: "synthetic failed CAS transport" } });
    if (variant === "deferred-return" || variant === "replay") {
      // Preserve the original source-named compatibility setup so a separate
      // Reading regression cannot prevent these independent negatives running.
      input.semantic_frame = null;
      const first = await runCommerceStateRuntime(h.db, input);
      assert(first?.trusted_lifecycle_commit && h.live.state.entities[1].status === "deferred", "defer setup failed");
      if (variant === "deferred-return") {
        input.text = "Return to Display stand."; input.source_message_id = "twin-return";
        input.semantic_frame = frame("ASK_FACT", "display");
      }
    }
    const before = structuredClone(h.live.state), writes = h.live.writes;
    const result = await runCommerceStateRuntime(h.db, input);
    assert(h.live.writes === writes && h.live.state.entities.length === 2,
      "negative lifecycle created a write or ghost: " + JSON.stringify({ result, before, after: h.live.state, writes: h.live.writes - writes }));
    unchanged(h.live.state, before, "rejected/replayed lifecycle changed state");
    if (variant !== "replay") assert(!result?.trusted_lifecycle_commit, "negative lifecycle supplied commit authority");
    if (variant === "failed-commit") assert(!result?.reply && result?.persist_result !== "success", "failed cancellation acknowledged");
    noTransaction(h.live.state);
  });
}

for (const variant of ["both-missing-refs", "both-one-ref", "both-wrong-ref", "focus-is-not-target", "extra-entity",
  "partial-group", "wrong-action", "forged-quote", "demand-subject", "negation", "transaction",
  "unknown-mixed-clause", "foreign-company", "foreign-ticket"] as const) {
  Deno.test(`P1TW-W21 compound negative: ${variant}`, async () => {
    const h = harness(lifecycleState(), 4);
    const input = lifecycleInput("Pause Display stand; focus on Training sessions.", "DEFER", "display:owned");
    const semantic = input.semantic_frame!;
    if (variant.startsWith("both-")) {
      input.text = "Pause both.";
      semantic.referents = [
        { ref: "training:owned", source: "persistent_state", confidence: 0.99 },
        { ref: "display:owned", source: "persistent_state", confidence: 0.99 },
      ];
      if (variant === "both-missing-refs") semantic.referents = [];
      if (variant === "both-one-ref") semantic.referents.pop();
      if (variant === "both-wrong-ref") semantic.referents[1].ref = "missing-entity";
    }
    if (variant === "focus-is-not-target") semantic.referents[0].ref = "training:owned";
    if (variant === "extra-entity") semantic.entities = [{
      entity_ref: "missing-entity", name: "Unmentioned studio rental", kind: "service", category_hint: "rental",
      model: null, sku: null, quantity: null, unit: null, attributes: {}, constraints: {}, confidence: 0.99,
      capabilities: { requires_delivery: false, supports_pickup: false, requires_installation: false,
        requires_booking: false, requires_quote: false, requires_site_check: false, digital_fulfilment: false,
        recurring_billing: false, rental_return: false, customization: false },
    }];
    if (variant === "partial-group") {
      input.text = "Pause one Training sessions; focus on Display stand.";
      semantic.referents[0].ref = "training:owned"; semantic.topic = "training";
    }
    if (variant === "wrong-action") semantic.operation = "CANCEL_ITEM";
    if (variant === "forged-quote" || variant === "demand-subject") semantic.demands = [{
      question: input.text, source_quote: variant === "forged-quote" ? "The customer never said this." : input.text,
      subject_refs: [variant === "demand-subject" ? "missing-entity" : "display:owned"], source_type: "general",
      requested_facts: [], constraints: {}, customer_correction: false, explicit_negations: [],
      ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
    }];
    if (variant === "negation") semantic.explicit_negations = ["display:owned"];
    if (variant === "transaction") semantic.transaction_state = "confirmed";
    if (variant === "unknown-mixed-clause") input.text += " Record a new booking.";
    if (variant === "foreign-company") h.live.company_id = "foreign-company";
    if (variant === "foreign-ticket") h.live.conversation_id = "foreign-ticket";
    const before = structuredClone(h.live.state);
    let result: Awaited<ReturnType<typeof runCommerceStateRuntime>> = null;
    let foreignRejected = false;
    try { result = await runCommerceStateRuntime(h.db, input); }
    catch (error) {
      if (variant === "foreign-company" || variant === "foreign-ticket")
        foreignRejected = error instanceof Error && error.message === "commerce_state_scope_mismatch";
      else throw error;
    }
    if (variant === "foreign-company" || variant === "foreign-ticket") assert(foreignRejected, "foreign compound snapshot accepted");
    assert(h.live.writes === 0 && !result?.trusted_lifecycle_commit && result?.persist_result !== "success",
      "invalid compound acquired mutation authority: " + JSON.stringify(result));
    unchanged(h.live.state, before, "invalid compound changed a target, focus or transaction");
  });
}

for (const variant of ["conditional-model-id", "reported-model-id", "partial-model-id", "negated-model-id",
  "whitespace-source", "conditional-both", "negated-both"] as const) {
  Deno.test(`P1TW-W21 source-clause negative: ${variant}`, async () => {
    const state = lifecycleState();
    state.entities[1].model = "DS-12";
    state.entities[1].attributes.product_name = "DS-12";
    if (variant === "partial-model-id") state.entities[1].quantity = 3;
    if (variant === "whitespace-source") state.entities[1].provenance.source_message_id = "   ";
    const text = variant === "conditional-model-id" ? "If needed pause DS-12; focus on Training sessions."
      : variant === "reported-model-id" ? 'The client said "Pause DS-12"; focus on Training sessions.'
      : variant === "partial-model-id" ? "Pause one DS-12; focus on Training sessions."
      : variant === "negated-model-id" ? "Do not pause DS-12; focus on Training sessions."
      : variant === "conditional-both" ? "If needed pause both."
      : variant === "negated-both" ? "Do not pause both."
      : "Pause DS-12; focus on Training sessions.";
    const input = lifecycleInput(text, "DEFER", "display:owned");
    if (variant.endsWith("both")) input.semantic_frame!.referents = [
      { ref: "training:owned", source: "persistent_state", confidence: 0.99 },
      { ref: "display:owned", source: "persistent_state", confidence: 0.99 },
    ];
    const h = harness(state, 4), before = structuredClone(h.live.state);
    const result = await runCommerceStateRuntime(h.db, input);
    assert(h.live.writes === 0 && !result?.trusted_lifecycle_commit && result?.persist_result !== "success",
      "identifier/collective bypass authorized an unsupported clause: " + JSON.stringify(result));
    unchanged(h.live.state, before, "unsupported source clause changed an entity or transaction");
  });
}

async function lifecycleB2Fixture(variant: "forward" | "reverse" | "both") {
  const h = harness(lifecycleState(), 4);
  const input = variant === "forward" ? lifecycleInput("Pause Display stand; focus on Training sessions.", "DEFER", "display:owned")
    : variant === "reverse" ? lifecycleInput("Pause Training sessions; focus on Display stand.", "DEFER", "training:owned")
    : lifecycleInput("Pause both.", "DEFER");
  if (variant === "both") input.semantic_frame!.referents = [
    { ref: "training:owned", source: "persistent_state", confidence: 0.99 },
    { ref: "display:owned", source: "persistent_state", confidence: 0.99 },
  ];
  const outcome = await runCommerceStateRuntime(h.db, input);
  assert(outcome?.trusted_lifecycle_commit && outcome.reply && outcome.persist_result === "success" &&
    h.live.writes === 1 && h.live.revision === 5, "actual lifecycle commit setup failed: " + JSON.stringify(outcome));
  const evaluation: B2EvaluationInput = {
    proposed_response: outcome.reply, persistence_kind: "ai_reply",
    snapshot: { ...owner, source_message_id: input.source_message_id, source_message_content: input.text,
      commerce_state_revision: h.live.revision, commerce_state_source_message_id: input.source_message_id,
      state: structuredClone(h.live.state) },
    metadata: { response_route: outcome.route, commerce_reason: outcome.reason,
      commerce_authority: outcome.authority, commerce_state_revision: outcome.revision,
      commerce_state_persist_result: outcome.persist_result, commerce_state_persistence_classification: "COMMITTED" },
    trusted_lifecycle_commit: structuredClone(outcome.trusted_lifecycle_commit),
  };
  return { ...h, input, outcome, evaluation };
}

// The real frozen gate performs both canonical reads and the final callback.
// This is a native adapter test, not production DB concurrency/RLS evidence.
async function runLifecycleB2(h: Awaited<ReturnType<typeof lifecycleB2Fixture>>, mode = "valid") {
  const e = h.evaluation;
  let stateReads = 0, commits = 0;
  const client: B2DatabaseClient = {
    from(table) {
      const filters: Record<string, string> = {};
      const query = {
        select: (_columns: string) => query,
        eq: (key: string, value: string) => { filters[key] = value; return query; },
        maybeSingle: async () => {
          if (table === "conversations") {
            assert(filters.id === owner.conversation_id, "B2 conversation lookup changed ticket");
            return { data: { id: owner.conversation_id, company_id: owner.company_id }, error: null };
          }
          if (table === "messages") {
            assert(filters.id === h.input.source_message_id && filters.conversation_id === owner.conversation_id,
              "B2 source lookup changed ticket or message");
            return { data: { id: h.input.source_message_id, conversation_id: owner.conversation_id,
              role: "visitor", content: h.input.text }, error: null };
          }
          assert(table === "conversation_commerce_state" && filters.conversation_id === owner.conversation_id &&
            filters.company_id === owner.company_id, "B2 state lookup changed owner or table");
          stateReads++;
          if (mode === "missing-state") return { data: null, error: null };
          return { data: { conversation_id: owner.conversation_id,
            company_id: mode === "tenant-drift" && stateReads > 1 ? "foreign-company" : owner.company_id,
            revision: mode === "stale-first-revision" ? h.live.revision - 1 :
              mode === "revision-drift" && stateReads > 1 ? h.live.revision + 1 : h.live.revision,
            source_message_id: mode === "source-drift" && stateReads > 1 ? "newer-source" : h.input.source_message_id,
            state: structuredClone(h.live.state) }, error: null };
        },
      };
      return query;
    },
  };
  const before = structuredClone(h.live.state);
  const result = await executeB2PersistenceGate({
    client, conversation_id: owner.conversation_id, source_message_id: h.input.source_message_id,
    proposed_response: e.proposed_response, persistence_kind: "ai_reply", metadata: e.metadata,
    trusted_lifecycle_commit: e.trusted_lifecycle_commit, expected_commerce_state_revision: h.live.revision,
    commit: async snapshot => {
      commits++;
      assert(snapshot.company_id === owner.company_id && snapshot.conversation_id === owner.conversation_id &&
        snapshot.source_message_id === h.input.source_message_id && snapshot.commerce_state_revision === h.live.revision &&
        snapshot.commerce_state_source_message_id === h.input.source_message_id,
        "B2 callback detached from current source, owner or revision");
      unchanged(snapshot.state, h.live.state, "B2 callback received a stale state");
      return { persisted_reply: e.proposed_response, source_message_id: snapshot.source_message_id };
    },
  });
  unchanged(h.live.state, before, "B2 evaluation/revalidation changed commerce state");
  return { result, stateReads, commits };
}

for (const variant of ["forward", "reverse", "both"] as const) {
  Deno.test(`P1TW-W21 B2 positive: ${variant} evaluates revalidates and commits once`, async () => {
    const h = await lifecycleB2Fixture(variant), evaluation = evaluateB2BeforeCommit(h.evaluation);
    assert(evaluation.decision === "allow" && evaluation.code === "B2_ALLOW_COMMITTED_SCOPED_LIFECYCLE", JSON.stringify(evaluation));
    const checked = await runLifecycleB2(h);
    assert(checked.result.committed && checked.commits === 1 && checked.stateReads === 2 &&
      checked.result.decision.code === "B2_ALLOW_COMMITTED_SCOPED_LIFECYCLE" &&
      checked.result.value?.persisted_reply === h.outcome.reply, JSON.stringify(checked));
  });
  for (const mode of ["missing-proof", "proof-source", "proof-tenant", "proof-revision", "reply", "failed-metadata",
    "missing-state", "stale-first-revision", "revision-drift", "source-drift", "tenant-drift"] as const) {
    Deno.test(`P1TW-W21 B2 negative: ${variant} ${mode}`, async () => {
      const h = await lifecycleB2Fixture(variant), e = h.evaluation;
      if (mode === "missing-proof") e.trusted_lifecycle_commit = null;
      if (mode === "proof-source") e.trusted_lifecycle_commit!.source_message_id = "other-source";
      if (mode === "proof-tenant") e.trusted_lifecycle_commit!.company_id = "foreign-company";
      if (mode === "proof-revision") e.trusted_lifecycle_commit!.committed_revision--;
      if (mode === "reply") e.proposed_response += " Your order is confirmed.";
      if (mode === "failed-metadata") e.metadata!.commerce_state_persist_result = "rpc_transport_error";
      const readbackMode = ["missing-state", "stale-first-revision", "revision-drift", "source-drift", "tenant-drift"].includes(mode);
      const decision = evaluateB2BeforeCommit(e);
      assert(readbackMode ? decision.decision === "allow" : decision.decision !== "allow",
        "wrong first evaluation before final readback: " + JSON.stringify(decision));
      const checked = await runLifecycleB2(h, mode);
      assert(!checked.result.committed && checked.commits === 0 && checked.result.decision.decision !== "allow",
        "invalid/stale lifecycle reached the persistence callback: " + JSON.stringify(checked));
      if (mode === "revision-drift" || mode === "source-drift") assert(checked.stateReads === 2 &&
        checked.result.decision.code === "COMMERCE_CONTEXT_CHANGED_BEFORE_COMMIT", JSON.stringify(checked));
      if (mode === "stale-first-revision" || mode === "missing-state") assert(checked.stateReads === 1 &&
        checked.result.decision.code === "EXPECTED_COMMERCE_REVISION_MISMATCH", JSON.stringify(checked));
      if (mode === "tenant-drift") assert(checked.stateReads === 2 &&
        checked.result.decision.code === "COMMERCE_STATE_COMPANY_MISMATCH", JSON.stringify(checked));
    });
  }
}

function dimensionFrame(attribute = "width", ref = "display:owned") {
  const semantic = frame("ASK_FACT", ref === "display:owned" ? "display" : "training");
  semantic.intent = "compare a product dimension against the current constraint";
  semantic.referents = [{ ref, source: "persistent_state", confidence: 0.99 }];
  semantic.requested_facts = [attribute];
  return semantic;
}
async function readOnly(state: ConversationCommerceState, input: CommerceRuntimeInput, options: {
  revision?: number; company_id?: string; conversation_id?: string;
} = {}) {
  const h = harness(state, options.revision ?? 12);
  h.live.company_id = options.company_id ?? owner.company_id;
  h.live.conversation_id = options.conversation_id ?? owner.conversation_id;
  const before = structuredClone(h.live.state);
  input.history = [{ id: "uncommitted-history", role: "visitor", content: "Display stand height 1800mm and depth 650mm." }];
  try {
    const result = await runCommerceStateRuntime(h.db, input);
    assert(result?.persist_result === "read_only", "read-only query did not return an explicit read-only outcome: " + JSON.stringify(result));
    return result;
  } finally {
    assert(h.live.writes === 0 && h.live.attempts === 0, "query called the writer");
    unchanged(h.live.state, before, "query changed canonical state or provenance");
  }
}

for (const [attribute, proposed, limit] of [["width", 598, 595], ["height", 1820, 1800], ["depth", 680, 650]] as const) {
  Deno.test(`P1TW-REFERENT positive: source-owned ${attribute} constraint`, async () => {
    const result = await readOnly(lifecycleState(), turn(`Would Display stand ${attribute} ${proposed}mm fit?`, dimensionFrame(attribute)));
    assert(result?.state_path === `entities.1.constraints.max_${attribute}_mm` &&
      result.reason === "read_only_attribute_constraint_query_resolved" && result.reply?.includes(String(limit)) &&
      result.reply.includes(String(proposed)) && !result.reply.includes("Training sessions"), JSON.stringify(result));
  });
}
Deno.test("P1TW-REFERENT positive: quantity topic switch and return preserve dimensions", async () => {
  const state = lifecycleState(), quantity = dimensionFrame("current_quantity", "training:owned");
  quantity.intent = "recall current quantity";
  const count = await readOnly(state, turn("How many Training sessions do I currently have?", quantity));
  assert(count?.state_path === "entities.0.quantity" && count.reply?.includes("3") && !count.reply.includes("Display stand"), JSON.stringify(count));
  for (const text of ["Back to Display stand: would width 598mm fit?", "Returning to Display stand, would width 598mm fit?"]) {
    const result = await readOnly(state, turn(text, dimensionFrame()));
    assert(result?.state_path === "entities.1.constraints.max_width_mm" && result.reply?.includes("595"), JSON.stringify(result));
  }
});
for (const variant of ["missing-reading", "wrong-subject", "ambiguous", "weak", "raw-history-only", "wrong-dimension",
  "cancelled", "deferred", "foreign-owner", "foreign-ticket", "invalid-revision", "forged-quote", "correction", "wrong-operation"] as const) {
  Deno.test(`P1TW-REFERENT negative: ${variant}`, async () => {
    const state = lifecycleState(), semantic = dimensionFrame("height"), input = turn("Would a height of 1820mm fit?", semantic);
    const options: { revision?: number; company_id?: string; conversation_id?: string } = {};
    if (variant === "missing-reading") input.semantic_frame = null;
    if (variant === "wrong-subject") semantic.referents[0].ref = "training:owned";
    if (variant === "ambiguous") semantic.ambiguity.is_ambiguous = true;
    if (variant === "weak") semantic.confidence = 0.4;
    if (variant === "raw-history-only" || variant === "wrong-dimension") delete state.entities[1].constraints.max_height_mm;
    if (variant === "cancelled" || variant === "deferred") state.entities[1].status = variant;
    if (variant === "foreign-owner") options.company_id = "foreign-company";
    if (variant === "foreign-ticket") options.conversation_id = "foreign-ticket";
    if (variant === "invalid-revision") options.revision = 1.5;
    if (variant === "forged-quote") semantic.demands = [{ question: input.text, source_quote: "fabricated source",
      subject_refs: ["display:owned"], source_type: "general", requested_facts: ["height"], constraints: {},
      customer_correction: false, explicit_negations: [], ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
    if (variant === "correction") semantic.customer_correction = true;
    if (variant === "wrong-operation") semantic.operation = "REMOVE_ITEM";
    if (variant === "foreign-owner" || variant === "foreign-ticket") {
      let rejected = false;
      try { await readOnly(state, input, options); }
      catch (error) { rejected = error instanceof Error && error.message === "commerce_state_scope_mismatch"; }
      assert(rejected, "foreign snapshot supplied dimension authority");
    } else {
      const result = await readOnly(state, input, options);
      assert(!result?.state_path && result?.reason !== "read_only_attribute_constraint_query_resolved",
        "invalid dimension evidence acquired an answer: " + JSON.stringify(result));
      assert(!result?.reply?.includes("1800") && !result?.reply?.includes("595"), "raw/other-dimension limit escaped");
    }
  });
}

function pendingState() {
  const state = lifecycleState();
  state.installation.pending_checks = ["shared site review"];
  state.installation.items = state.entities.map(entity => ({ item_id: `check-${entity.entity_id}`,
    kind: entity.entity_id === "training:owned" ? "training schedule review" : "display site review",
    entity_id: entity.entity_id, status: "pending", details: {},
    provenance: { source_type: "customer", source_message_id: "check-source-" + entity.entity_id } }));
  return state;
}
function pendingFrame(ref = "display:owned") {
  const semantic = frame("ASK_FACT", "installation"); semantic.intent = "read current pending checks";
  semantic.requested_facts = ["pending_checks"];
  semantic.referents = [{ ref, source: "persistent_state", confidence: 0.99 }];
  return semantic;
}
for (const variant of ["named", "deictic", "global", "zero", "replay"] as const) {
  Deno.test(`P1TW-PENDING positive: ${variant}`, async () => {
    const state = pendingState();
    if (variant === "zero") state.installation.items[1].status = "cancelled";
    const text = variant === "global" ? "How many checks are still pending?"
      : variant === "named" ? "For this Display stand, how many checks are still pending?"
      : "How many checks are still pending for this item?";
    const input = turn(text, pendingFrame()), result = await readOnly(state, input);
    if (variant === "global") {
      assert(result?.state_path === "installation.pending_checks" && result.reply?.includes("3") &&
        result.reply.includes("training schedule review") && result.reply.includes("display site review"), JSON.stringify(result));
    } else {
      assert(result?.state_path === "installation.items[entity_id=display:owned]" &&
        (variant === "zero" ? result.reply?.includes("no pending") : result.reply?.includes("1")) &&
        !result.reply?.includes("training schedule review"), JSON.stringify(result));
    }
    if (variant === "replay") {
      const again = await readOnly(state, input);
      unchanged(again, result, "same-source read replay changed answer or revision");
    }
  });
}
for (const variant of ["missing-reading", "unknown-reference", "conflicting-subject", "ambiguous", "weak", "inactive",
  "unowned", "missing-source", "unknown-binding", "foreign-owner", "foreign-ticket", "invalid-revision",
  "forged-quote", "wrong-operation", "correction", "negation"] as const) {
  Deno.test(`P1TW-PENDING negative: ${variant}`, async () => {
    const state = pendingState(), semantic = pendingFrame();
    const input = turn("How many checks are still pending for this item?", semantic);
    const options: { revision?: number; company_id?: string; conversation_id?: string } = {};
    if (variant === "missing-reading") input.semantic_frame = null;
    if (variant === "unknown-reference") semantic.referents[0].ref = "missing-subject";
    if (variant === "conflicting-subject") input.text = "For this Training sessions, how many checks are still pending?";
    if (variant === "ambiguous") semantic.ambiguity.is_ambiguous = true;
    if (variant === "weak") semantic.confidence = 0.4;
    if (variant === "inactive") state.entities[1].status = "deferred";
    if (variant === "unowned") state.entities[1].provenance.source_type = "system";
    if (variant === "missing-source") state.entities[1].provenance.source_message_id = null;
    if (variant === "unknown-binding") state.installation.items = [];
    if (variant === "foreign-owner") options.company_id = "foreign-company";
    if (variant === "foreign-ticket") options.conversation_id = "foreign-ticket";
    if (variant === "invalid-revision") options.revision = 1.5;
    if (variant === "forged-quote") semantic.demands = [{ question: input.text, source_quote: "model invented this",
      subject_refs: ["display:owned"], source_type: "general", requested_facts: ["pending_checks"], constraints: {},
      customer_correction: false, explicit_negations: [], ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
    if (variant === "wrong-operation") semantic.operation = "REMOVE_ITEM";
    if (variant === "correction") semantic.customer_correction = true;
    if (variant === "negation") semantic.explicit_negations = ["display:owned"];
    if (variant === "foreign-owner" || variant === "foreign-ticket") {
      let rejected = false;
      try { await readOnly(state, input, options); }
      catch (error) { rejected = error instanceof Error && error.message === "commerce_state_scope_mismatch"; }
      assert(rejected, "foreign pending metadata supplied authority");
    } else {
      const result = await readOnly(state, input, options);
      assert(result?.reason === "read_only_current_state_aggregate_query_unresolved" && !result.state_path &&
        result.authority === "INSUFFICIENT_INFORMATION", JSON.stringify(result));
      assert(!/training schedule review|display site review|shared site review/.test(result.reply ?? ""),
        "unbound scope leaked another subject's pending checks");
    }
  });
}
