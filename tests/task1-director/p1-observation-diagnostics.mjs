/** Structured observation assertions. Text matching is not a business oracle.
 * Missing semantic adjudication remains NOT_PROVEN, including must_not claims.
 */
import {digest} from './p1-observation-fixtures.mjs';
export const check=(id,pass,evidence,scope='runtime')=>({id,status:pass?'PASS':'FAIL',scope,evidence});
const unknown=(id,expected,reason,observations=[])=>({id,status:'NOT_PROVEN',expected,reason,observations});
const notReached=id=>({id,status:'NOT_REACHED',reason:'Handler result or required persisted artifact is unavailable.'});
export const active=state=>(state?.entities??[]).filter(entity=>!['cancelled','deferred'].includes(entity.status));
export function errorCodes(result,fixture,error){
 const found=[];
 const visit=(value,path,depth=0)=>{
  if(!value||typeof value!=='object'||depth>7)return;
  for(const [key,child] of Object.entries(value)){
   if(['code','error_code','source_error_code','reason_code','error'].includes(key)&&typeof child==='string'&&
    /^[a-zA-Z][a-zA-Z0-9_.:-]{2,140}$/u.test(child)&&!child.includes('PRIVATE-SECRET'))found.push({code:child,path:path+'.'+key});
   else if(child&&typeof child==='object')visit(child,path+'.'+key,depth+1);
  }
 };
 visit(result?.body,'response');
 for(const [index,reply] of (fixture?.commits??[]).entries())visit(reply.metadata,'commits.'+index+'.metadata');
 for(const [index,trace] of (fixture?.tables?.rag_trace??[]).entries())visit(trace,'rag_trace.'+index);
 if(error?.code)visit({code:error.code},'exception');
 return [...new Map(found.map(item=>[item.code+'|'+item.path,item])).values()];
}
const selectedReply=reply=>reply?{id:reply.id,source_message_id:reply.metadata?.source_message_id,
 content:reply.content,content_sha256:digest(reply.content),metadata:{
  response_route:reply.metadata?.response_route,source_error_code:reply.metadata?.source_error_code,
  execution_failure:reply.metadata?.execution_failure,generation_success:reply.metadata?.generation_success,
  b2_commit_source:reply.metadata?.b2_commit_source,b2_source_message_id:reply.metadata?.b2_source_message_id,
  b2_expected_company_id:reply.metadata?.b2_expected_company_id,b2_response_hash:reply.metadata?.b2_response_hash,
  recall_provenance:reply.metadata?.recall_provenance,citation_lineage:reply.metadata?.citation_lineage,
  unresolved_fact_fields:reply.metadata?.unresolved_fact_fields}}:null;
