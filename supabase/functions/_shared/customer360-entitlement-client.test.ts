import { validateTrustedCustomerContext } from "./customer360-entitlement-contract.ts";

const conversation = "c3000000-0000-4000-8000-000000000201";
const company = "c3000000-0000-4000-8000-000000000001";
const envelope = {
  success: true,
  trusted_customer_context: {
    source: "customer360-adapter",
    conversation_id: conversation,
    company_id: company,
    customer_ref: "cus_c3synthetic00000001",
    request_id: "c3000000-0000-4000-8000-000000000301",
    source_identity: "ai-chatbot-c3-nonproduction",
    degraded: false,
    entitlements: [{
      name: "priority_support",
      value: "eligible",
      scope: "customer_support",
      status: "active",
      valid_from: "2026-01-01T00:00:00Z",
      valid_until: "2027-01-01T00:00:00Z",
    }],
  },
};

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("C3 Customer360 verifier accepts exact server envelope", () => {
  const value = validateTrustedCustomerContext(envelope, {
    conversation_id: conversation,
    company_id: company,
  });
  assert(value?.source_identity === "ai-chatbot-c3-nonproduction", "trusted envelope rejected");
});

Deno.test("C3 Customer360 verifier rejects self claim and every identity/time field omission", () => {
  assert(validateTrustedCustomerContext({ entitlement: envelope.trusted_customer_context.entitlements[0] }, {
    conversation_id: conversation,
    company_id: company,
  }) === null, "client entitlement accepted");
  for (const field of ["company_id", "conversation_id", "customer_ref", "request_id", "source_identity"] as const) {
    const changed = structuredClone(envelope);
    delete (changed.trusted_customer_context as Record<string, unknown>)[field];
    assert(validateTrustedCustomerContext(changed, { conversation_id: conversation, company_id: company }) === null, `${field} omission accepted`);
  }
  const mismatch = structuredClone(envelope);
  mismatch.trusted_customer_context.company_id = "c3000000-0000-4000-8000-000000000002";
  assert(validateTrustedCustomerContext(mismatch, { conversation_id: conversation, company_id: company }) === null, "identity mismatch accepted");
  const missingTime = structuredClone(envelope);
  delete (missingTime.trusted_customer_context.entitlements[0] as Record<string, unknown>).valid_until;
  assert(validateTrustedCustomerContext(missingTime, { conversation_id: conversation, company_id: company }) === null, "missing validity accepted");
});
