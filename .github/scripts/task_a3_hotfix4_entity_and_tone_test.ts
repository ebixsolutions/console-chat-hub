import { createEmptyConversationCommerceState, type ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { buildCommerceEntityHints, reduceTurn } from "../../supabase/functions/_shared/commerce-state-runtime.ts";

const company = "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493";
const conversation = "11111111-1111-4111-8111-111111111111";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function apply(
  state: ConversationCommerceState,
  text: string,
  id: string,
  history: string[] = [],
): ConversationCommerceState {
  const hints = buildCommerceEntityHints([text, ...history]);

  return reduceTurn(
    state,
    {
      conversation_id: conversation,
      company_id: company,
      source_message_id: id,
      text,
      language: "zh-TW",
      history: history.map((content) => ({ role: "visitor", content })),
    },
    hints,
  );
}

function entity(state: ConversationCommerceState, id: string) {
  return state.entities.find((item) => item.entity_id === id);
}

const t1 = "我睡房有2部冷氣。";
const t2 = "窗口夠唔夠安全安裝冷氣？";
const t3 = "另外加1部冷氣。";

const s0 = createEmptyConversationCommerceState();

const s1 = apply(s0, t1, "11111111-1111-4111-8111-111111111101");
assert(entity(s1, "air_conditioner:bedroom")?.quantity === 2, "turn1 bedroom must be x2");
assert(!entity(s1, "air_conditioner:unscoped"), "turn1 must not create unscoped");

const bedroomP1 = entity(s1, "air_conditioner:bedroom")?.provenance.source_message_id;

const s2 = apply(s1, t2, "11111111-1111-4111-8111-111111111102", [t1]);
assert(entity(s2, "air_conditioner:bedroom")?.quantity === 2, "safety turn must preserve bedroom x2");
assert(!entity(s2, "air_conditioner:unscoped"), "safety turn must create zero ghost entities");
assert(
  entity(s2, "air_conditioner:bedroom")?.provenance.source_message_id === bedroomP1,
  "safety turn must not rewrite bedroom provenance",
);

const s3 = apply(s2, t3, "11111111-1111-4111-8111-111111111103", [t2, t1]);
assert(entity(s3, "air_conditioner:bedroom")?.quantity === 2, "additive turn must preserve bedroom x2");
assert(entity(s3, "air_conditioner:unscoped")?.quantity === 1, "additive turn must add exactly one new item");

const s4 = apply(s1, "睡房再加1部冷氣。", "11111111-1111-4111-8111-111111111104", [t1]);
assert(entity(s4, "air_conditioner:bedroom")?.quantity === 3, "scoped additive must increment x2 to x3");
assert(!entity(s4, "air_conditioner:unscoped"), "scoped additive must not create unscoped");

const source = await Deno.readTextFile("supabase/functions/_shared/commerce-state-runtime.ts");

assert(!source.includes("隔住screen估"), "rude zh-TW wording remains");
assert(!source.includes("我不会在线上猜"), "rude zh-CN wording remains");
assert(!source.includes("I won't guess that remotely"), "rude English wording remains");

console.log(JSON.stringify({
  status: "PASS",
  gate: "TASK_A3_HOTFIX4_ENTITY_AND_TONE",
  cases: 6
}));
