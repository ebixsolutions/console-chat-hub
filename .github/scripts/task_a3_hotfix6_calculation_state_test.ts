import {
  buildCommerceEntityHints,
  detectAdditiveEntityCreationSignal,
  extractCommerceCalculationTerms,
  reduceTurn,
} from "../../supabase/functions/_shared/commerce-state-runtime.ts";
import { createEmptyConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { calculateCommerceTerms } from "../../supabase/functions/_shared/commerce-state-authority.ts";

const company = "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493";
const conversation = "22222222-2222-4222-8222-222222222222";

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function apply(state: ReturnType<typeof createEmptyConversationCommerceState>, text: string, id: string) {
  const hints = buildCommerceEntityHints([text]);
  return reduceTurn(state, {
    conversation_id: conversation,
    company_id: company,
    source_message_id: id,
    text,
    language: "zh-TW",
  }, hints);
}

assert(detectAdditiveEntityCreationSignal("另外加1部冷氣。"), "explicit additive must remain true");
assert(!detectAdditiveEntityCreationSignal("另外每部材料費$550。"), "fee conjunction must not be additive");

let state = apply(createEmptyConversationCommerceState(), "我要3部冷氣。", "22222222-2222-4222-8222-222222222201");
assert(state.entities.length === 1 && state.entities[0].quantity === 3, "initial x3 failed");
state = apply(state, "更正，唔係3部，係2部。", "22222222-2222-4222-8222-222222222202");
assert(state.entities[0].quantity === 2, "correction x3 to x2 regressed");
const provenanceBeforeCalculation = state.entities[0].provenance.source_message_id;
const quotesBeforeCalculation = JSON.stringify(state.quotes);

const calculationText = "每部冷氣$5,600，安裝每部$550，另外每部材料費$550，2部總共幾錢？";
const terms = extractCommerceCalculationTerms([calculationText], state);
assert(terms.terms.length === 3, `expected 3 calculation terms, got ${terms.terms.length}`);
assert(terms.terms.map((term) => term.value).join(",") === "5600,550,550", "current-turn terms are wrong");
assert(terms.terms.every((term) => term.multiplier === 2), "explicit current-turn x2 must win as multiplier");
const calculation = calculateCommerceTerms(terms.terms, terms.currency);
assert(calculation?.result === 13400, `expected 13400, got ${calculation?.result}`);

const afterCalculation = apply(state, calculationText, "22222222-2222-4222-8222-222222222203");
assert(afterCalculation.entities[0].quantity === 2, "calculation turn mutated quantity");
assert(afterCalculation.entities[0].provenance.source_message_id === provenanceBeforeCalculation, "calculation turn rewrote entity provenance");
assert(JSON.stringify(afterCalculation.quotes) === quotesBeforeCalculation, "calculation turn mutated quotes");

const additive = apply(afterCalculation, "另外加1部冷氣。", "22222222-2222-4222-8222-222222222204");
const scoped = additive.entities.find((entity) => entity.entity_id === "air_conditioner:unscoped");
assert(scoped?.quantity === 3, `explicit additive after x2 must yield x3, got ${scoped?.quantity}`);

console.log(JSON.stringify({
  status: "PASS",
  gate: "TASK_A3_HOTFIX6_CALCULATION_STATE",
  assertions: {
    fee_conjunction_not_additive: true,
    correction_3_to_2_preserved: true,
    current_turn_terms_only: true,
    explicit_multiplier_2: true,
    deterministic_total_13400: true,
    calculation_state_read_only: true,
    provenance_preserved: true,
    explicit_additive_preserved: true
  }
}));
