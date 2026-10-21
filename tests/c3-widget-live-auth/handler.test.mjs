import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const root=new URL('../../',import.meta.url);
let code=fs.readFileSync(new URL('supabase/functions/widget-live-ai-test/index.ts',root),'utf8').replace(/^import .*;\n/gm,'').replace('Deno.serve(createWidgetLiveHandler());','');
const helper=fs.readFileSync(new URL('supabase/functions/_shared/supabase-admin-key.ts',root),'utf8').replace('export function','function');
const dependencyCode=['supabase/functions/_shared/original-widget-preview.ts','supabase/functions/_shared/execution-failure.ts','supabase/functions/_shared/uat-execution-contract.ts','supabase/functions/_shared/uat-execution-readiness.ts','supabase/functions/_shared/handoff-intent.ts','supabase/functions/_shared/conversational-routing.ts'].map(file=>fs.readFileSync(new URL(file,root),'utf8').replace(/^import .*;\n/gm,'')).join('\n');
code=dependencyCode+'\n'+code;
code='const createClient=()=>{throw new Error("unexpected SDK client")}; const supabaseCorsHeaders=()=>({});\n'+helper+'\n'+code+'\nexport {getSupabaseAdminKey as testAdminKey, trustedDispatchScope, FRANKIE_DEMO_COMPANY, FRANKIE_DEMO_REVISION, UatDenied};';
const js=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {createWidgetLiveHandler,testAdminKey,trustedDispatchScope,FRANKIE_DEMO_COMPANY,FRANKIE_DEMO_REVISION,UatDenied}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const company='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',channel='20000000-0000-4000-8000-000000000001';
const user='30000000-0000-4000-8000-000000000001', token='authenticated-test-token',secret='server-secret-never-output';
let completed=[];
async function check(name, options={}, expected=200, body={action:'history'}) {
 const logs=[], calls=[]; let clients=0; const requests=[]; const originalFetch=globalThis.fetch;
 const ownCompany=options.ownCompany===true;
 const scopeCompany=ownCompany?'3d6e17b5-ec79-4f75-aa7f-eaa824ff8493':company;
 const scopeChannel=ownCompany?'b0000000-0000-0000-0000-000000000001':channel;
 const conversation={id:company,company_id:scopeCompany,channel_config_id:scopeChannel,status:options.closed?'closed':options.human?'pending':'open',visitor_session_id:channel,metadata_source:{source:'c3_uat_widget',synthetic:true,owner_user_id:user,exclude_training:true}};
 globalThis.fetch=async(url,init)=>{requests.push({url,body:JSON.parse(init.body)}); const data=String(url).endsWith('receive-widget-message')?{message_id:channel,ai_reply_pending:false,idempotent:true}:{messages:[{id:channel,role:'agent',content:'synthetic response'}],conversation_status:options.human?'pending':'open',human_support:{state:options.human?'waiting':'none',queue_position:2,estimated_wait_minutes:4}}; return new Response(JSON.stringify({success:true,data}));};
 const row={company_id:scopeCompany,role:options.role??'admin',is_active:options.active??true};
 const memberships=options.ambiguous?[row,{...row,company_id:channel}]:[row];
 const client={rpc:async()=>options.missingRpc?({error:{code:'PGRST202'},data:null}):({error:null,data:{ready:true,remote_ready:false,allowed_conversations:options.allowed??[company],actor_id:options.leaseActor??user,channel_id:scopeChannel,run_id:ownCompany?env.FRANKIE_DEMO_UAT_RUN_ID:env.C3_TEMP_UAT_RUN_ID,revision:ownCompany?FRANKIE_DEMO_REVISION:env.C3_TEMP_UAT_SOURCE_REVISION}}),from(table){const chain={singleRow:false,select(){return this},eq(k,v){calls.push([table,k,v]);return this},is(k,v){calls.push([table,k,v]);return this},order(){return this},limit(){return this},maybeSingle(){this.singleRow=true;return this},then(resolve){
 let data=table==='company_membership'?memberships:table==='company'?{id:scopeCompany,is_active:options.companyActive??true}:table==='channel_config'?{id:scopeChannel,company_id:scopeCompany,is_active:true,channel_type:'web_widget',allowed_origins:['https://preview--console-chat-hub.lovable.app']}:table==='conversations'?(this.singleRow?{...conversation,metadata_source:options.foreignOwner?{...conversation.metadata_source,owner_user_id:channel}:conversation.metadata_source}:[]):table==='visitor_session'?{id:channel,channel_config_id:scopeChannel,visitor_fingerprint:'widget-live-test:'+user,visitor_metadata:{source:'c3_uat_widget',owner_user_id:options.foreignSession?channel:user,test_mode:true,exclude_training:true,scope_mode:'canonical'},session_token:'synthetic-session-token-with-32-characters'}:[];
 resolve({data,status:options.providerError?401:200,error:table==='company_membership'&&options.providerError?{code:'PGRST301',message:secret}:null});
 }};return chain;}};
 const env={C3_TEMP_UAT_RUN_ID:company,C3_TEMP_UAT_SOURCE_REVISION:'c3-3322877-bounded-uat-r2',SUPABASE_SECRET_KEY:secret,SUPABASE_URL:'https://nrfxhqabwblzxoushgnm.supabase.co',SUPABASE_ANON_KEY:'public-key',...(options.env??{})};
 globalThis.Deno={env:{get:k=>env[k]}};
 const handler=createWidgetLiveHandler({env:k=>env[k],getAdminKey:options.missingKey?()=>{throw Error(secret)}:testAdminKey, log:event=>logs.push(event),createClient:(url,key,config)=>{
 clients++; assert.equal(url,env.SUPABASE_URL); assert.equal(config.auth.persistSession,false);
 if(clients===1) return {auth:{getUser:async jwt=>{assert.equal(jwt,options.token??token);return {data:{user:options.invalid?null:{id:user}},error:options.invalid?{code:'bad_jwt',message:secret}:null}}},rpc:async()=>{if(ownCompany)throw Error('Frankie must never borrow C3 scope RPC');return {data:{isolated:options.isolated??true,config:{company_id:company,channel_id:channel}},error:null};}};
 assert.equal(key,secret);assert.equal(config.global,undefined);return client;
 }});
 const headers={Origin:'https://preview--console-chat-hub.lovable.app'};
 if(!options.noToken)headers.Authorization='Bearer '+(options.token??token);
 const response=await handler(new Request('https://endpoint.invalid',{method:'POST',headers,body:JSON.stringify(body)}));
 const responseText=await response.text(); assert.equal(response.status,expected,responseText);
 assert(!responseText.includes(secret));assert(!JSON.stringify(logs).includes(secret));assert(!JSON.stringify(logs).includes(token));
 if(expected===200&&options.isolated!==false && body.action==='history') {const h=JSON.parse(responseText);assert.equal(h.runtime_contract,'c3-widget-control-v2');assert.equal(h.actor_id,user);assert.equal(typeof h.execution_ready,'boolean');assert.equal(typeof h.remote_ready,'boolean');if(options.expectFrankieReady)assert.equal(h.execution_ready,true);assert(calls.some(c=>c[0]==='conversations'&&c[1]==='company_id'&&c[2]===scopeCompany));assert(calls.some(c=>c[0]==='conversations'&&c[1]==='channel_config_id'&&c[2]===scopeChannel));}
 if(body.action==='open_authorized'){assert(!requests.some(r=>r.url.endsWith('receive-widget-message')));if(expected===200){assert(calls.some(c=>c[0]==='conversations'&&c[1]==='company_id'&&c[2]===scopeCompany));assert(calls.some(c=>c[0]==='conversations'&&c[1]==='channel_config_id'&&c[2]===scopeChannel));assert.equal(requests.length,1);assert(requests[0].url.endsWith('widget-poll-messages'));assert.equal(JSON.parse(responseText).conversation_id,company);}else assert.equal(requests.length,0);}
 if(options.providerError)assert.equal(logs[0].provider_http_class,'4xx');
 if(body.action==='send'&&expected>=400)assert.equal(requests.length,0);
 if(body.action==='send'&&expected===200){assert(requests.some(r=>r.url.endsWith('receive-widget-message'))); assert(!requests.some(r=>r.url.endsWith('generate-reply'))); assert.equal(requests[0].body.client_message_id,body.client_message_id);assert.equal(requests[0].body.conversation_id,company);}
 if((body.action==='load'||body.action==='reconcile')&&expected===200){assert(requests.some(r=>r.url.endsWith('widget-poll-messages')));const payload=JSON.parse(responseText);assert.equal(payload.messages[0].role,'agent');assert.equal(payload.human_support.queue_position,2);}
 globalThis.fetch=originalFetch;
 completed.push({name,status:'PASS',kind:'actual_handler_unit_with_provider_adapters'});
}
await check('local identity remains reachable without model lease',{env:{C3_TEMP_UAT_RUN_ID:undefined}},200,{action:'send',test_conversation_id:company,client_message_id:channel,query:'你是誰'});
for (const query of ['what your name','有人吗？','Who are you?','你是誰？']) await check('local identity/presence without model lease: '+query,{env:{C3_TEMP_UAT_RUN_ID:undefined}},200,{action:'send',test_conversation_id:company,client_message_id:channel,query});
for (const query of ['Who are you? Check my refund','有人吗？請查能源資料','i want to buy fridge','I want software seats']) await check('business remains admission guarded: '+query,{env:{C3_TEMP_UAT_RUN_ID:undefined}},503,{action:'send',test_conversation_id:company,client_message_id:channel,query});
await check('local identity still requires owned conversation',{foreignOwner:true,env:{C3_TEMP_UAT_RUN_ID:undefined}},404,{action:'send',test_conversation_id:company,client_message_id:channel,query:'你是誰'});
await check('local identity still requires authenticated actor',{invalid:true},401,{action:'send',test_conversation_id:company,client_message_id:channel,query:'你是誰'});
await check('actual synthetic missing run denies before messages',{env:{C3_TEMP_UAT_RUN_ID:undefined}},503,{action:'send',test_conversation_id:company,client_message_id:channel,query:'Check the energy label'});
await check('actual synthetic missing status RPC denies before messages',{missingRpc:true},503,{action:'send',test_conversation_id:company,client_message_id:channel,query:'Check the energy label'});
await check('actual synthetic human control works without lease',{human:true,env:{C3_TEMP_UAT_RUN_ID:undefined}},200,{action:'send',test_conversation_id:company,client_message_id:channel,query:'Follow up with my agent'});
await check('actual synthetic explicit human request works without lease',{env:{C3_TEMP_UAT_RUN_ID:undefined}},200,{action:'send',test_conversation_id:company,client_message_id:channel,query:'Please connect me to a human now'});
await check('history remains readable when execution is not configured',{missingRpc:true});
await check('valid Admin');await check('valid Supervisor',{role:'supervisor'});
await check('Frankie own-company history bound to his real channel without C3 RPC',{ownCompany:true},200,{action:'history'});
await check('Frankie own-company lease readiness uses a distinct server run, not C3',
  {ownCompany:true,expectFrankieReady:true,env:{
    FRANKIE_DEMO_UAT_RUN_ID:'20000000-0000-4000-8000-000000000002',
    FRANKIE_DEMO_UAT_SOURCE_REVISION:'c3-frankie-tenant-bounded-demo-v1'
  }},200,{action:'history'});
