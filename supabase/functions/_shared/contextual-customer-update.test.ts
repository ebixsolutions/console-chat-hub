import {
  type ContextualCandidate,
  contextualUpdateEvents,
  resolveContextualCustomerUpdate,
  type ScopedCustomerValue,
} from "./contextual-customer-update.ts";
import {
  type ConversationCommerceState,
  createEmptyConversationCommerceState,
} from "./commerce-state-contract.ts";
import { reduceCommerceState } from "./commerce-state-reducer.ts";
import {
  type CommerceStateDbClient,
  runCommerceStateRuntime,
  validateTrustedProductTopicFocus,
} from "./commerce-state-runtime.ts";
import { resolveCanonicalCommerceResolution } from "./conversation-resolution-contract.ts";
import { activeCustomerGoal } from "./customer-journey-orchestration.ts";
import { prepareConversationRecall } from "./conversation-recall.ts";
import { buildCanonicalConversationMemory, verifyCommittedRoomCorrectionMemory } from "./conversation-long-memory.ts";
import {
  arbitrateAnaphoricProductFollowUp,
  classifyNaturalCustomerIntent,
  requiresCurrentMerchantEvidence,
} from "./natural-customer-response.ts";
import { evaluateB2BeforeCommit } from "./pre-send-conversion-supervisor.ts";
import { planConversationService, renderServicePlanReply } from "./conversation-service-planner.ts";
import { renderNaturalNoCurrentEvidence } from "./natural-customer-response.ts";
import { productKbSemanticContract } from "./product-kb-semantic-contract.ts";
import { deriveCurrentGroundingTarget, selectCanonicalGrounding } from "./canonical-grounding.ts";
import { resolveCanonicalKbDirectAnswer } from "./canonical-kb-direct-answer.ts";
import type { KBDocumentCandidate } from "./deterministic-kb-client.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function stateWith(topics: string[]): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.current_topic = topics[0] ?? null;
  state.entities = topics.map((category, index) => ({
    entity_id: category + ":unscoped:" + index,
    category,
    quantity: 3,
    status: "tentative" as const,
    attributes: {},
    constraints: {},
    provenance: { source_type: "customer" as const },
  }));
  return state;
}
const values = [
  {
    scope: "living_room",
    attribute: "quantity",
    action: "set" as const,
    value: 1,
  },
  {
    scope: "bedroom_1",
    attribute: "quantity",
    action: "set" as const,
    value: 1,
  },
  {
    scope: "bedroom_2",
    attribute: "quantity",
    action: "set" as const,
    value: 1,
  },
];
function candidate(topic: string): ContextualCandidate {
  return {
    topic,
    topic_source: "profile",
    action: "scoped_update",
    context_sufficient: true,
    values,
    aggregate_quantity: 3,
    reply: "Scoped update acknowledged.",
    clarification: "Which item and scope do you mean?",
  };
}

Deno.test("universal context: unique compatible update, latest correction wins", () => {
  const previous = stateWith(["domain_a"]);
  const first = resolveContextualCustomerUpdate({
    state: previous,
    candidate: candidate("domain_a"),
  });
  assert(first.route === "contextual_scoped_update", JSON.stringify(first));
  const next = reduceCommerceState(
    previous,
    contextualUpdateEvents(first, previous, "source-1"),
  );
  assert(next.entities[0].quantity === 3, "aggregate_three");
  const correction = candidate("domain_a");
  correction.values = [{
    scope: "bedroom_2",
    attribute: "quantity",
    action: "set",
    value: 2,
  }];
  correction.aggregate_quantity = 4;
  const second = resolveContextualCustomerUpdate({
    state: next,
    candidate: correction,
  });
  assert(second.route === "contextual_scoped_update", JSON.stringify(second));
  const corrected = reduceCommerceState(
    next,
    contextualUpdateEvents(second, next, "source-2"),
  );
  assert(corrected.entities[0].quantity === 4, "latest_total_four");
  assert(
    (corrected.entities[0].attributes.scoped_customer_updates as typeof values)
      .find((v) => v.scope === "bedroom_2")?.value === 2,
    "latest_scope_wins",
  );
  console.log("UNIVERSAL|unique_update=PASS|correction_latest_wins=PASS");
});

Deno.test("universal context: partial allocation and preference update retain aggregate", () => {
  const previous = stateWith(["domain_a"]);
  const preference = candidate("domain_a");
  preference.values = [{
    scope: "whole_item",
    attribute: "preference",
    action: "set",
    value: "weekend",
  }];
  preference.aggregate_quantity = undefined;
  const decided = resolveContextualCustomerUpdate({
    state: previous,
    candidate: preference,
  });
  const next = reduceCommerceState(
    previous,
    contextualUpdateEvents(decided, previous, "preference"),
  );
  assert(next.entities[0].quantity === 3, "preference_changed_quantity");
  const partial = candidate("domain_a");
  partial.values = [{
    scope: "zone_1",
    attribute: "quantity",
    action: "set",
    value: 1,
  }];
  partial.aggregate_quantity = undefined;
  const after = reduceCommerceState(
    next,
    contextualUpdateEvents(
      resolveContextualCustomerUpdate({ state: next, candidate: partial }),
      next,
      "partial",
    ),
  );
  assert(after.entities[0].quantity === 3, "partial_scope_changed_aggregate");
  assert(
    (after.entities[0].attributes
      .scoped_customer_updates as ScopedCustomerValue[]).length === 2,
    "preference_lost",
  );
  console.log(
    "UNIVERSAL|preference_attribute=PASS|partial_allocation_no_inferred_total=PASS",
  );
});

Deno.test("universal context: ambiguity, cross-domain and read-only never mutate", () => {
  const multiple = stateWith(["domain_a", "domain_b"]);
  const implicit = resolveContextualCustomerUpdate({
    state: multiple,
    candidate: candidate("domain_a"),
  });
  assert(
    implicit.route === "targeted_clarification" &&
      implicit.updates.length === 0,
    JSON.stringify(implicit),
  );
  const explicit = candidate("domain_a");
  explicit.topic_source = "explicit";
  const selected = resolveContextualCustomerUpdate({
    state: multiple,
    candidate: explicit,
  });
  assert(
    selected.route === "contextual_scoped_update" &&
      selected.entity_id === multiple.entities[0].entity_id,
    "explicit_scope",
  );
  const incompatible = resolveContextualCustomerUpdate({
    state: stateWith(["domain_b"]),
    candidate: explicit,
  });
  assert(
    incompatible.route === "targeted_clarification",
    "incompatible_domain",
  );
  const readOnly = resolveContextualCustomerUpdate({
    state: stateWith(["domain_a"]),
    candidate: candidate("domain_a"),
    read_only: true,
  });
  assert(
    readOnly.route === "none" &&
      contextualUpdateEvents(readOnly, stateWith(["domain_a"]), "read")
          .length === 0,
    "read_only",
  );
  const sameCategory = stateWith(["domain_a", "domain_a"]);
  assert(
    resolveContextualCustomerUpdate({
      state: sameCategory,
      candidate: explicit,
    }).route === "targeted_clarification",
    "multiple_compatible",
  );
  console.log("UNIVERSAL|ambiguous=PASS|cross_domain=PASS|read_only=PASS");
});

