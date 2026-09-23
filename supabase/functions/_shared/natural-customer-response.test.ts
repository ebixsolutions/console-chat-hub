import {
  classifyNaturalCustomerIntent,
  exactProductIdentifiers,
  renderNaturalImmediateResponse,
  renderNaturalNoCurrentEvidence,
  requiresCurrentMerchantEvidence,
} from "./natural-customer-response.ts";
import {
  type CommerceStateDbClient,
  runCommerceStateRuntime,
} from "./commerce-state-runtime.ts";
import {
  type ConversationCommerceState,
  createEmptyConversationCommerceState,
} from "./commerce-state-contract.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";

const assert: (value: unknown, message: string) => asserts value = (
  value,
  message,
) => {
  if (!value) throw new Error(message);
};

const forbidden =
  /你今次最想完成哪一件事|根據這段對話已有的資料|canonical|bounded answer|knowledge-base lookup/i;

Deno.test("A3 exact identifier no-current-evidence never re-asks for the supplied model", () => {
  for (const row of [
    { text: "有沒有 NONEXISTENT-999999？", language: "zh-TW" as const,
      identifier: "NONEXISTENT-999999", reask: /指定型號|提供型號|型號的話/u },
    { text: "Do you have ABC-12345?", language: "en" as const,
      identifier: "ABC-12345", reask: /specific model|provide.*model/i },
    { text: "有没有品牌 ZX9000？", language: "zh-CN" as const,
      identifier: "ZX9000", reask: /指定型号|提供型号/u },
    { text: "有沒有 ACME 冷氣 CW-SUL90BA？", language: "zh-TW" as const,
      identifier: "CW-SUL90BA", reask: /指定型號|提供型號/u },
  ]) {
    const intent = classifyNaturalCustomerIntent(row.text);
    assert(intent.kind === "product_availability", `${row.text}:${JSON.stringify(intent)}`);
    assert(exactProductIdentifiers(intent.product).includes(row.identifier), `${row.text}:identifier`);
    const reply = renderNaturalNoCurrentEvidence(intent, row.language) ?? "";
    assert(reply.includes(row.identifier) && /未能確認|无法确认|cannot confirm/i.test(reply), reply);
    assert(!row.reask.test(reply) && !/有現貨|in stock now|已確認有售/i.test(reply), reply);
    console.log(`A3 ${row.language}: ${reply}`);
  }
});

Deno.test("A3 broad or absent product keeps targeted clarification possible", () => {
  const broad = classifyNaturalCustomerIntent("你哋有冇 Panasonic 冷氣？");
  assert(broad.kind === "product_availability" &&
    exactProductIdentifiers(broad.product).length === 0, JSON.stringify(broad));
  const broadReply = renderNaturalNoCurrentEvidence(broad, "zh-TW") ?? "";
  assert(/指定型號/.test(broadReply) && /Panasonic 冷氣/.test(broadReply), broadReply);
  console.log("A3 broad:", broadReply);

  const absent = classifyNaturalCustomerIntent("你哋有冇？");
  assert(absent.kind === "product_availability" && absent.product === null, JSON.stringify(absent));
  const targeted = renderNaturalImmediateResponse(absent, "zh-TW") ?? "";
  assert(targeted === "你想查邊類產品或邊個型號？", targeted);
  console.log("A3 absent:", targeted);
  const englishAbsent = classifyNaturalCustomerIntent("Do you have?");
  assert(englishAbsent.kind === "product_availability" && englishAbsent.product === null, JSON.stringify(englishAbsent));
  assert(renderNaturalImmediateResponse(englishAbsent, "en") === "Which product or model would you like me to check?", "english_targeted_clarification");

  for (const text of ["Panasonic 冷氣", "coffee grinder", "17", "A12", "S26", "三門雪櫃"]) {
    assert(exactProductIdentifiers(text).length === 0, `${text}:false_model`);
  }
});

Deno.test("C3 greeting classifier renders natural zh-TW greeting without swallowing product intent", () => {
  for (const text of ["Hi", "你好", "早晨", "Hi / 你好", "Hello，早晨"]) {
    const intent = classifyNaturalCustomerIntent(text);
    assert(intent.kind === "greeting", `${text}:${JSON.stringify(intent)}`);
    assert(
      renderNaturalImmediateResponse(intent, "zh-TW") === "你好！有咩可以幫你？",
      text,
    );
  }
  const text = "Hi，想問冷氣，兩間房加個廳，唔知買咩匹數好";
  const intent = classifyNaturalCustomerIntent(text);
  assert(intent.kind === "product_guidance", `${text}:${JSON.stringify(intent)}`);
});

