import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';

// Executes the complete handler with a filtering persistence adapter. No Hosted
// claim: Auth, DB and transport are isolated; every write/upstream call traps.
const read=p=>fs.readFileSync(p,'utf8');
let source=process.env.C3_WIDGET_HANDLER_SOURCE_REF
  ? execFileSync('git',['show',process.env.C3_WIDGET_HANDLER_SOURCE_REF+':supabase/functions/widget-live-ai-test/index.ts'],{encoding:'utf8'})
  : read('supabase/functions/widget-live-ai-test/index.ts');
source=source.replace(/^import .*;\n/gm,'').replace('Deno.serve(createWidgetLiveHandler());','');
const dependencies=['execution-failure','uat-execution-contract','uat-execution-readiness','handoff-intent','conversational-routing']
  .map(n=>read(`supabase/functions/_shared/${n}.ts`).replace(/^import .*;\n/gm,'')).join('\n');
const code='const createClient=()=>{throw Error("SDK not injected")};const getSupabaseAdminKey=()=>"server-key";const supabaseCorsHeaders=()=>({});\n'+dependencies+'\n'+source;
const {createWidgetLiveHandler}=await import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64'));
const actor='30000000-0000-4000-8000-000000000001';
const ticket='55555555-5555-4555-8555-555555555555',session='66666666-6666-4666-8666-666666666666';
const scopes=[['Frankie','3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','b0000000-0000-0000-0000-000000000001'],['Authe','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec','0405282f-77dc-47cf-8074-99dd3dc6c393']];
const foreign='77777777-7777-4777-8777-777777777777';
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw Error('Provider/network dispatch forbidden in archive tests');};
test.after(()=>{globalThis.fetch=originalFetch;});