function fixture(initial = createEmptyConversationCommerceState()) {
  let state = initial;
  let revision = initial.entities.length ? 1 : 0;
  const db: CommerceStateDbClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: revision ? { revision, state } : null,
            error: null,
          }),
        }),
      }),
    }),
    rpc: async (_fn, params) => {
      state = params.p_state as ConversationCommerceState;
      revision += 1;
      return {
        data: { result: "success", applied_revision: revision },
        error: null,
      };
    },
  };
  let turn = 0;
  const ask = async (text: string, history: string[] = [], trusted_product_topic_focus?: { topic: string; product: string; resolution_strategy: "PER_TOPIC_REFERENT_HISTORY" }) => {
    turn += 1;
    const result = await runCommerceStateRuntime(db, {
      company_id: "company",
      conversation_id: "conversation",
      source_message_id: "source-" + turn,
      text,
      language: "zh-TW",
      history: history.map((content) => ({ role: "visitor", content })),
      trusted_product_topic_focus,
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
  assert(
    /兩間房|客廳/.test(reply.reply ?? "") && /面積/.test(reply.reply ?? ""),
    String(reply.reply),
  );
  assert(
    !/收到，你提到|customer_goal|已落單/.test(reply.reply ?? ""),
    "generic_or_claim",
  );
  assert(
    f.snapshot().state.current_topic === "air_conditioner",
    "context_not_durable",
  );
  assert(
    resolveCanonicalCommerceResolution({
      outcome: reply,
      authoritative_address_correction: false,
    }).bypass_service_plan,
    "precedence",
  );
  console.log("A|" + reply.route + "|" + reply.reply);
});

for (const [label, text] of variants) {
  Deno.test(`home appliance ${label}: scoped allocation from established context`, async () => {
    const f = fixture();
    await f.ask(introduction);
    const reply = await f.ask(text, [introduction]);
    const s = f.snapshot().state;
    assert(reply.route === "contextual_scoped_update", JSON.stringify(reply));
    assert(
      s.entities.filter((e) =>
        e.status !== "cancelled" && e.status !== "deferred"
      ).reduce((n, e) => n + e.quantity, 0) === 3,
      "aggregate_three",
    );
    const updates = s.entities[0]?.attributes
      .scoped_customer_updates as typeof values;
    assert(
      Array.isArray(updates) && updates.length === 3 &&
        updates.every((v) => v.value === 1),
      "one_each",
    );
    assert(
      /客廳|兩間房/.test(reply.reply ?? "") && /三部/.test(reply.reply ?? ""),
      String(reply.reply),
    );
    assert(
      !/customer_goal|已落單|已確認|收到，你提到/.test(reply.reply ?? ""),
      "false_action_or_internal",
    );
    assert(
      resolveCanonicalCommerceResolution({
        outcome: reply,
        authoritative_address_correction: false,
      }).bypass_service_plan,
      "precedence",
    );
    console.log(
      label + "|" + reply.route + "|" + reply.reply + "|revision=" +
        f.snapshot().revision,
    );
  });
}

Deno.test("home appliance D: room-only allocation without room context asks target", async () => {
  const f = fixture();
  const before = JSON.stringify(f.snapshot().state);
  const reply = await f.ask("房各一部");
  assert(
    reply.reason === "contextual_targeted_clarification" &&
      reply.persist_result === "read_only",
    JSON.stringify(reply),
  );
  assert(reply.reply?.includes("幾間房"), String(reply.reply));
  assert(
    JSON.stringify(f.snapshot().state) === before &&
      f.snapshot().revision === 0,
    "clarification_mutated",
  );
  console.log("D|targeted_clarification|" + reply.reply);
});

Deno.test("home appliance typo without unique context stays read-only", async () => {
  const f = fixture();
  const reply = await f.ask("廤一部，兩間房各一部");
  assert(
    reply.reason === "contextual_targeted_clarification",
    JSON.stringify(reply),
  );
  assert(
    f.snapshot().revision === 0 && f.snapshot().state.entities.length === 0,
    "typo_guessed_without_context",
  );
});

Deno.test("W9 established AC context survives intervening service and memory turns", async () => {
  const f = fixture();
  const opening = introduction;
  await f.ask(opening);
  await f.ask("細房80呎，大房100呎，客廳180呎。", [opening]);
  await f.ask("三個位都有窗口，而家都用窗口機。", [
    "細房80呎，大房100呎，客廳180呎。",
    opening,
  ]);
  await f.ask("客廳下晝西斜。", [
    "三個位都有窗口，而家都用窗口機。",
    "細房80呎，大房100呎，客廳180呎。",
    opening,
  ]);
  const text = "數量先記低：客廳一部，兩間房每間各一部。";
  const reply = await f.ask(text, [
    "客廳下晝西斜。",
    "三個位都有窗口，而家都用窗口機。",
    "細房80呎，大房100呎，客廳180呎。",
    opening,
  ]);
  const snapshot = f.snapshot();
  assert(
    reply.route === "contextual_scoped_update" &&
      reply.reason === "UNIQUE_COMPATIBLE_CONTEXT",
    JSON.stringify(reply),
  );
  assert(snapshot.state.current_topic === "air_conditioner", "topic_lost");
  const active = snapshot.state.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  assert(
    active.length === 1 && active[0].category === "air_conditioner" &&
      active[0].quantity === 3,
    JSON.stringify(active),
  );
  const scoped = active[0].attributes
    .scoped_customer_updates as ScopedCustomerValue[];
  assert(
    scoped.length === 3 &&
      scoped.every((value) =>
        value.attribute === "quantity" && value.value === 1
      ),
    JSON.stringify(scoped),
  );
  assert(
    snapshot.state.conversion.order_status === "none" &&
      snapshot.state.conversion.payment_status === "none" &&
      snapshot.state.conversion.quotation_status === "none" &&
      snapshot.state.quotes.length === 0,
    "transaction_promoted",
  );
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
    assert(
      reply.route === "product_guidance",
      `T${i + 1}:${JSON.stringify(reply)}`,
    );
    assert(
      !/收到，你提到|未確定嘅細節會再核實|提供相關項目、適用範圍同日期/.test(
        reply.reply ?? "",
      ),
      `passive:T${i + 1}:${reply.reply}`,
    );
  }
  assert(/平方呎/.test(replies[0].reply ?? ""), String(replies[0].reply));
  assert(
    /窗口位|安裝方式/.test(replies[1].reply ?? ""),
    String(replies[1].reply),
  );
  assert(
    /下午日照|西斜/.test(replies[2].reply ?? ""),
    String(replies[2].reply),
  );
  assert(
    /西斜會增加.*負荷/.test(replies[3].reply ?? "") &&
      /唔會.*保證匹數/.test(replies[3].reply ?? ""),
    String(replies[3].reply),
  );

  const beforeQuantity = f.snapshot();
  const activeBefore = beforeQuantity.state.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  assert(
    activeBefore.length === 1 &&
      activeBefore[0].entity_id === "air_conditioner:unscoped",
    JSON.stringify(activeBefore),
  );
  const goal = activeCustomerGoal(beforeQuantity.state, "air_conditioner")
    ?.goal;
  assert(
    goal?.objective === "replace_existing_appliance" &&
      goal.journey_stage === "sizing_guidance",
    JSON.stringify(goal),
  );
  assert(
    ["room_sizes", "installation_type", "sunlight"].every((item) =>
      goal.collected.includes(item)
    ),
    JSON.stringify(goal),
  );
  assert(
    goal.missing.join(",") === "sizing_decision,suitable_models",
    JSON.stringify(goal),
  );

  const t5 = "數量先記低：客廳一部，兩間房每間各一部。";
  const update = await f.ask(t5, turns.slice().reverse());
  assert(
    update.route === "contextual_scoped_update" &&
      update.reason === "UNIQUE_COMPATIBLE_CONTEXT",
    JSON.stringify(update),
  );
  assert(
    update.reply ===
      "記低客廳一部、兩間房各一部，共三部；呢個係選購要求，未落單。",
    String(update.reply),
  );
  const state = f.snapshot().state;
  assert(
    state.entities.length === 1 && state.entities[0].quantity === 3,
    JSON.stringify(state.entities),
  );
  assert(
    state.conversion.order_status === "none" &&
      state.conversion.payment_status === "none" &&
      state.conversion.quotation_status === "none" && state.quotes.length === 0,
    "transaction_promoted",
  );
  console.log(`W11-T1|${replies[0].route}|${replies[0].reply}`);
  console.log(`W11-T2|${replies[1].route}|${replies[1].reply}`);
  console.log(`W11-T3|${replies[2].route}|${replies[2].reply}`);
  console.log(`W11-T4|${replies[3].route}|${replies[3].reply}`);
  console.log(`W11-T5|${update.route}|${update.reply}`);
});

