import {
  contextualUpdateEvents,
  resolveContextualCustomerUpdate,
  type ContextualCandidate,
  type ScopedCustomerValue,
} from "./contextual-customer-update.ts";
import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { reduceCommerceState } from "./commerce-state-reducer.ts";
import {
  runCommerceStateRuntime,
  type CommerceStateDbClient,
} from "./commerce-state-runtime.ts";
import { resolveCanonicalCommerceResolution } from "./conversation-resolution-contract.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function stateWith(topics: string[]): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.current_topic = topics[0] ?? null;
  state.entities = topics.map((category, index) => ({
    entity_id: category + ":unscoped:" + index,
    category, quantity: 3, status: "tentative" as const,
    attributes: {}, constraints: {}, provenance: { source_type: "customer" as const },
  }));
  return state;
}
const values = [
  { scope: "living_room", attribute: "quantity", action: "set" as const, value: 1 },
  { scope: "bedroom_1", attribute: "quantity", action: "set" as const, value: 1 },
  { scope: "bedroom_2", attribute: "quantity", action: "set" as const, value: 1 },
];
function candidate(topic: string): ContextualCandidate {
  return {
    topic, topic_source: "profile", action: "scoped_update",
    context_sufficient: true, values, aggregate_quantity: 3, reply: "Scoped update acknowledged.",
    clarification: "Which item and scope do you mean?",
  };
}

Deno.test("universal context: unique compatible update, latest correction wins", () => {
  const previous = stateWith(["domain_a"]);
  const first = resolveContextualCustomerUpdate({ state: previous, candidate: candidate("domain_a") });
  assert(first.route === "contextual_scoped_update", JSON.stringify(first));
  const next = reduceCommerceState(previous, contextualUpdateEvents(first, previous, "source-1"));
  assert(next.entities[0].quantity === 3, "aggregate_three");
  const correction = candidate("domain_a");
  correction.values = [{ scope: "bedroom_2", attribute: "quantity", action: "set", value: 2 }];
  correction.aggregate_quantity = 4;
  const second = resolveContextualCustomerUpdate({ state: next, candidate: correction });
  assert(second.route === "contextual_scoped_update", JSON.stringify(second));
  const corrected = reduceCommerceState(next, contextualUpdateEvents(second, next, "source-2"));
  assert(corrected.entities[0].quantity === 4, "latest_total_four");
  assert((corrected.entities[0].attributes.scoped_customer_updates as typeof values)
    .find((v) => v.scope === "bedroom_2")?.value === 2, "latest_scope_wins");
  console.log("UNIVERSAL|unique_update=PASS|correction_latest_wins=PASS");
});

Deno.test("universal context: partial allocation and preference update retain aggregate", () => {
  const previous = stateWith(["domain_a"]);
  const preference = candidate("domain_a");
  preference.values = [{ scope: "whole_item", attribute: "preference", action: "set", value: "weekend" }];
  preference.aggregate_quantity = undefined;
  const decided = resolveContextualCustomerUpdate({ state: previous, candidate: preference });
  const next = reduceCommerceState(previous, contextualUpdateEvents(decided, previous, "preference"));
  assert(next.entities[0].quantity === 3, "preference_changed_quantity");
  const partial = candidate("domain_a");
  partial.values = [{ scope: "zone_1", attribute: "quantity", action: "set", value: 1 }];
  partial.aggregate_quantity = undefined;
  const after = reduceCommerceState(next, contextualUpdateEvents(resolveContextualCustomerUpdate({ state: next, candidate: partial }), next, "partial"));
  assert(after.entities[0].quantity === 3, "partial_scope_changed_aggregate");
  assert((after.entities[0].attributes.scoped_customer_updates as ScopedCustomerValue[]).length === 2, "preference_lost");
  console.log("UNIVERSAL|preference_attribute=PASS|partial_allocation_no_inferred_total=PASS");
});

Deno.test("universal context: ambiguity, cross-domain and read-only never mutate", () => {
  const multiple = stateWith(["domain_a", "domain_b"]);
  const implicit = resolveContextualCustomerUpdate({ state: multiple, candidate: candidate("domain_a") });
  assert(implicit.route === "targeted_clarification" && implicit.updates.length === 0, JSON.stringify(implicit));
  const explicit = candidate("domain_a");
  explicit.topic_source = "explicit";
  const selected = resolveContextualCustomerUpdate({ state: multiple, candidate: explicit });
  assert(selected.route === "contextual_scoped_update" && selected.entity_id === multiple.entities[0].entity_id, "explicit_scope");
  const incompatible = resolveContextualCustomerUpdate({ state: stateWith(["domain_b"]), candidate: explicit });
  assert(incompatible.route === "targeted_clarification", "incompatible_domain");
  const readOnly = resolveContextualCustomerUpdate({ state: stateWith(["domain_a"]), candidate: candidate("domain_a"), read_only: true });
  assert(readOnly.route === "none" && contextualUpdateEvents(readOnly, stateWith(["domain_a"]), "read").length === 0, "read_only");
  const sameCategory = stateWith(["domain_a", "domain_a"]);
  assert(resolveContextualCustomerUpdate({ state: sameCategory, candidate: explicit }).route === "targeted_clarification", "multiple_compatible");
  console.log("UNIVERSAL|ambiguous=PASS|cross_domain=PASS|read_only=PASS");
});