function fixture(scope,edit=()=>{},messageSnapshot=c=>c,fault={}) {
  const [,company,channel]=scope;
  const metadata={source:'widget_live_test',widget_live_test:true,exclude_training:true,owner_user_id:actor,scope_mode:'canonical',canonical_company_attached:true};
  const tables={company:[{id:company,is_active:true}],company_membership:[{user_id:actor,company_id:company,role:'admin',is_active:true}],channel_config:[{id:channel,company_id:company,is_active:true,channel_type:'web_widget',allowed_origins:['https://console-chat-hub.lovable.app']}],
    conversations:[{id:ticket,company_id:company,channel_config_id:null,visitor_session_id:session,metadata_source:metadata,status:'pending',assigned_agent_id:foreign,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T01:00:00Z'}],
    visitor_session:[{id:session,channel_config_id:null,visitor_fingerprint:`widget-live-test:${actor}`,visitor_metadata:{source:'widget_live_test',test_mode:true,owner_user_id:actor,exclude_training:true,scope_mode:'canonical'},session_token:'MUST_NOT_LEAVE_SERVER'}],
    messages:[{id:'v',conversation_id:ticket,role:'visitor',content:'original question',created_at:'2026-10-01T00:00:00Z',is_recalled:false},{id:'a',conversation_id:ticket,role:'assistant',content:'original answer',created_at:'2026-10-01T00:01:00Z',is_recalled:false},{id:'g',conversation_id:ticket,role:'agent',content:'human answer',created_at:'2026-10-01T00:02:00Z',is_recalled:false},{id:'r',conversation_id:ticket,role:'assistant',content:'recalled secret',created_at:'2026-10-01T00:03:00Z',is_recalled:true},{id:'x',conversation_id:foreign,role:'assistant',content:'FOREIGN SECRET',is_recalled:false},{id:'t',conversation_id:ticket,role:'assistant',content:'__THINKING__',is_recalled:false}]};
  edit(tables); const before=JSON.stringify(tables);const queries=[];
  const value=(row,key)=>key.includes('->>')?row[key.split('->>')[0]]?.[key.split('->>')[1]]:row[key];
  const db={rpc:async()=>({data:null,error:{code:'PGRST202'}}),from(table){
    let filters=[],single=false,orders=[],limit=Infinity,fields="";
    const q={select(selected){fields=selected;queries.push({table,fields});return this;},eq(k,v){filters.push(r=>value(r,k)===v);return this;},is(k,v){filters.push(r=>value(r,k)===v);return this;},neq(k,v){filters.push(r=>value(r,k)!==v);return this;},order(k,o){orders.push([k,o]);return this;},limit(n){limit=n;return this;},maybeSingle(){single=true;return this;},then(resolve){if(fault.session && table==='visitor_session'){resolve({data:null,error:{code:'PGRST000'}});return;}let rows=tables[table].filter(r=>filters.every(f=>f(r)));rows.sort((a,b)=>{for(const [k,o] of orders){const cmp=String(a[k]??'').localeCompare(String(b[k]??''));if(cmp)return o.ascending?cmp:-cmp;}return 0;});rows=rows.slice(0,limit);if(table==='messages' && fields.includes('archive:'))rows=rows.map(m=>{const c=tables.conversations.find(c=>c.id===m.conversation_id);return {...m,archive:c?messageSnapshot({...c,archive_session:tables.visitor_session.find(s=>s.id===c.visitor_session_id)}):null};});resolve({data:single?(rows[0]??null):rows,error:null});}};
    for(const name of ['insert','update','delete','upsert'])q[name]=()=>{throw Error('Archive attempted write: '+name);};
    return q;
  }};
  const env={SUPABASE_URL:'https://nrfxhqabwblzxoushgnm.supabase.co',SUPABASE_ANON_KEY:'public-key'};
  globalThis.Deno={env:{get:k=>env[k]}};
  const handler=createWidgetLiveHandler({env:k=>env[k],getAdminKey:()=> 'server-key',log(){},createClient(_url,key){return key==='public-key'?{auth:{getUser:async()=>({data:{user:{id:actor}},error:null})},rpc:async()=>({data:{isolated:true,config:{company_id:company,channel_id:channel}},error:null})}:db;}});
  return {tables,queries,async call(body){const response=await handler(new Request('https://test.invalid',{method:'POST',headers:{Origin:'https://console-chat-hub.lovable.app',Authorization:'Bearer isolated-auth'},body:JSON.stringify(body)}));const text=await response.text();assert(!text.includes('MUST_NOT_LEAVE_SERVER'));assert(!text.includes('FOREIGN SECRET'));assert(!text.includes('recalled secret'));assert.equal(JSON.stringify(tables),before,'read changed persistence');return {status:response.status,data:JSON.parse(text)};}};
}

for(const scope of scopes){
  test(scope[0]+' own archive history/readback, no lease, no writes or duplicate delivery',async()=>{
    const f=fixture(scope,t=>t.messages.push({...t.messages[2]}));
    const history=await f.call({action:'history'});assert.equal(history.status,200);assert.equal(history.data.execution_ready,false);assert.equal(history.data.history.length,1);assert.equal(history.data.history[0].read_only,true);assert.equal(history.data.history[0].message_count,3);
    for(let i=0;i<2;i++){const r=await f.call({action:'load',test_conversation_id:ticket});assert.equal(r.status,200);assert.equal(r.data.read_only,true);assert.equal(r.data.execution_class,'historical_widget_live_test');assert.equal(r.data.human_control,true);assert.deepEqual(r.data.messages.map(m=>m.id),['v','a','g']);}
    assert(f.queries.filter(q=>q.table==='visitor_session').every(q=>!q.fields.includes('session_token')));
  });
  const attacks={
    'cross Tenant':t=>t.conversations[0].company_id=foreign,
    'foreign actor':t=>t.conversations[0].metadata_source.owner_user_id=foreign,
    'foreign Channel':t=>t.conversations[0].channel_config_id=foreign,
    'missing session':t=>t.visitor_session=[],
    'wrong session id':t=>t.visitor_session[0].id=foreign,
    'session Channel':t=>t.visitor_session[0].channel_config_id=scope[2],
    'session owner':t=>t.visitor_session[0].visitor_metadata.owner_user_id=foreign,
    'session fingerprint':t=>t.visitor_session[0].visitor_fingerprint='widget-live-test:'+foreign,
    'session marker':t=>t.visitor_session[0].visitor_metadata.source='ordinary_customer',
    'session training flag':t=>t.visitor_session[0].visitor_metadata.exclude_training=false,
    'synthetic metadata spoof':t=>t.conversations[0].metadata_source.synthetic=true,
    'missing original marker':t=>delete t.conversations[0].metadata_source.widget_live_test,
    'preactivation scope':t=>t.conversations[0].metadata_source.scope_mode='pre_activation',
    'unattached company':t=>t.conversations[0].metadata_source.canonical_company_attached=false,
  };
  for(const [name,edit] of Object.entries(attacks))test(scope[0]+' archive denies '+name,async()=>{
    const f=fixture(scope,edit);const h=await f.call({action:'history'});assert.equal(h.status,200);assert.equal(h.data.history.length,0);
    const r=await f.call({action:'load',test_conversation_id:ticket});assert.equal(r.status,404);assert.equal(r.data.messages,undefined);
    assert(!f.queries.some(q=>q.table==='messages'),'denied archive must not even read messages');
  });
  test(scope[0]+' archive cannot be reopened as paid, control or human message',async()=>{
    const f=fixture(scope);
    for(const query of ['Check product price','Who are you?','Please connect me to a human']){
      const r=await f.call({action:'send',test_conversation_id:ticket,client_message_id:foreign,query});assert([404,503].includes(r.status));assert.equal(r.data.delivery_receipt,undefined);
    }
    const r=await f.call({action:'reconcile',client_message_id:foreign});assert.equal(r.status,404);
  });
}

for(const scope of scopes){
 for(const change of ['company','owner','session'])test(scope[0]+' rejects '+change+' change in message-query snapshot',async()=>{
  const f=fixture(scope,()=>{},c=>change==='company'?{...c,company_id:foreign}:change==='owner'?{...c,metadata_source:{...c.metadata_source,owner_user_id:foreign}}:{...c,archive_session:{...c.archive_session,visitor_fingerprint:'foreign'}});
  const r=await f.call({action:'load',test_conversation_id:ticket});assert.equal(r.status,500);assert.equal(r.data.messages,undefined);assert(!JSON.stringify(r.data).includes('original answer'));
 });
}

for(const scope of scopes)test(scope[0]+' history retains all 38 eligible original previews',async()=>{
 const f=fixture(scope,t=>{const c=t.conversations[0];t.conversations=Array.from({length:38},(_,i)=>({...c,id:'88888888-8888-4888-8888-'+String(i).padStart(12,'0')}));});
 const h=await f.call({action:'history'});assert.equal(h.status,200);assert.equal(h.data.history.length,38);assert.equal(new Set(h.data.history.map(c=>c.conversation_id)).size,38);assert(h.data.history.every(c=>c.read_only===true));
});

for(const scope of scopes)test(scope[0]+' session lookup failure is an error, never an empty successful archive',async()=>{
 const f=fixture(scope,()=>{},c=>c,{session:true});
 for(const body of [{action:'history'},{action:'load',test_conversation_id:ticket}]){const r=await f.call(body);assert.equal(r.status,500);assert.equal(r.data.history,undefined);assert.equal(r.data.messages,undefined);}
});

for(const scope of scopes)test(scope[0]+' original pre-activation archive is readable only after persisted own-company binding',async()=>{
 const f=fixture(scope,t=>{t.conversations[0].metadata_source.scope_mode='pre_activation';t.conversations[0].metadata_source.canonical_company_attached=false;t.visitor_session[0].visitor_metadata.scope_mode='pre_activation';});
 const h=await f.call({action:'history'});assert.equal(h.data.history.length,1);assert.equal(h.data.history[0].read_only,true);
 const r=await f.call({action:'load',test_conversation_id:ticket});assert.equal(r.status,200);assert.equal(r.data.read_only,true);assert.equal(r.data.messages.length,3);
 const denied=await f.call({action:'send',test_conversation_id:ticket,client_message_id:foreign,query:'Who are you?'});assert.equal(denied.status,404);
});
