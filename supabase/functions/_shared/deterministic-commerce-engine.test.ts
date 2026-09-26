import {
  classifyIntent,
  detectLocale,
  extractEntities,
  INTENT_RULES,
  registryIdentity,
  resolveBoundedReference,
  RESPONSE_TEMPLATES,
  runDeterministicCommerceEngine,
  validateGovernedRegistry,
} from "./deterministic-commerce-engine.ts";

const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};

Deno.test("deterministic locale covers en-US, zh-HK and zh-TW without inferring market", () => {
  assert(detectLocale("Please check my delivery") === "en-US", "en");
  assert(detectLocale("件貨仲未到，點算？") === "zh-HK", "hk");
  assert(detectLocale("商品還沒送到，請協助") === "zh-TW", "tw");
  const result = runDeterministicCommerceEngine({
    text: "件貨仲未到",
    market: "UNKNOWN",
  });
  assert(
    result.locale === "zh-HK" && result.market === "UNKNOWN",
    "language_must_not_infer_market",
  );
});

Deno.test("intent synonyms and written Cantonese are deterministic", () => {
  const rows: Array<[string, string]> = [
    ["Where is my shipment?", "shipping_delivery"],
    ["件貨派咗去邊？", "shipping_delivery"],
    ["台灣門市還有現貨嗎", "stock_availability"],
    ["我想退錢", "returns_refunds"],
    ["Please cancel my order", "order_change_cancellation"],
    ["信用咭付款失敗", "checkout_payment"],
    ["第三方賣家寄錯貨", "marketplace_seller"],
    ["VIP會員有咩權益", "crm_entitlement_vip"],
    ["我要真人客服", "explicit_human_request"],
    ["產品冒煙，有危險", "product_quality_safety"],
  ];
  for (const [text, intent] of rows) {
    assert(classifyIntent(text).intent === intent, `${text}:${classifyIntent(text).intent}`);
  }
});

Deno.test("entity extraction preserves spans and typed values", () => {
  const text = "Order number ABC-12345, model XY-9, quantity 2 units, USD 19.50";
  const rows = extractEntities(text);
  assert(
    rows.some((row) => row.kind === "order_reference" && row.value === "ABC-12345"),
    "order",
  );
  assert(
    rows.some((row) => row.kind === "sku_or_model" && row.value === "XY-9"),
    "model",
  );
  assert(
    rows.some((row) => row.kind === "quantity" && row.value === 2),
    "qty",
  );
  assert(
    rows.every((row) => text.slice(row.span.start, row.span.end) === row.span.text),
    "span",
  );
});

Deno.test("market policy is fail-closed and never inferred from language", () => {
  const result = runDeterministicCommerceEngine({
    text: "香港保養政策是甚麼？",
    locale_hint: "zh-HK",
    market: "UNKNOWN",
  });
  assert(result.template_id === "T-zh-HK-MARKET", "market_clarification");
  assert(result.response.includes("美國、香港定台灣"), "market_options");
});

Deno.test("low confidence clarifies once then offers human without claiming completion", () => {
  const first = runDeterministicCommerceEngine({
    text: "幫我搞掂",
    market: "HK",
    clarification_attempts: 0,
  });
  const second = runDeterministicCommerceEngine({
    text: "都係搞唔掂",
    market: "HK",
    clarification_attempts: 2,
  });
  assert(first.action === "clarify", "first_clarify");
  assert(second.action === "offer_handoff" && !second.requires_atomic_handoff, "offer_only");
  assert(!/已轉交|已转交|handed off/i.test(second.response), "false_handoff");
});

Deno.test("explicit human requires confirmation and atomic RPC before completion", () => {
  const offer = runDeterministicCommerceEngine({
    text: "I want a human agent",
    market: "US",
  });
  const confirmed = runDeterministicCommerceEngine({
    text: "I want a human agent",
    market: "US",
    customer_confirms_handoff: true,
  });
  assert(offer.action === "offer_handoff" && !offer.requires_atomic_handoff, "offer");
  assert(
    confirmed.action === "handoff_pending" && confirmed.requires_atomic_handoff,
    "pending_rpc",
  );
  assert(!confirmed.response.includes("has been handed"), "no_completion_before_rpc");
});

Deno.test("safety answer forbids refund or replacement promises", () => {
  const result = runDeterministicCommerceEngine({
    text: "The product is smoking and unsafe",
    market: "US",
  });
  assert(
    result.action === "answer" && result.prohibited_claims.includes("refund_confirmed"),
    "safety",
  );
  assert(result.response.includes("no replacement or refund is confirmed"), "no_promise");
});

