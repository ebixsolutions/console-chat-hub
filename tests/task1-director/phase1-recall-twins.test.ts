/**
 * Phase1 non-industry twins for five named legacy recall cases.
 * These exercise the actual native reducer/runtime/B2 with synthetic, explicitly
 * source-owned storage and Reading inputs. They are not Hosted/model/RLS proof.
 * Originals remain unchanged and blocking until their separate named decision.
 */
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceRuntimeInput, type CommerceStateDbClient } from "../../supabase/functions/_shared/commerce-state-runtime-base.ts";
import { prepareConversationRecall, type ConversationRecallInput } from "../../supabase/functions/_shared/conversation-recall.ts";
import { buildCanonicalConversationMemory } from "../../supabase/functions/_shared/conversation-long-memory.ts";
import { buildB2AuthoritativeReadbackProof, evaluateB2BeforeCommit, executeB2PersistenceGate } from "../../supabase/functions/_shared/pre-send-conversion-supervisor.ts";
import type { CommerceSemanticFrame } from "../../supabase/functions/_shared/commerce-semantic-frame.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const owner = { company_id: "twin-recall-company", conversation_id: "twin-recall-ticket" };
const capabilities = { requires_delivery: false, supports_pickup: false, requires_installation: false,
  requires_booking: false, requires_quote: false, requires_site_check: false, digital_fulfilment: false,
  recurring_billing: false, rental_return: false, customization: false };
function frame(operation: CommerceSemanticFrame["operation"] = "ASK_FACT", topic = "training-sessions"): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language: "en", operation,
    intent: "customer_fact_recall", topic, entities: [], referents: [], requested_facts: [],
    customer_correction: false, additive: false, explicit_negations: [], transaction_state: "none",
    payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.99 };
}
function demand(text: string, subject: string, facts: string[] = []) {
  return { question: text, source_quote: text, subject_refs: [subject], source_type: "general" as const,
    requested_facts: facts, constraints: {}, customer_correction: false, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } };
}
function entity(id: string, name: string, quantity: number, category = "training-sessions") {
  return { entity_id: id, category, quantity, status: "tentative" as const,
    attributes: { product_name: name, unit: "sessions", quantity_basis: "customer_explicit" },
    constraints: {}, provenance: { source_type: "customer" as const, source_message_id: `prior-${id}` } };
}
function state() {
  const s = createEmptyConversationCommerceState(); s.language = "en";
  s.entities = [entity("retained", "Atlas training sessions", 2), entity("paused", "Beta training sessions", 1)];
  s.conversion.tentative_entity_ids = s.entities.map(e => e.entity_id);
  return s;
}
function storage(initial: ConversationCommerceState, revision = 4) {
  const live = { state: structuredClone(initial), revision, writes: 0, seen: new Set<string>(),
    company_id: owner.company_id, conversation_id: owner.conversation_id, fail: false };
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      company_id: live.company_id, conversation_id: live.conversation_id, revision: live.revision,
      state: structuredClone(live.state) }, error: null }) }) }) }),
    rpc: async (_name, args) => {
      live.writes++;
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id,
        "Native writer received another owner");
      if (live.fail) return { data: null, error: { message: "synthetic storage failure" } };
      if (args.p_expected_revision !== live.revision) return { data: { result: "revision_conflict" }, error: null };
      const source = String(args.p_source_message_id);
      if (live.seen.has(source)) return { data: { result: "source_message_already_applied", applied_revision: live.revision }, error: null };
      live.state = structuredClone(args.p_state as ConversationCommerceState); live.revision++; live.seen.add(source);
      return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  return { live, db };
}
function turn(text: string, semantic_frame: CommerceSemanticFrame | null, source_message_id = "current-source"): CommerceRuntimeInput {
  return { ...owner, text, semantic_frame, source_message_id, language: "en" };
}
function lifecycle(s: ConversationCommerceState, operation: "CANCEL_ITEM" | "DEFER") {
  const e = s.entities[1], name = String(e.attributes.product_name);
  const reading = frame(operation, e.category); reading.intent = "customer_correction"; reading.customer_correction = true;
  reading.entities = [{ entity_ref: e.entity_id, name, kind: "service", category_hint: e.category,
    model: null, sku: null, quantity: null, unit: "sessions", attributes: {}, constraints: {},
    capabilities, confidence: 0.99 }];
  reading.referents = [{ ref: e.entity_id, source: "persistent_state", confidence: 0.99 }];
  const text = `${operation === "DEFER" ? "Pause" : "Cancel"} ${name}.`;
  reading.demands = [demand(text, e.entity_id)];
  return turn(text, reading, `lifecycle-${operation}`);
}
function recallInput(s: ConversationCommerceState, question: string, revision = 6): ConversationRecallInput {
  const source_message_id = "recap-source";
  const memory = buildCanonicalConversationMemory({ ...owner, source_message_id: "committed-source",
    commerce_state_revision: revision, commerce_state: s, newest_first: [], visitor_turn_count: 4,
    source_created_at: "2026-11-24T00:00:00Z", next_memory_revision: 1 });
  return { ...owner, source_message_id, question, memory,
    commerce: { ...owner, source_message_id: "committed-source", revision, state: s } };
}

