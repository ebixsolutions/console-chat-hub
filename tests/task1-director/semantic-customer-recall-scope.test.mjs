import { mkdtempSync, existsSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reduceTurn, buildCommerceEntityHints } from '../../supabase/functions/_shared/commerce-state-runtime-base.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareConversationRecall} from '../../supabase/functions/_shared/conversation-recall.ts';
import {createEmptyConversationCommerceState} from '../../supabase/functions/_shared/commerce-state-contract.ts';
import {buildCanonicalConversationMemory} from '../../supabase/functions/_shared/conversation-long-memory.ts';
import {resolveIndustryRuntime as d4ResolveIndustryRuntime} from '../../supabase/functions/_shared/industry-runtime-adapter.ts';
const scope={company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:'current-turn'};
function fixture({question='What budget did I mention?',key='budget',value=5000,source='My budget is 5000.',entity_id=null,subjects=[],entities=[],newer=[],emptyRequested=false}={}) {
 const state=createEmptyConversationCommerceState();state.entities=entities;
 const memory=buildCanonicalConversationMemory({...scope,commerce_state_revision:2,commerce_state:state,
  newest_first:[{id:'current-turn',role:'visitor',content:question,created_at:'2026-11-19T05:03:00Z'},...newer.map((content,i)=>({id:'newer-'+i,role:'visitor',content,created_at:'2026-11-19T05:02:00Z'})),{id:'original-source',role:'visitor',content:source,created_at:'2026-11-19T05:01:00Z'}],
  source_created_at:'2026-11-19T05:03:00Z',visitor_turn_count:2+newer.length,next_memory_revision:3});
 memory.current_customer_facts=[{key,value,authority:'customer',entity_id,source_message_id:'original-source'}];
 memory.cancelled_or_superseded=[];
 return {...scope,question,memory,commerce:{...scope,source_message_id:'original-source',revision:2,state},
  customer_recall_proposal:{...scope,intent:'customer_fact_recall',requested_facts:emptyRequested?[]:[key],subject_refs:subjects},
  trusted_visitor_source_status:'verified',
  trusted_visitor_source_rows:[...newer.map((content,i)=>({id:'newer-'+i,content})),{id:'original-source',content:source}]};
}
const entity=(name,qty,id)=>({entity_id:id,category:'generic_item',model:null,quantity:qty,status:'tentative',attributes:{product_name:name,unit:'units'},constraints:{},provenance:{source_type:'customer',source_message_id:'original-source'}});
const positives=[
 ['quantity-tw',{source:'我要三部冷氣。',question:'我剛剛說要幾部冷氣？',key:'quantity',value:3}],
 ['quantity-hk',{source:'我要三部冷氣。',question:'我啱啱話要幾多部？',key:'quantity',value:3}],
 ['quantity-en',{source:'I need 3 units.',question:'How many units did I ask for just now?',key:'quantity',value:3}],
 ['restaurant',{source:'我想訂三位。',question:'我之前話要訂幾多位？',key:'quantity',value:3}],
 ['beauty',{source:'我要三個療程。',question:'我之前提過要幾多個療程？',key:'quantity',value:3}],
 ['budget-hk',{source:'我嘅預算係5000。',question:'我頭先講嘅預算係幾多？'}],
 ['budget-en',{}],
 ['budget-associated-not-other-count',{source:'My budget is 2000 for 3 people.',value:2000}],
 ['budget-currency',{source:'My budget is HK$5,000.'}],
 ['date-request',{source:'我想預約2026-12-03。',question:'Which date did I request?',key:'preferred_date',value:'2026-12-03'}],
 ['date-preferred',{source:'My preferred date is 2026-12-03.',question:'Which date did I request?',key:'preferred_date',value:'2026-12-03'}],
 ['name-call-me',{source:'Please call me Morgan.',question:'Remind me of my name.',key:'name',value:'Morgan'}],
 ['name-my-own',{source:'My name is Morgan.',question:'What is my name?',key:'customer_name',value:'Morgan'}],
 ['preference',{source:'我偏好安靜的環境。',question:'我剛剛提過甚麼偏好？',key:'preferences',value:'安靜的環境'}],
 ['time',{source:'My preferred time is 14:30.',question:'What time did I request?',key:'preferred_time',value:'14:30'}],
 ['size',{source:'My preferred size is L.',question:'What size did I request?',key:'preferred_size',value:'L'}],
 ['known-subject',{source:'I requested a quantity of 3 units for Product A.',question:'Remind me of the quantity I requested for Product A.',key:'quantity',value:3,entity_id:'entity-a',entities:[entity('Product A',3,'entity-a'),entity('Product B',5,'entity-b')]}],
 ['newer-unrelated-field',{source:'I requested 3 units.',question:'How many units did I ask for?',key:'quantity',value:3,newer:['My budget is 5000.']}],
 ['newer-acknowledgment',{newer:['Thank you.']}],
 ['newer-other-entity',{source:'I requested a quantity of 3 units for Product A.',question:'Remind me of the quantity I requested for Product A.',key:'quantity',value:3,entity_id:'entity-a',entities:[entity('Product A',3,'entity-a'),entity('Product B',5,'entity-b')],newer:['Correction: Product B quantity is 6 units.']}],
];
const negatives=[
 ['budget-other-owner',{source:"My assistant's budget is 5000."}],
 ['size-other-owner',{source:"My assistant's size is L.",question:'What is my size?',key:'preferred_size',value:'L'}],
 ['budget-is-other-count',{source:'預算未定但我需要5000個樣品',question:'我頭先講嘅預算係幾多？'}],
 ['budget-is-headcount',{source:'My budget is 2000 for 3 people.',value:3}],
 ['budget-is-historical',{source:'我預算係2000但之前講5000作比較',question:'我目前提供嘅預算係幾多？'}],
 ['budget-negated',{source:'My budget is not 5000.'}],
 ['date-expiry',{source:'The rental ended on 2026-12-03.',question:'Which date did I request?',key:'preferred_date',value:'2026-12-03'}],
 ['date-labeled-expiry',{source:'My rental expiry date is 2026-12-03.',question:'Which date did I request?',key:'preferred_date',value:'2026-12-03'}],
 ['time-merchant-hours',{source:'The opening time is 14:30.',question:'What time did I request?',key:'preferred_time',value:'14:30'}],
 ['name-other-person',{source:"My assistant's name is Morgan.",question:'What is my name?',key:'customer_name',value:'Morgan'}],
 ['name-product',{source:'The product name is Morgan.',question:'What is my name?',key:'name',value:'Morgan'}],
 ['name-negated',{source:'Do not call me Morgan.',question:'What is my name?',key:'name',value:'Morgan'}],
 ['wrong-known-subject',{source:'I requested a quantity of 3 units for Product A.',question:'Remind me of the quantity I requested for Product B.',key:'quantity',value:3,entity_id:'entity-a',entities:[entity('Product A',3,'entity-a'),entity('Product B',5,'entity-b')]}],
 ['unknown-explicit-subject',{source:'I requested a quantity of 3 units for Product A.',question:'Remind me of the quantity I requested for Product B.',key:'quantity',value:3,entity_id:'entity-a',entities:[entity('Product A',3,'entity-a')]}],
 ['multiple-entities-no-subject',{source:'I requested a quantity of 3 units for Product A.',question:'Remind me of my quantity.',key:'quantity',value:3,entity_id:'entity-a',entities:[entity('Product A',3,'entity-a'),entity('Product B',5,'entity-b')]}],
 ['newer-correction',{source:'I requested 3 units.',question:'How many units did I ask for just now?',key:'quantity',value:3,newer:['Correction: I now need 5 units instead of 3 units.']}],
 ['newer-cancellation',{source:'I requested 3 units.',question:'How many units did I ask for just now?',key:'quantity',value:3,newer:['Cancel the previous request for 3 units.']}],
 ['newer-unresolved-correction',{newer:['Change that to 2000.']}],
 ['same-source-later-correction',{source:'My budget is 5000. My budget is now 2000.'}],
 ['same-clause-later-correction',{source:'My budget is 5000 but now 2000.'}],
];
for(const emptyRequested of [false,true]) {
 for(const [id,options] of positives)test(`semantic source association positive ${id} requested=${!emptyRequested}`,()=>{
  const input=fixture({...options,emptyRequested}), result=prepareConversationRecall(input,'en');
  assert.equal(result.decision.handled,true,JSON.stringify(result));assert.equal(result.decision.value,input.memory.current_customer_facts[0].value);
  assert.equal(result.decision.provenance.evidence[0].evidence_source_message_id,'original-source');
 });
 for(const [id,options] of negatives)test(`semantic source association rejects ${id} requested=${!emptyRequested}`,()=>{
  const result=prepareConversationRecall(fixture({...options,emptyRequested}),'en');assert.equal(result.decision.handled,false,JSON.stringify(result));
 });
}
for(const action of ['Cancel my subscription.','Buy that one for me.','Please pause my plan.','Could you reserve a table?','Schedule it for tomorrow.','Please renew my subscription.','Remove Product A.','Upgrade my plan.','Set the quantity to 5.','幫我book埋星期六。','請幫我取消訂閱。','同埋幫我下單。','先暫停服務。','and book it for tomorrow.'])test(`mixed action cannot be scalar recall: ${action}`,()=>{
 const result=prepareConversationRecall(fixture({question:'What budget did I mention? '+action}),'en');assert.equal(result.decision.handled,false,JSON.stringify(result));assert.equal(result.decision.reason,'CURRENT_KB_REQUIRED');assert.equal(result.reply,null);
});
for(const [id,mutate] of [
 ['proposal foreign tenant',i=>i.customer_recall_proposal.company_id='foreign'],
 ['memory foreign tenant',i=>i.memory.company_id='foreign'],
 ['commerce foreign tenant',i=>i.commerce.company_id='foreign'],
 ['memory stale current source',i=>i.memory.source_message_id='old'],
 ['commerce revision mismatch',i=>i.commerce.revision=1],
 ['missing commerce nonzero revision',i=>i.commerce=null],
 ['missing commerce zero is not verified empty',i=>{i.commerce=null;i.memory.commerce_state_revision=0;}],
 ['duplicate evidence source',i=>i.trusted_visitor_source_rows.push(i.trusted_visitor_source_rows[0])],
 ['source value absent',i=>i.trusted_visitor_source_rows[0].content='My budget is 9000.'],
 ['source is current turn',i=>i.memory.current_customer_facts[0].source_message_id=scope.source_message_id],
 ['superseded value',i=>i.memory.cancelled_or_superseded=[{...i.memory.current_customer_facts[0],key:'superseded_budget'}]],
])test(`semantic source proof rejects ${id}`,()=>{const i=fixture();mutate(i);assert.equal(prepareConversationRecall(i,'en').decision.handled,false);});
test('source-attested latest correction is usable even after prior same-value history was superseded',()=>{
 const input=fixture();input.memory.cancelled_or_superseded=[{key:'superseded_budget',value:5000,authority:'customer',entity_id:null,source_message_id:'older-source'}];
 assert.equal(prepareConversationRecall(input,'en').decision.handled,true);
});

