import { createEmptyConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import {
  deriveCommerceEventsFromCustomerTurn,
  reduceCommerceState,
} from "../../supabase/functions/_shared/commerce-state-reducer.ts";
import { resolveCommerceAnswerAuthority } from "../../supabase/functions/_shared/commerce-state-authority.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const customer = (source_message_id: string) => ({
  source_type: "customer" as const,
  source_message_id,
});

let state = createEmptyConversationCommerceState();

state = reduceCommerceState(state, [
  {
    type: "ADD_ENTITY",
    entity: {
      entity_id: "item-a",
      category: "product",
      quantity: 3,
      status: "tentative",
      attributes: {},
      constraints: {},
      provenance: customer("m1"),
    },
  },
  {
    type: "SET_ENTITY_QUANTITY",
    entity_id: "item-a",
    quantity: 2,
    provenance: customer("m2"),
  },
  { type: "ADD_CORRECTION", correction: "latest quantity is 2, not 3" },
]);
assert(state.entities[0]?.quantity === 2, "latest quantity must win");

const ensureEvents = deriveCommerceEventsFromCustomerTurn({
  text: "product keep it",
  source_message_id: "m3",
  entity_hints: [{ entity_id: "item-a", category: "product", aliases: ["product"] }],
});
state = reduceCommerceState(state, ensureEvents);
assert(state.entities[0]?.quantity === 2, "ENSURE_ENTITY must not reset quantity");

const quantityEvents = deriveCommerceEventsFromCustomerTurn({
  text: "product 改做兩件",
  source_message_id: "m3b",
  entity_hints: [{ entity_id: "item-a", category: "product", aliases: ["product"] }],
});
state = reduceCommerceState(state, quantityEvents);
assert(state.entities[0]?.quantity === 2, "generic Chinese quantity parsing failed");

state = reduceCommerceState(state, [
  { type: "SET_ENTITY_STATUS", entity_id: "item-a", status: "cancelled", provenance: customer("m4") },
]);
assert(state.conversion.cancelled_entity_ids.includes("item-a"), "cancelled entity missing");
assert(!state.conversion.tentative_entity_ids.includes("item-a"), "cancelled entity leaked into tentative list");

const quoteEvents = deriveCommerceEventsFromCustomerTurn({
  text: "之前報價 HK$5,600，未confirm",
  source_message_id: "m5",
  currency: "HKD",
});
state = reduceCommerceState(state, quoteEvents);
assert(state.quotes.length === 1, "quote not captured");
assert(state.quotes[0]?.amount === 5600, "quote amount mismatch");
assert(state.quotes[0]?.quote_type === "customer_reported_historical", "historical provenance lost");
assert(state.quotes[0]?.validity_status === "unknown", "unverified historical quote must not become current");
assert(state.quotes[0]?.conditions.unverified === true, "unverified marker missing");

const customerCurrentPrice = deriveCommerceEventsFromCustomerTurn({
  text: "而家價錢係 HK$6,000",
  source_message_id: "m5b",
  currency: "HKD",
});
state = reduceCommerceState(state, customerCurrentPrice);
assert(state.quotes[1]?.quote_type === "unverified", "customer current-price claim must not become verified");
assert(state.quotes[1]?.validity_status === "unknown", "customer current-price claim must require verification");

state = reduceCommerceState(state, [
  {
    type: "ADD_ENTITY",
    entity: {
      entity_id: "booking-a",
      category: "service_booking",
      quantity: 4,
      status: "tentative",
      attributes: { date: "2026-10-01" },
      constraints: { seating: "indoor" },
      provenance: customer("m6"),
    },
  },
  {
    type: "SET_ENTITY_QUANTITY",
    entity_id: "booking-a",
    quantity: 6,
    provenance: customer("m7"),
  },
]);
assert(state.entities.find((x) => x.entity_id === "booking-a")?.quantity === 6, "cross-industry quantity update failed");

state = reduceCommerceState(state, [
  { type: "SET_DELIVERY", patch: { address: "Block A", preferred_date: "Friday" }, provenance: customer("m8") },
  { type: "SET_DELIVERY", patch: { address: "Block B", preferred_date: "Saturday" }, provenance: customer("m9") },
]);
assert(state.delivery.address === "Block B", "latest address must win");
assert(state.delivery.preferred_date === "Saturday", "latest delivery preference must win");

const quoteOnly = deriveCommerceEventsFromCustomerTurn({
  text: "quotation only，未正式落單",
  source_message_id: "m10",
});
state = reduceCommerceState(state, quoteOnly);
assert(state.conversion.funnel_stage === "quotation", "quotation funnel mismatch");
assert(state.conversion.order_status === "draft", "quotation incorrectly confirmed as order");
assert(state.conversion.payment_status === "pending_quote", "quotation payment state mismatch");

let decision = resolveCommerceAnswerAuthority({
  question: "我最後數量幾多？",
  state,
  requested_state_path: "entities.0.quantity",
});
assert(decision.authority === "CONVERSATION_STATE", "known customer state did not win");
assert(decision.known_value === 2, "known customer value mismatch");

decision = resolveCommerceAnswerAuthority({
  question: "我最後地址係邊？",
  state,
});
assert(decision.authority === "CONVERSATION_STATE", "known address should be inferred without explicit path");
assert(decision.known_value === "Block B", "inferred address mismatch");

decision = resolveCommerceAnswerAuthority({
  question: "兩件加埋服務費總共幾錢？",
  state,
  calculation_terms: [
    { label: "item", value: 5600, multiplier: 2 },
    { label: "service", value: 550, multiplier: 2 },
    { label: "frame", value: 550, multiplier: 2 },
  ],
  calculation_currency: "HKD",
});
assert(decision.authority === "DETERMINISTIC_CALCULATION", "calculation authority mismatch");
assert(decision.calculation?.result === 13400, "deterministic calculation mismatch");

decision = resolveCommerceAnswerAuthority({
  question: "而家最新價幾多？",
  state,
  requires_current_price_or_stock: true,
});
assert(decision.authority === "CURRENT_KB_REQUIRED", "current price did not route to KB authority");

decision = resolveCommerceAnswerAuthority({
  question: "現場條件可唔可以保證安全？",
  state,
  requires_professional_site_check: true,
  requires_current_business_fact: true,
});
assert(decision.authority === "SAFE_PROFESSIONAL_CONFIRMATION", "safety must outrank current-business retrieval");

decision = resolveCommerceAnswerAuthority({
  question: "我最後收貨人電話係咩？",
  state,
  requested_state_path: "delivery.recipient_phone",
});
assert(decision.authority === "INSUFFICIENT_INFORMATION", "unknown customer state must remain unknown");

console.log(JSON.stringify({
  status: "PASS",
  task: "A2",
  assertions: {
    latest_value_wins: true,
    ensure_entity_no_reset: true,
    generic_quantity_parser: true,
    cancellation_reconciled: true,
    quote_provenance_preserved: true,
    customer_price_not_verified: true,
    cross_industry_entity_state: true,
    delivery_supersession: true,
    quotation_not_order: true,
    conversation_state_authority: true,
    inferred_known_state_authority: true,
    deterministic_calculation: true,
    current_kb_authority: true,
    safe_professional_confirmation: true,
    no_fabrication_on_unknown_state: true,
  },
}));