await check('Frankie business question denied before creating messages or paid dispatch',{ownCompany:true},503,{action:'send',test_conversation_id:company,client_message_id:channel,query:'Can you check my product warranty from KB?'});
await check('Frankie non-C3 membership cannot access the synthetic C3 tenant',{ownCompany:true,foreignOwner:true},404,{action:'load',test_conversation_id:company});
await check('no token',{noToken:true},401);await check('invalid JWT',{invalid:true,token:'invalid-token'},401);await check('expired JWT',{invalid:true,token:'expired-token'},401);
await check('inactive membership',{active:false},403);await check('unsupported role',{role:'agent'},403);
await check('inactive company',{companyActive:false},403);await check('ambiguous company',{ambiguous:true},409);
await check('tenant injection',{},400,{action:'history',company_id:channel});await check('user injection',{},400,{action:'history',user_id:user});
await check('admin key missing',{missingKey:true},500);
await check('modern key');await check('service fallback',{env:{SUPABASE_SECRET_KEY:undefined,SUPABASE_SERVICE_ROLE_KEY:secret}});await check('plural compatibility',{env:{SUPABASE_SECRET_KEY:undefined,SUPABASE_SECRET_KEYS:JSON.stringify({default:secret})}});
await check('wrong hosted project rejected',{env:{SUPABASE_URL:'https://unapproved.supabase.co'}},500);
await check('loopback requires server native marker',{env:{SUPABASE_URL:'http://127.0.0.1:54321'}},500);
await check('browser native marker cannot change backend',{env:{SUPABASE_URL:'http://127.0.0.1:54321'}},500,{action:'history',C3_NATIVE_ISOLATED_AUTH:'local-only'});
await check('explicit disposable native backend',{env:{SUPABASE_URL:'http://127.0.0.1:54321',C3_NATIVE_ISOLATED_AUTH:'local-only'}});
await check('native marker cannot authorize other hosted project',{env:{SUPABASE_URL:'https://unapproved.supabase.co',C3_NATIVE_ISOLATED_AUTH:'local-only'}},500);
await check('provider error safe diagnostics',{providerError:true},500);
await check('no registered scope cannot send',{isolated:false},503,{action:'send',query:'test',client_message_id:company});
await Promise.all([check('concurrent history A'),check('concurrent history B')]);
await check('load isolated conversation',{},200,{action:'load',test_conversation_id:company});
await check('read-only pending request reconciliation',{},200,{action:'reconcile',client_message_id:channel});
await check('foreign owner reconciliation denied',{foreignOwner:true},404,{action:'reconcile',client_message_id:channel});
await check('bad pending request id rejected',{},400,{action:'reconcile',client_message_id:'invalid'});
await check('foreign owner load denied',{foreignOwner:true},404,{action:'load',test_conversation_id:company});
await check('foreign lease actor denied before paid send',{leaseActor:channel},503,{action:'send',test_conversation_id:company,client_message_id:channel,query:'business request'});
await check('canonical send',{},200,{action:'send',test_conversation_id:company,client_message_id:channel,query:'synthetic generic request'});
await check('human control send remains ordinary widget',{human:true},200,{action:'send',test_conversation_id:company,client_message_id:channel,query:'synthetic reply'});
await check('missing stable message id rejected before writes',{},400,{action:'send',query:'synthetic'});