for(const question of ['What budget did I mention and could you cancel my subscription?', 'Remind me of my budget and please reserve a table.'])test(`same-clause mixed action is retained: ${question}`,()=>{
 const result=prepareConversationRecall(fixture({question}),'en');assert.equal(result.decision.handled,false,JSON.stringify(result));assert.equal(result.decision.reason,'CURRENT_KB_REQUIRED');
});

for(const [id,key,value,ownSource,foreignSource,question] of [
 ['preferences','preferences','quiet','I prefer quiet.',"My assistant's preference is quiet.",'What is my preference?'],
 ['custom scalar','favorite_color','blue','My favorite color is blue.',"My assistant's favorite color is blue.",'What is my favorite color?'],
])test(`personal scalar owner is required for ${id}`,()=>{
 const own=prepareConversationRecall(fixture({key,value,source:ownSource,question}),'en');
 assert.equal(own.decision.handled,true,JSON.stringify(own));assert.equal(own.decision.value,value);
 const foreign=prepareConversationRecall(fixture({key,value,source:foreignSource,question}),'en');
 assert.equal(foreign.decision.handled,false,JSON.stringify(foreign));
});

/** F1/S3 and F3/S4 — same-input baseline/candidate source differential,
 * one clean deterministic state per original case; no model or KB dispatch.
 * It is not the original full-handler, real-provider or Hosted acceptance. */
