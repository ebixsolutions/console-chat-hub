// Proposed replacements for legacy direct-state setups. All Visitor rows here are test inputs.
import { type ConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import { normalizeCommerceSemanticFrame } from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import { SCOPED_AREA_KEY,verifiedScopedAreaProposal } from "../../supabase/functions/_shared/contextual-customer-update.ts";

export function roomSourceFixture(state:ConversationCommerceState, scope:{company_id:string;conversation_id:string;revision:number}, ownerText:string,
    ownerId:string, observations:[string,number][], observationId:string, correction?:{text:string;id:string;scope:string;clause:string},unit="平方呎",source?:{text:string;rows:string[]}) {
  const owner=state.entities.find(e=>e.provenance.source_message_id===ownerId && !["cancelled","deferred","superseded"].includes(e.status));
  const goal=state.customer_constraints.contextual_goal as {goal_id?:string;source_message_id?:string}|undefined;
  const ref=owner?.entity_id ?? (goal?.source_message_id===ownerId?goal.goal_id:undefined);
  if(!ref)throw Error("fixture requires an independently scoped active owner");
  const history=[{id:ownerId,role:"visitor",content:ownerText}];
  const write=(action:"observe"|"correct",text:string,id:string,scopes:string[],rows:string[],revision:number)=>{
    const frame=normalizeCommerceSemanticFrame({operation:"UPDATE_ITEM",intent:"customer_context_update",confidence:.99,
      customer_correction:action==="correct",referents:[{source:"persistent_state",ref,confidence:.99}],
      customer_facts:[{key:SCOPED_AREA_KEY,value:{action,source_text:text.normalize("NFKC"),scopes,row_texts:rows}}]});
    const receipt=verifiedScopedAreaProposal({state,context:{company_id:scope.company_id,conversation_id:scope.conversation_id,
      source_message_id:id,state_revision:revision-1},text,frame,history});
    if(!receipt)throw Error("fixture area source rejected");
    state.customer_constraints[SCOPED_AREA_KEY]=receipt;
    history.push({id,role:"visitor",content:text});
    return receipt;
  };
  const rows=source?.rows??observations.map(([label,amount])=>label+amount+unit);
  write("observe",source?.text??rows.join("，"),observationId,observations.map(([label])=>label),rows,scope.revision-(correction?1:0));
  if(correction){
    const receipt=write("correct",correction.text,correction.id,[correction.scope],[correction.clause],scope.revision);
    if(!receipt.superseded.some(row=>row.source_message_id===observationId) ||
      !receipt.current.some(row=>row.source_message_id===correction.id))throw Error("correction lineage missing");
  }
  return history;
}


export function roomGoalFixture(state:ConversationCommerceState, snapshot:{company_id:string;conversation_id:string;revision:number},
  ownerText:string, label:string, ownerId:string, observations:[string,number][], observationId:string,
  source:{text:string;rows:string[]}){
  state.current_topic=label;
  state.customer_constraints.contextual_goal={version:"contextual-scope-1",goal_id:"contextual-goal:"+ownerId,
    subject_label:label,source_text:ownerText,company_id:snapshot.company_id,conversation_id:snapshot.conversation_id,
    source_message_id:ownerId,recorded_revision:1,status:"active"};
  return roomSourceFixture(state,snapshot,ownerText,ownerId,observations,observationId,undefined,"",source);
}
