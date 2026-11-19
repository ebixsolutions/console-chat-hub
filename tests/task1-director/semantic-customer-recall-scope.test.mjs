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
    trusted_visitor_source_rows:earlier.slice().reverse().map(x=>({id:x.id,content:x.content}))};
   const before=old.resolveConversationRecall(baseInput);
   const keys=semanticKeys[caseId]??[];
   const currentInput={...baseInput,
    customer_recall_proposal:keys.length?{company_id,conversation_id,source_message_id,
      intent:'customer_fact_recall',requested_facts:keys,subject_refs:[]}:undefined};
   const after=prepareConversationRecall(currentInput,'zh-TW').decision;
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