Deno.test("W13 T1-T5 committed journey progress carries bounded B2 authorization", async () => {
  const f = fixture();
  const turns = [
    "Hello，屋企想換冷氣，兩間睡房加個客廳，應該點揀好？",
    "細房大概80呎，大房100呎，個廳就180呎。",
    "三個位都有窗口位，而家裝緊嘅都係窗口機。",
    "另外個廳下晝西斜幾勁，揀機時要點考慮？",
    "數量先記低：客廳一部，兩間房每間各一部。",
  ];
  for (let i = 0; i < turns.length; i++) {
    const outcome = await f.ask(turns[i], turns.slice(0, i).reverse());
    const current = f.snapshot();
    const proof = outcome.trusted_journey_progress;
    assert(proof, `T${i + 1}:missing_private_proof:${JSON.stringify(outcome)}`);
    const verdict = evaluateB2BeforeCommit({
      proposed_response: outcome.reply ?? "",
      persistence_kind: "ai_reply",
      snapshot: {
        conversation_id: "conversation",
        company_id: "company",
        source_message_id: `source-${i + 1}`,
        source_message_content: turns[i],
        commerce_state_revision: current.revision,
        commerce_state_source_message_id: `source-${i + 1}`,
        state: current.state,
      },
      metadata: {
        response_route: outcome.route,
        commerce_reason: outcome.reason,
        commerce_authority: outcome.authority,
        commerce_state_revision: outcome.revision,
        commerce_state_persist_result: outcome.persist_result,
        commerce_state_persistence_classification: "COMMITTED",
        contextual_decision: outcome.contextual_decision ?? null,
      },
      trusted_journey_progress: proof,
    });
    const expectedCode = i >= 1
      ? "B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE"
      : "B2_ALLOW";
    assert(
      verdict.decision === "allow" && verdict.code === expectedCode,
      `T${i + 1}:B2:${JSON.stringify(verdict)}`,
    );
    if (i < 4) {
      assert(outcome.route === "product_guidance", `T${i + 1}:route`);
    } else {
      assert(
        outcome.route === "contextual_scoped_update" &&
          outcome.reason === "UNIQUE_COMPATIBLE_CONTEXT",
        `T5:${JSON.stringify(outcome)}`,
      );
    }
    console.log(
      `W13-T${
        i + 1
      }|${outcome.route}|${outcome.reply}|revision=${current.revision}|${verdict.code}`,
    );
  }
  const state = f.snapshot().state;
  const entity = state.entities.find((candidate) =>
    candidate.entity_id === "air_conditioner:unscoped"
  );
  assert(entity?.quantity === 3, JSON.stringify(entity));
  const scoped = entity.attributes
    .scoped_customer_updates as ScopedCustomerValue[];
  assert(
    scoped.length === 3 && scoped.every((item) => item.value === 1),
    JSON.stringify(scoped),
  );
  assert(
    state.conversion.order_status === "none" &&
      state.conversion.payment_status === "none" &&
      state.conversion.quotation_status === "none" && state.quotes.length === 0,
    "W13 transaction boundary",
  );
});