Deno.test("CRM accepts only active scope-matched entitlement", () => {
  const expired = runDeterministicCommerceEngine({
    text: "What are my VIP benefits?",
    market: "US",
    crm_entitlements: [
      {
        name: "VIP",
        value: "free delivery",
        status: "expired",
        scope_matches: true,
      },
    ],
  });
  const mismatch = runDeterministicCommerceEngine({
    text: "What are my VIP benefits?",
    market: "US",
    crm_entitlements: [
      {
        name: "VIP",
        value: "free delivery",
        status: "active",
        scope_matches: false,
      },
    ],
  });
  const active = runDeterministicCommerceEngine({
    text: "What are my VIP benefits?",
    market: "US",
    crm_entitlements: [
      {
        name: "VIP",
        value: "free delivery",
        status: "active",
        scope_matches: true,
      },
    ],
  });
  assert(expired.action === "clarify" && mismatch.action === "clarify", "fail_closed");
  assert(active.action === "answer" && active.response.includes("free delivery"), "trusted_only");
});

Deno.test("calculation requires one explicit currency and never confirms quote/payment", () => {
  const valid = runDeterministicCommerceEngine({
    text: "Calculate USD 10 and USD 20 total",
    market: "US",
  });
  const mixed = runDeterministicCommerceEngine({
    text: "Calculate USD 10 and HKD 20 total",
    market: "US",
  });
  assert(valid.action === "answer" && valid.response.includes("USD 30.00"), "sum");
  assert(valid.prohibited_claims.includes("payment_confirmed"), "guard");
  assert(mixed.action === "clarify", "mixed_currency");
});

Deno.test("100+ turns are bounded to twelve and latest correction wins", () => {
  const turns = Array.from({ length: 101 }, (_, index) => ({
    role: "customer",
    content: index === 100 ? "Order ABC-99999 delivery" : `old order OLD-${index}`,
  }));
  const resolved = resolveBoundedReference("cancel that", turns, {
    current_topic: "OLD",
  });
  assert(resolved.used_memory && resolved.inspected_turns === 12, "bounded");
  assert(resolved.text.includes("ABC-99999") && resolved.text.endsWith("cancel that"), "latest");
  assert(
    classifyIntent(resolved.text).intent === "correction_cancellation",
    "correction_precedence",
  );
});

Deno.test("registry governance is approved, non-self-approved, active and hash-bound", async () => {
  for (const row of [...INTENT_RULES, ...RESPONSE_TEMPLATES]) {
    assert(row.author !== row.human_approver, "self_approval");
    assert(["qa", "supervisor", "admin"].includes(row.approver_role), "role");
    assert(/^[0-9a-f]{64}$/.test(row.content_sha256) && !row.revoked, "hash_or_revocation");
  }
  const identity = await registryIdentity();
  assert(/^[0-9a-f]{64}$/.test(identity.rule_pack_sha256), "rule_pack_hash");
  assert(/^[0-9a-f]{64}$/.test(identity.template_pack_sha256), "template_pack_hash");
});

Deno.test("template collision and revocation fail closed", () => {
  const now = new Date("2026-09-17T12:00:00Z");
  assert(
    validateGovernedRegistry(INTENT_RULES, RESPONSE_TEMPLATES, now).active_template_count ===
      RESPONSE_TEMPLATES.length,
    "active_registry",
  );
  const duplicate = [...RESPONSE_TEMPLATES, RESPONSE_TEMPLATES[0]];
  let collision = false;
  try {
    validateGovernedRegistry(INTENT_RULES, duplicate, now);
  } catch (error) {
    collision = String(error).includes("template_collision");
  }
  assert(collision, "collision_not_rejected");
  const revoked = RESPONSE_TEMPLATES.map((row) => ({ ...row, revoked: true }));
  let empty = false;
  try {
    validateGovernedRegistry(INTENT_RULES, revoked, now);
  } catch (error) {
    empty = String(error).includes("governed_registry_empty");
  }
  assert(empty, "revoked_registry_not_rejected");
});

Deno.test("repeatability produces byte-identical result", () => {
  const input = {
    text: "Order number ABC-12345 delivery is late",
    market: "US" as const,
    now: new Date("2026-09-17T12:00:00Z"),
  };
  assert(
    JSON.stringify(runDeterministicCommerceEngine(input)) ===
      JSON.stringify(runDeterministicCommerceEngine(input)),
    "not_repeatable",
  );
});
