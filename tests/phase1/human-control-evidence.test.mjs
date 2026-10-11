import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { APPLICATION_HEAD as head, APPLICATION_TREE as tree, verifySuppression, verifyDelivery, verifyHistoricalControl } from '../../.github/scripts/phase1_human_control_evidence.mjs';
const project='nonproduction-project';
const ids={company:'company',conversation:'conversation',agent:'profile-agent',visitor_session:'session',channel:'channel',original_suppressed_visitor:'original-visitor',human_reply:'human'};
const visitor={id:'original-visitor',role:'visitor',content:'wait',created_at:'2026-10-05T09:07:00Z',metadata:{}};
const human={id:'human',role:'agent',sender_id:ids.agent,content:'human reply',created_at:'2026-10-05T09:13:00Z',metadata:{control_commit:'human'}};
const ai={id:'old-ai',role:'assistant',content:'prior answer',created_at:'2026-10-05T08:00:00Z'};
function setup(){
  const before={project_id:project,capture_kind:'BEFORE_PROBE',captured_at:'2026-10-05T10:00:00Z',conversation:{id:ids.conversation,company_id:ids.company,assigned_agent_id:ids.agent,status:'pending',visitor_session_id:ids.visitor_session,channel_config_id:ids.channel},queue:[{state:'assigned',company_id:ids.company,assigned_agent_id:ids.agent}],assignment:[{is_active:true,agent_id:ids.agent,conversation_id:ids.conversation}],messages:[ai,visitor,human],commerce:[{state:{entities:[{quantity:4}]},revision:4,state_hash:'hash',source_message_id:'lineage'}]};
  const receipt={kind:'widget_ingress_human_control',endpoint:`https://${project}.supabase.co/functions/v1/receive-widget-message`,observation_status:'CAPTURED',status:200,body:{success:true,data:{message_id:'probe',ai_reply_pending:false,control_state:'human_control'}},project_id:project,company_id:ids.company,conversation_id:ids.conversation,application_head:head,application_tree:tree,message_id:'probe',content:'neutral',request_identity:{client_message_id:'request-id'},started_at:'2026-10-05T10:01:00Z',observed_at:'2026-10-05T10:01:01Z'};
  const after=structuredClone(before);after.capture_kind='AFTER_PROBE';after.captured_at='2026-10-05T10:02:00Z';after.messages.push({id:'probe',role:'visitor',content:'neutral',created_at:'2026-10-05T10:01:00Z',metadata:{client_message_id:'request-id'}});
  const ui=Object.fromEntries(['login','customer_chat','summary_visible','generic_summary_visible','takeover_clicked','human_reply_sent','customer_received'].map(k=>[k,{observed:true,evidence_path:'actual.png'}]));ui.takeover_clicked.channel='console_control';ui.human_reply_sent.channel='console_composer';Object.assign(ui.customer_received,{message_id:'human',content:'human reply',displayed_bubble_count:1});
  const poll={...receipt,endpoint:`https://${project}.supabase.co/functions/v1/widget-poll-messages`,body:{success:true,data:{messages:[human],ai_generating:false,human_support:{state:'assigned',agent_assigned:true}}}};
  return {receipt,before,after,ids,project,ui,poll};
}
test('Widget ingress receipt, canonical delta, exact state and authorized scope accepted',()=>assert.equal(verifySuppression(setup()),true));
test('direct generator guard accepted only with its own endpoint/request identity',()=>{
 const x=setup();x.receipt={...x.receipt,kind:'direct_generate_human_guard',endpoint:`https://${project}.supabase.co/functions/v1/generate-reply`,body:{success:true,skipped:'human_handling'},message_id:visitor.id,content:visitor.content,request_identity:{source_message_id:visitor.id,message_id:visitor.id}};x.after.messages=structuredClone(x.before.messages);assert.equal(verifySuppression(x),true);
 x.receipt.kind='widget_ingress_human_control';assert.throws(()=>verifySuppression(x),/endpoint/);
});
const negative=[
 ['missing receipt',x=>x.receipt=null],['unobserved null body',x=>x.receipt.body=null],['pending AI',x=>x.receipt.body.data.ai_reply_pending=true],
 ['wrong endpoint',x=>x.receipt.endpoint='https://wrong/receive-widget-message'],['wrong project',x=>x.receipt.project_id='foreign'],['wrong company',x=>x.receipt.company_id='foreign'],['wrong conversation',x=>x.receipt.conversation_id='foreign'],['wrong message ID',x=>x.receipt.body.data.message_id='wrong'],
 ['HTTP200 without human decision',x=>delete x.receipt.body.data.control_state],['post-completion cannot become before',x=>x.before.capture_kind='POST_COMPLETION_READBACK'],['after capture labelled before',x=>x.before.captured_at=x.after.captured_at],
 ['new assistant',x=>x.after.messages.push({...ai,id:'new-ai'})],['thinking',x=>x.after.messages.push({...ai,id:'thinking',content:'__THINKING__'})],['pending assistant',x=>x.after.messages[0].status='sending'],
 ['state mutation at same revision',x=>x.after.commerce[0].state.entities[0].quantity=5],['hash mutation',x=>x.after.commerce[0].state_hash='other'],['lineage mutation',x=>x.after.commerce[0].source_message_id='other'],
 ['duplicate visitor row',x=>x.after.messages.push(structuredClone(x.after.messages.at(-1)))],['duplicate agent row',x=>x.after.messages.push(structuredClone(human))],['Auth user is not agent profile',x=>x.after.assignment[0].agent_id='auth-user'],
];
for(const [name,mutate]of negative)test(name+' rejected',()=>{const x=setup();mutate(x);assert.throws(()=>verifySuppression(x));});
test('polling binds exact canonical agent and actual UI',()=>{const x=setup();assert.equal(verifyDelivery({...x,receipt:x.poll,snapshot:x.after}),true);});
for(const [name,mutate] of [
 ['poll missing target',x=>x.poll.body.data.messages=[]],['poll duplicate target',x=>x.poll.body.data.messages.push(human)],['poll wrong content',x=>x.poll.body.data.messages[0]={...human,content:'other'}],['poll missing',x=>x.poll.body=null],['UI absent',x=>x.ui.customer_received.observed=false],['duplicate UI bubble',x=>x.ui.customer_received.displayed_bubble_count=2],['AI after original',x=>x.after.messages.push({...ai,id:'later-ai',created_at:'2026-10-05T10:01:00Z'})],
])test(name+' rejected',()=>{const x=setup();mutate(x);assert.throws(()=>verifyDelivery({...x,receipt:x.poll,snapshot:x.after}));});
test('original UI preservation uses real waiting baseline, not relabelled post-completion captures',()=>{const x=setup();const waiting=structuredClone(x.before);waiting.capture_kind='HISTORICAL_WAITING_SNAPSHOT';waiting.captured_at='2026-10-05T08:30:00Z';waiting.messages=[ai];const current=structuredClone(x.before);current.capture_kind='POST_COMPLETION_READBACK';assert.equal(verifyHistoricalControl({waiting,current,...x}),true);x.ui.summary_visible.observed=false;assert.throws(()=>verifyHistoricalControl({waiting,current,...x}));});
const collector=createRequire(import.meta.url)('./customer-control-collector.cjs');
function envFor(body){
 const keys={'nexus_widget_f6000000-0000-4000-8000-000000000130_conversation_id':'1f5d3608-86ba-40e5-aca8-83ea009293a5','nexus_widget_f6000000-0000-4000-8000-000000000130_channel_id':'f6000000-0000-4000-8000-000000000130','nexus_widget_f6000000-0000-4000-8000-000000000130_session_token':'synthetic-test-secret-value-32-characters'};
 return {location:{origin:'https://localhost:5173',pathname:'/phase1-demo'},document:{body:{innerText:['NONPRODUCTION','nbtowfuvvfqpxqydyoby',head,tree].join(' ')},querySelectorAll:()=>[{classList:{contains:r=>r==='agent'},textContent:'你好，我已接手，會按你之前提供的要求跟進。'}]},localStorage:{getItem:k=>keys[k]},AbortSignal,fetch:async()=>({status:200,json:async()=>body})};
}
const actualPoll=()=>({success:true,data:{messages:[{id:'1f8b22b1-9d67-42e8-8ab6-eda7e06dce43',role:'agent',content:'你好，我已接手，會按你之前提供的要求跟進。'}],ai_generating:false,human_support:{state:'assigned',agent_assigned:true,secret:'must-not-export'}}});
test('existing customer polling collector preserves observed body fields and never exports credentials',async()=>{const x=await collector.collect(envFor(actualPoll()));assert.equal(x.body.data.messages.length,1);assert.ok(!JSON.stringify(x).includes('secret'));assert.ok(!JSON.stringify(x).includes('session_token'));});
test('collector refuses wrong retained session before token read',async()=>{const e=envFor(actualPoll());e.localStorage.getItem=()=>null;await assert.rejects(collector.collect(e));});
test('collector refuses missing canonical target and generating AI',async()=>{const b=actualPoll();b.data.messages=[];await assert.rejects(collector.collect(envFor(b)));b.data.messages=actualPoll().data.messages;b.data.ai_generating=true;await assert.rejects(collector.collect(envFor(b)));});
function armedEnv(failSend=false){
 const e=envFor(actualPoll());e.alerts=[];e.alert=x=>e.alerts.push(x);e.sent=0;e.downloads=[];
 e.Blob=class{constructor(parts){e.downloads.push(JSON.parse(parts.join('')));}};
 e.URL={createObjectURL:()=> 'blob:synthetic',revokeObjectURL:()=>{}};e.setTimeout=()=>{};
 e.document.createElement=()=>({click(){},remove(){}});e.document.body.append=()=>{};
 e.fetch=async function(url){if(url.endsWith('/receive-widget-message')){e.sent++;if(failSend)throw Error('network failed');return {status:200,headers:{get:()=>null},clone:()=>({json:async()=>({success:true,data:{message_id:'new-probe',ai_reply_pending:false,control_state:'human_control'}})})};}return {status:200,json:async()=>actualPoll()};};
 return e;
}
const probeRequest=()=>({body:JSON.stringify({conversation_id:'1f5d3608-86ba-40e5-aca8-83ea009293a5',session_token:'synthetic-test-secret-value-32-characters',content:'收到，請繼續跟進。'})});
test('collector arms without sends, captures one normal Widget request and exports no secret',async()=>{const e=armedEnv();await collector.arm(e);assert.equal(e.sent,0);await e.fetch('https://nbtowfuvvfqpxqydyoby.supabase.co/functions/v1/receive-widget-message',probeRequest());assert.equal(e.sent,1);assert.equal(e.downloads.length,1);assert.equal(e.downloads[0].receipt.body.data.control_state,'human_control');assert.ok(!JSON.stringify(e.downloads).includes('synthetic-test-secret'));assert.ok(!JSON.stringify(e.downloads).includes('session_token'));});
test('failed one-shot collection never automatically resends and retains null receipt',async()=>{const e=armedEnv(true);await collector.arm(e);await e.fetch('https://nbtowfuvvfqpxqydyoby.supabase.co/functions/v1/receive-widget-message',probeRequest());assert.equal(e.sent,1);assert.equal(e.downloads[0].receipt,null);assert.equal(e.downloads[0].collection_status,'FAILED_DO_NOT_RESEND');});
