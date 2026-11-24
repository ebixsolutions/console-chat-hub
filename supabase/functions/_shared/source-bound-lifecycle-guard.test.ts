import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { reduceTurn, runCommerceStateRuntime, type CommerceRuntimeInput, type CommerceStateDbClient } from "./commerce-state-runtime-base.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const owner = { company_id: "company-a", conversation_id: "ticket-a" };
function state(name = "Alpha and Beta training sessions", unit = "sessions"): ConversationCommerceState {
  const previous = createEmptyConversationCommerceState();
  previous.entities = [{ entity_id: "generic:source-owned-group", category: "generic_product", quantity: 3,
    status: "tentative", attributes: { product_name: name, unit, quantity_basis: "customer_explicit" },
    constraints: {}, provenance: { source_type: "customer", source_message_id: "prior-visitor" } }];
  previous.conversion.tentative_entity_ids = previous.entities.map(entity => entity.entity_id);
  return previous;
}
function input(text: string, previous = state()): CommerceRuntimeInput {
  const target = previous.entities[0];
  const frame: CommerceSemanticFrame = {
    version: "commerce-semantic-1.0.0", language: "en", operation: "CANCEL_ITEM", intent: "customer_correction",
    topic: target.category, entities: [{ entity_ref: target.entity_id, name: String(target.attributes.product_name),
      kind: "service", category_hint: target.category, quantity: null, unit: String(target.attributes.unit),
      model: null, sku: null, attributes: {}, constraints: {}, confidence: 0.99,
      capabilities: { requires_delivery: false, supports_pickup: false, requires_installation: false,
        requires_booking: false, requires_quote: false, requires_site_check: false, digital_fulfilment: false,
        recurring_billing: false, rental_return: false, customization: false } }],
    referents: [{ ref: target.entity_id, source: "persistent_state", confidence: 0.99 }],
    customer_correction: true, additive: false, explicit_negations: [], requested_facts: [],
    transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.99,
  };
  return { ...owner, source_message_id: "current-visitor", text, language: "en", semantic_frame: frame };
}
function store(previous: ConversationCommerceState) {
  const live = { state: structuredClone(previous), revision: 4, writes: 0 };
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: {
      ...owner, revision: live.revision, state: structuredClone(live.state) }, error: null }) }) }) }),
    rpc: async (_name, args) => {
      live.writes++;
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id &&
        args.p_expected_revision === live.revision, "Owner/revision changed at the mutation boundary");
      live.state = structuredClone(args.p_state as ConversationCommerceState); live.revision++;
      return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  return { db, live };
}

Deno.test("Task3C source-bound full-entity correction uses the existing exact lifecycle receipt across industries", async () => {
  for (const [name, unit] of [["Alpha and Beta training sessions", "sessions"],
    ["North and South event rentals", "bundles"], ["Main and Annex subscriptions", "licenses"]]) {
    const previous = state(name, unit), { db, live } = store(previous);
    const outcome = await runCommerceStateRuntime(db, input("Cancel " + name + ".", previous));
    assert(live.state.entities.length === 1 && live.state.entities[0].status === "cancelled" &&
      live.state.entities[0].quantity === 3 && live.state.entities[0].provenance.source_message_id === "current-visitor" &&
      outcome?.trusted_lifecycle_commit?.target_entity_ids[0] === previous.entities[0].entity_id,
      JSON.stringify({ live, outcome }));
    assert(JSON.stringify(live.state.entities[0].attributes) === JSON.stringify(previous.entities[0].attributes),
      "Full cancellation invented or rewrote quantity/source labels");
  }
});

Deno.test("Task3C a typed partial subject cannot use an aggregate ref to cancel the whole group", async () => {
  for (const correction of [true, false]) {
    const previous = state(), { db, live } = store(previous);
    const turn = input("Cancel Beta training sessions; retain Alpha 2 sessions.", previous);
    turn.semantic_frame!.customer_correction = correction;
    turn.semantic_frame!.entities[0].name = "Beta training sessions";
    const outcome = await runCommerceStateRuntime(db, turn);
    assert(JSON.stringify(live.state) === JSON.stringify(previous) && live.writes === 0 &&
      outcome?.persist_result === "read_only", JSON.stringify({ live, outcome }));
  }
});

