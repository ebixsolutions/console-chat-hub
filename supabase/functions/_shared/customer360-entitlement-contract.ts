import type { ServerCustomerContext } from "./conversation-service-runtime.ts";

type Obj = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER = /^cus_[A-Za-z0-9_-]{16,64}$/;

const object = (value: unknown): Obj | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Obj
    : null;
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim()
    ? value.normalize("NFKC").trim().slice(0, max)
    : null;

export function validateTrustedCustomerContext(
  payload: unknown,
  expected: { conversation_id: string; company_id: string },
): ServerCustomerContext | null {
  const root = object(payload);
  const raw = object(root?.trusted_customer_context);
  if (!root || root.success !== true || !raw) return null;
  const conversationId = text(raw.conversation_id, 36);
  const companyId = text(raw.company_id, 36);
  const customerRef = text(raw.customer_ref, 128);
  const requestId = text(raw.request_id, 128);
  const sourceIdentity = text(raw.source_identity, 160);
  if (
    raw.source !== "customer360-adapter" || raw.degraded !== false ||
    !conversationId || !companyId || !customerRef || !requestId ||
    !sourceIdentity || !UUID.test(conversationId) || !UUID.test(companyId) ||
    !CUSTOMER.test(customerRef) ||
    conversationId !== expected.conversation_id || companyId !== expected.company_id
  ) return null;
  if (!Array.isArray(raw.entitlements)) return null;
  const entitlements: ServerCustomerContext["entitlements"] = [];
  for (const item of raw.entitlements) {
    const row = object(item);
    const name = text(row?.name, 80);
    const value = text(row?.value, 120);
    const scope = text(row?.scope, 120);
    const status = row?.status;
    const validFrom = text(row?.valid_from, 80);
    const validUntil = text(row?.valid_until, 80);
    if (
      !row || !name || !value || !scope ||
      (status !== "active" && status !== "inactive") ||
      !validFrom || !validUntil || !Number.isFinite(Date.parse(validFrom)) ||
      !Number.isFinite(Date.parse(validUntil))
    ) return null;
    entitlements.push({
      name,
      value,
      scope,
      status,
      valid_from: validFrom,
      valid_until: validUntil,
    });
  }
  return {
    source: "customer360-adapter",
    conversation_id: conversationId,
    company_id: companyId,
    customer_ref: customerRef,
    request_id: requestId,
    source_identity: sourceIdentity,
    degraded: false,
    entitlements,
  };
}
