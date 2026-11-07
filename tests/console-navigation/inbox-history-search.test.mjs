import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {build} from 'esbuild';
const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));const React=require('react');const {create,act}=require('react-test-renderer');globalThis.IS_REACT_ACT_ENVIRONMENT=true;const f=globalThis.__inboxSearch={};
const result=await build({entryPoints:['src/routes/_authenticated/console.conversations.index.tsx'],bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'transport',setup(b){
 b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^(lucide-react|sonner|@tanstack\/react-router|@\/hooks\/|@\/components\/|@\/integrations\/|@\/lib\/api\/feedback.service)/},a=>a.path.endsWith("/useTicketReply")?({path:path.resolve("src/hooks/useTicketReply.ts")}):({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{const s='const f=globalThis.__inboxSearch;';
 if(a.path==='@tanstack/react-router')return {contents:'export const createFileRoute=()=>x=>x;'};
 if(a.path==='lucide-react')return {contents:'export const Loader2=()=>null;'};
 if(a.path==='sonner')return {contents:'export const toast={error(){},info(){},success(){}};'};
 if(a.path.includes('useAuth'))return {contents:'export const useAuth=()=>({user:{id:globalThis.__inboxSearch.actor??"owner"}});'};
 if(a.path.includes('useCurrentRole'))return {contents:'export const useCurrentRole=()=>({role:globalThis.__inboxSearch.role??"admin",loading:false});'};
 if(a.path.includes('useEffectiveRole'))return {contents:'export const useConsoleLang=()=>"en";'};
 if(a.path.includes('/integrations/'))return {contents:s+'export const supabase={from:table=>f.from(table),functions:{invoke(...args){f.calls.push(args);throw Error("unexpected dispatch")}},channel:name=>({name,on(type,filter,cb){(f.realtime[name]??=[]).push({type,filter,cb});return this;},subscribe(status){this.status=status;f.channels.push(this);return this;}}),removeChannel(channel){channel.removed=true;}};'};
 if(a.path.includes('reply-request'))return {contents:'export class ReplyRequest{}'};
 if(a.path.includes('CRMPanel'))return {contents:'export const CRMPanel=p=>{globalThis.__inboxSearch.crmProps=p;return null;},RIGHT_COPY={inserted:{en:"Inserted"}},buildBoundedContext=()=>"",computeContextRevisionKey=(id,msgs)=>id+":"+msgs.filter(m=>m.role==="visitor"&&!m.is_recalled).map(m=>[m.id,m.content,m.status].join("|")).join(",");'};
 if(a.path.includes('ComposerTools'))return {contents:'export const AttachmentButtons=()=>null,EmojiPickerButton=()=>null,insertAtCaret=()=>({value:"",caret:0});'};
 if(a.path.includes('MessageAttachment'))return {contents:'export const MessageAttachment=()=>null,isAttachmentMessage=()=>false;'};
 if(a.path.includes('feedback.service'))return {contents:'export const feedbackService={};'};
 const name=a.path.split('/').at(-1);if(name==='AgentToolPanel')return {contents:s+'export const AgentToolPanel=(p)=>{f.toolProps=p;return null;};'};if(a.path.includes('/ui/'))return {contents:'export const Button="button",Textarea="textarea",Badge="span",Select="select",SelectContent="div",SelectItem="option",SelectTrigger="div",SelectValue="span",Dialog=({open,children})=>open?children:null,DialogContent="div",DialogHeader="div",DialogTitle="h2",DialogDescription="p";'};
 if(name==='PageStates')return {contents:'export const LoadingState=()=>null,PermissionDenied=()=>null;'};
 return {contents:`export const ${name}=()=>null;`};
 });}}]});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-inbox-search-'));const file=path.join(dir,'ui.mjs');fs.writeFileSync(file,result.outputFiles[0].text);const {Route}=await import(pathToFileURL(file));fs.rmSync(dir,{recursive:true});
