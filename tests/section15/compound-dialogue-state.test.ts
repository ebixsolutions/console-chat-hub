/** Native deterministic/CAS regressions only; no Hosted/model/Quality95 claims. */
import {createEmptyConversationCommerceState,type ConversationCommerceState} from '../../supabase/functions/_shared/commerce-state-contract.ts';
import {reduceTurn,persistCommerceTurn,runCommerceStateRuntime,type CommerceRuntimeInput,type CommerceStateDbClient} from '../../supabase/functions/_shared/commerce-state-runtime-base.ts';
import {HOME_APPLIANCE_PROFILE_V1} from '../../supabase/functions/_shared/industry-profiles/home-appliance-v1.ts';
import {matchesReferenceLabel} from '../../supabase/functions/_shared/industry-agent-registry.ts';
import {resolveIndustryRuntime} from '../../supabase/functions/_shared/industry-runtime-adapter.ts';
import {resolveEntityLifecyclePlan,b2JourneyTransactionBoundary} from '../../supabase/functions/_shared/b2-journey-progress-contract.ts';
import {buildCanonicalConversationMemory} from '../../supabase/functions/_shared/conversation-long-memory.ts';
import {prepareConversationRecall} from '../../supabase/functions/_shared/conversation-recall.ts';
import {classifyHandoffIntent} from '../../supabase/functions/_shared/handoff-intent.ts';
import {customerBusinessText} from '../../supabase/functions/_shared/commerce-state-authority.ts';
function assert(value:unknown,message='assertion failed'):asserts value{if(!value)throw Error(message);}
function sample(names:string[],categories=names):ConversationCommerceState{
 const s=createEmptyConversationCommerceState();s.current_topic='billing';
 s.entities=names.map((name,i)=>({entity_id:`generic:${i}:${name}`,category:categories[i],model:null,brand:null,quantity:i?1:5,status:'researching',attributes:{product_name:name,unit:i?'items':'seats'},constraints:{},provenance:{source_type:'customer',source_message_id:'prior',recorded_at:null}}));return s;
}
const hints=(s:ConversationCommerceState)=>s.entities.map(e=>({entity_id:e.entity_id,category:e.category,aliases:[e.category,String(e.attributes.product_name)]}));
const input=(text:string,source='compound',language:'en'|'zh-TW'='en'):CommerceRuntimeInput=>({company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:source,text,language});
function apply(s:ConversationCommerceState,text:string,language:'en'|'zh-TW'='en'){return reduceTurn(s,input(text,'compound',language),hints(s));}
function boundary(before:ConversationCommerceState,after:ConversationCommerceState){assert(JSON.stringify(b2JourneyTransactionBoundary(before))===JSON.stringify(b2JourneyTransactionBoundary(after)),'transaction boundary drift');}
for(const word of ['back','tracking','account','backup','TVA-91'])Deno.test(`profile aliases cannot match within ${word}`,()=>{
 assert(!matchesReferenceLabel(word,word==='TVA-91'?'TV':'AC'));
 assert(resolveIndustryRuntime({texts:[word],industry_identifier:null}).profile===null);
});
Deno.test('real AC and CJK category labels retain separately scoped profile matching',()=>{
 assert(matchesReferenceLabel('back to AC','AC'));assert(matchesReferenceLabel('冷氣先暫緩','冷氣'));
 assert(resolveIndustryRuntime({texts:['AC unit'],industry_identifier:null}).profile===HOME_APPLIANCE_PROFILE_V1);
});
for(const [a,b,unit] of [['subscription','addon','seats'],['booking','parking','nights'],['Product A','Product B','items'],['service','extra','sessions']]){
 for(const returnWord of ['back to','return to'])Deno.test(`compound ${a}/${b}: ${returnWord}, correction + defer + summary`,()=>{
  const before=sample([a,b]);before.entities[0].attributes.unit=unit;const immutable=JSON.stringify(before);
  const text=`Defer ${b}. Change ${a} to 8 ${unit}; ${returnWord} ${a}, give me a short English summary.`;
  const after=apply(before,text);assert(after.entities[0].quantity===8&&after.entities[1].quantity===1&&after.entities[1].status==='deferred',JSON.stringify(after));
  assert(!['deferred','cancelled'].includes(after.entities[0].status)&&after.current_topic===a);
  assert(after.entities.every(e=>e.provenance.source_message_id==='compound'));boundary(before,after);
  assert(JSON.stringify(before)===immutable,'input state mutated');
  assert(JSON.stringify(apply(after,text))===JSON.stringify(after),'retry multiplied mutation');
  const memory=buildCanonicalConversationMemory({previous:null,company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:'compound',commerce_state_revision:2,commerce_state:after,newest_first:[{id:'compound',role:'visitor',content:text}],visitor_turn_count:2,source_created_at:"2026-10-12T07:40:00Z",next_memory_revision:1});
  const readback=prepareConversationRecall({...input('Give me a short English summary.'),question:text,memory,commerce:{company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:'compound',revision:2,state:after}},'en');
  assert(readback.decision.handled&&readback.reply?.includes('8')&&/paused|deferred/i.test(readback.reply),JSON.stringify(readback));
  assert(!/generic:|revision|state key|B2_|paid|invoice/i.test(readback.reply!));
 });
}
for(const text of ['附加服務先暫緩。訂閱改為8席；講返訂閱，請用英文簡短總結。','暫緩附加服務；將訂閱改為8席。回到訂閱，請簡短整理。'])Deno.test(`Chinese independent corrections: ${text}`,()=>{
 const s=sample(['訂閱','附加服務'],['subscription','addon']);const a=apply(s,text,'zh-TW');
 assert(a.entities[0].quantity===8&&a.entities[1].status==='deferred',JSON.stringify(a));boundary(s,a);
 const english=apply(a,'back to subscription; give me a short English summary.');assert(english.entities[0].quantity===8&&english.entities[1].status==='deferred');
});
Deno.test('one named addon is deferred; sibling addon identity/quantity/provenance remains intact',()=>{
 const s=sample(['subscription','Backup','Analytics'],['subscription','addon','addon']);const original=JSON.stringify(s.entities[2]);
 const a=apply(s,'Defer Backup. Change subscription to 8 seats; back to subscription.');
 assert(a.entities[1].status==='deferred'&&JSON.stringify(a.entities[2])===original&&a.entities[0].quantity===8);
});
for(const text of ['Defer addon. Change unknown service to 8 seats.','Defer addon. Change subscription to 8 seats; change subscription to 9 seats.','Defer subscription. Change subscription to 8 seats.','Defer addon. Cancel addon.','Defer addon. Change service to 8 seats.'])Deno.test(`unresolved/conflicting operation rejects all changes: ${text}`,()=>{
 const s=sample(['subscription','addon','service','service']);assert(JSON.stringify(apply(s,text))===JSON.stringify(s));
});
Deno.test('unknown correction cannot become a fallback after sibling deferral',()=>{
 const s=sample(['subscription','addon']);assert(JSON.stringify(apply(s,'Defer addon. Change unknown service to 8 seats.'))===JSON.stringify(s));
});
Deno.test('cancelled/deferred referent never reactivated by correction, return or summary',()=>{
 for(const status of ['cancelled','deferred'] as const){const s=sample(['subscription','addon']);s.entities[0].status=status;
  assert(JSON.stringify(apply(s,'Defer addon. Change subscription to 8 seats; back to subscription.'))===JSON.stringify(s));
  const a=apply(s,'back to subscription; give me a summary.');assert(a.entities[0].status===status&&a.current_topic==='billing');}
});
Deno.test('billing policy and hypothetical old pricing never become merchant or transaction facts',()=>{
 const s=sample(['subscription','addon']);
 const a=apply(s,'Defer addon. Change subscription to 8 seats; what is the billing policy?');
 assert(a.entities[0].quantity===8&&a.entities[1].status==='deferred');boundary(s,a);
 assert(!JSON.stringify(a).includes('guaranteed'));
 const b=apply(a,'If the historical price was HK$100 per seat, what would 8 seats cost?');boundary(a,b);assert(b.quotes.length===0&&b.entities[0].quantity===8);
});
Deno.test('explicit R1 remains immediate while business projection keeps distinct operations',()=>{
 const text='Defer addon. Change subscription to 8 seats; please transfer me to a human support agent now.';
 assert(classifyHandoffIntent(text).explicit_request);const a=apply(sample(['subscription','addon']),customerBusinessText(text));
 assert(a.entities[0].quantity===8&&a.entities[1].status==='deferred');
});
Deno.test('summary rejects foreign tenant/ticket and stale Memory revision',()=>{
 const s=apply(sample(['subscription','addon']),'Defer addon. Change subscription to 8 seats.');
 for(const key of ['company_id','conversation_id']){
  const commerce={company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:'compound',revision:2,state:s,[key]:'foreign'};
  assert(!prepareConversationRecall({company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:'compound',question:'Give me a short summary.',memory:null,commerce},'en').decision.handled);
 }
});
Deno.test('one compound CAS persists both operations; replay, source/tenant denial and failed CAS cannot acknowledge',async()=>{
 const before=sample(['subscription','addon']);let state=structuredClone(before),revision=4,writes=0;const consumed=new Set<string>();
 const db:CommerceStateDbClient={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{revision,state:structuredClone(state)},error:null})})})}),rpc:async(_name,p)=>{
  if(p.p_company_id!=='tenant-a'||p.p_conversation_id!=='ticket-a')return{data:{result:'tenant_mismatch'},error:null};
  if(p.p_source_message_id==='wrong-source')return{data:{result:'invalid_source_message'},error:null};
  if(consumed.has(String(p.p_source_message_id)))return{data:{result:'source_message_already_applied',applied_revision:revision},error:null};
  if(p.p_expected_revision!==revision)return{data:{result:'revision_conflict'},error:null};
  state=structuredClone(p.p_state as ConversationCommerceState);revision++;writes++;consumed.add(String(p.p_source_message_id));return{data:{result:'success',applied_revision:revision},error:null};
 }};
 const i=input('Defer addon. Change subscription to 8 seats; back to subscription.');
 const result=await persistCommerceTurn(db,i,hints(before));assert(result.result==='success'&&writes===1&&revision===5&&state.entities[0].quantity===8&&state.entities[1].status==='deferred');
 const replay=await persistCommerceTurn(db,i,hints(before));assert(['no_semantic_change','source_message_already_applied'].includes(replay.result)&&writes===1);
 for(const denied of [{...i,company_id:'foreign',text:'Change subscription to 9 seats.'},{...i,source_message_id:'wrong-source',text:'Change subscription to 9 seats.'}]){
  const r=await persistCommerceTurn(db,denied,hints(before));assert(r.result!=='success'&&writes===1&&state.entities[0].quantity===8);}
 // A different snapshot invalidates both CAS attempts; no mutation is committed.
 const failing={...db,rpc:async()=>({data:{result:'revision_conflict'},error:null})};
 assert((await persistCommerceTurn(failing,input('Change subscription to 9 seats.','new'),hints(before))).result==='revision_conflict');assert(writes===1);
});

