import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type {
  ServiceCalculationTerm,
  ServicePlanInput,
} from "./conversation-service-planner.ts";

export const C3_SERVICE_RUNTIME_VERSION = "c3-service-runtime-1.0.0" as const;

export interface ServiceRuntimeMessage {
  role: string;
  content: string;
  id?: string | null;
}

export interface TrustedServiceEntitlement {
  name: string;
  value: string;
  authority: "TRUSTED_CRM";
  source: string;
}

export interface ServerCustomerContext {
  source: "customer360-adapter";
  conversation_id: string;
  company_id: string;
  customer_ref: string;
  request_id: string;
  source_identity: string;
  degraded: false;
  entitlements?: Array<{
    name: string;
    value: string;
    scope: string;
    valid_from?: string | null;
    valid_until?: string | null;
    status: "active" | "inactive";
  }>;
}

export interface ServiceRuntimeDerivation {
  version: typeof C3_SERVICE_RUNTIME_VERSION;
  calculation_terms: ServiceCalculationTerm[];
  calculation_quantity?: number;
  calculation_status:
    | "not_requested"
    | "ready"
    | "missing_explicit_basis"
    | "missing_quantity"
    | "mixed_currency"
    | "no_typed_amounts";
  entitlement: TrustedServiceEntitlement | null;
  entitlement_status: "trusted" | "unknown";
}

const clean = (value: unknown, limit = 1000) =>
  String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(
    0,
    limit,
  );

const CALCULATION_REQUEST =
  /(?:試算|试算|假設|假设|計算|计算|加埋|合共|總共|总共|calculate|estimate|total)/i;
const HISTORICAL_CONTEXT =
  /(?:舊|旧|之前|以前|歷史|历史|previous|historical|old|earlier)/i;
const MONEY_MARKER =
  /(?:HKD|HK\$|USD|US\$)\s*[0-9]|[0-9][0-9,.]*\s*(?:HKD|HK\$|USD|US\$)/i;
const PER_UNIT = /(?:每\s*(?:部|件|個|个|台|unit)|per\s+(?:unit|item|piece))/i;
const PER_ORDER =
  /(?:每\s*(?:單|单|張單|张单|order)|整\s*(?:單|单)|per\s+order)/i;

