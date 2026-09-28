import { classifyHandoffIntent as classifyR1 } from "./conversation-intelligence.ts";
import { classifyHandoffIntent as classifyGate } from "./handoff-intent.ts";
import { arbitrateAnaphoricProductFollowUp } from "./natural-customer-response.ts";
import { resolveWorkflow5ConversationLanguage } from "./conversation-runtime-state-core.ts";
import { deriveTypedCustomerCalculation } from "./conversation-service-runtime.ts";
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { acknowledgeCurrentCustomerDimensions, buildCommerceEntityHints, reduceTurn } from "./commerce-state-runtime-base.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("explicit handoff wins over a separate prior-reference or defer clause", () => {
  for (const text of [
    "我想轉真人客服。因為你剛才冇總結到我嘅要求。",
    "先暫緩個訂閱，但我而家想轉真人客服。",
  ]) {
    assert(classifyR1(text).explicit_request, `R1: ${text}`);
    assert(classifyGate(text).explicit_request, `gate: ${text}`);
  }
  for (const text of [
    "唔使轉真人。",
    "真人客服幾點有人？",
    "不要轉真人客服，但我而家要轉真人",
  ]) {
    assert(!classifyR1(text).explicit_request, `false R1: ${text}`);
    assert(!classifyGate(text).explicit_request, `false gate: ${text}`);
  }
});

Deno.test("explicit language directives retain customer language intent", () => {
  assert(resolveWorkflow5ConversationLanguage(
    "書房改咗105呎；please explain briefly in English how I should assess it.",
    [],
  ) === "en", "English override lost");
  assert(resolveWorkflow5ConversationLanguage(
    "可唔可以用廣東話兩句講返我而家嘅要求？", [],
  ) === "zh-TW", "Cantonese override lost");
});

Deno.test("explicit return to a prior model crosses a category-only topic switch", () => {
  const result = arbitrateAnaphoricProductFollowUp(
    "另一樣先暫緩。講返嗰部先，咁佢夠唔夠用？",
    [
      { role: "visitor", content: "另外想睇雪櫃，廚房最多610mm闊？" },
      { role: "visitor", content: "想揀窗口冷氣；見到 CW-SUL70BA，幾多匹？" },
    ],
  );
  assert(result.kind === "resolved" && result.intent.product === "CW-SUL70BA", "referent not restored");
  const ambiguous = arbitrateAnaphoricProductFollowUp(
    "講返嗰部，佢夠唔夠用？",
    [
      { role: "visitor", content: "型號 ZX-10001 或 ZX-10002，你推薦邊款？" },
    ],
  );
  assert(ambiguous.kind !== "resolved", "ambiguous referent was invented");
});

function sampleState(categories: Array<[string, number]>): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.entities = categories.map(([category, quantity]) => ({
    entity_id: `generic:${category}`, category, model: null, brand: null,
    quantity, status: "researching", attributes: {}, constraints: {},
    provenance: { source_type: "customer", source_message_id: "prior", recorded_at: null },
  }));
  return state;
}

function turn(state: ConversationCommerceState, source: string, content: string) {
  return reduceTurn(state, {
    conversation_id: "conversation-a", company_id: "tenant-a",
    source_message_id: source, text: content, language: "en",
  }, state.entities.map((e) => ({ entity_id: e.entity_id, category: e.category, aliases: [e.category] })));
}

Deno.test("booking and parking compound operation is scoped and atomic", () => {
  const before = sampleState([["booking", 2], ["parking", 1]]);
  const after = turn(before, "book-2", "Defer parking. Change booking to 3 nights; is that booking available?");
  assert(after.entities[0].quantity === 3, "booking correction lost");
  assert(after.entities[1].status === "deferred", "parking defer lost");
  assert(after.entities[0].status !== "deferred" && after.entities[0].status !== "cancelled", "booking contaminated");
  assert(after.quotes.length === 0 && after.conversion.order_status === "none", "question promoted a transaction");
  assert(after.entities.every((e) => e.provenance.source_message_id === "book-2"), "source binding lost");
  assert(JSON.stringify(turn(after, "book-2", "Defer parking. Change booking to 3 nights; is that booking available?")) === JSON.stringify(after), "replay changed state");
  assert(turn(before, "conflict", "Defer parking. Cancel parking.").entities[1].status === "researching", "conflicting operations partially applied");
  assert(turn(before, "question", "Should I defer parking?").entities[1].status === "researching", "question mutated lifecycle");
});

