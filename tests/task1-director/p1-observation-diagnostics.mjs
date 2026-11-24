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
  grounding_verification:reply.metadata?.grounding_verification,
  factual_evidence_coverage:reply.metadata?.factual_evidence_coverage,
  reference_authority:reply.metadata?.reference_authority,kb_request_contract:reply.metadata?.kb_request_contract,
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
  // Only explicit request fields are captured. Headers, credentials and arbitrary
  // RPC bodies never enter observer evidence. These are actual dispatched bodies,
  // not reconstructed queries from the desired answer or the proposed reading.
  kb_requests:(fixture?.requests??[]).filter(request=>request.url.includes('/rag/context-search')).map(request=>({
   query:typeof request.body?.query==='string'?request.body.query:null,
   query_sha256:typeof request.body?.query==='string'?digest(request.body.query):null,
   company_id:request.body?.company_id??null,
   candidate_top_k:request.body?.candidate_top_k??null})),
  persisted_action_requests:(fixture?.requests??[]).filter(request=>request.url.includes('/rpc/')).map(request=>({
   rpc:new URL(request.url).pathname.split('/').at(-1),
   source_message_id:request.body?.p_source_message_id??null,
   company_id:request.body?.p_company_id??request.body?.p_company??null,
   conversation_id:request.body?.p_conversation_id??null})),
  handoff_summaries:handoffs.map(request=>({
   source_message_id:request.body?.p_source_message_id??null,
   conversation_id:request.body?.p_conversation_id??null,
   company_id:request.body?.p_company_id??null,
   summary:request.body?.p_summary??request.body?.p_summary_text??null})),
  readback:{status:tables?'ACTUAL_FIXTURE_TABLES':'UNAVAILABLE',
   state:commerce?structuredClone(commerce.state):null,commerce_revision:commerce?.revision??null,
   commerce_source_message_id:commerce?.source_message_id??null,
   commerce_company_id:commerce?.company_id??null,commerce_conversation_id:commerce?.conversation_id??null,
   memory_revision:memory?.revision??null,memory_source_message_id:memory?.source_message_id??null,
   memory_commerce_revision:memory?.commerce_state_revision??null,
   memory_company_id:memory?.company_id??null,memory_conversation_id:memory?.conversation_id??null,
   memory:memory?structuredClone(memory.memory):null,
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

// Observer checks consume delivered, B2-bound replies and actual persisted
// state. A numeral in source text, a proposed Reading, or an echoed oracle is
// never sufficient. These helpers have no production import and grant no state
// authority; they only test receipts already emitted by the original handler.
const pathValue=(object,path)=>String(path??'').split('.').reduce((value,key)=>
 value&&typeof value==='object'&&Object.hasOwn(value,key)?value[key]:undefined,object);
const replyBound=turn=>!!turn?.reply&&turn.http===200&&
 turn.reply.source_message_id===turn.source_message_id&&
 turn.reply.metadata?.b2_source_message_id===turn.source_message_id&&
 turn.reply.metadata?.b2_expected_company_id===turn.company_id&&
 turn.reply.metadata?.b2_commit_source==='commit_ai_reply_tx'&&
 turn.reply.metadata?.b2_response_hash===digest(turn.reply.content)&&
 turn.reply.content_sha256===digest(turn.reply.content);
const canonicalBound=turn=>turn?.readback?.status==='ACTUAL_FIXTURE_TABLES'&&
 turn.readback.commerce_company_id===turn.company_id&&
 turn.readback.commerce_conversation_id===turn.conversation_id&&
 Number.isSafeInteger(turn.readback.commerce_revision)&&turn.readback.commerce_revision>0;
const sourceTurns=turns=>new Map(turns.filter(turn=>turn.visitor_found&&
 turn.visitor_sha256===turn.utterance_sha256&&turn.utterance_sha256===digest(turn.utterance))
 .map(turn=>[turn.source_message_id,turn]));
// Closed scalar-recap grammar: the whole delivered statement must be a
// quantity label, number and optional source-owned unit. A quoted, negated or
// incidental numeral is not an answer. Other natural prose remains unproven.
const quantityStatement=text=>{
 const match=String(text??'').normalize('NFKC').trim().match(/^(?:Quantity|數量|数量)(?: \([^\n()]+\))?:\s*(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s+([^\n:;.!?。！？；]+))?$/iu);
 return match?{value:Number(match[1].replace(/,/gu,'')),unit:match[2]?.trim()??null}:null;
};

function quantityEvidence(turns,expected,{historical=false}={}){
 const final=turns.at(-1),state=final?.readback?.state,sources=sourceTurns(turns.slice(0,-1));
 const proofs=Array.isArray(final?.reply?.metadata?.recall_provenance)?final.reply.metadata.recall_provenance:[];
 const selections=proofs.filter(proof=>proof.fact_type==='quantity'&&/^entities\.\d+\.quantity$/u.test(proof.state_path??''))
 .map(proof=>({proof,entity:pathValue(state,proof.state_path.replace(/\.quantity$/u,'')),
  value:pathValue(state,proof.state_path)}));
 const unique=[...new Map(selections.map(item=>[item.proof.entity_id,item])).values()];
 const verified=unique.filter(({proof,entity,value})=>entity&&entity.entity_id===proof.entity_id&&
  Number.isFinite(value)&&value>0&&entity.provenance?.source_type==='customer'&&
  entity.provenance.source_message_id===proof.source_message_id&&sources.has(proof.source_message_id)&&
  ['CURRENT_CUSTOMER_MEMORY','CONVERSATION_STATE'].includes(proof.authority)&&
  (historical?['cancelled','deferred'].includes(entity.status):!['cancelled','deferred'].includes(entity.status)));
 const units=[...new Set(verified.map(item=>item.entity.attributes?.unit??null))];
 // Heterogeneous products/units must not be summed into a coincidental expected count.
 const names=[...new Set(verified.map(item=>item.entity.attributes?.product_name??item.entity.category))];
 const total=verified.reduce((sum,item)=>sum+item.value,0);
 const statement=quantityStatement(final?.reply?.content),rendered=statement?.value===expected&&
  (statement.unit===null||units.length===1&&statement.unit===units[0]);
 const pass=replyBound(final)&&canonicalBound(final)&&verified.length>0&&units.length===1&&names.length===1&&
  total===expected&&rendered;
 return {pass,expected,actual:total,rendered,statement,reply_bound:replyBound(final),canonical_bound:canonicalBound(final),
  source_ids:[...sources.keys()],units,names,verified:verified.map(({proof,entity,value})=>({
   entity_id:entity.entity_id,status:entity.status,value,unit:entity.attributes?.unit??null,
   source_message_id:proof.source_message_id,state_path:proof.state_path}))};
}
function kbDispatchEvidence(final){
 const requests=final?.kb_requests??[],bindings=final?.input?.kb?.transport_rebinding??[];
 const allowedTenants=new Set(bindings.map(binding=>String(binding.to_tenant)));
 const valid=requests.filter(request=>typeof request.query==='string'&&request.query.trim()&&
  request.query_sha256===digest(request.query)&&allowedTenants.has(String(request.company_id)));
 return {pass:requests.length>0&&valid.length===requests.length&&final?.kb_dispatch_count===requests.length,
  dispatches:final?.kb_dispatch_count??0,requests,expected_synthetic_tenants:[...allowedTenants]};
}
function transactionStateChecks(turns){
 return turns.map(turn=>{
  const state=turn.readback?.state,entities=state?.entities??[];
  const bad=!!state&&(state.conversion?.order_status==='confirmed'||state.conversion?.payment_status==='paid'||
   state.delivery?.confirmed===true||entities.some(entity=>
    ['confirmed','paid','completed','booked','shipped','delivered','granted'].includes(entity.attributes?.semantic_transaction_state)||
    ['paid','completed'].includes(entity.attributes?.semantic_payment_state)||
    ['confirmed','booked','completed'].includes(entity.attributes?.semantic_booking_state)||
    ['shipped','delivered','completed'].includes(entity.attributes?.semantic_fulfillment_state)));
  return check('transaction_state_boundaries.turn_'+turn.turn,!!turn.readback&&turn.readback.status==='ACTUAL_FIXTURE_TABLES'&&!bad,
   {turn:turn.turn,conversion:state?.conversion??null,delivery:state?.delivery??null,
    entities:entities.map(entity=>({entity_id:entity.entity_id,transaction:entity.attributes?.semantic_transaction_state,
     payment:entity.attributes?.semantic_payment_state,booking:entity.attributes?.semantic_booking_state,
     fulfillment:entity.attributes?.semantic_fulfillment_state}))},'canonical_state_only');
 });
}
function structuredOriginalCheck(key,expected,row,turns){
 const final=turns.at(-1),state=final?.readback?.state,proofs=final?.reply?.metadata?.recall_provenance??[];
 const lineage=final?.reply?.metadata?.citation_lineage,kbKnown=final?.input?.kb?.status==='ORIGINAL_SYNTHETIC_SEED';
 const scope='original_expectation_structured_evidence',id='must.'+key;
 const decide=(pass,evidence)=>({...check(id,pass,evidence,scope),expected});
 const unavailable=(reason,observations=[])=>unknown(id,expected,reason,observations);
 if(key==='merchant_kb_required'){
  const evidence=kbDispatchEvidence(final);
  return decide(expected?evidence.pass:turns.every(turn=>turn.kb_dispatch_count===0),
   expected?evidence:{dispatches:turns.map(turn=>turn.kb_dispatch_count)});
 }
 if(key==='retain_document_id'||key==='retain_chunk_id'){
  const expectedIds=key==='retain_document_id'?final?.input?.kb?.document_ids:final?.input?.kb?.chunk_ids;
  const used=key==='retain_document_id'?[lineage?.selected_document_id]:lineage?.evidence_chunk_ids??[];
  return decide(replyBound(final)&&kbKnown&&kbDispatchEvidence(final).pass&&expectedIds?.includes(expected)&&used.includes(expected),
   {expected,actual:used,fixture_ids:expectedIds??[],reply_bound:replyBound(final),dispatch:kbDispatchEvidence(final)});
 }
 if(key==='customer_value')return decide(quantityEvidence(turns,expected).pass,quantityEvidence(turns,expected));
 if(key==='customer_unit'){
  const count=row.must?.customer_value,quantity=quantityEvidence(turns,count);
  const rendered=quantity.statement?.value===count&&quantity.statement.unit===expected;
  return decide(quantity.pass&&quantity.units.length===1&&quantity.units[0]===expected&&rendered,
   {quantity,expected_unit:expected,unit_attached_to_delivered_quantity:rendered});
 }
 if(key==='prior_source_required'){
  const prior=sourceTurns(turns.slice(0,-1)),selected=proofs.filter(proof=>proof.fact_type==='quantity');
  return decide(replyBound(final)&&canonicalBound(final)&&selected.length>0&&selected.every(proof=>{
   const entity=pathValue(state,String(proof.state_path??'').replace(/\.quantity$/u,''));
   return prior.has(proof.source_message_id)&&entity?.entity_id===proof.entity_id&&
    entity?.provenance?.source_message_id===proof.source_message_id&&entity.provenance.source_type==='customer';
  }),{proofs:selected,prior_source_ids:[...prior.keys()],reply_bound:replyBound(final)});
 }
 if(key==='retained_count'||key==='cancelled_or_deferred_count'){
  const quantity=quantityEvidence(turns,expected,{historical:key==='cancelled_or_deferred_count'});
  return decide(quantity.pass,quantity);
 }
 if(key==='do_not_merge_current_and_future'){
  const current=quantityEvidence(turns,row.must.retained_count),historical=quantityEvidence(turns,row.must.cancelled_or_deferred_count,{historical:true});
  const disjoint=current.verified.every(item=>!historical.verified.some(other=>other.entity_id===item.entity_id));
  const observations=[check('active_and_historical_partitions',current.pass&&historical.pass&&disjoint,
   {current,historical,disjoint},'canonical_state_and_delivered_values')];
  // Matching both numbers is not enough to adjudicate which phrase calls each
  // current or postponed (the wholesale counts can even be equal).
  return unavailable('Canonical partitions and both delivered numbers are checked; an independent lifecycle-label adjudicator is still required.',observations);
 }
 if(key==='answer_known_customer_count'){
  const prior=turns.slice(0,-1).find(turn=>canonicalBound(turn)&&active(turn.readback.state).length===1);
  const expectedCount=prior?active(prior.readback.state)[0].quantity:null;
  return decide(Number.isFinite(expectedCount)&&quantityEvidence(turns,expectedCount).pass,
   {expected_from_prior_canonical_state:expectedCount,quantity:quantityEvidence(turns,expectedCount)});
 }
 if(key==='requery_merchant_price'){
  const dispatch=kbDispatchEvidence(final),coverage=final?.reply?.metadata?.factual_evidence_coverage??[];
  const priceDemand=coverage.some(demand=>Array.isArray(demand.requested_facts)&&demand.requested_facts.some(fact=>['price','current_price','official_price'].includes(fact)));
  return priceDemand?decide(dispatch.pass,{dispatch,coverage}):unavailable(
   'A real tenant-bound query is checked separately; price intent must come from actual structured demand evidence, not a keyword guessed from the expected answer.',
   [check('current_turn_tenant_bound_kb_dispatch',dispatch.pass,dispatch,'actual_kb_dispatch')]);
 }
 if(['no_order_payment_booking_or_entitlement_fabrication','no_confirmed_order','no_shipment_claim'].includes(key)){
  const observations=transactionStateChecks(turns);
  if(observations.some(item=>item.status==='FAIL'))return decide(false,{observations});
  return unavailable('Actual transaction state is checked. State absence cannot prove that the delivered prose makes no false transaction, shipment or entitlement claim.',observations);
 }
 if(key==='no_sku_requirement'){
  const dispatch=kbDispatchEvidence(final),resolved=final?.reply?.metadata?.grounding_verification?.question_resolution==='supported';
  return decide(replyBound(final)&&dispatch.pass&&resolved&&
   (final.reply.metadata.unresolved_fact_fields??[]).length===0,{dispatch,question_resolution:final?.reply?.metadata?.grounding_verification?.question_resolution??null});
 }
 if(['no_live_availability_claim','no_unpublished_moq_or_lead_time_claim','historical_price_is_not_current','no_current_price_without_evidence'].includes(key)){
  const selected={lineage:lineage??null,verification:final?.reply?.metadata?.grounding_verification??null,
   unresolved_fact_fields:final?.reply?.metadata?.unresolved_fact_fields??[],reply_bound:replyBound(final)};
  return unavailable('Requires an independently adjudicated claim set and currentness/source authority for the delivered reply. No claim extractor or approved reviewer fixture is supplied.',
   [check('reply_has_b2_source_and_content_binding',replyBound(final),selected,'delivery_integrity_only')]);
 }
 return unavailable('No complete machine adjudicator exists for this unchanged requirement; do not replace it with keyword presence.');
}

export function businessAssertions(row,turns){
 if(row.kind==='probe')return probeChecks(row,turns);
 const checks=[];
 if(turns.length!==row.turns.length)checks.push(check('all_original_turns_observed',false,
  {expected:row.turns.length,actual:turns.length},'original_denominator'));

 if(typeof row.must==='object')for(const [key,expected] of Object.entries(row.must))checks.push(structuredOriginalCheck(key,expected,row,turns));
 else {
  const failedTurns=turns.filter(turn=>turn.http!==200||turn.reply?.metadata?.generation_success===false||
   turn.reply?.metadata?.execution_failure?.stage==='canonical_validation');
  // A handler-reported terminal failure is an actual unmet business reply, not
  // an opaque NOT_PROVEN. Still do not infer downstream policy/correction PASS.
  if(failedTurns.length)checks.push({...check('must',false,{failed_turns:failedTurns.map(turn=>({
   turn:turn.turn,http:turn.http,route:turn.reply?.metadata?.response_route??null,
   execution_failure:turn.reply?.metadata?.execution_failure??null}))},'actual_terminal_failure'),expected:row.must});
  else checks.push(unknown('must',row.must,'Full source-bound reply meaning has no independent machine adjudicator; keyword presence is insufficient.'));
 }

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
 const businessFailures=business.filter(item=>item.status==='FAIL');
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
  actual_failed_business_assertions:businessFailures.map(item=>item.id),
  business_obligations:business.length,
  business_checks_implemented:business.filter(item=>['PASS','FAIL'].includes(item.status)).length,
  business_checks_passed:business.filter(item=>item.status==='PASS').length,
  business_checks_failed:businessFailures.length,
  business_checks_unproven:notProven.length,
  unproven_business_assertions:notProven.map(item=>item.id),
  note:'FAIL includes incomplete original obligations; it is not a claim that every obstacle is an application defect.'};
}


