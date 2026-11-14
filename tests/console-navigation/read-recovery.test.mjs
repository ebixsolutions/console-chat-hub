import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));
const React=require('react');const {create,act}=require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const f=globalThis.__readRecovery={};
async function component(entry){
 const result=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'transport-only',setup(b){
  b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
  b.onResolve({filter:/^(lucide-react|@tanstack\/react-router|@\/hooks\/|@\/components\/console\/PageStates|@\/integrations\/|@\/lib\/api\/feedback.service)/},a=>({path:a.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},a=>{const s='const f=globalThis.__readRecovery;';
   if(a.path==='@tanstack/react-router')return {contents:'export const createFileRoute=()=>x=>x; export const Link="a";'};
   if(a.path==='lucide-react')return {contents:'export const AlertCircle=()=>null,BarChart3=()=>null,Loader2=()=>null,MessageSquare=()=>null,Star=()=>null,Users=()=>null;'};
   if(a.path.includes('useEffectiveRole'))return {contents:s+'export const useConsoleLang=()=>f.lang;'};
   if(a.path.includes('/hooks/'))return {contents:s+'export const useCurrentRole=()=>({role:f.role,loading:false});'};
   if(a.path.includes('PageStates'))return {contents:'export const LoadingState=()=>"Loading",PermissionDenied=()=>"Permission denied";'};
   if(a.path.includes('feedback.service'))return {contents:s+'export const feedbackService={listFeedbackResponses:p=>{f.calls.push(p);return f.feedback(p);}};'};
   if(a.path.includes('/integrations/'))return {contents:s+'export const supabase={functions:{invoke:(name,p)=>{f.calls.push({name,...p});return f.invoke(name,p);}}};'};
   throw Error('Unexpected boundary '+a.path);
  });
 }}]});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-read-recovery-'));const file=path.join(dir,'ui.mjs');fs.writeFileSync(file,result.outputFiles[0].text);const mod=await import(pathToFileURL(file));fs.rmSync(dir,{recursive:true});return mod.Route.component;
}
const Visitor=await component('src/routes/_authenticated/console.visitor-analytics.tsx');
const Customer=await component('src/routes/_authenticated/console.customer360.tsx');
const Feedback=await component('src/routes/_authenticated/console.feedback-responses.tsx');
const Analytics=await component('src/routes/_authenticated/console.analytics.tsx');
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n?.children?.map(text).join('')??'';
const button=(r,label)=>r.root.findAllByType('button').find(n=>text(n.children)===label);
async function mount(C){let r;await act(async()=>{r=create(React.createElement(C));});return r;}
async function click(r,label){const b=button(r,label);assert(b,'Missing action: '+label);assert(!b.props.disabled);await act(async()=>b.props.onClick());}
const summary={total_sessions:1,total_conversations:1,total_messages:20,feedback_count:0,average_rating:null,status_counts:{pending:1},recent_sessions:[]};
function reset(){Object.assign(f,{role:'admin',lang:'en',calls:[],invoke:async()=>({data:{success:true,summary},error:null}),feedback:async()=>({ok:true,data:{rows:[],total:0}})});}
test('A14-017-C04/A14-018-C01 supporting: failed read is recoverable by one explicit retry',async()=>{
 reset();f.invoke=async()=>({data:null,error:{message:'unavailable'}});const r=await mount(Visitor);assert.match(text(r.toJSON()),/Failed to load analytics/);assert.equal(f.calls.length,1);
 f.invoke=async()=>({data:{success:true,summary},error:null});await click(r,'Retry');assert.match(text(r.toJSON()),/Total Messages/);assert.match(text(r.toJSON()),/20/);assert.equal(f.calls.length,2);await act(async()=>r.unmount());
});
test('A14-001-C04 supporting: malformed success is an error and does not crash the route',async()=>{
 reset();f.invoke=async()=>({data:{success:true,summary:{...summary,average_rating:undefined}},error:null});const r=await mount(Visitor);assert.match(text(r.toJSON()),/Failed to load analytics/);await act(async()=>r.unmount());
});
test('A14-015-C01 supporting: conversations without visitor sessions still show authoritative metrics',async()=>{
 reset();f.invoke=async()=>({data:{success:true,summary:{...summary,total_sessions:0}},error:null});const r=await mount(Visitor);assert.match(text(r.toJSON()),/Total Messages/);assert.match(text(r.toJSON()),/20/);await act(async()=>r.unmount());
});
test('A15-001-C04/A15-025-C04 supporting: directory transport error permits explicit read retry',async()=>{
 reset();f.invoke=async()=>{throw Error('offline')};const r=await mount(Customer);assert.match(text(r.toJSON()),/Failed to load customer context/);f.invoke=async()=>({data:{success:true,visitors:[]},error:null});await click(r,'Retry');assert.match(text(r.toJSON()),/No visitors found/);assert.equal(f.calls.length,2);await act(async()=>r.unmount());
});
const feedbackRow=(id,status)=>({id,conversation_id:id,channel:'website_widget',status,delivery_status:'pending',rating:null,feedback_text:null,created_at:'2026-01-01',responded_at:null});
test('A09-002-C01 supporting: slow prior filter cannot replace current filter rows',async()=>{
 reset();const pending=[];f.feedback=p=>new Promise(resolve=>pending.push({p,resolve}));const r=await mount(Feedback);
 await act(async()=>r.root.findAllByType('select')[0].props.onChange({target:{value:'responded'}}));assert.equal(pending.length,2);
 await act(async()=>pending[1].resolve({ok:true,data:{rows:[feedbackRow('current-filter','responded')],total:1}}));
 await act(async()=>pending[0].resolve({ok:true,data:{rows:[feedbackRow('stale-filter','pending')],total:1}}));
 assert.match(text(r.toJSON()),/current-/);assert(!text(r.toJSON()).includes('stale-fi'));await act(async()=>r.unmount());
});
test('A09-001-C04 supporting: failed read is not empty feedback and explicit retry recovers',async()=>{
 reset();f.feedback=async()=>({ok:false,error:'read_unavailable'});const r=await mount(Feedback);assert.match(text(r.toJSON()),/read_unavailable/);assert(!text(r.toJSON()).includes('No feedback responses found.'));f.feedback=async()=>({ok:true,data:{rows:[],total:0}});await click(r,'Retry');assert.match(text(r.toJSON()),/No feedback responses found./);assert.equal(f.calls.length,2);await act(async()=>r.unmount());
});
async function searchConversation(r,value){
 await act(async()=>r.root.findByProps({placeholder:'Conversation UUID'}).props.onChange({target:{value}}));
 await click(r,'Search');
}
test('A09-006 supporting: invalid conversation input cannot expose Retry for the previous broader query',async t=>{
 reset();const r=await mount(Feedback);t.after(async()=>act(async()=>r.unmount()));await searchConversation(r,'invalid-uuid');
 assert.match(text(r.toJSON()),/invalid_conversation_id/);
 assert.equal(Boolean(button(r,'Retry')),false,'input errors require correction with Search, never replay the old query');
 assert.equal(f.calls.length,1);
});
test('A09-006 supporting: clearing invalid input recovers the unchanged unfiltered query through Search',async t=>{
 reset();const r=await mount(Feedback);t.after(async()=>act(async()=>r.unmount()));await searchConversation(r,'invalid-uuid');
 await searchConversation(r,'');
 assert(!text(r.toJSON()).includes('invalid_conversation_id'));
 assert.match(text(r.toJSON()),/No feedback responses found/);
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].conversation_id,undefined);
});
test('A09-006 supporting: a pending old read failure cannot replace the newer UUID validation error',async t=>{
 reset();let resolve;f.feedback=()=>new Promise(done=>resolve=done);const r=await mount(Feedback);t.after(async()=>act(async()=>r.unmount()));
 await searchConversation(r,'invalid-uuid');
 await act(async()=>resolve({ok:false,error:'old_read_failure'}));
 assert.match(text(r.toJSON()),/invalid_conversation_id/);
 assert(!text(r.toJSON()).includes('old_read_failure'));
 assert.equal(f.calls.length,1);
});
test('A09-006-C04/C06 supporting: correction and Enter recover the same exact conversation scope',async t=>{
 reset();const id='11111111-1111-4111-8111-111111111111';
 f.feedback=async p=>({ok:true,data:{rows:[feedbackRow(p.conversation_id??'initial','pending')],total:1}});
 const r=await mount(Feedback);t.after(async()=>act(async()=>r.unmount()));
 await searchConversation(r,id);assert.equal(f.calls.length,2);
 await searchConversation(r,'invalid-uuid');assert.equal(f.calls.length,2);
 await act(async()=>r.root.findByProps({placeholder:'Conversation UUID'}).props.onChange({target:{value:id}}));
 await act(async()=>r.root.findByProps({placeholder:'Conversation UUID'}).props.onKeyDown({key:'Enter'}));
 assert(!text(r.toJSON()).includes('invalid_conversation_id'));
 assert.equal(f.calls.length,3);assert.equal(f.calls[2].conversation_id,id);
 assert.equal(r.root.findByType('a').props.params.id,id);
});
test('A14-001-C07/A15-001-C07/A09-001-C07 supporting: forbidden role does not invoke readers',async()=>{
 reset();f.role='visitor';for(const C of [Visitor,Customer,Feedback]){const r=await mount(C);assert.match(text(r.toJSON()),/Permission [Dd]enied/);await act(async()=>r.unmount());}assert.equal(f.calls.length,0);
});
test('A16-001-C04 supporting: Analytics summary read error permits explicit retry',async()=>{
 reset();f.invoke=async()=>({data:null,error:{message:'unavailable'}});const r=await mount(Analytics);assert.match(text(r.toJSON()),/Analytics unavailable/);f.invoke=async()=>({data:{success:true,summary},error:null});await click(r,'Retry');assert.match(text(r.toJSON()),/Messages/);assert.equal(f.calls.length,2);await act(async()=>r.unmount());
});
const visitor='11111111-1111-4111-8111-111111111111';
const directory={success:true,visitors:[{id:visitor,identity:{name:'Read recovery visitor'},conversation_count:1,channel_name:'Widget',created_at:null,last_seen_at:null}]};
const customer={visitor_session_id:visitor,identity:{name:'Read recovery visitor'},conversations:[],feedback:[],evaluations:[],emotion_points:[]};
test('A15-025-C04 supporting: same visitor detail retries after read failure with no writes',async()=>{
 reset();f.invoke=async(_,p)=>({data:p.body.mode==='directory'?directory:null,error:p.body.mode==='directory'?null:{message:'unavailable'}});const r=await mount(Customer);assert.match(text(r.toJSON()),/Failed to load customer context/);f.invoke=async()=>({data:{success:true,customer},error:null});await click(r,'Retry');assert(!text(r.toJSON()).includes('Failed to load customer context'));assert.equal(f.calls.length,3);assert.deepEqual(f.calls[2].body,{mode:'detail',visitor_session_id:visitor});await act(async()=>r.unmount());
});
test('A15-003-C04 supporting: wrong visitor success never exposes foreign detail',async()=>{
 reset();f.invoke=async(_,p)=>({data:p.body.mode==='directory'?directory:{success:true,customer:{...customer,visitor_session_id:'foreign',identity:{name:'FOREIGN DETAIL'}}},error:null});const r=await mount(Customer);assert.match(text(r.toJSON()),/Failed to load customer context/);assert(!text(r.toJSON()).includes('FOREIGN DETAIL'));await act(async()=>r.unmount());
});