function fixture(initial = createEmptyConversationCommerceState()) {
  let state = initial;
  let revision = initial.entities.length ? 1 : 0;
  const db: CommerceStateDbClient = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: revision ? { revision, state } : null, error: null,
    }) }) }) }),
    rpc: async (_fn, params) => {
      state = params.p_state as ConversationCommerceState;
      revision += 1;
      return { data: { result: "success", applied_revision: revision }, error: null };
    },
  };
  let turn = 0;
  const ask = async (text: string, history: string[] = []) => {
    turn += 1;
    const result = await runCommerceStateRuntime(db, {
      company_id: "company", conversation_id: "conversation",
      source_message_id: "source-" + turn, text, language: "zh-TW",
      history: history.map((content) => ({ role: "visitor", content })),
    });
    assert(result, "runtime_empty");
    return result;
  };
  return { ask, snapshot: () => ({ state, revision }) };
}

const introduction = "我想問冷氣匹數，兩間房加個廳。";
const variants = [
  ["B", "係廳一部，房各一部"],
  ["C", "客廳一部，兩間房各一部"],
  ["E", "廤一部，兩間房各一部"],
] as const;

Deno.test("home appliance A: useful guidance rather than generic clarification", async () => {
  const f = fixture();
  const reply = await f.ask(introduction);
  assert(reply.route === "product_guidance", JSON.stringify(reply));
  assert(/兩間房|客廳/.test(reply.reply ?? "") && /面積/.test(reply.reply ?? ""), String(reply.reply));
  assert(!/收到，你提到|customer_goal|已落單/.test(reply.reply ?? ""), "generic_or_claim");
  assert(f.snapshot().state.current_topic === "air_conditioner", "context_not_durable");
  assert(resolveCanonicalCommerceResolution({ outcome: reply, authoritative_address_correction: false }).bypass_service_plan, "precedence");
  console.log("A|" + reply.route + "|" + reply.reply);
});

for (const [label, text] of variants) {
  Deno.test(`home appliance ${label}: scoped allocation from established context`, async () => {
    const f = fixture();
    await f.ask(introduction);
    const reply = await f.ask(text, [introduction]);
    const s = f.snapshot().state;
    assert(reply.route === "contextual_scoped_update", JSON.stringify(reply));
    assert(s.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred").reduce((n, e) => n + e.quantity, 0) === 3, "aggregate_three");
    const updates = s.entities[0]?.attributes.scoped_customer_updates as typeof values;
    assert(Array.isArray(updates) && updates.length === 3 && updates.every((v) => v.value === 1), "one_each");
    assert(/客廳|兩間房/.test(reply.reply ?? "") && /三部/.test(reply.reply ?? ""), String(reply.reply));
    assert(!/customer_goal|已落單|已確認|收到，你提到/.test(reply.reply ?? ""), "false_action_or_internal");
    assert(resolveCanonicalCommerceResolution({ outcome: reply, authoritative_address_correction: false }).bypass_service_plan, "precedence");
    console.log(label + "|" + reply.route + "|" + reply.reply + "|revision=" + f.snapshot().revision);
  });
}

Deno.test("home appliance D: room-only allocation without room context asks target", async () => {
  const f = fixture();
  const before = JSON.stringify(f.snapshot().state);
  const reply = await f.ask("房各一部");
  assert(reply.reason === "contextual_targeted_clarification" && reply.persist_result === "read_only", JSON.stringify(reply));
  assert(reply.reply?.includes("幾間房"), String(reply.reply));
  assert(JSON.stringify(f.snapshot().state) === before && f.snapshot().revision === 0, "clarification_mutated");
  console.log("D|targeted_clarification|" + reply.reply);
});

Deno.test("home appliance typo without unique context stays read-only", async () => {
  const f = fixture();
  const reply = await f.ask("廤一部，兩間房各一部");
  assert(reply.reason === "contextual_targeted_clarification", JSON.stringify(reply));
  assert(f.snapshot().revision === 0 && f.snapshot().state.entities.length === 0, "typo_guessed_without_context");
});

Deno.test("live runtime read-only recall preserves state and source provenance", async () => {
  const f = fixture();
  await f.ask(introduction);
  await f.ask("係廳一部，房各一部", [introduction]);
  const before = JSON.stringify(f.snapshot());
  const reply = await f.ask("我而家要幾多部冷氣？", [introduction, "係廳一部，房各一部"]);
  assert(/3|三/.test(reply.reply ?? ""), JSON.stringify(reply));
  assert(JSON.stringify(f.snapshot()) === before, "read_only_mutated_state");
});

Deno.test("live runtime cannot inherit AC allocation into refrigerator context", async () => {
  const f = fixture(stateWith(["refrigerator"]));
  const before = JSON.stringify(f.snapshot());
  const reply = await f.ask("係廳一部，房各一部", [introduction]);
  assert(reply.reason === "contextual_targeted_clarification", JSON.stringify(reply));
  assert(JSON.stringify(f.snapshot()) === before, "cross_entity_mutation");
});
