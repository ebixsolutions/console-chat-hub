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
  runCommerceStateRuntime,
  type CommerceStateDbClient,
} from "./commerce-state-runtime.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { planConversationService, renderTargetedServiceQuestion } from "./conversation-service-planner.ts";
import { buildCanonicalConversationMemory } from "./conversation-long-memory.ts";

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
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
    "if (_a3Commerce && _a3Commerce.reply && !_explicitHandoffRequested)";
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