Deno.test("Phase1 twin T006: background scope counts cannot become a session quantity or phantom product", async t => {
  const text = "Training sessions for 2 teams and 1 lobby. Please offer general planning advice.";
  for (const kind of ["accepted-reading", "missing-reading", "fabricated-source", "wrong-subject"] as const) {
    await t.step(kind, async () => {
      const reading = frame("UPDATE_ITEM", "Training sessions"); reading.intent = "customer_guidance";
      reading.customer_facts = [{ key: "contextual_scope_counts", value: [
        { scope: "teams", count: 2, source_text: "2 teams", subject_label: "Training sessions" },
        { scope: "lobby", count: 1, source_text: "1 lobby", subject_label: "Training sessions" },
      ] }];
      reading.demands = [demand(text, "Training sessions")];
      if (kind === "fabricated-source") reading.demands[0].source_quote = "The customer chose three sessions.";
      if (kind === "wrong-subject") reading.demands[0].subject_refs = ["Unmentioned service"];
      const { live, db } = storage(createEmptyConversationCommerceState());
      const outcome = await runCommerceStateRuntime(db, turn(text, kind === "missing-reading" ? null : reading, "scope-source"));
      assert(live.state.entities.length === 0, `${kind}: background scopes fabricated a product/count`);
      assert(live.state.conversion.order_status === "none" && live.state.conversion.payment_status === "none",
        `${kind}: advisory request fabricated a transaction`);
      if (kind === "accepted-reading") {
        assert(outcome?.route === "product_guidance" && live.state.customer_constraints.contextual_goal,
          `Accepted customer goal was discarded: ${JSON.stringify(outcome)}`);
      }
      const before = JSON.stringify(live.state), writes = live.writes, revision = live.revision;
      const query = frame(); query.requested_facts = ["current_quantity"];
      const read = await runCommerceStateRuntime(db, turn("How many sessions do I currently have?", query, "quantity-source"));
      assert(read?.authority !== "CONVERSATION_STATE" || !read.state_path,
        `${kind}: inferred a quantity from audience counts: ${JSON.stringify(read)}`);
      const recall = prepareConversationRecall({ ...owner, source_message_id: "quantity-source",
        question: "How many sessions do I currently have?", memory: null,
        commerce: { ...owner, source_message_id: "scope-source", revision, state: live.state } }, "en");
      assert(!recall.decision.handled && recall.decision.reason === "AMBIGUOUS" &&
        recall.decision.detail === "MISSING_QUANTITY", `${kind}: unknown quantity was answered: ${JSON.stringify(recall)}`);
      assert(live.writes === writes && live.revision === revision && JSON.stringify(live.state) === before,
        `${kind}: quantity query changed canonical state`);
    });
  }
});

