import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { ScopedCustomerValue } from "./contextual-customer-update.ts";
import { sameCanonicalJson } from "./canonical-json.ts";
import type { CustomerJourneyResponseIntent } from "./customer-journey-orchestration.ts";
import { HOME_APPLIANCE_CATEGORIES } from "./industry-profiles/home-appliance-v1.ts";

export interface B2LifecyclePlan {
  action: "deferred" | "cancelled";
  target_category: string;
  focus_category: string | null;
}

/** Lifecycle and focus are separate clauses. An unbound lifecycle verb is never inferred from history. */
export function resolveEntityLifecyclePlan(text: string, state: ConversationCommerceState):
  { kind: "mutation"; plans: B2LifecyclePlan[] } | { kind: "ambiguous" } | { kind: "none" } {
  const normalized = text.trim().toLowerCase();
  const aliases = (part: string) => [...new Set(HOME_APPLIANCE_CATEGORIES.filter((spec) =>
    spec.aliases.some((alias) => alias.trim().length >= 2 && part.includes(alias.toLowerCase()))
  ).map((spec) => spec.key))];
  const lifecycle = /暫時唔|暫時不|暂时不|稍後先|稍后再|hold off|defer|取消|唔要|不要|cancel\b/i;
  if (!lifecycle.test(normalized)) return { kind: "none" };
  if (/[？?]/.test(normalized) || /^(?:你仲記唔記得|係咪|有冇|是否|is |was |did )/i.test(normalized)) return { kind: "none" };
  const named = aliases(normalized);
  if (!named.length && !/兩樣都|两样都|both\b|暫時唔換|暫時不換|暂时不换/i.test(normalized)) return { kind: "none" };
  // Room-scoped cancellation and service/installation actions keep their
  // existing entity/field resolution contract, never become category lifecycle.
  if (/(?:客廳|客厅|睡房|大房|細房|细房|bedroom|living room|排水|檢查|检查|送貨|送货|delivery|闊度|宽度|高度|深度|尺寸|width|height|depth)/i.test(normalized)) return { kind: "none" };
  const clauses = normalized.split(/[，,；;。]|(?=先搞)|(?=先處理)|(?=先处理)/).map((s) => s.trim()).filter(Boolean);
  const lifecycleClauses = clauses.filter((part) => lifecycle.test(part));
  const focusClauses = clauses.filter((part) => /(?:先搞|先處理|先处理|focus on)/i.test(part) && !lifecycle.test(part));
  const focusKeys = [...new Set(focusClauses.flatMap(aliases))];
  if (focusKeys.length > 1) return { kind: "ambiguous" };
  const plans: B2LifecyclePlan[] = [];
  for (const [index, part] of lifecycleClauses.entries()) {
    if (/^(?:先)?取消[。.!]?$/i.test(part) && index > 0 && plans.length === 1) {
      plans[0].action = "cancelled";
      continue;
    }
    let keys = aliases(part);
    if (/兩樣都|两样都|both\b/i.test(part)) {
      keys = [...new Set(state.entities.filter((entity) =>
        entity.status !== "deferred" && entity.status !== "cancelled"
      ).map((entity) => entity.category))];
      if (keys.length !== 2) return { kind: "ambiguous" };
    }
    if (keys.length !== 1 && !/兩樣都|两样都|both\b/i.test(part)) return { kind: "ambiguous" };
    for (const key of keys) {
      if (plans.some((plan) => plan.target_category === key)) return { kind: "ambiguous" };
      plans.push({ target_category: key, action: /取消|唔要|不要|cancel\b/i.test(part) && !/暫時唔|暫時不|暂时不/i.test(part) ? "cancelled" : "deferred", focus_category: focusKeys[0] ?? null });
    }
  }
  if (!plans.length || plans.some((plan) =>
    state.entities.filter((entity) => entity.category === plan.target_category &&
      entity.status !== "deferred" && entity.status !== "cancelled").length !== 1 ||
    (plan.focus_category !== null && (plan.focus_category === plan.target_category ||
      state.entities.filter((entity) => entity.category === plan.focus_category &&
        entity.status !== "deferred" && entity.status !== "cancelled").length !== 1))
  )) return { kind: "ambiguous" };
  return { kind: "mutation", plans };
}

export interface B2TrustedLifecycleCommit {
  contract: "entity-lifecycle-commit-v1";
  company_id: string;
  source_message_id: string;
  source_text: string;
  previous_revision: number;
  committed_revision: number;
  plans: B2LifecyclePlan[];
  target_entity_ids: string[];
  previous_state: ConversationCommerceState;
  committed_state: ConversationCommerceState;
  reply: string;
  transaction_before: B2JourneyTransactionBoundary;
  transaction_after: B2JourneyTransactionBoundary;
}

