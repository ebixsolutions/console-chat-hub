import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';

// Render the complete existing component with React. Only transport, session,
// clock and decorative primitives are isolated. This is not Hosted/Auth proof.
const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));
const React=require('react');
const {create,act}=require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const fixture=globalThis.__c3Widget={};
const entry='src/routes/_authenticated/console.widget-preview.tsx';
const result=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'widget-isolated-boundaries',setup(b){
  b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
  b.onResolve({filter:/^@\/components\/console\/OrdinaryWidgetPreview$/},()=>({path:path.resolve('src/components/console/OrdinaryWidgetPreview.tsx')}));
 b.onResolve({filter:/^virtual:c3-widget-preview-source$/},()=>({path:'canonical-widget',namespace:'widget-source'}));
 b.onLoad({filter:/.*/,namespace:'widget-source'},()=>({contents:'export default () => '+JSON.stringify(fs.readFileSync('public/widget/chat.js','utf8'))+';'}));
 b.onResolve({filter:/^(lucide-react|@tanstack\/react-router|@\/hooks\/|@\/components\/|@\/integrations\/|@\/lib\/api\/)/},a=>({path:a.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>{
    const f='const f=globalThis.__c3Widget;';
    if(a.path==='lucide-react')return {contents:'export const AlertCircle=()=>null,Check=()=>null,Copy=()=>null,History=()=>null,Image=()=>null,Loader2=()=>null,MonitorDot=()=>null,Paperclip=()=>null,Plus=()=>null,Smile=()=>null,UserRound=()=>null,Video=()=>null;'};
    if(a.path==='@tanstack/react-router')return {contents:'export const createFileRoute=()=>x=>x;'};
    if(a.path.includes('runtime-authority'))return {contents:'export const resolveAuthoritativeSupabaseBinding=()=>({url:"https://nrfxhqabwblzxoushgnm.supabase.co"});'};
    if(a.path.includes('/supabase/client'))return {contents:f+'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"isolated-test-session"}},error:null})},functions:{invoke:(...args)=>f.invoke(...args)}};'};
    if(a.path.endsWith('useAuth'))return {contents:f+'export const useAuth=()=>({user:f.user});'};
    if(a.path.endsWith('useCurrentRole'))return {contents:'export const useCurrentRole=()=>({role:"admin",loading:false});'};
    if(a.path.endsWith('useEffectiveRole'))return {contents:'export const useConsoleLang=()=>"en";'};
    if(a.path.includes('config.service'))return {contents:'export const configService={};'};
    if(a.path.endsWith('PageStates'))return {contents:'export const LoadingState=()=>null,PermissionDenied=()=>null;'};
    const names=a.path.endsWith('/button')?['Button']:a.path.endsWith('/tabs')?['Tabs','TabsContent','TabsList','TabsTrigger']:['Select','SelectContent','SelectItem','SelectTrigger','SelectValue'];
    return {contents:'import React from "react";'+names.map(n=>`export const ${n}=p=>React.createElement("${n==='Button'?'button':'div'}",p,p.children);`).join('')};
  });
  b.onLoad({filter:/console\.widget-preview\.tsx$/},a=>({contents:(process.env.C3_WIDGET_PREVIEW_SOURCE_REF?execFileSync('git',['show',process.env.C3_WIDGET_PREVIEW_SOURCE_REF+':'+entry],{encoding:'utf8'}):fs.readFileSync(a.path,'utf8'))+'\nexport {PreviewWidget};',loader:'tsx'}));
}}]});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'c3-widget-react-'));
const file=path.join(temp,'widget.mjs');fs.writeFileSync(file,result.outputFiles[0].text);
const {PreviewWidget}=await import(pathToFileURL(file));
const company='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',channel='0405282f-77dc-47cf-8074-99dd3dc6c393',conversation='c7d3fa80-ed64-42d2-a48e-cda98dce5d71';
const storageKey=`widget_live_test:actor:${company}:${channel}`;
let calls=[],intervals=new Map(),store=new Map();
const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval;
test.after(()=>{globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;fs.rmSync(temp,{recursive:true,force:true});});
function reset(){
  calls=[];intervals=new Map();store=new Map([[storageKey,conversation]]);
  globalThis.setInterval=fn=>{const id={};intervals.set(id,fn);return id;};globalThis.clearInterval=id=>intervals.delete(id);
  globalThis.window={localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},addEventListener(){},removeEventListener(){}};
  globalThis.document={addEventListener(){},removeEventListener(){}};
  Object.assign(fixture,{user:{id:'actor'},historyError:false,loadError:false,loadThrows:false,human:false,assigned:false,generating:false,rows:[{id:'v0',role:'visitor',content:'Existing request'}],send:null,historyRows:[{conversation_id:conversation,message_count:1,latest_preview:'Existing request'}]});
  fixture.invoke=async(name,{body})=>{
    calls.push({name,body});assert.equal(name,'widget-live-ai-test');
    if(body.action==='readiness')return {error:null,data:{success:true,admission_action:'readiness',runtime_contract:'c3-widget-control-v2',actor_id:'actor',isolation_ready:true,execution_ready:false,remote_ready:false,company_id:company,channel_id:channel}};
    if(body.action==='history')return fixture.historyError?{error:new Error('unavailable'),data:null}:{error:null,data:{success:true,runtime_contract:"c3-widget-control-v2",actor_id:"actor",isolation_ready:true,execution_ready:false,remote_ready:false,company_id:company,channel_id:channel,history:fixture.historyRows}};
    if(body.action==='load'){
      if(fixture.loadThrows)throw new Error('network');
      if(fixture.loadError)return {error:new Error('unavailable'),data:null};
      return {error:null,data:{success:true,conversation_id:body.test_conversation_id,messages:fixture.rows,ai_generating:fixture.generating??false,human_control:fixture.human,assigned_agent_id:fixture.assigned?'agent':null}};
    }
    assert.equal(body.action,'send');return fixture.send?fixture.send(body):{error:null,data:{success:true,conversation_id:conversation,delivery_receipt:{persisted:true,conversation_id:conversation,client_message_id:body.client_message_id,visitor_message_id:'10000000-0000-4000-8000-000000000001'},messages:fixture.rows,ai_generating:fixture.generating??false,human_control:fixture.human,assigned_agent_id:fixture.assigned?'agent':null}};
  };
}
const props={scopeCompanyId:company,scopeChannelId:channel,lang:'en',mode:'live',theme:'classic',primary:'#000000',title:'Support',launcherIcon:'chat',placeholder:'Type',open:true,onOpenChange(){}};
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n?.children?.map(text).join('')??'';
const content=r=>text(r.toJSON());
const button=(r,label)=>r.root.findAllByType('button').find(n=>text({children:n.children})===label||n.props['aria-label']===label);
async function click(r,label){const b=button(r,label);assert.ok(b,'button '+label);assert.notEqual(b.props.disabled,true,label+' disabled');await act(async()=>b.props.onClick());}
async function mount(){let r;await act(async()=>{r=create(React.createElement(PreviewWidget,props));});return r;}
async function enter(r,value){await act(async()=>r.root.findByType('input').props.onChange({target:{value}}));}
async function tick(){await act(async()=>{for(const fn of [...intervals.values()])await fn();});}
async function close(r){await act(async()=>r.unmount());}
const sends=()=>calls.filter(x=>x.body.action==='send');

