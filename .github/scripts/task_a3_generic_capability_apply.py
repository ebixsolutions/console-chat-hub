from pathlib import Path

runtime_path = Path("supabase/functions/_shared/commerce-state-runtime.ts")
capability_path = Path("supabase/functions/_shared/commerce-capability-runtime.ts")
gate_path = Path(".github/scripts/task_a3_final_gate.mjs")
test_path = Path(".github/scripts/task_a3_generic_capability_runtime_test.ts")

runtime = runtime_path.read_text()
capability = capability_path.read_text()
gate = gate_path.read_text()

# Tighten generic variant extraction in the already-added capability module.
capability = capability.replace(
    r'''  const size = t.match(/(?:size|尺寸|尺碼|尺码)\s*(?:=|:|：)?\s*([A-Z0-9-]{1,12})/i)
    ?? t.match(/\b([XSML]{1,4})\s*碼\b/i);''',
    r'''  const size = t.match(/(?:size|尺寸|尺碼|尺码)\s*(?:=|:|：)?\s*([A-Z0-9-]{1,12})/i)
    ?? t.match(/\b([XSML]{1,4})\s*碼/i);''',
)
capability = capability.replace(
    r'''    const leading = t.match(/(?:^|\s)(黑色|白色|紅色|红色|藍色|蓝色|綠色|绿色|黃色|黄色|粉紅|粉红|紫色|灰色|black|white|red|blue|green|yellow|pink|purple|grey|gray)(?=\s|[A-Za-z\u3400-\u9fff])/i);''',
    r'''    const leading = t.match(/(黑色|白色|紅色|红色|藍色|蓝色|綠色|绿色|黃色|黄色|粉紅|粉红|紫色|灰色|black|white|red|blue|green|yellow|pink|purple|grey|gray)(?=\s|[A-Za-z\u3400-\u9fff])/i);''',
)

old = '''import {
  type CommerceAnswerAuthority,
  type CommerceCalculationTerm,
  resolveCommerceAnswerAuthority,
} from "./commerce-state-authority.ts";'''
new = '''import {
  type CommerceAnswerAuthority,
  type CommerceCalculationTerm,
  resolveCommerceAnswerAuthority,
} from "./commerce-state-authority.ts";
import {
  buildCapabilityAwarePreorderNextStep,
  buildGenericCommerceEntityHints,
  genericEntityLabelFromId,
} from "./commerce-capability-runtime.ts";'''
assert old in runtime, "STOP: capability import baseline mismatch"
runtime = runtime.replace(old, new, 1)

runtime = runtime.replace(
    " * This module is the ONLY place where industry/appliance-specific extraction is\n * allowed. A1 (contract) and A2 (reducer + authority) stay frozen and universal.",
    " * This module owns capability-driven commerce extraction plus optional industry\n * profiles. A1 (contract) and A2 (reducer + authority) stay frozen and universal.",
    1,
)
runtime = runtime.replace(
    " * A3 runtime extraction (industry-specific, intentionally NOT in A2)",
    " * A3 runtime extraction (generic capability layer + optional industry profiles)",
    1,
)

