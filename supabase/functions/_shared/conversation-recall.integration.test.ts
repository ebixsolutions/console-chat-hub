/** Offline integration against frozen B2 and the real runtime source. No live API calls. */
import {
  evaluateB2BeforeCommit,
  executeB2PersistenceGate,
} from "./pre-send-conversion-supervisor.ts";
import {
  prepareConversationRecall,
  resolveConversationRecall,
} from "./conversation-recall.ts";
import {
  recallFixture,
  t17ProductionFailureFixture,
} from "./conversation-recall.test.ts";
import {
  buildCommerceEntityHints,
  reduceTurn,
  resolveCommittedAddressCorrection,
  runCommerceStateRuntime,
  type CommerceStateDbClient,
} from "./commerce-state-runtime.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { isReadOnlyCurrentStateAggregateQuery } from "./commerce-state-authority.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { planConversationService, renderTargetedServiceQuestion } from "./conversation-service-planner.ts";
import { buildCanonicalConversationMemory } from "./conversation-long-memory.ts";

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}

function authoritativeAddressFrame(customer_correction: boolean): CommerceSemanticFrame {
  return {
    version: "commerce-semantic-1.0.0",
    language: "zh-TW",
    operation: "NO_STATE_CHANGE",
    intent: customer_correction ? "correct delivery address" : "set delivery address",
    topic: "delivery address",
    entities: [],
    referents: [],
    customer_correction,
    additive: false,
    explicit_negations: [],
    requested_facts: [],
    transaction_state: "none",
    payment_state: "none",
    booking_state: "none",
    fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
    confidence: 0.95,
  };
}

async function executeAddressCorrection(
  previous: ReturnType<typeof createEmptyConversationCommerceState>,
  text: string,
  source_message_id: string,
  semantic_frame: CommerceSemanticFrame = authoritativeAddressFrame(true),
) {
  let persisted = previous;
  const db: CommerceStateDbClient = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { revision: 40, state: previous }, error: null }) }),
      }),
    }),
    rpc: async (_name, params) => {
      persisted = params.p_state as typeof previous;
      return { data: { result: "success", applied_revision: 41 }, error: null };
    },
  };
  const outcome = await runCommerceStateRuntime(db, {
    conversation_id: "40000000-0000-4000-8000-000000000001",
    company_id: "40000000-0000-4000-8000-000000000002",
    source_message_id,
    text,
    language: "zh-TW",
    semantic_frame,
  });
  return { outcome, persisted };
}

const canonicalTurns1To17 = [
  "Hi，想問冷氣，兩間房加個廳，唔知買咩匹數好。",
  "兩間房大概80呎同100呎，廳180呎，全部窗口位，本身都係窗口機。",
  "細房應該1匹，大房同廳我唔知。",
  "我唔想太貴，格力、美的、Panasonic都得。",
  "仲有呀，我屋企下午西斜得幾勁。",
  "你而家記得我要幾多部冷氣？",
  "先唔好理個廳，我想問細房有冇1匹窗口變頻。",
  "Panasonic有冇？",
  "如果產品頁有機價，係咪即係包安裝？",
  "哦，即係機價同安裝要分開確認啦。",
  "我之前問你同事，佢話格力 GWF12P $5788，安裝550，鋁架550。",
  "之後胡小姐又話如果兩部可以5600一部。",
  "咁兩部連安裝同架，按我頭先提供嘅舊報價計幾錢？",
  "等等，我而家可能唔係兩部匹半喎。",
  "改做一部1匹，一部1.5匹。",
  "客廳嗰部暫時唔買住。",
  "咁我而家實際買幾多部冷氣？",
] as const;

Deno.test("C3 exact canonical T006 recalls aggregate quantity from prior room allocation", () => {
  let state = createEmptyConversationCommerceState();
  for (let index = 0; index < 6; index++) {
    const text = canonicalTurns1To17[index];
    state = reduceTurn(state, {
      conversation_id: "06000000-0000-4000-8000-000000000001",
      company_id: "06000000-0000-4000-8000-000000000002",
      source_message_id: `06000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text,
      language: "zh-TW",
      history: canonicalTurns1To17.slice(0, index).reverse().map((content) => ({
        role: "visitor",
        content,
      })),
    }, buildCommerceEntityHints([
      text,
      ...canonicalTurns1To17.slice(0, index).reverse(),
    ]));
  }

  const input = {
    conversation_id: "06000000-0000-4000-8000-000000000001",
    company_id: "06000000-0000-4000-8000-000000000002",
    source_message_id: "06000000-0000-4000-8000-000000000006",
    question: canonicalTurns1To17[5],
    memory: null,
    commerce: {
      conversation_id: "06000000-0000-4000-8000-000000000001",
      company_id: "06000000-0000-4000-8000-000000000002",
      source_message_id: "06000000-0000-4000-8000-000000000006",
      revision: 6,
      state,
    },
  };
  const route = prepareConversationRecall(input, "zh-TW");
  assert(route.decision.handled, JSON.stringify(route.decision));
  assert(route.decision.value === 3, JSON.stringify(route.decision));
  assert(route.reply?.includes("3 部"), route.reply ?? "missing reply");
});
Deno.test("C3 quantity recall remains unknown without an explicit scoped count", () => {
  const input = recallFixture("我而家要幾多部冷氣？");
  input.commerce!.state.entities = [];
  input.memory!.active_entities = [];
  input.memory!.current_customer_facts = [];
  const decision = resolveConversationRecall(input);
  assert(
    !decision.handled && decision.reason === "AMBIGUOUS" &&
      decision.detail === "MISSING_QUANTITY",
    JSON.stringify(decision),
  );
});

Deno.test("C3 exact T050 recalls all retained room sizes written with shared colloquial units", () => {
  const seed = recallFixture("幾大？");
  // Exact earlier correction shape present at T050. It is intentionally not
  // parseable as a replacement pair, but it is unrelated to room dimensions.
  seed.commerce!.state.latest_corrections = [
    "其實一部舊機拆，另一間房本身冇機。",
  ];
  const source = seed.source_message_id;
  const memory = buildCanonicalConversationMemory({
    previous: null,
    conversation_id: seed.conversation_id,
    company_id: seed.company_id,
    source_message_id: source,
    commerce_state_revision: seed.commerce!.revision,
    commerce_state: seed.commerce!.state,
    newest_first: [
      { id: source, role: "visitor", content: "幾大？" },
      { id: "50000000-0000-4000-8000-000000000049", role: "visitor", content: "唔洗再問我房幾大，我頭先講過。" },
      { id: "50000000-0000-4000-8000-000000000002", role: "visitor", content: "兩間房大概80呎同100呎，廳180呎，全部窗口位，本身都係窗口機。" },
    ],
    visitor_turn_count: 50,
    source_created_at: "2026-09-18T00:00:00Z",
    next_memory_revision: 1,
  });
  const result = prepareConversationRecall({
    ...seed,
    question: "幾大？",
    memory,
    recent_questions: ["唔洗再問我房幾大，我頭先講過。"],
  }, "zh-TW");
  assert(result.decision.handled, JSON.stringify(result.decision));
  assert(result.reply?.includes("80") && result.reply.includes("100"), result.reply ?? "missing reply");
  assert(!result.reply?.includes("180"), result.reply ?? "missing reply");
  assert(result.metadata.response_route === "canonical_memory_recall", JSON.stringify(result.metadata));
  assert(!/[?？]|最想完成/.test(result.reply ?? ""), result.reply ?? "missing reply");
  const b2 = evaluateB2BeforeCommit({
    proposed_response: result.reply ?? "",
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id: seed.conversation_id,
      company_id: seed.company_id,
      source_message_id: source,
      commerce_state_revision: seed.commerce!.revision,
      commerce_state_source_message_id: seed.commerce!.source_message_id,
      state: seed.commerce!.state,
    },
    metadata: result.metadata,
  });
  assert(
    b2.decision === "allow",
    `T050 entered terminal B2 recovery: ${JSON.stringify(b2)}`,
  );
});

Deno.test("C3 missing room sizes remain ambiguous instead of being inferred", () => {
  const input = recallFixture("幾大？");
  input.commerce!.state.entities = [];
  input.memory!.active_entities = [];
  input.memory!.current_customer_facts = [];
  input.recent_questions = ["唔洗再問我房幾大，我頭先講過。"];
  const decision = resolveConversationRecall(input);
  assert(
    !decision.handled && decision.reason === "AMBIGUOUS" &&
      decision.detail === "MISSING_ROOM_SIZE",
    JSON.stringify(decision),
  );
});

Deno.test("C3 context-resolved English compact size paraphrase uses the canonical room-size slot", () => {
  const input = recallFixture("how big?");
  input.commerce!.state.entities = [];
  input.memory!.active_entities = [];
  input.memory!.current_customer_facts = [{
    key: "room_size",
    value: [
      { member_id: "room:a", group: "room", value: "120 square feet" },
      { member_id: "room:b", group: "room", value: "140 square feet" },
      { member_id: "living_room:a", group: "living_room", value: "220 square feet" },
    ],
    authority: "customer",
    source_message_id: "51000000-0000-4000-8000-000000000002",
    entity_id: null,
    region: null,
  }];
  input.recent_questions = ["What was the bedroom size I gave you?"];
  const result = prepareConversationRecall(input, "en");
  assert(result.decision.handled, JSON.stringify(result.decision));
  assert(result.decision.fact_type === "room_size", JSON.stringify(result.decision));
  assert(result.reply?.includes("120") && result.reply.includes("140"), result.reply ?? "missing reply");
  assert(!result.reply?.includes("220"), result.reply ?? "missing reply");
});

Deno.test("C3 incompatible current room sizes for one entity remain conflicting", () => {
  const input = recallFixture("What was the room size?");
  input.memory!.current_customer_facts = [{
    key: "room_size",
    value: "200 sqft",
    authority: "customer",
    source_message_id: "52000000-0000-4000-8000-000000000002",
    entity_id: "ac-wall",
    region: "hong_kong",
  }];
  const decision = resolveConversationRecall(input);
  assert(
    !decision.handled && decision.reason === "AMBIGUOUS" &&
      decision.detail === "CONFLICTING_ROOM_SIZE",
    JSON.stringify(decision),
  );
});

Deno.test("C3 exact T016 resolved cancellation reply outranks generic clarification", async () => {
  let prior = createEmptyConversationCommerceState();
  for (let index = 0; index < 15; index++) {
    const text = canonicalTurns1To17[index];
    prior = reduceTurn(prior, {
      conversation_id: "16000000-0000-4000-8000-000000000001",
      company_id: "16000000-0000-4000-8000-000000000002",
      source_message_id: `16000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text,
      language: "zh-TW",
      history: canonicalTurns1To17.slice(0, index).reverse().map((content) => ({ role: "visitor", content })),
    }, buildCommerceEntityHints([text, ...canonicalTurns1To17.slice(0, index).reverse()]));
  }
  let persisted = prior;
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { revision: 15, state: prior }, error: null }) }) }) }),
    rpc: async (_name, params) => {
      persisted = params.p_state as typeof prior;
      return { data: { result: "success", applied_revision: 16 }, error: null };
    },
  };
  const outcome = await runCommerceStateRuntime(db, {
    conversation_id: "16000000-0000-4000-8000-000000000001",
    company_id: "16000000-0000-4000-8000-000000000002",
    source_message_id: "16000000-0000-4000-8000-000000000016",
    text: canonicalTurns1To17[15],
    language: "zh-TW",
    history: canonicalTurns1To17.slice(0, 15).reverse().map((content) => ({ role: "visitor", content })),
    // Production passes the semantic interpreter envelope as well as the raw
    // utterance. Its generated entity reference must collapse onto the same
    // canonical scoped entity instead of surviving as a mutation shadow.
    semantic_frame: {
      version: "commerce-semantic-1.0.0",
      language: "zh-TW",
      operation: "DEFER",
      intent: "defer a room-scoped item",
      topic: "air conditioner",
      entities: [{
        entity_ref: "current:1",
        name: "客廳嗰部",
        kind: "physical_product",
        category_hint: "air_conditioner",
        sku: null,
        model: null,
        quantity: 1,
        unit: "部",
        attributes: {},
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
        confidence: 0.95,
      }],
      referents: [{ ref: "客廳嗰部", source: "persistent_state", confidence: 0.95 }],
      customer_correction: false,
      additive: false,
      explicit_negations: [],
      requested_facts: [],
      transaction_state: "none",
      payment_state: "none",
      booking_state: "none",
      fulfillment_state: "none",
      ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
      confidence: 0.95,
    },
  });
  const livingRoom = persisted.entities.find((entity) => entity.entity_id === "air_conditioner:living_room");
  const activeQuantity = persisted.entities.filter((entity) => !["cancelled", "deferred"].includes(entity.status)).reduce((total, entity) => total + entity.quantity, 0);
  assert(livingRoom?.status === "cancelled", JSON.stringify(persisted.entities));
  assert(activeQuantity === 2, JSON.stringify(persisted.entities));
  assert(outcome?.reason === "explicit_entity_status_change_applied" && outcome.reply?.includes("已取消") && outcome.reply.includes("2 部"), JSON.stringify(outcome));
  const reply = outcome?.reply ?? "";
  assert(!/[?？]|最想完成/.test(reply), reply);

  const route = outcome?.reason === "explicit_entity_status_change_applied" && outcome.reply
    ? outcome.route
    : "canonical_memory_clarification";
  assert(route === "commerce_state_answer", `unexpected response route: ${route}`);
});