test('Task3C N1/N3 exact 13-case clean-source differential versus deployed-v289 source', async()=>{
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const baseline='0821ce02a7e43b2aa2da32a07f2abb20cece7444';
 const tmp=mkdtempSync(join(tmpdir(),'c3-source-baseline-'));
 let attached=false;
 try{
  execFileSync('git',['worktree','add','--detach',tmp,baseline],{cwd:root,timeout:30000,stdio:'pipe'});
  attached=true;
  if(existsSync(join(root,'node_modules')))symlinkSync(join(root,'node_modules'),join(tmp,'node_modules'),'dir');
  const old=await import(pathToFileURL(join(tmp,'supabase/functions/_shared/conversation-recall.ts')).href);
  const matrix=JSON.parse(readFileSync(new URL('./fixtures/task3c-replay/original-33-turns.json',import.meta.url),'utf8'));
  assert.equal(matrix.scope.case_count,13);
  assert.equal(matrix.scope.turn_count,33);
  const caseGroups=new Map();
  for(const turn of matrix.turns){
   if(!caseGroups.has(turn.case_id))caseGroups.set(turn.case_id,[]);
   caseGroups.get(turn.case_id).push(turn);
  }
  const semanticKeys={
   'T17':['quantity'],'T40':['address'],'T50':['room_size'],'T57':['address'],
   'T58':['delivery_status'],'T68':['horsepower'],'T69':['brand_constraint'],
   'T71':[],'T96':['recipient','contact'],'T98':['quotation_status','order_status'],
   'C3-CONTROL-12':[],'C3-CONTROL-13':['horsepower'],'C3-CONTROL-14':[]
  };
  let compared=0,regressions=0;
  for(const [caseId,turns] of caseGroups){
   const setup=turns.filter(t=>t.kind==='setup'),asserted=turns.filter(t=>t.kind==='asserted');
   assert.equal(asserted.length,1,caseId+' must keep one original asserted turn');
   const company_id='82000000-0000-4000-8000-000000000001';
   const conversation_id='82000000-0000-4000-8000-'+String(++compared).padStart(12,'0');
   let state=createEmptyConversationCommerceState();
   const earlier=[];
   for(const turn of setup){
    const id='82000000-0000-4000-8000-'+String(1000*compared+turn.turn).padStart(12,'0');
    state=reduceTurn(state,{company_id,conversation_id,source_message_id:id,text:turn.text,
      language:'zh-TW',history:earlier.map(x=>({role:'visitor',content:x.content}))},
      buildCommerceEntityHints([turn.text,...earlier.map(x=>x.content).reverse()]));
    earlier.push({id,content:turn.text,created_at:new Date(Date.UTC(2026,10,19,6,turn.turn)).toISOString()});
   }
   const source_message_id='82000000-0000-4000-8000-'+String(1000*compared+asserted[0].turn).padStart(12,'0');
   const newest_first=[
    {id:source_message_id,role:'visitor',content:asserted[0].text,created_at:'2026-11-19T07:00:00Z'},
    ...earlier.slice().reverse().map(x=>({...x,role:'visitor'}))
   ];
   const memory=buildCanonicalConversationMemory({
    company_id,conversation_id,source_message_id,commerce_state_revision:setup.length,
    commerce_state:state,newest_first,visitor_turn_count:turns.length,
    next_memory_revision:turns.length,source_created_at:'2026-11-19T07:00:00Z'
   });
   const baseInput={company_id,conversation_id,source_message_id,question:asserted[0].text,
    memory,commerce:{company_id,conversation_id,source_message_id:earlier.at(-1)?.id??source_message_id,
      revision:setup.length,state},
    // The clean-source differential constructs original server-attributed
    // Visitor turns; the same read result must be explicit for the D3 gate.
    trusted_visitor_source_status:'verified',
    trusted_visitor_source_rows:earlier.slice().reverse().map(x=>({id:x.id,content:x.content}))};
   const before=old.resolveConversationRecall(baseInput);
   const keys=semanticKeys[caseId]??[];
   const currentInput={...baseInput,
    customer_recall_proposal:keys.length?{company_id,conversation_id,source_message_id,
      intent:'customer_fact_recall',requested_facts:keys,subject_refs:[]}:undefined};
   const after=prepareConversationRecall(currentInput,'zh-TW').decision;
   if(caseId==='T68'){
    assert(after.handled,'T68 two room/horsepower requirements must be source-attested');
    const wrong=structuredClone(currentInput);
    const fact=wrong.memory.current_customer_facts.find(f=>f.key==='horsepower');
    assert(fact && Array.isArray(fact.value) && fact.value.length===2,
      'T68 requires retained room/horsepower pairs');
    fact.value=fact.value.map((v,i)=>i===1?String(v).replace('1.5匹','2匹'):v);
    assert.equal(prepareConversationRecall(wrong,'zh-TW').decision.handled,false,
      'wrong second-room horsepower must not match the first room');
    const spec=structuredClone(currentInput);
    spec.trusted_visitor_source_rows=spec.trusted_visitor_source_rows.map(row=>({
      ...row,content:'細房產品規格1匹，大房產品規格1.5匹。'
    }));
    assert.equal(prepareConversationRecall(spec,'zh-TW').decision.handled,false,
      'product specs must not prove customer-owned requirements');
    const duplicate=structuredClone(currentInput);
    duplicate.trusted_visitor_source_rows.push({...duplicate.trusted_visitor_source_rows[0]});
    assert.equal(prepareConversationRecall(duplicate,'zh-TW').decision.handled,false,
      'duplicate Visitor-source IDs are not unique evidence');
   }
   const equal=before.handled===after.handled &&
      (!before.handled||JSON.stringify(before.value)===JSON.stringify(after.value));
   // Source route decisions only: report concise path/why without disclosing
   // preserved fixture addresses, recipient names or contact numbers.
   const status={
    case_id:caseId,baseline:before.handled?'ANSWER':before.reason,
    baseline_detail:before.handled?'SOURCE_BOUND':before.detail,
    candidate:after.handled?'ANSWER':after.reason,
    candidate_detail:after.handled?'SOURCE_BOUND':after.detail,
    baseline_fact:before.handled?before.fact_type:null,
    candidate_fact:after.handled?after.fact_type:null,
    baseline_evidence:before.handled?before.provenance.evidence.map(e=>({
      authority:e.authority,source_kind:e.source_kind,
      has_source_id:!!e.evidence_source_message_id,
      path_category:e.state_path.split('.')[0]
    })):null,
    value_equal:before.handled&&after.handled?equal:null,
    independent_setup_turns:setup.length,
    result:before.handled&&!equal?'REGRESSION':after.handled?'SOURCE_ANSWER':'SOURCE_UNRESOLVED'
   };
   console.log('C3_N1_N3_DIFFERENTIAL|'+JSON.stringify(status));
   if(before.handled&&!equal)regressions++;
  }
  assert.equal(compared,13);
  assert.equal(regressions,0,'new semantic route may not be worse than the baseline on a canonical source-proven case');
  console.log('C3_N1_N3_SOURCE_COMPARISON|baseline='+baseline+'|cases=13|regressions=0|kind=ISOLATED_NO_PROVIDER|hosted=NOT_RUN');
 }finally{
  if(attached)execFileSync('git',['worktree','remove','--force',tmp],{cwd:root,timeout:30000,stdio:'pipe'});
  rmSync(tmp,{recursive:true,force:true});
 }
});

