/** Admin-only same-company evidence authorization and exact source-message correlation. */
const EVIDENCE_UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function isEvidenceConversationId(id:string):boolean{return EVIDENCE_UUID.test(id);}
const PRIVATE_EVIDENCE_KEY=/^(?:authorization|x-api-key|api_key|access_token|refresh_token|password|private_key|client_secret|service_role_key|email|phone|mobile)$/i;
const PHONE_OR_UUID=/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|(?:\+?852[- ]?)?[569]\d{3}[- ]?\d{4}/gi;
const LINEAGE_ID=String.raw`(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?=[0-9a-f]{0,31}[a-f])[0-9a-f]{32})`;
// Only exact lineage fields in serialized structured receipts can contain opaque IDs.
const STRUCTURED_LINEAGE_OR_PHONE=new RegExp(
 String.raw`(?<=[{,])(?:"(?:document_id|chunk_id|selected_document_id|selected_source_id)":"${LINEAGE_ID}"|"(?:evidence_chunk_ids|selected_document_ids)":\["${LINEAGE_ID}"(?:,"${LINEAGE_ID}")*\])(?=[,}])|${PHONE_OR_UUID.source}`,
 "gi",
);
/** The original raw-response hash remains independent of the redacted Admin display. */
export function redactEvidenceSensitiveText(value:string):string{
 return redactEvidenceText(value,false);
}
function redactEvidenceText(value:string,preserveStructuredLineage:boolean):string{
 if(value.length>65536)return "[WITHHELD_OVERSIZED]";
 return value
  .replace(/("(?:authorization|x-api-key|api_key|access_token|refresh_token|password|private_key|client_secret|service_role_key|email|phone|mobile)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,'$1"[REDACTED]"')
  .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi,"Bearer [REDACTED]")
  .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,"[EMAIL_REDACTED]")
  .replace(preserveStructuredLineage?STRUCTURED_LINEAGE_OR_PHONE:PHONE_OR_UUID,
   value=>value.startsWith('"')||EVIDENCE_UUID.test(value)?value:"[PHONE_REDACTED]");
}
/** Serialize a bounded redacted snapshot for the existing authenticated TanStack server function. */
export function redactEvidenceValue(value:unknown,preserveStructuredLineage=false):string|null{
 if(value===null||value===undefined)return null;
 try{
  const encoded=JSON.stringify(value,(key,item)=>PRIVATE_EVIDENCE_KEY.test(key)?"[REDACTED]":item);
  return typeof encoded==="string"?redactEvidenceText(encoded,preserveStructuredLineage):null;
 }catch{return "[WITHHELD_UNSERIALIZABLE]";}
}
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
const SEMANTIC_TRACE_CONTRACT="c3-admin-semantic-failure-v1";
const SEMANTIC_CAPTURE_CONTRACT="c3-semantic-failure-evidence-v1";
const SEMANTIC_NOT_DISPATCHED="KB_NOT_DISPATCHED_SEMANTIC_FAILURE";
const SEMANTIC_CAPTURE_LIMIT=65536;
const evidenceHash=(value:unknown):string|null=>typeof value==="string"&&/^[0-9a-f]{64}$/i.test(value)?value:null;
type SemanticCaptureView={
 captureState:string|null;displayState:string;captureOrigin:string|null;sha256:string|null;bytes:number|null;body:string|null;
};
function withheldSemanticCapture():SemanticCaptureView{
 return{captureState:null,displayState:"WITHHELD_INVALID_RECEIPT",captureOrigin:null,sha256:null,bytes:null,body:null};
}
/** These hashes describe the original complete bytes, never the redacted display. */
function semanticCaptureView(value:unknown,origin:"SEMANTIC_ROUTER_INPUT"|"SEMANTIC_MODEL_TEXT"):SemanticCaptureView{
 const receipt=asRecord(value),sha256=evidenceHash(receipt.sha256),bytes=receipt.bytes;
 if(receipt.capture_origin!==origin||!sha256||typeof bytes!=="number"||!Number.isSafeInteger(bytes)||bytes<0||
   !["CAPTURED","WITHHELD_OVERSIZED","WITHHELD_SENSITIVE"].includes(String(receipt.capture_state)))return withheldSemanticCapture();
 const captureState=String(receipt.capture_state);
 if(captureState!=="CAPTURED"){
  if(receipt.body!==null)return withheldSemanticCapture();
  return{captureState,displayState:captureState,captureOrigin:origin,sha256,bytes,body:null};
 }
 if(typeof receipt.body!=="string"||new TextEncoder().encode(receipt.body).byteLength!==bytes)return withheldSemanticCapture();
 if(bytes>SEMANTIC_CAPTURE_LIMIT)return{captureState,displayState:"WITHHELD_OVERSIZED",captureOrigin:origin,sha256,bytes,body:null};
 const body=redactEvidenceSensitiveText(receipt.body);
 return{captureState,displayState:body===receipt.body?"CAPTURED":"REDACTED",captureOrigin:origin,sha256,bytes,body};
}
/** Any semantic marker reserves the row for this decoder. Invalid rows cannot
 * fall through into the KB call list or masquerade as upstream HTTP evidence. */
