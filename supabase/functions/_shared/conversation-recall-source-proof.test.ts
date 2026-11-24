import {createEmptyConversationCommerceState} from "./commerce-state-contract.ts";
import {reduceTurn,runCommerceStateRuntime,type CommerceStateDbClient} from "./commerce-state-runtime.ts";
import {buildCanonicalConversationMemory} from "./conversation-long-memory.ts";
import {prepareConversationRecall,retainedRecapTargets,type ConversationRecallInput} from "./conversation-recall.ts";

function assert(value:unknown,message="assertion failed"):asserts value {if(!value)throw Error(message);}
const identity={company_id:"recap-company",conversation_id:"recap-ticket"};
function returnedResearch(){
 const state=createEmptyConversationCommerceState();
 state.entities=[{entity_id:"generic:workshop",category:"workshop_pack",quantity:2,status:"researching",
  attributes:{},constraints:{},provenance:{source_type:"customer",source_message_id:"initial-source"}}];
 const input={...identity,source_message_id:"literal-return-source",text:"Back to that WP, what model was I researching?",language:"en" as const,
  history:[{id:"original-product-source",role:"visitor",content:"Tell me about ZX-731 workshop pack."}],
  trusted_product_topic_focus:{topic:"workshop_pack",product:"ZX-731",resolution_strategy:"PER_TOPIC_REFERENT_HISTORY" as const}};
 const current=reduceTurn(state,input,[]);
 const memory=buildCanonicalConversationMemory({...identity,source_message_id:input.source_message_id,commerce_state_revision:2,
  commerce_state:current,newest_first:[],visitor_turn_count:1,source_created_at:"2026-11-24T00:00:00Z",next_memory_revision:1});
 const recall:ConversationRecallInput={...identity,source_message_id:"later-recap",question:"What are my WP requirements?",memory,
  commerce:{...identity,source_message_id:input.source_message_id,revision:2,state:current}};
 return {initial:state,input,recall};
}

Deno.test("Task3C recap literal alias comes from accepted current source, never category initials",()=>{
 const {initial,input,recall}=returnedResearch(),state=recall.commerce!.state;
 assert(!retainedRecapTargets(initial).includes("WP"),"category created an unwritten acronym");
 const aliases=state.entities[0].attributes.source_owned_recap_aliases as Record<string,unknown>[];
 assert(aliases.length===1&&aliases[0].alias==="WP"&&aliases[0].source_quote===input.text);
 assert(aliases[0].source_message_id===input.source_message_id&&aliases[0].company_id===identity.company_id&&aliases[0].conversation_id===identity.conversation_id);
 assert(state.entities[0].attributes.customer_subject_aliases===undefined,"read-only proof leaked into general mutation aliases");
 const before=JSON.stringify(recall),result=prepareConversationRecall(recall,"en");
 assert(result.decision.handled&&result.reply?.includes("ZX-731"),JSON.stringify(result));
 assert(JSON.stringify(recall)===before,"read-only recap wrote state");
 assert(!result.reply?.includes("source_owned_recap_aliases")&&!result.reply?.includes("source-owned-recap-alias-v1"),"internal receipt leaked to customer");
 const replay=reduceTurn(state,input,[]),replayed=replay.entities[0].attributes.source_owned_recap_aliases as unknown[];
 assert(replayed.length===1,"same-source replay duplicated alias receipt");
});

for(const kind of ["source","source-quote","foreign-company","foreign-ticket","stale-revision","duplicate","wrong-model","inactive","competing-alias"]){
 Deno.test("Task3C source-owned recap alias refuses "+kind,()=>{
  const {recall}=returnedResearch(),entity=recall.commerce!.state.entities[0];
  const receipts=entity.attributes.source_owned_recap_aliases as Record<string,unknown>[];
  if(kind==="source")receipts[0].source_message_id="another-source";
  if(kind==="source-quote")receipts[0].source_quote="Back to that other topic.";
  if(kind==="foreign-company")receipts[0].company_id="other-company";
  if(kind==="foreign-ticket")receipts[0].conversation_id="other-ticket";
  if(kind==="stale-revision")recall.memory!.commerce_state_revision=Number(recall.memory!.commerce_state_revision)-1;
  if(kind==="duplicate")receipts.push(structuredClone(receipts[0]));
  if(kind==="wrong-model")entity.model="MT-582";
  if(kind==="inactive")entity.status="cancelled";
  if(kind==="competing-alias"){
   const other=structuredClone(entity);other.entity_id="other-workshop";
   (other.attributes.source_owned_recap_aliases as Record<string,unknown>[])[0].entity_id=other.entity_id;
   recall.commerce!.state.entities.push(other);
  }
  const before=JSON.stringify(recall),result=prepareConversationRecall(recall,"en");
  assert(!result.decision.handled,JSON.stringify({kind,result}));assert(JSON.stringify(recall)===before);
 });
}

Deno.test("Task3C unvalidated research source cannot mint a recap alias",()=>{
 const {initial,input}=returnedResearch();
 for(const change of [
  {history:[]},
  {history:[{role:"assistant",content:"Tell me about ZX-731 workshop pack."}]},
  {text:"Back to that different service, what model was I researching?"},
 ]){
  const state=reduceTurn(initial,{...input,...change},[]);
  assert(!state.entities[0].attributes.source_owned_recap_aliases,JSON.stringify(change));
 }
});

