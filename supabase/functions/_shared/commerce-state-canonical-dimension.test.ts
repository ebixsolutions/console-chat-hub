import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceStateDbClient } from "./commerce-state-runtime-base.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function frame(topic: string): CommerceSemanticFrame {
  return {
    version: "commerce-semantic-1.0.0", language: "en", operation: "ASK_FACT",
    intent: "compare a product dimension against the current constraint", topic,
    entities: [], referents: [{ ref: "one 598mm item", source: "prior_turn", confidence: 0.94 }],
    requested_facts: ["width"], customer_correction: false, additive: false,
    explicit_negations: [], transaction_state: "none", payment_state: "none",
    booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.94,
  };
}

function snapshot(category: string): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.entities.push({
    entity_id: category + ":saved", category, quantity: 1, status: "researching",
    attributes: {}, constraints: { max_width_mm: 595 },
    provenance: { source_type: "customer", source_message_id: "earlier-customer-source" },
  });
  return state;
}

async function read(state: ConversationCommerceState, semantic: CommerceSemanticFrame | null,
  text = "Would one 598mm item fit?", revision = 12) {
  const before = JSON.stringify(state);
  let writes = 0;
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { company_id: "company-a", conversation_id: "ticket-a", revision, state }, error: null,
    }) }) }) }),
    rpc: async () => { writes++; return { data: { result: "success", applied_revision: 13 }, error: null }; },
  };
  const outcome = await runCommerceStateRuntime(db, {
    company_id: "company-a", conversation_id: "ticket-a", source_message_id: "current-customer-source",
    text, language: /[\p{Script=Han}]/u.test(text) ? "zh-TW" : "en", semantic_frame: semantic,
    history: [{ role: "visitor", content: "Previously I mentioned 1800mm height and 650mm depth." }],
  });
  assert(writes === 0, "Read-only canonical comparison called the writer");
  assert(JSON.stringify(state) === before, "Read-only canonical comparison changed the snapshot");
  return outcome;
}

Deno.test("Task3C canonical dimension lookup uses one exact stored category across industries", async () => {
  for (const category of ["packing-case", "event_display", "cabinet-rental"]) {
    const result = await read(snapshot(category), frame(category));
    assert(result?.state_path === "entities.0.constraints.max_width_mm", JSON.stringify(result));
    assert(result.reason === "read_only_attribute_constraint_query_resolved", JSON.stringify(result));
    assert(result.reply?.includes("598") && result.reply.includes("595"), JSON.stringify(result));
    assert(result.revision === 12 && result.persist_result === "read_only", JSON.stringify(result));
  }
});

Deno.test("Task3C original row 27 first canonical width subcase is independently reachable", async () => {
  const state = snapshot("refrigerator");
  state.entities.unshift({ entity_id: "air_conditioner:unscoped", category: "air_conditioner",
    quantity: 2, status: "researching", attributes: {}, constraints: {},
    provenance: { source_type: "customer", source_message_id: "other-source" } });
  const reading = frame("refrigerator");
  reading.language = "zh-TW";
  reading.referents = [{ ref: "一部598mm", source: "prior_turn", confidence: 0.94 }];
  const result = await read(state, reading, "雪櫃如果有一部598mm，我要唔要考慮？");
  assert(result?.state_path === "entities.1.constraints.max_width_mm", JSON.stringify(result));
  assert(result.reply?.includes("598") && result.reply.includes("595"), JSON.stringify(result));
});