Deno.test("Phase1 twin T016: resolved cancellation and deferral acknowledge the committed target and preserve its sibling", async t => {
  for (const operation of ["CANCEL_ITEM", "DEFER"] as const) await t.step(operation, async () => {
    const s = state(), sibling = JSON.stringify(s.entities[0]), { live, db } = storage(s);
    const input = lifecycle(s, operation), result = await runCommerceStateRuntime(db, input);
    assert(live.state.entities[1].status === (operation === "DEFER" ? "deferred" : "cancelled"), JSON.stringify(result));
    assert(JSON.stringify(live.state.entities[0]) === sibling && live.state.entities[0].quantity === 2,
      "Lifecycle changed the retained sibling quantity/provenance");
    assert(live.state.entities.length === s.entities.length &&
      JSON.stringify(live.state.entities.map(e => e.entity_id)) === JSON.stringify(s.entities.map(e => e.entity_id)),
      "Lifecycle created a semantic shadow or removed a canonical entity");
    const reply = result?.reply ?? "";
    assert(reply.trim().length > 0 && reply.includes("Beta training sessions") &&
      (operation === "DEFER" ? /\bpaused\b/u.test(reply) : /\bcancelled\b/u.test(reply)),
      `Committed lifecycle has no correct acknowledgement: ${JSON.stringify(result)}`);
    const retainedQuantity = `${live.state.entities[0].quantity} ${live.state.entities[0].attributes.unit}`;
    assert(reply.includes(retainedQuantity),
      `Lifecycle acknowledgement omitted the retained source-owned quantity ${retainedQuantity}: ${reply}`);
    assert(result?.route === "commerce_state_answer" && result.trusted_lifecycle_commit?.target_entity_ids.length === 1 &&
      result.trusted_lifecycle_commit.target_entity_ids[0] === "paused" && !/[?？]/u.test(reply),
      `Committed lifecycle was replaced by generic clarification: ${JSON.stringify(result)}`);
    assert(result.trusted_lifecycle_commit.reply === reply, "Lifecycle receipt detached from the delivered acknowledgement");
    const evaluated = evaluateB2BeforeCommit({ proposed_response: reply, persistence_kind: "ai_reply",
      snapshot: { ...owner, source_message_id: input.source_message_id, source_message_content: input.text,
        commerce_state_revision: live.revision, commerce_state_source_message_id: input.source_message_id, state: live.state },
      metadata: { response_route: result.route, commerce_reason: result.reason, commerce_authority: result.authority,
        commerce_state_revision: result.revision, commerce_state_persist_result: result.persist_result,
        commerce_state_persistence_classification: "COMMITTED" },
      trusted_lifecycle_commit: result.trusted_lifecycle_commit });
    assert(evaluated.decision === "allow", "Source-bound retained quantity failed B2: " + JSON.stringify(evaluated));
    const before = JSON.stringify(live.state), writes = live.writes, revision = live.revision;
    await runCommerceStateRuntime(db, input);
    assert(live.writes === writes && live.revision === revision && JSON.stringify(live.state) === before,
      "Lifecycle replay changed canonical state");
    assert(live.state.conversion.order_status === "none" && live.state.conversion.payment_status === "none",
      "Lifecycle acknowledged a transaction");
  });
  for (const kind of ["missing-reading", "unknown-target", "ambiguous", "failed-commit"] as const) await t.step(kind, async () => {
    const s = state(), { live, db } = storage(s), input = lifecycle(s, "CANCEL_ITEM");
    if (kind === "missing-reading") { input.semantic_frame = null; input.text = "Cancel those sessions."; }
    if (kind === "unknown-target") {
      input.semantic_frame!.entities[0].entity_ref = "unknown";
      input.semantic_frame!.entities[0].name = "Unmentioned sessions";
      input.semantic_frame!.referents[0].ref = "unknown";
      input.text = "Cancel those sessions.";
    }
    if (kind === "ambiguous") input.semantic_frame!.ambiguity.is_ambiguous = true;
    if (kind === "failed-commit") live.fail = true;
    const before = JSON.stringify(live.state), result = await runCommerceStateRuntime(db, input);
    assert(JSON.stringify(live.state) === before && !result?.trusted_lifecycle_commit,
      `${kind}: uncommitted lifecycle gained authority: ${JSON.stringify(result)}`);
  });
  await t.step("exact-literal-without-reading-compatibility", async () => {
    // The existing lexical path can bind a complete literal customer-owned
    // subject. Missing interpretation must not invent an unbound target.
    const s = state(), sibling = JSON.stringify(s.entities[0]), { live, db } = storage(s);
    const input = lifecycle(s, "CANCEL_ITEM"); input.semantic_frame = null;
    const result = await runCommerceStateRuntime(db, input);
    assert(live.state.entities[1].status === "cancelled" && JSON.stringify(live.state.entities[0]) === sibling &&
      result?.trusted_lifecycle_commit?.target_entity_ids.length === 1 &&
      result.trusted_lifecycle_commit.target_entity_ids[0] === "paused",
      "Existing complete literal lifecycle binding lost its scope");
  });
  for (const kind of ["missing-unit", "malformed-unit", "unconfirmed", "system-default", "zero-unconfirmed",
    "non-customer", "missing-source", "blank-source", "cancelled", "deferred", "superseded", "unrelated-scope",
    "unscoped-count", "unsafe-label"] as const) await t.step(`retained-count-negative-${kind}`, async () => {
    const s = state(), retained = s.entities[0];
    if (kind === "missing-unit") delete retained.attributes.unit;
    if (kind === "malformed-unit") retained.attributes.unit = "sessions; payment confirmed";
    if (kind === "unconfirmed") delete retained.attributes.quantity_basis;
    if (kind === "system-default") retained.attributes.quantity_basis = "system_default";
    if (kind === "zero-unconfirmed") { retained.quantity = 0; delete retained.attributes.quantity_basis; }
    if (kind === "non-customer") retained.provenance.source_type = "kb";
    if (kind === "missing-source") retained.provenance.source_message_id = null;
    if (kind === "blank-source") retained.provenance.source_message_id = "   ";
    if (kind === "cancelled" || kind === "deferred") retained.status = kind;
    if (kind === "superseded") (retained as { status: string }).status = "superseded";
    if (kind === "unrelated-scope") retained.category = "unrelated-request";
    if (kind === "unscoped-count") {
      retained.quantity = 0; delete retained.attributes.quantity_basis;
      s.customer_constraints.current_quantity = 95;
    }
    if (kind === "unsafe-label") retained.attributes.product_name = "contextual-item:internal-target";
    // Keep the seeded canonical lifecycle lists consistent; otherwise the
    // reducer's legitimate list reconciliation is a separate receipt failure.
    s.conversion.tentative_entity_ids = s.entities.filter(e => e.status === "tentative").map(e => e.entity_id);
    s.conversion.cancelled_entity_ids = s.entities.filter(e => e.status === "cancelled").map(e => e.entity_id);
    const before = JSON.stringify(retained), { live, db } = storage(s);
    const result = await runCommerceStateRuntime(db, lifecycle(s, "CANCEL_ITEM"));
    assert(result?.trusted_lifecycle_commit && live.state.entities[1].status === "cancelled" &&
      JSON.stringify(live.state.entities[0]) === before, kind + ": lifecycle control failed or changed the retained source");
    assert(!result.reply?.includes("Retained requirements:") && !result.reply?.includes("95"),
      kind + ": unproved retained quantity became an acknowledgement: " + JSON.stringify(result));
    assert(result.trusted_lifecycle_commit.reply === result.reply, kind + ": receipt/reply mismatch");
  });
  for (const kind of ["company", "ticket"] as const) await t.step(`retained-count-negative-foreign-${kind}`, async () => {
    const s = state(), { live, db } = storage(s), before = JSON.stringify(live.state);
    if (kind === "company") live.company_id = "foreign-company";
    else live.conversation_id = "foreign-ticket";
    let error = "";
    try { await runCommerceStateRuntime(db, lifecycle(s, "CANCEL_ITEM")); } catch (caught) { error = String(caught); }
    assert(error.includes("commerce_state_scope_mismatch") && live.writes === 0 &&
      JSON.stringify(live.state) === before, kind + ": foreign retained state reached acknowledgement");
  });
  await t.step("retained-count-positive-unlike-units-stay-separate", async () => {
    const s = state(), other = entity("other-retained", "Gamma training sessions", 7);
    other.attributes.unit = "passes"; s.entities.push(other);
    s.conversion.tentative_entity_ids.push(other.entity_id);
    const before = JSON.stringify([s.entities[0], other]), { live, db } = storage(s);
    const result = await runCommerceStateRuntime(db, lifecycle(s, "CANCEL_ITEM"));
    assert(result !== null && typeof result.reply === "string", "Lifecycle acknowledgement must contain a reply");
    assert(result?.reply?.includes("Atlas training sessions: 2 sessions") &&
      result.reply.includes("Gamma training sessions: 7 passes") && !/\b9\b|\btotal\b/iu.test(result.reply),
      "Unlike source units were lost or summed: " + JSON.stringify(result));
    assert(result.trusted_lifecycle_commit?.reply === result.reply &&
      JSON.stringify([live.state.entities[0], live.state.entities[2]]) === before,
      "Rendering retained requirements changed their quantities or provenance");
  });
});