// Bounded free-form entry: selection is read-only; no create or paid dispatch.
for(const ownCompany of [false,true]){
 const env=ownCompany?{FRANKIE_DEMO_UAT_RUN_ID:company,FRANKIE_DEMO_UAT_SOURCE_REVISION:FRANKIE_DEMO_REVISION}:{};
 await check('authorized Preview opens own leased ticket '+ownCompany,{ownCompany,env},200,{action:'open_authorized'});
 await check('authorized Preview denies foreign owner '+ownCompany,{ownCompany,env,foreignOwner:true},409,{action:'open_authorized'});
 await check('authorized Preview denies foreign Session '+ownCompany,{ownCompany,env,foreignSession:true},403,{action:'open_authorized'});
 await check('authorized Preview skips closed '+ownCompany,{ownCompany,env,closed:true},409,{action:'open_authorized'});
 await check('authorized Preview skips human control '+ownCompany,{ownCompany,env,human:true},409,{action:'open_authorized'});
 await check('authorized Preview cannot invent allowlist '+ownCompany,{ownCompany,env,allowed:[]},409,{action:'open_authorized'});
 await check('authorized free-form keeps canonical receive path '+ownCompany,{ownCompany,env},200,{action:'send',test_conversation_id:company,client_message_id:channel,query:'Please help me compare options for my business.'});
}
await check('authorized Preview foreign lease actor denies',{leaseActor:channel},503,{action:'open_authorized'});
await check('authorized Preview absent lease denies without reads upstream',{env:{C3_TEMP_UAT_RUN_ID:undefined}},503,{action:'open_authorized'});
await check('authorized Preview never accepts client grant',{env:{C3_TEMP_UAT_RUN_ID:undefined}},400,{action:'open_authorized',company_id:company});

