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
import { activeCustomerGoal } from "./customer-journey-orchestration.ts";

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
  ["W9-1", "數量記住：個廳要1部，兩個睡房每間1部"],
  ["W9-2", "客厅放一台，两间卧室每间各一台"],
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

Deno.test("W9 established AC context survives intervening service and memory turns", async () => {
  const f = fixture();
  const opening = introduction;
  await f.ask(opening);
  await f.ask("細房80呎，大房100呎，客廳180呎。", [opening]);
  await f.ask("三個位都有窗口，而家都用窗口機。", ["細房80呎，大房100呎，客廳180呎。", opening]);
  await f.ask("客廳下晝西斜。", ["三個位都有窗口，而家都用窗口機。", "細房80呎，大房100呎，客廳180呎。", opening]);
  const text = "數量先記低：客廳一部，兩間房每間各一部。";
  const reply = await f.ask(text, ["客廳下晝西斜。", "三個位都有窗口，而家都用窗口機。", "細房80呎，大房100呎，客廳180呎。", opening]);
  const snapshot = f.snapshot();
  assert(reply.route === "contextual_scoped_update" && reply.reason === "UNIQUE_COMPATIBLE_CONTEXT", JSON.stringify(reply));
  assert(snapshot.state.current_topic === "air_conditioner", "topic_lost");
  const active = snapshot.state.entities.filter((entity) => entity.status !== "cancelled" && entity.status !== "deferred");
  assert(active.length === 1 && active[0].category === "air_conditioner" && active[0].quantity === 3, JSON.stringify(active));
  const scoped = active[0].attributes.scoped_customer_updates as ScopedCustomerValue[];
  assert(scoped.length === 3 && scoped.every((value) => value.attribute === "quantity" && value.value === 1), JSON.stringify(scoped));
  assert(snapshot.state.conversion.order_status === "none" && snapshot.state.conversion.payment_status === "none" &&
    snapshot.state.conversion.quotation_status === "none" && snapshot.state.quotes.length === 0, "transaction_promoted");
});

Deno.test("W11 production-shaped T1-T5 advances one durable AC purchase journey", async () => {
  const f = fixture();
  const turns = [
    "Hello，屋企想換冷氣，兩間睡房加個客廳，應該點揀好？",
    "細房大概80呎，大房100呎，個廳就180呎。",
    "三個位都有窗口位，而家裝緊嘅都係窗口機。",
    "另外個廳下晝西斜幾勁，揀機時要點考慮？",
  ];
  const replies = [];
  for (let i = 0; i < turns.length; i++) {
    const reply = await f.ask(turns[i], turns.slice(0, i).reverse());
    replies.push(reply);
    assert(reply.route === "product_guidance", `T${i + 1}:${JSON.stringify(reply)}`);
    assert(!/收到，你提到|未確定嘅細節會再核實|提供相關項目、適用範圍同日期/.test(reply.reply ?? ""), `passive:T${i + 1}:${reply.reply}`);
  }
  assert(/平方呎/.test(replies[0].reply ?? ""), String(replies[0].reply));
  assert(/窗口位|安裝方式/.test(replies[1].reply ?? ""), String(replies[1].reply));
  assert(/下午日照|西斜/.test(replies[2].reply ?? ""), String(replies[2].reply));
  assert(/西斜會增加.*負荷/.test(replies[3].reply ?? "") && /唔會.*保證匹數/.test(replies[3].reply ?? ""), String(replies[3].reply));

  const beforeQuantity = f.snapshot();
  const activeBefore = beforeQuantity.state.entities.filter((entity) => entity.status !== "cancelled" && entity.status !== "deferred");
  assert(activeBefore.length === 1 && activeBefore[0].entity_id === "air_conditioner:unscoped", JSON.stringify(activeBefore));
  const goal = activeCustomerGoal(beforeQuantity.state, "air_conditioner")?.goal;
  assert(goal?.objective === "replace_existing_appliance" && goal.journey_stage === "sizing_guidance", JSON.stringify(goal));
  assert(["room_sizes", "installation_type", "sunlight"].every((item) => goal.collected.includes(item)), JSON.stringify(goal));
  assert(goal.missing.join(",") === "sizing_decision,suitable_models", JSON.stringify(goal));

  const t5 = "數量先記低：客廳一部，兩間房每間各一部。";
  const update = await f.ask(t5, turns.slice().reverse());
  assert(update.route === "contextual_scoped_update" && update.reason === "UNIQUE_COMPATIBLE_CONTEXT", JSON.stringify(update));
  assert(update.reply === "記低客廳一部、兩間房各一部，共三部；呢個係選購要求，未落單。", String(update.reply));
  const state = f.snapshot().state;
  assert(state.entities.length === 1 && state.entities[0].quantity === 3, JSON.stringify(state.entities));
  assert(state.conversion.order_status === "none" && state.conversion.payment_status === "none" &&
    state.conversion.quotation_status === "none" && state.quotes.length === 0, "transaction_promoted");
  console.log(`W11-T1|${replies[0].route}|${replies[0].reply}`);
  console.log(`W11-T2|${replies[1].route}|${replies[1].reply}`);
  console.log(`W11-T3|${replies[2].route}|${replies[2].reply}`);
  console.log(`W11-T4|${replies[3].route}|${replies[3].reply}`);
  console.log(`W11-T5|${update.route}|${update.reply}`);
});

