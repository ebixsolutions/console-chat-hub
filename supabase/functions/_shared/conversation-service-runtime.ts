import { deriveTypedCustomerMoneyFacts } from "./customer-money-facts.ts";
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

export interface TypedCustomerCalculationTerm extends ServiceCalculationTerm {
  source: "customer_message";
  source_message_id?: string;
}
export interface TypedCustomerCalculation {
  terms: TypedCustomerCalculationTerm[];
  quantity?: number;
  status: "not_requested" | "ready" | "missing_explicit_basis" | "missing_quantity" | "mixed_currency" | "no_typed_amounts";
  calculation_type?: "historical_or_conditional";
  authority?: "customer_supplied_historical_or_hypothetical";
  current_price_authority?: "NONE";
  transaction_mutation?: "NONE";
  arithmetic_operation?: "multiply_then_add" | "addition";
  currency?: string;
  result?: number;
}

const CALCULATION_REQUEST = /(?:試算|试算|假設|假设|計算|计算|加埋|合共|總共|总共|一共|總數|总数|計下|计下|算下|計幾錢|计多少钱|算幾錢|算多少钱|calculate|estimate|total|altogether|how much)/i;
const HISTORICAL_OR_CONDITIONAL = /(?:舊|旧|之前|以前|頭先|刚才|剛才|用返|歷史|历史|假設|假设|如果|若果|若按|按你提供|historical|previous|earlier|conditional|hypothetical|\bif\b|\bassuming\b)/i;
const MONEY_TOKEN = /\b(HKD|USD|TWD)\b\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|((?:HK|US|NT)\$|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(HKD|USD|TWD)\b/gi;

function calcClean(value: unknown, limit = 2400): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, limit);
}
function quantityValue(raw: string): number | null {
  const map: Record<string, number> = { "一": 1, "二": 2, "兩": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  if (/^\d{1,4}$/.test(raw)) return Number(raw);
  return map[raw.toLowerCase()] ?? null;
}
export function isReadOnlyCustomerCalculationRequest(text: string): boolean {
  const value = calcClean(text);
  MONEY_TOKEN.lastIndex = 0;
  const hasMoney = MONEY_TOKEN.test(value);
  MONEY_TOKEN.lastIndex = 0;
  return CALCULATION_REQUEST.test(value) && hasMoney && HISTORICAL_OR_CONDITIONAL.test(value) &&
    !/(?:落單|下單|下单|付款|支付|購買|购买|訂購|订购|正式報價|正式报价|place an order|checkout|pay now|purchase now|book now)/i.test(value);
}
export function isHistoricalOrConditionalCustomerCalculationRequest(text: string): boolean {
  return isReadOnlyCustomerCalculationRequest(text);
}
export function deriveTypedCustomerCalculation(input: {
  question: string; current_source_message_id?: string; recent_messages?: ServiceRuntimeMessage[];
  fallback_quantity?: number; fallback_quantity_source_message_id?: string;
}): TypedCustomerCalculation {
  const question = calcClean(input.question);
  if (!isReadOnlyCustomerCalculationRequest(question)) return { terms: [], status: "not_requested" };
  const money = deriveTypedCustomerMoneyFacts(question);
  const roleReference = /(?:用返|頭先|之前|earlier|previous|use).{0,24}(?:送貨費|送货费|delivery fee|installation fee|安裝費|安装费)/i.exec(question)?.[0];
  const recalled: TypedCustomerCalculationTerm[] = [];
  if (roleReference) {
    const role = /送貨|送货|delivery/i.test(roleReference) ? "delivery" : "installation";
    for (const row of input.recent_messages ?? []) {
      if (!/^(?:visitor|customer|user)$/.test(row.role) || row.id === input.current_source_message_id || row.content === input.question) continue;
      const prior = deriveTypedCustomerMoneyFacts(row.content);
      if (!prior.historical) continue;
      const matching = prior.facts.filter(f=>f.role===role);
      if (!matching.length) continue;
      if (matching.length !== 1 || !row.id) return {terms:[],status:"missing_explicit_basis"};
      const fact = matching[0];
      const basis = fact.charge_basis === "unspecified" && /加|plus|add/i.test(question)
        ? "per_order" : fact.charge_basis === "total" ? "per_order" : fact.charge_basis;
      if (basis === "unspecified") return {terms:[],status:"missing_explicit_basis"};
      recalled.push({label:fact.labels[2],amount:fact.amount,currency:fact.currency,charge_basis:basis,source:"customer_message",source_message_id:row.id});
      break;
    }
    if (!recalled.length) return {terms:[],status:"no_typed_amounts"};
  }
  if (money.facts.some((fact) => fact.charge_basis === "unspecified")) {
    return { terms: [], status: "missing_explicit_basis" };
  }
  const terms: TypedCustomerCalculationTerm[] = [...money.facts.map((fact) => ({
    label: fact.labels[2], amount: fact.amount, currency: fact.currency,
    charge_basis: (fact.charge_basis === "total" ? "per_order" : fact.charge_basis) as "per_unit" | "per_order",
    source: "customer_message" as const,
    ...(input.current_source_message_id ? { source_message_id: input.current_source_message_id } : {}),
  })),...recalled];
  if (!terms.length) return { terms: [], status: "no_typed_amounts" };
  if (new Set(terms.map((term) => term.currency)).size > 1) return { terms: [], status: "mixed_currency" };
  const qtyMatch = question.match(/(?:共|總共|总共|數量|数量|qty|quantity)?\s*(一|二|兩|两|三|四|五|六|七|八|九|十|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,4})\s*(?:部|台|件|個|个|份|位|晚|夜|日|天|次|unit|units|item|items|session|sessions|night|nights)/i);
  const explicit = qtyMatch ? quantityValue(qtyMatch[1]) : null;
  const fallback = Number.isInteger(input.fallback_quantity) && Number(input.fallback_quantity) > 0 ? Number(input.fallback_quantity) : null;
  const quantity = explicit ?? fallback ?? undefined;
  if (terms.some((term) => term.charge_basis === "per_unit") && !quantity) return { terms: [], status: "missing_quantity" };
  return { terms, ...(quantity ? { quantity } : {}), status: "ready",
    calculation_type: "historical_or_conditional", authority: "customer_supplied_historical_or_hypothetical",
    current_price_authority: "NONE", transaction_mutation: "NONE",
    arithmetic_operation: terms.some((term) => term.charge_basis === "per_unit") ? "multiply_then_add" : "addition",
    currency: terms[0].currency,
    result: Math.round(terms.reduce((sum, term) => sum + term.amount * (term.charge_basis === "per_unit" ? quantity ?? 1 : 1), 0) * 100) / 100 };
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
  calculation_type?: "historical_or_conditional";
  authority?: "customer_supplied_historical_or_hypothetical";
  current_price_authority?: "NONE";
  transaction_mutation?: "NONE";
  arithmetic_operation?: "multiply_then_add" | "addition";
  calculation_currency?: string;
  calculation_result?: number;
  entitlement: TrustedServiceEntitlement | null;
  entitlement_status: "trusted" | "unknown";
}

