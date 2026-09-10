import {
  buildCommerceEntityHints,
  buildCurrentPriceValidityAnswer,
  buildPreorderUnpaidAnswer,
  reduceTurn,
  requiresProfessionalSiteCheck,
} from "../../supabase/functions/_shared/commerce-state-runtime.ts";
import {
  extractGenericCommerceEntity,
  getEntityCapabilities,
} from "../../supabase/functions/_shared/commerce-capability-runtime.ts";
import { createEmptyConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";

const company = "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493";
const conversation = "33333333-3333-4333-8333-333333333333";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function apply(state: ReturnType<typeof createEmptyConversationCommerceState>, text: string, id: string) {
  return reduceTurn(state, {
    conversation_id: conversation,
    company_id: company,
    source_message_id: id,
    text,
    language: "zh-TW",
  }, buildCommerceEntityHints([text]));
}

const fashion = extractGenericCommerceEntity("我要2件黑色T-shirt，M碼。");
assert(fashion?.entity_id === "generic:t-shirt", `fashion generic id mismatch: ${fashion?.entity_id}`);
assert(fashion?.quantity === 2, "fashion quantity mismatch");
assert(fashion?.variant.size === "M", "fashion size variant missing");
assert(fashion?.variant.color === "黑色", "fashion color variant missing");
assert(fashion?.kind === "physical_product", "fashion kind mismatch");

const beauty = extractGenericCommerceEntity("我要3樽精華液。");
assert(beauty?.entity_id === "generic:精華液" && beauty.quantity === 3, "beauty extraction failed");

const grocery = extractGenericCommerceEntity("我要2盒牛奶。");
assert(grocery?.entity_id === "generic:牛奶" && grocery.quantity === 2, "grocery extraction failed");

const digital = extractGenericCommerceEntity("我要1個software license，下載版。");
assert(digital?.kind === "digital_good", "digital kind failed");
assert(digital?.capabilities.digital_fulfilment === true, "digital capability failed");
assert(digital?.capabilities.requires_installation === false, "digital must not inherit installation");

const service = extractGenericCommerceEntity("我想預約2位剪髮，星期五。");
assert(service?.kind === "service", "service kind failed");
assert(service?.capabilities.requires_booking === true, "service booking capability failed");

const b2b = extractGenericCommerceEntity("我要100箱紙杯，請報價。");
assert(b2b?.kind === "b2b_product", "B2B kind failed");
assert(b2b?.capabilities.requires_quote === true, "B2B quote capability failed");

let fashionState = apply(createEmptyConversationCommerceState(), "我要2件黑色T-shirt，M碼。", "33333333-3333-4333-8333-333333333301");
assert(fashionState.entities.length === 1, "fashion state entity missing");
assert(fashionState.entities[0].quantity === 2, "fashion state quantity failed");
assert(fashionState.entities[0].category === "generic_product", "fashion category must be generic_product");
assert(getEntityCapabilities(fashionState.entities[0]).requires_installation === false, "fashion must not require installation");
const fashionReply = buildPreorderUnpaidAnswer("zh-TW", fashionState);
assert(!/(?:安裝|師傅|现场|現場)/i.test(fashionReply), "fashion preorder leaked appliance workflow");
assert(/最終價格/.test(fashionReply) && /付款/.test(fashionReply), "fashion preorder missing generic next step");

let serviceState = apply(createEmptyConversationCommerceState(), "我想預約2位剪髮，星期五。", "33333333-3333-4333-8333-333333333302");
const serviceReply = buildPreorderUnpaidAnswer("zh-TW", serviceState);
assert(/預約時段/.test(serviceReply), "service preorder missing booking-aware next step");
assert(!/安裝/.test(serviceReply), "service preorder leaked installation");

let b2bState = apply(createEmptyConversationCommerceState(), "我要100箱紙杯，請報價。", "33333333-3333-4333-8333-333333333303");
assert(b2bState.entities[0].quantity === 100, "B2B quantity state failed");
assert(getEntityCapabilities(b2bState.entities[0]).requires_quote === true, "B2B state quote capability failed");

let additiveState = apply(createEmptyConversationCommerceState(), "我要2盒牛奶。", "33333333-3333-4333-8333-333333333304");
additiveState = apply(additiveState, "另外加1盒牛奶。", "33333333-3333-4333-8333-333333333305");
assert(additiveState.entities.length === 1 && additiveState.entities[0].quantity === 3, "generic additive quantity failed");
additiveState = apply(additiveState, "更正，唔係3盒，係2盒。", "33333333-3333-4333-8333-333333333306");
assert(additiveState.entities[0].quantity === 2, "generic correction failed");

const applianceHints = buildCommerceEntityHints(["我睡房有2部冷氣。"]).filter((x) => x.entity_id === "air_conditioner:bedroom");
assert(applianceHints.length === 1, "legacy appliance profile regressed");
let applianceState = reduceTurn(createEmptyConversationCommerceState(), {
  conversation_id: conversation,
  company_id: company,
  source_message_id: "33333333-3333-4333-8333-333333333307",
  text: "我睡房有2部冷氣。",
  language: "zh-TW",
}, applianceHints);
assert(applianceState.entities[0]?.quantity === 2, "legacy appliance quantity regressed");

assert(requiresProfessionalSiteCheck("窗口夠唔夠安全安裝冷氣？") === true, "appliance safety routing regressed");
assert(requiresProfessionalSiteCheck("想預約師傅上門按摩") === false, "generic service was misrouted to installation site check");

const priceReply = buildCurrentPriceValidityAnswer("zh-TW");
assert(!/(?:安裝|工程)/.test(priceReply), "generic current-price answer leaked appliance terms");
assert(/適用費用/.test(priceReply), "generic current-price answer missing applicable fees");

console.log(JSON.stringify({
  status: "PASS",
  gate: "TASK_A3_GENERIC_CAPABILITY_RUNTIME",
  cases: 12,
  assertions: {
    fashion_product_variant: true,
    beauty_product: true,
    grocery_product: true,
    digital_good: true,
    service_booking: true,
    b2b_quote: true,
    generic_state_persistence: true,
    generic_additive_and_correction: true,
    appliance_profile_preserved: true,
    capability_aware_preorder: true,
    service_not_installation_misroute: true,
    generic_price_reply: true
  }
}));