Deno.test("Task3C supplied correction units and subjects must match the exact canonical target", async () => {
  for (const kind of ["unit", "name", "source-type", "source-id", "ambiguity", "low-confidence", "quantity"] as const) {
    const previous = state(), turn = input("Cancel Alpha and Beta training sessions.", previous);
    if (kind === "unit") turn.semantic_frame!.entities[0].unit = "packages";
    if (kind === "name") turn.semantic_frame!.entities[0].name = "Other sessions";
    if (kind === "source-type") previous.entities[0].provenance.source_type = "kb";
    if (kind === "source-id") previous.entities[0].provenance.source_message_id = null;
    if (kind === "ambiguity") turn.semantic_frame!.ambiguity.is_ambiguous = true;
    if (kind === "low-confidence") turn.semantic_frame!.confidence = 0.4;
    if (kind === "quantity") turn.semantic_frame!.entities[0].quantity = 2;
    const { db, live } = store(previous);
    await runCommerceStateRuntime(db, turn);
    assert(JSON.stringify(live.state) === JSON.stringify(previous), kind + " changed the target: " + JSON.stringify(live.state));
  }
});

Deno.test("Task3C an independently canonical child can be cancelled without changing the retained sibling", async () => {
  const previous = state("Beta training sessions"); previous.entities[0].quantity = 1;
  previous.entities.push({ ...structuredClone(previous.entities[0]), entity_id: "generic:retained-child",
    quantity: 2, attributes: { product_name: "Alpha training sessions", unit: "sessions", quantity_basis: "customer_explicit" },
    provenance: { source_type: "customer", source_message_id: "retained-visitor" } });
  previous.conversion.tentative_entity_ids = previous.entities.map(entity => entity.entity_id);
  const originalSibling = structuredClone(previous.entities[1]), { db, live } = store(previous);
  const outcome = await runCommerceStateRuntime(db, input("Cancel Beta training sessions.", previous));
  assert(live.state.entities[0].status === "cancelled" &&
    JSON.stringify(live.state.entities[1]) === JSON.stringify(originalSibling) &&
    outcome?.trusted_lifecycle_commit?.target_entity_ids.length === 1,
    JSON.stringify({ live, outcome }));
});

Deno.test("Task3C canonical read-only questions remain available without a Reading", async () => {
  const previous = state(), { db, live } = store(previous);
  const turn = input("How many Alpha and Beta training sessions do I have now?", previous);
  delete turn.semantic_frame;
  const outcome = await runCommerceStateRuntime(db, turn);
  assert(live.writes === 0 && JSON.stringify(live.state) === JSON.stringify(previous) &&
    outcome?.persist_result === "read_only", JSON.stringify({ live, outcome }));
});

Deno.test("Task3C a failed lifecycle commit cannot acknowledge a successful cancellation", async () => {
  const previous = state(), { db, live } = store(previous);
  db.rpc = async () => ({ data: null, error: { message: "synthetic transport failure" } });
  const outcome = await runCommerceStateRuntime(db, input("Cancel Alpha and Beta training sessions.", previous));
  assert(JSON.stringify(live.state) === JSON.stringify(previous) &&
    !outcome?.trusted_lifecycle_commit && outcome?.persist_result !== "success" &&
    !/has been cancelled|已取消/iu.test(outcome?.reply ?? ""), JSON.stringify({ live, outcome }));
});

Deno.test("Task3C sparse lifecycle refs retain only complete literal subjects", async () => {
  for (const [text, allowed] of [
    ["Cancel Alpha and Beta training sessions.", true],
    ["Cancel Beta training sessions.", false],
    ["Cancel one Alpha and Beta training sessions.", false],
  ] as const) {
    const previous = state(), turn = input(text, previous), { db, live } = store(previous);
    turn.semantic_frame!.entities = [];
    const outcome = await runCommerceStateRuntime(db, turn);
    if (allowed) assert(live.state.entities[0].status === "cancelled" &&
      outcome?.trusted_lifecycle_commit?.target_entity_ids.length === 1, JSON.stringify({live,outcome}));
    else assert(JSON.stringify(live.state) === JSON.stringify(previous) && live.writes === 0 &&
      !outcome?.trusted_lifecycle_commit, JSON.stringify({text,live,outcome}));
  }
});
