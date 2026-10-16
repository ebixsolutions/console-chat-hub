import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {build} from 'esbuild';
const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));const React=require('react');const {create,act}=require('react-test-renderer');globalThis.IS_REACT_ACT_ENVIRONMENT=true;const f=globalThis.__inboxSearch={};
const result=await build({entryPoints:['src/routes/_authenticated/console.conversations.index.tsx'],bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'transport',setup(b){
 b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^(lucide-react|sonner|@tanstack\/react-router|@\/hooks\/|@\/components\/|@\/integrations\/|@\/lib\/api\/feedback.service)/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{const s='const f=globalThis.__inboxSearch;';
 if(a.path==='@tanstack/react-router')return {contents:'export const createFileRoute=()=>x=>x;'};
 if(a.path==='lucide-react')return {contents:'export const Loader2=()=>null;'};
 if(a.path==='sonner')return {contents:'export const toast={error(){},info(){},success(){}};'};
 if(a.path.includes('useAuth'))return {contents:'export const useAuth=()=>({user:{id:"owner"}});'};
 if(a.path.includes('useCurrentRole'))return {contents:'export const useCurrentRole=()=>({role:"admin",loading:false});'};
 if(a.path.includes('useEffectiveRole'))return {contents:'export const useConsoleLang=()=>"en";'};
 if(a.path.includes('/integrations/'))return {contents:s+'export const supabase={from:table=>f.from(table),functions:{invoke(){throw Error("unexpected dispatch")}},channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel(){}};'};
 if(a.path.includes('reply-request'))return {contents:'export class ReplyRequest{}'};
 if(a.path.includes('CRMPanel'))return {contents:'export const CRMPanel=()=>null,RIGHT_COPY={},buildBoundedContext=()=>"",computeContextRevisionKey=()=>"";'};
 if(a.path.includes('ComposerTools'))return {contents:'export const AttachmentButtons=()=>null,EmojiPickerButton=()=>null,insertAtCaret=()=>({value:"",caret:0});'};
 if(a.path.includes('MessageAttachment'))return {contents:'export const MessageAttachment=()=>null,isAttachmentMessage=()=>false;'};
 if(a.path.includes('feedback.service'))return {contents:'export const feedbackService={};'};
 const name=a.path.split('/').at(-1);if(a.path.includes('/ui/'))return {contents:'export const Button="button",Textarea="textarea",Badge="span",Select="select",SelectContent="div",SelectItem="option",SelectTrigger="div",SelectValue="span",Dialog=()=>null,DialogContent="div",DialogHeader="div",DialogTitle="h2",DialogDescription="p";'};
 if(name==='PageStates')return {contents:'export const LoadingState=()=>null,PermissionDenied=()=>null;'};
 return {contents:`export const ${name}=()=>null;`};
 });}}]});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-inbox-search-'));const file=path.join(dir,'ui.mjs');fs.writeFileSync(file,result.outputFiles[0].text);const {Route}=await import(pathToFileURL(file));fs.rmSync(dir,{recursive:true});
const txt=x=>typeof x==='string'?x:Array.isArray(x)?x.map(txt).join(''):x?.children?.map(txt).join('')??'';
let timers=[];
function reset(){timers=[];f.reads=[];f.fail=false;f.tables={conversations:[{id:'target',status:'open',assigned_agent_id:null,channel_config:{name:'Target channel'},visitor_session:{id:'visitor1',visitor_metadata:{name:'Target visitor'}}},{id:'other',status:'open',assigned_agent_id:null,channel_config:{name:'Other'},visitor_session:{id:'visitor2'}}],agent_profile:[],messages:[{id:'z1',conversation_id:'target',content:'Technical recovery',created_at:'2026-10-16',is_recalled:false},{id:'a1',conversation_id:'target',content:'有冇洗衣機訂閱服務資訊？請唔好憑空推套餐。',created_at:'2026-10-15',is_recalled:false},{id:'z2',conversation_id:'other',content:'Other message',created_at:'2026-10-16',is_recalled:false}]};
 f.from=table=>{let rows=[...f.tables[table]],needle=null,search=false;const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},in(k,ids){rows=rows.filter(r=>ids.includes(r[k]));return q;},neq(k,v){rows=rows.filter(r=>r[k]!==v);return q;},or(){rows=rows.filter(r=>!r.is_recalled);return q;},ilike(k,v){search=true;needle=v.slice(1,-1).replace(/\\([\\%_])/g,'$1');rows=rows.filter(r=>String(r[k]).toLowerCase().includes(needle.toLowerCase()));return q;},order(k,{ascending}={}){rows.sort((a,b)=>String(a[k]).localeCompare(String(b[k]))*(ascending?1:-1));return q;},range(a,b){f.reads.push({table,search,needle});return Promise.resolve(search&&f.fail?{data:null,error:{message:'read_failed'},count:null}:{data:rows.slice(a,b+1),error:null,count:rows.length});},maybeSingle:async()=>({data:rows[0]??null,error:null}),then(resolve){return Promise.resolve({data:rows,error:null,count:rows.length}).then(resolve);}};return q;};
 globalThis.window={setTimeout:fn=>(timers.push(fn),fn),clearTimeout:fn=>{timers=timers.filter(x=>x!==fn);}};globalThis.document={addEventListener(){},removeEventListener(){}};
}
async function mount(){let r;await act(async()=>r=create(React.createElement(Route.component)));return r;}
async function search(r,value){await act(async()=>r.root.findByProps({placeholder:'🔍 Search conversations...'}).props.onChange({target:{value}}));await act(async()=>{for(const fn of timers.splice(0))fn();});}
test('A02-011 actual Inbox UI finds an older visitor message despite latest recovery preview',async()=>{reset();const r=await mount();await search(r,'洗衣機訂閱服務資訊');assert.match(txt(r.toJSON()),/Target visitor/);assert(!txt(r.toJSON()).includes('No conversations found'));assert(f.reads.some(x=>x.table==='messages'&&x.search&&x.needle==='洗衣機訂閱服務資訊'));await act(async()=>r.unmount());});
test('A02-011 failed history lookup is an error, not a false empty result; clear restores inbox',async()=>{reset();const r=await mount();f.fail=true;await search(r,'洗衣機');assert.match(txt(r.toJSON()),/Message search unavailable/);assert(!txt(r.toJSON()).includes('No conversations found'));f.fail=false;await act(async()=>r.root.findAllByType('button').find(b=>txt({children:b.children})==='Retry message search').props.onClick());await act(async()=>{for(const fn of timers.splice(0))fn();});assert.match(txt(r.toJSON()),/Target visitor/);await act(async()=>r.unmount());});