// Real shared model-dispatch admission boundary, exercised without any upstream traffic.
{
 const originalDeno=globalThis.Deno;
 const companyId=FRANKIE_DEMO_COMPANY, conversationId='55555555-5555-4555-8555-555555555555';
 let synthetic=false;let sourceOverride=null;const env={};
 globalThis.Deno={env:{get:k=>env[k]}};
 const db={from:table=>({
   select(){return this},eq(){return this},
   async maybeSingle(){
     return {error:null,data:table==='company'?{id:companyId}:{
       id:conversationId,company_id:companyId,
       metadata_source:sourceOverride??(synthetic?{
         source:'c3_uat_widget',synthetic:true,exclude_training:true,
         owner_user_id:user
       }:{source:'ordinary_customer',exclude_training:false})
     }};
   }
 })};
 try{
   assert.equal(await trustedDispatchScope(db,companyId,conversationId),'legacy',
      'existing Frankie Production traffic must not require synthetic UAT admission');
   synthetic=true;let code='';
   try{await trustedDispatchScope(db,companyId,conversationId)}catch(e){code=e instanceof UatDenied?e.code:'other'}
   assert.equal(code,'UAT_AUTHORIZATION_ABSENT','synthetic paid dispatch denies without own run');
   for (const source of [
     {source:'widget_live_test',widget_live_test:true,exclude_training:true,owner_user_id:user},
     {source:'unexpected',synthetic:true,exclude_training:true,owner_user_id:user},
     {source:'c3_uat_widget',exclude_training:true,owner_user_id:user}
   ]) {
     sourceOverride=source;let denied='';
     try{await trustedDispatchScope(db,companyId,conversationId)}catch(e){denied=e instanceof UatDenied?e.code:'other'}
     assert.equal(denied,'UAT_AUTHORIZATION_DENIED','historical or damaged synthetic scope must never fall through to ordinary paid execution');
     completed.push({name:'historical/damaged synthetic cannot inherit ordinary Production: '+source.source,status:'PASS',kind:'real_source_with_injected_db'});
   }
   sourceOverride=null;
   env.FRANKIE_DEMO_UAT_RUN_ID='20000000-0000-4000-8000-000000000002';
   env.FRANKIE_DEMO_UAT_SOURCE_REVISION=FRANKIE_DEMO_REVISION;
   assert.equal(await trustedDispatchScope(db,companyId,conversationId),'uat','licensed synthetic path uses bounded dispatch');
   env.FRANKIE_DEMO_UAT_SOURCE_REVISION='wrong-revision';
   code='';try{await trustedDispatchScope(db,companyId,conversationId)}catch(e){code=e instanceof UatDenied?e.code:'other'}
   assert.equal(code,'UAT_SOURCE_OR_RUN_DENIED','wrong source revision cannot authorize dispatch');
   completed.push({name:'Frankie synthetic/ordinary model scope isolation',status:'PASS',kind:'real_source_with_injected_db'});
 }finally{globalThis.Deno=originalDeno}
}
if(process.env.C3_WIDGET_TEST_REPORT)fs.writeFileSync(process.env.C3_WIDGET_TEST_REPORT,JSON.stringify({completed,production_runtime:false},null,2));
console.log(JSON.stringify({tests:completed.length,passed:completed.length,production_runtime:false}));
