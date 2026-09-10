// Task A3 production hotfix #2: negated transaction statements must never confirm.
import {
  createEmptyConversationCommerceState,
  type ConversationCommerceState,
} from "../../supabase/functions/_shared/commerce-state-contract.ts";
import {
  deriveCommerceEventsFromCustomerTurn,
  reduceCommerceState,
} from "../../supabase/functions/_shared/commerce-state-reducer.ts";
import { enforceQuotationNotOrderEvents } from "../../supabase/functions/_shared/commerce-state-runtime.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message: string): void {
  assert(actual === expected, `${message} (expected ${expected}, got ${actual})`);
}

function applyTurn(text: string, previous?: ConversationCommerceState): ConversationCommerceState {
  const base = previous ?? createEmptyConversationCommerceState();
  const derived = deriveCommerceEventsFromCustomerTurn({
    text,
    source_message_id: "m1",
    occurred_at: null,
  });
  const reduced = reduceCommerceState(base, derived);
  return reduceCommerceState(reduced, enforceQuotationNotOrderEvents(text, reduced));
}

const QUOTE_ONLY = "我而家只係想要報價，未正式落單，未付款，未約送貨，未約安裝。";

Deno.test("negated quotation-only turn never confirms an order", () => {
  const state = applyTurn(QUOTE_ONLY);
  assert(state.conversion.order_status !== "confirmed", "order_status must not be confirmed");
  assert(state.conversion.funnel_stage !== "order_confirmed", "funnel_stage must not be order_confirmed");
  assert(state.conversion.payment_status !== "paid", "payment must not be paid");
  assertEquals(state.delivery.confirmed, false, "delivery must not be confirmed");
  assertEquals(state.conversion.funnel_stage, "quotation", "quotation semantics preserved");
});

Deno.test("positive 正式落單 still confirms the order", () => {
  const state = applyTurn("我確認正式落單。");
  assertEquals(state.conversion.order_status, "confirmed", "order_status");
  assertEquals(state.conversion.funnel_stage, "order_confirmed", "funnel_stage");
});

Deno.test("未付款 does not set paid", () => {
  const state = applyTurn("報價收到，未付款。");
  assert(state.conversion.payment_status !== "paid", "payment_status");
});

Deno.test("已付款 still positive", () => {
  const state = applyTurn("我已付款。");
  assertEquals(state.conversion.payment_status, "paid", "payment_status");
  assertEquals(state.conversion.order_status, "confirmed", "order_status");
});

Deno.test("未預約 does not create a confirmed booking", () => {
  const state = applyTurn("未預約送貨時間。");
  assertEquals(state.delivery.confirmed, false, "delivery.confirmed");
  assert(state.conversion.order_status !== "confirmed", "order_status");
});

Deno.test("English negations do not confirm", () => {
  const state = applyTurn("I have not ordered yet and have not paid, delivery is not booked.");
  assert(state.conversion.order_status !== "confirmed", "order_status");
  assert(state.conversion.payment_status !== "paid", "payment_status");
  assertEquals(state.delivery.confirmed, false, "delivery.confirmed");
});

Deno.test("a paid drift from a prior turn is downgraded when the customer negates payment", () => {
  const paid = applyTurn("我已付款。");
  assertEquals(paid.conversion.payment_status, "paid", "precondition");
  const corrected = applyTurn(QUOTE_ONLY, paid);
  assert(corrected.conversion.payment_status !== "paid", "payment downgraded");
  assert(corrected.conversion.order_status !== "confirmed", "order downgraded");
});