Deno.test("C3 natural-response 8 killer contract preserves shared precedence", () => {
  const availability = classifyNaturalCustomerIntent("你有沒有 iPhone?");
  assert(
    availability.kind === "product_availability",
    JSON.stringify(availability),
  );
  assert(availability.product === "iPhone", JSON.stringify(availability));
  assert(requiresCurrentMerchantEvidence(availability), "availability_lookup");
  const unknown = renderNaturalNoCurrentEvidence(availability, "zh-TW") ?? "";
  assert(/iPhone/.test(unknown) && /未能確認/.test(unknown), unknown);
  assert(/指定型號/.test(unknown) && !forbidden.test(unknown), unknown);

  const nonNaturalKillerCases = [
    "你而家記得我要幾多部冷氣？",
    "我最後係買三部定兩部？",
    "如果有一部598mm，我要唔要考慮？",
    "我而家有幾多項要師傅確認？",
    "唔係A座，係B座，我打錯。",
    "今次送貨政策未有資料，應該點處理？",
    "我要真人客服",
  ];
  for (const text of nonNaturalKillerCases) {
    const intent = classifyNaturalCustomerIntent(text);
    assert(intent.kind === "none", `${text}:${JSON.stringify(intent)}`);
  }
});

const demoCases: Array<{
  text: string;
  language: "zh-TW" | "zh-CN" | "en";
  kind: "greeting" | "product_shopping" | "product_availability";
  product?: string;
}> = [
  { text: "你好", language: "zh-TW", kind: "greeting" },
  { text: "嗨！", language: "zh-TW", kind: "greeting" },
  { text: "早安", language: "zh-TW", kind: "greeting" },
  { text: "Hi", language: "en", kind: "greeting" },
  { text: "Good evening!", language: "en", kind: "greeting" },
  {
    text: "我想買 iPhone",
    language: "zh-TW",
    kind: "product_shopping",
    product: "iPhone",
  },
  {
    text: "我想購買 Panasonic 雪櫃",
    language: "zh-TW",
    kind: "product_shopping",
    product: "Panasonic 雪櫃",
  },
  {
    text: "我打算入手一部洗衣機",
    language: "zh-TW",
    kind: "product_shopping",
    product: "洗衣機",
  },
  {
    text: "我想买 Galaxy S26",
    language: "zh-CN",
    kind: "product_shopping",
    product: "Galaxy S26",
  },
  {
    text: "I want to buy an iPhone",
    language: "en",
    kind: "product_shopping",
    product: "iPhone",
  },
  {
    text: "I am looking to purchase a laptop",
    language: "en",
    kind: "product_shopping",
    product: "laptop",
  },
  {
    text: "你有沒有 iPhone?",
    language: "zh-TW",
    kind: "product_availability",
    product: "iPhone",
  },
  {
    text: "你哋有冇 Panasonic 冷氣？",
    language: "zh-TW",
    kind: "product_availability",
    product: "Panasonic 冷氣",
  },
  {
    text: "店內有沒有三門雪櫃？",
    language: "zh-TW",
    kind: "product_availability",
    product: "三門雪櫃",
  },
  {
    text: "这里有没有前置式洗衣机？",
    language: "zh-CN",
    kind: "product_availability",
    product: "前置式洗衣机",
  },
  {
    text: "Do you have iPhone 17?",
    language: "en",
    kind: "product_availability",
    product: "iPhone 17",
  },
  {
    text: "Does the store carry MacBook Air?",
    language: "en",
    kind: "product_availability",
    product: "MacBook Air",
  },
  {
    text: "Is Galaxy S26 available?",
    language: "en",
    kind: "product_availability",
    product: "Galaxy S26",
  },
  {
    text: "你們是否有吸塵機現貨？",
    language: "zh-TW",
    kind: "product_availability",
    product: "吸塵機",
  },
  {
    text: "Are there any gaming laptops in stock?",
    language: "en",
    kind: "product_availability",
    product: "gaming laptops",
  },
];

Deno.test("C3 20-case customer demo natural-response gate", () => {
  let naturalAcceptable = 0;
  for (const [index, row] of demoCases.entries()) {
    const intent = classifyNaturalCustomerIntent(row.text);
    assert(intent.kind === row.kind, `T${index + 1}:${JSON.stringify(intent)}`);
    if (row.product) {
      assert(intent.product === row.product, `T${index + 1}:${intent.product}`);
    }
    const reply = intent.kind === "product_availability"
      ? renderNaturalNoCurrentEvidence(intent, row.language)
      : renderNaturalImmediateResponse(intent, row.language);
    assert(reply && reply.trim().length > 0, `T${index + 1}:empty`);
    assert(!forbidden.test(reply), `T${index + 1}:machine:${reply}`);
    assert(
      !/已確認有售|有現貨|in stock now|currently available/i.test(reply),
      `T${index + 1}:fabrication:${reply}`,
    );
    if (intent.kind === "product_availability") {
      assert(
        /未能確認|无法确认|cannot confirm/i.test(reply),
        `T${index + 1}:honesty:${reply}`,
      );
      assert(requiresCurrentMerchantEvidence(intent), `T${index + 1}:lookup`);
    }
    naturalAcceptable += 1;
  }
  assert(demoCases.length === 20, "demo_count");
  assert(naturalAcceptable >= 18, `natural_acceptability:${naturalAcceptable}`);
  console.log(
    `C3_CUSTOMER_DEMO|cases=20|p0=0|dead_end=0|reask=0|natural=${naturalAcceptable}|result=PASS`,
  );
});