Deno.test("C3 genuinely ambiguous cancellation still requests clarification", () => {
  const question = "其中一部暫時唔買住。";
  const input = recallFixture(question);
  input.commerce!.state.entities = [
    { ...input.commerce!.state.entities[0], entity_id: "air_conditioner:bedroom_a", quantity: 1, status: "tentative" },
    { ...input.commerce!.state.entities[0], entity_id: "air_conditioner:bedroom_b", quantity: 1, status: "tentative" },
  ];
  const recall = resolveConversationRecall(input);
  const plan = planConversationService({ question, language: "zh-TW", recall, memory: input.memory, commerce: input.commerce!.state });
  assert(["targeted_clarification", "partial_answer_then_question"].includes(plan.action), JSON.stringify(plan));
  assert(/[?？]/.test(renderTargetedServiceQuestion(plan, "zh-TW")), JSON.stringify(plan));
});

Deno.test("C3 exact canonical turn 17 supersedes the tentative correction before B2", () => {
  let state = createEmptyConversationCommerceState();
  for (let index = 0; index < canonicalTurns1To17.length - 1; index++) {
    const text = canonicalTurns1To17[index];
    state = reduceTurn(state, {
      conversation_id: "17000000-0000-4000-8000-000000000001",
      company_id: "17000000-0000-4000-8000-000000000002",
      source_message_id: `17000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text,
      language: "zh-TW",
      history: canonicalTurns1To17.slice(0, index).reverse().map((content) => ({
        role: "visitor",
        content,
      })),
    }, buildCommerceEntityHints([
      text,
      ...canonicalTurns1To17.slice(0, index).reverse(),
    ]));
  }
  assert(
    state.latest_corrections.at(-1)?.startsWith("改做一部1匹") === true,
    JSON.stringify(state.latest_corrections),
  );

  const active = state.entities[0];
  assert(active, "missing active entity");
  assert(active.quantity === 2, JSON.stringify(state.entities));
  assert(
    state.entities.some((entity) =>
      entity.entity_id === "air_conditioner:living_room" &&
      ["cancelled", "deferred"].includes(entity.status)
    ),
    JSON.stringify(state.entities),
  );
  const recall = prepareConversationRecall({
    conversation_id: "17000000-0000-4000-8000-000000000001",
    company_id: "17000000-0000-4000-8000-000000000002",
    source_message_id: "17000000-0000-4000-8000-000000000017",
    question: canonicalTurns1To17[16],
    memory: null,
    commerce: {
      conversation_id: "17000000-0000-4000-8000-000000000001",
      company_id: "17000000-0000-4000-8000-000000000002",
      source_message_id: "17000000-0000-4000-8000-000000000017",
      revision: 17,
      state,
    },
  }, "zh-TW");
  assert(recall.decision.handled, JSON.stringify(recall.decision));
  assert(recall.decision.value === 2, JSON.stringify(recall.decision));
  assert(recall.reply?.includes("2 部"), recall.reply ?? "missing reply");
  const decision = evaluateB2BeforeCommit({
    proposed_response: "你而家實際買 2 部冷氣；客廳嗰部已暫緩，不計入數量。",
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id: "17000000-0000-4000-8000-000000000001",
      company_id: "17000000-0000-4000-8000-000000000002",
      source_message_id: "17000000-0000-4000-8000-000000000017",
      commerce_state_revision: 17,
      commerce_state_source_message_id: "17000000-0000-4000-8000-000000000017",
      state,
    },
  });
  assert(decision.decision === "allow", JSON.stringify(decision));
});
const questions = [
  "一開始我要幾部冷氣？",
  "更正後冷氣數量是多少？",
  "我更正後的收貨地址是什麼？",
  "之前提供的房間面積是多少？",
  "What is my corrected delivery address?",
  "我偏好星期幾送貨？",
  "我之前冷氣要求幾匹？",
  "我要求的冷氣品牌是否一定要指定？",
  "舊報價 HKD 5,600 不應沿用，記得嗎？",
  "請讀回我的收貨人和聯絡電話？",
  "我現在是報價階段還是正式訂單？",
];
for (const q of questions) {
  for (const lang of ["zh-TW", "zh-CN", "en"]) {
    Deno.test(`C3 real frozen B2 semantic reply ${lang}: ${q}`, () => {
      const input = recallFixture(q);
      const route = prepareConversationRecall(input, lang);
      assert(
        route.decision.handled && route.reply,
        JSON.stringify(route.decision),
      );
      const b2 = evaluateB2BeforeCommit({
        proposed_response: route.reply,
        persistence_kind: "ai_reply",
        snapshot: {
          conversation_id: input.conversation_id,
          company_id: input.company_id,
          source_message_id: input.source_message_id,
          commerce_state_revision: input.commerce!.revision,
          commerce_state_source_message_id: input.commerce!.source_message_id,
          state: input.commerce!.state,
        },
        metadata: route.metadata,
      });
      assert(b2.decision === "allow", `${b2.code}: ${route.reply}`);
    });
  }
}
Deno.test("C3 routing metadata does not duplicate contact values", () => {
  const r = prepareConversationRecall(recallFixture("我的收貨人和電話？"));
  assert(r.reply?.includes("90000001"));
  assert(!JSON.stringify(r.metadata).includes("90000001"));
});
Deno.test("C3 exact T17 repaired reply passes frozen B2 persistence gate", () => {
  const input = t17ProductionFailureFixture();
  const route = prepareConversationRecall(input, "zh-TW");
  assert(route.decision.handled && route.reply, JSON.stringify(route.decision));
  assert(
    (route.reply.includes("2") || route.reply.includes("兩")) &&
      route.reply.includes("客廳") &&
      /取消/.test(route.reply),
    route.reply,
  );
  const b2 = evaluateB2BeforeCommit({
    proposed_response: route.reply,
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id: input.conversation_id,
      company_id: input.company_id,
      source_message_id: input.source_message_id,
      commerce_state_revision: input.commerce!.revision,
      commerce_state_source_message_id: input.commerce!.source_message_id,
      state: input.commerce!.state,
    },
    metadata: route.metadata,
  });
  assert(b2.decision === "allow", `${b2.code}: ${route.reply}`);
});

Deno.test("C3 exact T57 corrected address survives state, memory, B2, and recall", async () => {
  const { buildCanonicalConversationMemory } = await import("./conversation-long-memory.ts");
  const conversation_id = "57000000-0000-4000-8000-000000000001";
  const company_id = "57000000-0000-4000-8000-000000000002";
  const turns = [
    "地址是幸福邨A座12樓。",
    "更正為幸福邨B座12樓。",
    "另外想問保養安排。",
    "回到送貨資料，最新地址是哪裡？",
  ];
  let state = createEmptyConversationCommerceState();
  for (let index = 0; index < turns.length - 1; index++) {
    state = reduceTurn(state, {
      conversation_id,
      company_id,
      source_message_id: `57000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text: turns[index],
      language: "zh-TW",
      semantic_frame: index === 1
        ? {
          version: "commerce-semantic-1.0.0",
          language: "zh-TW",
          operation: "NO_STATE_CHANGE",
          intent: "correct delivery address",
          topic: "delivery address",
          entities: [],
          referents: [],
          customer_correction: true,
          additive: false,
          explicit_negations: [],
          requested_facts: [],
          transaction_state: "none",
          payment_state: "none",
          booking_state: "none",
          fulfillment_state: "none",
          ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
          confidence: 0.95,
        }
        : null,
    }, []);
  }
  assert(state.delivery.address === "幸福邨B座12樓", JSON.stringify(state.delivery));
  assert(state.latest_corrections.at(-1) === turns[1], JSON.stringify(state.latest_corrections));

  const source_message_id = "57000000-0000-4000-8000-000000000004";
  const memory = buildCanonicalConversationMemory({
    conversation_id,
    company_id,
    source_message_id,
    commerce_state_revision: 3,
    commerce_state: state,
    newest_first: turns.slice().reverse().map((content, index) => ({
      id: index === 0 ? source_message_id : `57000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`,
      role: "visitor",
      content,
    })),
    visitor_turn_count: turns.length,
    source_created_at: "2026-09-18T00:00:00Z",
    next_memory_revision: 4,
  });
  const input = {
    ...recallFixture(turns.at(-1)),
    conversation_id,
    company_id,
    source_message_id,
    question: turns.at(-1)!,
    memory,
    commerce: { conversation_id, company_id, source_message_id, revision: 3, state },
  };
  const route = prepareConversationRecall(input, "zh-TW");
  assert(route.decision.handled && route.reply, JSON.stringify(route.decision));
  assert(route.reply.includes("幸福邨B座12樓"), route.reply);
  assert(!route.reply.includes("幸福邨A座12樓"), route.reply);
  const b2 = evaluateB2BeforeCommit({
    proposed_response: route.reply,
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id,
      company_id,
      source_message_id,
      commerce_state_revision: 3,
      commerce_state_source_message_id: source_message_id,
      state,
    },
    metadata: route.metadata,
  });
  assert(b2.decision === "allow", JSON.stringify(b2));
});