Deno.test('command conjunctions bind separate changes without splitting an entity enumeration',()=>{
 const s=sample(['subscription','addon']);
 for(const text of ['Defer addon and change subscription to 8 seats and return to subscription.','Change subscription to 8 seats and defer addon; back to subscription.']){
  const a=apply(s,text);assert(a.entities[0].quantity===8&&a.entities[1].status==='deferred'&&a.current_topic==='subscription',JSON.stringify(a));
 }
 const multiple=sample(['subscription','Backup','Analytics'],['subscription','addon','addon']);
 const a=apply(multiple,'Defer Backup and defer Analytics. Change subscription to 8 seats; return to subscription.');
 assert(a.entities[1].status==='deferred'&&a.entities[2].status==='deferred'&&a.entities[0].quantity===8);
});
Deno.test('summary cannot substitute stale or differently sourced Memory for the committed transition',()=>{
 const s=apply(sample(['subscription','addon']),'Defer addon. Change subscription to 8 seats.');
 const memory=buildCanonicalConversationMemory({previous:null,company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:'compound',commerce_state_revision:2,commerce_state:s,newest_first:[],visitor_turn_count:2,source_created_at:'2026-10-12T07:40:00Z',next_memory_revision:1});
 for(const bad of [{...memory,commerce_state_revision:1},{...memory,company_id:'foreign'},{...memory,conversation_id:'foreign'}]){
  const r=prepareConversationRecall({company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:'compound',question:'Give me a summary.',memory:bad,commerce:{company_id:'tenant-a',conversation_id:'ticket-a',source_message_id:'compound',revision:2,state:s}},'en');
  assert(!r.decision.handled);
 }
});

