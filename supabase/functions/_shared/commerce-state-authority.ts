import type { ConversationCommerceState } from "./commerce-state-contract.ts";

export type CommerceAnswerAuthority =
  | "CONVERSATION_STATE"
  | "DETERMINISTIC_CALCULATION"
  | "CURRENT_KB_REQUIRED"
  | "SAFE_PROFESSIONAL_CONFIRMATION"
  | "INSUFFICIENT_INFORMATION";

export interface CommerceAuthorityDecision {
  authority: CommerceAnswerAuthority;
  reason: string;
  known_value?: unknown;
  state_path?: string | null;
  calculation?: { expression: string; result: number; currency?: string | null } | null;
}

export interface CommerceCalculationTerm {
  label: string;
  value: number;
  multiplier?: number;
}

export interface ResolveCommerceAuthorityInput {
  question: string;
  state: ConversationCommerceState;
  requested_state_path?: string | null;
  calculation_terms?: CommerceCalculationTerm[];
  calculation_currency?: string | null;
  requires_current_business_fact?: boolean;
  requires_current_price_or_stock?: boolean;
  requires_policy_or_terms?: boolean;
  requires_professional_site_check?: boolean;
  unsafe_to_remote_confirm?: boolean;
}

function clean(value: unknown, max = 1200): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getCommerceStatePath(state: ConversationCommerceState, path: string): unknown {
  const parts = clean(path, 300).split(".").filter(Boolean);
  if (!parts.length) return undefined;
  let current: unknown = state;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

export function findCommerceEntity(
  state: ConversationCommerceState,
  key: string,
): ConversationCommerceState["entities"][number] | null {
  const needle = clean(key, 120).toLowerCase();
  if (!needle) return null;
  const matches = state.entities.filter((entity) =>
    [entity.entity_id, entity.category, entity.brand ?? "", entity.model ?? ""]
      .map((x) => clean(x, 120).toLowerCase())
      .some((x) => x === needle || (x.length >= 2 && x.includes(needle)) || (needle.length >= 2 && needle.includes(x)))
  );
  return matches.length === 1 ? matches[0] : null;
}

export function calculateCommerceTerms(
  terms: CommerceCalculationTerm[],
  currency?: string | null,
): CommerceAuthorityDecision["calculation"] {
  if (!terms.length) return null;
  let total = 0;
  const expressionParts: string[] = [];
  for (const term of terms) {
    if (!Number.isFinite(term.value)) return null;
    const multiplier = term.multiplier ?? 1;
    if (!Number.isFinite(multiplier)) return null;
    total += term.value * multiplier;
    expressionParts.push(`${term.label}:${term.value}×${multiplier}`);
  }
  return {
    expression: expressionParts.join(" + "),
    result: Math.round((total + Number.EPSILON) * 100) / 100,
    currency: currency ?? null,
  };
}

function questionLooksLikeCurrentBusinessFact(question: string): boolean {
  return /(?:而家|現在|现在|目前|最新|current|latest|今日|today).{0,30}(?:價|价|price|stock|庫存|库存|有貨|有货|available|政策|policy|收費|收费|fee|delivery|送貨|送货|保養|保修|warranty)/i.test(question);
}

function questionLooksLikeCustomerState(question: string): boolean {
  return /(?:我(?:而家|現在|现在|目前|最後|最后)?|my\s+(?:current|latest|final)?).{0,45}(?:幾多|多少|數量|数量|要咩|要什麼|要什么|地址|電話|电话|收貨人|收货人|日期|時間|时间|要求|需求|限制|狀態|状态|order|quote|quotation|quantity|address|phone|recipient|date|requirements?|constraints?|status)|(?:幫我|帮我|please).{0,30}(?:總結|总结|summari[sz]e).{0,30}(?:我|my)/i.test(question);
}

function questionLooksLikeCalculation(question: string): boolean {
  return /(?:加埋|合共|總共幾錢|总共多少钱|一共多少|total|how much.*(?:total|altogether)|calculate|計下|算下|計算|计算)/i.test(question);
}

/**
 * Universal authority hierarchy for commerce answers.
 * 1. Explicit customer-owned state wins when the requested path is known.
 * 2. Deterministic arithmetic from supplied terms wins over KB retrieval.
 * 3. Current business/product/policy facts require current KB/tool evidence.
 * 4. Site/safety-sensitive questions require professional confirmation.
 * 5. Otherwise fail safely instead of inventing facts.
 */
export function resolveCommerceAnswerAuthority(input: ResolveCommerceAuthorityInput): CommerceAuthorityDecision {
  const question = clean(input.question);
  const statePath = clean(input.requested_state_path ?? "", 300);

  if (statePath) {
    const known = getCommerceStatePath(input.state, statePath);
    if (known !== undefined && known !== null && known !== "") {
      return {
        authority: "CONVERSATION_STATE",
        reason: "requested_customer_state_is_known",
        known_value: known,
        state_path: statePath,
      };
    }
  }

  if ((questionLooksLikeCalculation(question) || (input.calculation_terms?.length ?? 0) > 0) && input.calculation_terms?.length) {
    const calculation = calculateCommerceTerms(input.calculation_terms, input.calculation_currency);
    if (calculation) {
      return {
        authority: "DETERMINISTIC_CALCULATION",
        reason: "calculation_fully_supported_by_known_terms",
        calculation,
      };
    }
  }

  if (
    input.requires_current_business_fact ||
    input.requires_current_price_or_stock ||
    input.requires_policy_or_terms ||
    questionLooksLikeCurrentBusinessFact(question)
  ) {
    return {
      authority: "CURRENT_KB_REQUIRED",
      reason: "current_business_fact_requires_authoritative_evidence",
    };
  }

  if (input.requires_professional_site_check || input.unsafe_to_remote_confirm) {
    return {
      authority: "SAFE_PROFESSIONAL_CONFIRMATION",
      reason: "remote_confirmation_not_safe_or_not_authoritative",
    };
  }

  if (questionLooksLikeCustomerState(question)) {
    return {
      authority: "INSUFFICIENT_INFORMATION",
      reason: "customer_state_question_but_requested_fact_not_resolved",
      state_path: statePath || null,
    };
  }

  return {
    authority: "INSUFFICIENT_INFORMATION",
    reason: "no_authoritative_source_selected",
  };
}