const txt=x=>typeof x==='string'?x:Array.isArray(x)?x.map(txt).join(''):x?.children?.map(txt).join('')??'';
let timers=[];let intervals=[];
function reset(){timers=[];intervals=[];f.realtime={};f.channels=[];f.calls=[];f.actor="owner";f.role="admin";f.activityRead=null;f.messageRead=null;f.historyReads=[];f.reads=[];const storage=new Map();globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};f.fail=false;f.previewFail=false;f.tables={conversations:[{id:'target',company_id:'company-a',status:'open',assigned_agent_id:null,channel_config:{name:'Target channel'},visitor_session:{id:'visitor1',visitor_metadata:{name:'Target visitor'}}},{id:'other',company_id:'company-a',status:'open',assigned_agent_id:null,channel_config:{name:'Other'},visitor_session:{id:'visitor2'}}],agent_profile:[],messages:[{id:'z1',conversation_id:'target',content:'Technical recovery',created_at:'2026-10-16',is_recalled:false},{id:'a1',conversation_id:'target',content:'有冇洗衣機訂閱服務資訊？請唔好憑空推套餐。',created_at:'2026-10-15',is_recalled:false},{id:'z2',conversation_id:'other',content:'Other message',created_at:'2026-10-16',is_recalled:false}]};
 f.tables.conversation_status_log=[];f.tables.conversation_assignment=[];f.tables.handoff_event=[];
 f.from=table=>{let rows=[...f.tables[table]],needle=null,search=false;const q={select(){return q;},eq(k,v){rows=rows.filter(r=>r[k]===v);return q;},in(k,ids){rows=rows.filter(r=>ids.includes(r[k]));return q;},neq(k,v){rows=rows.filter(r=>r[k]!==v);return q;},or(){rows=rows.filter(r=>!r.is_recalled);return q;},ilike(k,v){search=true;needle=v.slice(1,-1).replace(/\\([\\%_])/g,'$1');rows=rows.filter(r=>String(r[k]).toLowerCase().includes(needle.toLowerCase()));return q;},order(k,{ascending}={}){rows.sort((a,b)=>String(a[k]).localeCompare(String(b[k]))*(ascending?1:-1));return q;},range(a,b){f.reads.push({table,search,needle});return Promise.resolve((search&&f.fail||(!search&&table==='messages'&&f.previewFail))?{data:null,error:{message:'read_failed'},count:null}:{data:rows.slice(a,b+1),error:null,count:rows.length});},maybeSingle:async()=>({data:rows[0]??null,error:null}),then(resolve,reject){if(table==="messages")f.historyReads.push(rows.map(r=>r.id));return (table==="messages"&&f.messageRead?f.messageRead(rows):f.activityRead&&["conversation_status_log","conversation_assignment","handoff_event"].includes(table)?f.activityRead(table,rows):Promise.resolve({data:rows,error:null,count:rows.length})).then(resolve,reject);}};return q;};
 globalThis.window={setTimeout:fn=>(timers.push(fn),fn),clearTimeout:fn=>{timers=timers.filter(x=>x!==fn);},setInterval:fn=>(intervals.push(fn),fn),clearInterval:fn=>{intervals=intervals.filter(x=>x!==fn);}};globalThis.document={addEventListener(){},removeEventListener(){}};
}
async function mount(){let r;await act(async()=>r=create(React.createElement(Route.component)));return r;}
async function search(r,value){await act(async()=>r.root.findByProps({placeholder:'🔍 Search conversations...'}).props.onChange({target:{value}}));await act(async()=>{for(const fn of timers.splice(0))fn();});}
test('A02-011 actual Inbox UI finds an older visitor message despite latest recovery preview',async()=>{reset();const r=await mount();await search(r,'洗衣機訂閱服務資訊');assert.match(txt(r.toJSON()),/Target visitor/);assert(!txt(r.toJSON()).includes('No conversations found'));assert(f.reads.some(x=>x.table==='messages'&&x.search&&x.needle==='洗衣機訂閱服務資訊'));await act(async()=>r.unmount());});
test('A02-011 failed history lookup is an error, not a false empty result; clear restores inbox',async()=>{reset();const r=await mount();f.fail=true;await search(r,'洗衣機');assert.match(txt(r.toJSON()),/Message search unavailable/);assert(!txt(r.toJSON()).includes('No conversations found'));f.fail=false;await act(async()=>r.root.findAllByType('button').find(b=>txt({children:b.children})==='Retry message search').props.onClick());await act(async()=>{for(const fn of timers.splice(0))fn();});assert.match(txt(r.toJSON()),/Target visitor/);await act(async()=>r.unmount());});