Deno.test('actual Commerce runtime does not let already-deferred status or recap discard a separate correction',async()=>{
 const initial=sample(['subscription','addon']);initial.current_topic='subscription';initial.entities[1].status='deferred';
 let state=structuredClone(initial),revision=3,calls=0;
 const db:CommerceStateDbClient={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{revision,state:structuredClone(state)},error:null})})})}),rpc:async(_f,p)=>{calls++;state=structuredClone(p.p_state as ConversationCommerceState);revision++;return{data:{result:'success',applied_revision:revision},error:null}}};
 const result=await runCommerceStateRuntime(db,input('Defer addon. Change subscription to 8 seats; back to subscription, give me a short English summary.'));
 assert(result?.persist_result==='success'&&calls===1&&state.entities[0].quantity===8&&state.entities[1].status==='deferred',JSON.stringify({result,state,calls}));
 const before=JSON.stringify(state);
 await runCommerceStateRuntime(db,input('Give me a short English summary.','read'));
 assert(calls===1&&JSON.stringify(state)===before);
});

Deno.test('single generic correction cannot revive an inactive entity or guess an unknown target',()=>{
 const s=sample(['subscription']);s.entities[0].status='cancelled';
 assert(JSON.stringify(apply(s,'Change subscription to 8 seats.'))===JSON.stringify(s));
 const active=sample(['subscription']);assert(JSON.stringify(apply(active,'Change unknown service to 8 seats.'))===JSON.stringify(active));
});
