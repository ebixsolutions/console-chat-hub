import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';

// Real React DOM + jsdom input elements and user-event editing. Only session,
// transport and decorative boundaries are fixtures. Never loads a remote page.
const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));
const {JSDOM}=require('jsdom');
const dom=new JSDOM('<!doctype html><body></body>',{url:'https://widget-input.invalid',pretendToBeVisual:true});
for(const key of ['window','document','Node','HTMLElement','HTMLInputElement','Event','KeyboardEvent','CompositionEvent','InputEvent','MouseEvent'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react');const {act}=React;const {createRoot}=require('react-dom/client');
const userEvent=require('@testing-library/user-event').default;
const f=globalThis.__widgetInput={};
const entry='src/routes/_authenticated/console.widget-preview.tsx';
const compiled=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'input-dom-boundaries',setup(b){
 b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^@\/components\/console\/OrdinaryWidgetPreview$/},()=>({path:path.resolve('src/components/console/OrdinaryWidgetPreview.tsx')}));
 b.onResolve({filter:/^virtual:c3-widget-preview-source$/},()=>({path:'canonical-widget',namespace:'widget-source'}));
 b.onLoad({filter:/.*/,namespace:'widget-source'},()=>({contents:'export default () => '+JSON.stringify(fs.readFileSync('public/widget/chat.js','utf8'))+';'}));
 b.onResolve({filter:/^(lucide-react|@tanstack\/react-router|@\/hooks\/|@\/components\/|@\/integrations\/|@\/lib\/api\/)/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{const s='const f=globalThis.__widgetInput;';
  if(a.path==='lucide-react')return {contents:'export const AlertCircle=()=>null,Check=()=>null,Copy=()=>null,History=()=>null,Image=()=>null,Loader2=()=>null,MonitorDot=()=>null,Paperclip=()=>null,Plus=()=>null,Smile=()=>null,UserRound=()=>null,Video=()=>null;'};
  if(a.path==='@tanstack/react-router')return {contents:'export const createFileRoute=()=>x=>x;'};
  if(a.path.includes('runtime-authority'))return {contents:'export const resolveAuthoritativeSupabaseBinding=()=>({url:"https://unreachable.invalid"});'};
  if(a.path.includes('/supabase/client'))return {contents:s+'export const supabase={auth:{getSession:async()=>({data:{session:f.actor?{access_token:"isolated-session"}:null},error:null})},functions:{invoke:(...args)=>f.invoke(...args)}};'};
  if(a.path.endsWith('useAuth'))return {contents:s+'export const useAuth=()=>({user:f.actor});'};
  if(a.path.endsWith('useCurrentRole'))return {contents:'export const useCurrentRole=()=>({role:"admin",loading:false});'};
  if(a.path.endsWith('useEffectiveRole'))return {contents:'export const useConsoleLang=()=>"en";'};
  if(a.path.includes('config.service'))return {contents:'export const configService={};'};
  if(a.path.endsWith('PageStates'))return {contents:'export const LoadingState=()=>null,PermissionDenied=()=>null;'};
  const names=a.path.endsWith('/button')?['Button']:a.path.endsWith('/tabs')?['Tabs','TabsContent','TabsList','TabsTrigger']:['Select','SelectContent','SelectItem','SelectTrigger','SelectValue'];
  return {contents:'import React from "react";'+names.map(n=>`export const ${n}=p=>React.createElement("${n==='Button'?'button':'div'}",p,p.children);`).join('')};
 });
 b.onLoad({filter:/console\.widget-preview\.tsx$/},a=>({contents:(process.env.C3_WIDGET_PREVIEW_SOURCE_REF?execFileSync('git',['show',process.env.C3_WIDGET_PREVIEW_SOURCE_REF+':'+entry],{encoding:'utf8'}):fs.readFileSync(a.path,'utf8'))+'\nexport {PreviewWidget};',loader:'tsx'}));
}}]});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'c3-widget-input-dom-'));const modulePath=path.join(temp,'widget.mjs');fs.writeFileSync(modulePath,compiled.outputFiles[0].text);
const {PreviewWidget}=await import(pathToFileURL(modulePath));
const company='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',channel='0405282f-77dc-47cf-8074-99dd3dc6c393',conversation='c7d3fa80-ed64-42d2-a48e-cda98dce5d71';
const key=`widget_live_test:actor:${company}:${channel}`;
const props={scopeCompanyId:company,scopeChannelId:channel,lang:'en',mode:'live',theme:'classic',primary:'#000',title:'Support',launcherIcon:'chat',placeholder:'Type',open:true,onOpenChange(){}};
const originalInterval=globalThis.setInterval,originalClear=globalThis.clearInterval,originalFetch=globalThis.fetch;
let intervals,calls,network;
globalThis.fetch=async()=>{network++;throw Error('Remote network forbidden in local DOM test');};
test.after(()=>{globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;globalThis.fetch=originalFetch;dom.window.close();fs.rmSync(temp,{recursive:true,force:true});});
function reset(){
 document.body.innerHTML='';window.localStorage.clear();intervals=new Map();calls=[];network=0;
 globalThis.setInterval=fn=>{const id={};intervals.set(id,fn);return id;};globalThis.clearInterval=id=>intervals.delete(id);
 Object.assign(f,{actor:{id:'actor'},ready:true,wrongTenant:false,status:'open',human:false,readOnly:false});
 f.historyResponse=null;
 f.invoke=async(name,{body})=>{calls.push(body);assert.equal(name,'widget-live-ai-test');
  if(body.action==='history' && f.historyResponse)return f.historyResponse;
  if(body.action==='history')return {error:null,data:{success:true,runtime_contract:"c3-widget-control-v2",actor_id:"actor",isolation_ready:f.ready,execution_ready:false,remote_ready:false,company_id:f.wrongTenant?'foreign':company,channel_id:channel,history:[]}};
  if(body.action==='load')return {error:null,data:{success:true,conversation_id:body.test_conversation_id,conversation_status:f.status,human_control:f.human,read_only:f.readOnly,messages:[]}};
  return {error:new Error('Unexpected dispatch trapped by local fixture'),data:null};
 };
}
async function mount(t){const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host);await act(async()=>root.render(React.createElement(PreviewWidget,props)));let closed=false;const close=async()=>{if(!closed){closed=true;await act(async()=>root.unmount());host.remove();}};t.after(close);return {host,root,close,user:userEvent.setup({document})};}
const isSend=c=>c.action==='send'||c.action==='original_preview_send';
const field=r=>r.host.querySelector('input');
const button=(r,label)=>[...r.host.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);
const edit=async(r,text)=>act(async()=>r.user.type(field(r),text));
const click=async(r,el)=>act(async()=>r.user.click(el));
function noDispatch(){assert.equal(calls.filter(c=>isSend(c)).length,0,'input must never dispatch');assert.equal(network,0);}
test('original Preview archive is readable but Send, Enter and emoji cannot write; new conversation restores draft input',async t=>{
 reset();f.readOnly=true;f.human=true;window.localStorage.setItem(key,conversation);
 const r=await mount(t);
 assert(calls.some(c=>c.action==='load'&&c.test_conversation_id===conversation));
 assert.match(r.host.textContent,/original Preview conversation is read-only/);
 assert.equal(field(r).disabled,true);assert.equal(button(r,'Send').disabled,true);
 await click(r,button(r,'Send'));await act(async()=>r.user.keyboard('{Enter}'));noDispatch();
 await click(r,button(r,'New Conversation'));assert.equal(field(r).disabled,false);
 await edit(r,'A new draft');assert.equal(field(r).value,'A new draft');noDispatch();
});
test('switching from current conversation to archive blocks input before delayed read completes',async t=>{
 reset();f.historyResponse={error:null,data:{success:true,runtime_contract:'c3-widget-control-v2',actor_id:'actor',isolation_ready:true,execution_ready:false,remote_ready:false,company_id:company,channel_id:channel,history:[{conversation_id:conversation,message_count:3,latest_preview:'Original answer',read_only:true}]}};
 const invoke=f.invoke;let complete;
 f.invoke=async(name,args)=>args.body.action==='load'?await new Promise(resolve=>{complete=resolve;}):invoke(name,args);
 const r=await mount(t);await click(r,button(r,'Conversation History'));
 const archive=[...r.host.querySelectorAll('button')].find(b=>b.textContent.includes('Preview archive'));
 assert(archive);await click(r,archive);assert.equal(field(r).disabled,true);
 await act(async()=>complete({error:null,data:{success:true,conversation_id:conversation,read_only:true,messages:[]}}));
 assert.equal(field(r).disabled,true);noDispatch();
});
test('original symptom: scope-unready real DOM keyboard and emoji must share safe draft editability',async t=>{
 reset();f.ready=false;const r=await mount(t);
 const disabled=field(r).disabled;await click(r,button(r,'Emoji'));const first=r.host.querySelector('[aria-label^="Insert "]');await click(r,first);
 console.log(JSON.stringify({local_state:'scope-unready',keyboard_disabled:disabled,emoji_inserted:field(r).value.length>0}));
 assert.equal(disabled,false);await act(async()=>r.user.clear(field(r)));await edit(r,'你好 Hello 123 !?');
 assert.equal(field(r).value,'你好 Hello 123 !?');assert.equal(field(r).disabled,false);
 assert.equal(button(r,'Send').disabled,true);assert.match(r.host.textContent,/channel is unavailable/);
 await click(r,button(r,'Emoji'));const emoji=r.host.querySelector('[aria-label^="Insert "]');const value=emoji.textContent;await click(r,emoji);assert.ok(field(r).value.includes(value));
 await act(async()=>r.user.keyboard('{Enter}'));noDispatch();
});
test('DOM keyboard, paste, Backspace, selection, focus and unrelated rerender retain the controlled draft',async t=>{
 reset();const r=await mount(t);await edit(r,'廣東話 Traditional 123 !?');
 await act(async()=>r.user.paste('，空 格 / $ @'));const before=field(r).value;
 field(r).setSelectionRange(0,3);await act(async()=>r.user.keyboard('{Backspace}'));assert.equal(field(r).value,before.slice(3));const kept=field(r).value;
 await click(r,button(r,'Emoji'));await click(r,field(r));
 await act(async()=>r.root.render(React.createElement(PreviewWidget,{...props,title:'Updated title'})));assert.equal(field(r).value,kept);noDispatch();
});
test('DOM Chinese IME composition Enter and keyCode229 never submit',async t=>{
 reset();const r=await mount(t);await click(r,field(r));
 await act(async()=>field(r).dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true,data:''})));
 await edit(r,'中文輸入');
 await click(r,button(r,'Emoji'));assert.equal(r.host.querySelector('[aria-label^="Insert "]'),null);
 await act(async()=>field(r).dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:true,keyCode:13})));
 await act(async()=>field(r).dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:false,keyCode:13})));
 await act(async()=>field(r).dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true,data:'中文輸入'})));
 await act(async()=>field(r).dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:false,keyCode:229})));
 assert.equal(field(r).value,'中文輸入');noDispatch();
});
test('DOM emoji replaces the real selection and preserves subsequent normal typing',async t=>{
 reset();const r=await mount(t);await edit(r,'abc123');field(r).setSelectionRange(1,4);
 await click(r,button(r,'Emoji'));const emoji=r.host.querySelector('[aria-label^="Insert "]');const value=emoji.textContent;await click(r,emoji);
 assert.equal(field(r).value,'a'+value+'23');assert.equal(field(r).selectionStart,1+value.length);
 await act(async()=>r.user.keyboard('Z'));assert.equal(field(r).value,'a'+value+'Z23');
 field(r).setSelectionRange(1,1+value.length);await click(r,button(r,'Emoji'));await click(r,r.host.querySelector('[aria-label^="Insert "]'));
 assert.equal(field(r).selectionStart,1+value.length);assert.equal(field(r).selectionEnd,1+value.length);
 await act(async()=>r.user.keyboard('Q'));assert.equal(field(r).value,'a'+value+'QZ23');noDispatch();
});
test('local draft survives real unmount/remount without a send or cross-actor restore',async t=>{
 reset();f.ready=false;const r=await mount(t);await edit(r,'保留草稿 123');await r.close();const next=await mount(t);assert.equal(field(next).value,'保留草稿 123');await next.close();
 f.actor={id:'other-actor'};const other=await mount(t);assert.equal(field(other).value,'');noDispatch();
});
test('wrong Tenant or absent Actor cannot send or use emoji to bypass a disabled editor',async t=>{
 reset();f.actor=null;const r=await mount(t);assert.equal(field(r).disabled,true);assert.equal(button(r,'Emoji').disabled,true);await edit(r,'denied');assert.equal(field(r).value,'');await r.close();
 f.actor={id:'actor'};f.wrongTenant=true;const wrong=await mount(t);await edit(wrong,'local only');assert.equal(button(wrong,'Send').disabled,true);await act(async()=>wrong.user.keyboard('{Enter}'));noDispatch();
});
test('resolved Live conversation disables text and emoji and offers only the existing New Conversation flow',async t=>{
 reset();f.status='resolved';window.localStorage.setItem(key,conversation);const r=await mount(t);
 assert.equal(field(r).disabled,true);assert.equal(button(r,'Emoji').disabled,true);assert.equal(button(r,'Send').disabled,true);assert.match(r.host.textContent,/resolved.*New Conversation/i);
 await click(r,button(r,'New Conversation'));assert.equal(field(r).disabled,false);noDispatch();
});
test('unknown pending delivery remains locked across reload and cannot be cleared by New Conversation',async t=>{
 reset();window.localStorage.setItem(key,conversation);window.localStorage.setItem(key+':pending',JSON.stringify({id:'pending-id',text:'Pending exact text'}));const r=await mount(t);
 assert.equal(field(r).value,'Pending exact text');assert.equal(field(r).disabled,true);assert.equal(button(r,'Emoji').disabled,true);assert.equal(button(r,'Send').disabled,true);
 await click(r,button(r,'New Conversation'));assert.ok(window.localStorage.getItem(key+':pending'));noDispatch();
});
test('human control still permits local visitor composition without inventing a human reply or sending',async t=>{
 reset();f.human=true;window.localStorage.setItem(key,conversation);const r=await mount(t);await edit(r,'給真人客服的草稿');assert.equal(field(r).value,'給真人客服的草稿');assert.equal(field(r).disabled,false);noDispatch();
});
test('local draft is separated by Channel and survives an unrelated server poll',async t=>{
 reset();window.localStorage.setItem(key,conversation);const r=await mount(t);await edit(r,'同一票草稿');await act(async()=>{for(const poll of intervals.values())await poll();});assert.equal(field(r).value,'同一票草稿');
 await act(async()=>r.root.render(React.createElement(PreviewWidget,{...props,scopeChannelId:'other-channel'})));assert.equal(field(r).value,'');assert.equal(button(r,'Send').disabled,true);noDispatch();
});

