/**
 * Universal context binding for an industry adapter's structured customer turn.
 * The core knows entities, scopes and event authority, never industry vocabulary.
 */
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceStateEvent } from "./commerce-state-reducer.ts";

export interface ScopedCustomerValue {
  scope: string;
  attribute: string;
  action: "set";
  value: string | number | boolean;
}

export interface ContextualCandidate {
  topic: string;
  topic_source: "explicit" | "profile";
  action: "enquiry" | "scoped_update";
  values: ScopedCustomerValue[];
  /** Explicit aggregate from the adapter; partial scoped changes must not invent it. */
  aggregate_quantity?: number;
  context_sufficient: boolean;
  reply: string;
  clarification: string;
}

export type ContextualDecision =
  | { route: "none"; reason: string; updates: [] }
  | { route: "targeted_clarification"; reason: string; reply: string; updates: [] }
  | { route: "product_guidance"; reason: string; reply: string; topic: string; updates: [] }
  | {
    route: "contextual_scoped_update";
    reason: string;
    reply: string;
    topic: string;
    entity_id: string;
    updates: ScopedCustomerValue[];
    aggregate_quantity?: number;
  };

export function resolveContextualCustomerUpdate(input: {
  candidate: ContextualCandidate | null;
  state: ConversationCommerceState;
  read_only?: boolean;
}): ContextualDecision {
  const candidate = input.candidate;
  if (!candidate) return { route: "none", reason: "NO_CONTEXTUAL_CANDIDATE", updates: [] };
  if (candidate.action === "enquiry") {
    if (!candidate.context_sufficient) {
      return { route: "targeted_clarification", reason: "ENQUIRY_CONTEXT_AMBIGUOUS", reply: candidate.clarification, updates: [] };
    }
    return { route: "product_guidance", reason: "CONTEXTUAL_ENQUIRY", topic: candidate.topic, reply: candidate.reply, updates: [] };
  }
  if (input.read_only) return { route: "none", reason: "READ_ONLY_TURN", updates: [] };
  const active = input.state.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  const compatible = active.filter((entity) => entity.category === candidate.topic);
  // An implicit subject must never silently jump across another active domain.
  const ambiguous = candidate.topic_source !== "explicit" && active.some((entity) =>
    entity.category !== candidate.topic
  );
  if (!candidate.context_sufficient || ambiguous || compatible.length !== 1) {
    return {
      route: "targeted_clarification",
      reason: !candidate.context_sufficient ? "SCOPE_CONTEXT_MISSING" : "ENTITY_REFERENCE_AMBIGUOUS",
      reply: candidate.clarification,
      updates: [],
    };
  }
  if (!candidate.values.length || new Set(candidate.values.map((v) => v.scope + ":" + v.attribute)).size !== candidate.values.length) {
    return { route: "targeted_clarification", reason: "SCOPED_VALUES_AMBIGUOUS", reply: candidate.clarification, updates: [] };
  }
  return {
    route: "contextual_scoped_update",
    reason: "UNIQUE_COMPATIBLE_CONTEXT",
    topic: candidate.topic,
    entity_id: compatible[0].entity_id,
    updates: candidate.values,
    aggregate_quantity: candidate.aggregate_quantity,
    reply: candidate.reply,
  };
}

export function contextualUpdateEvents(
  decision: ContextualDecision,
  state: ConversationCommerceState,
  source_message_id: string,
  occurred_at?: string | null,
): CommerceStateEvent[] {
  if (decision.route !== "contextual_scoped_update") return [];
  const target = state.entities.find((entity) => entity.entity_id === decision.entity_id);
  if (!target) return [];
  const provenance = { source_type: "customer" as const, source_message_id, recorded_at: occurred_at ?? null };
  const current = target.attributes.scoped_customer_updates;
  const records: ScopedCustomerValue[] = Array.isArray(current)
    ? current.filter((value): value is ScopedCustomerValue =>
      Boolean(value && typeof value === "object" && typeof value.scope === "string" && typeof value.attribute === "string"))
    : [];
  const merged = new Map(records.map((value) => [value.scope + ":" + value.attribute, value]));
  for (const value of decision.updates) merged.set(value.scope + ":" + value.attribute, value);
  const updates = [...merged.values()];
  const events: CommerceStateEvent[] = [{
    type: "SET_ENTITY_ATTRIBUTE",
    entity_id: target.entity_id,
    key: "scoped_customer_updates",
    value: updates,
    provenance,
  }];
  // Only an adapter-authoritative aggregate can change the entity quantity.
  const allocation = updates.filter((v) => v.attribute === "quantity" && typeof v.value === "number");
  if (decision.aggregate_quantity !== undefined && allocation.length === updates.length && allocation.length > 0) {
    const total = allocation.reduce((sum, value) => sum + Number(value.value), 0);
    if (Number.isInteger(decision.aggregate_quantity) && decision.aggregate_quantity >= 0 && total === decision.aggregate_quantity && total !== target.quantity) events.push({
      type: "SET_ENTITY_QUANTITY", entity_id: target.entity_id, quantity: total, provenance,
    });
  }
  return events;
}
