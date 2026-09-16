import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import {
  applyServiceRuntimeDerivation,
  deriveServiceRuntimeInputs,
  resolveTrustedServiceEntitlement,
} from "./conversation-service-runtime.ts";
import {
  planConversationService,
  renderServicePlanReply,
  renderTargetedServiceQuestion,
} from "./conversation-service-planner.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  }
};
const assertMatch = (actual: string, expected: RegExp) => {
  if (!expected.test(actual)) {
    throw new Error(`pattern=${expected} actual=${actual}`);
  }
};

const commerce = createEmptyConversationCommerceState();
commerce.current_intent = "按舊資料試算兩部冷氣";
commerce.entities.push({
  entity_id: "ac:living",
  category: "aircon",
  quantity: 2,
  status: "researching",
  attributes: { model: "AC-2200" },
  constraints: {},
  provenance: { source_type: "customer", source_message_id: "m1" },
});

function run(
  question: string,
  recent_messages: Array<{ role: string; content: string }> = [],
) {
  const runtime = deriveServiceRuntimeInputs({
    question,
    recent_messages,
    commerce,
    trusted_customer_context: null,
    expected_conversation_id: "c1",
    expected_company_id: "co1",
  });
  const plan = planConversationService(applyServiceRuntimeDerivation({
    question,
    language: "zh-TW",
    recall: { handled: false },
    memory: null,
    commerce,
    recent_messages,
  }, runtime));
  return {
    runtime,
    plan,
    reply: renderServicePlanReply(plan, null, recent_messages) ??
      renderTargetedServiceQuestion(plan, "zh-TW"),
  };
}

Deno.test("C3 real caller adapter derives typed per-unit and per-order calculation", () => {
  const value = run(
    "用舊數字試算2部：舊機價每部 HKD 5,600，安裝每部 HKD 550，鋁架整單 HKD 550",
  );
  assertEquals(value.runtime.calculation_status, "ready");
  assertEquals(value.plan.calculation?.total, 12850);
  assertMatch(value.reply, /HKD 12,850/);
  assertMatch(value.reply, /不是現行正式報價/);
});

Deno.test("C3 mixed currency blocks the whole calculation", () => {
  const value = run("用舊數字試算2部：機價每部 HKD 5,600，安裝每部 USD 550");
  assertEquals(value.runtime.calculation_status, "mixed_currency");
  assertEquals(value.plan.calculation, undefined);
  assertMatch(value.reply, /不同幣別/);
});

Deno.test("C3 missing basis or quantity cannot silently default", () => {
  const noBasis = run("用舊數字試算：舊機價 HKD 5,600，安裝 HKD 550");
  assertEquals(noBasis.runtime.calculation_status, "missing_explicit_basis");
  assertMatch(noBasis.reply, /每部／每件.*整單/);
  const stateWithoutQuantity = structuredClone(commerce);
  stateWithoutQuantity.entities = [];
  const runtime = deriveServiceRuntimeInputs({
    question: "用舊數字試算：舊機價每部 HKD 5,600",
    commerce: stateWithoutQuantity,
    expected_conversation_id: "c1",
    expected_company_id: "co1",
  });
  assertEquals(runtime.calculation_status, "missing_quantity");
});

Deno.test("C3 entitlement accepts only server-bound active exact-scope CRM evidence", () => {
  const trusted = resolveTrustedServiceEntitlement({
    context: {
      source: "customer360-adapter",
      conversation_id: "c1",
      company_id: "co1",
      customer_ref: "cus_1234567890abcdef",
      request_id: "req-1",
      degraded: false,
      entitlements: [{
        name: "priority_support",
        value: "eligible",
        scope: "customer_support",
        status: "active",
        valid_until: "2099-01-01T00:00:00Z",
      }],
    },
    expected_conversation_id: "c1",
    expected_company_id: "co1",
    requested_scope: "customer_support",
    now: new Date("2026-09-16T00:00:00Z"),
  });
  assertEquals(trusted?.authority, "TRUSTED_CRM");
  assertEquals(
    resolveTrustedServiceEntitlement({
      context: {
        source: "customer360-adapter",
        conversation_id: "wrong",
        company_id: "co1",
        customer_ref: "cus_1234567890abcdef",
        request_id: "req-1",
        degraded: false,
        entitlements: [{
          name: "priority_support",
          value: "eligible",
          scope: "customer_support",
          status: "active",
        }],
      },
      expected_conversation_id: "c1",
      expected_company_id: "co1",
      requested_scope: "customer_support",
    }),
    null,
  );
});

Deno.test("C3 both Edge entrypoints consume runtime derivation before planning", async () => {
  for (
    const file of [
      "supabase/functions/generate-reply/index.ts",
      "supabase/functions/agent-assist/index.ts",
    ]
  ) {
    const source = await Deno.readTextFile(file);
    assertMatch(source, /deriveServiceRuntimeInputs\(/);
    assertMatch(source, /applyServiceRuntimeDerivation\(/);
    assertMatch(source, /calculation_input_status/);
  }
});