function isSemanticTrace(trace:EvidenceTrace):boolean{
 const data=asRecord(trace.retrieved_chunks),semantic=asRecord(data.semantic);
 return trace.kb_source?.startsWith("semantic_")===true||
  typeof data.contract==="string"&&data.contract.startsWith("c3-admin-semantic-")||
  typeof semantic.contract==="string"&&semantic.contract.startsWith("c3-semantic-")||Object.hasOwn(data,"semantic");
}
function semanticTraceView(trace:EvidenceTrace,sourceId:string){
 const data=asRecord(trace.retrieved_chunks),semantic=asRecord(data.semantic),input=asRecord(data.semantic_input);
 const expectedRequest=`commerce-semantic:${sourceId}`;
 const linked=EVIDENCE_UUID.test(sourceId)&&trace.message_id===sourceId&&trace.kb_source==="semantic_contract_failure"&&
  data.contract===SEMANTIC_TRACE_CONTRACT&&data.source_message_id===sourceId&&
  semantic.contract===SEMANTIC_CAPTURE_CONTRACT&&semantic.source_message_id===sourceId&&
  data.operation_id===expectedRequest&&semantic.request_id===expectedRequest&&
  input.source_message_id===sourceId&&data.request_dispatch_state===SEMANTIC_NOT_DISPATCHED&&trace.query_sent===null&&trace.top_score===null;
 return{id:trace.id,createdAt:trace.created_at,linkageStatus:linked?"MATCH":"WITHHELD_INVALID_BINDING",
  sourceMessageId:linked?sourceId:null,requestId:linked?expectedRequest:null,
  requestDispatchState:linked?SEMANTIC_NOT_DISPATCHED:"NOT_VERIFIED",
  request:linked?semanticCaptureView(semantic.request,"SEMANTIC_ROUTER_INPUT"):withheldSemanticCapture(),
  response:linked?semanticCaptureView(semantic.response,"SEMANTIC_MODEL_TEXT"):withheldSemanticCapture(),
  inputUserSha256:linked?evidenceHash(input.user_sha256):null,
  inputSystemSha256:linked?evidenceHash(input.system_sha256):null,
  diagnostics:linked?redactEvidenceValue({stage:data.stage??null,contract_rejection:data.contract_rejection??null,
   contract_diagnostic:data.contract_diagnostic??null,recovery_outcomes:semantic.recovery_outcomes??null}):null};
}