Deno.test("C3 production-parity T040 converges scoped address correction across commerce, memory, recall, and B2", () => {
  const conversation_id = "40000000-0000-4000-8000-000000000001";
  const company_id = "40000000-0000-4000-8000-000000000002";
  const turns = [
    "送貨地址是長沙灣幸福邨A座12樓。",
    "唔係A座，係B座，我打錯。",
    "幫我讀返地址。",
  ];
  let state = createEmptyConversationCommerceState();
  for (let index = 0; index < turns.length; index += 1) {
    state = reduceTurn(state, {
      conversation_id,
      company_id,
      source_message_id: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text: turns[index],
      language: "zh-TW",
      semantic_frame: authoritativeAddressFrame(index === 1),
      history: turns.slice(0, index).reverse().map((content) => ({
        role: "visitor",
        content,
      })),
    }, []);
  }
  assert(
    state.delivery.address === "長沙灣幸福邨B座12樓",
    JSON.stringify(state.delivery),
  );
  assert(!state.delivery.address.includes("A座"), state.delivery.address);

  const source_message_id = "40000000-0000-4000-8000-000000000003";
  const memory = buildCanonicalConversationMemory({
    conversation_id,
    company_id,
    source_message_id,
    commerce_state_revision: 40,
    commerce_state: state,
    newest_first: turns.slice().reverse().map((content, index) => ({
      id: `40000000-0000-4000-8000-${String(3 - index).padStart(12, "0")}`,
      role: "visitor",
      content,
    })),
    visitor_turn_count: 40,
    source_created_at: "2026-09-19T00:00:00Z",
    next_memory_revision: 40,
  });
  const currentAddresses = memory.current_customer_facts.filter((fact) =>
    ["address", "delivery_address", "shipping_address", "corrected_delivery_address"]
      .includes(fact.key)
  );
  assert(currentAddresses.length === 1, JSON.stringify(currentAddresses));
  assert(currentAddresses[0].value === state.delivery.address, JSON.stringify(currentAddresses));
  assert(
    !JSON.stringify(currentAddresses).includes("A座"),
    JSON.stringify(currentAddresses),
  );

  const route = prepareConversationRecall({
    conversation_id,
    company_id,
    source_message_id,
    question: turns[2],
    memory,
    commerce: {
      conversation_id,
      company_id,
      source_message_id,
      revision: 40,
      state,
    },
  }, "zh-TW");
  assert(route.decision.handled && route.reply, JSON.stringify(route.decision));
  assert(route.reply.includes("B座") && route.reply.includes("12樓"), route.reply);
  assert(!route.reply.includes("A座"), route.reply);
  const b2 = evaluateB2BeforeCommit({
    proposed_response: route.reply,
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id,
      company_id,
      source_message_id,
      commerce_state_revision: 40,
      commerce_state_source_message_id: source_message_id,
      state,
    },
    metadata: route.metadata,
  });
  assert(b2.decision === "allow", JSON.stringify(b2));
});

Deno.test("C3 T040 committed scoped correction answers from post-commit state without re-asking", async () => {
  const previous = createEmptyConversationCommerceState();
  previous.delivery.address = "長沙灣幸福邨A座12樓";
  const source_message_id = "40000000-0000-4000-8000-000000000040";
  const { outcome, persisted } = await executeAddressCorrection(previous, "唔係A座，係B座，我打錯", source_message_id);
  assert(persisted.delivery.address === "長沙灣幸福邨B座12樓", JSON.stringify(persisted.delivery));
  assert(outcome?.reason === "explicit_address_correction_applied", JSON.stringify(outcome));
  assert(outcome.route === "commerce_state_answer", JSON.stringify(outcome));
  assert(outcome.reply === "已更新送貨地址為長沙灣幸福邨B座12樓。", outcome.reply ?? "missing reply");
  assert(!/[?？]|最想完成|提供.*地址/.test(outcome.reply), outcome.reply);

  const b2 = evaluateB2BeforeCommit({
    proposed_response: outcome.reply,
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id: "40000000-0000-4000-8000-000000000001",
      company_id: "40000000-0000-4000-8000-000000000002",
      source_message_id,
      commerce_state_revision: 41,
      commerce_state_source_message_id: source_message_id,
      state: persisted,
    },
  });
  assert(b2.decision === "allow", JSON.stringify(b2));
});

Deno.test("C3 captured v138 T040 envelope does not let stale semantic ambiguity re-ask after commit", async () => {
  const previous = createEmptyConversationCommerceState();
  const firstSource = "97740415-fdfb-4cfc-a72c-325967751050";
  previous.delivery.address = "長沙灣幸福邨A座12樓";
  previous.delivery.provenance = {
    source_type: "customer",
    source_message_id: firstSource,
    recorded_at: "2026-09-19T14:13:12.974273+00:00",
  };
  const frame = authoritativeAddressFrame(true);
  frame.operation = "NO_STATE_CHANGE";
  frame.ambiguity = {
    is_ambiguous: true,
    reasons: ["pre-commit semantic referent unresolved"],
    clarification_question: "你想更正哪一個地址？",
  };
  const source = "054918e3-72d3-4afb-9b19-d714f414c293";
  const result = await executeAddressCorrection(
    previous,
    "唔係A座，係B座，我打錯",
    source,
    frame,
  );
  assert(result.persisted.delivery.address === "長沙灣幸福邨B座12樓", JSON.stringify(result.persisted.delivery));
  assert(result.outcome?.persist_result === "success", JSON.stringify(result.outcome));
  assert(result.outcome.reason === "no_authoritative_source_selected", JSON.stringify(result.outcome));
  assert(result.outcome.route === "commerce_kb_required", JSON.stringify(result.outcome));
  assert(result.outcome.reply === null, JSON.stringify(result.outcome));

  const previousMemory = buildCanonicalConversationMemory({
    previous: null,
    conversation_id: "40000000-0000-4000-8000-000000000001",
    company_id: "40000000-0000-4000-8000-000000000002",
    source_message_id: firstSource,
    commerce_state_revision: 40,
    commerce_state: previous,
    newest_first: [{
      id: firstSource,
      role: "visitor",
      content: "送貨地址是長沙灣幸福邨A座12樓。",
    }],
    visitor_turn_count: 1,
    source_created_at: "2026-09-19T14:13:12.974273+00:00",
    next_memory_revision: 1,
  });
  const memory = buildCanonicalConversationMemory({
    previous: previousMemory,
    conversation_id: "40000000-0000-4000-8000-000000000001",
    company_id: "40000000-0000-4000-8000-000000000002",
    source_message_id: source,
    commerce_state_revision: 41,
    commerce_state: result.persisted,
    newest_first: [
      { id: source, role: "visitor", content: "唔係A座，係B座，我打錯" },
      {
        id: firstSource,
        role: "visitor",
        content: "送貨地址是長沙灣幸福邨A座12樓。",
      },
    ],
    visitor_turn_count: 2,
    source_created_at: "2026-09-19T14:13:27.357992+00:00",
    next_memory_revision: 2,
  });
  const commerce = {
    conversation_id: "40000000-0000-4000-8000-000000000001",
    company_id: "40000000-0000-4000-8000-000000000002",
    source_message_id: source,
    revision: 41,
    state: result.persisted,
  };
  const recall = prepareConversationRecall({
    conversation_id: commerce.conversation_id,
    company_id: commerce.company_id,
    source_message_id: source,
    question: "唔係A座，係B座，我打錯",
    memory,
    commerce,
  }, "zh-TW");
  const plan = planConversationService({
    question: "唔係A座，係B座，我打錯",
    language: "zh-TW",
    recall: recall.decision,
    memory,
    commerce: result.persisted,
  });
  assert(recall.metadata.response_route === "canonical_memory_clarification", JSON.stringify(recall.metadata));
  assert(plan.action === "partial_answer_then_question", JSON.stringify(plan));
  assert(plan.missing_slots.includes("customer_goal"), JSON.stringify(plan));
  assert(renderTargetedServiceQuestion(plan, "zh-TW").includes("最想完成"), JSON.stringify(plan));

  const resolved = resolveCommittedAddressCorrection({
    text: "唔係A座，係B座，我打錯",
    source_message_id: source,
    language: "zh-TW",
    memory,
    commerce,
  });
  assert(resolved?.status === "RESOLVED", JSON.stringify(resolved));
  assert(resolved.operation === "SCOPED_COMPONENT_UPDATE", JSON.stringify(resolved));
  assert(resolved.address === "長沙灣幸福邨B座12樓", JSON.stringify(resolved));
  assert(
    resolved.reply === "已更新送貨地址為長沙灣幸福邨B座12樓。" &&
      !/[?？]|最想完成/.test(resolved.reply),
    JSON.stringify(resolved),
  );
  const b2 = evaluateB2BeforeCommit({
    proposed_response: resolved.reply,
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id: commerce.conversation_id,
      company_id: commerce.company_id,
      source_message_id: source,
      commerce_state_revision: commerce.revision,
      commerce_state_source_message_id: commerce.source_message_id,
      state: commerce.state,
    },
    metadata: {
      response_route: "commerce_state_answer",
      correction_resolution: resolved.status,
      correction_source_message_id: resolved.source_message_id,
    },
  });
  assert(b2.decision === "allow", JSON.stringify(b2));
});

Deno.test("C3 committed correction resolution fails closed on provenance, convergence, or missing-info gaps", () => {
  const source = "45000000-0000-4000-8000-000000000040";
  const firstSource = "45000000-0000-4000-8000-000000000001";
  const state = createEmptyConversationCommerceState();
  state.delivery.address = "長沙灣幸福邨B座12樓";
  state.delivery.provenance = {
    source_type: "customer",
    source_message_id: source,
    recorded_at: "2026-09-19T14:13:27.357992+00:00",
  };
  const evidence = {
    text: "唔係A座，係B座，我打錯",
    source_message_id: source,
    language: "zh-TW" as const,
    memory: {
      source_message_id: source,
      commerce_state_revision: 41,
      current_customer_facts: [{
        key: "corrected_delivery_address",
        value: "長沙灣幸福邨B座12樓",
        authority: "canonical_commerce",
        source_message_id: source,
      }],
      cancelled_or_superseded: [{
        key: "superseded_delivery_address",
        value: "長沙灣幸福邨A座12樓",
        source_message_id: firstSource,
      }],
      latest_corrections: ["唔係A座,係B座,我打錯"],
      open_questions: [] as string[],
    },
    commerce: { source_message_id: source, revision: 41, state },
  };
  assert(resolveCommittedAddressCorrection(evidence)?.status === "RESOLVED");
  assert(
    resolveCommittedAddressCorrection({
      ...evidence,
      commerce: {
        ...evidence.commerce,
        state: {
          ...state,
          delivery: {
            ...state.delivery,
            provenance: {
              ...state.delivery.provenance!,
              source_message_id: firstSource,
            },
          },
        },
      },
    }) === null,
    "source-message/provenance mismatch must fail closed",
  );
  assert(
    resolveCommittedAddressCorrection({
      ...evidence,
      memory: {
        ...evidence.memory,
        current_customer_facts: [{
          ...evidence.memory.current_customer_facts[0],
          value: "長沙灣幸福邨C座12樓",
        }],
      },
    }) === null,
    "Memory/Commerce disagreement must fail closed",
  );
  assert(
    resolveCommittedAddressCorrection({
      ...evidence,
      memory: {
        ...evidence.memory,
        open_questions: ["請提供樓層"],
      },
    }) === null,
    "genuinely missing required information must preserve clarification",
  );
});

