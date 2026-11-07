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
const f=globalThis.__actionExports={};
const downloads=[];globalThis.document={createElement:()=>({click(){downloads.push({name:this.download,blob:f.blob});},remove(){}}),body:{appendChild(){}}};
URL.createObjectURL=blob=>(f.blob=blob,'blob:isolated');URL.revokeObjectURL=()=>{};
async function component(entry){
 const result=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'boundaries',setup(b){
 b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^(lucide-react|@tanstack\/react-router|@\/hooks\/|@\/components\/console\/PageStates|@\/integrations\/|@\/lib\/api\/)/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{const s='const f=globalThis.__actionExports;';
 if(a.path==='@tanstack/react-router')return {contents:'export const createFileRoute=()=>x=>x; export const Link="a";'};
 if(a.path==='lucide-react')return {contents:'export const AlertCircle=()=>null,BarChart3=()=>null,Loader2=()=>null,MessageSquare=()=>null,Star=()=>null,Users=()=>null;'};
 if(a.path.includes('useEffectiveRole'))return {contents:'export const useConsoleLang=()=>"en";'};
 if(a.path.includes('/hooks/'))return {contents:s+'export const useCurrentRole=()=>({role:f.role,loading:false});'};
 if(a.path.includes('PageStates'))return {contents:'export const LoadingState=()=>"Loading",PermissionDenied=()=>"Permission denied";'};
 if(a.path.includes('feedback.service'))return {contents:s+'export const feedbackService={listFeedbackResponses:p=>{f.calls.push(p);return f.feedback(p);}};'};
 if(a.path.includes('/integrations/'))return {contents:s+'export const supabase={functions:{invoke:async(name,body)=>{f.calls.push({name,...body});return f.analytics;}}};'};
 throw Error('Unexpected boundary '+a.path);
 });}}]});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-original-action-'));const file=path.join(dir,'component.mjs');fs.writeFileSync(file,result.outputFiles[0].text);const mod=await import(pathToFileURL(file));fs.rmSync(dir,{recursive:true});return mod.Route.component;
}
const Feedback=await component('src/routes/_authenticated/console.feedback-responses.tsx');
const Analytics=await component('src/routes/_authenticated/console.analytics.tsx');
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n?.children?.map(text).join('')??'';
const button=(r,label)=>r.root.findAllByType('button').find(n=>text({children:n.children})===label);
async function mount(C){let r;await act(async()=>{r=create(React.createElement(C));});return r;}
async function click(r,label){const b=button(r,label);assert(b,'Missing original action: '+label);assert(!b.props.disabled);await act(async()=>b.props.onClick());}
const row=i=>({id:'r'+i,conversation_id:'ticket',channel:'website_widget',status:'responded',rating:0,feedback_text:i===0?'=HYPERLINK("bad")\n客戶,回饋':'Feedback '+i,responded_at:null,created_at:'2026-01-01'});
function reset(){Object.assign(f,{role:'admin',calls:[],feedback:async p=>({ok:true,data:{rows:Array.from({length:53},(_,i)=>row(i)).slice(p.page*p.page_size,(p.page+1)*p.page_size),total:53}}),analytics:{error:null,data:{success:true,summary:{total_sessions:0,total_conversations:3,total_messages:7,feedback_count:0,average_rating:null,status_counts:{open:2,resolved:1}}}}});downloads.length=0;}
test('A09-010 actual Feedback UI exports every filtered page, quoted Unicode and formula-neutral text; no writes',async()=>{reset();const r=await mount(Feedback);await act(async()=>r.root.findAllByType('select')[0].props.onChange({target:{value:'responded'}}));await click(r,'Export filtered CSV');assert.equal(downloads.length,1);const csv=await downloads[0].blob.text();assert(csv.includes('r52'));assert(csv.includes("'=HYPERLINK"));assert(csv.includes('客戶,回饋'));assert(f.calls.filter(x=>x.page_size===50).every(x=>x.status==='responded'));assert.equal(f.calls.filter(x=>x.page_size===50).length,2);await act(async()=>r.unmount());});
test('A09-010 later-page error refuses partial export and permits explicit export retry',async()=>{reset();const r=await mount(Feedback);const good=f.feedback;f.feedback=async p=>p.page_size===50&&p.page===1?{ok:false,error:'read_failed'}:good(p);await click(r,'Export filtered CSV');assert.equal(downloads.length,0);assert.match(text(r.toJSON()),/read_failed/);f.feedback=good;await click(r,'Export filtered CSV');assert.equal(downloads.length,1);await act(async()=>r.unmount());});
test('A16-008/012 actual Analytics chart and CSV use only existing summary; unknown rating stays blank, zero stays zero',async()=>{reset();const r=await mount(Analytics);assert(r.root.findAll(n=>n.props.role==='img'&&n.props['aria-label']==='Conversation status chart').length===1);await click(r,'Export summary CSV');const csv=await downloads[0].blob.text();assert.match(csv,/"total_sessions","0"/);assert.match(csv,/"average_rating",""/);assert.match(csv,/"status:open","2"/);assert.deepEqual(f.calls.map(x=>x.name),['visitor-analytics']);await act(async()=>r.unmount());});
test('A09/A16 forbidden role does not load data or expose exports',async()=>{reset();f.role='visitor';for(const C of [Feedback,Analytics]){const r=await mount(C);assert.equal(r.root.findAllByType('button').length,0);await act(async()=>r.unmount());}assert.equal(f.calls.length,0);assert.equal(downloads.length,0);});