/** Completeness is checked by exact IDs, modes, turns and original utterance
 * hashes, not by row count alone. Missing/duplicate/timeout rows stay in the
 * denominator; successful probes never fill a business-row gap. */
export function summarizeObservationEvidence(expectedRows,records){
 const expected=new Map(expectedRows.map(row=>[row.id,row])),seen=new Map();
 const failures=[],unknownIds=[];
 for(const record of records){
  if(!expected.has(record.id)){unknownIds.push(record.id);continue;}
  const bucket=seen.get(record.id)??[];bucket.push(record);seen.set(record.id,bucket);
 }
 let expectedModes=0,actualModes=0,expectedTurns=0,actualTurns=0,implemented=0,passed=0,failed=0,unproven=0;
 const missingIds=[],duplicateIds=[],businessRows=[],probeRows=[];
 for(const row of expectedRows){
  const modes=row.kind==='probe'?['scripted']:['no_reading','scripted'],matches=seen.get(row.id)??[];
  expectedModes+=modes.length;expectedTurns+=row.turns.length*modes.length;
  if(!matches.length){missingIds.push(row.id);continue;}
  if(matches.length!==1){duplicateIds.push(row.id);continue;}
  const record=matches[0];
  const extraModes=Object.keys(record.modes??{}).filter(mode=>!modes.includes(mode));
  if(extraModes.length)failures.push({id:row.id,reason:'unexpected_modes',modes:extraModes});
  for(const name of modes){
   const mode=record.modes?.[name];
   if(!mode){failures.push({id:row.id,mode:name,reason:'missing_mode'});continue;}
   actualModes++;
   const turns=Array.isArray(mode.turns)?mode.turns:[];
   actualTurns+=turns.length;
   if(turns.length!==row.turns.length||mode.expected_turns!==row.turns.length||mode.executed_turns!==turns.length)
    failures.push({id:row.id,mode:name,reason:'turn_count_mismatch',expected:row.turns.length,actual:turns.length});
   for(const [index,turn] of turns.entries())if(turn.turn!==index+1||
    turn.utterance!==row.turns[index]||turn.utterance_sha256!==digest(row.turns[index]??''))
     failures.push({id:row.id,mode:name,turn:index+1,reason:'original_turn_identity_mismatch'});
   for(const assertion of mode.business_assertions??[]){
    if(['PASS','FAIL'].includes(assertion.status))implemented++;
    if(assertion.status==='PASS')passed++;
    else if(assertion.status==='FAIL')failed++;
    else unproven++;
   }
  }
  const allModes=modes.map(name=>record.modes?.[name]);
  const scripted=record.modes?.scripted;
  const summary={id:row.id,scripted_scoped_pass:scripted?.status==='PASS',
   scripted_business_pass:scripted?.business_assertions?.length>0&&scripted.business_assertions.every(assertion=>assertion.status==='PASS'),scoped_pass:allModes.length===modes.length&&allModes.every(mode=>mode?.status==='PASS'),
   business_pass:allModes.length===modes.length&&allModes.every(mode=>mode?.business_assertions?.length>0&&mode.business_assertions.every(assertion=>assertion.status==='PASS')),
   unresolved:allModes.flatMap(mode=>(mode?.business_assertions??[]).filter(assertion=>assertion.status!=='PASS').map(assertion=>assertion.id))};
  (row.kind==='probe'?probeRows:businessRows).push(summary);
 }
 const complete=expected.size===expectedRows.length&&missingIds.length===0&&duplicateIds.length===0&&unknownIds.length===0&&failures.length===0&&
  records.length===expectedRows.length&&expectedModes===actualModes&&expectedTurns===actualTurns;
 return {complete,expected_rows:expectedRows.length,unique_observed_rows:seen.size,missing_ids:missingIds,
  duplicate_ids:duplicateIds,unexpected_ids:unknownIds,identity_failures:failures,
  expected_modes:expectedModes,executed_modes:actualModes,expected_turns:expectedTurns,executed_turns:actualTurns,
  business_assertions:{implemented,passed,failed,unproven},
  original_business_rows:{expected:expectedRows.filter(row=>row.kind!=='probe').length,
   observed:businessRows.length,scoped_pass:businessRows.filter(row=>row.scoped_pass).length,
   all_business_checks_pass:businessRows.filter(row=>row.business_pass).length,
   scripted_scoped_pass:businessRows.filter(row=>row.scripted_scoped_pass).length,
   scripted_business_checks_pass:businessRows.filter(row=>row.scripted_business_pass).length,
   incomplete_ids:businessRows.filter(row=>!row.business_pass).map(row=>row.id)},
  independent_probe_rows:{expected:expectedRows.filter(row=>row.kind==='probe').length,
   observed:probeRows.length,scoped_pass:probeRows.filter(row=>row.scoped_pass).length},
  // This aggregate cannot grant real-model/Hosted or semantic prose acceptance.
  full_oracle:'NOT_PROVEN'};
}