Deno.test("C3 post-commit correction resolution covers scoped block floor unit and full replacement", () => {
  const firstSource = "46000000-0000-4000-8000-000000000001";
  const cases = [
    {
      source: "46000000-0000-4000-8000-000000000002",
      text: "唔係A座，係B座",
      previous: "長沙灣幸福邨A座12樓1201室",
      current: "長沙灣幸福邨B座12樓1201室",
      operation: "SCOPED_COMPONENT_UPDATE",
    },
    {
      source: "46000000-0000-4000-8000-000000000003",
      text: "唔係12樓，而係15樓",
      previous: "長沙灣幸福邨B座12樓1201室",
      current: "長沙灣幸福邨B座15樓1201室",
      operation: "SCOPED_COMPONENT_UPDATE",
    },
    {
      source: "46000000-0000-4000-8000-000000000004",
      text: "不是1201室，是1508室",
      previous: "長沙灣幸福邨B座15樓1201室",
      current: "長沙灣幸福邨B座15樓1508室",
      operation: "SCOPED_COMPONENT_UPDATE",
    },
    {
      source: "46000000-0000-4000-8000-000000000005",
      text: "地址改做九龍灣XX大廈3樓",
      previous: "長沙灣幸福邨B座15樓1508室",
      current: "九龍灣XX大廈3樓",
      operation: "FULL_REPLACE",
    },
  ] as const;

  for (const [index, item] of cases.entries()) {
    const state = createEmptyConversationCommerceState();
    state.delivery.address = item.current;
    state.delivery.provenance = {
      source_type: "customer",
      source_message_id: item.source,
      recorded_at: "2026-09-19T14:13:27.357992+00:00",
    };
    const resolved = resolveCommittedAddressCorrection({
      text: item.text,
      source_message_id: item.source,
      language: "zh-TW",
      memory: {
        source_message_id: item.source,
        commerce_state_revision: 42 + index,
        current_customer_facts: [{
          key: "corrected_delivery_address",
          value: item.current,
          authority: "canonical_commerce",
          source_message_id: item.source,
        }],
        cancelled_or_superseded: [{
          key: "superseded_delivery_address",
          value: item.previous,
          source_message_id: firstSource,
        }],
        latest_corrections: [item.text],
        open_questions: [],
      },
      commerce: {
        source_message_id: item.source,
        revision: 42 + index,
        state,
      },
    });
    assert(resolved?.status === "RESOLVED", JSON.stringify({ item, resolved }));
    assert(resolved.operation === item.operation, JSON.stringify(resolved));
    assert(resolved.address === item.current, JSON.stringify(resolved));
    assert(resolved.reply.includes(item.current), JSON.stringify(resolved));
    assert(!/[?？]|最想完成/.test(resolved.reply), resolved.reply);
  }
});

Deno.test("C3 completed block floor and unit corrections acknowledge the complete address", async () => {
  let state = createEmptyConversationCommerceState();
  state.delivery.address = "長沙灣幸福邨A座12樓1201室";
  const cases = [
    ["唔係A座，係B座", "長沙灣幸福邨B座12樓1201室"],
    ["唔係12樓，而係15樓", "長沙灣幸福邨B座15樓1201室"],
    ["不是1201室，是1508室", "長沙灣幸福邨B座15樓1508室"],
  ] as const;
  for (let index = 0; index < cases.length; index += 1) {
    const [text, expected] = cases[index];
    const result = await executeAddressCorrection(
      state,
      text,
      `41000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    state = result.persisted;
    assert(state.delivery.address === expected, JSON.stringify(state.delivery));
    assert(
      result.outcome?.reason === "explicit_address_correction_applied" &&
        result.outcome.reply?.includes(expected) &&
        !/[?？]|最想完成/.test(result.outcome.reply),
      JSON.stringify(result.outcome),
    );
  }
});

Deno.test("C3 complete full-address replacement acknowledges without clarification", async () => {
  const previous = createEmptyConversationCommerceState();
  previous.delivery.address = "長沙灣幸福邨B座15樓1508室";
  const { outcome, persisted } = await executeAddressCorrection(
    previous,
    "地址改做九龍灣XX大廈3樓",
    "43000000-0000-4000-8000-000000000001",
  );
  assert(persisted.delivery.address === "九龍灣XX大廈3樓", JSON.stringify(persisted.delivery));
  assert(
    outcome?.reason === "explicit_address_correction_applied" &&
      outcome.reply?.includes("九龍灣XX大廈3樓") && !/[?？]/.test(outcome.reply),
    JSON.stringify(outcome),
  );
});

Deno.test("C3 incomplete or ambiguous scoped correction preserves clarification", async () => {
  const incomplete = createEmptyConversationCommerceState();
  incomplete.delivery.address = "A座";
  const incompleteResult = await executeAddressCorrection(
    incomplete,
    "唔係A座，係B座",
    "44000000-0000-4000-8000-000000000001",
  );
  assert(incompleteResult.persisted.delivery.address === "B座", JSON.stringify(incompleteResult.persisted.delivery));
  assert(!incompleteResult.outcome?.reply, JSON.stringify(incompleteResult.outcome));

  const ambiguousFrame = authoritativeAddressFrame(true);
  ambiguousFrame.ambiguity = {
    is_ambiguous: true,
    reasons: ["multiple address referents"],
    clarification_question: "你想更正哪一個送貨地址？",
  };
  const ambiguous = createEmptyConversationCommerceState();
  ambiguous.delivery.address = "長沙灣幸福邨A座12樓";
  const ambiguousResult = await executeAddressCorrection(
    ambiguous,
    "唔係A座，係B座",
    "44000000-0000-4000-8000-000000000002",
    ambiguousFrame,
  );
  assert(!ambiguousResult.outcome?.reply, JSON.stringify(ambiguousResult.outcome));

  for (const [question, commerce] of [
    ["唔係A座，係B座", incompleteResult.persisted],
    ["唔係A座，係B座", ambiguousResult.persisted],
  ] as const) {
    const input = recallFixture(question);
    input.commerce!.state = commerce;
    const recall = resolveConversationRecall(input);
    const plan = planConversationService({ question, language: "zh-TW", recall, memory: input.memory, commerce });
    assert(["targeted_clarification", "partial_answer_then_question"].includes(plan.action), JSON.stringify(plan));
    assert(/[?？]/.test(renderTargetedServiceQuestion(plan, "zh-TW")), JSON.stringify(plan));
  }
});

Deno.test("C3 scoped address mutation preserves block floor unit and supports explicit replacement", () => {
  const conversation_id = "41000000-0000-4000-8000-000000000001";
  const company_id = "41000000-0000-4000-8000-000000000002";
  let revision = 0;
  let state = createEmptyConversationCommerceState();
  const turn = (text: string, correction: boolean) => {
    revision += 1;
    state = reduceTurn(state, {
      conversation_id,
      company_id,
      source_message_id: `41000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
      text,
      language: "zh-TW",
      semantic_frame: authoritativeAddressFrame(correction),
    }, []);
  };

  turn("送貨地址是長沙灣幸福邨A座12樓1201室。", false);
  turn("唔係A座，係B座。", true);
  assert(String(state.delivery.address) === "長沙灣幸福邨B座12樓1201室", JSON.stringify(state.delivery));

  turn("唔係12樓，而係15樓。", true);
  assert(String(state.delivery.address) === "長沙灣幸福邨B座15樓1201室", JSON.stringify(state.delivery));

  turn("不是1201室，是1508室。", true);
  assert(String(state.delivery.address) === "長沙灣幸福邨B座15樓1508室", JSON.stringify(state.delivery));

  turn("地址改做九龍灣XX大廈3樓。", true);
  assert(String(state.delivery.address) === "九龍灣XX大廈3樓", JSON.stringify(state.delivery));
  assert(!String(state.delivery.address).includes("幸福邨"), String(state.delivery.address));
});

Deno.test("C3 scoped address mutation without prior context stays unknown", () => {
  const state = reduceTurn(createEmptyConversationCommerceState(), {
    conversation_id: "42000000-0000-4000-8000-000000000001",
    company_id: "42000000-0000-4000-8000-000000000002",
    source_message_id: "42000000-0000-4000-8000-000000000003",
    text: "唔係A座，係B座。",
    language: "zh-TW",
    semantic_frame: authoritativeAddressFrame(true),
  }, []);
  assert(!state.delivery.address, JSON.stringify(state.delivery));
  assert(
    state.latest_corrections.length === 1 &&
      state.latest_corrections[0].includes("A座") &&
      state.latest_corrections[0].includes("B座"),
    JSON.stringify(state.latest_corrections),
  );
});

Deno.test("C3 current official facts still have no recall reply", () => {
  const r = prepareConversationRecall(
    recallFixture("What is the official warranty?"),
  );
  assert(
    !r.decision.handled && r.decision.reason === "CURRENT_KB_REQUIRED" &&
      r.reply === null,
  );
});
Deno.test("C3 ambiguous recall is not sent to KB no-match", () => {
  const i = recallFixture("我的電話？");
  delete i.commerce!.state.delivery.recipient_phone;
  const r = prepareConversationRecall(i);
  assert(
    !r.decision.handled && r.decision.reason === "AMBIGUOUS" && r.reply &&
      r.metadata.response_route === "canonical_memory_clarification",
  );
});
Deno.test("C3 frozen B2 remains fail-closed on unresolved correction", () => {
  const i = recallFixture();
  i.commerce!.state.latest_corrections = [
    "correction whose values are not canonicalized",
  ];
  const r = prepareConversationRecall(i);
  assert(r.reply);
  const d = evaluateB2BeforeCommit({
    proposed_response: r.reply,
    persistence_kind: "ai_reply",
    snapshot: {
      ...i,
      commerce_state_revision: 20,
      commerce_state_source_message_id: i.source_message_id,
      state: i.commerce!.state,
    },
    metadata: r.metadata,
  });
  assert(d.decision !== "allow" && d.code === "LATEST_CORRECTION_UNRESOLVED");
});