function moneyInClause(
  clause: string,
): { amount: number; currency: string } | null {
  const before = clause.match(/\b(HKD|USD)\b|(?:HK\$|US\$)/i);
  const amount = clause.match(
    /(?:HKD|USD|HK\$|US\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:HKD|USD|HK\$|US\$)/i,
  );
  if (!before || !amount) return null;
  const value = Number((amount[1] ?? amount[2]).replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  const marker = before[0].toUpperCase();
  return { amount: value, currency: marker.includes("US") ? "USD" : "HKD" };
}

function termLabel(clause: string, index: number): string {
  const label = clean(clause, 100)
    .replace(/(?:HKD|USD|HK\$|US\$)\s*[0-9][0-9,]*(?:\.[0-9]{1,2})?/ig, "")
    .replace(/[0-9][0-9,]*(?:\.[0-9]{1,2})?\s*(?:HKD|USD|HK\$|US\$)/ig, "")
    .replace(PER_UNIT, "")
    .replace(PER_ORDER, "")
    .replace(/[：:()（）]/g, " ")
    .trim();
  return label.slice(0, 60) || `歷史金額 ${index + 1}`;
}

function explicitQuantity(
  question: string,
  commerce: ConversationCommerceState | null,
): number | undefined {
  const match = clean(question).match(
    /(?:共|總共|总共|數量|数量|qty|quantity)?\s*([1-9][0-9]{0,3})\s*(?:部|件|個|个|台|units?|items?|pieces?)/i,
  );
  if (match) return Number(match[1]);
  const active = (commerce?.entities ?? []).filter((entity) =>
    !["cancelled", "deferred"].includes(entity.status)
  );
  if (
    active.length === 1 && Number.isInteger(active[0].quantity) &&
    active[0].quantity > 0
  ) return active[0].quantity;
  return undefined;
}

export function deriveTypedHistoricalCalculation(input: {
  question: string;
  recent_messages?: ServiceRuntimeMessage[];
  commerce: ConversationCommerceState | null;
}): Pick<
  ServiceRuntimeDerivation,
  "calculation_terms" | "calculation_quantity" | "calculation_status"
> {
  const question = clean(input.question, 2400);
  if (
    !CALCULATION_REQUEST.test(question) || !HISTORICAL_CONTEXT.test(question)
  ) {
    return { calculation_terms: [], calculation_status: "not_requested" };
  }
  const customerTexts = [
    question,
    ...(input.recent_messages ?? [])
      .filter((row) => /^(?:visitor|customer|user)$/i.test(row.role))
      .map((row) => clean(row.content, 2400)),
  ]
    .filter((text) => HISTORICAL_CONTEXT.test(text) || MONEY_MARKER.test(text));
  const clauses = customerTexts.flatMap((text) =>
    text
      .replace(/([0-9]),(?=[0-9])/g, "$1∯")
      .split(/[，,；;。\n]+/)
      .map((part) => clean(part.replace(/∯/g, ","), 300))
      .filter(Boolean)
  );
  const moneyClauses = clauses.filter((clause) => MONEY_MARKER.test(clause));
  if (!moneyClauses.length) {
    return { calculation_terms: [], calculation_status: "no_typed_amounts" };
  }
  if (
    moneyClauses.some((clause) =>
      !PER_UNIT.test(clause) && !PER_ORDER.test(clause)
    )
  ) {
    return {
      calculation_terms: [],
      calculation_status: "missing_explicit_basis",
    };
  }
  const parsed = moneyClauses.map((clause, index) => {
    const money = moneyInClause(clause);
    if (!money) return null;
    return {
      label: termLabel(clause, index),
      amount: money.amount,
      currency: money.currency,
      charge_basis: PER_UNIT.test(clause)
        ? "per_unit" as const
        : "per_order" as const,
      source: "customer_message" as const,
    };
  });
  if (parsed.some((term) => term === null)) {
    return { calculation_terms: [], calculation_status: "no_typed_amounts" };
  }
  const terms = parsed as ServiceCalculationTerm[];
  if (new Set(terms.map((term) => term.currency)).size !== 1) {
    return { calculation_terms: [], calculation_status: "mixed_currency" };
  }
  const quantity = explicitQuantity(question, input.commerce);
  if (terms.some((term) => term.charge_basis === "per_unit") && !quantity) {
    return { calculation_terms: [], calculation_status: "missing_quantity" };
  }
  return {
    calculation_terms: terms,
    ...(quantity ? { calculation_quantity: quantity } : {}),
    calculation_status: "ready",
  };
}

export function resolveTrustedServiceEntitlement(input: {
  context: ServerCustomerContext | null;
  expected_conversation_id: string;
  expected_company_id: string;
  requested_scope: string;
  now?: Date;
}): TrustedServiceEntitlement | null {
  const context = input.context;
  if (
    !context || context.source !== "customer360-adapter" ||
    context.degraded !== false ||
    context.conversation_id !== input.expected_conversation_id ||
    context.company_id !== input.expected_company_id ||
    !clean(context.customer_ref) || !clean(context.request_id) ||
    !clean(context.source_identity)
  ) return null;
  const now = (input.now ?? new Date()).getTime();
  const candidates = (context.entitlements ?? []).filter((row) => {
    if (
      row.status !== "active" ||
      clean(row.scope) !== clean(input.requested_scope)
    ) return false;
    const from = row.valid_from
      ? Date.parse(row.valid_from)
      : Number.NEGATIVE_INFINITY;
    const until = row.valid_until
      ? Date.parse(row.valid_until)
      : Number.POSITIVE_INFINITY;
    return Number.isFinite(from) || from === Number.NEGATIVE_INFINITY
      ? (Number.isFinite(until) || until === Number.POSITIVE_INFINITY) &&
        from <= now && now <= until
      : false;
  });
  if (candidates.length !== 1) return null;
  const row = candidates[0];
  if (!clean(row.name) || !clean(row.value)) return null;
  return {
    name: clean(row.name, 80),
    value: clean(row.value, 120),
    authority: "TRUSTED_CRM",
    source: `customer360-adapter:${clean(context.source_identity, 80)}:${
      clean(context.request_id, 80)
    }:${clean(context.customer_ref, 128)}`,
  };
}

export function deriveServiceRuntimeInputs(input: {
  question: string;
  recent_messages?: ServiceRuntimeMessage[];
  commerce: ConversationCommerceState | null;
  trusted_customer_context?: ServerCustomerContext | null;
  expected_conversation_id: string;
  expected_company_id: string;
  entitlement_scope?: string;
}): ServiceRuntimeDerivation {
  const calculation = deriveTypedHistoricalCalculation(input);
  const entitlement = resolveTrustedServiceEntitlement({
    context: input.trusted_customer_context ?? null,
    expected_conversation_id: input.expected_conversation_id,
    expected_company_id: input.expected_company_id,
    requested_scope: input.entitlement_scope ?? "customer_support",
  });
  return {
    version: C3_SERVICE_RUNTIME_VERSION,
    ...calculation,
    entitlement,
    entitlement_status: entitlement ? "trusted" : "unknown",
  };
}

export function applyServiceRuntimeDerivation(
  base: ServicePlanInput,
  derived: ServiceRuntimeDerivation,
): ServicePlanInput {
  return {
    ...base,
    calculation_terms: derived.calculation_terms,
    calculation_quantity: derived.calculation_quantity,
    calculation_status: derived.calculation_status,
    entitlement: derived.entitlement,
  };
}
