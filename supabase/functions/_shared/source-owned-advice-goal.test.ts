import { isReadOnlyMemoryOrCurrentStateRecall, isSourceOwnedActiveAdviceGoal } from "./commerce-state-authority.ts";
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { persistCommerceTurn, type CommerceStateDbClient } from "./commerce-state-runtime-base.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function reading(text: string, subject?: string): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language: "en", operation: "ASK_FACT",
    intent: "customer_guidance", topic: subject ?? null, entities: [], referents: [],
    requested_facts: [], customer_correction: false, additive: false, explicit_negations: [],
    transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.99,
    demands: [{ question: text, source_quote: text, subject_refs: subject ? [subject] : [],
      source_type: "general", requested_facts: [], constraints: {}, customer_correction: false,
      explicit_negations: [], ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }] };
}
function state(): ConversationCommerceState {
  const result = createEmptyConversationCommerceState();
  result.entities = [{ entity_id: "source-owned-training", category: "services", quantity: 2, status: "researching",
    attributes: { product_name: "Training sessions" }, constraints: {},
    provenance: { source_type: "customer", source_message_id: "prior-visitor" } }];
  return result;
}

Deno.test("Task3C advice goal classification follows sourced Reading across languages and speech forms", () => {
  for (const [text, subject] of [
    ["研修の準備では何を比較すべきでしょうか。", "研修"],
    ["Formation professionnelle : quels critères faut-il comparer ?", "Formation professionnelle"],
    ["一般租賃規劃，請講解應該比較嘅條件。", "租賃"],
    ["Last time the plan was different. I do not need merchant offers; please explain preparation priorities for Training sessions.", "Training sessions"],
  ]) {
    const frame = reading(text, subject);
    assert(isSourceOwnedActiveAdviceGoal(text, frame), "A first-person/verb/history dictionary rejected a valid Reading: " + text);
    assert(!isSourceOwnedActiveAdviceGoal(text, null), "Missing Reading acquired advice authority from wording");
  }
});

Deno.test("Task3C advice goal rejects invented quotes, ambiguity, merchant facts and recalled or transactional intent", () => {
  const text = "I want to prepare Training sessions. What should I compare?";
  const invalid: CommerceSemanticFrame[] = [];
  const quote = reading(text, "Training sessions"); quote.demands![0].source_quote = "Training sessions that the customer never mentioned"; invalid.push(quote);
  const noQuote = reading(text); noQuote.demands = []; invalid.push(noQuote);
  const otherSubject = reading(text, "Festival catering"); invalid.push(otherSubject);
  const low = reading(text); low.confidence = 0.6; invalid.push(low);
  const ambiguous = reading(text); ambiguous.ambiguity.is_ambiguous = true; invalid.push(ambiguous);
  const recalled = reading(text); recalled.intent = "customer_fact_recall"; invalid.push(recalled);
  const declined = reading(text); declined.intent = "decline_guidance"; invalid.push(declined);
  const merchant = reading(text); merchant.requested_facts = ["current availability"]; invalid.push(merchant);
  const policy = reading(text); policy.demands![0].source_type = "policy"; invalid.push(policy);
  const merchantDemand = reading(text); merchantDemand.demands![0].requested_facts = ["price"]; invalid.push(merchantDemand);
  const order = reading(text); order.transaction_state = "confirmed"; invalid.push(order);
  const doubled = reading(text); doubled.demands!.push(structuredClone(doubled.demands![0])); invalid.push(doubled);
  for (const frame of invalid) assert(!isSourceOwnedActiveAdviceGoal(text, frame), JSON.stringify(frame));
});

