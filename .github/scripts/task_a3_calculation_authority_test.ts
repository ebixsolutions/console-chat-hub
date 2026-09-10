// Task A3 production hotfix: deterministic calculation gating + no quote double-count.
import {
  createEmptyConversationCommerceState,
  type ConversationCommerceState,
} from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { resolveCommerceAnswerAuthority } from "../../supabase/functions/_shared/commerce-state-authority.ts";
import {
  detectExplicitCalculationRequest,
  extractCommerceCalculationTerms,
} from "../../supabase/functions/_shared/commerce-state-runtime.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message: string): void {
  assert(actual === expected, `${message} (expected ${expected}, got ${actual})`);
}

const HISTORY_TEXT = "之前每部機價5600元，安裝費550元，窗架550元，全部都係歷史價，未係現價。";

function stateWithQuantityTwoAndHistoricalQuote(): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.entities.push({
    entity_id: "aircon",
    category: "aircon",
    quantity: 2,
    status: "tentative",
    attributes: {},
    constraints: {},
    provenance: { source_type: "customer" },
  });
  state.quotes.push({
    quote_id: "q1",
    amount: 5600,
    currency: "HKD",
    quote_type: "customer_reported_historical",
    validity_status: "historical",
    conditions: {},
    provenance: { source_type: "customer" },
  });
  return state;
}

Deno.test("historical price statement alone is not an explicit calculation request", () => {
  assertEquals(detectExplicitCalculationRequest(HISTORY_TEXT), false, "history statement");
  const decision = resolveCommerceAnswerAuthority({
    question: HISTORY_TEXT,
    state: stateWithQuantityTwoAndHistoricalQuote(),
    calculation_terms: [],
  });
  assert(decision.authority !== "DETERMINISTIC_CALCULATION", "history must not auto-total");
});

Deno.test("explicit total question with quantity 2 computes exactly 13400", () => {
  const question = "咁全部加埋合共幾錢？";
  assertEquals(detectExplicitCalculationRequest(question), true, "explicit request");
  const state = stateWithQuantityTwoAndHistoricalQuote();
  const { terms, currency } = extractCommerceCalculationTerms([question, HISTORY_TEXT], state);
  assertEquals(terms.length, 3, "three distinct text terms");
  const decision = resolveCommerceAnswerAuthority({
    question,
    state,
    calculation_terms: terms,
    calculation_currency: currency,
  });
  assertEquals(decision.authority, "DETERMINISTIC_CALCULATION", "authority");
  assertEquals(decision.calculation?.result, 13400, "2*(5600+550+550)");
});

Deno.test("two distinct same-value 550 text mentions are both counted", () => {
  const { terms } = extractCommerceCalculationTerms([HISTORY_TEXT], createEmptyConversationCommerceState());
  assertEquals(terms.filter((t) => t.value === 550).length, 2, "550 counted twice");
});

Deno.test("persisted historical quote already present in text is not duplicated", () => {
  const state = stateWithQuantityTwoAndHistoricalQuote();
  const { terms } = extractCommerceCalculationTerms([HISTORY_TEXT], state);
  assertEquals(terms.filter((t) => t.value === 5600).length, 1, "5600 not duplicated");
});

Deno.test("persisted historical quote absent from text still supplements calculation", () => {
  const state = createEmptyConversationCommerceState();
  state.quotes.push({
    quote_id: "q2",
    amount: 4200,
    currency: "HKD",
    quote_type: "customer_reported_historical",
    validity_status: "historical",
    conditions: {},
    provenance: { source_type: "customer" },
  });
  const { terms } = extractCommerceCalculationTerms(["安裝費550元"], state);
  assert(terms.some((t) => t.value === 4200), "absent quote supplements");
});