const activityButton=(r,label)=>r.root.findAllByType('button').find(b=>txt({children:b.children}).trim()===label);
async function pickTicket(r,label){const row=r.root.findAll(n=>n.props.onClick&&txt({children:n.children}).includes(label)).at(-1);assert(row);await act(async()=>row.props.onClick());}
test('assigned Inbox ticket does not become Unassigned when its agent name is unavailable',async()=>{
 reset();f.tables.conversations[0].assigned_agent_id='restricted-profile';f.tables.conversations[0].status='pending';const r=await mount();await pickTicket(r,'Target visitor');assert.match(txt(r.toJSON()),/Assigned agent \(name unavailable\)/);assert(!txt(r.toJSON()).includes('👤 Unassigned'));await act(async()=>r.unmount());
});
async function openActivity(r){await act(async()=>activityButton(r,'Activity').props.onClick());}
test('A02-035-C04 activity read failure is not a false empty history and Retry reloads all three sources',async()=>{
 reset();f.tables.agent_profile=[{id:'admin-profile',user_id:'owner',display_name:'Admin',role:'admin',status:'active'}];const r=await mount();await pickTicket(r,'Target visitor');f.activityRead=async()=>({data:null,error:{message:'activity_read_failed'}});await openActivity(r);
 assert.match(txt(r.toJSON()),/Conversation activity unavailable/);assert(!txt(r.toJSON()).includes('No status, assignment, or handoff activity recorded'));
 let reads=0;f.activityRead=async(table)=>{reads++;return {data:table==='conversation_status_log'?[{created_at:'2026-10-17',old_status:'open',new_status:'pending',reason:'CURRENT TICKET ACTIVITY'}]:[],error:null}};
 await act(async()=>activityButton(r,'Retry activity').props.onClick());assert.equal(reads,3);assert.match(txt(r.toJSON()),/CURRENT TICKET ACTIVITY/);await act(async()=>r.unmount());
});
test('A02-035 activity from an earlier ticket cannot replace the current ticket history',async()=>{
 reset();f.tables.agent_profile=[{id:'admin-profile',user_id:'owner',display_name:'Admin',role:'admin',status:'active'}];const r=await mount();await pickTicket(r,'Target visitor');const waits=[];f.activityRead=()=>new Promise(resolve=>waits.push(resolve));await openActivity(r);assert.equal(waits.length,3);
 await pickTicket(r,'Other Visitor');f.activityRead=async(table)=>({data:table==='conversation_status_log'?[{created_at:'2026-10-17',old_status:'open',new_status:'pending',reason:'CURRENT OTHER TICKET'}]:[],error:null});await openActivity(r);assert.match(txt(r.toJSON()),/CURRENT OTHER TICKET/);
 await act(async()=>waits.forEach((resolve,i)=>resolve({data:i===0?[{created_at:'2026-10-16',old_status:'open',new_status:'pending',reason:'STALE TARGET ACTIVITY'}]:[],error:null})));
 assert(!txt(r.toJSON()).includes('STALE TARGET ACTIVITY'));assert.match(txt(r.toJSON()),/CURRENT OTHER TICKET/);await act(async()=>r.unmount());
});

test('Task1 C1: a failed optional preview read leaves RLS-scoped tickets visible with a truthful error', async () => {
 reset();
 f.previewFail = true;
 const r = await mount();
 const rendered = txt(r.toJSON());
 assert.match(rendered, /Target visitor/, 'base Inbox ticket must remain visible');
 assert.match(rendered, /Ticket previews unavailable/, 'preview failure must be visible');
 assert.doesNotMatch(rendered, /No conversations found/, 'preview failure is not an empty Inbox');
 await act(async()=>r.unmount());
});