Deno.test("W15 sequential T1-T8 preserves journey then prioritizes factual follow-up", async () => {
  const f = fixture();
  const turns = [
    "Hello，屋企想換冷氣，兩間睡房加個客廳，應該點揀好？",
    "細房大概80呎，大房100呎，個廳就180呎。",
    "三個位都有窗口位，而家裝緊嘅都係窗口機。",
    "另外個廳下晝西斜幾勁，揀機時要點考慮？",
    "數量先記低：客廳一部，兩間房每間各一部。",
  ];
  for (let i = 0; i < turns.length; i++) {
    const outcome = await f.ask(turns[i], turns.slice(0, i).reverse());
    assert(
      i < 4
        ? outcome.route === "product_guidance"
        : outcome.route === "contextual_scoped_update" &&
          outcome.reason === "UNIQUE_COMPATIBLE_CONTEXT",
      `T${i + 1}:${JSON.stringify(outcome)}`,
    );
  }
  const t6 = "細房我見到 CW-SUL70BA，佢有咩功能、係幾多匹？80呎用落夠唔夠？";
  const t6Intent = classifyNaturalCustomerIntent(t6);
  assert(
    t6Intent.kind === "product_factual_query" &&
      t6Intent.facts.join(",") === "features,horsepower,suitability" &&
      requiresCurrentMerchantEvidence(t6Intent),
    JSON.stringify(t6Intent),
  );
  const t7 = arbitrateAnaphoricProductFollowUp("咁呢部而家賣幾錢？", [
    {
      role: "visitor",
      content: t6,
    },
    ...turns.slice().reverse().map((content) => ({ role: "visitor", content })),
  ]);
  assert(
    t7.kind === "resolved" && t7.intent.product === "CW-SUL70BA" &&
      t7.intent.fact === "price" && requiresCurrentMerchantEvidence(t7.intent),
    JSON.stringify(t7),
  );

  const beforeSwitch = structuredClone(f.snapshot().state);
  const t8 = await f.ask(
    "另外雪櫃都想換，擺位闊度最多595mm，想搵雙門款。",
    ["咁呢部而家賣幾錢？", t6, ...turns.slice().reverse()],
  );
  const afterSwitch = f.snapshot().state;
  const ac = afterSwitch.entities.find((entity) =>
    entity.category === "air_conditioner"
  );
  const fridge = afterSwitch.entities.find((entity) =>
    entity.category === "refrigerator"
  );
  assert(t8.route === "product_guidance", JSON.stringify(t8));
  assert(
    ac?.quantity === 3 && fridge?.quantity === 1 &&
      !JSON.stringify(fridge).includes("180") &&
      !JSON.stringify(fridge).includes("sunlight"),
    JSON.stringify(afterSwitch.entities),
  );
  assert(
    beforeSwitch.conversion.order_status === "none" &&
      afterSwitch.conversion.order_status === "none" &&
      afterSwitch.conversion.payment_status === "none" &&
      afterSwitch.quotes.length === 0,
    "transaction_boundary_changed",
  );
  console.log(
    "W15-SEQUENTIAL|T1-T5=PASS|T6=features+horsepower+suitability|T7=CURRENT_KB_REQUIRED:price:CW-SUL70BA|T8=refrigerator_isolated",
  );
  console.log(`W15-T8|${t8.route}|${t8.reply}`);
});