old = '''function entityLabel(entityId: string, language: CommerceLanguage): string {
  const [categoryKey, roomKey] = entityId.split(":");
  const category = CATEGORY_SPECS.find((x) => x.key === categoryKey);
  const room = ROOM_SPECS.find((x) => x.key === roomKey);
  const categoryText = category ? category.label[language] : clean(categoryKey, 60);
  if (!room) return categoryText;
  return language === "en"
    ? `${room.label.en} ${categoryText}`
    : `${room.label[language]}${categoryText}`;
}'''
new = '''function entityLabel(entityId: string, language: CommerceLanguage): string {
  const generic = genericEntityLabelFromId(entityId);
  if (generic) return generic;
  const [categoryKey, roomKey] = entityId.split(":");
  const category = CATEGORY_SPECS.find((x) => x.key === categoryKey);
  const room = ROOM_SPECS.find((x) => x.key === roomKey);
  const categoryText = category ? category.label[language] : clean(categoryKey, 60);
  if (!room) return categoryText;
  return language === "en"
    ? `${room.label.en} ${categoryText}`
    : `${room.label[language]}${categoryText}`;
}'''
assert old in runtime, "STOP: entityLabel baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''/** Build entity hints from the whole conversation so state survives topic drift. */
export function buildCommerceEntityHints(texts: string[]): CommerceTurnEntityHint[] {
  const hints = new Map<string, CommerceTurnEntityHint>();
  for (const raw of texts) {
    const text = clean(raw);
    if (!text) continue;
    const categories = detectCategories(text);
    if (!categories.length) continue;
    const rooms = detectRooms(text);
    for (const category of categories) {
      const scopes = rooms.length ? rooms : [null];
      for (const room of scopes) {
        const entityId = room ? `${category.key}:${room.key}` : `${category.key}:unscoped`;
        if (hints.has(entityId)) continue;
        hints.set(entityId, {
          entity_id: entityId,
          category: category.key,
          aliases: [...category.aliases, ...(room ? room.aliases : [])],
        });
      }
    }
  }
  return [...hints.values()];
}'''
new = '''/** Build entity hints from the whole conversation so state survives topic drift. */
export function buildCommerceEntityHints(texts: string[]): CommerceTurnEntityHint[] {
  const hints = new Map<string, CommerceTurnEntityHint>();
  for (const raw of texts) {
    const text = clean(raw);
    if (!text) continue;
    const categories = detectCategories(text);
    if (categories.length) {
      const rooms = detectRooms(text);
      for (const category of categories) {
        const scopes = rooms.length ? rooms : [null];
        for (const room of scopes) {
          const entityId = room ? `${category.key}:${room.key}` : `${category.key}:unscoped`;
          if (hints.has(entityId)) continue;
          hints.set(entityId, {
            entity_id: entityId,
            category: category.key,
            aliases: [...category.aliases, ...(room ? room.aliases : [])],
          });
        }
      }
      continue;
    }
    for (const hint of buildGenericCommerceEntityHints([text])) {
      const existing = hints.get(hint.entity_id);
      if (!existing) hints.set(hint.entity_id, hint);
      else hints.set(hint.entity_id, {
        ...existing,
        aliases: [...new Set([...(existing.aliases ?? []), ...(hint.aliases ?? [])])],
        attributes: { ...(existing.attributes ?? {}), ...(hint.attributes ?? {}) },
      });
    }
  }
  return [...hints.values()];
}'''
assert old in runtime, "STOP: buildCommerceEntityHints baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''function hintsMentionedInTurn(text: string, hints: CommerceTurnEntityHint[]): CommerceTurnEntityHint[] {
  const lower = clean(text).toLowerCase();
  const rooms = detectRooms(text);
  const categories = detectCategories(text).map((x) => x.key);
  return hints.filter((hint) => {
    if (!categories.includes(hint.category)) return false;
    const [, roomKey] = hint.entity_id.split(":");
    if (!rooms.length) return true;
    if (roomKey === "unscoped") return false;
    return rooms.some((room) => room.key === roomKey) || Boolean(lower) === false;
  });
}'''
new = '''function hintsMentionedInTurn(text: string, hints: CommerceTurnEntityHint[]): CommerceTurnEntityHint[] {
  const lower = clean(text).toLowerCase();
  const rooms = detectRooms(text);
  const categories = detectCategories(text).map((x) => x.key);
  return hints.filter((hint) => {
    if (hint.entity_id.startsWith("generic:")) {
      return (hint.aliases ?? []).some((alias) => {
        const normalized = clean(alias, 80).toLowerCase();
        return normalized.length >= 2 && lower.includes(normalized);
      });
    }
    if (!categories.includes(hint.category)) return false;
    const [, roomKey] = hint.entity_id.split(":");
    if (!rooms.length) return true;
    if (roomKey === "unscoped") return false;
    return rooms.some((room) => room.key === roomKey) || Boolean(lower) === false;
  });
}'''
assert old in runtime, "STOP: hintsMentionedInTurn baseline mismatch"
runtime = runtime.replace(old, new, 1)

runtime = runtime.replace(
    'const COUNT_UNIT = "部|台|件|個|个|套|張|张|units?|pcs?|pieces?";',
    'const COUNT_UNIT = "部|台|件|個|个|套|張|张|盒|箱|包|袋|樽|瓶|支|枝|本|冊|册|對|对|雙|双|條|条|份|位|席|間|间|晚|次|堂|課|课|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?";',
    1,
)
runtime = runtime.replace(
    r'''/(?:改(?:做|成|返)?|變成|变成|change to|要|need|order)?\s*([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|張|张|units?|pcs?|pieces?)/i,''',
    r'''/(?:改(?:做|成|返)?|變成|变成|change to|要|need|order)?\s*([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|張|张|盒|箱|包|袋|樽|瓶|支|枝|本|冊|册|對|对|雙|双|條|条|份|位|席|間|间|晚|次|堂|課|课|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?)/i,''',
    1,
)