Deno.test("Task3C sparse guidance Reading retains the existing intent-only server source contract", () => {
  const text = "想換冷氣，兩間睡房加個客廳，應該點揀好？", frame = reading(text);
  frame.demands = [];
  const source = { company_id: "company", conversation_id: "ticket", source_message_id: "current-source", text };
  assert(isSourceOwnedActiveAdviceGoal(text, frame, undefined, source), "Existing source-bound sparse Reading was rejected");
  assert(!isSourceOwnedActiveAdviceGoal(text, frame), "Sparse Reading acquired source ownership without the server turn");
  assert(!isSourceOwnedActiveAdviceGoal(text, null, undefined, source), "Source identity inferred a missing Reading");
  for (const field of ["company_id", "conversation_id", "source_message_id"] as const)
    assert(!isSourceOwnedActiveAdviceGoal(text, frame, undefined, { ...source, [field]: "" }), "Missing " + field + " was accepted");
  assert(!isSourceOwnedActiveAdviceGoal(text, frame, undefined, { ...source, text: "An earlier different request" }),
    "A mismatched original source supplied current guidance authority");
  const fakeQuote = reading(text); fakeQuote.demands![0].source_quote = "Unstated general advice";
  assert(!isSourceOwnedActiveAdviceGoal(text, fakeQuote, undefined, source), "Server identity bypassed a supplied invalid quote");
  const quantity = reading(text); quantity.demands = [];
  quantity.entities = [{ entity_ref: "invented", name: "冷氣", kind: "physical_product", category_hint: null,
    quantity: 3, unit: "部", model: null, sku: null, attributes: {}, constraints: {}, confidence: 0.99,
    capabilities: { requires_delivery: false, supports_pickup: false, requires_installation: false,
      requires_booking: false, requires_quote: false, requires_site_check: false, digital_fulfilment: false,
      recurring_billing: false, rental_return: false, customization: false } }];
  assert(!isSourceOwnedActiveAdviceGoal(text, quantity, undefined, source), "Intent-only compatibility authorized a proposed quantity");
});

Deno.test("Task3C advice goal binds a persistent subject only to one active customer-owned identity", () => {
  const text = "Which preparation priorities should I compare for it?", frame = reading(text);
  frame.demands![0].subject_refs = ["source-owned-training"];
  frame.referents = [{ ref: "source-owned-training", source: "persistent_state", confidence: 0.99 }];
  assert(isSourceOwnedActiveAdviceGoal(text, frame, state()), "Valid unique canonical subject was lost");
  assert(!isSourceOwnedActiveAdviceGoal(text, frame), "Model-only persistent reference was treated as committed state");
  for (const change of ["cancelled", "deferred", "foreign-source", "missing-source", "competing"] as const) {
    const prior = state();
    if (change === "cancelled" || change === "deferred") prior.entities[0].status = change;
    if (change === "foreign-source") prior.entities[0].provenance.source_type = "kb";
    if (change === "missing-source") prior.entities[0].provenance.source_message_id = null;
    if (change === "competing") prior.entities.push({ ...structuredClone(prior.entities[0]),
      entity_id: "another-training", attributes: { product_name: "Other sessions" } });
    assert(!isSourceOwnedActiveAdviceGoal(text, frame, prior), change + " was accepted");
  }
  const priorTurn = structuredClone(frame); priorTurn.referents![0].source = "prior_turn";
  assert(!isSourceOwnedActiveAdviceGoal(text, priorTurn, state()), "Raw prior-turn reference became state authority");
});

Deno.test("Task3C current guidance and quantity recall retain distinct typed speech acts", () => {
  const text = "How many sessions should I consider for a training programme?", frame = reading(text);
  assert(!isReadOnlyMemoryOrCurrentStateRecall(text, frame), "Current guidance was turned into a quantity recall by words alone");
  const recall = structuredClone(frame); recall.intent = "customer_fact_recall";
  recall.requested_facts = ["current_quantity"];
  assert(isReadOnlyMemoryOrCurrentStateRecall(text, recall), "Existing canonical quantity recall was bypassed");
});

Deno.test("Task3C a source-quoted advice Reading persists intent without inferring quantities or orders", async () => {
  const text = "Formation professionnelle : quels critères faut-il comparer ?", frame = reading(text, "Formation professionnelle");
  let saved = createEmptyConversationCommerceState(), writes = 0;
  const db: CommerceStateDbClient = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    rpc: async (_name, params) => { writes++; saved = params.p_state as ConversationCommerceState;
      return { data: { result: "success", applied_revision: 1 }, error: null }; } };
  const result = await persistCommerceTurn(db, { company_id: "company", conversation_id: "ticket",
    source_message_id: "current-visitor", language: "en", text, semantic_frame: frame }, []);
  assert(result.result === "success" && writes === 1 && saved.current_intent === "customer_guidance" &&
    saved.entities.length === 0 && saved.conversion.order_status === "none" && saved.conversion.payment_status === "none",
    JSON.stringify(result));
});
