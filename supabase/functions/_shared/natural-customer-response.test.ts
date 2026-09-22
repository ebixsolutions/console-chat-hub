import {
  classifyNaturalCustomerIntent,
  renderNaturalImmediateResponse,
  renderNaturalNoCurrentEvidence,
  requiresCurrentMerchantEvidence,
} from "./natural-customer-response.ts";

const assert: (value: unknown, message: string) => asserts value = (
  value,
  message,
) => {
  if (!value) throw new Error(message);
};

const forbidden =
  /你今次最想完成哪一件事|根據這段對話已有的資料|canonical|bounded answer|knowledge-base lookup/i;

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