const clean = (value: unknown, limit = 1000) =>
  String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(
    0,
    limit,
  );

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
  current_source_message_id?: string;
  recent_messages?: ServiceRuntimeMessage[];
  commerce: ConversationCommerceState | null;
  trusted_customer_context?: ServerCustomerContext | null;
  expected_conversation_id: string;
  expected_company_id: string;
  entitlement_scope?: string;
}): ServiceRuntimeDerivation {
  const typed = deriveTypedCustomerCalculation({
    question: input.question,
    current_source_message_id: input.current_source_message_id,
    recent_messages: input.recent_messages,
    fallback_quantity: (() => {
      const active = (input.commerce?.entities ?? []).filter((entity) =>
        !["cancelled", "deferred"].includes(entity.status)
      );
      return active.length === 1 ? active[0].quantity : undefined;
    })(),
    fallback_quantity_source_message_id: input.commerce?.entities.length === 1
      ? input.commerce.entities[0].provenance.source_message_id ?? undefined
      : undefined,
  });
  const calculation = {
    calculation_terms: typed.terms,
    calculation_quantity: typed.quantity,
    calculation_status: typed.status,
    calculation_type: typed.calculation_type,
    authority: typed.authority,
    current_price_authority: typed.current_price_authority,
    transaction_mutation: typed.transaction_mutation,
    arithmetic_operation: typed.arithmetic_operation,
    calculation_currency: typed.currency,
    calculation_result: typed.result,
  };
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