Deno.test("subscription and add-on state survives billing detour and an English return", () => {
  let state = sampleState([["subscription", 5], ["addon", 1]]);
  state.current_topic = "billing";
  state = turn(state, "saas-2", "Defer addon. Change subscription to 8 seats; back to subscription, give me a short English summary.");
  assert(state.entities[0].quantity === 8 && state.entities[1].status === "deferred", "SaaS compound state lost");
  assert(state.current_topic === "subscription", "subscription referent not restored");
  assert(state.conversion.payment_status === "none", "billing topic became a payment");
});

Deno.test("customer subscription limit persists while billing policy stays with KB", () => {
  const frame: CommerceSemanticFrame = {
    version: "commerce-semantic-1.0.0", language: "en", operation: "ASK_FACT",
    intent: "billing enquiry", topic: "subscription",
    entities: [{ entity_ref: "subscription", name: "subscription", kind: "subscription",
      category_hint: "subscription", sku: null, model: null, quantity: null, unit: null,
      attributes: {}, constraints: { seat_limit: 8, billing_policy: "guaranteed" }, confidence: 0.95,
      capabilities: { requires_delivery: false, supports_pickup: false, requires_installation: false,
        requires_booking: false, requires_quote: false, requires_site_check: false,
        digital_fulfilment: true, recurring_billing: true, rental_return: false, customization: false } }],
    referents: [], customer_correction: false, additive: false, explicit_negations: [],
    requested_facts: ["billing policy"], transaction_state: "none", payment_state: "none",
    booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.94,
  };
  const before = sampleState([["subscription", 2]]);
  const after = reduceTurn(before, { conversation_id: "c", company_id: "tenant-a",
    source_message_id: "mixed-1", text: "For the subscription, our seat limit is 8; what is your billing policy?",
    language: "en", semantic_frame: frame,
  }, [{ entity_id: "generic:subscription", category: "subscription", aliases: ["subscription"] }]);
  assert(after.entities[0].constraints.seat_limit === 8, "customer limit lost on KB question");
  assert(after.entities[0].constraints.billing_policy === undefined, "merchant policy invented from model");
  assert(after.entities[0].provenance.source_message_id === "mixed-1", "customer source lost");
  assert(after.conversion.order_status === "none", "billing question became order");
});

Deno.test("real failed dialogue reducer class keeps entity constraints and correction separate", () => {
  const texts = [
    "早晨，我間書房大約95呎，想揀部窗口冷氣。見到樂聲 CW-SUL70BA，呢款係幾多匹，同埋有咩主要功能？",
    "另外想順便睇雪櫃，廚房個位最多610mm闊，雙門款有冇啲方向？",
    "雪櫃先擺低啦。講返書房嗰部先，我頭先量錯，書房其實係105呎；咁要點評估佢夠唔夠？",
  ];
  let state = createEmptyConversationCommerceState();
  const history: string[] = [];
  for (const [index, text] of texts.entries()) {
    state = reduceTurn(state, {
      conversation_id: "demo-replay", company_id: "tenant-a",
      source_message_id: `demo-${index}`, text, language: "zh-TW",
      history: history.map((content) => ({ role: "visitor", content })),
      trusted_product_topic_focus: index === 2
        ? { topic: "air_conditioner", product: "CW-SUL70BA", resolution_strategy: "PER_TOPIC_REFERENT_HISTORY" }
        : null,
    }, buildCommerceEntityHints([text, ...history]));
    history.unshift(text);
  }
  const ac = state.entities.filter((entity) => entity.category === "air_conditioner");
  const fridge = state.entities.filter((entity) => entity.category === "refrigerator");
  assert(ac.length === 1 && fridge.length === 1, "duplicate or missing entities");
  assert(ac[0].attributes.room_sizes && (ac[0].attributes.room_sizes as Record<string, string>).study === "105平方呎", "scoped correction lost");
  assert(fridge[0].constraints.max_width_mm === 610 && !ac[0].constraints.max_width_mm, "width crossed entity boundary");
  const beforeDefer = structuredClone(state);
  beforeDefer.current_topic = "refrigerator";
  beforeDefer.entities[1].status = "researching";
  assert(acknowledgeCurrentCustomerDimensions(beforeDefer, "zh-TW")?.includes("610 mm"), "known customer condition missing before KB conflict");
  assert(fridge[0].status === "deferred" && ac[0].status !== "deferred", "defer contaminated prior topic");
  assert(state.current_topic === "air_conditioner", "return to prior topic failed");
  assert(state.latest_corrections.length > 0 && !JSON.stringify(ac[0].attributes).includes("95平方呎"), "old value revived");
});