Deno.test("W19 sequential T1-T16 source replay preserves customer journey, KB and transaction boundaries", async () => {
  const f = fixture();
  const turns: string[] = [];
  const ask = async (text: string) => { const outcome = await f.ask(text, turns.slice().reverse()); turns.push(text); return outcome; };
  const t1 = await ask("Hello，屋企想換冷氣，兩間睡房加個客廳，應該點揀好？");
  const t2 = await ask("細房大概80呎，大房100呎，個廳就180呎。");
  const t3 = await ask("三個位都有窗口位，而家裝緊嘅都係窗口機。");
  const t4 = await ask("另外個廳下晝西斜幾勁，揀機時要點考慮？");
  const t5 = await ask("數量先記低：客廳一部，兩間房每間各一部。");
  assert([t1, t2, t3, t4].every((turn) => turn.route === "product_guidance") && t5.route === "contextual_scoped_update" && t5.reason === "UNIQUE_COMPATIBLE_CONTEXT", JSON.stringify({ t1, t2, t3, t4, t5 }));

  const t6 = "細房我見到 CW-SUL70BA，佢有咩功能、係幾多匹？80呎用落夠唔夠？";
  const t6Intent = classifyNaturalCustomerIntent(t6); turns.push(t6);
  assert(t6Intent.kind === "product_factual_query" && t6Intent.facts.join(",") === "features,horsepower,suitability", JSON.stringify(t6Intent));
  const t7 = "咁呢部而家賣幾錢？";
  const t7Result = arbitrateAnaphoricProductFollowUp(t7, turns.slice().reverse().map((content) => ({ role: "visitor", content }))); turns.push(t7);
  assert(t7Result.kind === "resolved" && t7Result.intent.product === "CW-SUL70BA" && t7Result.intent.fact === "price", JSON.stringify(t7Result));

  const t8 = await ask("另外雪櫃都想換，擺位闊度最多595mm，想搵雙門款。");
  const switched = f.snapshot().state;
  const acAfterSwitch = switched.entities.find((entity) => entity.category === "air_conditioner");
  const fridgeAfterSwitch = switched.entities.find((entity) => entity.category === "refrigerator");
  assert(t8.route === "product_guidance" && acAfterSwitch?.quantity === 3 && fridgeAfterSwitch?.quantity === 1 && !JSON.stringify(fridgeAfterSwitch).includes("180") && !JSON.stringify(fridgeAfterSwitch).includes("sunlight"), JSON.stringify({ t8, entities: switched.entities }));

  const t9 = "講返頭先嗰部冷氣，細房研究緊邊個型號同幾多匹？";
  const t9Result = arbitrateAnaphoricProductFollowUp(t9, turns.slice().reverse().map((content) => ({ role: "visitor", content, conversation_id: "conversation", company_id: "company" })), { conversation_id: "conversation", company_id: "company" });
  const t9Focus = { topic: "air_conditioner", product: "CW-SUL70BA", resolution_strategy: "PER_TOPIC_REFERENT_HISTORY" as const };
  const focusValidation = validateTrustedProductTopicFocus({ conversation_id: "conversation", company_id: "company", source_message_id: "source-t9", text: t9, language: "zh-TW", history: turns.slice().reverse().map((content) => ({ role: "visitor", content })), trusted_product_topic_focus: t9Focus }, f.snapshot().state);
  assert(focusValidation.valid, JSON.stringify(focusValidation));
  const t9State = await f.ask(t9, turns.slice().reverse(), t9Focus); turns.push(t9);
  assert(t9Result.kind === "resolved" && t9Result.intent.product === "CW-SUL70BA" && t9Result.intent.facts.includes("model_info") && t9Result.intent.facts.includes("horsepower") && t9Result.resolved_topic === "air_conditioner" && f.snapshot().state.current_topic === "air_conditioner", JSON.stringify({ t9Result, t9State }));

  const t10 = await ask("大房唔係100呎，應該係110呎。");
  assert(t10.persist_result === "success" && t10.trusted_correction_commit?.previous_value === "100平方呎" && t10.trusted_correction_commit?.current_value === "110平方呎" && f.snapshot().state.current_topic === "air_conditioner" && f.snapshot().state.latest_corrections.some((value) => value.includes("110呎") && value.includes("100呎")), JSON.stringify({ t10, state: f.snapshot().state }));
  const t10Proof = t10.trusted_correction_commit!;
  const t10State = f.snapshot();
  assert(t10Proof.category === "air_conditioner" && t10Proof.scope === "large_bedroom" &&
    t10Proof.field === "room_size" && t10Proof.previous_values.large_bedroom === "100平方呎" &&
    t10Proof.committed_values.large_bedroom === "110平方呎" &&
    t10State.state.entities.find((entity) => entity.entity_id === t10Proof.entity_id)?.attributes.room_sizes &&
    t10State.revision === t10Proof.previous_revision + 1, "t10_scoped_commit");
  const t10Memory = buildCanonicalConversationMemory({
    conversation_id: "conversation", company_id: "company",
    source_message_id: t10Proof.source_message_id,
    commerce_state_revision: t10State.revision,
    commerce_state: t10State.state,
    newest_first: turns.slice().reverse().map((content, index) => ({
      id: index === 0 ? t10Proof.source_message_id : `source-${turns.length - index}`, role: "visitor", content,
    })),
    visitor_turn_count: turns.length,
    source_created_at: "2026-09-25T00:00:00.000Z",
    next_memory_revision: turns.length,
  });
  const t10Current = t10Memory.current_customer_facts.find((fact) => fact.key === "room_size");
  assert(Array.isArray(t10Current?.value) &&
    t10Current.value.some((item) => item.label === "大房" && item.value === "110平方呎") &&
    t10Memory.cancelled_or_superseded.some((fact) =>
      fact.key === "superseded_room_size" &&
      (fact.value as { value?: string }).value === "100平方呎"
    ) && t10Memory.commerce_state_revision === t10State.revision, "t10_memory_commerce_disagree");
  const exactReadback = {
    memory: t10Memory, receipt: t10Proof,
    commerce: { company_id: "company", source_message_id: t10Proof.source_message_id, revision: t10State.revision },
  };
  assert(verifyCommittedRoomCorrectionMemory(exactReadback), "t10_memory_receipt_rejected");
  for (const [label, readback] of ([
    ["missing_memory", { ...exactReadback, memory: null }],
    ["wrong_tenant", { ...exactReadback, commerce: { ...exactReadback.commerce, company_id: "other" } }],
    ["wrong_turn", { ...exactReadback, commerce: { ...exactReadback.commerce, source_message_id: "other" } }],
    ["stale_memory", { ...exactReadback, memory: { ...t10Memory, commerce_state_revision: t10State.revision - 1 } }],
    ["missing_superseded", { ...exactReadback, memory: { ...t10Memory, cancelled_or_superseded: [] } }],
    ["missing_current", { ...exactReadback, memory: { ...t10Memory, current_customer_facts: [] } }],
  ] as Array<[string, Parameters<typeof verifyCommittedRoomCorrectionMemory>[0]]>)) assert(!verifyCommittedRoomCorrectionMemory(readback), `memory_${label}_accepted`);
  const t10Metadata = {
    response_route: t10.route, commerce_reason: t10.reason,
    commerce_authority: t10.authority,
    commerce_state_revision: t10.revision,
    commerce_state_persist_result: t10.persist_result,
    commerce_state_persistence_classification: "COMMITTED",
  };
  const t10Snapshot = {
    conversation_id: "conversation", company_id: "company",
    source_message_id: t10Proof.source_message_id,
    source_message_content: t10Proof.source_text,
    commerce_state_revision: t10State.revision,
    commerce_state_source_message_id: t10Proof.source_message_id,
    state: t10State.state,
  };
  const t10B2 = (overrides: Record<string, unknown> = {}) =>
    evaluateB2BeforeCommit({
      proposed_response: t10.reply ?? "",
      persistence_kind: "ai_reply",
      snapshot: t10Snapshot, metadata: t10Metadata,
      trusted_correction_commit: t10Proof,
      ...overrides,
    });
  assert(t10B2().code === "B2_ALLOW_COMMITTED_SCOPED_CORRECTION", JSON.stringify(t10B2()));
  for (const [label, overrides] of [
    ["no_receipt", { trusted_correction_commit: null }],
    ["failed_commit", { metadata: { ...t10Metadata, commerce_state_persist_result: "rpc_transport_error" } }],
    ["stale_revision", { trusted_correction_commit: { ...t10Proof, committed_revision: t10Proof.previous_revision } }],
    ["replay", { trusted_correction_commit: { ...t10Proof, source_message_id: "another-turn" } }],
    ["tenant", { trusted_correction_commit: { ...t10Proof, company_id: "other-company" } }],
    ["scope", { trusted_correction_commit: { ...t10Proof, scope: "small_bedroom" } }],
    ["entity", { trusted_correction_commit: { ...t10Proof, entity_id: "refrigerator:unscoped" } }],
    ["text_only", { proposed_response: t10.reply ?? "", trusted_correction_commit: null }],
    ["order", { proposed_response: `${t10.reply} 訂單已確認。` }],
  ] as const) {
    const decision = t10B2(overrides);
    assert(decision.decision !== "allow", `${label}:${JSON.stringify(decision)}`);
  }
  const cancelledCorrectionState = structuredClone(t10State.state);
  cancelledCorrectionState.entities.find((entity) => entity.entity_id === t10Proof.entity_id)!.status = "cancelled";
  assert(t10B2({ snapshot: { ...t10Snapshot, state: cancelledCorrectionState } }).decision !== "allow", "cancelled_correction_accepted");
  const ambiguousCorrectionState = structuredClone(t10State.state);
  ambiguousCorrectionState.entities.push({
    ...structuredClone(ambiguousCorrectionState.entities.find((entity) => entity.entity_id === t10Proof.entity_id)!),
    entity_id: "air_conditioner:other",
  });
  assert(t10B2({ snapshot: { ...t10Snapshot, state: ambiguousCorrectionState } }).decision !== "allow", "ambiguous_correction_accepted");
  const failedCommit = await runCommerceStateRuntime({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () =>
        ({ data: { revision: t10State.revision, state: t10State.state }, error: null })
      }) }),
    }),
    rpc: async () => ({ data: null, error: { message: "simulated CAS failure" } }),
  }, {
    company_id: "company", conversation_id: "conversation",
    source_message_id: "failed-source", text: "大房唔係110呎，應該係120呎。",
    language: "zh-TW",
  });
  assert(failedCommit?.persist_result === "rpc_transport_error" &&
    !failedCommit.trusted_correction_commit &&
    t10State.state.entities.find((entity) => entity.entity_id === t10Proof.entity_id)
      ?.attributes.room_sizes &&
    !JSON.stringify(t10State.state).includes("120平方呎"), "failed_commit_created_proof");
  const staleOld = await runCommerceStateRuntime({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () =>
      ({ data: { revision: t10State.revision, state: t10State.state }, error: null })
    }) }) }),
    rpc: async (_fn, params) => ({ data: { result: "success", applied_revision: t10State.revision + 1 }, error: null }),
  }, {
    company_id: "company", conversation_id: "conversation",
    source_message_id: "wrong-old", text: "大房唔係99呎，應該係120呎。",
    language: "zh-TW",
  });
  assert(staleOld && !staleOld.trusted_correction_commit &&
    (t10State.state.entities.find((entity) => entity.entity_id === t10Proof.entity_id)
      ?.attributes.room_sizes as Record<string, string>).large_bedroom === "110平方呎",
    "wrong_old_value_promoted");
  console.log(`W20-T10|${t10.route}|${t10.reply}|revision=${t10State.revision}|B2=${t10B2().code}|negative=PASS`);
  const t11 = await ask("雪櫃暫時唔買，先取消。");
  const afterCancellation = f.snapshot().state;
  const refrigerator = afterCancellation.entities.find((entity) => entity.category === "refrigerator");
  const ac = afterCancellation.entities.find((entity) => entity.category === "air_conditioner");
  assert((refrigerator?.status === "cancelled" || refrigerator?.status === "deferred") && ac?.quantity === 3, JSON.stringify({ t11, refrigerator, ac }));

  const t12 = "而家我冷氣要求係點？";
  const allTurns = [...turns, t12];
  const memory = buildCanonicalConversationMemory({ conversation_id: "conversation", company_id: "company", source_message_id: "source-t12", commerce_state_revision: f.snapshot().revision, commerce_state: afterCancellation, newest_first: allTurns.slice().reverse().map((content, index) => ({ id: `history-${index}`, role: "visitor", content })), visitor_turn_count: allTurns.length, source_created_at: "2026-09-24T00:00:00.000Z", next_memory_revision: allTurns.length });
  const recall = prepareConversationRecall({ conversation_id: "conversation", company_id: "company", source_message_id: "source-t12", question: t12, memory, commerce: { conversation_id: "conversation", company_id: "company", source_message_id: "source-t11", revision: f.snapshot().revision, state: afterCancellation }, recent_questions: turns.slice().reverse() }, "zh-TW");
  assert(recall.decision.handled && recall.reply && ["80平方呎", "110平方呎", "180平方呎", "窗口", "西斜", "共三部", "CW-SUL70BA"].every((item) => recall.reply!.includes(item)) && !recall.reply.includes("100平方呎") && !recall.reply.includes("雪櫃") && !recall.reply.includes("refrigerator:unscoped"), JSON.stringify(recall));
  assert(afterCancellation.conversion.order_status === "none" && afterCancellation.conversion.payment_status === "none" && afterCancellation.conversion.quotation_status === "none" && afterCancellation.quotes.length === 0, "transaction_promoted");
  const kbContent = "工作表：商品設定_20260813 162932 ID: 7944 狀態: 開啟 商品型號: CW-SUL70BA 商品圖片: 39 成本: 3750 銷售價: 5680 特價: 4038 匹數 (多聯分體式): 29 品牌: PANASONIC 樂聲牌 附加項目: 否 新增日期: 46247 標籤: 32 描述: PANASONIC 樂聲 CW-SUL70BA 3/4匹Inverter LITE變頻式淨冷窗口機，採用香港專利左出風設計、R32製冷劑及四合一抗菌過濾網，製冷能力7,400BTU/h，設左右自動送風、睡眠模式及獨立抽濕，獲香港1級能源標籤，提供3年全機及5年壓縮機保用。 功能: 變頻 淨冷 匹數: 3/4匹 氣體: 36 風數: 42";
  const kbDoc: KBDocumentCandidate = {
    document_id: "fixture-cw", title: "PANASONIC 樂聲牌 CW-SUL70BA", source_type: "Product", document_score: 0.99,
    chunks: [{ document_id: "fixture-cw", chunk_id: "fixture-chunk", title: "CW-SUL70BA", content: kbContent, score: 0.99, chunk_type: "full_content", source_type: "Product", status: "published" }],
    citations: [], meta: { document_score: 0.99, highest_chunk_score: 0.99, second_highest_chunk_score: 0, returned_summary_count: 0, returned_full_content_count: 1, dropped_without_document_id: 0, dropped_without_content: 0 },
    llm_context: { selected_document_id: "fixture-cw", orientation_summary: null, full_content_evidence: [{ document_id: "fixture-cw", chunk_id: "fixture-chunk", content: kbContent, score: 0.99, source_type: "Product" }] },
  };
  const factualAnswer = (request: string, intent: ReturnType<typeof classifyNaturalCustomerIntent>, category: string | null, language: "zh-TW" | "en", documents: KBDocumentCandidate[]) => {
    const contract = productKbSemanticContract(intent, category, request);
    assert(contract, `missing_product_contract:${request}`);
    const target = deriveCurrentGroundingTarget(request, contract.query, contract.entity_ids, contract.topic_ids, true);
    const selection = selectCanonicalGrounding(documents, { requestText: contract.query, currentTurnText: request, minScore: 0.45, requirePublished: true, expectedTenantId: "34", expectedEntityIds: target.entity_ids, expectedTopicIds: target.topic_ids, requiresCurrentKb: true, targetChanged: true });
    return resolveCanonicalKbDirectAnswer({ request, selection, language });
  };
  assert(t9Result.kind === "resolved", "T9 referent missing");
  const t9Answer = factualAnswer(t9Result.grounded_question, t9Result.intent, t9Result.resolved_topic, "zh-TW", [kbDoc]);
  assert(t9Answer?.reply.includes("CW-SUL70BA") && t9Answer.reply.includes("3/4匹"), JSON.stringify(t9Answer));
  const t13 = "舊報價假設機價每部5600、安裝每部550、鋁架每單550，共2部，試算幾多？";
  const t13Plan = planConversationService({ question: t13, language: "zh-TW", recall: { handled: false, reason: "CURRENT_KB_REQUIRED" }, memory: null, commerce: afterCancellation, calculation_quantity: 2, calculation_terms: [
    { label: "機價", amount: 5600, currency: "HKD", charge_basis: "per_unit", source: "customer_message" },
    { label: "安裝", amount: 550, currency: "HKD", charge_basis: "per_unit", source: "customer_message" },
    { label: "鋁架", amount: 550, currency: "HKD", charge_basis: "per_order", source: "customer_message" },
  ] });
  assert(t13Plan.action === "historical_calculation" && t13Plan.calculation?.total === 12850 && t13Plan.calculation.historical_only, JSON.stringify(t13Plan)); turns.push(t13);
  const t14 = "CW-SUL70BA 開唔到機，點處理？";
  const t14Plan = planConversationService({ question: t14, language: "zh-TW", recall: { handled: false, reason: "NOT_A_RECALL_QUERY" }, memory: null, commerce: afterCancellation });
  const t14Reply = renderServicePlanReply(t14Plan, null) ?? "";
  assert(t14Plan.issue_kind === "product_operation_failure" && /燈號|錯誤提示/.test(t14Reply) && productKbSemanticContract(classifyNaturalCustomerIntent(t14), null, t14) === null, JSON.stringify(t14Plan)); turns.push(t14);
  const t15 = "NONEXISTENT-999999 有咩功能？";
  const t15Intent = classifyNaturalCustomerIntent(t15);
  const t15Reply = renderNaturalNoCurrentEvidence(t15Intent, "zh-TW") ?? "";
  assert(factualAnswer(t15, t15Intent, null, "zh-TW", []) === null && t15Reply.includes("NONEXISTENT-999999") && !/請提供型號/.test(t15Reply), t15Reply); turns.push(t15);
  const t16 = "Is CW-SUL70BA suitable for an 80 sq ft bedroom, and what is its horsepower?";
  const t16Answer = factualAnswer(t16, classifyNaturalCustomerIntent(t16), null, "en", [kbDoc]);
  assert(t16Answer?.reply.includes("PANASONIC CW-SUL70BA") && t16Answer.reply.includes("3/4 HP") && /does not directly state a suitable room area/.test(t16Answer.reply) && !t16Answer.reply.includes("樂聲"), JSON.stringify(t16Answer)); turns.push(t16);
  assert(f.snapshot().state.conversion.order_status === "none" && f.snapshot().state.conversion.payment_status === "none" && f.snapshot().state.conversion.quotation_status === "none", "false_transaction");
  console.log(`W19-T9|canonical_kb_direct_answer|${t9Answer?.reply}`);
  console.log(`W19-T13|${t13Plan.action}|${t13Plan.calculation?.total}|historical_only`);
  console.log(`W19-T14|${t14Plan.issue_kind}|${t14Reply}`);
  console.log(`W19-T15|kb_no_current_evidence|${t15Reply}`);
  console.log(`W19-T16|canonical_kb_direct_answer|${t16Answer?.reply}`);
  console.log(`W17-T1|${t1.route}|${t1.reply}`); console.log(`W17-T2|${t2.route}|${t2.reply}`); console.log(`W17-T3|${t3.route}|${t3.reply}`); console.log(`W17-T4|${t4.route}|${t4.reply}`); console.log(`W17-T5|${t5.route}|${t5.reply}`); console.log("W17-T6|CURRENT_KB_REQUIRED|features+horsepower+suitability"); console.log("W17-T7|CURRENT_KB_REQUIRED|price:CW-SUL70BA"); console.log(`W17-T8|${t8.route}|${t8.reply}`); console.log("W17-T9|CURRENT_KB_REQUIRED|CW-SUL70BA|horsepower+model_info"); console.log(`W17-T10|${t10.route}|${t10.reply}`); console.log(`W17-T11|${t11.route}|${t11.reply}`); console.log(`W17-T12|${recall.metadata.response_route}|${recall.reply}`);
});