/** Task3C D3 six cases (F1/F3/F8, S3/S2/S4), no model or KB. */
import { loadScopedRecallVisitorSources } from '../../supabase/functions/_shared/conversation-recall.ts';
const d3Source=(content='My budget is 5000.',id='original-source',conversation_id='ticket-a')=>({
 id,conversation_id,role:'visitor',is_recalled:false,content,
 created_at:'2026-11-19T05:01:00Z'
});
async function d3Read(input,fetch_missing,recent_rows=[],enabled=true){
 return loadScopedRecallVisitorSources({
   company_id:input.company_id,conversation_id:input.conversation_id,
   source_message_id:input.source_message_id,question:input.question,
   memory:input.memory,commerce:input.commerce,
   requested_facts:input.customer_recall_proposal?.requested_facts,
   enabled,recent_rows,fetch_missing
 });
}
test('D3 outside 50 recent rows uses one bounded original Visitor source read',async()=>{
 const input=fixture(),many=Array.from({length:50},(_,i)=>d3Source('Earlier unrelated request '+i,'history-'+i));
 let attempts=0;
 const out=await d3Read(input,async ids=>{attempts++;assert.deepEqual(ids,['original-source']);return {rows:[d3Source()]};},many);
 assert.equal(out.status,'verified');assert.equal(out.targeted_count,1);assert.equal(attempts,1);
 const result=prepareConversationRecall({...input,trusted_visitor_source_rows:out.rows,trusted_visitor_source_status:out.status},'en');
 assert.equal(result.decision.handled,true,JSON.stringify(result));
 assert.equal(result.decision.value,5000);
});
test('D3 a recalled original Visitor source cannot attest a customer fact',async()=>{
 const input=fixture();const out=await d3Read(input,async()=>({rows:[{...d3Source(),is_recalled:true}]}));
 assert.notEqual(out.status,'verified');
 const answer=prepareConversationRecall({...input,trusted_visitor_source_rows:out.rows,trusted_visitor_source_status:out.status},'en');
 assert.equal(answer.decision.handled,false);
});
test('D3 source read error is not an empty trusted-source read',async()=>{
 const input=fixture();const out=await d3Read(input,async()=>({rows:null,error:{code:'PGRST_READ_FAILURE'}}));
 assert.equal(out.status,'failed');
 assert.equal(prepareConversationRecall({...input,trusted_visitor_source_rows:out.rows,trusted_visitor_source_status:out.status},'en').decision.handled,false);
 const recentFailure=await d3Read(input,async()=>{throw Error('must not run')},null);
 assert.equal(recentFailure.status,'failed');
 const noCandidate=structuredClone(input);noCandidate.memory.current_customer_facts=[];
 let called=false;
 const noEvidenceId=await d3Read(noCandidate,async()=>{called=true;return {rows:[]};});
 assert.equal(noEvidenceId.status,'not_requested');
 assert.equal(called,false,'no candidate ID must not cause a speculative DB read');
});
test('D3 wrong tenant or conversation source is denied',async()=>{
 const input=fixture();
 const out=await d3Read(input,async()=>({rows:[d3Source('My budget is 5000.','original-source','other-conversation')]}));
 assert.equal(out.status,'failed');
 const foreign=structuredClone(input);foreign.memory.company_id='other-company';
 assert.equal((await d3Read(foreign,async()=>({rows:[d3Source()]}))).status,'failed');
});
test('D3 canonical 6 cannot replace Visitor-attested 3',async()=>{
 const input=fixture({key:'quantity',value:6,source:'I requested 3 units.',question:'How many units did I say I needed earlier?'});
 const out=await d3Read(input,async()=>({rows:[d3Source('I requested 3 units.')]}));
 assert.equal(out.status,'verified');
 const decision=prepareConversationRecall({...input,trusted_visitor_source_rows:out.rows,trusted_visitor_source_status:out.status},'en').decision;
 assert.equal(decision.handled,false,'wrong stored value must not pass original attestation');
});
test('D3 duplicate original message IDs and >5 targeted IDs fail closed',async()=>{
 const input=fixture();
 const out=await d3Read(input,async()=>({rows:[d3Source(),d3Source()]}));
 assert.equal(out.status,'failed');
 const overflow=structuredClone(input);
 for(let i=1;i<=6;i++)overflow.memory.current_customer_facts.push({
   key:'budget',value:i,authority:'customer',source_message_id:'extra-'+i,entity_id:null
 });
 let dispatched=false;
 const capped=await d3Read(overflow,async()=>{dispatched=true;return {rows:[]};});
 assert.equal(capped.status,'over_cap');assert.equal(dispatched,false);
});

