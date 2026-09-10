// Task A3 production hotfix #3: category-only mentions must not create ghost unscoped entities.
import {
  createEmptyConversationCommerceState,
  type ConversationCommerceState,
} from "../../supabase/functions/_shared/commerce-state-contract.ts";
import {
  buildCommerceEntityHints,
  detectExplicitEntityCreationSignal,
  filterGhostUnscopedHints,
  runCommerceStateReduction,
} from "../../supabase/functions/_shared/commerce-state-runtime.ts";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message: string): void {
  assert(actual === expected, `${message} (expected ${expected}, got ${actual})`);
}

function bedroomAirconTwo(): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.entities.push({
    entity_id: "air_conditioner:bedroom",
    category: "air_conditioner",
    quantity: 2,
    status: "tentative",
    attributes: {},
    constraints: {},
    provenance: { source_type: "customer" },
  });
  return state;
}

function applyTurn(text: string, previous: ConversationCommerceState): ConversationCommerceState {
  const hints = buildCommerceEntityHints(["睡房要2部冷氣", text]);
  return runCommerceStateReduction(previous, {
    text,
    source_message_id: "m-ghost",
    occurred_at: null,
    language: "zh-TW",
  }, hints);
}

const SAFETY_QUESTION = "我屋企個窗口夠唔夠安全安裝冷氣？";
const KB_QUESTION = "冷氣一般用幾多電？";

Deno.test("safety question with generic 冷氣 does not create air_conditioner:unscoped", () => {
  const state = applyTurn(SAFETY_QUESTION, bedroomAirconTwo());
  assertEquals(state.entities.length, 1, "entity count");
  assertEquals(state.entities[0]?.entity_id, "air_conditioner:bedroom", "entity id");
  assertEquals(state.entities[0]?.quantity, 2, "quantity preserved");
});

Deno.test("generic factual KB question does not create ghost unscoped entity", () => {
  const state = applyTurn(KB_QUESTION, bedroomAirconTwo());
  assertEquals(state.entities.length, 1, "entity count");
  assert(
    !state.entities.some((e) => e.entity_id === "air_conditioner:unscoped"),
    "no ghost unscoped entity",
  );
});

Deno.test("explicit 另外加1部冷氣 still creates a legitimate new entity", () => {
  assertEquals(detectExplicitEntityCreationSignal("另外加1部冷氣"), true, "creation signal");
  const state = applyTurn("另外加1部冷氣", bedroomAirconTwo());
  assert(
    state.entities.some((e) => e.entity_id === "air_conditioner:unscoped"),
    "explicit add creates unscoped entity",
  );
  assertEquals(
    state.entities.find((e) => e.entity_id === "air_conditioner:bedroom")?.quantity,
    2,
    "existing bedroom quantity untouched",
  );
});

Deno.test("hint filter keeps room-scoped and already-existing unscoped hints", () => {
  const state = bedroomAirconTwo();
  state.entities.push({
    entity_id: "air_conditioner:unscoped",
    category: "air_conditioner",
    quantity: 1,
    status: "tentative",
    attributes: {},
    constraints: {},
    provenance: { source_type: "customer" },
  });
  const hints = buildCommerceEntityHints(["睡房冷氣", SAFETY_QUESTION]);
  const kept = filterGhostUnscopedHints(SAFETY_QUESTION, state, hints);
  assert(kept.some((h) => h.entity_id === "air_conditioner:bedroom"), "room-scoped kept");
  assert(kept.some((h) => h.entity_id === "air_conditioner:unscoped"), "existing unscoped kept");
});

Deno.test("safety question does not confirm any order", () => {
  const state = applyTurn(SAFETY_QUESTION, bedroomAirconTwo());
  assert(state.conversion.order_status !== "confirmed", "order_status");
});