Deno.test("frozen natural dialogue inputs progress through ten turns with human control after first R1", () => {
  const turns = [
    "早晨，我間書房大約95呎，想揀部窗口冷氣。見到樂聲 CW-SUL70BA，呢款係幾多匹，同埋有咩主要功能？",
    "咁嗰部擺喺95呎書房夠唔夠？個窗下午幾曬。",
    "另外想順便睇雪櫃，廚房個位最多610mm闊，雙門款有冇啲方向？",
    "雪櫃先擺低啦。講返書房嗰部先，我頭先量錯，書房其實係105呎；咁要點評估佢夠唔夠？",
    "就係 CW-SUL70BA，你頭先講過嗰部。書房改咗105呎；please explain briefly in English how I should assess it.",
    "OK，先唔揀型號住。可唔可以用廣東話兩句講返我而家嘅冷氣同雪櫃要求？",
    "總結先放埋一邊。如果純粹用我假設嘅舊價，每部 HK$4,750，三部再加 HK$960 送貨費，試算係幾多？呢個唔係現行報價。",
    "朋友又傳咗個「MOONCOOL-XYZ77」型號，話佢有自動清洗。你查到可靠資料確認到嗎？",
    "我想轉真人客服接手。主要係你剛才冇總結到已講嘅要求，亦未能幫我判斷 CW-SUL70BA 放喺更正後105呎、下午曬嘅書房是否合適；請同事睇返呢段對話，雪櫃暫時唔跟。",
    "雪櫃暫緩，冷氣唔暫緩。我而家係明確要求真人客服接手，原因係前面回指同總結答錯；請幫我轉交，唔好再由 AI 問我型號。",
  ];
  let state = createEmptyConversationCommerceState();
  const history: string[] = [];
  let underHumanControl = false;
  let handoffs = 0;
  for (const [index, input] of turns.entries()) {
    const source = `natural-source-${index + 1}`;
    if (underHumanControl) {
      assert(index === 9, "unexpected extra automated turn");
      assert(classifyR1(input).explicit_request, "second human request lost");
      continue; // Human control disallows another AI answer or duplicate handoff.
    }
    if (classifyR1(input).explicit_request) {
      assert(index === 8, "explicit R1 happened on wrong turn");
      handoffs++;
      underHumanControl = true;
      continue;
    }
    if (index === 6) {
      const prior = JSON.stringify(state);
      const calculation = deriveTypedCustomerCalculation({ question: input, current_source_message_id: source });
      assert(calculation.status === "ready" && calculation.result === 15210 && calculation.current_price_authority === "NONE", "historical HKD 15,210 not calculated");
      assert(JSON.stringify(state) === prior, "hypothetical calculation mutated Commerce");
      history.unshift(input);
      continue;
    }
    if (index === 7) {
      assert(!JSON.stringify(state).includes("MOONCOOL-XYZ77"), "unknown KB model promoted to merchant fact");
      history.unshift(input);
      continue;
    }
    const language = resolveWorkflow5ConversationLanguage(input, []);
    if (index === 4) assert(language === "en", "explicit English lost");
    if (index === 5) assert(language === "zh-TW", "explicit Cantonese lost");
    state = reduceTurn(state, {
      conversation_id: "natural-replay", company_id: "tenant-a", source_message_id: source,
      text: input, language, history: history.map((content) => ({ role: "visitor", content })),
      trusted_product_topic_focus: index === 3
        ? { topic: "air_conditioner", product: "CW-SUL70BA", resolution_strategy: "PER_TOPIC_REFERENT_HISTORY" }
        : null,
    }, buildCommerceEntityHints([input, ...history]));
    history.unshift(input);
  }
  const air = state.entities.find((entity) => entity.category === "air_conditioner");
  const fridge = state.entities.find((entity) => entity.category === "refrigerator");
  assert(air?.attributes.room_sizes && (air.attributes.room_sizes as Record<string, string>).study === "105平方呎", "corrected room size lost");
  assert(fridge?.constraints.max_width_mm === 610 && fridge.status === "deferred", "deferred refrigerator state lost");
  assert(state.conversion.order_status === "none" && state.conversion.payment_status === "none", "research promoted to transaction");
  assert(handoffs === 1 && underHumanControl, "R1 control was duplicated or bypassed");
});