test('scope diagnostics preserve HTTP auth, conflict and readiness distinctions without dispatch',async t=>{
 for(const status of [401,403,409,503]){
  reset();f.historyResponse={data:null,error:{context:new Response('{}',{status})}};const r=await mount(t);
  assert.match(r.host.textContent,new RegExp('HTTP '+status));assert.equal(button(r,'Send').disabled,true);await edit(r,'safe local draft');noDispatch();await r.close();
 }
});
test('non-C3 scope and selected-channel mismatch are explicit, draft-only and never broaden tenant access',async t=>{
 reset();f.ready=false;const r=await mount(t);assert.match(r.host.textContent,/C3 isolated test scope is not available/);assert.equal(button(r,'Send').disabled,true);noDispatch();await r.close();
 reset();f.wrongTenant=true;const wrong=await mount(t);assert.match(wrong.host.textContent,/selected company\/channel does not match/);assert.equal(button(wrong,'Send').disabled,true);noDispatch();
});
test('execution and remote readiness are not described as role denial or empty KB',async t=>{
 reset();f.historyResponse={data:{success:true,runtime_contract:"c3-widget-control-v2",actor_id:"actor",isolation_ready:true,company_id:company,channel_id:channel,execution_ready:false,execution_failure:{code:'UAT_REMOTE_BOUND_UNVERIFIED',stage:'admission',retryable:false},remote_ready:false,history:[]},error:null};const r=await mount(t);assert.match(r.host.textContent,/UAT_REMOTE_BOUND_UNVERIFIED/);noDispatch();await r.close();
 reset();f.historyResponse={data:{success:true,runtime_contract:"c3-widget-control-v2",actor_id:"actor",isolation_ready:true,company_id:company,channel_id:channel,execution_ready:true,remote_ready:false,history:[]},error:null};const remote=await mount(t);assert.match(remote.host.textContent,/remote KB queries are not yet authorized/);noDispatch();
});

