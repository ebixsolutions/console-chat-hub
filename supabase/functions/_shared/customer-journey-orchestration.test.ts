import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { reduceCommerceState } from "./commerce-state-reducer.ts";
import {
  activeCustomerGoal,
  type CustomerJourneySignal,
  planCustomerJourney,
} from "./customer-journey-orchestration.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function signal(
  category: string,
  collected: string[] = [],
): CustomerJourneySignal {
  return {
    category,
    objective: "replace_existing_item",
    journey_stage: "requirements_discovery",
    collected,
    missing: ["size", "suitable_models"],
    response_intent: collected.includes("size")
      ? "advance_decision"
      : "request_highest_value_missing_information",
    reply: collected.includes("size")
      ? "Compare supported models next."
      : "What size do you need?",
    category_source: "explicit",
  };
}

Deno.test("W11 generic customer goal persists objective, stage, collected and missing", () => {
  const empty = createEmptyConversationCommerceState();
  const first = planCustomerJourney({
    signal: signal("category_a"),
    state: empty,
    source_message_id: "s1",
  });
  assert(
    first.status === "advance" && first.entity_id === "category_a:unscoped",
    JSON.stringify(first),
  );
  const state = reduceCommerceState(empty, first.events);
  const goal = activeCustomerGoal(state, "category_a");
  assert(
    goal?.goal.objective === "replace_existing_item",
    JSON.stringify(goal),
  );
  assert(
    goal.goal.journey_stage === "requirements_discovery" &&
      goal.goal.missing.includes("size"),
    JSON.stringify(goal),
  );

  const second = planCustomerJourney({
    signal: signal("category_a", ["size"]),
    state,
    source_message_id: "s2",
  });
  const advanced = reduceCommerceState(state, second.events);
  const next = activeCustomerGoal(advanced, "category_a")?.goal;
  assert(
    next?.collected.includes("size") && !next.missing.includes("size") &&
      next.missing.includes("suitable_models"),
    JSON.stringify(next),
  );
});

Deno.test("W11 goals are category-compatible and never revive cancelled or deferred entities", () => {
  const empty = createEmptyConversationCommerceState();
  const a = planCustomerJourney({
    signal: signal("category_a"),
    state: empty,
    source_message_id: "a",
  });
  let state = reduceCommerceState(empty, a.events);
  const b = planCustomerJourney({
    signal: signal("category_b"),
    state,
    source_message_id: "b",
  });
  state = reduceCommerceState(state, b.events);
  assert(
    state.entities.length === 2 &&
      state.entities.every((entity) => entity.quantity === 1),
    JSON.stringify(state.entities),
  );
  const cancelled = reduceCommerceState(state, [{
    type: "SET_ENTITY_STATUS",
    entity_id: "category_a:unscoped",
    status: "cancelled",
    provenance: { source_type: "customer", source_message_id: "cancel" },
  }]);
  const blocked = planCustomerJourney({
    signal: signal("category_a", ["size"]),
    state: cancelled,
    source_message_id: "later",
  });
  assert(
    blocked.status === "ambiguous" &&
      blocked.reason === "INACTIVE_GOAL_NOT_REACTIVATED" &&
      blocked.events.length === 0,
    JSON.stringify(blocked),
  );
});