test('D3 missing source verification status cannot attest customer-owned scalar',()=>{
 const input=fixture();delete input.trusted_visitor_source_status;
 assert.equal(prepareConversationRecall(input,'en').decision.handled,false);
});
test('D3 six already-recent Visitor sources are not six missing DB reads',async()=>{
 const input=fixture();const ids=Array.from({length:6},(_,i)=>'ready-'+i);
 input.memory.current_customer_facts=ids.map((id,i)=>({
   key:'budget',value:5000+i,authority:'customer',source_message_id:id,entity_id:null
 }));
 const recent=ids.map((id,i)=>d3Source('My budget is '+(5000+i)+'.',id));
 let reads=0;
 const out=await d3Read(input,async()=>{reads++;throw Error('no missing source');},recent);
 assert.equal(out.status,'verified');assert.equal(out.targeted_count,0);
 assert.equal(out.rows.length,6);assert.equal(reads,0);
});

/** P5 R2: sample the unchanged historical original full-handler test with
 * both randomized source IDs and two fixed ID orders. Each worktree changes
 * only a disposable copy of the original fixture; the assertion is verbatim.
 * This is non-paid isolated runtime, never Hosted PASS. */
test('Task3C R2 original test533 nondeterminism 100x per historical/current source', {timeout:240000},async()=>{
 const {spawnSync}=await import('node:child_process');
 const {writeFileSync}=await import('node:fs');
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const refs=[
  ['FIRST_OBSERVED_FAIL','fb70fd8e617b5e9f37c8ed086aca250556adcaf4'],
  ['POST_D3_SOURCE_PASS','d4d2f3cdfcb58b26de629aef66471f82a6c45ada'],
 ];
 for(const [label,ref] of refs) {
  const temp=mkdtempSync(join(tmpdir(),'c3-test533-repro-'));
  let attached=false;
  try{
   execFileSync('git',['worktree','add','--detach',temp,ref],{cwd:root,timeout:30000,stdio:'pipe'});
   attached=true;
   if(existsSync(join(root,'node_modules')))symlinkSync(join(root,'node_modules'),join(temp,'node_modules'),'dir');
   const filepath=join(temp,'tests/c3-widget-live-auth/original-preview.test.mjs');
   let text=readFileSync(filepath,'utf8');
   const loop="for(const tool of ['knowledge_helper','suggest_reply'])for(const stale of [true,false])test(";
   assert(text.includes(loop),'original four-variant test must exist');
   text=text.replace(loop,
     "for(const tool of ['knowledge_helper','suggest_reply'])for(const stale of [true,false])for(const r2Iteration of Array.from({length:100},(_,i)=>i))test(");
   const uuids=" const currentSource=crypto.randomUUID(),newSource=crypto.randomUUID(),oldSource=crypto.randomUUID();";
   assert(text.includes(uuids),'original source ID fixture changed');
   text=text.replace(uuids,` const currentSource=crypto.randomUUID(),
  newSource=r2Iteration===98?'00000000-0000-4000-8000-000000000101':
    r2Iteration===99?'00000000-0000-4000-8000-000000000099':crypto.randomUUID(),
  oldSource=r2Iteration===98?'00000000-0000-4000-8000-000000000099':
    r2Iteration===99?'00000000-0000-4000-8000-000000000101':crypto.randomUUID();`);
   const assertion=" assert(!JSON.stringify(result.data).includes(older)&&!JSON.stringify(result.data).includes('5432'),'older source leaked into the current assistance');";
   assert(text.includes(assertion),'original source-leak assertion cannot be weakened');
   const diagnostic=` if(tool==='suggest_reply'&&stale&&(JSON.stringify(result.data).includes(older)||JSON.stringify(result.data).includes('5432'))){
  const paths=[]; const visit=(value,path)=>{
   if(typeof value==='string'&&(value.includes(older)||value.includes('5432')))paths.push(path);
   else if(value&&typeof value==='object')for(const [key,child]of Object.entries(value))visit(child,path+'.'+key);
  };
  visit(result.data,'data');
  console.log('D3_R2_PATHS|'+JSON.stringify(paths.slice(0,20)));
 }
`;
   text=text.replace(assertion,diagnostic+assertion);
   writeFileSync(filepath,text,'utf8');
   // Node's parent test worker exports NODE_TEST_CONTEXT=child-v8.
   // A nested 'node --test' inheriting it silently exits 0 with zero tests.
   // Remove only that runner flag; never relax the original source-leak test.
   const childEnv={...process.env,C3_KB_ADMISSION_SOURCE_REF:''};
   delete childEnv.NODE_TEST_CONTEXT;
   const run=spawnSync(process.execPath,[
    '--test','--test-reporter=tap',
    '--test-name-pattern=Task3 topic-switch v5 Inbox suggest_reply: confident older proposal',
    'tests/c3-widget-live-auth/original-preview.test.mjs'],{
      cwd:temp,encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024,
      env:childEnv});
   if(run.error)throw run.error;
   const output=String(run.stdout??'')+'\n'+String(run.stderr??'');
   const matches=output.split('\n').map(line=>line.trim()).filter(line=>
     /^(?:not ok|ok) \d+ - Task3 topic-switch v5 Inbox suggest_reply: confident older proposal/.test(line));
   const failures=matches.filter(line=>line.startsWith('not ok')).length;
   const paths=[...output.matchAll(/D3_R2_PATHS\|([^\n]+)/g)].flatMap(m=>{
     try{return JSON.parse(m[1])}catch{return []}
   });
   const result={label,head:ref,attempts:matches.length,failures,
      passes:matches.length-failures,fixed_id_order_cases:2,
      exit_code:run.status,leak_paths:[...new Set(paths)].slice(0,20),
      evidence_tier:'NONPAID_SOURCE_REPRO_NOT_HOSTED'};
   console.log('D3_R2_REPRO|'+JSON.stringify(result));
   if(matches.length!==100)console.log('D3_R2_CHILD_TEST_DEBUG|'+JSON.stringify({label,exit_code:run.status,stdout_end:String(run.stdout??'').slice(-1200),stderr_end:String(run.stderr??'').slice(-600)}));
   assert.equal(matches.length,100,'100 original test assertions must be recorded for '+label);
   assert.equal(run.signal,null,'stress fixture timed out');
  }finally{
   if(attached)execFileSync('git',['worktree','remove','--force',temp],{cwd:root,timeout:30000,stdio:'pipe'});
   rmSync(temp,{recursive:true,force:true});
  }
 }
});