Deno.test("W17 trusted topic restoration fails closed on entity, topic, history, and activity drift", () => {
  const base = createEmptyConversationCommerceState();
  base.entities.push({ entity_id: "air_conditioner:unscoped", category: "air_conditioner", quantity: 3, status: "researching", attributes: {}, constraints: {}, provenance: { source_type: "customer" } });
  const input = { conversation_id: "conversation", company_id: "company", source_message_id: "source", text: "講返頭先嗰部冷氣，佢係幾多匹？", language: "zh-TW" as const, history: [{ role: "visitor", content: "我研究緊 CW-SUL70BA 冷氣。" }], trusted_product_topic_focus: { topic: "air_conditioner", product: "CW-SUL70BA", resolution_strategy: "PER_TOPIC_REFERENT_HISTORY" as const } };
  assert(validateTrustedProductTopicFocus(input, base).valid, "valid_focus_rejected");
  assert(!validateTrustedProductTopicFocus({ ...input, text: "講返雪櫃，佢幾多匹？" }, base).valid, "cross_entity_topic_accepted");
  assert(!validateTrustedProductTopicFocus({ ...input, history: [] }, base).valid, "missing_history_accepted");
  const competing = structuredClone(base); competing.entities.push({ ...competing.entities[0], entity_id: "air_conditioner:bedroom_1" });
  assert(!validateTrustedProductTopicFocus(input, competing).valid, "competing_active_entity_accepted");
  const cancelled = structuredClone(base); cancelled.entities[0].status = "cancelled";
  assert(!validateTrustedProductTopicFocus(input, cancelled).valid, "cancelled_entity_revived");
});