Deno.test("C3 recall callback runs only through real frozen B2 persistence", async () => {
  const i = recallFixture();
  const r = prepareConversationRecall(i);
  assert(r.reply);
  let commits = 0;
  const client = {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            error: null,
            data: table === "conversations"
              ? { id: i.conversation_id, company_id: i.company_id }
              : table === "messages"
              ? {
                id: i.source_message_id,
                conversation_id: i.conversation_id,
                role: "visitor",
              }
              : {
                conversation_id: i.conversation_id,
                company_id: i.company_id,
                revision: 20,
                source_message_id: i.source_message_id,
                state: i.commerce!.state,
              },
          };
        },
      };
    },
  };
  const result = await executeB2PersistenceGate({
    client,
    conversation_id: i.conversation_id,
    source_message_id: i.source_message_id,
    proposed_response: r.reply,
    persistence_kind: "ai_reply",
    metadata: r.metadata,
    expected_commerce_state_revision: 20,
    commit: async () => {
      commits++;
      return "persisted";
    },
  });
  assert(result.committed && commits === 1, JSON.stringify(result));
});
Deno.test("C3 changed commerce revision commits zero", async () => {
  const i = recallFixture();
  const r = prepareConversationRecall(i);
  assert(r.reply);
  let commits = 0, reads = 0;
  const client = {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          if (table === "conversation_commerce_state") reads++;
          return {
            error: null,
            data: table === "conversations"
              ? { id: i.conversation_id, company_id: i.company_id }
              : table === "messages"
              ? {
                id: i.source_message_id,
                conversation_id: i.conversation_id,
                role: "visitor",
              }
              : {
                conversation_id: i.conversation_id,
                company_id: i.company_id,
                revision: reads > 1 ? 21 : 20,
                source_message_id: i.source_message_id,
                state: i.commerce!.state,
              },
          };
        },
      };
    },
  };
  const result = await executeB2PersistenceGate({
    client,
    conversation_id: i.conversation_id,
    source_message_id: i.source_message_id,
    proposed_response: r.reply,
    persistence_kind: "ai_reply",
    metadata: r.metadata,
    expected_commerce_state_revision: 20,
    commit: async () => {
      commits++;
      return "forbidden";
    },
  });
  assert(!result.committed && commits === 0, JSON.stringify(result));
});
Deno.test("C3 source audit recall precedes commerce reply, context shortcuts and KB", () => {
  const source = Deno.readTextFileSync(
    new URL("../generate-reply/index.ts", import.meta.url),
  );
  const start = source.indexOf("const _c3Recall = prepareConversationRecall(");
  const commerceReplyMarker =
    "if (_c3CommerceReply && !_explicitHandoffRequested)";
  assert(start > source.indexOf("refreshConversationLongMemory("));
  for (
    const marker of [
      commerceReplyMarker,
      'if (_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE")',
      "await callKBAdapter(",
    ]
  ) assert(start < source.indexOf(marker, start), `precedence: ${marker}`);
  const block = source.slice(
    start,
    source.indexOf(commerceReplyMarker, start),
  );
  assert(block.includes("commitAiReplyWithControlGate("));
  assert(!/\.insert\(|\.rpc\(/.test(block), "direct persistence bypass");
  assert(
    source.includes('_c3Recall.decision.reason === "NOT_A_RECALL_QUERY"'),
    "raw fallback authority guard absent",
  );
  const resolvedAddress = source.indexOf(
    "resolveCommittedAddressCorrection({",
    start,
  );
  const plannedReply = source.indexOf("const _c3PlannedReply", start);
  assert(resolvedAddress > start && resolvedAddress < plannedReply, "post-commit address correction must clear stale clarification before reply planning");
  const resolvedReadOnly = source.indexOf(
    "const _c3ResolvedReadOnlyCurrentState",
    start,
  );
  assert(
    resolvedReadOnly > start && resolvedReadOnly < plannedReply,
    "known read-only commerce answer must clear stale clarification before reply planning",
  );
  const planningWindow = source.slice(resolvedReadOnly, plannedReply + 500);
  assert(
    planningWindow.includes("read_only_memory_or_current_state_recall_resolved") &&
      planningWindow.includes("_c3ResolvedReadOnlyCurrentState"),
    "known-state answer precedence contract absent",
  );
});
Deno.test("C3 assist uses same resolver after RBAC and before its KB dependency", () => {
  const source = Deno.readTextFileSync(
    new URL("../agent-assist/index.ts", import.meta.url),
  );
  const start = source.indexOf("const recallRoute = prepareConversationRecall(");
  const kbStart = source.indexOf("const kbPrefix");
  assert(start > source.indexOf("not_assigned_to_conversation"));
  assert(start > source.indexOf("handoff_context"));
  assert(start < kbStart);
  assert(
    /draft_only:\s*true/.test(source.slice(start, kbStart)),
  );
});
Deno.test("C3 legacy structured API delegates rather than adding a second resolver", () => {
  const source = Deno.readTextFileSync(
    new URL("./conversation-long-memory.ts", import.meta.url),
  );
  const block = source.slice(
    source.indexOf("export function resolveStructuredMemoryResponse("),
    source.indexOf("export function buildBoundedConversationContext("),
  );
  assert(
    block.includes("resolveConversationRecall(") &&
      !block.includes("asksFirst") && !block.includes("asksCorrection"),
  );
});
Deno.test("C3 unknown fact decisions never acquire inferred values", () => {
  const d = resolveConversationRecall(
    recallFixture("What is my favorite color?"),
  );
  assert(!d.handled && !("value" in d));
});

Deno.test("C3 reconstructed acceptance failures use customer-owned history (non-production replay)", async () => {
  const { buildCanonicalConversationMemory } = await import("./conversation-long-memory.ts");
  const contract = JSON.parse(Deno.readTextFileSync(new URL("../../../.github/scripts/c3_validation_scenarios.json", import.meta.url)));
  const ids = new Set(["T06", "T17", "T40", "T50", "T57", "T58", "T68", "T69", "T71", "C3-CONTROL-14"]);
  for (const row of contract.scenarios.filter((item: { id: string }) => ids.has(item.id))) {
    const seed = recallFixture(row.input);
    const commerceState = structuredClone(seed.commerce!.state);
    commerceState.entities = [];
    commerceState.quotes = [];
    commerceState.customer_constraints = {};
    commerceState.delivery.address = row.id === "T40" ? "長沙灣幸福邨A座12樓" : row.id === "T57" ? "幸福邨A座12樓" : null;
    commerceState.delivery.preferred_date = null;
    commerceState.delivery.preferred_window = null;
    const source = seed.source_message_id;
    const setup = row.setup_turns.map((content: string, index: number) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: "visitor",
      content,
    }));
    const memory = buildCanonicalConversationMemory({
      previous: null,
      conversation_id: seed.conversation_id,
      company_id: seed.company_id,
      source_message_id: source,
      commerce_state_revision: 20,
      commerce_state: commerceState,
      newest_first: [{ id: source, role: "visitor", content: row.input }, ...setup.reverse()],
      visitor_turn_count: setup.length + 1,
      source_created_at: "2026-09-16T00:00:00Z",
      next_memory_revision: 1,
    });
    const result = prepareConversationRecall({ ...seed, memory, commerce: { ...seed.commerce!, state: commerceState } });
    assert(result.decision.handled && result.reply, `${row.id}: ${JSON.stringify(result.decision)}`);
    const normalized = result.reply.normalize("NFKC").toLowerCase();
    const contains = (value: string) => normalized.includes(value.normalize("NFKC").toLowerCase());
    assert(!(row.expected.include_all ?? []).some((value: string) => !contains(value)), `${row.id}:include_all:${result.reply}`);
    assert(!row.expected.include_any || row.expected.include_any.some(contains), `${row.id}:include_any:${result.reply}`);
    assert(!row.expected.include_any_secondary || row.expected.include_any_secondary.some(contains), `${row.id}:include_any_secondary:${result.reply}`);
    assert(!(row.expected.exclude_any ?? []).some(contains), `${row.id}:exclude_any:${result.reply}`);
  }
});

Deno.test("C3 synthetic 100-turn bounded-memory routing continuity (not production replay)", async () => {
  const { buildCanonicalConversationMemory } = await import(
    "./conversation-long-memory.ts"
  );
  const seed = recallFixture();
  let previous = null as
    | ReturnType<typeof buildCanonicalConversationMemory>
    | null;
  for (let turn = 1; turn <= 100; turn++) {
    const source = `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`;
    const question = turn % 2
      ? "我之前冷氣要求幾匹？"
      : "請讀回我的收貨人和聯絡電話？";
    const memory = buildCanonicalConversationMemory({
      previous,
      conversation_id: seed.conversation_id,
      company_id: seed.company_id,
      source_message_id: source,
      commerce_state_revision: 20,
      commerce_state: seed.commerce!.state,
      newest_first: [{ id: source, role: "visitor", content: question }],
      visitor_turn_count: turn,
      source_created_at: `2026-09-15T00:${
        String(Math.floor(turn / 60)).padStart(2, "0")
      }:${String(turn % 60).padStart(2, "0")}Z`,
      next_memory_revision: turn,
    });
    const route = prepareConversationRecall({
      ...seed,
      question,
      source_message_id: source,
      memory,
      commerce: { ...seed.commerce!, source_message_id: source },
    });
    assert(
      route.decision.handled && route.reply,
      `synthetic turn ${turn}: ${JSON.stringify(route.decision)}`,
    );
    assert(
      JSON.stringify(memory).length <= 16384 && route.reply.length <= 4096,
      "bounded state drift",
    );
    previous = memory;
  }
});

function turn55CommerceState() {
  const state = createEmptyConversationCommerceState();
  state.language = "zh-TW";
  state.current_intent = "purchase_air_conditioner";
  state.current_topic = "air_conditioner";
  state.current_industry = "home_appliance";
  state.latest_corrections = [
    "改做一部1匹，一部1.5匹。",
    "客廳嗰部暫時唔買住。",
  ];
  state.entities = [
    {
      entity_id: "air_conditioner:unscoped",
      category: "air_conditioner",
      brand: null,
      model: null,
      quantity: 2,
      status: "tentative",
      attributes: { correction_lineage: "two-active-units" },
      constraints: {},
      provenance: {
        source_type: "customer",
        source_message_id: "55a00000-0000-4000-8000-000000000015",
      },
    },
    {
      entity_id: "air_conditioner:living_room",
      category: "air_conditioner",
      brand: null,
      model: null,
      quantity: 1,
      status: "cancelled",
      attributes: { correction_lineage: "living-room-cancelled" },
      constraints: {},
      provenance: {
        source_type: "customer",
        source_message_id: "55a00000-0000-4000-8000-000000000016",
      },
    },
  ];
  state.quotes = [{
    quote_id: "customer:066a0e16-d07b-47e6-ab16-88694d49b1fb:0",
    entity_id: null,
    amount: 5788,
    currency: "HKD",
    quote_type: "customer_reported_historical",
    validity_status: "historical",
    source_label: "customer_reported",
    conditions: { historical: true, unverified: false },
    provenance: {
      source_type: "customer",
      source_message_id: "066a0e16-d07b-47e6-ab16-88694d49b1fb",
    },
  }];
  state.delivery.address = "長沙灣幸福邨B座12樓";
  state.delivery.provenance = {
    source_type: "customer",
    source_message_id: "813a3f34-ee61-4c5b-9e75-45de0ac5d2e0",
  };
  state.installation.pending_checks = ["installation_site_check"];
  state.conversion.funnel_stage = "quotation";
  state.conversion.quotation_status = "draft";
  state.conversion.tentative_entity_ids = ["air_conditioner:unscoped"];
  state.conversion.cancelled_entity_ids = ["air_conditioner:living_room"];
  return state;
}