old = '''function requiresProfessionalSiteCheck(text: string): boolean {
  return (
    /(?:啲|個|个)?(?:窗口|窗台|牆|墙|電壓|电压|排水|承重)/i.test(text) &&
    /(?:得唔得|可以嗎|可以吗|夠唔夠|够不够|安全|裝得|装得|OK嗎|ok\?|feasible|可行|支持|support)/i.test(text)
  ) || /(?:上門|上门|師傅|师傅|onsite|on-site|site (?:visit|survey)|technician)/i.test(text);
}'''
new = '''export function requiresProfessionalSiteCheck(text: string): boolean {
  const structural = /(?:啲|個|个)?(?:窗口|窗台|牆|墙|電壓|电压|排水|承重|wall strength|structural|voltage|drainage)/i.test(text)
    && /(?:得唔得|可以嗎|可以吗|夠唔夠|够不够|安全|裝得|装得|OK嗎|ok\?|feasible|可行|支持|support)/i.test(text);
  const installation = /(?:安裝|安装|installation|install|mount|拆機|拆机|dismantle)/i.test(text)
    && /(?:上門|上门|師傅|师傅|onsite|on-site|site (?:visit|survey)|technician|安全|可行|feasible)/i.test(text);
  return structural || installation;
}'''
assert old in runtime, "STOP: professional site check baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''  const preorder = /(?:想預訂|想预订|想訂|想订|要預訂|要预订|預訂|预订|reserve|reservation|pre[- ]?order|want to order|place an order)/i.test(t);'''
new = '''  const preorder = /(?:想預訂|想预订|想訂|想订|要預訂|要预订|預訂|预订|想預約|想预约|要預約|要预约|預約|预约|reserve|reservation|book(?:ing)?|pre[- ]?order|want to order|place an order)/i.test(t);'''
assert old in runtime, "STOP: preorder detector baseline mismatch"
runtime = runtime.replace(old, new, 1)

runtime = runtime.replace(
    'tail: { "zh-TW": "最新價格同工程費用仍然要同事確認之後才作準。", "zh-CN": "最新价格与工程费用仍需同事确认后才作准。", en: "Latest pricing and engineering fees still need to be confirmed by our team." },',
    'tail: { "zh-TW": "最新價格、適用費用同相關條件仍然要確認之後先作準。", "zh-CN": "最新价格、适用费用及相关条件仍需确认后才作准。", en: "Latest pricing, applicable fees and relevant conditions still need to be confirmed." },',
    1,
)

old = '''function buildQuantityAnswer(state: ConversationCommerceState, language: CommerceLanguage): string | null {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  if (!active.length) return null;
  const total = active.reduce((sum, e) => sum + e.quantity, 0);
  const breakdown = active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、");
  if (language === "en") return `You currently have ${total} unit(s) in total: ${breakdown}.`;
  if (language === "zh-CN") return `你目前合共 ${total} 部：${breakdown}。`;
  return `你而家合共 ${total} 部：${breakdown}。`;
}'''
new = '''function buildQuantityAnswer(state: ConversationCommerceState, language: CommerceLanguage): string | null {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  if (!active.length) return null;
  const total = active.reduce((sum, e) => sum + e.quantity, 0);
  const breakdown = active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、");
  if (language === "en") return `You currently have ${total} unit(s) in total: ${breakdown}.`;
  if (language === "zh-CN") return `你目前合共 ${total} 个单位：${breakdown}。`;
  return `你而家合共 ${total} 個單位：${breakdown}。`;
}'''
assert old in runtime, "STOP: quantity answer baseline mismatch"
runtime = runtime.replace(old, new, 1)

runtime = runtime.replace(
    'if (language === "en") return `Based only on the figures in this calculation: ${rendered} (${currency}). Latest prices and engineering fees still need to be confirmed by our team.`;\n  if (language === "zh-CN") return `只按你这次提供的数字计算：${rendered}（${currency}）。最新价格与工程费用仍需同事确认。`;\n  return `只按你今次提供嘅數字計：${rendered}（${currency}）。最新價格同工程費用仍然要同事確認。`;',
    'if (language === "en") return `Based only on the figures in this calculation: ${rendered} (${currency}). Latest prices, applicable fees and conditions still need to be confirmed.`;\n  if (language === "zh-CN") return `只按你这次提供的数字计算：${rendered}（${currency}）。最新价格、适用费用及相关条件仍需确认。`;\n  return `只按你今次提供嘅數字計：${rendered}（${currency}）。最新價格、適用費用同相關條件仍然要確認。`;',
    1,
)

