/** Admin-only same-company evidence authorization and exact source-message correlation. */
export type EvidenceAdminScope={ok:true;companyId:string}|{ok:false;error:string};
export async function resolveEvidenceAdminScope(db:any,userId:string):Promise<EvidenceAdminScope>{
 if(!userId)return{ok:false,error:"unauthenticated"};
 const {data,error}=await db.from("company_membership").select("company_id,role,is_active").eq("user_id",userId);
 if(error)return{ok:false,error:"membership_lookup_failed"};
 const rows=(data??[]) as Array<{company_id:string|null;role:string|null;is_active:boolean|null}>;
 const ids=[...new Set(rows.map(x=>x.company_id).filter((v):v is string=>typeof v==="string"&&!!v))];
 if(ids.length!==1)return{ok:false,error:"company_scope_unresolved"};
 const companyId=ids[0];
 if(!rows.some(x=>x.company_id===companyId&&x.is_active===true&&x.role==="admin"))
  return{ok:false,error:"forbidden"};
 const {data:company,error:companyError}=await db.from("company").select("id,is_active").eq("id",companyId).maybeSingle();
 if(companyError||!company||company.is_active!==true)return{ok:false,error:"company_inactive"};
 return{ok:true,companyId};
}
type EvidenceMessage={id:string;role:string;content:string;created_at:string;metadata?:unknown;is_recalled?:boolean|null};
type EvidenceTrace={id:string;message_id:string|null;query_sent:string|null;retrieved_chunks:unknown;top_score:number|null;kb_source:string|null;created_at:string};
function asRecord(x:unknown):Record<string,unknown>{return x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};}
export function linkConversationEvidenceTurns(messages:EvidenceMessage[],traces:EvidenceTrace[]){
 const visitors=messages.filter(m=>["visitor","customer","user"].includes(m.role));
 const visitorIds=new Set(visitors.map(x=>x.id));
 const replies=new Map<string,EvidenceMessage[]>(),unlinked:EvidenceMessage[]=[];
 for(const m of messages){
  if(!["assistant","agent"].includes(m.role)||m.content==="__THINKING__")continue;
  const meta=asRecord(m.metadata);
  const source=[meta.source_message_id,meta.b2_source_message_id].find(x=>typeof x==="string"&&visitorIds.has(x)) as string|undefined;
  if(!source){unlinked.push(m);continue;}
  replies.set(source,[...(replies.get(source)??[]),m]);
 }
 const turns=visitors.map((m,index)=>({
  index:index+1,messageId:m.id,createdAt:m.created_at,
  customerQuestion:m.is_recalled?"[RECALLED]":m.content,
  answers:(replies.get(m.id)??[]).map(a=>{
   const meta=asRecord(a.metadata);
   return{id:a.id,role:a.role,text:a.is_recalled?"[RECALLED]":a.content,createdAt:a.created_at,
    metadata:{
     response_route:typeof meta.response_route==="string"?meta.response_route:null,
     source_error_code:typeof meta.source_error_code==="string"?meta.source_error_code:null,
     grounding_state:typeof meta.grounding_state==="string"?meta.grounding_state:null,
     grounding_verification:meta.grounding_verification??null,
     factual_evidence_coverage:meta.factual_evidence_coverage??null,
     citations:meta.citations??null,unresolved_fact_fields:meta.unresolved_fact_fields??null,
    }};
  }),
  evidence:traces.filter(t=>t.message_id===m.id).map(t=>{
   const d=asRecord(t.retrieved_chunks),r=asRecord(d.response);
   return{id:t.id,createdAt:t.created_at,exactQuery:t.query_sent,
    requestJson:typeof d.request_json==="string"?d.request_json:null,
    sourceContext:d.source_context??null,queryContract:d.query_contract??null,
    requestDispatchState:d.request_dispatch_state??"NOT_VERIFIED",
    rawCaptureState:typeof r.capture_state==="string"?r.capture_state:"NOT_CAPTURED",
    rawResponse:typeof r.response_json_raw==="string"?r.response_json_raw:null,
    rawSha256:typeof r.response_sha256==="string"?r.response_sha256:null,
    responseBytes:typeof r.response_bytes==="number"?r.response_bytes:null,
    responseStatus:typeof r.http_status==="number"?r.http_status:null,
    lineage:d.lineage??null};
  }),
  evidenceStatus:traces.some(t=>t.message_id===m.id)?"TRACE_RECORDED":"NOT_CAPTURED",
 }));
 return {turns,unlinkedReplies:unlinked.map(m=>({id:m.id,role:m.role,
  text:m.is_recalled?"[RECALLED]":m.content,createdAt:m.created_at}))};
}