Deno.test("Task3C failed research persistence leaves no authoritative recap alias",async()=>{
 const {initial,input}=returnedResearch(),stored=structuredClone(initial),before=JSON.stringify(stored);
 let attempts=0;
 const db:CommerceStateDbClient={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{revision:1,state:structuredClone(stored)},error:null})})})}),
  rpc:async(_name,params)=>{attempts++;assert(params.p_expected_revision===1&&params.p_source_message_id===input.source_message_id);
   return {data:null,error:{message:"isolated persistence failure"}};}};
 const result=await runCommerceStateRuntime(db,input);
 assert(attempts>0&&result?.persist_result!=="success",JSON.stringify(result));
 assert(JSON.stringify(stored)===before&&!retainedRecapTargets(stored).includes("WP"));
});

function semanticInput(question:string):ConversationRecallInput{
 const state=createEmptyConversationCommerceState();
 state.entities=[{entity_id:"course-item",category:"generic_service",model:"ZX-731",quantity:3,status:"researching",
  attributes:{product_name:"粵語課程"},constraints:{},provenance:{source_type:"customer",source_message_id:"course-source"}},
 {entity_id:"other-item",category:"generic_product",model:"MT-582",quantity:1,status:"deferred",
  attributes:{product_name:"蛋糕套餐"},constraints:{},provenance:{source_type:"customer",source_message_id:"other-source"}}];
 const memory=buildCanonicalConversationMemory({...identity,source_message_id:"current-recap",commerce_state_revision:8,
  commerce_state:state,newest_first:[],visitor_turn_count:2,source_created_at:"2026-11-24T00:00:00Z",next_memory_revision:3});
 return {...identity,source_message_id:"current-recap",question,memory,
  commerce:{...identity,source_message_id:"prior-state",revision:8,state},
  trusted_visitor_source_status:"verified",trusted_visitor_source_rows:[{id:"course-source",content:"我想報三堂粵語課程。"}],
  referents:[{ref:"course-item",source:"persistent_state",confidence:.99}]};
}
for(const question of ["Can you recap my current language course requirements?","Summarize the language course.","整理返語言培訓需要。"]){
 Deno.test("Task3C accepted semantic subject uses existing whole-turn recap grammar: "+question,()=>{
  const input=semanticInput(question),before=JSON.stringify(input),result=prepareConversationRecall(input,"en");
  assert(result.decision.handled&&result.reply?.includes("ZX-731")&&!result.reply?.includes("MT-582"),JSON.stringify(result));
  assert(JSON.stringify(input)===before,"ephemeral translated phrase became an alias");
  const absent=prepareConversationRecall({...input,referents:[]},"en");
  assert(!absent.decision.handled,"unknown translated label selected state without accepted referent");
 });
}
for(const kind of ["missing-source","duplicate-source","wrong-source","foreign-company","foreign-ticket","stale-revision","ambiguous-ref","weak-ref","foreign-proposal","unbound-proposal"]){
 Deno.test("Task3C semantic recap refuses "+kind,()=>{
  const input=semanticInput("Summarize the language course.");
  if(kind==="missing-source")input.trusted_visitor_source_rows=[];
  if(kind==="duplicate-source")input.trusted_visitor_source_rows=[...input.trusted_visitor_source_rows!,...input.trusted_visitor_source_rows!];
  if(kind==="wrong-source")input.trusted_visitor_source_rows=[{id:"course-source",content:"I asked about a different item."}];
  if(kind==="foreign-company")input.company_id="foreign";
  if(kind==="foreign-ticket")input.conversation_id="foreign";
  if(kind==="stale-revision")input.memory!.commerce_state_revision=Number(input.memory!.commerce_state_revision)-1;
  if(kind==="ambiguous-ref")input.referents!.push({ref:"other-item",source:"persistent_state",confidence:.99});
  if(kind==="weak-ref")input.referents![0].confidence=.7;
  if(kind==="foreign-proposal"||kind==="unbound-proposal")input.customer_recall_proposal={...identity,
   company_id:kind==="foreign-proposal"?"foreign":identity.company_id,source_message_id:input.source_message_id,
   intent:"customer_fact_recall",requested_facts:["summary"],subject_refs:[kind==="unbound-proposal"?"another course":"language course"]};
  const result=prepareConversationRecall(input,"en");assert(!result.decision.handled,JSON.stringify({kind,result}));
 });
}
Deno.test("Task3C scoped proposal selects only its current literal target with accepted state referent",()=>{
 const input=semanticInput("Summarize the language course.");
 input.customer_recall_proposal={...identity,source_message_id:input.source_message_id,intent:"customer_fact_recall",
  requested_facts:["summary"],subject_refs:["language course"]};
 const result=prepareConversationRecall(input,"en");assert(result.decision.handled&&result.reply?.includes("ZX-731"),JSON.stringify(result));
});
Deno.test("Task3C semantic hint cannot shrink a global recap or swallow another demand",()=>{
 for(const question of ["Give me a recap of everything.","Summarize my current requirements."]){
  const result=prepareConversationRecall(semanticInput(question),"en");
  assert(result.decision.handled&&result.reply?.includes("MT-582")&&result.reply?.includes("ZX-731"),JSON.stringify(result));
 }
 for(const question of ["Summarize the language course price.","Cancel the language course and recap it.",
  "Summarize the language course and explain the warranty.","If I ask later, summarize the language course.",
  "Summarize LM-902."]){
  const result=prepareConversationRecall(semanticInput(question),"en");assert(!result.decision.handled,JSON.stringify({question,result}));
 }
 const competing=prepareConversationRecall(semanticInput("Recap MT-582."),"en");
 assert(!competing.decision.handled||!competing.reply?.includes("ZX-731"),JSON.stringify(competing));
});