Deno.test("Task3C canonical dimension lookup rejects missing, ambiguous and unowned facts", async () => {
  const cases: Array<{ state: ConversationCommerceState; semantic: CommerceSemanticFrame | null; label: string }> = [];
  const absent = snapshot("packing-case"); absent.entities[0].constraints = {};
  cases.push({ state: absent, semantic: frame("packing-case"), label: "missing canonical limit" });
  const competing = snapshot("packing-case"); competing.entities.push({ ...structuredClone(competing.entities[0]), entity_id: "second" });
  cases.push({ state: competing, semantic: frame("packing-case"), label: "two compatible subjects" });
  for (const status of ["cancelled", "deferred"] as const) {
    const state = snapshot("packing-case"); state.entities[0].status = status;
    cases.push({ state, semantic: frame("packing-case"), label: status });
  }
  const unowned = snapshot("packing-case"); unowned.entities[0].provenance.source_type = "system";
  cases.push({ state: unowned, semantic: frame("packing-case"), label: "non-customer owner" });
  const noSource = snapshot("packing-case"); noSource.entities[0].provenance.source_message_id = null;
  cases.push({ state: noSource, semantic: frame("packing-case"), label: "missing customer source" });
  const low = frame("packing-case"); low.confidence = 0.8;
  cases.push({ state: snapshot("packing-case"), semantic: low, label: "low confidence" });
  const ambiguous = frame("packing-case"); ambiguous.ambiguity.is_ambiguous = true;
  cases.push({ state: snapshot("packing-case"), semantic: ambiguous, label: "semantic ambiguity" });
  const height = frame("packing-case"); height.requested_facts = ["height"];
  cases.push({ state: snapshot("packing-case"), semantic: height, label: "width cannot answer height or raw history" });
  const otherRef = frame("packing-case"); otherRef.referents = [{ ref: "another-item", source: "persistent_state", confidence: 0.99 }];
  cases.push({ state: snapshot("packing-case"), semantic: otherRef, label: "conflicting persistent reference" });
  cases.push({ state: snapshot("packing-case"), semantic: frame("other-category"), label: "different category" });
  cases.push({ state: snapshot("packing-case"), semantic: null, label: "no interpretation cannot invent category" });
  for (const test of cases) {
    const result = await read(test.state, test.semantic);
    assert(result?.reason !== "read_only_attribute_constraint_query_resolved", test.label + ": " + JSON.stringify(result));
    assert(!result?.state_path, test.label + ": unexpectedly selected a canonical value");
  }
});

Deno.test("Task3C canonical dimension lookup refuses an independently named competing subject", async () => {
  const state = snapshot("packing-case");
  state.entities.push({ entity_id: "display", category: "event-display", quantity: 1, status: "researching",
    attributes: { product_name: "Portable display" }, constraints: { max_width_mm: 700 },
    provenance: { source_type: "customer", source_message_id: "display-source" } });
  const result = await read(state, frame("packing-case"), "Would Portable display width 598mm fit?");
  assert(result?.reason !== "read_only_attribute_constraint_query_resolved", JSON.stringify(result));
});

Deno.test("Task3C dimension lookup asks only for the missing limit on its verified canonical subject", async () => {
  const state = snapshot("packing-case");
  const reading = frame("packing-case");
  reading.requested_facts = ["height"];
  const result = await read(state, reading, "Would a height of 1820mm fit?");
  assert(result?.reason === "read_only_attribute_constraint_query_unresolved" && !result.state_path,
    JSON.stringify(result));
  assert(result.reply?.includes("packing-case") && result.reply.includes("height limit"),
    "Known subject was discarded instead of asking its missing limit: " + JSON.stringify(result));
  assert(!result.reply?.includes("1800") && !result.reply?.includes("595"),
    "Uncommitted history or another dimension supplied the missing limit");
});

