import {
  buildCommerceEntityHints,
  buildCurrentPriceValidityAnswer,
  buildPreorderUnpaidAnswer,
  buildTransactionSummary,
  detectCurrentPriceValidityQuestion,
  detectPreorderUnpaidIntent,
  detectTransactionSummaryIntent,
  reduceTurn,
} from "../../supabase/functions/_shared/commerce-state-runtime.ts";
import { createEmptyConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const company = "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493";
const conversation = "77777777-7777-4777-8777-777777777777";
const state = createEmptyConversationCommerceState();
state.entities.push({
  entity_id: "air_conditioner:unscoped",
  category: "air_conditioner",
  brand: null,
  model: null,
  quantity: 2,
  status: "tentative",
  attributes: {},
  constraints: {},
  provenance: { source_type: "customer", source_message_id: "seed", recorded_at: null },
});
state.conversion.funnel_stage = "quotation";
state.conversion.quotation_status = "draft";
state.conversion.order_status = "none";
state.conversion.payment_status = "none";

const priceQ = "呢個報價我之前見過，係咪而家都一定係呢個價？";
const preorderQ = "我想預訂，但未付款。";

assert(!detectTransactionSummaryIntent(priceQ), "price validity question must not trigger summary dump");
assert(!detectTransactionSummaryIntent(preorderQ), "preorder/unpaid must not trigger summary dump");
assert(detectTransactionSummaryIntent("幫我總結一下而家訂單同付款狀態"), "explicit summary intent must remain supported");
assert(detectCurrentPriceValidityQuestion(priceQ), "current-price validity detector missed real production wording");
assert(detectPreorderUnpaidIntent(preorderQ), "preorder unpaid detector missed real production wording");

const priceReply = buildCurrentPriceValidityAnswer("zh-TW");
assert(priceReply.includes("唔代表而家仍然係同一個價"), "price reply must directly answer the question");
assert(!/(?:quotation=|order=|payment=|funnel_stage)/i.test(priceReply), "price reply leaks internal state enum");

const preorderReply = buildPreorderUnpaidAnswer("zh-TW", state);
assert(preorderReply.includes("冷氣機 x2"), "preorder reply must preserve known item context");
assert(preorderReply.includes("仲未付款"), "preorder reply must acknowledge unpaid status");
assert(preorderReply.includes("下一步"), "preorder reply must provide next best action");
assert(!/(?:quotation=|order=|payment=|funnel_stage)/i.test(preorderReply), "preorder reply leaks internal state enum");

const summary = buildTransactionSummary(state, "zh-TW");
assert(!/(?:quotation=|order=|payment=|funnel_stage|quotation\s*\/)/i.test(summary), "explicit summary must not expose internal enums");
assert(summary.includes("訂單：尚未確認"), "summary must humanize order status");
assert(summary.includes("付款：目前未有已付款記錄"), "summary must humanize payment status");

function reduce(text: string, id: string) {
  return reduceTurn(state, {
    conversation_id: conversation,
    company_id: company,
    source_message_id: id,
    text,
    language: "zh-TW",
  }, buildCommerceEntityHints([text]));
}
const priceState = reduce(priceQ, "77777777-7777-4777-8777-777777777701");
assert(priceState.conversion.order_status === "none", "price question promoted order");
assert(priceState.conversion.payment_status === "none", "price question promoted payment");
const preorderState = reduce(preorderQ, "77777777-7777-4777-8777-777777777702");
assert(preorderState.conversion.order_status === "none", "preorder intent must not become confirmed order");
assert(preorderState.conversion.payment_status === "none", "unpaid preorder must remain unpaid");
assert(preorderState.delivery.confirmed === false, "preorder intent must not confirm delivery");

console.log(JSON.stringify({
  status: "PASS",
  gate: "TASK_A3_HOTFIX7_CUSTOMER_REPLY",
  assertions: {
    explicit_summary_only: true,
    current_price_direct_answer: true,
    preorder_acknowledgement_and_next_step: true,
    internal_enums_hidden: true,
    order_not_promoted: true,
    unpaid_not_promoted: true,
    delivery_not_confirmed: true
  }
}));
