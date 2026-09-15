import {
  buildC2HandoffPackage,
  decideTransactionClosure,
  renderC2HandoffSummary,
  validateC2CommitSnapshot,
} from "./transaction-closure-handoff.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { deriveHandoffDecisionInput, evaluateHandoffDecision } from "./handoff-decision.ts";
import { isHumanControlState } from "./conversation-intelligence.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const IDS = {
  conversation:"11111111-1111-4111-8111-111111111111",
  company:"22222222-2222-4222-8222-222222222222",
  source:"33333333-3333-4333-8333-333333333333",
};

Deno.test("C2 integration explicit handoff package takeover suppression and return", () => {
  const decision = evaluateHandoffDecision(deriveHandoffDecisionInput(
    [{role:"visitor",content:"I want a human agent"}],
    "I want a human agent",
    [],
    {explicit_human_request:true},
  ));
  assert(decision.handoff_mode !== "normal_ai_continue", "deterministic R1 not consumed");
  const commerce=createEmptyConversationCommerceState();
  commerce.current_intent="confirm quotation";
  commerce.entities.push({entity_id:"ac-2",category:"aircon",model:"PRO",quantity:2,status:"confirmed",attributes:{},constraints:{},provenance:{source_type:"customer",source_message_id:IDS.source}});
  commerce.latest_corrections=["quantity 3 → 2"];
  const freshness=validateC2CommitSnapshot(
    {conversation_id:IDS.conversation,company_id:IDS.company,source_message_id:IDS.source,commerce_state_revision:4},
    {conversation_id:IDS.conversation,company_id:IDS.company,latest_source_message_id:IDS.source,commerce_state_revision:4,handoff_authority_valid:true},
  );
  assert(freshness.ok,"fresh package rejected");
  const pkg=buildC2HandoffPackage({
    conversation_id:IDS.conversation,company_id:IDS.company,source_message_id:IDS.source,
    handoff_reason:"Customer requested human support",handoff_authority:"R1",
    commerce_state_revision:4,commerce_state:commerce,current_customer_goal:"confirm quotation",
    generated_at:"2026-09-14T00:00:00Z",
  });
  assert(pkg.active_entities.length===1&&pkg.active_entities[0].quantity===2,"current facts wrong");
  assert(renderC2HandoffSummary(pkg).includes("quantity 2"),"human projection wrong");
  assert(isHumanControlState("pending","44444444-4444-4444-8444-444444444444"),"AI not suppressed after takeover");
  assert(!isHumanControlState("open",null),"explicit return did not resume AI");
});

Deno.test("C2 integration normal closure is idempotently resolvable", () => {
  const commerce=createEmptyConversationCommerceState();
  const first=decideTransactionClosure({utterance_kind:"positive_no_more_help",commerce_state:commerce});
  const repeated=decideTransactionClosure({utterance_kind:"positive_no_more_help",commerce_state:commerce});
  assert(first.may_resolve&&repeated.may_resolve&&first.state==="RESOLVED","closure not stable");
});

Deno.test("C2 integration pending transaction cannot close", () => {
  const commerce=createEmptyConversationCommerceState();
  commerce.conversion.order_status="pending_confirmation";
  commerce.conversion.payment_status="pending_payment";
  const result=decideTransactionClosure({utterance_kind:"no_more_help",commerce_state:commerce});
  assert(!result.may_resolve&&result.blockers.includes("order_pending")&&result.blockers.includes("payment_pending"),"pending truth lost");
});

Deno.test("C2 integration repeated trigger has stable source-bound package", () => {
  const commerce=createEmptyConversationCommerceState();
  const input={
    conversation_id:IDS.conversation,company_id:IDS.company,source_message_id:IDS.source,
    handoff_reason:"Safety confirmation",handoff_authority:"E1",commerce_state_revision:8,
    commerce_state:commerce,current_customer_goal:"confirm site safety",generated_at:"2026-09-14T00:00:00Z",
  };
  const a=buildC2HandoffPackage(input),b=buildC2HandoffPackage(input);
  assert(JSON.stringify(a)===JSON.stringify(b),"package not deterministic");
});

Deno.test("C2 integration stale retry fails then fresh retry succeeds", () => {
  const stale=validateC2CommitSnapshot(
    {conversation_id:IDS.conversation,company_id:IDS.company,source_message_id:IDS.source,commerce_state_revision:1},
    {conversation_id:IDS.conversation,company_id:IDS.company,latest_source_message_id:"new",commerce_state_revision:2,handoff_authority_valid:true},
  );
  const fresh=validateC2CommitSnapshot(
    {conversation_id:IDS.conversation,company_id:IDS.company,source_message_id:"new",commerce_state_revision:2},
    {conversation_id:IDS.conversation,company_id:IDS.company,latest_source_message_id:"new",commerce_state_revision:2,handoff_authority_valid:true},
  );
  assert(!stale.ok&&fresh.ok,"retry contract invalid");
});

Deno.test("C2 reconciles additively with authoritative agent-assist v34", async () => {
  const source=await Deno.readTextFile(
    new URL("../agent-assist/index.ts",import.meta.url),
  );
  for(const marker of [
    "resolveConversationScope",
    "applyCompanyScope",
    "fetchKBRag",
    "selectCanonicalGrounding",
    "buildCanonicalAssistRetrievalQuery",
    "buildWarmHandoffPackage",
    "callAssistModel",
    '"translate"',
    '"grammar"',
    '"suggest_reply"',
    '"knowledge_helper"',
    '"check_policy"',
    '"handoff_context"',
  ])assert(source.includes(marker),`agent-assist v34 behavior missing: ${marker}`);
  const canonical=source.indexOf("parsePersistedC2Handoff(persistedEvent?.ai_summary)");
  const fallback=source.indexOf('buildWarmHandoffPackage(history,"takeover")');
  assert(canonical>=0&&fallback>canonical,
    "persisted C2 truth must outrank derived warm-handoff presentation");
  assert(source.includes("persisted.structured_package.company_id===conv.company_id"),
    "persisted C2 tenant binding missing");
});