const GATE_RECEIPT_CONTRACT="c3-gate-reason-v1";
function gateReceiptView(t:EvidenceTrace,sourceId:string){
 const o=asRecord(t.retrieved_chunks),d=asRecord(o.decision_receipt),binding=asRecord(d.source_binding);
 if(t.kb_source!=="protected_pipeline_diagnostic"||o.contract!=="c3-protected-pipeline-evidence-v1"||
   t.message_id!==sourceId||o.source_message_id!==sourceId||d.contract!==GATE_RECEIPT_CONTRACT||
   binding.source_message_id!==sourceId||binding.company_id!==o.company_id||
   typeof binding.conversation_id!=="string"||!EVIDENCE_UUID.test(binding.conversation_id)||!EVIDENCE_UUID.test(binding.company_id))return null;
 if(!["grounding_verifier","b2","semantic_validation","recovery"].includes(String(d.gate))||
    !["accepted","rejected","fallback_selected","NOT_CAPTURED"].includes(String(d.outcome)))return null;
 const demands=Array.isArray(d.per_demand)?d.per_demand.slice(0,12).flatMap(raw=>{
   const e=asRecord(raw);
   if(typeof e.demand_id!=="string"||!/^demand-(?:[1-9]|1[0-2])$/u.test(e.demand_id)||
      !["supported","partial","unavailable"].includes(String(e.status)))return [];
   return [{demand_id:e.demand_id,status:e.status,evidence_ids:Array.isArray(e.evidence_ids)?
      e.evidence_ids.filter(v=>typeof v==="string"&&/^E(?:[1-9]|1[0-5])$/u.test(v)).slice(0,15):[]}];
 }):[];
 return {id:t.id,gate:d.gate,outcome:d.outcome,
   firedCondition:typeof d.fired_condition==="string"&&/^[A-Za-z0-9_]{3,80}$/u.test(d.fired_condition)?
     d.fired_condition:"NOT_CAPTURED",
   faultClass:["content","reviewer_output_shape","policy","system","NOT_CAPTURED"].includes(String(d.fault_class))?
     d.fault_class:"NOT_CAPTURED",perDemand:demands,
   selectedFallback:typeof d.selected_fallback==="string"&&/^[a-z_]{4,80}$/u.test(d.selected_fallback)?
     d.selected_fallback:null,source:"PROTECTED_PIPELINE_DIAGNOSTIC"};
}
export function linkConversationEvidenceTurns(messages:EvidenceMessage[],traces:EvidenceTrace[]){
 const visitors=messages.filter(m=>["visitor","customer","user"].includes(m.role));
 const visitorIds=new Set(visitors.map(x=>x.id));
 const replies=new Map<string,EvidenceMessage[]>(),unlinked:EvidenceMessage[]=[];
 for(const m of messages){
  if(!["assistant","agent"].includes(m.role)||m.content==="__THINKING__")continue;
  const meta=asRecord(m.metadata);
const declared=[meta.source_message_id,meta.b2_source_message_id]
     .filter((value):value is string=>typeof value==="string"&&value.length>0);
   const distinct=[...new Set(declared)];
   if(distinct.length>1){unlinked.push(m);continue;} // Conflicting source pointers are never guessed.
   const source=distinct[0];
   if(source&&!visitorIds.has(source))continue; // A source on another message page.
   if(!source){unlinked.push(m);continue;}
   replies.set(source,[...(replies.get(source)??[]),m]);
 }
 const turns=visitors.map((m,index)=>{
  const sourceTraces=traces.filter(t=>t.message_id===m.id),kbTraces=sourceTraces.filter(t=>!isSemanticTrace(t)&&t.kb_source!=="protected_pipeline_diagnostic");
  const semanticEvidence=sourceTraces.filter(isSemanticTrace).map(t=>semanticTraceView(t,m.id));
  return{
  index:index+1,messageId:m.id,createdAt:m.created_at,
  customerQuestion:m.is_recalled?"[RECALLED]":redactEvidenceSensitiveText(m.content),
  answers:(replies.get(m.id)??[]).map(a=>{
   const meta=asRecord(a.metadata);
   return{id:a.id,role:a.role,text:a.is_recalled?"[RECALLED]":redactEvidenceSensitiveText(a.content),createdAt:a.created_at,
    metadata:redactEvidenceValue({
     response_route:typeof meta.response_route==="string"?meta.response_route:null,
     source_error_code:typeof meta.source_error_code==="string"?meta.source_error_code:null,
     grounding_state:typeof meta.grounding_state==="string"?meta.grounding_state:null,
grounding_verification:meta.grounding_verification??null,
 grounding_rejection_reason:meta.grounding_rejection_reason??null,
 grounding_verifier_failure:meta.grounding_verifier_failure??null,
 failed_generation_request_id:meta.failed_generation_request_id??null,
 factual_evidence_coverage:meta.factual_evidence_coverage??null,
     factual_evidence_candidates:meta.factual_evidence_candidates??null,
     factual_evidence_selection:meta.factual_evidence_selection??null,
     citation_lineage:meta.citation_lineage??null,
     semantic_failure_receipt:meta.semantic_failure_receipt??null,
     assistant_message_id:a.id,source_message_id:m.id,
     b2_gate_contract:meta.b2_gate_contract??null,b2_commit_source:meta.b2_commit_source??null,
     b2_expected_revision:meta.b2_expected_revision??null,b2_source_message_id:meta.b2_source_message_id??null,
     b2_expected_company_id:meta.b2_expected_company_id??null,control_commit:meta.control_commit??null,
     citations:meta.citations??null,unresolved_fact_fields:meta.unresolved_fact_fields??null,
    },true)};
  }),
  semanticEvidence,
  gateDecisions:sourceTraces.map(t=>gateReceiptView(t,m.id)).filter((x):x is NonNullable<typeof x>=>x!==null),
  pipelineEvidence:sourceTraces.filter(t=>t.kb_source==="protected_pipeline_diagnostic").map(t=>{
   const d=asRecord(t.retrieved_chunks);
   const linked=d.contract==="c3-protected-pipeline-evidence-v1"&&d.source_message_id===m.id&&EVIDENCE_UUID.test(m.id);
   return {id:t.id,stage:linked?String(d.stage):"NOT_VERIFIED",linkageStatus:linked?"MATCH":"MISMATCH",
    capture:linked?redactEvidenceValue(d.payload):null};
  }),
  evidence:kbTraces.map(t=>{
   const d=asRecord(t.retrieved_chunks),r=asRecord(d.response);
   const raw=typeof r.response_json_raw==="string"?r.response_json_raw:null;
   const safeRaw=raw===null?null:redactEvidenceSensitiveText(raw);
   return{id:t.id,createdAt:t.created_at,exactQuery:t.query_sent?redactEvidenceSensitiveText(t.query_sent):null,
    requestJson:typeof d.request_json==="string"?redactEvidenceSensitiveText(d.request_json):null,
    sourceContext:redactEvidenceValue(d.source_context??null),queryContract:redactEvidenceValue(d.query_contract??null),
    requestDispatchState:typeof d.request_dispatch_state==="string"?d.request_dispatch_state:"NOT_VERIFIED",
rawCaptureState:raw!==null&&safeRaw!==raw?"REDACTED":
   r.capture_origin!=="UPSTREAM_HTTP"&&r.capture_state==="CAPTURED"?"LEGACY_ORIGIN_UNVERIFIED":
   typeof r.capture_state==="string"?r.capture_state:"NOT_CAPTURED",
 rawCaptureOrigin:typeof r.capture_origin==="string"?r.capture_origin:"LEGACY_ORIGIN_UNVERIFIED",
 bodyComplete:r.body_complete===true,operationId:typeof d.operation_id==="string"?d.operation_id:null,
 rawResponse:safeRaw,
 rawSha256:typeof r.response_sha256==="string"?r.response_sha256:null,
 responseBytes:typeof r.response_bytes==="number"?r.response_bytes:null,
 normalizedSha256:typeof r.normalized_response_sha256==="string"?r.normalized_response_sha256:null,
 normalizedBytes:typeof r.normalized_response_bytes==="number"?r.normalized_response_bytes:null,
 executionFailure:redactEvidenceValue(d.execution_failure??null),
    responseStatus:typeof r.http_status==="number"?r.http_status:null,
    lineage:redactEvidenceValue(d.lineage??null,true)};
  }),
  evidenceStatus:kbTraces.length?"TRACE_RECORDED":
   semanticEvidence.some(trace=>trace.linkageStatus==="MATCH")||(replies.get(m.id)??[]).some(reply=>{
     const meta=asRecord(reply.metadata),failure=asRecord(meta.execution_failure);
     return meta.response_route==="terminal_failure_recovery" &&
       meta.source_error_code==="LLM_INVALID_OUTPUT" &&
       failure.stage==="canonical_validation" &&
       (meta.rag_api_status===null||meta.rag_api_status===undefined);
   })?"KB_NOT_DISPATCHED_SEMANTIC_FAILURE":"NOT_CAPTURED",
 };});
return {turns,unlinkedReplies:unlinked.map(m=>({id:m.id,role:m.role,
   text:m.is_recalled?"[RECALLED]":redactEvidenceSensitiveText(m.content),createdAt:m.created_at,
   linkageStatus:new Set([asRecord(m.metadata).source_message_id,asRecord(m.metadata).b2_source_message_id]
     .filter(v=>typeof v==="string"&&v.length>0)).size>1?"CONFLICTING_SOURCE_IDS":"NO_SOURCE_ID"}))};
}