Deno.test("W13 journey authorization fails closed across tenant, revision, entity, replay and transaction drift", async () => {
  const f = fixture();
  const t1 = "Hello，屋企想換冷氣，兩間睡房加個客廳，應該點揀好？";
  const t2 = "細房大概80呎，大房100呎，個廳就180呎。";
  await f.ask(t1);
  const outcome = await f.ask(t2, [t1]);
  const current = f.snapshot();
  const proof = outcome.trusted_journey_progress;
  assert(proof?.update_kind === "customer_goal", JSON.stringify(proof));
  const metadata = {
    response_route: outcome.route,
    commerce_reason: outcome.reason,
    commerce_authority: outcome.authority,
    commerce_state_revision: outcome.revision,
    commerce_state_persist_result: outcome.persist_result,
    commerce_state_persistence_classification: "COMMITTED",
    contextual_decision: null,
  };
  const snapshot = {
    conversation_id: "conversation",
    company_id: "company",
    source_message_id: "source-2",
    source_message_content: t2,
    commerce_state_revision: current.revision,
    commerce_state_source_message_id: "source-2",
    state: current.state,
  };
  const evaluate = (overrides: Record<string, unknown> = {}) =>
    evaluateB2BeforeCommit({
      proposed_response: outcome.reply ?? "",
      persistence_kind: "ai_reply",
      snapshot,
      metadata,
      trusted_journey_progress: proof,
      ...overrides,
    });

  assert(
    evaluate().code === "B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE",
    "valid_proof_rejected",
  );
  const blockedWithoutReceipt = evaluate({ trusted_journey_progress: null });
  assert(
    blockedWithoutReceipt.decision === "block" &&
      blockedWithoutReceipt.code === "KNOWN_CONTEXT_RECONFIRMATION",
    JSON.stringify(blockedWithoutReceipt),
  );
  const repeatedSizes = evaluate({
    proposed_response: "請再確認細房、大房同客廳嘅房間面積？",
    trusted_journey_progress: null,
  });
  assert(
    repeatedSizes.code === "KNOWN_CONTEXT_RECONFIRMATION",
    JSON.stringify(repeatedSizes),
  );
  const repeatedProduct = evaluate({
    proposed_response: "你講緊邊種產品類型？",
    trusted_journey_progress: null,
  });
  assert(
    repeatedProduct.code === "KNOWN_CONTEXT_RECONFIRMATION",
    JSON.stringify(repeatedProduct),
  );

  for (
    const [label, tampered] of [
      ["tenant", { ...proof, company_id: "another-company" }],
      ["revision", {
        ...proof,
        committed_revision: proof.committed_revision + 1,
      }],
      ["entity", {
        ...proof,
        entity_id: "refrigerator:unscoped",
        category: "refrigerator",
      }],
      ["replay", { ...proof, source_message_id: "source-from-another-turn" }],
      ["source_text", { ...proof, source_text: "another customer turn" }],
    ] as const
  ) {
    const verdict = evaluate({ trusted_journey_progress: tampered });
    assert(verdict.decision !== "allow", `${label}:${JSON.stringify(verdict)}`);
  }

  const staleState = structuredClone(current.state);
  staleState.latest_corrections = ["大房唔係100呎而係110呎"];
  const stale = evaluate({
    proposed_response: "大房而家係100呎。",
    snapshot: { ...snapshot, state: staleState },
    trusted_journey_progress: null,
  });
  assert(stale.code === "SUPERSEDED_VALUE_REUSED", JSON.stringify(stale));

  const cancelledState = structuredClone(current.state);
  cancelledState.entities[0].status = "cancelled";
  const cancelled = evaluate({
    snapshot: { ...snapshot, state: cancelledState },
  });
  assert(cancelled.decision !== "allow", JSON.stringify(cancelled));

  const fakeNextStep = evaluate({
    proposed_response: "下一步請再確認房間面積？",
    trusted_journey_progress: null,
  });
  assert(
    fakeNextStep.code === "KNOWN_CONTEXT_RECONFIRMATION",
    JSON.stringify(fakeNextStep),
  );
  const falseTransaction = evaluate({
    proposed_response: "資料已記低，訂單已確認。下一步請確認安裝方式？",
  });
  assert(
    falseTransaction.code === "ORDER_CONFIRMATION_NOT_PROVEN",
    JSON.stringify(falseTransaction),
  );
  console.log(
    "W13-NEGATIVE|known_reask=BLOCK|product_reask=BLOCK|commit_failure=BLOCK|stale=BLOCK|cancelled=BLOCK|cross_entity=BLOCK|tenant_revision_replay=BLOCK|transaction=BLOCK",
  );
});