old = '''export function buildCurrentPriceValidityAnswer(language: CommerceLanguage): string {
  if (language === "en") return "Not necessarily. A previous quote is only a reference and does not guarantee the current price. The latest product price and any installation or engineering charges need to be confirmed again before they are final.";
  if (language === "zh-CN") return "未必。你之前看到的报价只可作为参考，并不代表目前仍是同一价格。最新产品价格及安装／工程费用需要重新确认后才作准。";
  return "未必。你之前見過嘅報價只可以作參考，唔代表而家仍然係同一個價。最新產品價格同安裝／工程費用需要重新確認後先作準。";
}'''
new = '''export function buildCurrentPriceValidityAnswer(language: CommerceLanguage): string {
  if (language === "en") return "Not necessarily. A previous quote is only a reference and does not guarantee the current price. The latest price, applicable fees and relevant conditions need to be confirmed again before they are final.";
  if (language === "zh-CN") return "未必。你之前看到的报价只可作为参考，并不代表目前仍是同一价格。最新价格、适用费用及相关条件需要重新确认后才作准。";
  return "未必。你之前見過嘅報價只可以作參考，唔代表而家仍然係同一個價。最新價格、適用費用同相關條件需要重新確認後先作準。";
}'''
assert old in runtime, "STOP: current price answer baseline mismatch"
runtime = runtime.replace(old, new, 1)

old = '''export function buildPreorderUnpaidAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  if (language === "en") return `${known ? `Got it — you want to reserve ${known}. ` : "Got it — you want to make a reservation. "}Since payment has not been made yet, this is not a completed or confirmed order. The next step is to confirm the final quote, installation requirements and payment arrangement.`;
  if (language === "zh-CN") return `${known ? `好的，我知道你想预订${known}。` : "好的，我知道你想预订。"}由于目前还未付款，所以现在还不算已完成或已确认订单。下一步需要先确认最终报价、安装条件及付款安排。`;
  return `${known ? `好，我知道你想預訂${known}。` : "好，我知道你想預訂。"}因為你仲未付款，所以而家未算完成或已確認訂單。下一步要先確認最終報價、安裝條件同付款安排。`;
}'''
new = '''export function buildPreorderUnpaidAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  const nextStep = buildCapabilityAwarePreorderNextStep(state, language);
  if (language === "en") return `${known ? `Got it — you want to reserve ${known}. ` : "Got it — you want to proceed. "}Since payment has not been made yet, this is not a completed or confirmed order. ${nextStep}`;
  if (language === "zh-CN") return `${known ? `好的，我知道你想预订${known}。` : "好的，我知道你想继续预订。"}由于目前还未付款，所以现在还不算已完成或已确认订单。${nextStep}`;
  return `${known ? `好，我知道你想預訂${known}。` : "好，我知道你想繼續預訂。"}因為你仲未付款，所以而家未算完成或已確認訂單。${nextStep}`;
}'''
assert old in runtime, "STOP: preorder answer baseline mismatch"
runtime = runtime.replace(old, new, 1)

runtime_path.write_text(runtime)
capability_path.write_text(capability)

test_path.write_text(r'''import {
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
''')

old_files = '''  runtime: "supabase/functions/_shared/commerce-state-runtime.ts",
  contract: "supabase/functions/_shared/commerce-state-contract.ts",'''
new_files = '''  runtime: "supabase/functions/_shared/commerce-state-runtime.ts",
  capability: "supabase/functions/_shared/commerce-capability-runtime.ts",
  contract: "supabase/functions/_shared/commerce-state-contract.ts",'''
assert old_files in gate, "STOP: final-gate files baseline mismatch"
gate = gate.replace(old_files, new_files, 1)

old_exec = '''execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_hotfix7_customer_reply_test.ts"], { stdio: "inherit" });
execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.contract, files.reducer, files.authority], { stdio: "inherit" });'''
new_exec = '''execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_hotfix7_customer_reply_test.ts"], { stdio: "inherit" });
execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_generic_capability_runtime_test.ts"], { stdio: "inherit" });
execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.capability, files.contract, files.reducer, files.authority], { stdio: "inherit" });'''
assert old_exec in gate, "STOP: final-gate command baseline mismatch"
gate = gate.replace(old_exec, new_exec, 1)

gate_path.write_text(gate)
print("A3 GENERIC CAPABILITY APPLY PASS")
