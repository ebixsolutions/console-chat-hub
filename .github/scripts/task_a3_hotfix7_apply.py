from pathlib import Path

runtime_path = Path("supabase/functions/_shared/commerce-state-runtime.ts")
gate_path = Path(".github/scripts/task_a3_final_gate.mjs")
test_path = Path(".github/scripts/task_a3_hotfix7_customer_reply_test.ts")

runtime = runtime_path.read_text()

old = '''export function detectTransactionSummaryIntent(text: string): boolean {
  return /(?:落單|下單|下单|落单|報價|报价|quotation|quote|付款|payment|checkout|幫我總結|帮我总结|總結一下|总结一下|整理(?:一下)?(?:比|畀|給|给)?同事|同事跟進|同事跟进|summar(?:y|ise|ize)|recap|hand over to)/i.test(clean(text));
}'''
new = '''export function detectTransactionSummaryIntent(text: string): boolean {
  return /(?:幫我總結|帮我总结|總結一下|总结一下|幫我整理|帮我整理|整理(?:一下)?(?:比|畀|給|给)?同事|同事跟進|同事跟进|summar(?:y|ise|ize)|recap|hand over to)/i.test(clean(text));
}

export function detectCurrentPriceValidityQuestion(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  const historical = /(?:之前|以前|以往|舊|旧|歷史|历史|previous|earlier|old)/i.test(t);
  const price = /(?:報價|报价|價|价|price|quote|quotation|收費|收费|fee)/i.test(t);
  const current = /(?:而家|現在|现在|目前|最新|仲係|还是|仍然|current|latest|still)/i.test(t);
  const validity = /(?:一定|作準|作准|有效|同價|同价|一樣|一样|same|valid|guarantee|guaranteed)/i.test(t);
  return historical && price && (current || validity);
}

export function detectPreorderUnpaidIntent(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  const preorder = /(?:想預訂|想预订|想訂|想订|要預訂|要预订|預訂|预订|reserve|reservation|pre[- ]?order|want to order|place an order)/i.test(t);
  return preorder && scanNegatedTransaction(t).negated_payment;
}'''
assert old in runtime, "STOP: summary intent baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''  lines.push(`${t.status[language]}: ${state.conversion.funnel_stage} / quotation=${state.conversion.quotation_status} / order=${state.conversion.order_status} / payment=${state.conversion.payment_status}`);
  lines.push(t.tail[language]);'''
new = '''  const orderConfirmed = state.conversion.order_status === "confirmed" || state.conversion.order_status === "completed";
  const paymentPaid = state.conversion.payment_status === "paid";
  if (language === "en") {
    lines.push(orderConfirmed ? "Order: confirmed." : "Order: not yet confirmed.");
    lines.push(paymentPaid ? "Payment: received." : "Payment: no confirmed payment on record yet.");
  } else if (language === "zh-CN") {
    lines.push(orderConfirmed ? "订单：已确认。" : "订单：尚未确认。");
    lines.push(paymentPaid ? "付款：已确认收到。" : "付款：目前未有已付款记录。");
  } else {
    lines.push(orderConfirmed ? "訂單：已確認。" : "訂單：尚未確認。");
    lines.push(paymentPaid ? "付款：已確認收到。" : "付款：目前未有已付款記錄。");
  }
  lines.push(t.tail[language]);'''
assert old in runtime, "STOP: transaction summary status baseline mismatch"
runtime = runtime.replace(old, new, 1)

anchor = '''function buildProfessionalConfirmationAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  if (language === "en") return `${known ? `I still have your details on record: ${known}. ` : ""}For safety and accuracy, our technician needs to inspect the site in person before we can confirm whether the installation is suitable.`;
  if (language === "zh-CN") return `${known ? `我们已保留您之前提供的资料：${known}。` : ""}为确保安全和准确，需要师傅上门检查窗口尺寸、承托及安装环境后再确认是否适合安装。`;
  return `${known ? `我哋已保留您之前提供嘅資料：${known}。` : ""}為確保安全同準確，需要師傅上門檢查窗口尺寸、承托同安裝環境後先可以確認是否適合安裝。`;
}
'''
insert = anchor + '''\nexport function buildCurrentPriceValidityAnswer(language: CommerceLanguage): string {
  if (language === "en") return "Not necessarily. A previous quote is only a reference and does not guarantee the current price. The latest product price and any installation or engineering charges need to be confirmed again before they are final.";
  if (language === "zh-CN") return "未必。你之前看到的报价只可作为参考，并不代表目前仍是同一价格。最新产品价格及安装／工程费用需要重新确认后才作准。";
  return "未必。你之前見過嘅報價只可以作參考，唔代表而家仍然係同一個價。最新產品價格同安裝／工程費用需要重新確認後先作準。";
}