Deno.test("W11 entity switch, room correction and cancellation stay scoped", async () => {
  const f = fixture();
  const ac = "屋企想換冷氣，兩間睡房加個客廳，應該點揀？";
  await f.ask(ac);
  await f.ask("細房80呎，大房100呎，客廳180呎。", [ac]);
  await f.ask("全部都有窗口位，而家都係窗口機。", [
    "細房80呎，大房100呎，客廳180呎。",
    ac,
  ]);
  await f.ask("客廳下晝西斜。", [
    "全部都有窗口位，而家都係窗口機。",
    "細房80呎，大房100呎，客廳180呎。",
    ac,
  ]);

  const fridge = await f.ask("另外雪櫃我想睇下，擺位闊度唔超過595mm。", [
    "客廳下晝西斜。",
    ac,
  ]);
  assert(fridge.route === "product_guidance", JSON.stringify(fridge));
  const switched = f.snapshot().state;
  assert(
    switched.current_topic === "refrigerator" &&
      switched.entities.filter((entity) =>
          entity.status !== "cancelled" && entity.status !== "deferred"
        ).length === 2,
    JSON.stringify(switched.entities),
  );

  const beforeAmbiguous = JSON.stringify(f.snapshot());
  const ambiguous = await f.ask("房各一部", [
    "另外雪櫃我想睇下，擺位闊度唔超過595mm。",
    ac,
  ]);
  assert(
    ambiguous.reason === "contextual_targeted_clarification" &&
      ambiguous.persist_result === "read_only",
    JSON.stringify(ambiguous),
  );
  assert(
    JSON.stringify(f.snapshot()) === beforeAmbiguous,
    "fridge_inherited_ac_quantity",
  );

  const corrected = await f.ask("返返冷氣，更正大房係110呎，唔係100呎。", [
    "另外雪櫃我想睇下，擺位闊度唔超過595mm。",
    ac,
  ]);
  assert(corrected.route === "product_guidance", JSON.stringify(corrected));
  assert(
    f.snapshot().state.latest_corrections.at(-1)?.includes("110呎"),
    JSON.stringify(f.snapshot().state.latest_corrections),
  );

  await f.ask("雪櫃暫時唔買，先取消。", [
    "返返冷氣，更正大房係110呎，唔係100呎。",
    ac,
  ]);
  const cancelled = f.snapshot().state.entities.find((entity) =>
    entity.category === "refrigerator"
  );
  assert(
    cancelled?.status === "cancelled" || cancelled?.status === "deferred",
    JSON.stringify(cancelled),
  );
  await f.ask("冷氣繼續按頭先要求處理。", ["雪櫃暫時唔買，先取消。", ac]);
  const after = f.snapshot().state.entities.find((entity) =>
    entity.category === "refrigerator"
  );
  assert(after?.status === cancelled.status, "cancelled_entity_revived");
});

Deno.test("W9 fresh and incompatible quantity references remain targeted and read-only", async () => {
  const fresh = fixture();
  const freshBefore = JSON.stringify(fresh.snapshot());
  const freshReply = await fresh.ask("客廳一部，兩間房每間各一部");
  assert(
    freshReply.reason === "contextual_targeted_clarification" &&
      freshReply.persist_result === "read_only",
    JSON.stringify(freshReply),
  );
  assert(
    JSON.stringify(fresh.snapshot()) === freshBefore,
    "fresh_context_mutated",
  );

  const refrigerator = fixture(stateWith(["refrigerator"]));
  const fridgeBefore = JSON.stringify(refrigerator.snapshot());
  const incompatible = await refrigerator.ask("客廳一部，兩間房每間各一部", [
    introduction,
  ]);
  assert(
    incompatible.reason === "contextual_targeted_clarification",
    JSON.stringify(incompatible),
  );
  assert(
    JSON.stringify(refrigerator.snapshot()) === fridgeBefore,
    "incompatible_context_inherited",
  );
});

Deno.test("live runtime read-only recall preserves state and source provenance", async () => {
  const f = fixture();
  await f.ask(introduction);
  await f.ask("係廳一部，房各一部", [introduction]);
  const before = JSON.stringify(f.snapshot());
  const reply = await f.ask("我而家要幾多部冷氣？", [
    introduction,
    "係廳一部，房各一部",
  ]);
  assert(/3|三/.test(reply.reply ?? ""), JSON.stringify(reply));
  assert(JSON.stringify(f.snapshot()) === before, "read_only_mutated_state");
});

Deno.test("live runtime cannot inherit AC allocation into refrigerator context", async () => {
  const f = fixture(stateWith(["refrigerator"]));
  const before = JSON.stringify(f.snapshot());
  const reply = await f.ask("係廳一部，房各一部", [introduction]);
  assert(
    reply.reason === "contextual_targeted_clarification",
    JSON.stringify(reply),
  );
  assert(JSON.stringify(f.snapshot()) === before, "cross_entity_mutation");
});