/** D4-2 PRE-FIX observational baseline, not D4 acceptance.
 * Original Task3C, 6 industries x 4 question classes. Scripted semantic
 * frames only; 0 real AI, 0 KB, 0 Hosted, 0 production changes.
 * Keep failures in the denominator and preserve original assertions. */
test('D4-2 six-industry twenty-four-cell baseline before generic repair',()=>{
 const domains=[
  ['appliance','air_conditioner','CW-SUL70BA air conditioner','Living room air conditioner','部','units',
    '我要三部冷氣。','我之前提過要幾多部冷氣？','更正，只保留兩部冷氣，第三部暫緩。'],
  ['beauty','beauty_service','Glow facial package','Calm facial package','堂','sessions',
    '我想要三堂美容療程。','我之前提過要幾多堂美容療程？','更正，只保留兩堂療程，第三堂暫緩。'],
  ['education','education_service','English course','Math course','課','lessons',
    '我想報三課英語課。','我之前提過要幾多課英語課？','更正，只保留兩課，第三課延後再談。'],
  ['restaurant','restaurant_service','Dinner set','Lunch set','份','sets',
    '我想要三份套餐。','我之前提過要幾多份套餐？','更正，只保留兩份套餐，第三份取消。'],
  ['retail','retail_item','Office desk','Meeting desk','張','items',
    '我要三張書枱。','我之前提過要幾多張書枱？','更正，只保留兩張書枱，第三張暫時取消。'],
  ['saas','subscription','Team license','Staff license','licenses','licenses',
    'We need three licenses for this team.','How many licenses did I mention earlier?',
    'Correction: keep two licenses; postpone the third.']
 ];
 const classes=['C1_RECALL','C2_CORRECT_CANCEL','C3_QUANTITY_WRITE','C4_MULTI_SUBJECT'];
 const rows=[];
 function applyScripted(name,category,unit,count,text) {
  const state=createEmptyConversationCommerceState();state.current_topic=category;
  const e={...entity(name,3,'d4-a'),model:name,category,
    attributes:{product_name:name,unit},
    provenance:{source_type:'customer',source_message_id:'d4-original'}};
  state.entities=[e];
  const frame={version:'commerce-semantic-1.0.0',language:'en',operation:'SET_QUANTITY',
   intent:'other',topic:category,confidence:.98,
   ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},
   entities:[{entity_ref:'d4-a',name,kind:'service',category_hint:category,
    sku:null,model:name,quantity:count,unit,attributes:{},constraints:{},
    capabilities:{},confidence:.96}],
   referents:[],customer_facts:[],requested_facts:[],customer_correction:true,
   additive:false,explicit_negations:[],transaction_state:'none',payment_state:'none',
   booking_state:'none',fulfillment_state:'none'};
  const next=reduceTurn(state,{text,semantic_frame:frame,source_message_id:'d4-new',
   company_id:'d4-synthetic-company',conversation_id:'d4-synthetic-ticket',language:'en'},
   [{entity_id:'d4-a',category,model:name,aliases:[name],
     attributes:{product_name:name,unit}}]);
  return {qty:next.entities.find(v=>v.entity_id==='d4-a')?.quantity??null,
   source_id:next.entities[0]?.provenance?.source_message_id??null,
   deferred:next.entities.filter(v=>v.status==='cancelled'||v.status==='deferred').length};
 }
 for(const [industry,category,name,other,sourceUnit,englishUnit,original,question,correction] of domains){
  for(const kind of classes){
   const write='Change '+name+' to 3 '+englishUnit+'.';
   const dual='I requested 3 '+englishUnit+' for '+name+' and 5 '+englishUnit+' for '+other+'.';
   const ask='Remind me of the quantity I requested for '+name+'.';
   const text=kind===classes[0]?question:kind===classes[1]?correction:
     kind===classes[2]?write:ask;
   const source=kind===classes[3]?dual:original;
   const profile=d4ResolveIndustryRuntime({texts:[text,source],industry_identifier:null});
   let status='FAIL',reason='UNTESTED',observed={};
   try{
    if(kind===classes[0]){
     const r=prepareConversationRecall(fixture({source,question:text,key:'quantity',value:3,
       emptyRequested:true}),industry==='saas'?'en':'zh-TW').decision;
     const attested=!!r.provenance?.evidence?.find(e=>e.evidence_source_message_id==='original-source');
     status=r.handled&&r.value===3&&attested?'PASS':'FAIL';
     reason=status==='PASS'?'SOURCE_PROVEN':String(r.reason??'VALUE_OR_SOURCE_UNVERIFIED');
     observed={handled:r.handled,fact:r.fact_type??null,attested};
    }else if(kind===classes[1]){
     const a=applyScripted(name,category,englishUnit,2,text);
     status=a.qty===2?(a.deferred>=1?'PASS':'CLARIFY'):'FAIL';
     reason=a.qty!==2?'CORRECTION_NOT_APPLIED':a.deferred<1?
       'DEFERRED_MEMBER_NOT_TRACKED':'CORRECTION_AND_DEFERRED_PROVEN';
     observed={retained_count:a.qty,deferred_member_count:a.deferred};
    }else if(kind===classes[2]){
     const a=applyScripted(name,category,englishUnit,3,text);
     status=a.qty===3&&a.source_id==='d4-new'?'PASS':'FAIL';
     reason=status==='PASS'?'SOURCE_BOUND_WRITE':'WRITE_OR_PROVENANCE_UNVERIFIED';
     observed={quantity:a.qty,source_attested:a.source_id==='d4-new'};
    }else{
     const entities=[{...entity(name,3,'d4-a'),model:name,
      attributes:{product_name:name,unit:englishUnit}},
      {...entity(other,5,'d4-b'),model:other,
      attributes:{product_name:other,unit:englishUnit}}];
     const r=prepareConversationRecall(fixture({source,question:text,key:'quantity',
      value:'3 '+englishUnit,entity_id:'d4-a',entities,subjects:['d4-a']}),'en').decision;
     const attested=!!r.provenance?.evidence?.find(e=>e.evidence_source_message_id==='original-source');
     status=r.handled&&String(r.value).includes('3')&&!String(r.value).includes('5')&&attested?'PASS':'FAIL';
     reason=status==='PASS'?'SUBJECT_TYPED_UNIT_PROVEN':
       String(r.reason??'TYPED_UNIT_OR_SUBJECT_UNVERIFIED');
     observed={handled:r.handled,attested,value_type:typeof r.value,other_quantity:5};
    }
   }catch(e){status='FAIL';reason='BASELINE_RUNTIME_EXCEPTION';observed={error:String(e).slice(0,130)};}
   const row={case_id:'D4-'+industry+'-'+kind,industry,question_class:kind,
    explicit_profile:null,effective_profile:profile.industry_id??null,
    status,reason_code:reason,observed,
    evidence_tier:'SOURCE_ISOLATED_SCRIPTED_NOT_REAL_MODEL_NOT_HOSTED'};
   rows.push(row);console.log('D4_BASELINE|'+JSON.stringify(row));
  }
 }
 assert.equal(rows.length,24,'D4-2 must have 24 observed cases');
 assert.equal(new Set(rows.map(v=>v.case_id)).size,24,'D4-2 duplicate ids');
 assert.equal(rows.filter(v=>!['PASS','FAIL','CLARIFY'].includes(v.status)).length,0,'D4 status missing');
 console.log('D4_BASELINE_SUMMARY|'+JSON.stringify({
  source_logic:'08863aa54be5d6880790e1a9f66f4d5423c5bc00',
  cases:24,pass:rows.filter(v=>v.status==='PASS').length,
  fail:rows.filter(v=>v.status==='FAIL').length,
  clarify:rows.filter(v=>v.status==='CLARIFY').length,
  scripted:true,real_model_calls:0,real_kb_calls:0,hosted:'NOT_RUN',acceptance:'NOT_CLAIMED'}));
});