Deno.test("Phase1 twin T17: latest source-bound correction and cancellation determine read-only quantity before B2", async () => {
  const s = state(); s.entities[0].quantity = 6; s.latest_corrections = ["Maybe 6 sessions, not final."];
  const { live, db } = storage(s);
  const correction = frame("SET_QUANTITY"); correction.customer_correction = true; correction.intent = "customer_correction";
  correction.entities = [{ entity_ref: "retained", name: "Atlas training sessions", kind: "service",
    category_hint: "training-sessions", model: null, sku: null, quantity: 2, unit: "sessions",
    attributes: {}, constraints: {}, capabilities, confidence: 0.99 }];
  correction.referents = [{ ref: "retained", source: "persistent_state", confidence: 0.99 }];
  const correctionText = "Change Atlas training sessions to 2 sessions.";
  correction.demands = [demand(correctionText, "retained")];
  const changed = await runCommerceStateRuntime(db, turn(correctionText, correction, "corrected-source"));
  assert(live.state.entities[0].quantity === 2 && live.state.entities[0].provenance.source_message_id === "corrected-source",
    `Latest correction did not replace old quantity: ${JSON.stringify(changed)}`);
  // The canonical ledger intentionally normalizes quantity corrections; the
  // exact Visitor source is retained by the entity provenance checked above.
  const latestCorrection = live.state.latest_corrections.at(-1) ?? "";
  assert(latestCorrection.includes("Atlas training sessions") && latestCorrection.includes("2 sessions") &&
    latestCorrection !== s.latest_corrections[0], "Latest accepted correction is absent: " + JSON.stringify(live.state.latest_corrections));
  await runCommerceStateRuntime(db, lifecycle(live.state, "CANCEL_ITEM"));
  assert(live.state.entities[1].status === "cancelled", "Inactive item still contributes to the active request");
  const before = JSON.stringify(live.state), writes = live.writes, revision = live.revision;
  const reading = frame(); reading.requested_facts = ["current_quantity"];
  reading.referents = [{ ref: "retained", source: "persistent_state", confidence: 0.99 }];
  const text = "How many Atlas training sessions do I currently have?";
  reading.demands = [demand(text, "retained", ["current_quantity"])];
  const result = await runCommerceStateRuntime(db, turn(text, reading, "query-source"));
  assert(result !== null && typeof result.reply === "string", "Current quantity readback must contain a reply");
  assert(result?.persist_result === "read_only" && result.state_path === "entities.0.quantity" && result.reply?.includes("2 sessions"),
    `Current quantity was replaced by tentative history: ${JSON.stringify(result)}`);
  const recalled = prepareConversationRecall({ ...owner, source_message_id: "query-source", question: text,
    memory: null, referents: [{ ref: "retained", source: "canonical_commerce", confidence: .99 }],
    commerce: { ...owner, source_message_id: "lifecycle-CANCEL_ITEM", revision, state: live.state } }, "en");
  assert(recalled.decision.handled && recalled.decision.value === 2 &&
    recalled.decision.state_path === "entities.0.quantity" && recalled.reply?.includes("2 sessions"),
    "Latest correction failed the original prepareConversationRecall surface: " + JSON.stringify(recalled));
  assert(live.writes === writes && live.revision === revision && JSON.stringify(live.state) === before,
    "Quantity recall changed count/status/source lineage");
  const metadata = { response_route: result.route, commerce_authority: result.authority,
    commerce_state_revision: result.revision, commerce_state_persist_result: result.persist_result,
    commerce_state_persistence_classification: "NO_SEMANTIC_CHANGE", commerce_reason: result.reason,
    commerce_state_path: result.state_path,
    commerce_state_readback_proof: buildB2AuthoritativeReadbackProof(live.state, result.state_path) };
  const evaluation = { proposed_response: result.reply, persistence_kind: "ai_reply" as const, metadata,
    snapshot: { ...owner, source_message_id: "query-source", commerce_state_revision: revision,
      commerce_state_source_message_id: "lifecycle-CANCEL_ITEM", state: live.state } };
  assert(evaluateB2BeforeCommit(evaluation).decision === "allow", "Bound current count rejected at original B2");
  const staleValue = evaluateB2BeforeCommit({ ...evaluation, proposed_response: "You currently have 6 sessions of Atlas training sessions." });
  assert(staleValue.decision !== "allow", "Superseded 6-session answer passed B2: " + JSON.stringify(staleValue));
  const client = { from(table: string) { return { select() { return this; }, eq() { return this; },
    async maybeSingle() { return { error: null, data: table === "conversations"
      ? { id: owner.conversation_id, company_id: owner.company_id }
      : table === "messages" ? { id: "query-source", conversation_id: owner.conversation_id, role: "visitor", content: text }
      : { company_id: owner.company_id, revision, source_message_id: "lifecycle-CANCEL_ITEM", state: live.state } }; },
  }; } };
  let commits = 0;
  const gateInput = { client, conversation_id: owner.conversation_id, source_message_id: "query-source",
    proposed_response: result.reply, persistence_kind: "ai_reply" as const, metadata,
    expected_commerce_state_revision: revision, commit: async () => { commits++; return { result: "success" }; } };
  const accepted = await executeB2PersistenceGate(gateInput);
  assert(accepted.committed && commits === 1, "Current readback failed commit-time B2: " + JSON.stringify(accepted));
  const wrongRevision = await executeB2PersistenceGate({ ...gateInput, expected_commerce_state_revision: revision - 1 });
  assert(!wrongRevision.committed && wrongRevision.decision.code === "EXPECTED_COMMERCE_REVISION_MISMATCH" && commits === 1,
    "Stale expected revision reached the B2 persistence callback");
  assert(live.state.conversion.order_status === "none" && live.state.conversion.payment_status === "none",
    "Corrected request fabricated order/payment confirmation");
});