function turn55SemanticFrame(): CommerceSemanticFrame {
  return {
    version: "commerce-semantic-1.0.0",
    language: "zh-TW",
    operation: "ASK_FACT",
    intent: "recall current purchased quantity",
    topic: "air_conditioner",
    entities: [],
    referents: [{ ref: "最後買嘅冷氣", source: "persistent_state", confidence: 0.96 }],
    customer_correction: false,
    additive: false,
    explicit_negations: [],
    requested_facts: ["current_quantity"],
    transaction_state: "none",
    payment_state: "none",
    booking_state: "none",
    fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
    // Captured production fell through the deterministic extractor because the
    // semantic envelope was below the authoritative mutation threshold.
    confidence: 0.55,
  };
}

async function executeCommerceFixture(
  previous: ReturnType<typeof turn55CommerceState>,
  text: string,
  source_message_id: string,
  semantic_frame: CommerceSemanticFrame | null = turn55SemanticFrame(),
) {
  let persisted = previous;
  let rpcCalls = 0;
  const db: CommerceStateDbClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { revision: 54, state: previous }, error: null }),
        }),
      }),
    }),
    rpc: async (_name, params) => {
      rpcCalls += 1;
      persisted = params.p_state as typeof previous;
      return { data: { result: "success", applied_revision: 55 }, error: null };
    },
  };
  const outcome = await runCommerceStateRuntime(db, {
    conversation_id: "95d4e67f-b896-47a2-bd64-b3f44dcf23f1",
    company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id,
    text,
    language: "zh-TW",
    history: [
      { role: "visitor", content: "改做一部1匹，一部1.5匹。" },
      { role: "visitor", content: "客廳嗰部暫時唔買住。" },
      { role: "visitor", content: "咁我而家實際買幾多部冷氣？" },
    ],
    semantic_frame,
    industry_identifier: "home_appliance",
  });
  return { outcome, persisted, rpcCalls };
}

Deno.test("C3 captured production turn 55 known quantity is read-only and outranks clarification", async () => {
  const previous = turn55CommerceState();
  const before = JSON.stringify(previous);
  const source = "59b89c91-f150-4120-b226-a2944f0eb2da";
  const result = await executeCommerceFixture(
    previous,
    "我最後係買三部定兩部？",
    source,
  );
  assert(result.outcome?.route === "commerce_state_answer", JSON.stringify(result.outcome));
  assert(result.outcome.reason === "read_only_memory_or_current_state_recall_resolved", JSON.stringify(result.outcome));
  assert(result.outcome.state_path === "entities.0.quantity", JSON.stringify(result.outcome));
  assert(result.outcome.reply?.includes("2") && !/[?？]|最想完成/.test(result.outcome.reply), result.outcome.reply ?? "missing reply");
  assert(result.outcome.revision === 54 && result.outcome.persist_result === "read_only", JSON.stringify(result.outcome));
  assert(result.rpcCalls === 0, `read-only quantity query created ${result.rpcCalls} semantic event(s)`);
  assert(JSON.stringify(result.persisted) === before, JSON.stringify(result.persisted));
  assert(result.persisted.entities.length === 2, JSON.stringify(result.persisted.entities));
  assert(!result.persisted.entities.some((entity) => entity.entity_id === "generic:定兩部"), JSON.stringify(result.persisted.entities));
  assert(!result.persisted.entities.some((entity) => entity.quantity === 3), JSON.stringify(result.persisted.entities));
});

Deno.test("C3 read-only current-state query class preserves mutations, ambiguity, scope, and replay contracts", async () => {
  const known = await executeCommerceFixture(
    turn55CommerceState(),
    "我而家實際買幾多部冷氣？",
    "55b00000-0000-4000-8000-000000000001",
  );
  assert(known.outcome?.reason === "read_only_memory_or_current_state_recall_resolved" && known.outcome.reply?.includes("2"), JSON.stringify(known.outcome));
  assert(known.persisted.entities.length === 2, JSON.stringify(known.persisted.entities));

  const status = await executeCommerceFixture(
    turn55CommerceState(),
    "客廳嗰部而家係咪已取消？",
    "55b00000-0000-4000-8000-000000000002",
  );
  assert(status.outcome?.reason === "read_only_memory_or_current_state_recall_resolved", JSON.stringify(status.outcome));
  assert(status.outcome.reply?.includes("cancelled") || status.outcome.reply?.includes("取消"), status.outcome?.reply ?? "missing reply");
  assert(status.persisted.entities.find((entity) => entity.entity_id.endsWith("living_room"))?.status === "cancelled", JSON.stringify(status.persisted));

  const numbered = await executeCommerceFixture(
    turn55CommerceState(),
    "冷氣而家係三部定兩部？",
    "55b00000-0000-4000-8000-000000000003",
  );
  assert(numbered.outcome?.reply?.includes("2"), JSON.stringify(numbered.outcome));
  assert(!numbered.persisted.entities.some((entity) => entity.quantity === 3), JSON.stringify(numbered.persisted.entities));

  const setFrame = turn55SemanticFrame();
  setFrame.operation = "SET_QUANTITY";
  setFrame.intent = "set current quantity";
  setFrame.entities = [{
    entity_ref: "air_conditioner:unscoped",
    name: "冷氣",
    kind: "physical_product",
    category_hint: "air_conditioner",
    sku: null,
    model: null,
    quantity: 3,
    unit: "部",
    attributes: {},
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
    confidence: 0.98,
  }];
  const set = await executeCommerceFixture(
    turn55CommerceState(),
    "可以幫我將冷氣改做三部嗎？",
    "55b00000-0000-4000-8000-000000000004",
    setFrame,
  );
  assert(set.persisted.entities.find((entity) => entity.entity_id.endsWith(":unscoped"))?.quantity === 3, JSON.stringify(set.persisted));

  const addFrame = structuredClone(setFrame);
  addFrame.operation = "ADD_ITEM";
  addFrame.intent = "add another unit";
  addFrame.additive = true;
  addFrame.entities[0].quantity = 1;
  const add = await executeCommerceFixture(
    turn55CommerceState(),
    "可以幫我再加一部冷氣嗎？",
    "55b00000-0000-4000-8000-000000000005",
    addFrame,
  );
  assert(add.persisted.entities.find((entity) => entity.entity_id.endsWith(":unscoped"))?.quantity === 3, JSON.stringify(add.persisted));

  const ambiguousState = turn55CommerceState();
  ambiguousState.entities[0] = { ...ambiguousState.entities[0], entity_id: "air_conditioner:bedroom_a", quantity: 1 };
  ambiguousState.entities.push({ ...ambiguousState.entities[0], entity_id: "air_conditioner:bedroom_b" });
  const ambiguousFrame = turn55SemanticFrame();
  ambiguousFrame.ambiguity = { is_ambiguous: true, reasons: ["multiple active entities"], clarification_question: "你指邊一部？" };
  const ambiguousBefore = JSON.stringify(ambiguousState);
  const ambiguous = await executeCommerceFixture(
    ambiguousState,
    "嗰部而家係一部定兩部？",
    "55b00000-0000-4000-8000-000000000006",
    ambiguousFrame,
  );
  assert(ambiguous.outcome?.reply === null, JSON.stringify(ambiguous.outcome));
  assert(JSON.stringify(ambiguous.persisted) === ambiguousBefore, JSON.stringify(ambiguous.persisted));

  const genericQuestionState = createEmptyConversationCommerceState();
  const generic = await executeCommerceFixture(
    genericQuestionState,
    "我係買兩部打印機定三部？",
    "55b00000-0000-4000-8000-000000000007",
    null,
  );
  assert(generic.persisted.entities.length === 0, JSON.stringify(generic.persisted.entities));

  assert(known.outcome?.reply?.includes("2") && !known.outcome.reply.includes("3"), known.outcome?.reply ?? "missing reply");

  const replayState = turn55CommerceState();
  let replayRpcCalls = 0;
  const replayDb: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { revision: 55, state: replayState }, error: null }) }) }) }),
    rpc: async () => {
      replayRpcCalls += 1;
      return { data: { result: "source_message_already_applied", applied_revision: 55 }, error: null };
    },
  };
  const replay = await runCommerceStateRuntime(replayDb, {
    conversation_id: "95d4e67f-b896-47a2-bd64-b3f44dcf23f1",
    company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id: "59b89c91-f150-4120-b226-a2944f0eb2da",
    text: "我最後係買三部定兩部？",
    language: "zh-TW",
    semantic_frame: turn55SemanticFrame(),
  });
  assert(replayRpcCalls === 0 && replay?.revision === 55 && replay.persist_result === "read_only", JSON.stringify(replay));
  assert(JSON.stringify(replayState) === JSON.stringify(turn55CommerceState()), JSON.stringify(replayState));
});

function turn25SemanticFrame(): CommerceSemanticFrame {
  return {
    version: "commerce-semantic-1.0.0",
    language: "zh-TW",
    operation: "ASK_FACT",
    intent: "remember the current air-conditioner quantity",
    topic: "air_conditioner",
    entities: [{
      entity_ref: "air_conditioner:unscoped",
      name: "冷氣嗰兩部",
      kind: "physical_product",
      category_hint: "air_conditioner",
      sku: null,
      model: null,
      quantity: 2,
      unit: "部",
      attributes: {},
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
      confidence: 0.96,
    }],
    referents: [{ ref: "頭先冷氣嗰兩部", source: "persistent_state", confidence: 0.96 }],
    customer_correction: false,
    additive: false,
    explicit_negations: [],
    // Production supplied no supported recall slot, which previously allowed
    // NO_SUPPORTED_FACT_SLOT and customer_goal clarification to win.
    requested_facts: [],
    transaction_state: "none",
    payment_state: "none",
    booking_state: "none",
    fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
    confidence: 0.96,
  };
}

async function executeTurn25Fixture(
  text: string,
  semantic_frame: CommerceSemanticFrame | null = turn25SemanticFrame(),
  previous = turn55CommerceState(),
) {
  const originalProvenance = structuredClone(previous.entities[0].provenance);
  let persisted = previous;
  let rpcCalls = 0;
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { revision: 24, state: previous }, error: null }) }) }) }),
    rpc: async (_name, params) => {
      rpcCalls += 1;
      persisted = params.p_state as typeof previous;
      return { data: { result: "success", applied_revision: 25 }, error: null };
    },
  };
  const source = "35bea890-7c24-41c2-9e3d-7b5aa56f5afb";
  const outcome = await runCommerceStateRuntime(db, {
    conversation_id: "fbfc51ee-32a0-41dc-9ff5-451c5a8bf4e9",
    company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id: source,
    text,
    language: /[a-z]/i.test(text) && !/[\u3400-\u9fff]/u.test(text) ? "en" : "zh-TW",
    history: [
      { role: "visitor", content: "改做一部1匹，一部1.5匹。" },
      { role: "visitor", content: "客廳嗰部暫時唔買住。" },
      { role: "visitor", content: "咁我而家實際買幾多部冷氣？" },
    ],
    semantic_frame,
    industry_identifier: "home_appliance",
  });
  return { outcome, persisted, rpcCalls, source, originalProvenance };
}

