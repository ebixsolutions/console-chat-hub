import { createEmptyConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { reduceCommerceState } from "../../supabase/functions/_shared/commerce-state-reducer.ts";
import {
  COMMERCE_SEMANTIC_FRAME_VERSION,
  normalizeCommerceSemanticFrame,
  type CommerceSemanticFrame,
} from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import {
  mergeCommerceEntityHints,
  semanticFrameToEntityHints,
  semanticFrameToStateEvents,
} from "../../supabase/functions/_shared/commerce-semantic-adapter.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function frame(overrides: Partial<CommerceSemanticFrame>): CommerceSemanticFrame {
  return {
    version: COMMERCE_SEMANTIC_FRAME_VERSION,
    language: "und",
    operation: "NO_STATE_CHANGE",
    intent: "unknown",
    topic: null,
    entities: [],
    referents: [],
    customer_correction: false,
    additive: false,
    explicit_negations: [],
    requested_facts: [],
    transaction_state: "unknown",
    payment_state: "unknown",
    booking_state: "unknown",
    fulfillment_state: "unknown",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
    confidence: 0.95,
    ...overrides,
  };
}

const unknownIndustry = normalizeCommerceSemanticFrame({
  version: COMMERCE_SEMANTIC_FRAME_VERSION,
  language: "zu",
  operation: "ADD_ITEM",
  intent: "rent_equipment",
  topic: "rental",
  entities: [{
    entity_ref: "excavator",
    name: "挖泥機",
    kind: "rental",
    category_hint: null,
    sku: null,
    model: null,
    quantity: 2,
    unit: "部",
    attributes: { duration_days: 3, destination: "屯門地盤" },
    constraints: {},
    capabilities: {
      requires_delivery: true,
      supports_pickup: false,
      requires_installation: false,
      requires_booking: false,
      requires_quote: true,
      requires_site_check: false,
      digital_fulfilment: false,
      recurring_billing: false,
      rental_return: true,
      customization: false,
    },
    confidence: 0.97,
  }],
  referents: [],
  customer_correction: false,
  additive: false,
  explicit_negations: [],
  requested_facts: ["rental price", "delivery conditions"],
  transaction_state: "draft",
  payment_state: "pending_quote",
  booking_state: "none",
  fulfillment_state: "requested",
  ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
  confidence: 0.97,
});
assert(unknownIndustry?.entities[0].kind === "rental", "unseen rental industry failed schema normalization");
assert(unknownIndustry?.language === "zu", "arbitrary language code must survive normalization");
assert(unknownIndustry?.transaction_state === "draft", "transaction lifecycle missing from canonical frame");
assert(unknownIndustry?.payment_state === "pending_quote", "payment lifecycle missing from canonical frame");
assert(unknownIndustry?.fulfillment_state === "requested", "fulfillment lifecycle missing from canonical frame");

const semanticHints = semanticFrameToEntityHints(unknownIndustry);
assert(semanticHints.length === 1, "semantic entity hint missing");
assert(semanticHints[0].category === "rental", "semantic rental category failed");
assert((semanticHints[0].attributes?.capabilities as Record<string, unknown>)?.rental_return === true, "rental capability missing");

const applianceDeterministic = [{
  entity_id: "air_conditioner:bedroom",
  category: "air_conditioner",
  aliases: ["冷氣", "冷氣機", "睡房"],
}];
const applianceSemantic = semanticFrameToEntityHints(frame({
  operation: "ADD_ITEM",
  entities: [{
    entity_ref: "冷氣",
    name: "冷氣",
    kind: "physical_product",
    category_hint: null,
    sku: null,
    model: null,
    quantity: 2,
    unit: "部",
    attributes: { room: "睡房" },
    constraints: {},
    capabilities: {
      requires_delivery: false,
      supports_pickup: false,
      requires_installation: true,
      requires_booking: false,
      requires_quote: false,
      requires_site_check: true,
      digital_fulfilment: false,
      recurring_billing: false,
      rental_return: false,
      customization: false,
    },
    confidence: 0.98,
  }],
}));
const merged = mergeCommerceEntityHints(applianceSemantic, applianceDeterministic);
assert(merged.length === 1 && merged[0].entity_id === "air_conditioner:bedroom", "semantic layer must preserve known deterministic entity identity");

let state = createEmptyConversationCommerceState();
const first = frame({
  language: "ja",
  operation: "ADD_ITEM",
  intent: "buy_unknown_item",
  transaction_state: "draft",
  entities: [{
    entity_ref: "custom-widget",
    name: "超新型部材",
    kind: "physical_product",
    category_hint: null,
    sku: null,
    model: null,
    quantity: 3,
    unit: "個",
    attributes: { color: "青" },
    constraints: {},
    capabilities: {
      requires_delivery: false,
      supports_pickup: false,
      requires_installation: false,
      requires_booking: false,
      requires_quote: false,
      requires_site_check: false,
      digital_fulfilment: false,
      recurring_billing: false,
      rental_return: false,
      customization: false,
    },
    confidence: 0.99,
  }],
});
const firstHints = semanticFrameToEntityHints(first);
state = reduceCommerceState(state, semanticFrameToStateEvents(first, state, firstHints, "11111111-1111-4111-8111-111111111111"));
assert(state.entities.length === 1 && state.entities[0].quantity === 3, "unseen multilingual ADD_ITEM failed deterministic reducer");

const correction = frame({
  language: "ja",
  operation: "SET_QUANTITY",
  intent: "correct_quantity",
  customer_correction: true,
  entities: [{ ...first.entities[0], quantity: 2, confidence: 0.99 }],
});
state = reduceCommerceState(state, semanticFrameToStateEvents(correction, state, semanticFrameToEntityHints(correction), "22222222-2222-4222-8222-222222222222"));
assert(state.entities[0].quantity === 2, "language-neutral quantity correction failed");