Deno.test("Phase1 twin T27: dimension comparison uses its canonical target and rejects history-only limits", async t => {
  for (const variant of ["canonical-limit", "history-only", "wrong-subject", "missing-reading", "foreign-company", "foreign-ticket", "bad-revision"] as const) {
    await t.step(variant, async () => {
      const s = state(); s.entities[1].status = "cancelled";
      s.entities.push({ ...entity("display", "Portable exhibition frame", 1, "display-rental"),
        constraints: variant === "history-only" ? {} : { max_width_mm: 595 } });
      const { live, db } = storage(s, variant === "bad-revision" ? 0 : 21);
      if (variant === "foreign-company") live.company_id = "other-company";
      if (variant === "foreign-ticket") live.conversation_id = "other-ticket";
      const text = "Would Portable exhibition frame width 598mm fit?", reading = frame("ASK_FACT", "display-rental");
      reading.intent = "compare a product dimension against the current constraint";
      reading.requested_facts = ["width"];
      reading.referents = [{ ref: "display", source: "persistent_state", confidence: 0.99 }];
      reading.demands = [demand(text, "display", ["width"])];
      if (variant === "wrong-subject") reading.demands[0].subject_refs = ["retained"];
      const input = turn(text, variant === "missing-reading" ? null : reading, "dimension-query");
      input.history = [{ role: "visitor", content: "My earlier width limit was 595mm." }];
      const before = JSON.stringify(live.state); let error = "", result;
      try { result = await runCommerceStateRuntime(db, input); } catch (caught) { error = String(caught); }
      assert(live.writes === 0 && JSON.stringify(live.state) === before && live.revision === (variant === "bad-revision" ? 0 : 21),
        `${variant}: dimension query changed canonical state`);
      if (variant === "canonical-limit") {
        assert(result != null && typeof result.reply === "string", "Canonical dimension comparison must contain a reply");
        assert(!error && result?.reason === "read_only_attribute_constraint_query_resolved" &&
          result.route === "commerce_state_answer" && result.persist_result === "read_only" && result.revision === 21 &&
          result.state_path === "entities.2.constraints.max_width_mm" && result.reply?.includes("598") && result.reply.includes("595"),
          JSON.stringify({ result, error }));
        assert(!result.reply.includes("Atlas") && !result.reply.includes("Beta"), "Unrelated quantities leaked into dimension answer");
      } else if (variant.startsWith("foreign-")) assert(error.includes("commerce_state_scope_mismatch"), "Foreign snapshot was read");
      else assert(!error && result?.reason !== "read_only_attribute_constraint_query_resolved" && !result?.state_path,
        `${variant}: unavailable comparison was asserted: ${JSON.stringify(result)}`);
    });
  }
});