test('Task1 C4 Inbox keeps Agent Tools bound to current visitor revision, role and ticket',async()=>{
 reset();f.toolProps=null;
 f.tables.messages=[
  {id:'visitor-target-v1',conversation_id:'target',role:'visitor',content:'兩部冷氣安裝資料',created_at:'2026-10-25T10:00:00Z',status:'delivered',is_recalled:false},
  {id:'visitor-other-v1',conversation_id:'other',role:'visitor',content:'配送和退貨政策',created_at:'2026-10-25T10:01:00Z',status:'delivered',is_recalled:false}
 ];
 const r=await mount();
 await pickTicket(r,'Target visitor');
 assert.equal(f.toolProps?.conversationId,'target');
 assert.deepEqual(JSON.parse(f.toolProps?.toolScopeKey),['owner','admin','company-a',null]);
 assert.match(f.toolProps?.contextRevisionKey??'',/visitor-target-v1/);
 const oldKey=f.toolProps.contextRevisionKey;
 await pickTicket(r,'Other Visitor');
 assert.equal(f.toolProps?.conversationId,'other');
 assert.match(f.toolProps?.contextRevisionKey??'',/visitor-other-v1/);
 assert.notEqual(f.toolProps.contextRevisionKey,oldKey);
 const otherKey=f.toolProps.contextRevisionKey;
 f.tables.messages.push({id:'visitor-other-v2',conversation_id:'other',role:'visitor',content:'更正，我問退款政策',created_at:'2026-10-25T10:02:00Z',status:'delivered',is_recalled:false});
 await pickTicket(r,'Target visitor');
 await pickTicket(r,'Other Visitor');
 assert.match(f.toolProps?.contextRevisionKey??'',/visitor-other-v2/);
 assert.notEqual(f.toolProps.contextRevisionKey,otherKey,'new customer correction must invalidate C4 drafts and citations');
 f.role='agent';
 await pickTicket(r,'Target visitor');
 assert.deepEqual(JSON.parse(f.toolProps?.toolScopeKey),['owner','agent','company-a',null],'role changes must invalidate privileged tool results');
 await act(async()=>r.unmount());
});

test('Task1 C4 message push updates selected Inbox and invalidates pending draft without polling',async()=>{
 reset();f.toolProps=null;
 f.tables.messages=[{id:'visitor-v1',conversation_id:'target',role:'visitor',content:'我有20個分頁',created_at:'2026-10-27T01:01:00Z',status:'delivered',is_recalled:false}];
 const r=await mount();await pickTicket(r,'Target visitor');
 assert.match(f.toolProps.contextRevisionKey,/visitor-v1/);
 assert.equal(intervals.length,0,'no selected-ticket polling timer may be registered');
 await act(async()=>f.toolProps.onUseDraft('Current human draft'));
 assert.equal(f.toolProps.draftText,'Current human draft');
 await act(async()=>f.toolProps.onUseDraft('Old Helper suggestion'));
 assert.match(txt(r.toJSON()),/Replace Draft\?/);
 const beforeListReads=f.reads.filter(x=>x.table==='conversations').length;
 // No Realtime notification: only the durable server row changes.
 f.tables.messages.push({id:'visitor-v2',conversation_id:'target',role:'visitor',content:'更正只係8個分頁',created_at:'2026-10-27T01:03:00Z',status:'delivered',is_recalled:false});
 await act(async()=>{f.realtime['console-messages-target'][0].cb({eventType:'INSERT',new:{conversation_id:'target',role:'visitor',content:'更正只係8個分頁'}});await Promise.resolve();await Promise.resolve();});
 assert.equal(f.toolProps.conversationId,'target','must not switch tickets');
 assert.match(f.toolProps.contextRevisionKey,/visitor-v2/,'new Visitor revision must reach the still-open Inbox');
 assert.match(txt(r.toJSON()),/更正只係8個分頁/);
 assert.doesNotMatch(txt(r.toJSON()),/Replace Draft\?/,'obsolete confirmation must be cleared');
 assert.equal(f.toolProps.draftText,'Current human draft','stale tool may not replace the human draft');
 assert.equal(f.reads.filter(x=>x.table==='conversations').length,beforeListReads,'must not poll entire Inbox');
 await act(async()=>r.unmount());assert.equal(intervals.length,0,'timer must clean up');
});