Deno.test("C3 captured production turn 25 memory recall is read-only and outranks clarification", async () => {
  const previous = turn55CommerceState();
  const before = JSON.stringify(previous);
  const result = await executeTurn25Fixture("頭先冷氣嗰兩部你仲記唔記得？", turn25SemanticFrame(), previous);
  assert(result.outcome?.authority === "CONVERSATION_STATE", JSON.stringify(result.outcome));
  assert(result.outcome?.route === "commerce_state_answer", JSON.stringify(result.outcome));
  assert(result.outcome?.reason === "read_only_memory_or_current_state_recall_resolved", JSON.stringify(result.outcome));
  assert(result.outcome?.reply?.includes("2") && !/[?？]|最想完成/.test(result.outcome.reply), result.outcome?.reply ?? "missing reply");
  assert(result.outcome?.persist_result === "read_only" && result.outcome.revision === 24, JSON.stringify(result.outcome));
  assert(result.rpcCalls === 0, `read-only recall created ${result.rpcCalls} semantic event(s)`);
  assert(JSON.stringify(result.persisted) === before, JSON.stringify(result.persisted));
  assert(JSON.stringify(result.persisted.entities[0].provenance) === JSON.stringify(result.originalProvenance), JSON.stringify(result.persisted.entities[0].provenance));
  assert(result.persisted.entities[0].provenance.source_message_id !== result.source, JSON.stringify(result.persisted.entities[0].provenance));
  assert(result.persisted.entities.filter((entity) => !["cancelled", "deferred"].includes(entity.status)).reduce((sum, entity) => sum + entity.quantity, 0) === 2);
  assert(result.persisted.entities.find((entity) => entity.entity_id === "air_conditioner:living_room")?.status === "cancelled");

  const recall = prepareConversationRecall({
    conversation_id: "fbfc51ee-32a0-41dc-9ff5-451c5a8bf4e9",
    company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id: result.source,
    question: "頭先冷氣嗰兩部你仲記唔記得？",
    memory: null,
    commerce: {
      conversation_id: "fbfc51ee-32a0-41dc-9ff5-451c5a8bf4e9",
      company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
      source_message_id: "55a00000-0000-4000-8000-000000000016",
      revision: 24,
      state: previous,
    },
  }, "zh-TW");
  assert(recall.decision.handled && recall.decision.value === 2, JSON.stringify(recall.decision));
  assert(recall.metadata.response_route === "canonical_memory_recall", JSON.stringify(recall.metadata));
  assert(recall.reply?.includes("2 部") && !/[?？]|最想完成/.test(recall.reply), recall.reply ?? "missing reply");
});

Deno.test("C3 memory/current-state recall class covers Cantonese, English, status, ambiguity, mutation controls, and replay", async () => {
  for (const text of [
    "頭先嗰兩部呢？",
    "我之前最後話要幾多部？",
    "你記得我最後要幾多部嗎？",
    "Do you remember how many I settled on?",
    "Remind me what quantity I have now.",
  ]) {
    const result = await executeTurn25Fixture(text, null);
    assert(result.outcome?.reason === "read_only_memory_or_current_state_recall_resolved", `${text}:${JSON.stringify(result.outcome)}`);
    assert(result.outcome?.reply?.includes("2"), `${text}:${result.outcome?.reply}`);
    assert(result.rpcCalls === 0, `${text}:rpc=${result.rpcCalls}`);
    assert(JSON.stringify(result.persisted.entities[0].provenance) === JSON.stringify(result.originalProvenance), `${text}:provenance rebound`);
  }

  const status = await executeTurn25Fixture("你仲記唔記得客廳嗰部係咪取消咗？", null);
  assert(
    (status.outcome?.reply?.includes("取消") || status.outcome?.reply?.includes("cancelled")) &&
      status.rpcCalls === 0,
    JSON.stringify(status.outcome),
  );

  const ambiguousState = turn55CommerceState();
  ambiguousState.entities[0] = { ...ambiguousState.entities[0], entity_id: "air_conditioner:bedroom_a", quantity: 1 };
  ambiguousState.entities.push({ ...ambiguousState.entities[0], entity_id: "air_conditioner:bedroom_b" });
  const ambiguous = await executeTurn25Fixture("頭先嗰部你仲記唔記得？", null, ambiguousState);
  assert(ambiguous.outcome?.reply === null && ambiguous.rpcCalls === 0, JSON.stringify(ambiguous.outcome));

  const setFrame = turn25SemanticFrame();
  setFrame.operation = "SET_QUANTITY";
  setFrame.intent = "set quantity";
  setFrame.entities[0].quantity = 3;
  const set = await executeTurn25Fixture("唔係兩部，改做三部", setFrame);
  assert(set.rpcCalls === 1 && set.persisted.entities[0].quantity === 3, JSON.stringify(set.persisted));

  const addFrame = structuredClone(setFrame);
  addFrame.operation = "ADD_ITEM";
  addFrame.intent = "add another unit";
  addFrame.additive = true;
  addFrame.entities[0].quantity = 1;
  const add = await executeTurn25Fixture("加多一部", addFrame);
  assert(add.rpcCalls === 1 && add.persisted.entities[0].quantity === 3, JSON.stringify(add.persisted));

  const first = await executeTurn25Fixture("頭先冷氣嗰兩部你仲記唔記得？", turn25SemanticFrame());
  const replay = await executeTurn25Fixture("頭先冷氣嗰兩部你仲記唔記得？", turn25SemanticFrame());
  assert(first.rpcCalls === 0 && replay.rpcCalls === 0);
  assert(first.outcome?.revision === replay.outcome?.revision && first.outcome?.reply === replay.outcome?.reply);
});

function turn27SemanticFrame(
  topic = "refrigerator",
  requested_facts: string[] = ["width"],
): CommerceSemanticFrame {
  return {
    version: "commerce-semantic-1.0.0",
    language: "zh-TW",
    operation: "ASK_FACT",
    intent: "compare a product dimension against the current constraint",
    topic,
    entities: [],
    referents: [{ ref: "一部598mm", source: "prior_turn", confidence: 0.94 }],
    customer_correction: false,
    additive: false,
    explicit_negations: [],
    requested_facts,
    transaction_state: "none",
    payment_state: "none",
    booking_state: "none",
    fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null },
    confidence: 0.94,
  };
}

const turn27ProductionHistory = [
  { role: "visitor", content: "好。咁雪櫃繼續。" },
  { role: "visitor", content: "頭先冷氣嗰兩部你仲記唔記得？" },
  { role: "visitor", content: "等陣，係595mm樓下先啱，我個位得600，想留返位。" },
  { role: "visitor", content: "我最緊要唔好超過600闊，深少少冇所謂。" },
  { role: "visitor", content: "Panasonic有冇合適方向？" },
  { role: "visitor", content: "順便問埋雪櫃，想要三門，600mm樓下闊。" },
] as const;

async function executeTurn27Fixture(
  text: string,
  semantic_frame: CommerceSemanticFrame | null = turn27SemanticFrame(),
  history: Array<{ role: string; content: string }> = [...turn27ProductionHistory],
  previous = turn55CommerceState(),
) {
  const before = JSON.stringify(previous);
  let persisted = previous;
  let rpcCalls = 0;
  const db: CommerceStateDbClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { revision: 21, state: previous }, error: null }),
        }),
      }),
    }),
    rpc: async (_name, params) => {
      rpcCalls += 1;
      persisted = params.p_state as typeof previous;
      return { data: { result: "success", applied_revision: 22 }, error: null };
    },
  };
  const outcome = await runCommerceStateRuntime(db, {
    conversation_id: "36d27e7c-45c2-4f85-9845-914e2fe9fe3f",
    company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id: "cab996a5-f99b-4f66-b89e-3bb0e73e5ecc",
    text,
    language: /[a-z]/i.test(text) && !/[\u3400-\u9fff]/u.test(text) ? "en" : "zh-TW",
    history,
    semantic_frame,
    industry_identifier: "home_appliance",
  });
  return { before, outcome, persisted, rpcCalls };
}

Deno.test(
  "C3 captured production turn 27 rejects AC quantity and resolves refrigerator width constraint",
  async () => {
    const result = await executeTurn27Fixture("如果有一部598mm，我要唔要考慮？");
    assert(result.outcome?.route === "commerce_state_answer", JSON.stringify(result.outcome));
    assert(
      result.outcome?.reason === "read_only_attribute_constraint_query_resolved",
      JSON.stringify(result.outcome),
    );
    assert(
      result.outcome?.state_path === "customer_constraints.refrigerator.width",
      JSON.stringify(result.outcome),
    );
    assert(
      result.outcome?.reply?.includes("598") && result.outcome.reply.includes("595"),
      result.outcome?.reply ?? "missing reply",
    );
    assert(
      !/(?:冷氣|空調|air conditioner).{0,20}(?:x?2|兩部|2 個)/i.test(result.outcome?.reply ?? ""),
      result.outcome?.reply ?? "missing reply",
    );
    assert(
      result.outcome?.persist_result === "read_only" && result.outcome.revision === 21,
      JSON.stringify(result.outcome),
    );
    assert(result.rpcCalls === 0, `attribute query created ${result.rpcCalls} semantic event(s)`);
    assert(JSON.stringify(result.persisted) === result.before, JSON.stringify(result.persisted));
    assert(
      result.persisted.entities[0].quantity === 2 &&
        result.persisted.entities[1].status === "cancelled",
    );
  },
);