/** D4-2 TIER1 (local half of the 24-cell strengthened baseline).
 * The complete-handler C1/C3 half is in the existing emergency-p0 suite.
 * Synthetic semantic frames are explicitly NOT real-model or Hosted evidence. */
test('D4-2 tier1 six-industry corrected/cancelled and typed subject-value matrix',()=>{
 const d=[
  ['appliance','air_conditioner','冷氣','部','匹','細房冷氣','大房冷氣',1.5,2,'更正，只保留兩部冷氣，第三部暫緩。'],
  ['beauty','beauty_service','美容療程','堂','分鐘','護膚療程A','護膚療程B',60,90,'更正，只保留兩堂療程，第三堂暫緩。'],
  ['education','education_service','英語課','課','分鐘','英語課A','英語課B',45,90,'更正，只保留兩課，第三課延後再談。'],
  ['restaurant','restaurant_service','套餐','份','位','A號餐枱','B號餐枱',4,6,'更正，只保留兩份套餐，第三份取消。'],
  ['retail','retail_item','書枱','張','位','書枱A','書枱B',4,6,'更正，只保留兩張書枱，第三張取消。'],
  ['saas','subscription','Team licenses','licenses','seats','Starter plan','Pro plan',4,6,'Correction: keep two licenses; postpone the third.']
 ];
 const rows=[],instrument=[];
 for(const [industry,category,name,unit,propertyUnit,firstName,otherName,firstValue,otherValue,correction] of d){
  const base=createEmptyConversationCommerceState();base.current_topic=category;
  base.entities=[{...entity(name,3,'d4-t1-primary'),category,model:name,status:'tentative',
   attributes:{product_name:name,unit},provenance:{source_type:'customer',source_message_id:'d4-original'}}];
  try{
   const first=base.entities[0];
   const frame={version:'commerce-semantic-1.0.0',language:industry==='saas'?'en':'zh-TW',
    operation:'SET_QUANTITY',intent:'other',topic:category,confidence:.98,
    ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},
    entities:[{entity_ref:first.entity_id,name,kind:industry==='appliance'||industry==='retail'?'physical_product':'service',
      category_hint:category,sku:null,model:name,quantity:2,unit,attributes:{},constraints:{},capabilities:{},confidence:.96}],
    referents:[],customer_facts:[{key:'browser_tabs',value:6}],requested_facts:[],
    customer_correction:true,additive:false,explicit_negations:[],
    transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none'};
   const after=reduceTurn(base,{text:correction+(industry==='saas'?' I also have six browser tabs now.':' 另外現在只開6個瀏覽器分頁。'),
      semantic_frame:frame,source_message_id:'d4-t1-correction',
      company_id:'d4-t1-company',conversation_id:'d4-t1-ticket',
      language:industry==='saas'?'en':'zh-TW'},[{entity_id:first.entity_id,
      category,model:name,aliases:[name],attributes:{unit}}]);
   const active=after.entities.filter(v=>v.status!=='cancelled'&&v.status!=='deferred');
   const retained=active.find(v=>v.entity_id===first.entity_id);
   const deferred=after.entities.filter(v=>v.status==='cancelled'||v.status==='deferred').length;
   const count=retained?.quantity??null;
   const status=count===2&&count!==6?(deferred>=1?'PASS':'CLARIFY'):'FAIL';
   const row={case_id:'D4-T1-'+industry+'-C2_CORRECT_CANCEL',industry,question_class:'C2_CORRECT_CANCEL',
    explicit_profile:null,effective_profile:after.current_industry??null,
    status,reason_code:count!==2?'TARGET_NOT_UPDATED':deferred===0?'DEFERRED_MEMBER_NOT_TRACKED':'SOURCED_CORRECTION',
    observations:{initial_count:3,target_count:2,decoy_count:6,actual_count:count,
      deferred_count:deferred,provenance_source_matches:retained?.provenance?.source_message_id==='d4-t1-correction'},
    profile_observed_from:'REDUCER_STATE',evidence_tier:'SCRIPTED_REDUCER_NOT_FULL_HANDLER'};
   rows.push(row);console.log('D4_TIER1|'+JSON.stringify(row));
  }catch(e){instrument.push({case_id:'D4-T1-'+industry+'-C2',error:String(e).slice(0,250)});}
  try{
   const key=industry==='appliance'?'horsepower':industry==='beauty'?'duration_minutes':
     industry==='education'?'lesson_minutes':industry==='restaurant'?'seats_per_table':
     industry==='retail'?'seat_capacity':'subscription_seats';
   const original=industry==='saas'
    ? 'I requested '+firstValue+' '+propertyUnit+' for '+firstName+
      ' and '+otherValue+' '+propertyUnit+' for '+otherName+'.'
    : '我之前要求'+firstName+firstValue+propertyUnit+'，'+otherName+otherValue+propertyUnit+'。';
   const e1={...entity(firstName,1,'d4-t1-first'),category,model:firstName,
     attributes:{product_name:firstName,[key]:firstValue,unit:propertyUnit}};
   const e2={...entity(otherName,1,'d4-t1-other'),category,model:otherName,
     attributes:{product_name:otherName,[key]:otherValue,unit:propertyUnit}};
   const expected=String(firstValue)+' '+propertyUnit;
   const input=fixture({source:original,question:industry==='saas'?'What '+key+' did I request for '+firstName+'?':'我之前要求'+firstName+'係幾多'+propertyUnit+'？',
    key,value:expected,entity_id:'d4-t1-first',entities:[e1,e2],subjects:['d4-t1-first']});
   const result=prepareConversationRecall(input,industry==='saas'?'en':'zh-TW').decision;
   const attested=!!result.provenance?.evidence?.some(x=>x.evidence_source_message_id==='original-source');
   const correct=result.handled&&attested&&String(result.value).includes(String(firstValue))&&
    !String(result.value).includes(String(otherValue));
   const status=correct?'PASS':result.handled?'FAIL':'CLARIFY';
   const row={case_id:'D4-T1-'+industry+'-C4_MULTI_SUBJECT',industry,question_class:'C4_MULTI_SUBJECT',
    explicit_profile:null,effective_profile:input.commerce?.state?.current_industry??null,
    status,reason_code:correct?'ONE_SUBJECT_NUMERIC_TEXT_UNIT_ATTESTED':
      result.handled?'WRONG_VALUE_OR_SUBJECT':String(result.reason??'SOURCE_OR_DIMENSION_UNVERIFIED'),
    observations:{source_attribute_type:'number',source_memory_type:'text_with_unit',
      source_number:firstValue,decoy_subject_number:otherValue,unit:propertyUnit,
      handled:result.handled,source_attested:attested,answer_value_type:typeof result.value},
    profile_observed_from:'CANONICAL_INPUT_STATE',
    evidence_tier:'SOURCE_ISOLATED_NOT_FULL_HANDLER_NOT_REAL_MODEL'};
   rows.push(row);console.log('D4_TIER1|'+JSON.stringify(row));
  }catch(e){instrument.push({case_id:'D4-T1-'+industry+'-C4',error:String(e).slice(0,250)});}
 }
 console.log('D4_TIER1_LOCAL_SUMMARY|'+JSON.stringify({cells:rows.length,
  pass:rows.filter(x=>x.status==='PASS').length,fail:rows.filter(x=>x.status==='FAIL').length,
  clarify:rows.filter(x=>x.status==='CLARIFY').length,instrument_errors:instrument,
  real_model_calls:0,real_kb_calls:0,hosted:'NOT_RUN'}));
 assert.deepEqual(instrument,[],'instrument defects cannot be misclassified as product FAIL');
 assert.equal(rows.length,12,'C2/C4 must produce all twelve source observations');
});