Deno.test("W11 entity switch, room correction and cancellation stay scoped", async () => {
  const f = fixture();
  const ac = "屋企想換冷氣，兩間睡房加個客廳，應該點揀？";
  await f.ask(ac);
  await f.ask("細房80呎，大房100呎，客廳180呎。", [ac]);
  await f.ask("全部都有窗口位，而家都係窗口機。", ["細房80呎，大房100呎，客廳180呎。", ac]);
  await f.ask("客廳下晝西斜。", ["全部都有窗口位，而家都係窗口機。", "細房80呎，大房100呎，客廳180呎。", ac]);

  const fridge = await f.ask("另外雪櫃我想睇下，擺位闊度唔超過595mm。", ["客廳下晝西斜。", ac]);
  assert(fridge.route === "product_guidance", JSON.stringify(fridge));
  const switched = f.snapshot().state;
  assert(switched.current_topic === "refrigerator" && switched.entities.filter((entity) => entity.status !== "cancelled" && entity.status !== "deferred").length === 2, JSON.stringify(switched.entities));

  const beforeAmbiguous = JSON.stringify(f.snapshot());
  const ambiguous = await f.ask("房各一部", ["另外雪櫃我想睇下，擺位闊度唔超過595mm。", ac]);
  assert(ambiguous.reason === "contextual_targeted_clarification" && ambiguous.persist_result === "read_only", JSON.stringify(ambiguous));
  assert(JSON.stringify(f.snapshot()) === beforeAmbiguous, "fridge_inherited_ac_quantity");

  const corrected = await f.ask("返返冷氣，更正大房係110呎，唔係100呎。", ["另外雪櫃我想睇下，擺位闊度唔超過595mm。", ac]);
  assert(corrected.route === "product_guidance", JSON.stringify(corrected));
  assert(f.snapshot().state.latest_corrections.at(-1)?.includes("110呎"), JSON.stringify(f.snapshot().state.latest_corrections));

  await f.ask("雪櫃暫時唔買，先取消。", ["返返冷氣，更正大房係110呎，唔係100呎。", ac]);
  const cancelled = f.snapshot().state.entities.find((entity) => entity.category === "refrigerator");
  assert(cancelled?.status === "cancelled" || cancelled?.status === "deferred", JSON.stringify(cancelled));
  await f.ask("冷氣繼續按頭先要求處理。", ["雪櫃暫時唔買，先取消。", ac]);
  const after = f.snapshot().state.entities.find((entity) => entity.category === "refrigerator");
  assert(after?.status === cancelled.status, "cancelled_entity_revived");
});

Deno.test("W9 fresh and incompatible quantity references remain targeted and read-only", async () => {
  const fresh = fixture();
  const freshBefore = JSON.stringify(fresh.snapshot());
  const freshReply = await fresh.ask("客廳一部，兩間房每間各一部");
  assert(freshReply.reason === "contextual_targeted_clarification" && freshReply.persist_result === "read_only", JSON.stringify(freshReply));
  assert(JSON.stringify(fresh.snapshot()) === freshBefore, "fresh_context_mutated");

  const refrigerator = fixture(stateWith(["refrigerator"]));
  const fridgeBefore = JSON.stringify(refrigerator.snapshot());
  const incompatible = await refrigerator.ask("客廳一部，兩間房每間各一部", [introduction]);
  assert(incompatible.reason === "contextual_targeted_clarification", JSON.stringify(incompatible));
  assert(JSON.stringify(refrigerator.snapshot()) === fridgeBefore, "incompatible_context_inherited");
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
