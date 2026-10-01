import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { ScopedCustomerValue } from "./contextual-customer-update.ts";
import { sameCanonicalJson } from "./canonical-json.ts";
import type { CustomerJourneyResponseIntent } from "./customer-journey-orchestration.ts";
import { HOME_APPLIANCE_CATEGORIES } from "./industry-profiles/home-appliance-v1.ts";

export interface B2LifecyclePlan {
  action: "deferred" | "cancelled";
  target_category: string;
  /** Present when category alone does not identify one canonical entity. */
  target_entity_id?: string;
  focus_category: string | null;
}

/** Lifecycle and focus are separate clauses. An unbound lifecycle verb is never inferred from history. */
export function resolveEntityLifecyclePlan(text: string, state: ConversationCommerceState):
  { kind: "mutation"; plans: B2LifecyclePlan[] } | { kind: "ambiguous"; action: "deferred" | "cancelled" } | { kind: "none" } {
  const normalized = text.trim().toLowerCase();
  const operation = (part: string): "deferred" | "cancelled" => /取消|唔要|不要|cancel\b/i.test(part) && !/暫時唔|暫時不|暂时不/i.test(part) ? "cancelled" : "deferred";
  const ambiguous = () => ({kind:"ambiguous" as const,action:operation(normalized)});
  const identityValues = (entity: ConversationCommerceState["entities"][number]) => [entity.model,entity.attributes.product_name,entity.attributes.sku].filter((v):v is string=>typeof v==="string" && v.trim().length>=2).map(v=>v.trim().toLowerCase());
  // Identifier tokens are data references, not a catalogue of customer phrases.
  const identifiers = (part: string): string[] => part.match(/\b(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9]+(?:[-_][a-z0-9]+)*\b/gi) ?? [];

  const aliases = (part: string) => [...new Set([
    ...HOME_APPLIANCE_CATEGORIES.filter((spec) =>
      spec.aliases.some((alias) => alias.trim().length >= 2 && part.includes(alias.toLowerCase()))
    ).map((spec) => spec.key),
    ...state.entities.filter((entity) =>
      [entity.category, entity.model, entity.attributes.product_name]
        .some((value) => typeof value === "string" && value.trim().length >= 2 &&
          part.includes(value.trim().toLowerCase())) || identifiers(part).some(id=>identityValues(entity).some(value=>identifiers(value).includes(id)))
    ).map((entity) => entity.category),
  ])];
  const lifecycle = /暫時唔|暫時不|暂时不|暫緩|暂缓|先擺低|先放低|稍後先|稍后再|hold off|defer|pause|取消|唔要|不要|cancel\b/i;
  if (!lifecycle.test(normalized)) return { kind: "none" };
  if (/^(?:你仲記唔記得|係咪|有冇|是否|is |was |did )/i.test(normalized)) return { kind: "none" };
  const named = aliases(normalized);
  // Room-scoped cancellation and service/installation actions keep their
  // existing entity/field resolution contract, never become category lifecycle.
  if (/(?:排水|檢查|检查|送貨|送货|delivery|闊度|宽度|高度|深度|尺寸|width|height|depth)/i.test(normalized)) return { kind: "none" };
  const clauses = normalized.split(/[，,；;。]|\.(?=\s|$)|(?=先搞)|(?=先處理)|(?=先处理)/).map((s) => s.trim()).filter(Boolean);
  const lifecycleClauses = clauses.filter((part) => lifecycle.test(part) && !/[?？]/.test(part));
  // A question such as "我要唔要考慮？" contains a negated verb, but does not
  // authorize a lifecycle mutation. Preserve a separate imperative clause if
  // the turn also asks a question.
  if (!lifecycleClauses.length) return { kind: "none" };
  if (!named.length && !/兩樣都|两样都|both\b|暫時唔換|暫時不換|暂时不换/i.test(normalized)) return ambiguous();
  const focusClauses = clauses.filter((part) => /(?:先搞|先處理|先处理|focus on|back to|return to)/i.test(part) && !lifecycle.test(part));
  const focusKeys = [...new Set(focusClauses.flatMap(aliases))];
  if (focusKeys.length > 1) return ambiguous();
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
      if (keys.length !== 2) return ambiguous();
    }
    if (keys.length !== 1 && !/兩樣都|两样都|both\b/i.test(part)) return ambiguous();
    for (const key of keys) {
      if (plans.some((plan) => plan.target_category === key)) return ambiguous();
      const action=operation(part), explicitIds=identifiers(part);
      const namedEntities=state.entities.filter(entity=>identityValues(entity).some(value=>part.includes(value)) || explicitIds.some(id=>identityValues(entity).some(value=>identifiers(value).includes(id))));
      if(explicitIds.length && explicitIds.some(id=>!namedEntities.some(entity=>identityValues(entity).some(value=>identifiers(value).includes(id)))))return ambiguous();
      const candidates=(namedEntities.length?namedEntities:state.entities.filter(entity=>entity.category===key)).filter(entity=>entity.category===key && (action==="cancelled" || entity.status!=="cancelled"));
      if(candidates.length!==1)return ambiguous();
      const target=candidates[0];
      plans.push({target_category:key,action,focus_category:focusKeys[0]??null,...(state.entities.filter(entity=>entity.category===key).length>1?{target_entity_id:target.entity_id}:{})});
    }
  }
  if (!plans.length || plans.some((plan) =>
    state.entities.filter((entity) => (plan.target_entity_id ? entity.entity_id===plan.target_entity_id : entity.category===plan.target_category) &&
      (plan.action === "cancelled" || entity.status !== "cancelled")).length !== 1 ||
    (plan.focus_category !== null && (plan.focus_category === plan.target_category ||
      state.entities.filter((entity) => entity.category === plan.focus_category &&
        entity.status !== "deferred" && entity.status !== "cancelled").length !== 1))
  )) return ambiguous();
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
    const old = before.entities.find((entity) => (plan.target_entity_id ? entity.entity_id===plan.target_entity_id : entity.category===plan.target_category) &&
      (plan.action === "cancelled" || entity.status !== "cancelled"));
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