export function verifyEntityLifecycleTransition(
  text: string, before: ConversationCommerceState, after: ConversationCommerceState,
  sourceMessageId: string,
): { valid: true; plans: B2LifecyclePlan[]; targetIds: string[] } | { valid: false } {
  const resolved = resolveEntityLifecyclePlan(text, before);
  if (resolved.kind !== "mutation" || before.entities.length !== after.entities.length ||
    JSON.stringify(b2JourneyTransactionBoundary(before)) !== JSON.stringify(b2JourneyTransactionBoundary(after))) return { valid: false };
  const targetIds: string[] = [];
  for (const plan of resolved.plans) {
    const old = before.entities.find((entity) => entity.category === plan.target_category &&
      entity.status !== "cancelled" && entity.status !== "deferred");
    if (!old) return { valid: false };
    targetIds.push(old.entity_id);
  }
  const expected = structuredClone(before);
  for (const [index, entity] of expected.entities.entries()) {
    if (!targetIds.includes(entity.entity_id)) continue;
    const changed = after.entities[index];
    if (changed?.entity_id !== entity.entity_id || changed.status !==
      resolved.plans.find((plan) => plan.target_category === entity.category)?.action ||
      changed.provenance.source_type !== "customer" ||
      changed.provenance.source_message_id !== sourceMessageId) return { valid: false };
    expected.entities[index] = structuredClone(changed);
    expected.entities[index].quantity = entity.quantity;
    expected.entities[index].attributes = entity.attributes;
    expected.entities[index].constraints = entity.constraints;
    expected.entities[index].model = entity.model;
    expected.entities[index].brand = entity.brand;
  }
  const focus = resolved.plans[0].focus_category;
  if (focus) expected.current_topic = focus;
  expected.conversion.tentative_entity_ids = before.conversion.tentative_entity_ids.filter((id) => !targetIds.includes(id));
  expected.conversion.cancelled_entity_ids = [...new Set([
    ...before.conversion.cancelled_entity_ids,
    ...resolved.plans.filter((plan) => plan.action === "cancelled").flatMap((plan) =>
      targetIds.filter((id) => before.entities.find((entity) => entity.entity_id === id)?.category === plan.target_category)),
  ])];
  if (!sameCanonicalJson(expected, after)) return { valid: false };
  for (const [index, entity] of before.entities.entries()) {
    const committed = after.entities[index];
    if (entity.entity_id !== committed.entity_id || entity.category !== committed.category ||
      entity.quantity !== committed.quantity ||
      !sameCanonicalJson(entity.attributes, committed.attributes) ||
      !sameCanonicalJson(entity.constraints, committed.constraints) ||
      entity.model !== committed.model || entity.brand !== committed.brand ||
      (!targetIds.includes(entity.entity_id) && !sameCanonicalJson(entity, committed))) return { valid: false };
  }
  return { valid: true, plans: resolved.plans, targetIds };
}

export interface B2JourneyTransactionBoundary {
  quotes: ConversationCommerceState["quotes"];
  delivery_confirmed: boolean;
  confirmed_installation_items:
    ConversationCommerceState["installation"]["items"];
  quotation_status: string;
  order_status: string;
  payment_status: string;
}

export function b2JourneyTransactionBoundary(
  state: ConversationCommerceState,
): B2JourneyTransactionBoundary {
  return {
    quotes: structuredClone(state.quotes),
    delivery_confirmed: state.delivery.confirmed,
    confirmed_installation_items: structuredClone(
      state.installation.items.filter((item) => item.status === "confirmed"),
    ),
    quotation_status: state.conversion.quotation_status,
    order_status: state.conversion.order_status,
    payment_status: state.conversion.payment_status,
  };
}

interface B2TrustedJourneyProgressBase {
  contract: "journey-progress-after-accepted-update-v1";
  company_id: string;
  source_message_id: string;
  source_text: string;
  previous_revision: number;
  committed_revision: number;
  entity_id: string;
  category: string;
  journey_stage: string;
  next_missing_slot: string | null;
  response_decision: CustomerJourneyResponseIntent;
  response_route: "product_guidance" | "contextual_scoped_update";
  response_reason: string;
  reply: string;
  transaction_before: B2JourneyTransactionBoundary;
  transaction_after: B2JourneyTransactionBoundary;
}

export interface B2TrustedGoalJourneyProgress
  extends B2TrustedJourneyProgressBase {
  update_kind: "customer_goal";
  previous_collected: string[];
  committed_collected: string[];
  previous_missing: string[];
  committed_missing: string[];
  accepted_slots: string[];
  accepted_corrections: string[];
}

export interface B2TrustedScopedJourneyProgress
  extends B2TrustedJourneyProgressBase {
  update_kind: "contextual_scoped_update";
  response_decision: "confirm_controlled_update";
  accepted_updates: ScopedCustomerValue[];
  committed_updates: ScopedCustomerValue[];
  aggregate_quantity?: number;
}

/** Private server-to-server evidence; never request or assistant metadata. */
export type B2TrustedJourneyProgress =
  | B2TrustedGoalJourneyProgress
  | B2TrustedScopedJourneyProgress;

/** In-process receipt for a single scoped correction, after the Commerce CAS commit. */
export interface B2TrustedCorrectionCommit {
  contract: "scoped-correction-commit-v1";
  company_id: string;
  source_message_id: string;
  source_text: string;
  previous_revision: number;
  committed_revision: number;
  entity_id: string;
  category: string;
  scope: string;
  field: "room_size";
  previous_value: string;
  current_value: string;
  previous_values: Record<string, string>;
  committed_values: Record<string, string>;
  correction: string;
  reply: string;
  transaction_before: B2JourneyTransactionBoundary;
  transaction_after: B2JourneyTransactionBoundary;
}
