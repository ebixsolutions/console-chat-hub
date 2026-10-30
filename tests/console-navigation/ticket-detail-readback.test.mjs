import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {build} from 'esbuild';
const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));const React=require('react');const {create,act}=require('react-test-renderer');globalThis.IS_REACT_ACT_ENVIRONMENT=true;const f=globalThis.__detailRead={};
const result=await build({entryPoints:['src/routes/_authenticated/console.conversations.$id.tsx'],bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'transport',setup(b){
 b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^(lucide-react|sonner|@tanstack\/react-router|@\/hooks\/|@\/components\/|@\/integrations\/|@\/lib\/api\/feedback.service)/},a=>a.path.endsWith("/useTicketReply")?({path:path.resolve("src/hooks/useTicketReply.ts")}):({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{const s='const f=globalThis.__detailRead;';
 if(a.path==='@tanstack/react-router')return {contents:'export const createFileRoute=()=>x=>({...x,useParams:()=>({id:globalThis.__detailRead.id})});export const Link="a";'};
 if(a.path==='lucide-react')return {contents:'export const Loader2=()=>null,ArrowLeft=()=>null;'};
 if(a.path==='sonner')return {contents:'export const toast={error(){},info(){},success(){}};'};
 if(a.path.includes('useAuth'))return {contents:'export const useAuth=()=>({user:{id:"owner"}});'};
 if(a.path.includes('useCurrentRole'))return {contents:'export const useCurrentRole=()=>({role:"admin",loading:false});'};
 if(a.path.includes('useEffectiveRole'))return {contents:'export const useConsoleLang=()=>"en";'};
 if(a.path.includes('/integrations/'))return {contents:s+'export const supabase={from:table=>f.from(table),functions:{invoke(){throw Error("unexpected dispatch")}},channel:name=>({name,on(type,filter,change){this.change=change;return this;},subscribe(status){this.status=status;f.channels.push(this);return this;}}),removeChannel(channel){channel.removed=true;}};'};
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
function reset(){timers=[];f.id="target";f.channels=[];f.historyReads=[];f.messageRead=null;f.reads=[];f.fail=false;f.tables={conversations:[{id:'target',status:'open',assigned_agent_id:null,channel_config:{name:'Target channel'},visitor_session:{id:'visitor1',visitor_metadata:{name:'Target visitor'}}},{id:'other',status:'open',assigned_agent_id:null,channel_config:{name:'Other'},visitor_session:{id:'visitor2'}}],agent_profile:[],messages:[{id:'z1',conversation_id:'target',content:'Technical recovery',created_at:'2026-10-16',is_recalled:false},{id:'a1',conversation_id:'target',content:'有冇洗衣機訂閱服務資訊？請唔好憑空推套餐。',created_at:'2026-10-15',is_recalled:false},{id:'z2',conversation_id:'other',content:'Other message',created_at:'2026-10-16',is_recalled:false}]};
 f.from=table=>{let rows=[...f.tables[table]],needle=null,search=false;const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},in(k,ids){rows=rows.filter(r=>ids.includes(r[k]));return q;},neq(k,v){rows=rows.filter(r=>r[k]!==v);return q;},or(){rows=rows.filter(r=>!r.is_recalled);return q;},ilike(k,v){search=true;needle=v.slice(1,-1).replace(/\\([\\%_])/g,'$1');rows=rows.filter(r=>String(r[k]).toLowerCase().includes(needle.toLowerCase()));return q;},order(k,{ascending}={}){rows.sort((a,b)=>String(a[k]).localeCompare(String(b[k]))*(ascending?1:-1));return q;},range(a,b){f.reads.push({table,search,needle});return Promise.resolve(search&&f.fail?{data:null,error:{message:'read_failed'},count:null}:{data:rows.slice(a,b+1),error:null,count:rows.length});},single:async()=>{f.reads.push({table});return {data:rows[0]??null,error:null}},maybeSingle:async()=>({data:rows[0]??null,error:null}),then(resolve,reject){if(table==="messages")f.historyReads.push(rows.map(r=>r.id));return (table==="messages"&&f.messageRead?f.messageRead(rows):Promise.resolve({data:rows,error:null,count:rows.length})).then(resolve,reject);}};return q;};
 globalThis.window={setTimeout:fn=>(timers.push(fn),fn),clearTimeout:fn=>{timers=timers.filter(x=>x!==fn);}};globalThis.document={addEventListener(){},removeEventListener(){}};
}
async function mount(){let r;await act(async()=>r=create(React.createElement(Route.component)));return r;}
async function search(r,value){await act(async()=>r.root.findByProps({placeholder:'🔍 Search conversations...'}).props.onChange({target:{value}}));await act(async()=>{for(const fn of timers.splice(0))fn();});}


test('original detail route ignores a previous ticket history completion after navigation',async()=>{
 reset();const pending=[];f.messageRead=rows=>new Promise(resolve=>pending.push({rows,resolve}));f.tables.messages=[{id:'target-source',conversation_id:'target',role:'visitor',content:'OLD TICKET MESSAGE',is_recalled:false},{id:'other-source',conversation_id:'other',role:'visitor',content:'CURRENT TICKET MESSAGE',is_recalled:false}];const r=await mount();f.id='other';await act(async()=>r.update(React.createElement(Route.component)));assert.equal(pending.length,2);await act(async()=>pending[1].resolve({data:pending[1].rows,error:null}));await act(async()=>pending[0].resolve({data:pending[0].rows,error:null}));assert.match(txt(r.toJSON()),/CURRENT TICKET MESSAGE/);assert(!txt(r.toJSON()).includes('OLD TICKET MESSAGE'));await act(async()=>r.unmount());
});
test('original detail history failure is not no messages and normal read retry is available',async()=>{
 reset();f.messageRead=async()=>({data:null,error:{message:'read unavailable'}});const r=await mount();assert.match(txt(r.toJSON()),/Messages unavailable/);assert(!txt(r.toJSON()).includes('No messages yet.'));f.messageRead=null;await act(async()=>r.root.findAllByType('button').find(b=>txt({children:b.children})==='Retry messages').props.onClick());assert.match(txt(r.toJSON()),/Technical recovery/);await act(async()=>r.unmount());
});

test('assigned ticket remains assigned when RBAC hides its agent profile',async()=>{
 reset();f.tables.conversations[0].assigned_agent_id='restricted-profile';f.tables.conversations[0].status='pending';const r=await mount();assert.match(txt(r.toJSON()),/Assigned agent \(name unavailable\)/);assert(!txt(r.toJSON()).includes('Unassigned'));await act(async()=>r.unmount());
});
test('assigned ticket displays an authorized profile name and only null assignment is Unassigned',async()=>{
 reset();f.tables.conversations[0].assigned_agent_id='visible-profile';f.tables.agent_profile=[{id:'visible-profile',display_name:'Visible agent',role:'agent',status:'active'}];const assigned=await mount();assert.match(txt(assigned.toJSON()),/Visible agent/);assert(!txt(assigned.toJSON()).includes('Unassigned'));await act(async()=>assigned.unmount());reset();const unassigned=await mount();assert.match(txt(unassigned.toJSON()),/Unassigned/);assert(!txt(unassigned.toJSON()).includes('Assigned agent (name unavailable)'));await act(async()=>unassigned.unmount());
});


test('Task3 detail initial SUBSCRIBED reconciles missed control and history once per acknowledgement burst',async t=>{
 reset();const r=await mount();t.after(async()=>{await act(async()=>r.unmount())});
 const reads=f.reads.filter(x=>x.table==='conversations').length,histories=f.historyReads.length;
 f.tables.conversations[0]={...f.tables.conversations[0],status:'pending',assigned_agent_id:'gap-agent'};
 f.tables.messages.push({id:'gap',conversation_id:'target',role:'visitor',content:'Saved in initial detail subscription gap',is_recalled:false,created_at:'2026-10-30'});
 await act(async()=>{for(const channel of f.channels.filter(c=>!c.removed))channel.status('SUBSCRIBED')});
 assert.match(txt(r.toJSON()),/Saved in initial detail subscription gap/);assert.match(txt(r.toJSON()),/Assigned agent \(name unavailable\)/);
 assert.equal(f.reads.filter(x=>x.table==='conversations').length,reads+1);assert.equal(f.historyReads.length,histories+1);
 f.tables.messages.push({id:'reconnect',conversation_id:'target',role:'visitor',content:'Saved before next detail acknowledgement',is_recalled:false,created_at:'2026-10-31'});
 await act(async()=>f.channels.find(c=>c.name==='detail-msgs-target').status('SUBSCRIBED'));
 assert.match(txt(r.toJSON()),/Saved before next detail acknowledgement/);assert.equal(f.historyReads.length,histories+2);
});

test('Task3 detail removed subscription and delayed catch-up cannot replace the new ticket',async t=>{
 reset();const r=await mount();t.after(async()=>{await act(async()=>r.unmount())});
 const oldChannels=[...f.channels];let release;
 f.messageRead=rows=>new Promise(resolve=>release=()=>resolve({data:rows,error:null}));
 await act(async()=>oldChannels[0].status('SUBSCRIBED'));assert.equal(typeof release,'function');
 f.messageRead=null;f.id='other';await act(async()=>r.update(React.createElement(Route.component)));
 const before=f.historyReads.length;
 await act(async()=>{for(const channel of oldChannels)channel.status('SUBSCRIBED');release()});
 assert.equal(f.historyReads.length,before,'removed channel callbacks must not issue reads');assert.match(txt(r.toJSON()),/Other message/);assert.doesNotMatch(txt(r.toJSON()),/Technical recovery/);
});