export function snapshot(fixture,result,source){
 const tables=fixture?.tables,commerce=tables?.conversation_commerce_state?.[0];
 const memory=tables?.conversation_memory_state?.[0];
 const visitor=tables?.messages?.find(message=>message.id===source&&message.role==='visitor');
 const handoffs=(fixture?.requests??[]).filter(request=>request.url.endsWith('/rpc/explicit_handoff_tx')||request.url.endsWith('/rpc/required_escalation_handoff_tx'));
 return {source_message_id:source,company_id:tables?.conversations?.[0]?.company_id??null,
  conversation_id:tables?.conversations?.[0]?.id??null,visitor_found:!!visitor,
  visitor_sha256:visitor?digest(visitor.content):null,conversation_status:tables?.conversations?.[0]?.status??null,
  http:result?.status??null,response:{error:result?.body?.error,code:result?.body?.code,
   skipped:result?.body?.skipped,response_route:result?.body?.response_route,
   escalation_rule:result?.body?.escalation_rule,handoff_persisted:result?.body?.handoff_persisted},
  reply_count:fixture?.commits?.length??0,reply:selectedReply(fixture?.commits?.[0]),
  kb_dispatch_count:(fixture?.requests??[]).filter(request=>request.url.includes('/rag/context-search')).length,
  semantic_dispatch_count:(fixture?.requests??[]).filter(request=>request.url.endsWith(':generateContent')&&
   request.body?.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.')).length,
  generation_dispatch_count:(fixture?.requests??[]).filter(request=>request.url.endsWith(':generateContent')&&
   !request.body?.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.')).length,
  handoff_rpc_count:handoffs.length,
  readback:{status:tables?'ACTUAL_FIXTURE_TABLES':'UNAVAILABLE',
   state:commerce?structuredClone(commerce.state):null,commerce_revision:commerce?.revision??null,
   commerce_source_message_id:commerce?.source_message_id??null,
   commerce_company_id:commerce?.company_id??null,commerce_conversation_id:commerce?.conversation_id??null,
   memory_revision:memory?.revision??null,memory_source_message_id:memory?.source_message_id??null,
   commerce_commit_for_this_source:!!tables?.conversation_commerce_state_event?.some(event=>event.source_message_id===source&&event.applied_revision===commerce?.revision),
   memory_commit_for_this_source:!!tables?.conversation_memory_state_event?.some(event=>event.source_message_id===source&&event.applied_revision===memory?.revision)}};
}

export function turnAssertions(observation){
 const result=[];
 result.push(check('source_visitor_binding',observation.visitor_found&&observation.visitor_sha256===observation.utterance_sha256,
  {source_message_id:observation.source_message_id,visitor_sha256:observation.visitor_sha256,expected_sha256:observation.utterance_sha256}));
 if(observation.http===null){
  result.push(check('handler_completed',false,observation.exception??null),...['handler_http_200','exactly_once_delivery','no_terminal_failure','reply_source_binding'].map(notReached));
  return result;
 }
 result.push(check('handler_http_200',observation.http===200,observation.http));
 const handoff=observation.response.handoff_persisted===true&&observation.handoff_rpc_count===1&&observation.conversation_status==='human_control';
 const suppressed=observation.response.skipped==='human_handling'&&observation.conversation_status==='human_control';
 result.push(check('exactly_once_delivery',handoff?observation.reply_count===0:suppressed?observation.reply_count===0:observation.reply_count===1,
  {replies:observation.reply_count,handoff_rpc_count:observation.handoff_rpc_count,handoff,suppressed}));
 if(observation.reply){
  const meta=observation.reply.metadata;
  result.push(check('no_terminal_failure',meta.generation_success!==false,
   {generation_success:meta.generation_success,execution_failure:meta.execution_failure??null}));
  result.push(check('reply_source_binding',observation.reply.source_message_id===observation.source_message_id&&
   meta.b2_source_message_id===observation.source_message_id&&meta.b2_expected_company_id===observation.company_id&&
   meta.b2_commit_source==='commit_ai_reply_tx'&&meta.b2_response_hash===observation.reply.content_sha256,
   {source_message_id:observation.reply.source_message_id,b2_source_message_id:meta.b2_source_message_id,
    b2_expected_company_id:meta.b2_expected_company_id,content_hash_bound:meta.b2_response_hash===observation.reply.content_sha256}));
 }else if(!handoff&&!suppressed)result.push(notReached('no_terminal_failure'),notReached('reply_source_binding'));
 const state=observation.readback.state;
 result.push(check('no_fabricated_order_or_payment_in_state',!state||state.conversion?.order_status!=='confirmed'&&state.conversion?.payment_status!=='paid',
  state?.conversion??null,'canonical_state_only'));
 if(state)result.push(check('persisted_state_tenant_ticket',observation.readback.commerce_company_id===observation.company_id&&
  observation.readback.commerce_conversation_id===observation.conversation_id,
  {company_id:observation.readback.commerce_company_id,conversation_id:observation.readback.commerce_conversation_id}));
 return result;
}

function probeChecks(row,turns){
 const last=turns.at(-1),state=last?.readback?.state,expect=row.expect,checks=[];
 const entity=state?.entities?.find(item=>item.attributes?.product_name===expect.item);
 if(expect.item)checks.push(check('expect.item',!!entity,{expected:expect.item,entity:entity??null},'original_probe'));
 if(typeof expect.quantity==='number')checks.push(check('expect.quantity',entity?.quantity===expect.quantity,
  {expected:expect.quantity,actual:entity?.quantity??null},'original_probe'));
 if(typeof expect.notQuantity==='number')checks.push(check('expect.notQuantity',!entity||entity.quantity!==expect.notQuantity,
  {forbidden:expect.notQuantity,actual:entity?.quantity??null},'original_probe'));
 if(expect.noCustomerExplicit)checks.push(check('expect.noCustomerExplicit',!!entity&&entity.attributes?.quantity_basis!=='customer_explicit',
  {quantity_basis:entity?.attributes?.quantity_basis??null},'original_probe'));
 if(expect.quotes===0)checks.push(check('expect.quotes',(state?.quotes?.length??0)===0,{actual:state?.quotes?.length??0},'original_probe'));
 if(expect.allowSafeRefusal)checks.push(check('expect.allowSafeRefusal',last?.http===200&&last.assertions.every(item=>item.status==='PASS'),
  {runtime_assertions:last?.assertions??[]},'original_probe'));
 return checks;
}

function structuredOriginalCheck(key,expected,row,turns){
 const final=turns.at(-1),state=final?.readback?.state,entityRows=active(state);
 const storedSum=entityRows.reduce((sum,entity)=>sum+(Number.isFinite(entity.quantity)?entity.quantity:0),0);
 const priorSourceIds=new Set(turns.slice(0,-1).filter(turn=>turn.visitor_found).map(turn=>turn.source_message_id));
 const proofs=final?.reply?.metadata?.recall_provenance??[],lineage=final?.reply?.metadata?.citation_lineage;
 const missingReading=turns.some(turn=>turn.input.reading.status==='NOT_SUPPLIED');
 const kbKnown=final?.input?.kb?.status==='ORIGINAL_SYNTHETIC_SEED';
 const scope='original_expectation_structured_evidence';
 let observation;
 if(key==='merchant_kb_required')return {...check('must.'+key,expected?final?.kb_dispatch_count>0:turns.every(turn=>turn.kb_dispatch_count===0),
  {required:expected,dispatches:turns.map(turn=>turn.kb_dispatch_count)},scope),expected};
 if(key==='retain_document_id')return {...check('must.'+key,kbKnown&&lineage?.selected_document_id===expected,
  {expected,actual:lineage?.selected_document_id??null,kb_supplied:kbKnown},scope),expected};
 if(key==='retain_chunk_id')return {...check('must.'+key,kbKnown&&lineage?.evidence_chunk_ids?.includes(expected),
  {expected,actual:lineage?.evidence_chunk_ids??[],kb_supplied:kbKnown},scope),expected};
 if(key==='prior_source_required')return {...check('must.'+key,proofs.length>0&&proofs.every(proof=>priorSourceIds.has(proof.source_message_id))&&
  final.assertions.find(item=>item.id==='reply_source_binding')?.status==='PASS',
  {proofs,prior_source_ids:[...priorSourceIds]},scope),expected};
 if(key==='retained_count')observation=check('active_canonical_quantity',entityRows.length>0&&storedSum===expected,
  {expected,actual:storedSum,entity_ids:entityRows.map(entity=>entity.entity_id)},'canonical_state_only');
 if(key==='customer_value')observation=check('canonical_customer_quantity',entityRows.length>0&&storedSum===expected,
  {expected,actual:storedSum,recall_provenance:proofs},'canonical_state_only');
 if(key==='cancelled_or_deferred_count'){
  const historical=(state?.entities??[]).filter(entity=>['cancelled','deferred'].includes(entity.status));
  observation=check('historical_canonical_quantity',historical.length>0&&historical.reduce((sum,entity)=>sum+(entity.quantity??0),0)===expected,
   {expected,entities:historical},'canonical_state_only');
 }
 return unknown('must.'+key,expected,missingReading?
  'SCRIPTED_READING_MISSING: runtime evidence is retained, but the complete original requirement is not established.':
  'BUSINESS_ORACLE_NOT_IMPLEMENTED: structured state/lineage alone cannot certify the full customer-facing requirement.',observation?[observation]:[]);
}

export function businessAssertions(row,turns){
 if(row.kind==='probe')return probeChecks(row,turns);
 const checks=[];
 if(typeof row.must==='object')for(const [key,expected] of Object.entries(row.must))checks.push(structuredOriginalCheck(key,expected,row,turns));
 else checks.push(unknown('must',row.must,'Full source-bound reply meaning has no independent machine adjudicator; keyword presence is insufficient.'));
 if(row.must_not!==undefined)checks.push(unknown('must_not',row.must_not,
  'Absence of fixed keywords cannot prove absence of forbidden claims; no independent claim adjudicator is supplied.'));
 const humanTurn={'RT-05':2,'ED-05':3,'SA-05':3}[row.id];
 if(humanTurn){
  const actual=turns[humanTurn-1];
  checks.push(check('must.explicit_human_subassertion',actual?.response.escalation_rule==='R1'&&
   actual.response.handoff_persisted===true&&actual.handoff_rpc_count===1&&actual.conversation_status==='human_control'&&actual.kb_dispatch_count===0,
   {turn:humanTurn,response:actual?.response,handoff_rpc_count:actual?.handoff_rpc_count,
    conversation_status:actual?.conversation_status,kb_dispatch_count:actual?.kb_dispatch_count},'original_must_partial'));
 }
 return checks;
}

export function modeOutcome(turns,business){
 const runtime=turns.flatMap(turn=>turn.assertions),failures=runtime.filter(item=>item.status==='FAIL');
 const notProven=business.filter(item=>item.status==='NOT_PROVEN'||item.status==='NOT_REACHED');
 const missing=turns.filter(turn=>turn.input.reading.status==='NOT_SUPPLIED').map(turn=>turn.turn);
 const generationMissing=turns.filter(turn=>turn.generation_dispatch_count>0&&turn.input.generation.status==='NOT_SUPPLIED').map(turn=>turn.turn);
 const kbMissing=turns.filter(turn=>turn.kb_dispatch_count>0&&turn.input.kb.status==='KB_FIXTURE_MISSING').map(turn=>turn.turn);
 const all=runtime.concat(business),complete=all.length>0&&all.every(item=>item.status==='PASS');
 return {status:complete?'PASS':'FAIL',outcome:complete?'SCOPED_SCRIPTED_ASSERTIONS_PASS':
  missing.length||generationMissing.length||kbMissing.length?'BLOCKED':notProven.length?'NOT_PROVEN':'FAIL',
  business_oracle:business.every(item=>item.status==='PASS')?'SCOPED_ASSERTIONS_CHECKED':'NOT_PROVEN',
  reading_missing_turns:missing,generation_fixture_missing_turns:generationMissing,kb_fixture_missing_turns:kbMissing,
  actual_failed_runtime_assertions:failures.map(item=>item.id),
  unproven_business_assertions:notProven.map(item=>item.id),
  note:'FAIL includes incomplete original obligations; it is not a claim that every obstacle is an application defect.'};
}