Deno.test(
  "C3 attribute-compatible referent routing is fail-closed across topic switches and quantities",
  async () => {
    const multi = turn55CommerceState();
    multi.entities.push({
      entity_id: "refrigerator:unscoped",
      category: "refrigerator",
      brand: null,
      model: null,
      quantity: 1,
      status: "researching",
      attributes: {},
      constraints: { max_width_mm: 595 },
      provenance: {
        source_type: "customer",
        source_message_id: "27a00000-0000-4000-8000-000000000001",
      },
    });

    const fridge = await executeTurn27Fixture(
      "雪櫃如果有一部598mm，我要唔要考慮？",
      turn27SemanticFrame(),
      [...turn27ProductionHistory],
      multi,
    );
    assert(
      fridge.outcome?.state_path === "entities.2.constraints.max_width_mm",
      JSON.stringify(fridge.outcome),
    );
    assert(fridge.outcome?.reply?.includes("598") && fridge.outcome.reply.includes("595"));

    const quantityFrame = turn27SemanticFrame("air_conditioner", ["current_quantity"]);
    const acQuantity = await executeTurn27Fixture(
      "我而家有幾多部冷氣？",
      quantityFrame,
      [...turn27ProductionHistory],
      multi,
    );
    assert(
      acQuantity.outcome?.state_path === "entities.0.quantity",
      JSON.stringify(acQuantity.outcome),
    );
    assert(
      acQuantity.outcome?.reply?.includes("2") && !acQuantity.outcome.reply.includes("雪櫃"),
      acQuantity.outcome?.reply ?? "missing reply",
    );

    for (const [text, fact, limit] of [
      ["雪櫃高度1820mm得唔得？", "height", "1800"],
      ["雪櫃深度680mm得唔得？", "depth", "650"],
    ] as const) {
      const dimension = await executeTurn27Fixture(
        text,
        turn27SemanticFrame("refrigerator", [fact]),
        [
          { role: "visitor", content: "雪櫃繼續。" },
          {
            role: "visitor",
            content: `雪櫃${fact === "height" ? "高度" : "深度"}最多${limit}mm。`,
          },
        ],
        multi,
      );
      assert(
        dimension.outcome?.state_path === `customer_constraints.refrigerator.${fact}`,
        JSON.stringify(dimension.outcome),
      );
      assert(
        dimension.outcome?.reply?.includes(limit),
        dimension.outcome?.reply ?? "missing reply",
      );
      assert(dimension.rpcCalls === 0 && JSON.stringify(dimension.persisted) === dimension.before);
    }

    const incompatible = await executeTurn27Fixture(
      "高度1820mm得唔得？",
      turn27SemanticFrame("", ["height"]),
      [],
      multi,
    );
    assert(
      incompatible.outcome?.reason === "read_only_attribute_constraint_query_unresolved",
      JSON.stringify(incompatible.outcome),
    );
    assert(
      incompatible.outcome?.reply?.includes("邊類產品") ||
        incompatible.outcome?.reply?.includes("which product"),
      incompatible.outcome?.reply ?? "missing reply",
    );
    assert(
      !incompatible.outcome?.state_path?.includes("entities.0.quantity"),
      JSON.stringify(incompatible.outcome),
    );

    const switched = await executeTurn27Fixture(
      "轉返雪櫃先，如果係598mm呢？",
      turn27SemanticFrame("refrigerator", ["width"]),
      [{ role: "visitor", content: "冷氣而家係兩部。" }, ...turn27ProductionHistory],
      multi,
    );
    assert(
      switched.outcome?.state_path === "entities.2.constraints.max_width_mm",
      JSON.stringify(switched.outcome),
    );

    const returned = await executeTurn27Fixture(
      "講返雪櫃，598mm嗰部呢？",
      turn27SemanticFrame("refrigerator", ["width"]),
      [{ role: "visitor", content: "冷氣嗰兩部我記得。" }, ...turn27ProductionHistory],
      multi,
    );
    assert(
      returned.outcome?.state_path === "entities.2.constraints.max_width_mm",
      JSON.stringify(returned.outcome),
    );
    assert(returned.rpcCalls === 0 && JSON.stringify(returned.persisted) === returned.before);

    const cancelledOnly = turn55CommerceState();
    cancelledOnly.entities[0] = { ...cancelledOnly.entities[0], status: "cancelled" };
    const cancelled = await executeTurn27Fixture(
      "我而家有幾多部冷氣？",
      quantityFrame,
      [],
      cancelledOnly,
    );
    assert(
      cancelled.outcome?.reply == null || !cancelled.outcome.reply.includes("2"),
      JSON.stringify(cancelled.outcome),
    );
    assert(cancelled.rpcCalls === 0);
  },
);

function turn48SemanticFrame(language: "zh-TW" | "en" = "zh-TW", ambiguous = false): CommerceSemanticFrame {
  return {
    version: "commerce-semantic-1.0.0",
    language,
    operation: "ASK_FACT",
    intent: "recall pending technician confirmation aggregate",
    topic: "installation",
    entities: [],
    referents: [{ ref: "pending technician checks", source: "persistent_state", confidence: ambiguous ? 0.5 : 0.96 }],
    customer_correction: false,
    additive: false,
    explicit_negations: [],
    requested_facts: [],
    transaction_state: "none",
    payment_state: "none",
    booking_state: "none",
    fulfillment_state: "none",
    ambiguity: {
      is_ambiguous: ambiguous,
      reasons: ambiguous ? ["multiple installation referents"] : [],
      clarification_question: ambiguous ? "Which installation?" : null,
    },
    confidence: 0.55,
  };
}

function turn48CommerceState() {
  const state = turn55CommerceState();
  state.installation.pending_checks = ["installation_site_check"];
  state.installation.items = [];
  state.unresolved_items = ["confirm installation feasibility after site check"];
  state.current_topic = "installation";
  state.metadata = {
    captured_turn: 47,
    fallback_reason: "NO_SUPPORTED_FACT_SLOT",
    source_message_id: "48a00000-0000-4000-8000-000000000047",
  };
  return state;
}

async function executeTurn48Fixture(
  text: string,
  options: {
    previous?: ReturnType<typeof turn48CommerceState>;
    semantic_frame?: CommerceSemanticFrame | null;
    revision?: number;
    language?: "zh-TW" | "zh-CN" | "en";
    source_message_id?: string;
  } = {},
) {
  const previous = options.previous ?? turn48CommerceState();
  const before = JSON.stringify(previous);
  let persisted = previous;
  let rpcCalls = 0;
  const db: CommerceStateDbClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: options.revision === 0 ? null : { revision: options.revision ?? 40, state: previous },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (_name, params) => {
      rpcCalls += 1;
      persisted = params.p_state as typeof previous;
      return { data: { result: "success", applied_revision: 41 }, error: null };
    },
  };
  const outcome = await runCommerceStateRuntime(db, {
    conversation_id: "19484609-961e-4f5f-b1c6-b731afb79313",
    company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id: options.source_message_id ?? "d4c905ae-35bf-4c4b-bc5b-c9e377e70fc7",
    text,
    language: options.language ?? "zh-TW",
    history: [
      { role: "visitor", content: "窗口同安裝位要師傅上門睇。" },
      { role: "visitor", content: "客廳嗰部取消，冷氣而家兩部。" },
      { role: "visitor", content: "雪櫃闊度唔可以超過595mm。" },
    ],
    semantic_frame: options.semantic_frame === undefined
      ? turn48SemanticFrame(options.language === "en" ? "en" : "zh-TW")
      : options.semantic_frame,
    industry_identifier: "home_appliance",
  });
  return { before, outcome, persisted, rpcCalls };
}

Deno.test("C3 captured production turn 48 resolves pending technician count read-only before clarification", async () => {
  const previous = turn48CommerceState();
  const provenanceBefore = JSON.stringify(previous.entities.map((entity) => entity.provenance));
  const result = await executeTurn48Fixture("我而家有幾多項要師傅確認？", { previous });
  assert(isReadOnlyCurrentStateAggregateQuery("我而家有幾多項要師傅確認？", turn48SemanticFrame()));
  assert(result.outcome?.route === "commerce_state_answer", JSON.stringify(result.outcome));
  assert(result.outcome?.reason === "read_only_current_state_aggregate_query_resolved", JSON.stringify(result.outcome));
  assert(result.outcome?.state_path === "installation.pending_checks");
  assert(result.outcome?.reply?.includes("1") && result.outcome.reply.includes("安裝現場檢查"), result.outcome?.reply ?? "missing reply");
  assert(!/[?？]|最想完成/.test(result.outcome?.reply ?? ""));
  assert(result.outcome?.persist_result === "read_only" && result.outcome.revision === 40);
  assert(result.rpcCalls === 0, `aggregate query created ${result.rpcCalls} semantic event(s)`);
  assert(JSON.stringify(result.persisted) === result.before);
  assert(JSON.stringify(result.persisted.entities.map((entity) => entity.provenance)) === provenanceBefore);
});

Deno.test("C3 pending technician aggregate count and list queries preserve zero, unknown, mutation and replay boundaries", async () => {
  for (const [text, language] of [
    ["我而家有幾多項要師傅確認？", "zh-TW"],
    ["仲有幾多項未確認？", "zh-TW"],
    ["How many checks are still pending?", "en"],
  ] as const) {
    const result = await executeTurn48Fixture(text, { language, semantic_frame: turn48SemanticFrame(language === "en" ? "en" : "zh-TW") });
    assert(result.outcome?.reason === "read_only_current_state_aggregate_query_resolved", `${text}:${JSON.stringify(result.outcome)}`);
    assert(result.outcome?.reply?.includes("1"), result.outcome?.reply ?? text);
    assert(result.rpcCalls === 0 && JSON.stringify(result.persisted) === result.before);
  }

  const list = await executeTurn48Fixture("仲有邊啲要師傅確認？");
  assert(list.outcome?.reply?.includes("安裝現場檢查"));
  assert(list.rpcCalls === 0);

  const zeroState = turn48CommerceState();
  zeroState.installation.pending_checks = [];
  const zero = await executeTurn48Fixture("我而家有幾多項要師傅確認？", { previous: zeroState });
  assert(zero.outcome?.reply?.includes("冇待師傅確認"));
  assert(zero.rpcCalls === 0);

  const unknown = await executeTurn48Fixture("仲有邊啲要師傅確認？", { revision: 0 });
  assert(unknown.outcome?.reason === "read_only_current_state_aggregate_query_unresolved");
  assert(unknown.outcome?.reply?.includes("邊件產品或邊項安裝") && !unknown.outcome.reply.includes("最想完成"));
  assert(unknown.rpcCalls === 0);

  const ambiguous = await executeTurn48Fixture("呢兩件貨邊啲要師傅確認？", { semantic_frame: turn48SemanticFrame("zh-TW", true) });
  assert(ambiguous.outcome?.reason === "read_only_current_state_aggregate_query_unresolved");
  assert(ambiguous.rpcCalls === 0);

  const added = await executeTurn48Fixture("新增一項排水檢查，請師傅確認。", { semantic_frame: null, source_message_id: "48a00000-0000-4000-8000-000000000048" });
  assert(added.rpcCalls === 1);
  assert(added.persisted.installation.pending_checks.includes("drainage_check"));
  assert(added.persisted.installation.pending_checks.includes("installation_site_check"));

  const cancelledState = turn48CommerceState();
  cancelledState.installation.pending_checks.push("drainage_check");
  const cancelled = await executeTurn48Fixture("取消排水檢查。", { previous: cancelledState, semantic_frame: null, source_message_id: "48a00000-0000-4000-8000-000000000049" });
  assert(cancelled.rpcCalls === 1);
  assert(!cancelled.persisted.installation.pending_checks.includes("drainage_check"));
  assert(cancelled.persisted.installation.pending_checks.includes("installation_site_check"));

  const first = await executeTurn48Fixture("我而家有幾多項要師傅確認？");
  const replay = await executeTurn48Fixture("我而家有幾多項要師傅確認？", { previous: first.persisted, source_message_id: "d4c905ae-35bf-4c4b-bc5b-c9e377e70fc7" });
  assert(first.rpcCalls === 0 && replay.rpcCalls === 0);
  assert(first.before === JSON.stringify(replay.persisted));
});
