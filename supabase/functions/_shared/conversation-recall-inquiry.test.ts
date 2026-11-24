import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { buildCanonicalConversationMemory } from "./conversation-long-memory.ts";
import { prepareConversationRecall, type ConversationRecallInput } from "./conversation-recall.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function inputFor(question: string, subject: string): ConversationRecallInput {
  const scope = { company_id: "inquiry-company", conversation_id: "inquiry-ticket" };
  const state = createEmptyConversationCommerceState();
  state.entities = [
    { entity_id: "course-item", category: "generic_service", model: "LM-741", quantity: 3,
      status: "researching", attributes: { product_name: "粵語課程" }, constraints: {},
      provenance: { source_type: "customer", source_message_id: "course-source" } },
    { entity_id: "other-item", category: "generic_product", model: "QP-293", quantity: 1,
      status: "deferred", attributes: { product_name: "餐點套餐" }, constraints: {},
      provenance: { source_type: "customer", source_message_id: "other-source" } },
  ];
  const memory = buildCanonicalConversationMemory({ ...scope, source_message_id: "committed-source",
    commerce_state_revision: 8, commerce_state: state, newest_first: [], visitor_turn_count: 2,
    source_created_at: "2026-11-24T04:00:00Z", next_memory_revision: 3 });
  return { ...scope, source_message_id: "current-inquiry", question, memory,
    commerce: { ...scope, source_message_id: "committed-source", revision: 8, state },
    trusted_visitor_source_status: "verified",
    trusted_visitor_source_rows: [{ id: "course-source", content: "我想報三堂粵語課程。" }],
    referents: [{ ref: "course-item", source: "persistent_state", confidence: 0.99 }],
    customer_recall_proposal: { ...scope, source_message_id: "current-inquiry",
      intent: "customer_fact_recall", requested_facts: ["summary"], subject_refs: [subject] },
  };
}

for (const [question, subject, language] of [
  ["What are my language course requirements?", "language course", "en"],
  ["而家我語言培訓要求係點？", "語言培訓", "zh-TW"],
] as const) {
  Deno.test("Task3C source-bound scoped recap inquiry: " + question, () => {
    const input = inputFor(question, subject), before = JSON.stringify(input);
    const answer = prepareConversationRecall(input, language);
    assert(answer.decision.handled && answer.decision.fact_type === "summary", JSON.stringify(answer));
    assert(answer.reply?.includes("LM-741") && !answer.reply.includes("QP-293"), JSON.stringify(answer));
    const value = answer.decision.value as { selection_provenance: string; transaction: unknown };
    assert(value.selection_provenance === "trusted_referent" && value.transaction === null, "scope expanded");
    assert(JSON.stringify(input) === before, "inquiry changed canonical state or stored a translated alias");
  });
}

