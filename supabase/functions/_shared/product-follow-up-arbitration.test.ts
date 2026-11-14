import {
  arbitrateAnaphoricProductFollowUp,
  renderNaturalImmediateResponse,
  requiresCurrentMerchantEvidence,
} from "./natural-customer-response.ts";

function assert(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(detail);
}

const prior = [{
  role: "visitor",
  content: "細房我見到 ZX-AB12345，佢有咩功能、係幾多匹？80呎用落夠唔夠？",
}];

for (
  const [question, fact] of [
    ["呢部幾錢？", "price"],
    ["呢款而家售價幾多？", "price"],
    ["佢賣幾錢？", "price"],
    ["How much is this one?", "price"],
    ["What's the current price of that model?", "price"],
    ["呢部有咩功能？", "features"],
    ["佢幾多匹？", "horsepower"],
    ["Is this one suitable for 80 sq ft?", "suitability"],
  ] as const
) {
  Deno.test(`W15 resolved product follow-up: ${question}`, () => {
    const result = arbitrateAnaphoricProductFollowUp(question, prior);
    assert(result.kind === "resolved", JSON.stringify(result));
    assert(
      result.intent.product === "ZX-AB12345" &&
        result.intent.facts.includes(fact) &&
        result.grounded_question.includes("ZX-AB12345") &&
        requiresCurrentMerchantEvidence(result.intent),
      JSON.stringify(result),
    );
  });
}

Deno.test("W15 Commerce quantity recall is not suppressed", () => {
  assert(
    arbitrateAnaphoricProductFollowUp("我而家要幾多部？", prior).kind ===
      "not_applicable",
    "quantity_was_reclassified",
  );
});

Deno.test("W15 order-state recall is not suppressed", () => {
  assert(
    arbitrateAnaphoricProductFollowUp("三部係咪已經落咗單？", prior).kind ===
      "not_applicable",
    "order_state_was_reclassified",
  );
});

Deno.test("W15 competing product referents require targeted clarification", () => {
  const result = arbitrateAnaphoricProductFollowUp("呢部幾錢？", [{
    role: "visitor",
    content: "我比較緊 ZX-AB12345 同 QN-CD67890。",
  }]);
  assert(
    result.kind === "clarification" &&
      result.intent.reason === "MULTIPLE_COMPATIBLE_PRODUCT_REFERENTS" &&
      result.intent.candidates.join(",") === "ZX-AB12345,QN-CD67890",
    JSON.stringify(result),
  );
  const reply = result.kind === "clarification"
    ? renderNaturalImmediateResponse(result.intent, "zh-TW")
    : null;
  assert(
    reply === "你指邊個型號：ZX-AB12345 / QN-CD67890？",
    String(reply),
  );
});

Deno.test("W15 incompatible category switch cannot inherit the prior product", () => {
  const result = arbitrateAnaphoricProductFollowUp("呢部有咩功能？", [
    { role: "visitor", content: "另外想轉睇雪櫃，闊度最多595mm。" },
    ...prior,
  ]);
  assert(
    result.kind === "clarification" &&
      result.intent.reason === "INCOMPATIBLE_RECENT_PRODUCT_CONTEXT" &&
      result.intent.candidates.length === 0,
    JSON.stringify(result),
  );
});

Deno.test("W15 cancelled or deferred referent is never revived", () => {
  for (
    const inactive of [
      "ZX-AB12345 嗰部取消，唔要。",
      "嗰部暫緩，遲啲先。",
    ]
  ) {
    const result = arbitrateAnaphoricProductFollowUp("佢賣幾錢？", [
      { role: "visitor", content: inactive },
      ...prior,
    ]);
    assert(
      result.kind === "clarification" &&
        result.intent.reason === "INACTIVE_OR_SUPERSEDED_PRODUCT_REFERENT",
      `${inactive}:${JSON.stringify(result)}`,
    );
  }
});

Deno.test("W15 absent explicit product referent fails safe", () => {
  const result = arbitrateAnaphoricProductFollowUp("How much is this one?", [{
    role: "visitor",
    content: "I need something for my bedroom.",
  }]);
  assert(
    result.kind === "clarification" &&
      result.intent.reason === "NO_RECENT_EXPLICIT_PRODUCT_REFERENT",
    JSON.stringify(result),
  );
});

Deno.test("W15 product support remains outside factual arbitration", () => {
  assert(
    arbitrateAnaphoricProductFollowUp("佢開唔到機，點處理？", prior).kind ===
      "not_applicable",
    "support_was_reclassified",
  );
});
