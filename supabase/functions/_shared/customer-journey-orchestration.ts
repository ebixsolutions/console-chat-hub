import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceStateEvent } from "./commerce-state-reducer.ts";

export type CustomerJourneyResponseIntent =
  | "advance_decision"
  | "reduce_uncertainty"
  | "answer_known_fact"
  | "request_highest_value_missing_information"
  | "confirm_controlled_update";

export interface CustomerGoalState {
  category: string;
  objective: string;
  journey_stage: string;
  collected: string[];
  missing: string[];
  response_intent: CustomerJourneyResponseIntent;
  source_message_id: string;
  updated_at: string | null;
}

export interface CustomerJourneySignal {
  category: string;
  objective: string;
  journey_stage: string;
  collected: string[];
  missing: string[];
  response_intent: CustomerJourneyResponseIntent;
  reply: string;
  category_source: "explicit" | "active_goal";
}

export interface CustomerJourneyPlan {
  status: "advance" | "ambiguous" | "none";
  reason: string;
  goal: CustomerGoalState | null;
  entity_id: string | null;
  reply: string | null;
  events: CommerceStateEvent[];
}

const GOAL_ATTRIBUTE = "customer_goal";

function clean(value: unknown, max = 240): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function cleanReply(value: unknown, max = 1200): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function strings(value: unknown, max = 12): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item, 80)).filter(Boolean))]
    .slice(0, max);
}

function isResponseIntent(
  value: unknown,
): value is CustomerJourneyResponseIntent {
  return [
    "advance_decision",
    "reduce_uncertainty",
    "answer_known_fact",
    "request_highest_value_missing_information",
    "confirm_controlled_update",
  ].includes(String(value));
}

export function readCustomerGoal(value: unknown): CustomerGoalState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const category = clean(row.category, 80);
  const objective = clean(row.objective, 120);
  const journey_stage = clean(row.journey_stage, 120);
  const source_message_id = clean(row.source_message_id, 100);
  if (
    !category || !objective || !journey_stage || !source_message_id ||
    !isResponseIntent(row.response_intent)
  ) return null;
  return {
    category,
    objective,
    journey_stage,
    collected: strings(row.collected),
    missing: strings(row.missing),
    response_intent: row.response_intent,
    source_message_id,
    updated_at: clean(row.updated_at, 80) || null,
  };
}

export function activeCustomerGoal(
  state: ConversationCommerceState,
  category?: string | null,
): { entity_id: string; goal: CustomerGoalState } | null {
  const active = state.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred" &&
    (!category || entity.category === category)
  ).flatMap((entity) => {
    const goal = readCustomerGoal(entity.attributes[GOAL_ATTRIBUTE]);
    return goal && goal.category === entity.category
      ? [{ entity_id: entity.entity_id, goal }]
      : [];
  });
  if (active.length !== 1) return null;
  return active[0];
}

/**
 * Bind an industry-neutral journey signal to one compatible active entity.
 * A cancelled/deferred entity is never revived, and multiple compatible
 * entities never receive an implicit update.
 */
export function planCustomerJourney(input: {
  signal: CustomerJourneySignal | null;
  state: ConversationCommerceState;
  source_message_id: string;
  occurred_at?: string | null;
}): CustomerJourneyPlan {
  const signal = input.signal;
  if (!signal) {
    return {
      status: "none",
      reason: "NO_CUSTOMER_JOURNEY_SIGNAL",
      goal: null,
      entity_id: null,
      reply: null,
      events: [],
    };
  }
  const activeCompatible = input.state.entities.filter((entity) =>
    entity.category === signal.category && entity.status !== "cancelled" &&
    entity.status !== "deferred"
  );
  const inactiveCompatible = input.state.entities.filter((entity) =>
    entity.category === signal.category &&
    (entity.status === "cancelled" || entity.status === "deferred")
  );
  if (
    activeCompatible.length > 1 ||
    (!activeCompatible.length && inactiveCompatible.length)
  ) {
    return {
      status: "ambiguous",
      reason: activeCompatible.length > 1
        ? "MULTIPLE_COMPATIBLE_GOALS"
        : "INACTIVE_GOAL_NOT_REACTIVATED",
      goal: null,
      entity_id: null,
      reply: null,
      events: [],
    };
  }
  const existing = activeCompatible[0] ?? null;
  const previousGoal = existing
    ? readCustomerGoal(existing.attributes[GOAL_ATTRIBUTE])
    : null;
  const collected = [
    ...new Set([
      ...(previousGoal?.collected ?? []),
      ...strings(signal.collected),
    ]),
  ].slice(0, 12);
  const missing = strings(signal.missing).filter((item) =>
    !collected.includes(item)
  );
  const goal: CustomerGoalState = {
    category: signal.category,
    objective: signal.objective || previousGoal?.objective || "select_product",
    journey_stage: signal.journey_stage,
    collected,
    missing,
    response_intent: signal.response_intent,
    source_message_id: input.source_message_id,
    updated_at: input.occurred_at ?? null,
  };
  const entity_id = existing?.entity_id ?? `${signal.category}:unscoped`;
  const provenance = {
    source_type: "customer" as const,
    source_message_id: input.source_message_id,
    recorded_at: input.occurred_at ?? null,
  };
  const goalEvent: CommerceStateEvent = existing
    ? {
      type: "SET_ENTITY_ATTRIBUTE",
      entity_id,
      key: GOAL_ATTRIBUTE,
      value: goal,
      provenance,
    }
    : {
      type: "ENSURE_ENTITY",
      entity: {
        entity_id,
        category: signal.category,
        quantity: 1,
        status: "researching",
        attributes: { [GOAL_ATTRIBUTE]: goal },
        constraints: {},
        provenance,
      },
    };
  return {
    status: "advance",
    reason: `CUSTOMER_JOURNEY_${signal.response_intent.toUpperCase()}`,
    goal,
    entity_id,
    reply: cleanReply(signal.reply) || null,
    events: [
      { type: "SET_CONTEXT", intent: goal.objective, topic: goal.category },
      goalEvent,
    ],
  };
}

export function customerJourneyGoalAttribute(): string {
  return GOAL_ATTRIBUTE;
}