test('actual v13-shaped history lacks send admission proof; HTTP200 cannot authorize Send',async t=>{
 reset();f.historyResponse={data:{success:true,mode:'persistent_live_ai_test',isolation_ready:true,company_id:company,channel_id:channel,history:[]},error:null};const r=await mount(t);await edit(r,'Check energy label');assert.equal(button(r,'Send').disabled,true);assert.match(r.host.textContent,/backend has not proven/);assert.match(r.host.textContent,/backend_runtime_contract_unverified/);noDispatch();
});
test('pending without conversation id has read-only reconciliation, never automatic resend or New bypass',async t=>{
 reset();const id='10000000-0000-4000-8000-000000000001';window.localStorage.setItem(key+':pending',JSON.stringify({id,text:'unknown original'}));const r=await mount(t);assert.match(r.host.textContent,/previous_delivery_unresolved/);const check=button(r,'Check original delivery');assert(check);await click(r,check);assert.equal(calls.filter(c=>c.action==='reconcile').length,1);assert.equal(button(r,'Send').disabled,true);assert.equal(field(r).value,'unknown original');noDispatch();
});

test('same-company/channel response for another authenticated actor is not send authority',async t=>{reset();f.historyResponse={error:null,data:{success:true,runtime_contract:'c3-widget-control-v2',actor_id:'foreign-actor',isolation_ready:true,company_id:company,channel_id:channel,execution_ready:false,remote_ready:false,history:[]}};const r=await mount(t);await edit(r,'Who are you?');assert(button(r,'Send').disabled);assert.match(r.host.textContent,/authenticated_actor_mismatch/);noDispatch();});
test('authorized free-form opens server-selected ticket and sends unchanged text and stable delivery ID',async t=>{
 reset();f.historyResponse={error:null,data:{success:true,runtime_contract:'c3-widget-control-v2',actor_id:'actor',isolation_ready:true,company_id:company,channel_id:channel,execution_ready:true,remote_ready:false,authorized_preview_available:true,history:[]}};
 const invoke=f.invoke;
 f.invoke=async(name,args)=>{
  if(args.body.action==='open_authorized'){calls.push(args.body);return {error:null,data:{success:true,conversation_id:conversation,conversation_status:'open',read_only:false,messages:[]}};}
  if(isSend(args.body)){calls.push(args.body);return {error:null,data:{success:true,conversation_id:conversation,conversation_status:'open',delivery_receipt:{persisted:true,conversation_id:conversation,client_message_id:args.body.client_message_id,visitor_message_id:channel},messages:[{id:channel,role:'assistant',content:'Isolated persisted answer'}]}};}
  return invoke(name,args);
 };
 const r=await mount(t);const open=button(r,'Open authorized AI conversation');assert(open);await click(r,open);
 assert.deepEqual(calls.find(c=>c.action==='open_authorized'),{action:'open_authorized'});
 await edit(r,'Please compare options for my business.');await click(r,button(r,'Send'));
 const sends=calls.filter(c=>isSend(c));assert.equal(sends.length,1);assert.equal(sends[0].test_conversation_id,conversation);assert.equal(sends[0].query,'Please compare options for my business.');assert.match(sends[0].client_message_id,/^[a-f0-9-]{36}$/i);assert.match(r.host.textContent,/Isolated persisted answer/);assert.equal(network,0);
});
test('authorized free-form entry requires verified actor and execution readiness',async t=>{
 for(const overrides of [{actor_id:'other'},{execution_ready:false},{authorized_preview_available:false}]){
  reset();f.historyResponse={error:null,data:{success:true,runtime_contract:'c3-widget-control-v2',actor_id:'actor',isolation_ready:true,company_id:company,channel_id:channel,execution_ready:true,remote_ready:false,authorized_preview_available:true,history:[],...overrides}};
  const r=await mount(t);assert.equal(button(r,'Open authorized AI conversation'),undefined);assert(!calls.some(c=>c.action==='open_authorized'));noDispatch();await r.close();
 }
});
test('authorized free-form cannot switch away from unresolved delivery',async t=>{
 reset();window.localStorage.setItem(key+':pending',JSON.stringify({id:channel,text:'Unresolved prior delivery'}));
 f.historyResponse={error:null,data:{success:true,runtime_contract:'c3-widget-control-v2',actor_id:'actor',isolation_ready:true,company_id:company,channel_id:channel,execution_ready:true,remote_ready:false,authorized_preview_available:true,history:[]}};
 const r=await mount(t);const open=button(r,'Open authorized AI conversation');assert(open);assert(open.disabled);await click(r,open);assert(!calls.some(c=>c.action==='open_authorized'));noDispatch();
});
test('original account Preview uses normal free-form Send without lease ticket selection or browser authority flags',async t=>{
 reset();f.historyResponse={error:null,data:{success:true,runtime_contract:'c3-widget-control-v2',actor_id:'actor',isolation_ready:true,company_id:company,channel_id:channel,execution_class:'authenticated_admin_preview',execution_ready:true,remote_ready:false,authorized_preview_available:false,history:[]}};
 const invoke=f.invoke;f.invoke=async(name,args)=>{if(isSend(args.body)){calls.push(args.body);return {error:null,data:{success:true,conversation_id:conversation,conversation_status:'open',delivery_receipt:{persisted:true,conversation_id:conversation,client_message_id:args.body.client_message_id,visitor_message_id:channel},messages:[{id:channel,role:'assistant',content:'Isolated original Preview reply'}]}};}return invoke(name,args);};
 const r=await mount(t);assert.equal(button(r,'Open authorized AI conversation'),undefined);await edit(r,'Help me compare options for my new business, in Cantonese.');await click(r,button(r,'Send'));const first=calls.find(c=>isSend(c));assert.equal(first.query,'Help me compare options for my new business, in Cantonese.');assert.equal(first.action,'original_preview_send');assert.deepEqual(Object.keys(first).sort(),['action','client_message_id','query']);assert.match(r.host.textContent,/Isolated original Preview reply/);await edit(r,'Correction: my room is 150 square feet.');await click(r,button(r,'Send'));const sends=calls.filter(c=>isSend(c));assert.equal(sends.length,2);assert.equal(sends[1].test_conversation_id,conversation);assert.notEqual(sends[1].client_message_id,first.client_message_id);assert.equal(network,0);
});
test('original account missing paid authorization remains explicit, preserves draft and never auto-retries',async t=>{
 reset();f.historyResponse={error:null,data:{success:true,runtime_contract:'c3-widget-control-v2',actor_id:'actor',isolation_ready:true,company_id:company,channel_id:channel,execution_class:'authenticated_admin_preview',execution_ready:false,remote_ready:false,execution_failure:{code:'ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED',stage:'admission',retryable:false},history:[]}};
 const invoke=f.invoke;f.invoke=async(name,args)=>{if(isSend(args.body)){calls.push(args.body);return {error:null,data:{success:false,error:'live_ai_execution_unavailable',retryable:false,failure:{code:'ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED'}}};}return invoke(name,args);};
 const r=await mount(t);assert.match(r.host.textContent,/ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED/);await edit(r,'A real free-form business question');await click(r,button(r,'Send'));assert.equal(field(r).value,'A real free-form business question');assert.equal(window.localStorage.getItem(key+':pending'),null);assert.equal(calls.filter(c=>isSend(c)).length,1);assert.equal(network,0);
});
test('original permission never converts a restored synthetic ticket; New Conversation opens the normal original Preview draft',async t=>{
 reset();window.localStorage.setItem(key,conversation);f.historyResponse={error:null,data:{success:true,runtime_contract:'c3-widget-control-v2',actor_id:'actor',isolation_ready:true,company_id:company,channel_id:channel,execution_class:'authenticated_admin_preview',execution_ready:true,remote_ready:false,history:[]}};
 const invoke=f.invoke;f.invoke=async(name,args)=>args.body.action==='load'?{error:null,data:{success:true,conversation_id:conversation,read_only:true,read_only_reason:'synthetic_uat_start_new_original_preview',messages:[]}}:invoke(name,args);
 const r=await mount(t);assert.match(r.host.textContent,/Select New Conversation/);assert(!r.host.textContent.includes('disabled for this archive'));assert.equal(field(r).disabled,true);await click(r,button(r,'New Conversation'));assert.equal(field(r).disabled,false);await edit(r,'A new unrestricted customer-service question');assert.equal(field(r).value,'A new unrestricted customer-service question');noDispatch();
});
