import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { runCommerceStateRuntime, type CommerceStateDbClient } from "./commerce-state-runtime.ts";
import { resolveCanonicalCommerceResolution } from "./conversation-resolution-contract.ts";
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
    current_source_message_id: "t13-source",
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

Deno.test("generic current-message historical calculation retains explicit operands and charge basis", () => {
  const value = run("如果用返之前每部 HK$5,680 嗰個歷史價，兩部再加 HK$1,490，合共幾多？");
  assertEquals(value.runtime.calculation_status, "ready");
  assertEquals(value.plan.calculation?.total, 12850);
  assertMatch(value.reply, /HK\$ 5,680/);
  assertMatch(value.reply, /HK\$ 1,490/);
  assertMatch(value.reply, /HK\$ 12,850/);
  assertMatch(value.reply, /歷史條件試算/);
  assertEquals(value.runtime.calculation_terms.every((term) => term.source_message_id === "t13-source"), true);
});

Deno.test("exact T13 production-shaped Commerce and service path is read-only", async () => {
  const source = "如果用返之前每部 HK$5,680 嗰個歷史價，兩部再加 HK$1,490，合共幾多？";
  const state = structuredClone(commerce);
  const before = JSON.stringify(state);
  let writes = 0;
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: { revision: 9, state: structuredClone(state) }, error: null,
    }) }) }) }),
    rpc: async () => { writes++; return { data: null, error: null }; },
  };
  const outcome = await runCommerceStateRuntime(db, {
    conversation_id: "c1", company_id: "co1", source_message_id: "t13-source",
    text: source, language: "zh-TW",
  });
  assertEquals(outcome?.reason, "read_only_customer_calculation");
  assertEquals(outcome?.persist_result, "read_only");
  assertEquals(outcome?.revision, 9);
  assertEquals(outcome?.calculation?.result, 12850);
  assertEquals(writes, 0);
  assertEquals(JSON.stringify(state), before);
  const resolution = resolveCanonicalCommerceResolution({ outcome, authoritative_address_correction: false });
  assertEquals(resolution.skip_memory_refresh, true);
  assertEquals(resolution.no_semantic_change, true);
  const runtime = deriveServiceRuntimeInputs({ question: source, current_source_message_id: "t13-source",
    commerce: state, trusted_customer_context: null, expected_conversation_id: "c1", expected_company_id: "co1" });
  assertEquals(runtime.calculation_result, 12850);
  const plan = planConversationService(applyServiceRuntimeDerivation({ question: source,
    language: "zh-TW", recall: { handled: false }, memory: null, commerce: state }, runtime));
  const response = renderServicePlanReply(plan, null) ?? "";
  assertEquals(plan.calculation?.total, 12850);
  assertMatch(response, /HK\$ 12,850/);
  assertMatch(response, /歷史條件試算/);
  assertMatch(response, /不是現行正式報價/);
});

Deno.test("C3 real caller adapter derives typed per-unit and per-order calculation", () => {
  const value = run(
    "用舊數字試算2部：舊機價每部 HKD 5,600，安裝每部 HKD 550，鋁架整單 HKD 550",
  );
  assertEquals(value.runtime.calculation_status, "ready");
  assertEquals(value.plan.calculation?.total, 12850);
  assertMatch(value.reply, /HK\$ 12,850/);
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
  assertMatch(noBasis.reply, /單價.*整批總額/);
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
      source_identity: "ai-chatbot-c3-nonproduction",
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
        source_identity: "ai-chatbot-c3-nonproduction",
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

Deno.test("C3 entitlement fails closed for expired inactive scope mismatch conflict and missing source identity", () => {
  const base = {
    source: "customer360-adapter" as const,
    conversation_id: "c1",
    company_id: "co1",
    customer_ref: "cus_1234567890abcdef",
    request_id: "req-1",
    source_identity: "ai-chatbot-c3-nonproduction",
    degraded: false as const,
  };
  const resolve = (entitlements: Array<Record<string, unknown>>, override: Record<string, unknown> = {}) =>
    resolveTrustedServiceEntitlement({
      context: { ...base, ...override, entitlements } as any,
      expected_conversation_id: "c1",
      expected_company_id: "co1",
      requested_scope: "customer_support",
      now: new Date("2026-09-16T00:00:00Z"),
    });
  const active = {
    name: "priority_support",
    value: "eligible",
    scope: "customer_support",
    status: "active" as const,
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: "2027-01-01T00:00:00Z",
  };
  assertEquals(resolve([{ ...active, valid_until: "2026-01-02T00:00:00Z" }]), null);
  assertEquals(resolve([{ ...active, status: "inactive" }]), null);
  assertEquals(resolve([{ ...active, scope: "billing" }]), null);
  assertEquals(resolve([active, { ...active, value: "not-eligible" }]), null);
  assertEquals(resolve([active], { source_identity: "" }), null);
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
    assertMatch(source, /fetchTrustedCustomerContext\(/);
    assertMatch(source, /trusted_customer_context:\s*(?:_c3TrustedCustomerContext|trustedCustomerContext)/);
    assertMatch(source, /calculation_input_status/);
  }
});
