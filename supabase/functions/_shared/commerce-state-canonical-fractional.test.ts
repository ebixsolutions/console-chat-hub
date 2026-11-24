import {createEmptyConversationCommerceState,type CommerceEntity,type ConversationCommerceState} from "./commerce-state-contract.ts";
import {reduceCommerceState} from "./commerce-state-reducer.ts";
import {customerRequestedQuantity} from "./customer-journey-orchestration.ts";
import {normalizeCommerceSemanticFrame} from "./commerce-semantic-frame.ts";
import {runCommerceStateRuntime,type CommerceStateDbClient} from "./commerce-state-runtime-base.ts";

const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message)};
function entity(category:string,quantity:number,unit:string):CommerceEntity {
  return {entity_id:category+":saved",category,quantity,status:"researching",
    attributes:{product_name:category,unit,quantity_basis:"customer_explicit"},constraints:{},
    provenance:{source_type:"customer",source_message_id:"source-quantity"}};
}
async function read(state:ConversationCommerceState,category:string){
  let writes=0;const before=JSON.stringify(state),beforeQuantity=state.entities[0].quantity;
  const db:CommerceStateDbClient={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{
    company_id:"company",conversation_id:"ticket",revision:7,state},error:null})})})}),
    rpc:async()=>{writes++;throw Error("read attempted a state write")}};
  const frame=normalizeCommerceSemanticFrame({operation:"ASK_FACT",confidence:.99,
    intent:"read current customer quantity",topic:category,requested_facts:["current_quantity"],
    entities:[],referents:[],demands:[]})!;
  const outcome=await runCommerceStateRuntime(db,{company_id:"company",conversation_id:"ticket",
    source_message_id:"source-query",text:"What quantity do I currently have?",language:"en",semantic_frame:frame});
  assert(writes===0&&JSON.stringify(state)===before&&Object.is(state.entities[0].quantity,beforeQuantity),
    "read changed the stored quantity or provenance");
  assert(outcome?.persist_result==="read_only"&&outcome.revision===7,"read lost its snapshot revision");
  return outcome;
}

for(const [category,quantity,unit] of [["weighed-goods",.5,"kg"],["consultation",1.5,"hours"]] as const){
  Deno.test("Task3C canonical saved fractional quantity: "+quantity+" "+unit,async()=>{
    // The original authoritative reducer accepts this finite nonnegative
    // customer quantity. The reader must not silently tighten that contract.
    const state=reduceCommerceState(createEmptyConversationCommerceState(),[
      {type:"ENSURE_ENTITY",entity:entity(category,quantity,unit)},
    ]);
    assert(customerRequestedQuantity(state.entities[0])===quantity,"existing quantity contract lost the fraction");
    const result=await read(state,category);
    assert(result?.authority==="CONVERSATION_STATE"&&result.state_path==="entities.0.quantity"&&
      result.reply?.includes(String(quantity)+" "+unit),JSON.stringify(result));
    assert(state.entities[0].provenance.source_message_id==="source-quantity","query relabelled the source");
  });
}

Deno.test("Task3C canonical saved fractional reader still rejects negative or nonfinite storage values",async()=>{
  for(const value of [-.5,NaN,Infinity,-Infinity]){
    let rejected=false;
    try{reduceCommerceState(createEmptyConversationCommerceState(),[{type:"ENSURE_ENTITY",entity:entity("weighed-goods",value,"kg")}]);}
    catch{rejected=true;}
    assert(rejected,"canonical reducer accepted invalid quantity "+String(value));
    // Explicit malformed-storage counterexample: it never becomes a claimed
    // customer fact merely because a caller provides an exact category.
    const malformed=createEmptyConversationCommerceState();malformed.entities=[entity("weighed-goods",value,"kg")];
    const result=await read(malformed,"weighed-goods");
    assert(result?.authority==="INSUFFICIENT_INFORMATION"&&!result.state_path,
      String(value)+": "+JSON.stringify(result));
  }
});