test('business readiness does not disable local identity/presence or explicit human request; mount only reads',async()=>{
  reset();const r=await mount();assert.equal(sends().length,0);assert(calls.every(x=>['readiness','load'].includes(x.body.action)));
  for(const input of ['你是誰','有人吗？','Please connect me to human support']){await enter(r,input);assert.equal(button(r,'Send').props.disabled,false);await click(r,'Send');}
  assert.deepEqual(sends().map(x=>x.body.query),['你是誰','有人吗？','Please connect me to human support']);await close(r);
});
test('history transport failure is not empty history and does not revoke independent verified scope',async()=>{
  reset();fixture.historyError=true;const r=await mount();await click(r,'Conversation History');assert.match(content(r),/History.*(?:unavailable|could not be loaded)/);assert(!content(r).includes('No Live AI Test history yet.'));assert.equal(r.root.findByType('input').props.disabled,false);assert.equal(button(r,'Send').props.disabled,true);
  assert.match(content(r),/scopeReady=true/);fixture.historyError=false;await click(r,'Conversation History');await click(r,'Conversation History');assert(!content(r).includes('History could not be loaded'));assert.equal(r.root.findByType('input').props.disabled,false);assert.equal(sends().length,0);await close(r);
});
test('three polling failures preserve messages, pause reads and explicitly restart the SAME conversation',async()=>{
  reset();const r=await mount();fixture.loadError=true;await tick();await tick();await tick();assert.match(content(r),/Conversation refresh failed/);assert.match(content(r),/Existing request/);const count=calls.length;await tick();assert.equal(calls.length,count);
  fixture.loadError=false;fixture.rows.push({id:'a1',role:'agent',content:'Actual agent message'});await click(r,'Refresh conversation');assert.match(content(r),/Actual agent message/);assert(!content(r).includes('Conversation refresh failed'));await tick();assert(calls.length>count);assert.equal(sends().length,0);await close(r);
});
test('thrown polling errors use the same recoverable read state without a delivery-unknown claim',async()=>{
  reset();const r=await mount();fixture.loadThrows=true;await tick();await tick();await tick();assert.match(content(r),/Conversation refresh failed/);assert(!content(r).includes('Delivery could not be confirmed'));fixture.loadThrows=false;await click(r,'Refresh conversation');assert(!content(r).includes('Conversation refresh failed'));await close(r);
});
test('human assignment keeps click-send enabled and never claims agent answered/took over from assignment alone',async()=>{
  reset();fixture.human=true;fixture.assigned=true;const r=await mount();assert.match(content(r),/does not confirm they have answered/);assert(!content(r).includes('has taken over'));await enter(r,'Follow-up for my agent');await click(r,'Send');assert.equal(sends().length,1);await close(r);
});
test('definitive prewrite business denial releases only this unsent draft; subsequent R1 remains reachable',async()=>{
  reset();fixture.send=async()=>({data:null,error:{context:new Response(JSON.stringify({success:false,error:'live_ai_execution_unavailable',retryable:false}),{status:503})}});const r=await mount();await enter(r,'Check current energy label');await click(r,'Send');assert.match(content(r),/not admitted and was not sent/);assert(!store.has(storageKey+':pending'));assert(!content(r).includes('Delivery could not be confirmed'));
  fixture.send=null;await enter(r,'Please connect me to human support');await click(r,'Send');assert.equal(sends().length,2);await close(r);
});
test('unknown send cannot replay, clear pending by New, or settle against unrelated history; source-bound readback recovers without resend',async()=>{
  reset();fixture.send=async()=>{throw new Error('unknown transport outcome');};const r=await mount();await enter(r,'Business request');await click(r,'Send');const pending=JSON.parse(store.get(storageKey+':pending'));assert.equal(sends().length,1);assert.equal(button(r,'Send').props.disabled,true);
  await click(r,'New Conversation');assert(store.has(storageKey+':pending'));assert.equal(sends().length,1);
  fixture.rows.push({id:'unrelated',role:'assistant',content:'Not this request',metadata:{source_message_id:'other'}});await click(r,'Refresh conversation');assert(store.has(storageKey+':pending'));assert.equal(sends().length,1);
  fixture.rows.push({id:'v1',role:'visitor',content:'Business request',metadata:{client_message_id:pending.id}},{id:'thinking',role:'assistant',content:'Thinking',metadata:{source_message_id:'v1',is_thinking:true}});await tick();assert(store.has(storageKey+':pending'));
  fixture.rows.push({id:'final',role:'assistant',content:'Persisted actual reply',metadata:{source_message_id:'v1'}});await tick();assert(!store.has(storageKey+':pending'));assert.equal(sends().length,1);assert.match(content(r),/Persisted actual reply/);await close(r);
});
test('pending delivery survives reload and remains blocked until exact visitor receipt in human-control readback',async()=>{
  reset();store.set(storageKey+':pending',JSON.stringify({id:'pending-id',text:'For my agent'}));fixture.human=true;const r=await mount();assert.equal(button(r,'Send').props.disabled,true);fixture.rows.push({id:'human-visitor',role:'visitor',content:'For my agent',metadata:{client_message_id:'pending-id'}});await tick();assert(!store.has(storageKey+':pending'));assert.equal(sends().length,0);await close(r);
});
test('scope changes discard old conversation data and require new verified context',async()=>{
  reset();const r=await mount();fixture.historyError=true;fixture.rows=[];await act(async()=>r.update(React.createElement(PreviewWidget,{...props,scopeChannelId:'different-channel'})));assert(!content(r).includes('Existing request'));assert.equal(r.root.findByType('input').props.disabled,false);assert.equal(r.root.findByType('input').props.value,'');assert.equal(button(r,'Send').props.disabled,true);assert.equal(sends().length,0);await close(r);
});