Deno.test("Phase1 twin recap partition: named scope and global recap retain inactive items without cross-entity leakage", async t => {
  for (const status of ["deferred", "cancelled"] as const) await t.step(status, () => {
    const s = state(); s.entities[0].model = "AT-731"; s.entities[1].model = "BT-864";
    s.entities[1].status = status; s.entities[1].constraints.max_width_mm = 617;
    const input = recallInput(s, "Recap Atlas training sessions."); input.recent_questions = ["Tell me about Beta training sessions"];
    const before = JSON.stringify(input);
    for (const question of ["Recap Atlas training sessions.", "整理返 Atlas training sessions。"] ) {
      const answer = prepareConversationRecall({ ...input, question }, "en");
      assert(answer.decision.handled && answer.reply?.includes("AT-731") && !answer.reply.includes("BT-864") && !answer.reply.includes("617"),
        JSON.stringify(answer));
      const value = answer.decision.value as { entity_details: Array<{ entity_id: string }>; transaction: unknown };
      assert(value.entity_details.length === 1 && value.entity_details[0].entity_id === "retained" && value.transaction === null,
        "Scoped recap leaked another entity or transaction");
    }
    for (const question of ["What do I currently have noted?", "Give me a recap of everything.", "而家我有咩記低？"]) {
      const answer = prepareConversationRecall({ ...input, question }, "en");
      assert(answer.decision.handled && answer.reply?.includes("AT-731") && answer.reply.includes("BT-864") &&
        answer.reply.includes(status === "deferred" ? "paused" : "cancelled"), JSON.stringify(answer));
      assert((answer.decision.value as { selection_provenance: string }).selection_provenance === "global", "Global recap borrowed last entity scope");
    }
    assert(JSON.stringify(input) === before, "Recap mutated state/memory/source");
    const ambiguous = structuredClone(s); ambiguous.entities.push({ ...structuredClone(s.entities[0]), entity_id: "another-atlas" });
    const rejected = prepareConversationRecall(recallInput(ambiguous, "Recap Atlas training sessions."), "en");
    assert(!rejected.decision.handled && rejected.decision.reason === "AMBIGUOUS", "Ambiguous same-name subject silently selected one");
    const noModel = structuredClone(s); delete noModel.entities[0].model;
    const withoutModel = prepareConversationRecall(recallInput(noModel, "Recap Atlas training sessions."), "en");
    assert(withoutModel.decision.handled && !withoutModel.reply?.includes("AT-731"), "Missing model invented from another snapshot");
    delete noModel.entities[0].attributes.product_name;
    const nameless = recallInput(noModel, "Recap it.");
    nameless.referents = [{ ref: "retained", source: "canonical_commerce", confidence: .99 }];
    const withoutNameOrModel = prepareConversationRecall(nameless, "en");
    assert(withoutNameOrModel.decision.handled && withoutNameOrModel.reply?.includes("2 sessions") &&
      !/AT-731|BT-864|Atlas training sessions|Beta training sessions/u.test(withoutNameOrModel.reply),
      "Bound nameless recap invented another source's product/model: " + JSON.stringify(withoutNameOrModel));
    for (const kind of ["company", "ticket", "stale-memory"] as const) {
      const invalid = structuredClone(input);
      if (kind === "company") invalid.company_id = "other-company";
      if (kind === "ticket") invalid.conversation_id = "other-ticket";
      if (kind === "stale-memory") {
        assert(invalid.memory !== null && typeof invalid.memory.commerce_state_revision === "number",
          "Stale-memory negative requires an actual bound numeric revision");
        invalid.memory.commerce_state_revision--;
      }
      const denied = prepareConversationRecall(invalid, "en");
      assert(!denied.decision.handled, `${kind}: unbound recap was answered`);
    }
  });
});