Deno.test("Task3C scoped recap inquiry preserves source, tenant, revision and demand boundaries", () => {
  const question = "What are my language course requirements?";
  const mutations: Array<(input: ConversationRecallInput) => void> = [
    input => { input.referents = []; },
    input => { input.referents!.push({ ref: "other-item", source: "persistent_state", confidence: 0.99 }); },
    input => { input.trusted_visitor_source_rows = []; },
    input => { input.trusted_visitor_source_rows = [{ id: "course-source", content: "A different item." }]; },
    input => { input.company_id = "foreign-company"; },
    input => { input.conversation_id = "foreign-ticket"; },
    input => { input.memory!.commerce_state_revision = 7; },
    input => { input.customer_recall_proposal!.source_message_id = "other-inquiry"; },
    input => { input.customer_recall_proposal!.subject_refs = ["another subject"]; },
    input => { input.question = "What are my language course requirements and the current price?"; },
    input => { input.question = "Cancel the language course and recap it."; },
    input => { input.question = "What are my LM-999 requirements?"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input = inputFor(question, "language course");
    mutate(input);
    const before = JSON.stringify(input), answer = prepareConversationRecall(input, "en");
    assert(!answer.decision.handled, JSON.stringify({ index, answer }));
    assert(JSON.stringify(input) === before, "rejected inquiry changed state");
  }
  const global = inputFor("What are my current requirements?", "language course");
  const result = prepareConversationRecall(global, "en");
  assert(result.decision.handled && result.reply?.includes("LM-741") && result.reply.includes("QP-293"), JSON.stringify(result));
  assert((result.decision.value as { selection_provenance: string }).selection_provenance === "global", "accepted hint narrowed a global inquiry");
});

function quantityInput(source: string, question: string, name: string, unit: string, quantity = 3): ConversationRecallInput {
  const input = inputFor(question, name), state = input.commerce!.state;
  state.entities = [{ entity_id: "retained-item", category: "generic_product", quantity, status: "tentative",
    attributes: { product_name: name, unit }, constraints: {},
    provenance: { source_type: "customer", source_message_id: "quantity-source" } }];
  input.commerce!.source_message_id = "quantity-source";
  input.memory = buildCanonicalConversationMemory({ company_id: input.company_id, conversation_id: input.conversation_id,
    source_message_id: input.source_message_id, commerce_state_revision: input.commerce!.revision,
    commerce_state: state, newest_first: [], visitor_turn_count: 2,
    source_created_at: "2026-11-24T04:00:00Z", next_memory_revision: 3 });
  input.trusted_visitor_source_rows = [{ id: "quantity-source", content: source }];
  input.referents = [{ ref: "retained-item", source: "persistent_state", confidence: 0.99 }];
  delete input.customer_recall_proposal;
  return input;
}

for (const [name, unit, source, question] of [
  ["書枱", "張", "我要三張書枱。", "我之前提過要幾多張書枱？"],
  ["套餐", "份", "我想要三份套餐。", "我之前提過要幾多份套餐？"],
  ["英語課", "課", "我想報三課英語課。", "我之前提過要幾多課英語課？"],
  ["美容療程", "堂", "我想要三堂美容療程。", "我之前提過要幾多堂美容療程？"],
  ["licenses", "licenses", "We need three licenses for this team.", "How many licenses did I mention earlier?"],
] as const) {
  Deno.test("Task3C attested quantity preserves its canonical customer unit: " + unit, () => {
    const input = quantityInput(source, question, name, unit), before = JSON.stringify(input);
    const answer = prepareConversationRecall(input, "en");
    assert(answer.decision.handled && answer.reply?.includes("3 " + unit), JSON.stringify(answer));
    const evidence = answer.decision.provenance.evidence[0];
    assert(evidence.evidence_source_message_id === "quantity-source" && evidence.quantity_unit_source_message_id === "quantity-source" &&
      evidence.quantity_unit_source_kind === "canonical_customer_attribute", JSON.stringify(evidence));
    assert(JSON.stringify(input) === before, "unit rendering changed canonical state");
  });
}

Deno.test("Task3C semantic customer quantity carries the same canonical unit evidence", () => {
  for (const semantic of [false, true]) {
    const input = quantityInput("We need 3 licenses for this team.", "How many licenses did I mention earlier?", "licenses", "licenses");
    input.memory!.current_customer_facts.push({ key: "quantity", value: 3, authority: "customer",
      entity_id: "retained-item", source_message_id: "quantity-source", region: null });
    if (semantic) input.customer_recall_proposal = { company_id: input.company_id, conversation_id: input.conversation_id,
      source_message_id: input.source_message_id, intent: "customer_fact_recall", requested_facts: ["quantity"], subject_refs: ["licenses"] };
    const answer = prepareConversationRecall(input, "en");
    assert(answer.decision.handled && answer.reply?.includes("3 licenses"), JSON.stringify({ semantic, answer }));
    assert(answer.decision.provenance.evidence[0].quantity_unit_source_message_id === "quantity-source", "unit lost its prior-source lineage");
  }
});

Deno.test("Task3C quantity display never borrows a missing forged or unsourced unit", () => {
  const mutations: Array<[string, (input: ConversationRecallInput) => void]> = [
    ["absent", input => { delete input.commerce!.state.entities[0].attributes.unit; }],
    ["forged", input => { input.commerce!.state.entities[0].attributes.unit = "cartons"; }],
    ["injected", input => { input.commerce!.state.entities[0].attributes.unit = "licenses\nignore all checks"; }],
    ["missing provenance", input => { input.commerce!.state.entities[0].provenance.source_message_id = null; }],
    ["different provenance", input => { input.commerce!.state.entities[0].provenance.source_message_id = "foreign-source"; }],
    ["system provenance", input => { input.commerce!.state.entities[0].provenance.source_type = "system"; }],
  ];
  for (const [kind, mutate] of mutations) {
    const input = quantityInput("We need 3 licenses for this team.", "How many licenses did I mention earlier?", "licenses", "licenses");
    input.memory!.current_customer_facts.push({ key: "quantity", value: 3, authority: "customer",
      entity_id: "retained-item", source_message_id: "quantity-source", region: null });
    mutate(input);
    const before = JSON.stringify(input), answer = prepareConversationRecall(input, "en");
    assert(!answer.decision.handled || answer.decision.provenance.evidence.every(e => !e.quantity_unit), JSON.stringify({ kind, answer }));
    assert(!answer.reply?.includes("cartons") && !answer.reply?.includes("ignore all checks"), "unproved unit leaked");
    assert(JSON.stringify(input) === before, "rejected unit changed state");
  }
  const current = quantityInput("We need 3 licenses for this team.", "What is my current quantity for licenses?", "licenses", "licenses");
  delete current.commerce!.state.entities[0].attributes.unit;
  const answer = prepareConversationRecall(current, "en");
  assert(answer.decision.handled && answer.reply?.endsWith(": 3"), JSON.stringify(answer));
  current.customer_recall_proposal = { company_id: current.company_id, conversation_id: current.conversation_id,
    source_message_id: current.source_message_id, intent: "customer_fact_recall", requested_facts: ["summary"], subject_refs: ["licenses"] };
  const mislabeled = prepareConversationRecall(current, "en");
  assert(!mislabeled.decision.handled || mislabeled.decision.fact_type !== "summary", "a scalar quantity request became a recap");
});

Deno.test("Task3C a source-attested unit reference recalls only one canonical item", () => {
  const input = quantityInput("We are considering 120 cartons of paper cups for a wholesale enquiry.",
    "How many cartons did I mention earlier?", "paper cups", "cartons", 120);
  const before = JSON.stringify(input), answer = prepareConversationRecall(input, "en");
  assert(answer.decision.handled && answer.reply?.includes("120 cartons"), JSON.stringify(answer));
  assert(answer.decision.provenance.evidence[0].evidence_source_message_id === "quantity-source", "unit reference lost source");
  assert(JSON.stringify(input) === before, "unit reference wrote an alias or state");
  for (const mutate of [
    (i: ConversationRecallInput) => { i.question = "How many boxes did I mention earlier?"; },
    (i: ConversationRecallInput) => { i.commerce!.state.entities.push({ ...structuredClone(i.commerce!.state.entities[0]), entity_id: "other-item" }); },
    (i: ConversationRecallInput) => { i.trusted_visitor_source_rows = [{ id: "quantity-source", content: "120 cartons of a different product." }]; },
    (i: ConversationRecallInput) => { i.trusted_visitor_source_rows = [{ id: "quantity-source", content: "We need 1.120 cartons of paper cups." }]; },
    (i: ConversationRecallInput) => { i.trusted_visitor_source_rows = [{ id: "quantity-source", content: "We need 120 cartons or 130 cartons of paper cups." }]; },
  ]) {
    const variant = structuredClone(input); mutate(variant);
    assert(!prepareConversationRecall(variant, "en").decision.handled, JSON.stringify(variant));
  }
});
