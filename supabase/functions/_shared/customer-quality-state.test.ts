/** Component projections only. Full-chain acceptance uses c3_actual_handler_runtime.mjs. */
import { buildCanonicalConversationMemory } from "./conversation-long-memory.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { classifySocialTurn } from "./natural-customer-response.ts";
import { deriveTypedCustomerCalculation } from "./conversation-service-runtime.ts";
import { deriveTypedCustomerMoneyFacts } from "./customer-money-facts.ts";
const eq=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(JSON.stringify({a,b}));};
const build=(rows:Array<{id:string,role:string,content:string,metadata?:Record<string,unknown>}>)=>buildCanonicalConversationMemory({conversation_id:"conversation",company_id:"tenant",source_message_id:rows[0].id,commerce_state_revision:0,commerce_state:createEmptyConversationCommerceState(),newest_first:rows,visitor_turn_count:1,source_created_at:"2026-09-30T00:00:00Z",next_memory_revision:1});
Deno.test("COMPONENT: social-only history cannot become a business goal, topic or queue",()=>{
  for(const content of ["你好","你好，可以幫我嗎？","早晨，可唔可以幫我？","Hi","Hello, could you help me please?","Thanks","明白","OK"]){const m=build([{id:"social",role:"visitor",content}]);eq(m.current_goal,null);eq(m.current_topic,null);eq(m.open_questions,[]);}
  for(const text of ["你好，我想查訂單","Hi, I need help choosing an AC","你好，我想轉真人"])eq(classifySocialTurn(text),null);
});
Deno.test("COMPONENT: delivered grounded/unknown/calculation/recap answers close source-bound items",()=>{
  for(const response_route of ["canonical_kb_direct_answer","kb_no_current_evidence","c3_historical_conditional_calculation","canonical_memory_recall"]){
    const m=build([{id:"answer",role:"assistant",content:"The available answer.",metadata:{response_route,control_commit:"ai",source_message_id:"question"}},{id:"question",role:"visitor",content:"What is known?"}]);eq(m.open_questions,[]);eq(m.question_lifecycle?.[0].resolution_source_message_id,"answer");eq(m.question_lifecycle?.[0].status,"resolved");
  }
});
Deno.test("COMPONENT: explicit clarification remains open; transcript alone cannot claim closure",()=>{
  const m=build([{id:"answer",role:"assistant",content:"What height and depth can fit?",metadata:{response_route:"product_guidance",control_commit:"ai",source_message_id:"question"}},{id:"question",role:"visitor",content:"I need help choosing a refrigerator"}]);eq(m.question_lifecycle?.[0].status,"pending");eq(m.open_questions,["What height and depth can fit?"]);
});
Deno.test("COMPONENT: all typed money roles/bases remain historical and source-bound",()=>{
  const m=build([{id:"money",role:"visitor",content:"之前機價 HK$6,247，送貨 HK$385。"}]);eq(m.historical_facts.map(f=>[(f.value as Record<string,unknown>).amount,(f.value as Record<string,unknown>).semantic_role,(f.value as Record<string,unknown>).charge_basis,f.source_message_id,(f.value as Record<string,unknown>).reusable_as_current]),[[6247,"unit_price","unspecified","money",false],[385,"delivery","unspecified","money",false]]);
  const total=deriveTypedCustomerMoneyFacts("之前兩部合共 HK$6,193.50。").facts[0];eq([total.charge_basis,total.quantity],["total",2]);
  const c=deriveTypedCustomerCalculation({question:"用返頭先個送貨費，加兩部每部 HK$4,111，合共幾多？",current_source_message_id:"next",recent_messages:[{id:"money",role:"visitor",content:"之前機價 HK$6,247，送貨 HK$385。"}]});eq(c.result,8607);eq(c.terms.map(f=>f.source_message_id),["next","money"]);
  eq(deriveTypedCustomerMoneyFacts("HKD 17 and HKD 28 delivery").facts.map(f=>f.role),["amount","amount"]);
  eq(deriveTypedCustomerCalculation({question:"假設每部 HK$10.01，三部加整單 HK$0，試算幾多？"}).result,30.03);
});