test('Task1: Realtime INSERT/UPDATE updates Inbox without rescan of message previews',async()=>{
 reset();const r=await mount();const reads=f.reads.filter(x=>x.table==='messages').length;
 assert.equal(f.realtime['console-all-messages']?.length,1);
 assert.equal(f.realtime['console-conversations']?.length,1);
 await act(async()=>f.realtime['console-all-messages'][0].cb({eventType:'INSERT',
   new:{conversation_id:'target',role:'visitor',content:'PUSHED CUSTOMER UPDATE',
     created_at:'2026-10-28T12:00:00Z',is_recalled:false}}));
 assert.match(txt(r.toJSON()),/PUSHED CUSTOMER UPDATE/);
 assert.equal(f.reads.filter(x=>x.table==='messages').length,reads,'no full-list message rescan');
 await act(async()=>f.realtime['console-conversations'][0].cb({eventType:'UPDATE',
   new:{id:'target',status:'pending',updated_at:'2026-10-28T12:00:01Z'}}));
 assert.equal(f.reads.filter(x=>x.table==='messages').length,reads,'no rescan after status update');
 await act(async()=>f.realtime['console-all-messages'][0].cb({eventType:'INSERT',
   new:{conversation_id:'foreign',content:'CROSS TENANT PRIVATE'}}));
 assert.doesNotMatch(txt(r.toJSON()),/CROSS TENANT PRIVATE/);
 assert.equal(f.reads.filter(x=>x.table==='messages').length,reads);
 await act(async()=>r.unmount());
});

test('Task1 Inbox has zero periodic message/whole-list polling and reconnects only on events',async()=>{
 reset();const r=await mount();await pickTicket(r,'Target visitor');
 assert.equal(intervals.length,0,'forbid every-X-seconds fetch even for selected ticket');
 assert.equal(typeof f.realtime['console-messages-target']?.[0]?.cb,'function');
 const prior=f.reads.filter(x=>x.table==='messages').length;
 await act(async()=>{f.realtime['console-all-messages'][0].cb({eventType:'INSERT',
   new:{conversation_id:'target',content:'NEW PUSH MESSAGE',created_at:'2026-10-28T12:01:00Z'}})});
 assert.equal(f.reads.filter(x=>x.table==='messages').length,prior,'Inbox preview uses push payload with no RLS-wide refetch');
 assert.equal(intervals.length,0);
 await act(async()=>r.unmount());
});


const currentChannel=name=>f.channels.filter(c=>c.name===name&&!c.removed).at(-1);
const inboxDraft=r=>r.root.findByType('textarea');
async function messageBubble(r,content){const bubble=r.root.findAll(n=>n.type==='div'&&n.props.onClick&&txt({children:n.children})===content).at(-1);assert(bubble,content);await act(async()=>bubble.props.onClick());}

test('Task3 initial SUBSCRIBED catches the Inbox snapshot gap and coalesces sibling acknowledgements',async t=>{
 reset();f.tables.messages=[{id:'before',conversation_id:'target',role:'visitor',content:'Before subscription',is_recalled:false,created_at:'2026-10-30T01:00:00Z'}];
 const r=await mount();t.after(async()=>{await act(async()=>r.unmount())});await pickTicket(r,'Target visitor');
 const listReads=f.reads.filter(x=>x.table==='conversations').length,historyReads=f.historyReads.length;
 f.tables.conversations[0]={...f.tables.conversations[0],status:'pending',assigned_agent_id:'late-agent'};
 f.tables.messages.push({id:'after',conversation_id:'target',role:'visitor',content:'Saved before subscription became ready',is_recalled:false,created_at:'2026-10-30T01:00:01Z'});
 await act(async()=>{currentChannel('console-conversations').status('SUBSCRIBED');currentChannel('console-all-messages').status('SUBSCRIBED');currentChannel('console-messages-target').status('SUBSCRIBED');});
 assert.equal(f.toolProps.convStatus,'pending');assert.match(txt(r.toJSON()),/Saved before subscription became ready/);
 assert.equal(f.reads.filter(x=>x.table==='conversations').length,listReads+1,'same-turn global acknowledgements share a snapshot');
 assert.equal(f.historyReads.length,historyReads+1,'same-turn acknowledgements share the selected history read');
 assert.equal(intervals.length,0);assert.deepEqual(f.calls,[]);
 f.tables.messages.push({id:'resume',conversation_id:'target',role:'visitor',content:'Saved during reconnect',is_recalled:false,created_at:'2026-10-30T01:00:02Z'});
 await act(async()=>currentChannel('console-messages-target').status('SUBSCRIBED'));
 assert.match(txt(r.toJSON()),/Saved during reconnect/,'every subsequent acknowledgement reconciles without needing a preceding error event');
 assert.equal(f.historyReads.length,historyReads+2);
});