const additive = frame({
  language: "fr",
  operation: "ADD_ITEM",
  intent: "add_more",
  additive: true,
  entities: [{ ...first.entities[0], quantity: 4, confidence: 0.99 }],
});
state = reduceCommerceState(state, semanticFrameToStateEvents(additive, state, semanticFrameToEntityHints(additive), "33333333-3333-4333-8333-333333333333"));
assert(state.entities[0].quantity === 6, "language-neutral additive operation failed");

const factual = frame({
  language: "de",
  operation: "ASK_FACT",
  intent: "pickup_policy_question",
  requested_facts: ["pickup eligibility", "pickup location"],
  confidence: 0.99,
});
const before = JSON.stringify(state);
state = reduceCommerceState(state, semanticFrameToStateEvents(factual, state, [], "44444444-4444-4444-8444-444444444444"));
assert(JSON.stringify(state) === before, "ASK_FACT must not mutate commerce state");

const negatedReserve = frame({
  language: "zh-TW",
  operation: "RESERVE",
  intent: "preorder_unpaid",
  payment_state: "none",
  booking_state: "requested",
  explicit_negations: ["未付款"],
  confidence: 0.99,
});
const beforeReserve = JSON.stringify(state);
state = reduceCommerceState(state, semanticFrameToStateEvents(negatedReserve, state, [], "55555555-5555-4555-8555-555555555555"));
assert(JSON.stringify(state) === beforeReserve, "negated reservation must not promote order/payment state");

const ambiguousRaw = normalizeCommerceSemanticFrame({
  version: COMMERCE_SEMANTIC_FRAME_VERSION,
  language: "en",
  operation: "ADD_ITEM",
  intent: "add_item",
  topic: "accessory",
  entities: [{ ...first.entities[0], entity_ref: "another-one", name: "another one", quantity: 1, confidence: 0.91 }],
  referents: [{ ref: "prior:item", source: "prior_turn", confidence: 0.55 }],
  customer_correction: false,
  additive: true,
  explicit_negations: [],
  requested_facts: [],
  transaction_state: "draft",
  payment_state: "none",
  booking_state: "none",
  fulfillment_state: "none",
  ambiguity: { is_ambiguous: true, reasons: ["multiple plausible prior items"], clarification_question: "Which item do you mean?" },
  confidence: 0.91,
});
assert(ambiguousRaw?.operation === "NO_STATE_CHANGE", "ambiguous semantic frame must normalize to NO_STATE_CHANGE");
assert(ambiguousRaw?.ambiguity.is_ambiguous === true, "ambiguity must remain explicit in canonical frame");
const beforeAmbiguous = JSON.stringify(state);
state = reduceCommerceState(state, semanticFrameToStateEvents(ambiguousRaw, state, semanticFrameToEntityHints(ambiguousRaw), "66666666-6666-4666-8666-666666666666"));
assert(JSON.stringify(state) === beforeAmbiguous, "ambiguous interpretation must not mutate commerce state");

const lowConfidenceRaw = normalizeCommerceSemanticFrame({
  version: COMMERCE_SEMANTIC_FRAME_VERSION,
  language: "en",
  operation: "ADD_ITEM",
  intent: "add_item",
  topic: null,
  entities: [],
  referents: [],
  customer_correction: false,
  additive: false,
  explicit_negations: [],
  requested_facts: [],
  transaction_state: "unknown",
  payment_state: "unknown",
  booking_state: "unknown",
  fulfillment_state: "unknown",
  ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
  confidence: 0.4,
});
assert(lowConfidenceRaw?.ambiguity.is_ambiguous === true, "low-confidence frame must be forced ambiguous");
assert(lowConfidenceRaw?.ambiguity.reasons.includes("low_confidence"), "low-confidence ambiguity reason missing");
assert(lowConfidenceRaw?.operation === "NO_STATE_CHANGE", "low-confidence frame must be read-only");

const invalidLifecycle = normalizeCommerceSemanticFrame({
  version: COMMERCE_SEMANTIC_FRAME_VERSION,
  language: "en",
  operation: "NO_STATE_CHANGE",
  intent: "status",
  topic: null,
  entities: [],
  referents: [],
  customer_correction: false,
  additive: false,
  explicit_negations: [],
  requested_facts: [],
  transaction_state: "magically_done",
  payment_state: "definitely_paid_somehow",
  booking_state: "booked_by_guess",
  fulfillment_state: "teleported",
  ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
  confidence: 0.99,
});
assert(invalidLifecycle?.transaction_state === "unknown", "invalid transaction lifecycle must normalize safely");
assert(invalidLifecycle?.payment_state === "unknown", "invalid payment lifecycle must normalize safely");
assert(invalidLifecycle?.booking_state === "unknown", "invalid booking lifecycle must normalize safely");
assert(invalidLifecycle?.fulfillment_state === "unknown", "invalid fulfillment lifecycle must normalize safely");

console.log(JSON.stringify({
  status: "PASS",
  gate: "TASK_A3_TASK1_UNIVERSAL_SEMANTICS",
  assertions: {
    no_industry_enumeration_required: true,
    arbitrary_language_preserved: true,
    unknown_rental_supported: true,
    known_profile_identity_preserved: true,
    language_neutral_add_item: true,
    language_neutral_correction: true,
    language_neutral_additive: true,
    factual_query_read_only: true,
    negated_transaction_safe: true,
    canonical_lifecycle_fields_required: true,
    ambiguity_explicit: true,
    ambiguity_forces_no_state_change: true,
    ambiguity_blocks_reducer_events: true,
    low_confidence_forces_ambiguity: true,
    invalid_lifecycle_values_fail_safe: true,
  },
}, null, 2));
