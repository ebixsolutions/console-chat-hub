import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

// Real endpoint handler and Web Streams; only Supabase transport is isolated.
// No Production, provider, visitor send or SQL mutation is performed.
const f=globalThis.__task1cEventRuntime={};
const savedDeno=globalThis.Deno;
globalThis.Deno={env:{get:k=>({SUPABASE_URL:'https://nrfxhqabwblzxoushgnm.supabase.co',SUPABASE_SECRET_KEY:'isolated-only'})[k]},serve:handler=>f.handler=handler};
const bundle=await build({entryPoints:['supabase/functions/widget-poll-messages/index.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{
 name:'isolated-sdk',setup(b){
  b.onResolve({filter:/^https:\/\/esm.sh\/@supabase/},a=>({path:a.path,namespace:'sdk'}));
  b.onLoad({filter:/.*/,namespace:'sdk'},()=>({contents:'export const createClient=()=>globalThis.__task1cEventRuntime.db;'}));
 }
}]});
await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const handler=f.handler;
const realInterval=globalThis.setInterval,realClear=globalThis.clearInterval;
const company='30000000-0000-4000-8000-000000000001',channel='40000000-0000-4000-8000-000000000001',conversation='10000000-0000-4000-8000-000000000001',session='20000000-0000-4000-8000-000000000001';
const token='isolated-visitor-session-more-than-32-characters';
const origin='https://console-chat-hub.lovable.app';
const drain=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
function setup(){
 f.reads=[];f.removed=[];f.subscriptions=[];f.timers=new Set();f.block=null;f.failRead=false;
 f.session={id:session,channel_config:{id:channel,company_id:company,is_active:true,channel_type:'web_widget',allowed_origins:[origin]}};
 f.conversation={id:conversation,company_id:company,channel_config_id:channel,visitor_session_id:session,status:'open',assigned_agent_id:null,metadata_source:{}};
 globalThis.setInterval=fn=>{f.timers.add(fn);return fn;};globalThis.clearInterval=fn=>f.timers.delete(fn);
 f.db={
  from(table){const filters=[];let one=false;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},neq(){return q},order(){return q},limit(){return q},maybeSingle(){one=true;return q},then(resolve,reject){return Promise.resolve().then(async()=>{
   f.reads.push({table,filters});if(f.block)await f.block;if(f.failRead)throw Error('isolated database unavailable');
   if(table==='visitor_session')return {data:f.session,error:null};
   if(table==='conversations')return {data:f.conversation,error:null};
   if(table==='messages')return {data:one?null:[],error:null};
   throw Error('Unexpected table '+table);
  }).then(resolve,reject)}};return q},
  channel(name){const stream={name,callbacks:[],on(type,filter,cb){this.callbacks.push({type,filter,cb});return this},subscribe(cb){this.status=cb;queueMicrotask(()=>cb('SUBSCRIBED'));return this}};f.subscriptions.push(stream);return stream},
  async removeChannel(stream){f.removed.push(stream);return 'ok'},
 };
}
async function open(extra={},requestOrigin=origin){const abort=new AbortController();const response=await handler(new Request('https://function.invalid',{method:'POST',headers:{Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify({conversation_id:conversation,session_token:token,subscribe_events:true,...extra}),signal:abort.signal}));return {response,abort,reader:response.body?.getReader()};}
async function read(reader){const result=await reader.read();return result.done?null:new TextDecoder().decode(result.value);}
const emit=()=>f.subscriptions[0].callbacks[0].cb({eventType:'INSERT',new:{conversation_id:conversation,content:'NEVER FORWARD THIS CONTENT'}});
test.after(()=>{globalThis.setInterval=realInterval;globalThis.clearInterval=realClear;globalThis.Deno=savedDeno;delete globalThis.__task1cEventRuntime;});

test('actual stream: idle heartbeat performs zero database reads; new event verifies exact tenant and emits no content',async()=>{
 setup();const x=await open();assert.equal(x.response.status,200);assert.match(x.response.headers.get('content-type'),/text\/event-stream/);assert.equal(await read(x.reader),'data: ready\n\n');
 assert.equal(f.reads.length,2);assert.equal(f.subscriptions.length,1);
 assert.deepEqual(f.subscriptions[0].callbacks.map(x=>x.filter.filter),['conversation_id=eq.'+conversation,'id=eq.'+conversation]);
 for(const tick of f.timers)tick();assert.equal(await read(x.reader),': keep-alive\n\n');assert.equal(f.reads.length,2,'no idle DB polling');
 emit();await drain();assert.equal(await read(x.reader),'data: invalidate\n\n');assert.deepEqual(f.reads.slice(2).map(x=>x.table),['visitor_session','conversations']);
 assert(!JSON.stringify(f.subscriptions[0]).includes(token),'visitor token not in subscription topic');
 x.abort.abort();await drain();assert.equal(f.removed.length,1);assert.equal(f.timers.size,0);assert.equal(await read(x.reader),null);
 const count=f.reads.length;emit();await drain();assert.equal(f.reads.length,count,'closed callback cannot query');
});
test('actual stream denies wrong session/channel/tenant and Origin before opening any subscription',async()=>{
 for(const mismatch of ['session','channel','tenant','origin','malformed']){
  setup();if(mismatch==='session')f.conversation.visitor_session_id=crypto.randomUUID();if(mismatch==='channel')f.conversation.channel_config_id=crypto.randomUUID();if(mismatch==='tenant')f.conversation.company_id=crypto.randomUUID();
  const x=await open(mismatch==='malformed'?{subscribe_events:'true'}:{},mismatch==='origin'?'https://foreign.invalid':origin);
  assert.equal(x.response.status,mismatch==='origin'?403:mismatch==='malformed'?400:404,mismatch);assert.equal(f.subscriptions.length,0);await x.reader.cancel();
 }
});
test('actual stream revocation and transport errors fail closed without emitting a change',async()=>{
 for(const revoke of ['visitor','tenant','inactive','origin','throws']){
  setup();const x=await open();await read(x.reader);
  if(revoke==='visitor')f.session=null;
  if(revoke==='tenant')f.conversation={...f.conversation,company_id:crypto.randomUUID()};
  if(revoke==='inactive')f.session={...f.session,channel_config:{...f.session.channel_config,is_active:false}};
  if(revoke==='origin')f.session={...f.session,channel_config:{...f.session.channel_config,allowed_origins:[]}};
  if(revoke==='throws')f.failRead=true;
  emit();await drain();assert.equal(await read(x.reader),null,revoke);assert.equal(f.removed.length,1);assert.equal(f.timers.size,0);
 }
});
test('actual stream coalesces a concurrent event burst and cancels without late readback',async()=>{
 setup();const x=await open();await read(x.reader);let release;f.block=new Promise(r=>release=r);
 for(let i=0;i<20;i++)emit();await drain();assert.equal(f.reads.length,3,'at most one concurrent authorization query');
 x.abort.abort();release();f.block=null;await drain();assert.equal(await read(x.reader),null);assert.equal(f.reads.length,3);assert.equal(f.removed.length,1);
});
test('actual stream cancellation before subscribe and failed subscription release all resources',async()=>{
 setup();const x=await open();await read(x.reader);f.subscriptions[0].status('CHANNEL_ERROR');await drain();assert.equal(await read(x.reader),null);assert.equal(f.removed.length,1);assert.equal(f.timers.size,0);
});