Deno.test("C3 mixed greeting product guidance stays natural without hiding the commerce writer", () => {
  const intent = classifyNaturalCustomerIntent(
    "Hi，想問冷氣，兩間房加個廳，唔知買咩匹數好。",
  );
  assert(intent.kind === "product_guidance", JSON.stringify(intent));
  assert(intent.product === "冷氣", JSON.stringify(intent));
  const reply = renderNaturalImmediateResponse(intent, "zh-TW") ?? "";
  assert(/冷氣/.test(reply) && /用途|尺寸|空間|安裝/.test(reply), reply);
  assert(!forbidden.test(reply), reply);
});

Deno.test("C3 natural-response negatives preserve correction cancellation handoff and recall", () => {
  for (
    const text of [
      "地址唔係A座，改做B座。",
      "取消客廳嗰部冷氣。",
      "星期六改做星期日送。",
      "我最後係買三部定兩部？",
      "請轉真人客服。",
      "而家實際售價可能同舊報價唔同係咪？",
    ]
  ) {
    const intent = classifyNaturalCustomerIntent(text);
    assert(intent.kind === "none", `${text}:${JSON.stringify(intent)}`);
  }
});

Deno.test("C3 production-parity semantic ASK_FACT still persists and scopes product research", async () => {
  let state = createEmptyConversationCommerceState();
  let revision = 0;
  const db: CommerceStateDbClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: revision ? { revision, state } : null,
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (_name, params) => {
      state = params.p_state as ConversationCommerceState;
      revision += 1;
      return {
        data: { result: "success", applied_revision: revision },
        error: null,
      };
    },
  };
  const semantic = (
    topic: string,
    requested: string[],
  ): CommerceSemanticFrame => ({
    version: "commerce-semantic-1.0.0",
    language: "zh-TW",
    operation: "ASK_FACT",
    intent: "product research",
    topic,
    entities: [],
    referents: [],
    customer_correction: false,
    additive: false,
    explicit_negations: [],
    requested_facts: requested,
    transaction_state: "none",
    payment_state: "none",
    booking_state: "none",
    fulfillment_state: "none",
    ambiguity: {
      is_ambiguous: false,
      reasons: [],
      clarification_question: null,
    },
    confidence: 0.94,
  });
  const run = (
    id: number,
    text: string,
    frame: CommerceSemanticFrame | null,
    history: Array<{ role: string; content: string }>,
  ) =>
    runCommerceStateRuntime(db, {
      conversation_id: "21000000-0000-4000-8000-000000000001",
      company_id: "21000000-0000-4000-8000-000000000002",
      source_message_id: `21000000-0000-4000-8000-${
        String(id).padStart(12, "0")
      }`,
      text,
      language: "zh-TW",
      history,
      semantic_frame: frame,
      industry_identifier: "home_appliance",
    });

  const initial = await run(
    21,
    "順便問埋雪櫃，想要三門，600mm樓下闊。",
    semantic("refrigerator", ["width"]),
    [],
  );
  const fridge = state.entities.find((entity) =>
    entity.category === "refrigerator"
  );
  assert(
    fridge?.constraints.max_width_mm === 600,
    `${JSON.stringify(initial)}:${JSON.stringify(state.entities)}`,
  );

  const constraint = await run(
    56,
    "雪櫃限制呢？",
    semantic("refrigerator", ["constraints"]),
    [
      { role: "visitor", content: "順便問埋雪櫃，想要三門，600mm樓下闊。" },
    ],
  );
  assert(constraint?.reply?.includes("600"), JSON.stringify(constraint));
  assert(
    !/冷氣|air_conditioner/i.test(constraint?.reply ?? ""),
    constraint?.reply ?? "",
  );

  await run(
    61,
    "再問埋洗衣機，我位得600闊。",
    semantic("washing_machine", ["width"]),
    [
      { role: "visitor", content: "雪櫃限制呢？" },
    ],
  );
  const washer = state.entities.find((entity) =>
    entity.category === "washing_machine"
  );
  assert(
    washer?.constraints.max_width_mm === 600,
    JSON.stringify(state.entities),
  );

  const correction = await run(63, "之前雪櫃嗰個闊度限制取消啦。", null, [
    { role: "visitor", content: "前置式，8kg左右。" },
    { role: "visitor", content: "再問埋洗衣機，我位得600闊。" },
  ]);
  const correctedFridge = state.entities.find((entity) =>
    entity.category === "refrigerator"
  );
  const unchangedWasher = state.entities.find((entity) =>
    entity.category === "washing_machine"
  );
  assert(
    correctedFridge?.status !== "cancelled",
    JSON.stringify(correctedFridge),
  );
  assert(
    correctedFridge?.constraints.max_width_mm === undefined,
    `${JSON.stringify(correction)}:${JSON.stringify(correctedFridge)}`,
  );
  assert(
    unchangedWasher?.constraints.max_width_mm === 600,
    JSON.stringify(unchangedWasher),
  );

  await run(66, "洗衣機未決定買住。", null, []);
  assert(
    state.entities.find((entity) => entity.category === "washing_machine")
      ?.status === "deferred",
    JSON.stringify(state.entities),
  );
});