test('Task3 removed Inbox subscription cannot read or apply a previous ticket after navigation',async t=>{
 reset();const r=await mount();t.after(async()=>{await act(async()=>r.unmount())});await pickTicket(r,'Target visitor');
 const old=currentChannel('console-messages-target');await pickTicket(r,'Other Visitor');const before=f.historyReads.length;
 await act(async()=>old.status('SUBSCRIBED'));
 assert.equal(f.historyReads.length,before);assert.equal(f.toolProps.conversationId,'other');assert.deepEqual(f.calls,[]);
});

for(const change of ['actor','role','company','assignment','status','selected message','current draft','customer revision'])test('Task3 pending Replace rejects changed '+change+' and its retained callbacks',async t=>{
 reset();f.tables.messages=[{id:'visitor',conversation_id:'target',role:'visitor',content:'Current customer question',is_recalled:false,created_at:'2026-10-30T01:00:00Z'},
   {id:'assistant',conversation_id:'target',role:'assistant',content:'Existing answer',is_recalled:false,created_at:'2026-10-30T01:00:01Z'}];
 const r=await mount();t.after(async()=>{await act(async()=>r.unmount())});await pickTicket(r,'Target visitor');await messageBubble(r,'Current customer question');
 await act(async()=>f.toolProps.onUseDraft('Human draft'));
 const oldApply=f.toolProps.onUseDraft;
 await act(async()=>oldApply('Obsolete suggestion'));
 const oldConfirm=activityButton(r,'Replace')?.props.onClick;assert(oldConfirm,'pending confirmation exists');
 if(change==='actor'||change==='role'){
   if(change==='actor')f.actor='new-owner';else f.role='supervisor';
   await act(async()=>r.update(React.createElement(Route.component)));
 }else if(['company','assignment','status'].includes(change)){
   const delta=change==='company'?{company_id:'company-b'}:change==='assignment'?{assigned_agent_id:'new-agent'}:{status:'resolved'};
   f.tables.conversations[0]={...f.tables.conversations[0],...delta};
   await act(async()=>f.realtime['console-conversations'].at(-1).cb({eventType:'UPDATE',new:{id:'target',...delta}}));
 }else if(change==='selected message')await messageBubble(r,'Existing answer');
 else if(change==='current draft')await act(async()=>inboxDraft(r).props.onChange({target:{value:'Newer human draft'}}));
 else{
   f.tables.messages[0]={...f.tables.messages[0],content:'Corrected customer question'};
   await act(async()=>f.realtime['console-messages-target'].at(-1).cb({eventType:'UPDATE',new:f.tables.messages[0]}));
 }
 assert.doesNotMatch(txt(r.toJSON()),/Replace Draft\?/,'context change closes pending confirmation');
 const retainedDraft=inboxDraft(r).props.value;
 await act(async()=>{oldConfirm();oldApply('Another obsolete suggestion')});
 assert.equal(inboxDraft(r).props.value,retainedDraft);assert.doesNotMatch(txt(r.toJSON()),/Replace Draft\?/);
 assert.deepEqual(f.calls,[]);
 if(change==='actor'){
   f.actor='owner';await act(async()=>r.update(React.createElement(Route.component)));
   assert.equal(inboxDraft(r).props.value,'Human draft','old callback must not overwrite the prior actor draft either');
 }
});

test('Task3 unchanged pending Replace applies once and remains draft-only',async t=>{
 reset();const r=await mount();t.after(async()=>{await act(async()=>r.unmount())});await pickTicket(r,'Target visitor');
 await act(async()=>f.crmProps.onInsertDraft('Human draft'));
 await act(async()=>f.crmProps.onInsertDraft('Current verified excerpt'));
 const confirm=activityButton(r,'Replace').props.onClick;await act(async()=>confirm());
 assert.equal(inboxDraft(r).props.value,'Current verified excerpt');assert.doesNotMatch(txt(r.toJSON()),/Replace Draft\?/);
 await act(async()=>confirm());assert.equal(inboxDraft(r).props.value,'Current verified excerpt');assert.deepEqual(f.calls,[]);
});