test('a polled AI-pending flag cannot intercept an explicit R1 when no send is in flight',async()=>{
  reset();fixture.generating=true;const r=await mount();await enter(r,'Please connect me to human support');assert.equal(button(r,'Send').props.disabled,false);await click(r,'Send');assert.equal(sends().length,1);assert.equal(sends()[0].body.query,'Please connect me to human support');await close(r);
});

test('HTTP200 success without exact persisted source receipt must remain pending and cannot be retried',async()=>{reset();fixture.send=async()=>({error:null,data:{success:true,conversation_id:conversation,messages:[]}});const r=await mount();await enter(r,'Who are you?');await click(r,'Send');assert(store.has(storageKey+':pending'));assert.equal(button(r,'Send').props.disabled,true);assert.match(content(r),/Delivery could not be confirmed/);await close(r);});

test('101-turn original C3 Widget source path preserves one conversation and distinct receipts without any paid provider calls',async()=>{
  reset();
  const r=await mount();
  let seq=0;
  fixture.send=async body=>{
    seq++;
    const visitorId='10000000-0000-4000-8000-'+seq.toString(16).padStart(12,'0');
    fixture.rows.push({id:visitorId,role:'visitor',content:body.query,metadata:{client_message_id:body.client_message_id}});
    return {error:null,data:{success:true,conversation_id:conversation,delivery_receipt:{persisted:true,conversation_id:conversation,client_message_id:body.client_message_id,visitor_message_id:visitorId},messages:fixture.rows,ai_generating:false,human_control:false,assigned_agent_id:null}};
  };
  for(let turn=1;turn<=101;turn++){
    await enter(r,'Independent customer turn '+turn+' — follow up on the same ticket');
    await click(r,'Send');
    assert.equal(sends().length,turn,'each turn issues one original guarded widget request');
    assert.equal(sends()[turn-1].body.test_conversation_id,conversation,'no new ticket between turns');
    assert(!store.has(storageKey+':pending'),'persisted receipt clears only current pending delivery');
  }
  assert.equal(new Set(sends().map(x=>x.body.client_message_id)).size,101,'no client message replay');
  assert.equal(new Set(fixture.rows.filter(x=>x.id!=='v0').map(x=>x.id)).size,101,'101 distinct new visitor receipts; pre-existing history excluded');
  assert.equal(sends().some(x=>x.name!=='widget-live-ai-test'),false,'no alternate backend');
  await close(r);
});