export function buildPreorderUnpaidAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  if (language === "en") return `${known ? `Got it — you want to reserve ${known}. ` : "Got it — you want to make a reservation. "}Since payment has not been made yet, this is not a completed or confirmed order. The next step is to confirm the final quote, installation requirements and payment arrangement.`;
  if (language === "zh-CN") return `${known ? `好的，我知道你想预订${known}。` : "好的，我知道你想预订。"}由于目前还未付款，所以现在还不算已完成或已确认订单。下一步需要先确认最终报价、安装条件及付款安排。`;
  return `${known ? `好，我知道你想預訂${known}。` : "好，我知道你想預訂。"}因為你仲未付款，所以而家未算完成或已確認訂單。下一步要先確認最終報價、安裝條件同付款安排。`;
}
'''
assert anchor in runtime, "STOP: professional confirmation anchor mismatch"
runtime = runtime.replace(anchor, insert, 1)

old = '''  if (decision.authority === "DETERMINISTIC_CALCULATION" && decision.calculation) {
    return { ...base, authority: decision.authority, calculation: decision.calculation, reply: buildCalculationAnswer(language, decision.calculation), route: "commerce_state_answer" };
  }

  if (summaryIntent && (state.entities.length > 0 || state.quotes.length > 0)) {'''
new = '''  if (decision.authority === "DETERMINISTIC_CALCULATION" && decision.calculation) {
    return { ...base, authority: decision.authority, calculation: decision.calculation, reply: buildCalculationAnswer(language, decision.calculation), route: "commerce_state_answer" };
  }

  if (detectCurrentPriceValidityQuestion(text)) {
    return { ...base, authority: "CURRENT_KB_REQUIRED", reason: "previous_quote_not_authoritative_for_current_price", reply: buildCurrentPriceValidityAnswer(language), route: "commerce_state_answer" };
  }

  if (detectPreorderUnpaidIntent(text)) {
    return { ...base, authority: "CONVERSATION_STATE", reason: "preorder_intent_acknowledged_without_order_or_payment_promotion", reply: buildPreorderUnpaidAnswer(language, state), route: "commerce_state_answer" };
  }

  if (summaryIntent && (state.entities.length > 0 || state.quotes.length > 0)) {'''
assert old in runtime, "STOP: runtime reply routing baseline mismatch"
runtime = runtime.replace(old, new, 1)

runtime_path.write_text(runtime)

test_path.write_text(r'''import {
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
''')

gate = gate_path.read_text()
old_gate = '''execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_hotfix6_calculation_state_test.ts"], { stdio: "inherit" });
execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.contract, files.reducer, files.authority], { stdio: "inherit" });'''
new_gate = '''execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_hotfix6_calculation_state_test.ts"], { stdio: "inherit" });
execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_hotfix7_customer_reply_test.ts"], { stdio: "inherit" });
execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.contract, files.reducer, files.authority], { stdio: "inherit" });'''
assert old_gate in gate, "STOP: final-gate hotfix6 baseline mismatch"
gate_path.write_text(gate.replace(old_gate, new_gate, 1))

Path(__file__).unlink()
print("HOTFIX7 APPLY PASS")
