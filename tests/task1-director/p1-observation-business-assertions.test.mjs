/** Observer-only adversarial controls. No application fixture, original oracle,
 * semantic reading, merchant document or original test is modified here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {businessAssertions,snapshot,summarizeObservationEvidence,readBoundB2Diagnostic} from './p1-observation-diagnostics.mjs';
import {digest,loadObservationCases,buildTurnInput} from './p1-observation-fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const updateReply=(turn,content)=>{
 turn.reply.content=content;turn.reply.content_sha256=digest(content);
 turn.reply.metadata.b2_response_hash=digest(content);
};
function quantityCase(){
 const source='source-initial',question='source-question',company='company',ticket='ticket';
 const state={entities:[{entity_id:'item',category:'generic',quantity:3,status:'tentative',
  attributes:{product_name:'notebook',unit:'units'},provenance:{source_type:'customer',source_message_id:source}}],
  conversion:{order_status:'none',payment_status:'none'},delivery:{confirmed:false}};
 const turn=(id,utterance)=>({turn:id===source?1:2,source_message_id:id,company_id:company,conversation_id:ticket,
  visitor_found:true,visitor_sha256:digest(utterance),utterance,utterance_sha256:digest(utterance),http:200,kb_dispatch_count:0,
  input:{reading:{status:'SCRIPTED_PROPOSAL'},kb:{status:'ORIGINAL_SYNTHETIC_SEED',transport_rebinding:[{to_tenant:'34'}]},generation:{status:'NOT_SUPPLIED'}},
  readback:{status:'ACTUAL_FIXTURE_TABLES',state:structuredClone(state),commerce_revision:1,
   commerce_company_id:company,commerce_conversation_id:ticket},assertions:[],
  reply:{source_message_id:id,content:'',content_sha256:'',metadata:{b2_source_message_id:id,b2_expected_company_id:company,
   b2_commit_source:'commit_ai_reply_tx',b2_response_hash:'',recall_provenance:[]}}});
 const turns=[turn(source,'I need 3 units of notebook.'),turn(question,'How many notebook units did I request?')];
 updateReply(turns[0],'Your request was recorded.');updateReply(turns[1],'quantity: 3 units');
 turns[1].reply.metadata.recall_provenance=[{fact_type:'quantity',state_path:'entities.0.quantity',entity_id:'item',
  authority:'CURRENT_CUSTOMER_MEMORY',source_message_id:source}];
 const row={id:'case',kind:'synthetic',turns:turns.map(item=>item.utterance),
  must:{customer_value:3,customer_unit:'units',prior_source_required:true,merchant_kb_required:false}};
 return {row,turns};
}
const statuses=(row,turns)=>Object.fromEntries(businessAssertions(row,turns).map(check=>[check.id,check.status]));
test('Delivered quantity and unit need canonical path, prior source and exact B2 reply binding',()=>{
 const {row,turns}=quantityCase();assert(Object.values(statuses(row,turns)).every(status=>status==='PASS'));
});
test('Correct stored count cannot hide a missing unit in the delivered answer',()=>{
 const {row,turns}=quantityCase();updateReply(turns[1],'quantity: 3');
 const results=statuses(row,turns);assert.equal(results['must.customer_value'],'PASS');
 assert.equal(results['must.customer_unit'],'FAIL');
});
test('A numeral embedded in a different value cannot satisfy the reply quantity',()=>{
 const {row,turns}=quantityCase();updateReply(turns[1],'quantity: 3003 units');
 assert.equal(statuses(row,turns)['must.customer_value'],'FAIL');
});
test('A negated or quoted copy of the expected numeral is not a supported numeric answer',()=>{
 for(const text of ['It is not 3 units.','You asked for 3 units; the current quantity is 5 units.','"Quantity: 3 units"','Quantity: 3 units\nActually: 5 units']){
  const {row,turns}=quantityCase();updateReply(turns[1],text);
  assert.equal(statuses(row,turns)['must.customer_value'],'FAIL');
 }
});
test('Wrong source, tenant, entity or reply hash cannot earn quantity PASS',()=>{
 for(const mutate of [
  t=>t.reply.metadata.recall_provenance[0].source_message_id='another-source',
  t=>t.readback.commerce_company_id='another-company',
  t=>t.reply.metadata.recall_provenance[0].entity_id='another-entity',
  t=>t.reply.metadata.b2_response_hash='forged',
  t=>t.readback.state.entities[0].provenance.source_type='system',
 ]){
  const {row,turns}=quantityCase();mutate(turns[1]);
  assert.equal(statuses(row,turns)['must.customer_value'],'FAIL');
 }
});
test('An unrelated mixed-product sum cannot coincidentally satisfy the original requested count',()=>{
 const {row,turns}=quantityCase(),final=turns[1];
 final.readback.state.entities[0].quantity=2;
 final.readback.state.entities.push({...structuredClone(final.readback.state.entities[0]),entity_id:'other',quantity:1,
  attributes:{product_name:'another-product',unit:'units'}});
 final.reply.metadata.recall_provenance.push({...final.reply.metadata.recall_provenance[0],entity_id:'other',state_path:'entities.1.quantity'});
 assert.equal(statuses(row,turns)['must.customer_value'],'FAIL');
});
test('Stored state alone cannot certify a customer-facing answer',()=>{
 const {row,turns}=quantityCase();turns[1].reply.metadata.recall_provenance=[];
 assert.equal(statuses(row,turns)['must.customer_value'],'FAIL');
});
test('Actual KB query and tenant are required; cited oracle names alone cannot pass',()=>{
 const {row,turns}=quantityCase(),final=turns[1];row.must={merchant_kb_required:true,retain_document_id:'doc',retain_chunk_id:'chunk'};
 final.kb_dispatch_count=1;final.kb_requests=[{query:'a policy query',query_sha256:digest('a policy query'),company_id:'other-tenant'}];
 final.input.kb.document_ids=['doc'];final.input.kb.chunk_ids=['chunk'];
 final.reply.metadata.citation_lineage={selected_document_id:'doc',evidence_chunk_ids:['chunk']};
 assert(Object.values(statuses(row,turns)).every(status=>status==='FAIL'));
 final.kb_requests[0].company_id='34';assert(Object.values(statuses(row,turns)).every(status=>status==='PASS'));
});
test('Policy prose copied from the frozen oracle remains unproven without independent semantic evidence',()=>{
 const {turns}=quantityCase(),row={id:'text',kind:'sourced',turns:turns.map(turn=>turn.utterance),
  must:'Use the published rule and explain the customer next step.',must_not:'Invent a refund.'};
 updateReply(turns[1],row.must+' '+row.must_not);
 assert.deepEqual(businessAssertions(row,turns).map(item=>item.status),['NOT_PROVEN','NOT_PROVEN']);
});
test('An actual terminal failure is an unmet business reply even if output repeats the oracle',()=>{
 const {turns}=quantityCase(),row={id:'text',kind:'sourced',turns:turns.map(turn=>turn.utterance),must:'Give a supported answer.'};
 turns[0].reply.metadata.generation_success=false;
 assert.equal(statuses(row,turns).must,'FAIL');
});
function record(row,turns){return {id:row.id,modes:Object.fromEntries(['no_reading','scripted'].map(mode=>[mode,{
 status:'FAIL',business_assertions:businessAssertions(row,turns),expected_turns:row.turns.length,executed_turns:turns.length,turns}]))};}
test('Equal row count with one duplicate and one missing original ID is incomplete',()=>{
 const {row,turns}=quantityCase(),other={...row,id:'other'};
 const result=summarizeObservationEvidence([row,other],[record(row,turns),record(row,turns)]);
 assert.equal(result.complete,false);assert.deepEqual(result.missing_ids,['other']);assert.deepEqual(result.duplicate_ids,['case']);
 assert.equal(result.expected_turns,8);assert.equal(result.full_oracle,'NOT_PROVEN');
});
test('Dropped timeout turns and mutated original utterances remain in the denominator',()=>{
 const {row,turns}=quantityCase(),r=record(row,turns);
 r.modes.scripted.turns=[structuredClone(turns[0])];r.modes.scripted.executed_turns=1;
 r.modes.no_reading.turns[1]={...turns[1],utterance:'Changed input'};
 const result=summarizeObservationEvidence([row],[r]);
 assert.equal(result.complete,false);assert.equal(result.expected_turns,4);assert.equal(result.executed_turns,3);
 assert(result.identity_failures.some(item=>item.reason==='turn_count_mismatch'));
 assert(result.identity_failures.some(item=>item.reason==='original_turn_identity_mismatch'));
});
test('Original 60+7 IDs and the three-colleagues P3 sentence are unchanged',()=>{
 const {rows}=loadObservationCases(fs,root);assert.equal(rows.length,67);assert.equal(new Set(rows.map(row=>row.id)).size,67);
 assert.equal(rows.find(row=>row.id==='P3').turns[0],'我想訂蛋糕畀三位同事慶祝，預算500元，請介紹有咩款式。');
 assert.equal(rows.find(row=>row.id==='P3').reading.quantity,null);
});
test('Actual request evidence excludes secret-bearing extra fields and arbitrary RPC payloads',()=>{
 const f={tables:{conversations:[{id:'ticket',company_id:'company'}],messages:[]},commits:[],requests:[{
  url:'https://fixture.invalid/rag/context-search',body:{query:'policy',company_id:'34',api_key:'DO_NOT_CAPTURE'}},{
  url:'https://fixture.invalid/rest/v1/rpc/commit_ai_reply_tx',body:{p_conversation_id:'ticket',secret:'DO_NOT_CAPTURE'}}]};
 const observed=snapshot(f,{status:200,body:{}},'source');
 assert.equal(observed.kb_requests[0].query,'policy');assert.equal(observed.kb_requests[0].query_sha256,digest('policy'));
 assert(!JSON.stringify(observed).includes('DO_NOT_CAPTURE'));
});


test('Compound partition observer checks delivered labels and both canonical paths even when counts are equal',()=>{
 const {turns}=quantityCase(),source=turns[0].source_message_id,final=turns[1],id='item',childId=id+':unit-status:'+source;
 const parent={entity_id:id,category:'generic',quantity:60,status:'tentative',
  attributes:{product_name:'notebook',unit:'units',quantity_basis:'customer_explicit'},
  constraints:{customer_inactive_unit_count:60,customer_inactive_unit_status:'deferred'},
  provenance:{source_type:'customer',source_message_id:source}};
 const child={...structuredClone(parent),entity_id:childId,status:'deferred',
  attributes:{...parent.attributes,customer_part_of_entity_id:id,customer_unit_partition:'source_bound_status'},
  constraints:{source_bound_partial_unit:true}};
 const state={...turns[0].readback.state,entities:[parent,child]};
 for(const t of turns){t.readback.state=structuredClone(state);t.readback.commerce_source_message_id=source;
  t.readback.memory_company_id=t.company_id;t.readback.memory_conversation_id=t.conversation_id;
  t.readback.memory_commerce_revision=t.readback.commerce_revision;t.readback.commerce_commit_for_this_source=false;}
 const proof=(fact_type,state_path,entity_id,temporal_scope)=>({fact_type,state_path,entity_id,temporal_scope,
  authority:'CANONICAL_COMMERCE_STATE',source_kind:'canonical_partial_unit_partition',source_message_id:source,
  ...(fact_type==='quantity'?{quantity_unit_source_kind:'canonical_customer_attribute',quantity_unit_source_message_id:source}:{})});
 final.reply.metadata.recall_provenance=[proof('quantity','entities.0.quantity',id,'current'),
  proof('quantity','entities.1.quantity',childId,'excluded'),proof('entity_status','entities.1.status',childId,'excluded')];
 updateReply(final,'Recorded your requirements for notebook: retained 60 units; deferred requirement: 60 units.');
 const row={id:'partition',kind:'synthetic',turns:turns.map(t=>t.utterance),
  must:{retained_count:60,cancelled_or_deferred_count:60,do_not_merge_current_and_future:true}};
 assert.deepEqual(Object.values(statuses(row,turns)),['PASS','PASS','PASS']);
 // Same canonical pair in the exact Chinese renderer grammar, including NFKC colons.
 for(const statement of ['已記錄你嘅notebook要求：保留 60 units；暫緩嘅要求：60 units。','已记录你的notebook需求：保留 60 units；暂缓的需求：60 units。']){
  updateReply(final,statement);assert.deepEqual(Object.values(statuses(row,turns)),['PASS','PASS','PASS']);
  updateReply(final,statement+' Order confirmed.');assert(Object.values(statuses(row,turns)).every(s=>s==='FAIL'));
 }
 updateReply(final,'Recorded your requirements for notebook: retained 60 units; deferred requirement: 60 units.');
 for(const mutate of [
  t=>updateReply(t,'Recorded your requirements for notebook: retained 60 units; cancelled requirement: 60 units.'),
  t=>updateReply(t,'Recorded your requirements for notebook: retained 120 units; deferred requirement: 60 units.'),
  t=>updateReply(t,'Recorded your requirements for notebook: retained 60 units; deferred requirement: 60 cartons.'),
  t=>updateReply(t,t.reply.content+' Order confirmed.'),
  t=>t.reply.metadata.recall_provenance[1].temporal_scope='current',
  t=>t.reply.metadata.recall_provenance[0].entity_id=childId,
  t=>t.reply.metadata.recall_provenance[2].source_message_id='foreign',
  t=>t.readback.commerce_revision++,
  t=>t.kb_dispatch_count=1,t=>t.readback.state.entities[1].attributes.customer_part_of_entity_id='foreign',
 ]){const wrong=structuredClone(turns);mutate(wrong[1]);assert(Object.values(statuses(row,wrong)).every(s=>s==='FAIL'));}
});

test('R2 archived wholesale KB retains actual document/chunk and does not invent MOQ or price',()=>{
 const {rows}=loadObservationCases(fs,root),row=rows.find(r=>r.id==='SYNTHETIC-b2b-wholesale-merchant-topic');
 const input=buildTurnInput(row,0,'scripted',fs,root),d=input.options.originalRagResponse.selected_documents[0];
 assert.equal(input.proof.kb.source_blob_sha,'d3550b84e723729f42f2deb099b13167e52634af');
 assert.equal(d.document_id,'synthetic-b2b-wholesale-instructions-v1');
 assert.equal(d.evidence[0].chunk_id,'synthetic-b2b-wholesale-instructions-v1-c1');
 assert.equal(d.authority.tenant_id,'34');assert.equal(d.authority.currentness,'unknown');
 assert.equal(d.evidence[0].content,'This synthetic wholesale desk accepts quotation enquiries after confirming product specification, requested carton quantity and delivery region. No minimum order quantity, current price, available stock, confirmed lead time, payment, shipment or binding quotation is supplied by this fixture.');
 assert.equal(input.proof.kb.response_sha256,digest(input.options.originalRagResponse));
});
test('R2 archived sourced stubs preserve scope and absent rescheduling rule',()=>{
 const {rows}=loadObservationCases(fs,root),get=(id,t,mode='scripted')=>buildTurnInput(rows.find(r=>r.id===id),t,mode,fs,root);
 const r=get('RT-02',1);assert.equal(r.proof.kb.source_blob_sha,'cb23ce9ec793415bd17e454e4492ea074c0c1c7c');
 assert.deepEqual(r.proof.kb.chunk_ids,['R-K2','R-K1']);
 assert.equal(r.options.originalRagResponse.selected_documents[0].evidence[0].content,'訂造及傢俬貨品尺寸容差為 ±2 厘米。');
 const rt=get('RT-05',0);assert.equal(rt.proof.kb.status,'ORIGINAL_SYNTHETIC_NO_MATCH');assert.deepEqual(rt.options.originalRagResponse.selected_documents,[]);assert.equal(rt.options.originalRagResponse.context_found,false);
 const neg=get('RT-02',1,'no_reading');assert.equal(neg.options.semanticRaw,'');assert.equal(neg.proof.reading.status,'MISSING_READING_NEGATIVE');assert.deepEqual(neg.options.originalRagResponse,r.options.originalRagResponse);
 for(const row of rows.filter(r=>r.kind==='sourced_synthetic_kb'))for(let t=0;t<row.turns.length;t++){
  const i=buildTurnInput(row,t,'scripted',fs,root);assert.equal(i.proof.kb.source_group,row.id.split('-')[0]);assert.equal(i.proof.kb.source_blob_sha,'cb23ce9ec793415bd17e454e4492ea074c0c1c7c');
  for(const d of i.options.originalRagResponse.selected_documents)assert(d.document_id.startsWith('synthetic-sourced-'+row.id.split('-')[0].toLowerCase()+'-'));
 }
});

test('R2 source-bound scripted generation is present only for exact selected scripted input, not empty/wrong Reading',()=>{
 const {rows}=loadObservationCases(fs,root);let count=0;const keys=[];
 for(const row of rows)for(let t=0;t<row.turns.length;t++){
  const pos=buildTurnInput(row,t,'scripted',fs,root),neg=buildTurnInput(row,t,'no_reading',fs,root);
  assert.equal(neg.options.answer,'');assert.equal(neg.options.verifierGrounded,false);
  assert.equal(neg.proof.generation.status,'NOT_SUPPLIED');
  if(pos.proof.generation.status==='SCRIPTED_DRAFT_AND_REVIEWER_NOT_REAL_MODEL'){
   count++;keys.push(row.id+':'+t);assert.equal(pos.proof.generation.source_quote,row.turns[t]);
   assert.equal(pos.proof.generation.answer_sha256,digest(pos.options.answer));
   assert.equal(pos.proof.generation.reviewer_sha256,digest(pos.options.verifierResponses[0]));
   assert(pos.proof.generation.required_chunk_ids.every(id=>pos.proof.kb.chunk_ids.includes(id)));
   assert.equal(pos.options.verifierGrounded,false,'no permissive default reviewer');
   const altered=structuredClone(row);altered.turns[t]+=' altered source';
   assert.throws(()=>buildTurnInput(altered,t,'scripted',fs,root));
  }
 }
 assert.equal(count,25);
 assert.deepEqual(keys.sort(),["BE-04:1","BE-05:2","ED-02:1","ED-03:1","ED-05:1","FB-01:0","FB-01:1","FB-02:1","P1:0","P2:0","R1:0","R2:0","R3:0","RT-02:1","SA-04:2","SYNTHETIC-b2b-wholesale-merchant-topic:0","SYNTHETIC-b2b-wholesale-mixed-known-unknown:2","SYNTHETIC-beauty-merchant-topic:0","SYNTHETIC-education-merchant-topic:0","SYNTHETIC-restaurant-merchant-topic:0","SYNTHETIC-retail-merchant-topic:0","SYNTHETIC-retail-mixed-known-unknown:2","SYNTHETIC-saas-merchant-topic:0","WH-01:1","WH-05:1"].sort());
});

test('B2 observer decodes only the exact scoped safe diagnostic, not raw payload or delivery proof',()=>{
 const scope={company_id:'company',conversation_id:'ticket',source_message_id:'source'};
 const row={kb_source:'protected_pipeline_diagnostic',conversation_id:'ticket',message_id:'source',
  retrieved_chunks:{contract:'c3-protected-pipeline-evidence-v1',stage:'b2_verdict',company_id:'company',source_message_id:'source',
   payload:{capture_state:'WITHHELD_SENSITIVE',decision:{decision:'allow',code:'FAKE_RAW'},raw:'DO_NOT_CAPTURE'},
   decision_receipt:{contract:'c3-gate-reason-v1',gate:'b2',outcome:'rejected',fired_condition:'KNOWN_CONTEXT_RECONFIRMATION',
    source_binding:{...scope,state_revision:2},capture_state:'WITHHELD_SENSITIVE',commit_confirmed:false}}};
 const positive=readBoundB2Diagnostic(row,scope);
 assert.deepEqual(positive,{decision:'block',code:'KNOWN_CONTEXT_RECONFIRMATION',committed:false,
  receipt_status:'SOURCE_BOUND_GATE_DIAGNOSTIC',state_revision:2,not_persisted_reply_proof:true});
 for(const mutate of [
  r=>r.message_id='other',r=>r.conversation_id='other',r=>r.retrieved_chunks.company_id='other',
  r=>r.retrieved_chunks.source_message_id='other',r=>r.retrieved_chunks.contract='legacy',
  r=>r.retrieved_chunks.decision_receipt.source_binding.company_id='other',
  r=>r.retrieved_chunks.decision_receipt.source_binding.source_message_id='other',
  r=>r.retrieved_chunks.decision_receipt.source_binding.conversation_id='other',
  r=>r.retrieved_chunks.decision_receipt.source_binding.state_revision=-1,
  r=>r.retrieved_chunks.decision_receipt.gate='other',r=>r.retrieved_chunks.decision_receipt.commit_confirmed=true,
  r=>delete r.retrieved_chunks.decision_receipt,r=>r.retrieved_chunks.payload.capture_state='CAPTURED',
 ]){const copy=structuredClone(row);mutate(copy);assert.deepEqual(readBoundB2Diagnostic(copy,scope),
  {decision:null,code:null,committed:null,receipt_status:'NOT_CAPTURED'});}
 const allowed=structuredClone(row);allowed.retrieved_chunks.decision_receipt.outcome='accepted';
 allowed.retrieved_chunks.decision_receipt.fired_condition='B2_ALLOW';allowed.retrieved_chunks.decision_receipt.commit_confirmed=true;
 assert.equal(readBoundB2Diagnostic(allowed,scope).not_persisted_reply_proof,true);
 const unknown=structuredClone(row);unknown.retrieved_chunks.decision_receipt.outcome='NOT_CAPTURED';
 unknown.retrieved_chunks.decision_receipt.fired_condition='NOT_CAPTURED';unknown.retrieved_chunks.decision_receipt.commit_confirmed=null;
 assert.equal(readBoundB2Diagnostic(unknown,scope).decision,null);assert.equal(readBoundB2Diagnostic(unknown,scope).code,null);
 const observed=snapshot({tables:{conversations:[{id:'ticket',company_id:'company'}],messages:[],rag_trace:[row]},requests:[],commits:[]},{status:409,body:{}},'source');
 assert.deepEqual(observed.b2_verdicts,[positive]);assert.equal(observed.reply,null);assert(!JSON.stringify(observed).includes('DO_NOT_CAPTURE'));
});