Deno.test("Task3C dimension lookup rejects contradictory original-source demand evidence", async () => {
  const text = "Would one 598mm item fit?";
  for (const kind of ["valid", "invented quote", "different subject", "unmentioned subject",
    "ambiguous demand", "negated demand", "correction demand"] as const) {
    const state = snapshot("packing-case"), reading = frame("packing-case");
    state.entities.push({ entity_id: "other", category: "event-display", quantity: 1,
      status: "researching", attributes: {}, constraints: { max_width_mm: 700 },
      provenance: { source_type: "customer", source_message_id: "other-source" } });
    reading.demands = [{ question: text, source_quote: text, subject_refs: ["packing-case:saved"],
      source_type: "general", requested_facts: ["width"], constraints: {},
      customer_correction: false, explicit_negations: [],
      ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
    if (kind === "invented quote") reading.demands[0].source_quote = "The customer never said this.";
    if (kind === "different subject") reading.demands[0].subject_refs = ["other"];
    if (kind === "unmentioned subject") reading.demands[0].subject_refs = ["a missing subject"];
    if (kind === "ambiguous demand") reading.demands[0].ambiguity.is_ambiguous = true;
    if (kind === "negated demand") reading.demands[0].explicit_negations = ["packing-case"];
    if (kind === "correction demand") reading.demands[0].customer_correction = true;
    const result = await read(state, reading, text);
    if (kind === "valid") assert(result?.state_path === "entities.0.constraints.max_width_mm", JSON.stringify(result));
    else assert(result?.reason !== "read_only_attribute_constraint_query_resolved" && !result?.state_path,
      kind + ": " + JSON.stringify(result));
  }
});

Deno.test("Task3C dimension lookup cannot redirect a known prior-turn identity through a competing topic", async () => {
  const state = snapshot("packing-case");
  state.entities.push({ entity_id: "other", category: "event-display", quantity: 1,
    status: "researching", attributes: {}, constraints: { max_width_mm: 700 },
    provenance: { source_type: "customer", source_message_id: "other-source" } });
  const reading = frame("packing-case");
  reading.referents = [{ ref: "other", source: "prior_turn", confidence: 0.99 }];
  const result = await read(state, reading);
  assert(result?.reason !== "read_only_attribute_constraint_query_resolved" && !result?.state_path,
    JSON.stringify(result));
});

Deno.test("Task3C dimension lookup never binds a newly named subject by a quoted model echo", async () => {
  const text = "Would a portable gantry width 598mm fit?";
  const reading = frame("packing-case");
  reading.demands = [{ question: text, source_quote: text, subject_refs: ["portable gantry"],
    source_type: "general", requested_facts: ["width"], constraints: {},
    customer_correction: false, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  const result = await read(snapshot("packing-case"), reading, text);
  assert(result?.reason !== "read_only_attribute_constraint_query_resolved" && !result?.state_path,
    JSON.stringify(result));
});

Deno.test("Task3C dimension lookup applies frame exclusions before a literal trusted-reference shortcut", async () => {
  for (const kind of ["negated", "corrected", "additive", "ambiguous"] as const) {
    const state = snapshot("packing-case"), reading = frame("packing-case");
    state.entities[0].attributes.product_name = "Packing crate";
    reading.referents = [{ ref: "packing-case:saved", source: "persistent_state", confidence: 0.99 }];
    if (kind === "negated") reading.explicit_negations = ["packing-case"];
    if (kind === "corrected") reading.customer_correction = true;
    if (kind === "additive") reading.additive = true;
    if (kind === "ambiguous") reading.ambiguity.is_ambiguous = true;
    const result = await read(state, reading, "Would Packing crate width 598mm fit?");
    assert(result?.reason !== "read_only_attribute_constraint_query_resolved" && !result?.state_path,
      kind + ": " + JSON.stringify(result));
  }
});

Deno.test("Task3C dimension lookup requires a valid committed revision on every selector", async () => {
  for (const literal of [false, true]) for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const state = snapshot("packing-case"), reading = frame("packing-case");
    if (literal) {
      state.entities[0].attributes.product_name = "Packing crate";
      reading.referents = [{ ref: "packing-case:saved", source: "persistent_state", confidence: 0.99 }];
    }
    const result = await read(state, reading,
      literal ? "Would Packing crate width 598mm fit?" : "Would one 598mm item fit?", revision);
    assert(result?.reason !== "read_only_attribute_constraint_query_resolved" && !result?.state_path,
      JSON.stringify({ literal, revision, result }));
  }
});
