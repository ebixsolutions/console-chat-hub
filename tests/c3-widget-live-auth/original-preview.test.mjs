import './semantic-bounds.test.mjs';
import {execFileSync} from 'node:child_process';
import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
// Actual wrapper + signed persisted authority + paid-dispatch boundary. Only
// Auth/DB/Widget transport/provider are isolated adapters. Never Hosted PASS.
const f={};globalThis.Deno={env:{get:k=>f.env?.[k]},serve(){}};
const out=await build({stdin:{contents:`export {createWidgetLiveHandler} from './supabase/functions/widget-live-ai-test/index.ts'; export * from './supabase/functions/_shared/original-widget-preview.ts'; export {trustedDispatchScope} from './supabase/functions/_shared/uat-execution-contract.ts'; export {accountedModelFetch,authorizeOriginalPreviewKB,consumeOriginalPreviewKBPermit} from './supabase/functions/_shared/model-attempt-accounting.ts'; export {prepareRemoteRetrieval,signRemote} from './supabase/functions/_shared/remote-model-accounting.ts'; export {fetchKBRag,resolveTenantScope,resolveKBEndpoint} from './supabase/functions/_shared/kb-client.ts';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'sdk-transport-only',setup(b){if(process.env.C3_KB_ADMISSION_SOURCE_REF)b.onLoad({filter:/supabase\/functions\/_shared\/(kb-client|model-attempt-accounting|remote-model-accounting)\.ts$/},a=>({contents:execFileSync('git',['show',process.env.C3_KB_ADMISSION_SOURCE_REF+':'+a.path.slice(process.cwd().length+1)],{encoding:'utf8'}),loader:'ts'}));b.onResolve({filter:/^https:\/\/esm.sh\//},a=>({path:a.path,namespace:'sdk'}));b.onLoad({filter:/.*/,namespace:'sdk'},()=>({contents:'export const createClient=(url,key)=>globalThis.__c3KbClient(url,key);'}));}}]});
const {createWidgetLiveHandler,ORIGINAL_PREVIEW_AUTHORIZATION,ORIGINAL_PREVIEW_ACCOUNTS,signOriginalPreview,verifyOriginalPreview,trustedDispatchScope,accountedModelFetch,authorizeOriginalPreviewKB,consumeOriginalPreviewKBPermit,fetchKBRag,resolveTenantScope,resolveKBEndpoint,prepareRemoteRetrieval,signRemote}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const realFetch=globalThis.fetch;const realKbClient=globalThis.__c3KbClient;test.after(()=>{globalThis.fetch=realFetch;if(realKbClient===undefined)delete globalThis.__c3KbClient;else globalThis.__c3KbClient=realKbClient;});
const body=JSON.stringify({contents:[{role:'user',parts:[{text:'Compare options for my business.'}]}],generationConfig:{maxOutputTokens:2048}});
function setup(account,{grant=true}={}){
 f.account=account;f.user={id:crypto.randomUUID(),email:account.email,email_confirmed_at:'2026-01-01T00:00:00Z'};
 f.env={SUPABASE_URL:'https://nrfxhqabwblzxoushgnm.supabase.co',SUPABASE_ANON_KEY:'public',SUPABASE_SECRET_KEY:'isolated-secret-not-production',LLM_PROVIDER:'vertex',GOOGLE_SERVICE_ACCOUNT_JSON:'isolated-provider-config',GOOGLE_PROJECT_ID:'fixture-project',GOOGLE_REGION:'asia-east1',LLM_MODEL_GENERATION:'gemini-2.5-flash',...(grant?{ORIGINAL_WIDGET_PREVIEW_AUTHORIZATION:ORIGINAL_PREVIEW_AUTHORIZATION}:{})};
 f.rows={company_membership:[{user_id:f.user.id,company_id:account.company,role:'admin',is_active:true}],company:[{id:account.company,is_active:true}],channel_config:[{id:account.channel,company_id:account.company,is_active:true,channel_type:'web_widget',allowed_origins:['https://console-chat-hub.lovable.app']}],visitor_session:[],conversations:[],messages:[]};f.logs=[];f.rpc=[];f.transport=[];f.provider=0;f.writes=0;f.deferAnswer=false;f.omitVisitor=false;f.afterReceive=null;f.tasks=[];f.releaseGeneration=null;
 f.db={rpc:async(n)=>{f.rpc.push(n);throw Error('Original Preview must not borrow synthetic quota/registration');},from(table){let filters=[],single=false,op=null,payload,fields='',opts={};const q={
 select(s,o={}){fields=s;opts=o;return q;},eq(k,v){filters.push([k,v]);return q;},is(k,v){filters.push([k,v]);return q;},neq(k,v){filters.push([k,v,true]);return q;},order(){return q;},limit(){return q;},maybeSingle(){single=true;return q;},single(){single=true;return q;},insert(v){op='insert';payload=v;return q;},delete(){op='delete';return q;},update(v){op='update';payload=v;return q;},then(resolve,reject){return Promise.resolve().then(()=>{
 const get=(r,k)=>k.includes('->>')?r[k.split('->>')[0]]?.[k.split('->>')[1]]:r[k];let rows=(f.rows[table]??[]).filter(r=>filters.every(([k,v,ne])=>ne?get(r,k)!==v:get(r,k)===v));
 if(op==='insert'){if(payload.id && f.rows[table].some(r=>r.id===payload.id))return {data:null,error:{code:'23505'}};const row={id:crypto.randomUUID(),...payload};f.rows[table].push(row);rows=[row];f.writes++;}
 if(op==='delete'){f.rows[table]=f.rows[table].filter(r=>!rows.includes(r));f.writes++;}
 if(op==='update'){rows.forEach(r=>Object.assign(r,payload));f.writes++;}
 if(table==='messages'&&fields.includes('archive:')&&f.omitVisitor)rows=[];
 if(table==='messages'&&fields.includes('archive:'))rows=rows.map(r=>{const c=f.rows.conversations.find(c=>c.id===r.conversation_id);return {...r,archive:{...c,archive_channel:f.rows.channel_config.find(ch=>ch.id===c.channel_config_id),archive_session:f.rows.visitor_session.find(s=>s.id===c.visitor_session_id)}};});
 return {data:single?(rows[0]??null):rows,error:null,count:rows.length};}).then(resolve,reject);}};return q;}};
 globalThis.__c3KbClient=(url,key)=>{assert.equal(url,f.env.SUPABASE_URL);assert.equal(key,f.env.SUPABASE_SECRET_KEY);return f.db;};
 f.url='https://asia-east1-aiplatform.googleapis.com/v1/projects/fixture-project/locations/asia-east1/publishers/google/models/gemini-2.5-flash:generateContent';
 f.upstream=async()=>{f.provider++;return Response.json({usageMetadata:{promptTokenCount:25,candidatesTokenCount:20},candidates:[{content:{parts:[{text:'Isolated provider reply'}]}}]});};
 globalThis.fetch=async(url,init)=>{f.transport.push(String(url));const b=JSON.parse(init.body),c=f.rows.conversations.find(c=>c.id===b.conversation_id),s=f.rows.visitor_session.find(s=>s.id===c?.visitor_session_id);assert(c);assert.equal(s.session_token,b.session_token);
 if(String(url).endsWith('receive-widget-message')){
 let m=f.rows.messages.find(m=>m.role==='visitor'&&m.metadata.client_message_id===b.client_message_id);const repeated=!!m;
 if(!m){m={id:crypto.randomUUID(),conversation_id:c.id,role:'visitor',content:b.content,is_recalled:false,metadata:{client_message_id:b.client_message_id}};f.rows.messages.push(m);
 if(c.status==='open') {const generate=async()=>{if(f.deferAnswer)await new Promise(resolve=>{f.releaseGeneration=resolve;});await accountedModelFetch(f.db,{companyId:c.company_id,conversationId:c.id,operationId:'generate-reply-'+m.id,provider:'vertex',purpose:'generation',slot:'generation',attempt:1,request:body},f.url,{method:'POST',body},f.upstream);f.rows.messages.push({id:crypto.randomUUID(),conversation_id:c.id,role:'assistant',content:'Isolated provider reply',is_recalled:false,metadata:{source_message_id:m.id,generation_success:true}});};if(f.deferAnswer)f.tasks.push(generate());else await generate();}}
 if(f.afterReceive)f.afterReceive();
 return Response.json({success:true,data:{message_id:m.id,ai_reply_pending:f.deferAnswer&&c.status==='open',idempotent:repeated}});
 }
 assert(String(url).endsWith('widget-poll-messages'));return Response.json({success:true,data:{messages:f.rows.messages.filter(m=>m.conversation_id===c.id&&(!f.omitVisitor||m.role!=='visitor')),human_support:{state:c.status==='pending'?'waiting':'none'},ai_generating:false}});
 };
 f.handler=createWidgetLiveHandler({env:k=>f.env[k],getAdminKey:()=>f.env.SUPABASE_SECRET_KEY,log(event){f.logs.push(event);},createClient:(url,key)=>key==='public'?{auth:{getUser:async()=>({data:{user:f.user},error:null})},rpc:async()=>{throw Error('Original actor must use own Channel, not B12 registration');}}:f.db});
}
async function request(b){const r=await f.handler(new Request('https://function.invalid',{method:'POST',headers:{Authorization:'Bearer isolated-verified-actor',Origin:'https://console-chat-hub.lovable.app','Content-Type':'application/json'},body:JSON.stringify(b)}));return {status:r.status,data:await r.json()};}
async function start(){const id=crypto.randomUUID();const r=await request({action:'original_preview_send',client_message_id:id,query:'Please compare options for my business.'});assert.equal(r.status,200,JSON.stringify(r));return {r,id,c:f.rows.conversations[0]};}
for(const account of ORIGINAL_PREVIEW_ACCOUNTS){
 test(account.email+': original free-form creates marked own ticket, reaches provider boundary, persists and polls exactly once',async()=>{
  setup(account);const h=await request({action:'history'});assert.equal(h.data.execution_class,'authenticated_admin_preview');assert.equal(h.data.execution_ready,true);assert.equal(h.data.remote_ready,false);
  const {r,id,c}=await start();assert.equal(c.company_id,account.company);assert.equal(c.channel_config_id,account.channel);assert.equal(c.metadata_source.source,'widget_live_test');assert.equal(c.metadata_source.widget_live_test,true);assert.equal(c.metadata_source.exclude_training,true);assert.notEqual(c.metadata_source.synthetic,true);assert.equal(await trustedDispatchScope(f.db,account.company,c.id),'authenticated_preview');assert.equal(r.data.answer,'');assert.equal((await request({action:'load',test_conversation_id:c.id})).data.messages.find(m=>m.role==='assistant').content,'Isolated provider reply');assert.equal(f.provider,1);assert.equal(f.rpc.length,0);
  const duplicate=await request({action:'original_preview_send',client_message_id:id,query:'Please compare options for my business.'});assert.equal(duplicate.data.conversation_id,c.id);assert.equal(duplicate.data.idempotent,true);assert.equal(f.provider,1);assert.equal(f.rows.messages.length,2);assert.equal(f.rows.visitor_session.length,1);assert.equal(f.rows.conversations.length,1);assert(!JSON.stringify(r).includes('original_preview_authority'));assert(f.transport.every(u=>!u.endsWith('generate-reply')));
 });
 test(account.email+': absent paid permission denies before creating Session/message or provider I/O',async()=>{setup(account,{grant:false});const r=await request({action:'original_preview_send',client_message_id:crypto.randomUUID(),query:'Compare options for my business.'});assert.equal(r.status,503);assert.equal(r.data.failure.code,'ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED');assert.equal(r.data.failure.stage,'admission');assert.equal(f.writes,0);assert.equal(f.provider,0);assert.equal(f.rpc.length,0);});
 test(account.email+': browser grant, synthetic relabel, receipt tamper and Tenant/session drift cannot authorize dispatch',async()=>{
  setup(account);const {c}=await start();const baseline=structuredClone(c);for(const change of [c=>c.company_id=ORIGINAL_PREVIEW_ACCOUNTS.find(a=>a!==account).company,c=>c.channel_config_id=crypto.randomUUID(),c=>c.visitor_session_id=crypto.randomUUID(),c=>c.metadata_source.owner_user_id=crypto.randomUUID(),c=>c.metadata_source.original_preview_authority.signature='0'.repeat(64),c=>c.metadata_source.source='c3_uat_widget',c=>c.metadata_source.synthetic=true]){
   Object.assign(c,structuredClone(baseline));change(c);await assert.rejects(()=>trustedDispatchScope(f.db,account.company,c.id));assert.equal(f.provider,1);
  }Object.assign(c,baseline);delete f.env.ORIGINAL_WIDGET_PREVIEW_AUTHORIZATION;await assert.rejects(()=>trustedDispatchScope(f.db,account.company,c.id));assert.equal(await verifyOriginalPreview(f.db,c,undefined,false),true);
 });
 test(account.email+': revoked role and foreign Session deny, ordinary Frankie and synthetic UAT retain their classes',async()=>{
  setup(account);const {c}=await start();f.rows.company_membership[0].role='agent';assert.equal(await verifyOriginalPreview(f.db,c),false);f.rows.company_membership[0].role='admin';f.rows.visitor_session[0].visitor_metadata.owner_user_id='foreign';assert.equal(await verifyOriginalPreview(f.db,c),false);f.rows.visitor_session[0].visitor_metadata.owner_user_id=f.user.id;
  c.metadata_source={source:'c3_uat_widget',synthetic:true,exclude_training:true,owner_user_id:f.user.id};await assert.rejects(()=>trustedDispatchScope(f.db,account.company,c.id));if(account===ORIGINAL_PREVIEW_ACCOUNTS[0]){c.metadata_source={source:'ordinary_customer'};assert.equal(await trustedDispatchScope(f.db,account.company,c.id),'legacy');}
 });
 test(account.email+': provider permissions do not allow fallback, foreign endpoint, oversized output, or fourth attempt',async()=>{
  setup(account);const {c}=await start();const meta={companyId:account.company,conversationId:c.id,operationId:'next-visitor',provider:'vertex',purpose:'generation',slot:'generation',attempt:1,request:body};
  for(const [m,url,payload] of [[{...meta,provider:'anthropic'},f.url,body],[meta,'https://foreign.invalid/generateContent',body],[{...meta,attempt:4},f.url,body],[meta,f.url,JSON.stringify({generationConfig:{maxOutputTokens:99999}})]])await assert.rejects(()=>accountedModelFetch(f.db,{...m,request:payload},url,{method:'POST',body:payload},f.upstream));assert.equal(f.provider,1);
 });
 test(account.email+': revoked permission reconciliation is read-only and never automatically resends',async()=>{setup(account);const {id,c}=await start();delete f.env.ORIGINAL_WIDGET_PREVIEW_AUTHORIZATION;const r=await request({action:'reconcile',client_message_id:id});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.conversation_id,c.id);assert.equal(r.data.read_only,true);assert.equal(f.provider,1);assert.equal(f.rows.messages.length,2);});
}
for(const account of ORIGINAL_PREVIEW_ACCOUNTS){
 test(account.email+': existing synthetic ticket never becomes original Preview under the new paid permission',async()=>{setup(account);const {c}=await start();c.metadata_source={source:'c3_uat_widget',synthetic:true,exclude_training:true,owner_user_id:f.user.id};const before=structuredClone(c);const r=await request({action:'original_preview_send',test_conversation_id:c.id,client_message_id:crypto.randomUUID(),query:'Compare business options.'});assert.equal(r.status,403);assert.equal(r.data.error,'original_preview_new_conversation_required');assert.deepEqual(c,before);assert.equal(f.provider,1);assert.equal(f.rows.messages.length,2);});
 test(account.email+': cross-Tenant load and browser scope spoof are denied without message/provider access',async()=>{setup(account);const {c}=await start();const foreign={...structuredClone(c),id:crypto.randomUUID(),company_id:ORIGINAL_PREVIEW_ACCOUNTS.find(a=>a!==account).company};f.rows.conversations.push(foreign);const load=await request({action:'load',test_conversation_id:foreign.id});assert.equal(load.status,404);const spoof=await request({action:'original_preview_send',query:'business',client_message_id:crypto.randomUUID(),company_id:foreign.company_id,original_preview_authority:c.metadata_source.original_preview_authority});assert.equal(spoof.status,400);assert.equal(f.provider,1);assert.equal(f.rows.messages.length,2);});
 test(account.email+': human control suppresses AI and resolved conversations cannot reopen',async()=>{setup(account);const {c}=await start();c.status='pending';const r=await request({action:'original_preview_send',test_conversation_id:c.id,client_message_id:crypto.randomUUID(),query:'Please update my customer requirements.'});assert.equal(r.status,200);assert.equal(r.data.human_control,true);assert.equal(f.provider,1);c.status='resolved';const closed=await request({action:'original_preview_send',test_conversation_id:c.id,client_message_id:crypto.randomUUID(),query:'Any update?'});assert.equal(closed.status,409);assert.equal(f.provider,1);});
}
test('email mismatch and unconfirmed email cannot mint original Preview authority',async()=>{setup(ORIGINAL_PREVIEW_ACCOUNTS[0]);for(const user of [{...f.user,email:'other@example.invalid'},{...f.user,email_confirmed_at:null}])await assert.rejects(()=>signOriginalPreview(user,f.account.company,f.account.channel,crypto.randomUUID(),crypto.randomUUID()));assert.equal(f.provider,0);assert.equal(f.writes,0);});

test('existing send action stays Synthetic UAT even for an explicitly paid-authorized original account',async()=>{for(const account of ORIGINAL_PREVIEW_ACCOUNTS){setup(account);const r=await request({action:'send',client_message_id:crypto.randomUUID(),query:'Compare business options.'});assert.equal(r.status,503);assert.equal(r.data.failure.code,'UAT_AUTHORIZATION_ABSENT');assert.equal(f.writes,0);assert.equal(f.provider,0);}});
test('dedicated original action cannot grant access to another authenticated email',async()=>{setup(ORIGINAL_PREVIEW_ACCOUNTS[0]);f.user.email='other@example.invalid';const r=await request({action:'original_preview_send',client_message_id:crypto.randomUUID(),query:'Business query'});assert.equal(r.status,403);assert.equal(f.writes,0);assert.equal(f.provider,0);});

for(const account of ORIGINAL_PREVIEW_ACCOUNTS){
 test(account.email+': lightweight trusted admission performs no archive reads, writes or model dispatch',async()=>{
  setup(account);const from=f.db.from;
  f.db.from=function(table){if(['conversations','visitor_session','messages'].includes(table))throw Error('Readiness must not read history');return from.call(this,table);};
  const r=await request({action:'readiness'});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.admission_action,'readiness');assert.equal(r.data.runtime_contract,'c3-widget-control-v2');assert.equal(r.data.actor_id,f.user.id);assert.equal(r.data.company_id,account.company);assert.equal(r.data.channel_id,account.channel);assert.equal(r.data.execution_class,'authenticated_admin_preview');assert.equal(r.data.execution_ready,true);assert.equal(r.data.remote_ready,false);assert(!('history' in r.data));assert.equal(f.logs.length,1);assert.equal(f.logs[0].action,'readiness');assert.equal(f.logs[0].stage,'admission_complete');assert.equal(f.logs[0].status,200);assert(Number.isFinite(f.logs[0].elapsed_ms)&&f.logs[0].elapsed_ms>=0);assert.equal(f.logs[0].correlation_id,r.data.correlation_id);assert(!JSON.stringify(f.logs).includes(f.env.SUPABASE_SECRET_KEY));assert.equal(f.writes,0);assert.equal(f.provider,0);assert.equal(f.transport.length,0);assert.equal(f.rpc.length,0);
 });
 test(account.email+': history can remain pending while independent admission completes; revocation still denies paid readiness',async()=>{
  setup(account);const from=f.db.from;let release;const barrier=new Promise(resolve=>{release=resolve;});
  f.db.from=function(table){const q=from.call(this,table);if(table==='conversations'){const then=q.then;q.then=(resolve,reject)=>barrier.then(()=>then.call(q,resolve,reject));}return q;};
  let historyDone=false;const history=request({action:'history'}).then(r=>{historyDone=true;return r;});
  const ready=await request({action:'readiness'});assert.equal(ready.status,200);assert.equal(ready.data.execution_ready,true);assert.equal(historyDone,false);release();assert.equal((await history).status,200);
  delete f.env.ORIGINAL_WIDGET_PREVIEW_AUTHORIZATION;const denied=await request({action:'readiness'});assert.equal(denied.status,200);assert.equal(denied.data.execution_ready,false);assert.equal(denied.data.execution_failure.code,'ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED');assert.equal(f.writes,0);assert.equal(f.provider,0);
 });
 test(account.email+': lightweight admission retains role, Origin and client Tenant-injection denials',async()=>{
  setup(account);f.rows.company_membership[0].role='agent';assert.equal((await request({action:'readiness'})).status,403);
  setup(account);f.rows.channel_config[0].allowed_origins=['https://other.invalid'];assert.equal((await request({action:'readiness'})).status,503);
  setup(account);assert.equal((await request({action:'readiness',company_id:ORIGINAL_PREVIEW_ACCOUNTS.find(a=>a!==account).company})).status,400);assert.equal(f.writes,0);assert.equal(f.provider,0);
 });
}

for(const account of ORIGINAL_PREVIEW_ACCOUNTS)test(account.email+': durable Visitor receipt returns while governed generation remains pending; polling delivers exactly once',async()=>{
 setup(account);f.deferAnswer=true;const client=crypto.randomUUID(),started=performance.now();
 const r=await request({action:'original_preview_send',client_message_id:client,query:'Please explain selection trade-offs for my business.'});const elapsed=performance.now()-started;
 const tasks=[...f.tasks];f.releaseGeneration();await Promise.all(tasks);
 assert.equal(r.status,200,JSON.stringify(r));assert(elapsed<2000,'unnecessary post-receipt wait '+elapsed+'ms');assert.equal(r.data.delivery_receipt.persisted,true);assert.equal(r.data.generation_success,false);assert.equal(r.data.answer,'');assert.equal(f.provider,1);assert.equal(f.transport.filter(x=>x.endsWith('widget-poll-messages')).length,0,'send receipt must not depend on another HTTP poll');
 const c=f.rows.conversations[0];const loaded=await request({action:'load',test_conversation_id:c.id});assert.equal(loaded.status,200);assert.equal(loaded.data.messages.filter(m=>m.role==='assistant').length,1);
 const replay=await request({action:'original_preview_send',test_conversation_id:c.id,client_message_id:client,query:'Please explain selection trade-offs for my business.'});assert.equal(replay.data.delivery_receipt.visitor_message_id,r.data.delivery_receipt.visitor_message_id);assert.equal(f.provider,1);assert.equal(f.rows.messages.length,2);
 console.log('ISOLATED_RECEIPT_RESPONSE_MS',account.email,Math.round(elapsed),'NOT_HOSTED_AI_LATENCY');
});

for(const account of ORIGINAL_PREVIEW_ACCOUNTS)test(account.email+': a missing durable Visitor cannot become a verified receipt or trigger a blind resend',async()=>{
 setup(account);f.deferAnswer=true;f.omitVisitor=true;const id=crypto.randomUUID();
 const r=await request({action:'original_preview_send',client_message_id:id,query:'Please help compare the options.'});
 assert.equal(r.status,503);assert.equal(r.data.error,'visitor_receipt_unverified');assert.equal(r.data.delivery_receipt,undefined);assert.equal(f.transport.filter(u=>u.endsWith('receive-widget-message')).length,1);assert.equal(f.rows.messages.filter(m=>m.role==='visitor').length,1);
 f.omitVisitor=false;f.releaseGeneration();await Promise.all(f.tasks);const reconciled=await request({action:'reconcile',client_message_id:id});assert.equal(reconciled.status,200);assert.equal(reconciled.data.reconciled_client_message_id,id);assert.equal(reconciled.data.messages.filter(m=>m.role==='visitor').length,1);assert.equal(f.provider,1);assert.equal(f.transport.filter(u=>u.endsWith('receive-widget-message')).length,1);
});

for(const account of ORIGINAL_PREVIEW_ACCOUNTS)test(account.email+': Vertex B-O does not admit Singapore KB embedding or any downstream transport',async()=>{
 setup(account);const {c}=await start();let remote=0;const requestBody=JSON.stringify({query:'current published product facts',company_id:'fixture-only-not-a-live-mapping'});
 await assert.rejects(()=>accountedModelFetch(f.db,{companyId:account.company,conversationId:c.id,operationId:'kb-'+crypto.randomUUID(),provider:'singapore-kb',purpose:'kb_embedding',slot:'context-search',attempt:1,request:requestBody},'https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search',{method:'POST',body:requestBody},async()=>{remote++;return Response.json({});}),e=>e.code==='ORIGINAL_PREVIEW_PROVIDER_DENIED');assert.equal(remote,0);assert.equal(f.provider,1);
});

for(const account of ORIGINAL_PREVIEW_ACCOUNTS)test(account.email+': KB adapter applies original provider admission before remote UAT preparation',async()=>{
 setup(account);const {c}=await start();f.transport=[];const mapped=account===ORIGINAL_PREVIEW_ACCOUNTS[0]?'101':'202';f.env.KB_SINGAPORE_TENANT_MAP_JSON=JSON.stringify({[account.company]:mapped});f.env.KB_SINGAPORE_TENANT_API_KEYS_JSON=JSON.stringify({[mapped]:'isolated-existing-tenant-key-not-production'});
 const scope=await resolveTenantScope(c.id,undefined,account.company);assert.equal(scope.resolved,true);assert.equal(scope.scope.singaporeTenantId,mapped);
 const diagnostics=[];const oldLog=console.log;let result;console.log=(value)=>diagnostics.push(value);
 try {result=await fetchKBRag({query:'Please check the current published policy.',top_k:3},scope.scope,resolveKBEndpoint(),{uatContext:{conversationId:c.id,sourceMessageId:f.rows.messages.find(m=>m.role==='visitor').id,operationId:'kb:'+crypto.randomUUID()}});}finally{console.log=oldLog;}
 assert.equal(diagnostics.length,2);for(const line of diagnostics){const entry=JSON.parse(line);assert.equal(entry.canonical_kb_tenant,mapped);assert.equal(entry.source_message_id,f.rows.messages.find(m=>m.role==='visitor').id);assert.equal(entry.company_id,account.company);}assert(!JSON.stringify(diagnostics).includes('isolated-existing-tenant-key'));assert(!JSON.stringify(diagnostics).includes('Please check the current'));
 assert.equal(result.success,false);assert.equal(result.failure.code,'ORIGINAL_PREVIEW_PROVIDER_DENIED',JSON.stringify(result));assert.equal(result.failure.stage,'admission');assert.equal(f.transport.length,0,'no contract GET or retrieval POST before paid authority');assert.equal(f.provider,1);
 const wrong=await resolveTenantScope(c.id,undefined,ORIGINAL_PREVIEW_ACCOUNTS.find(a=>a!==account).company);assert.equal(wrong.resolved,false);assert.equal(wrong.reason,'KB_TENANT_IDENTITY_CONFLICT');assert.equal(f.transport.length,0);
});
for(const account of ORIGINAL_PREVIEW_ACCOUNTS)test(account.email+': admitted Vertex preparation receives server classification; denied scopes never call preparation',async()=>{
 setup(account);const {c}=await start();let prepared=0;const meta={companyId:account.company,conversationId:c.id,operationId:'generation:'+crypto.randomUUID(),provider:'vertex',purpose:'generation',slot:'generation',attempt:1,request:body};
 const up=async(url,init)=>{assert.equal(new Headers(init.headers).get('x-server-scope'),'authenticated_preview');assert.equal(init.body,body);assert.equal(init.redirect,'error');return Response.json({});};
 await accountedModelFetch(f.db,meta,f.url,{method:'POST',body,headers:{'x-server-scope':'caller-value'}},up,undefined,async mode=>{prepared++;assert.equal(mode,'authenticated_preview');return {'x-server-scope':mode};});assert.equal(prepared,1);
 c.company_id=ORIGINAL_PREVIEW_ACCOUNTS.find(a=>a!==account).company;await assert.rejects(()=>accountedModelFetch(f.db,meta,f.url,{method:'POST',body},up,undefined,async()=>{prepared++;return {};}));assert.equal(prepared,1);
});

test('ordinary Frankie KB dispatch retains its canonical request and credential headers without a synthetic lease',async()=>{
 setup(ORIGINAL_PREVIEW_ACCOUNTS[0]);const {c}=await start();c.metadata_source={source:'ordinary_customer'};const key='isolated-existing-key-never-live';f.env.KB_SINGAPORE_TENANT_MAP_JSON=JSON.stringify({[c.company_id]:'101'});f.env.KB_SINGAPORE_TENANT_API_KEYS_JSON=JSON.stringify({'101':key});
 const scope=await resolveTenantScope(c.id,undefined,c.company_id);assert.equal(scope.resolved,true);const cfg=resolveKBEndpoint();let requests=0;const previous=globalThis.fetch;globalThis.fetch=async(url,init)=>{requests++;assert.equal(String(url),cfg.ragUrl);assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('x-api-key'),key);assert.equal(new Headers(init.headers).get('x-ai-company-id'),null);assert.equal(JSON.parse(init.body).company_id,101);return Response.json({success:true,context_found:false,selected_documents:[],citations:[],meta:{}});};
 try{const result=await fetchKBRag({query:'ordinary published policy',top_k:3},scope.scope,cfg,{uatContext:{conversationId:c.id,operationId:'kb:'+crypto.randomUUID()}});assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.failure.code,'KB_NO_MATCH');assert.equal(requests,1);assert.equal(f.provider,1);assert.equal(f.rpc.length,0);}finally{globalThis.fetch=previous;}
});

for(const account of ORIGINAL_PREVIEW_ACCOUNTS)for(const fault of ['none','grant-absent','wrong-actor','foreign-tenant','runtime','signature','shared-atomic','proof-bypass','forged-permit','revoked'])test(account.email+': conditional KB compatibility retains independent permission and request-bound remote proof: '+fault,async()=>{
 setup(account);const {c}=await start();const tenant=account===ORIGINAL_PREVIEW_ACCOUNTS[0]?'101':'202';const endpoint='https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search';const secret='isolated-existing-tenant-secret';const runtime='a'.repeat(64);f.env.KB_SINGAPORE_TENANT_MAP_JSON=JSON.stringify({[account.company]:tenant});
 const binding={actor_id:fault==='wrong-actor'?crypto.randomUUID():f.user.id,company_id:account.company,channel_id:account.channel,tenant_id:tenant,endpoint,provider:'singapore-kb',purpose:'kb_embedding',remote_mode:'retrieval_only',allow_remote_embedding:false,remote_runtime_sha256:runtime};
 if(fault!=='grant-absent')f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify({version:1,bindings:[binding]});
 const request=JSON.stringify({query:'published product facts',company_id:fault==='foreign-tenant'?999:Number(tenant),candidate_top_k:10,max_documents:5,max_summary_chunks:1,max_full_content_chunks:3,score_threshold:0.05});let get=0,post=0;
 const up=async(url,init)=>{
  if(String(url).endsWith('/model-accounting-contract')){get++;assert.equal(init.method,'GET');const scope=JSON.parse(new Headers(init.headers).get('x-c3-accounting-scope'));assert.equal(scope.tenant,tenant);assert.equal(scope.company,account.company);const body=JSON.stringify({...scope,protocol:'c3-shared-attempt-v1',mode:fault==='shared-atomic'?'shared_atomic_attempts':'retrieval_only',runtime_sha256:fault==='runtime'?'b'.repeat(64):runtime});if(fault==='revoked')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;return new Response(body,{headers:{'x-c3-accounting-signature':fault==='signature'?'0'.repeat(64):await signRemote(body,secret)}});}
  assert.equal(String(url),endpoint);assert.equal(init.method,'POST');post++;return Response.json({success:true});
 };
 const meta={companyId:account.company,conversationId:c.id,operationId:'isolated-kb-test',provider:'singapore-kb',purpose:'kb_embedding',slot:'context-search',attempt:1,request};let error;
 try{await accountedModelFetch(f.db,meta,endpoint,{method:'POST',body:request},up,undefined,async(mode,permit)=>fault==='proof-bypass'?{}:await prepareRemoteRetrieval(account.company,tenant,secret,endpoint,up,undefined,'kb',request,mode,fault==='forged-permit'?{}:permit));}catch(e){error=e;}
 if(fault==='none'){assert.equal(error,undefined);assert.equal(get,1);assert.equal(post,1);}else{assert(error);assert.equal(post,0);if(['grant-absent','wrong-actor','foreign-tenant','proof-bypass','forged-permit'].includes(fault))assert.equal(get,0);}
 assert.equal(f.provider,1,'no extra Vertex retry');assert.equal(f.rpc.length,0,'no synthetic quota or new accounting backend');
});

for(const account of ORIGINAL_PREVIEW_ACCOUNTS)test(account.email+': Origin revocation between durable receive and receipt fails closed without another poll or resend',async()=>{
 setup(account);f.afterReceive=()=>{f.rows.channel_config[0].allowed_origins=[];};const id=crypto.randomUUID();
 const r=await request({action:'original_preview_send',client_message_id:id,query:'Please explain selection trade-offs without a lookup.'});assert.equal(r.status,403);assert.equal(r.data.error,'widget_origin_or_channel_revoked');assert.equal(r.data.delivery_receipt,undefined);assert.equal(f.rows.messages.filter(m=>m.role==='visitor').length,1);assert.equal(f.transport.filter(u=>u.endsWith('receive-widget-message')).length,1);assert.equal(f.transport.filter(u=>u.endsWith('widget-poll-messages')).length,0);
});

// Every credential/runtime/evidence here is an isolated fixture. No model, KB
// server or Production is contacted; these are not Hosted acceptance receipts.
const fixtureDigest=async s=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');
async function embeddingFixture(fault='none') {
 setup(ORIGINAL_PREVIEW_ACCOUNTS[0]);f.user.id='3bdf936e-b543-41d8-9fff-fa020a85f3f6';f.rows.company_membership[0].user_id=f.user.id;
 const {c}=await start(),secret='isolated-existing-kb-key-not-production';
 const content='Isolated published subscription policy; not merchant data.';
 const endpoint='https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search';
 const a={protocol:'original-preview-query-embedding-v1',actor:f.user.id,company:c.company_id,channel:c.channel_config_id,tenant:'34',endpoint,
  runtime_sha256:await fixtureDigest('ISOLATED_RUNTIME_NOT_LIVE'),deployment_evidence_sha256:await fixtureDigest('ISOLATED_DEPLOYMENT_RECEIPT'),embedding_config_sha256:await fixtureDigest('ISOLATED_EMBEDDING_SETTINGS'),lineage_evidence_sha256:await fixtureDigest('ISOLATED_LINEAGE_RECEIPT'),
  observed_at:Math.floor(Date.now()/1000)-1,expires:Math.floor(Date.now()/1000)+600,
  deployment_pinned_until_expiry:true,lineage_pinned_until_expiry:true,query_embedding_calls:1,embedding_retries:0,generation_calls:0,ingestion_allowed:false,reindex_allowed:false,max_query_bytes:2048,
  documents:[{document_id:'fixture-published-policy',version_id:'fixture-version-2',chunks:[{chunk_id:'fixture-chunk-2',content_sha256:await fixtureDigest(content)}]}]};
 if(fault==='expired')a.expires=a.observed_at-1;
 if(fault==='future')a.observed_at=Math.floor(Date.now()/1000)+100;
 if(fault==='retries')a.embedding_retries=1;
 if(fault==='generation')a.generation_calls=1;
 if(fault==='mutable-runtime')a.deployment_pinned_until_expiry=false;
 if(fault==='mutable-lineage')a.lineage_pinned_until_expiry=false;
 if(fault==='ingestion')a.ingestion_allowed=true;
 if(fault==='foreign-attestation')a.tenant='35';
 a.lineage_evidence_sha256=await fixtureDigest(JSON.stringify(a.documents,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v));
 if(fault==='lineage-digest')a.lineage_evidence_sha256=await fixtureDigest('WRONG_LINEAGE_SNAPSHOT');
 const payload=JSON.stringify(a);
 const binding={actor_id:fault==='actor'?crypto.randomUUID():f.user.id,company_id:c.company_id,channel_id:c.channel_config_id,tenant_id:'34',endpoint,provider:'singapore-kb',purpose:'kb_embedding',remote_mode:'query_embedding_attested_v1',allow_remote_embedding:true,
  remote_runtime_sha256:fault==='runtime'?await fixtureDigest('OTHER_RUNTIME'):a.runtime_sha256,deployment_evidence_sha256:a.deployment_evidence_sha256,lineage_evidence_sha256:a.lineage_evidence_sha256,
  embedding_config_sha256:a.embedding_config_sha256,
  attestation_payload:payload,attestation_signature:fault==='signature'?'f'.repeat(64):await signRemote(payload,secret)};
 if(fault!=='no-grant')f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify({version:2,bindings:[binding]});
 if(fault==='BO-revoked')delete f.env.ORIGINAL_WIDGET_PREVIEW_AUTHORIZATION;
 if(fault==='human-control')c.status='pending';
 if(fault==='assigned-agent')c.assigned_agent_id=crypto.randomUUID();
 f.env.KB_SINGAPORE_TENANT_MAP_JSON=JSON.stringify({[c.company_id]:fault==='mapping'?'35':'34'});
 f.env.KB_SINGAPORE_TENANT_API_KEYS_JSON=JSON.stringify({'34':secret});
 const request=JSON.stringify({query:'What is the published subscription policy?',company_id:34,candidate_top_k:10,max_documents:5,max_summary_chunks:1,max_full_content_chunks:3,score_threshold:0.05});
 const meta={companyId:c.company_id,conversationId:c.id,operationId:'kb:'+crypto.randomUUID(),provider:'singapore-kb',purpose:'kb_embedding',slot:'context-search',attempt:fault==='attempt'?2:1,request};
 let posts=0;
 const upstream=async(url,init)=>{
  assert.equal(String(url),endpoint,'existing API only; no invented accounting endpoint');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');posts++;
  if(fault==='unknown')throw new TypeError('isolated transport unknown');
  if(fault==='revoke-response')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
  if(fault==='no-match')return Response.json({success:true,context_found:false,selected_documents:[],citations:[]});
  const d={document_id:'fixture-published-policy',title:'Fixture policy',source_type:'policy',document_score:0.99,evidence:[{chunk_id:'fixture-chunk-2',chunk_type:'full_content',content:fault==='changed-content'?'Changed unreviewed content':content,score:0.99}]};
  if(fault==='foreign-response')d.tenant_id='35';
  if(fault==='old-version')d.version_id='fixture-version-1';
  if(fault==='draft')d.authority={publication_state:'draft'};
  if(fault==='unreviewed-chunk')d.evidence[0].chunk_id='unreviewed-chunk';
  return Response.json({success:true,context_found:true,selected_documents:[d],llm_context:{combined_text:'UNTRUSTED COMBINED TEXT'}});
 };
 const prepare=async(mode,permit)=>{
  if(fault==='proof-bypass')return {};
  const headers=await prepareRemoteRetrieval(c.company_id,'34',secret,endpoint,upstream,undefined,'kb',request,mode,permit);
  if(fault==='revoke-prepare')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
  return headers;
 };
 return {c,secret,endpoint,request,meta,upstream,prepare,posts:()=>posts};
}

for(const fault of ['none','no-match','no-grant','BO-revoked','human-control','assigned-agent','actor','mapping','attempt','signature','expired','future','runtime','lineage-digest','retries','generation','ingestion','mutable-runtime','mutable-lineage','foreign-attestation','proof-bypass','revoke-prepare','revoke-response','foreign-response','old-version','draft','changed-content','unreviewed-chunk','unknown'])test('Frankie separately authorized existing query embedding, closed controls and current lineage: '+fault,async()=>{
 const x=await embeddingFixture(fault);let result,error;
 try{result=await accountedModelFetch(f.db,x.meta,x.endpoint,{method:'POST',body:x.request},x.upstream,undefined,x.prepare);}catch(e){error=e;}
 const afterDispatch=['revoke-response','foreign-response','old-version','draft','changed-content','unreviewed-chunk','unknown'].includes(fault);
 if(['none','no-match'].includes(fault)) {
  assert.equal(error,undefined);assert.equal(x.posts(),1);
  const data=await result.json();assert.equal(data.context_found,fault==='none');
  if(fault==='none'){assert.equal(data.selected_documents[0].authority.tenant_id,'34');assert.equal(data.selected_documents[0].authority.version_id,'fixture-version-2');assert.equal(data.selected_documents[0].authority.currentness,'current');assert(!JSON.stringify(data).includes('UNTRUSTED COMBINED TEXT'));}
 }else {assert(error,'fault admitted');assert.equal(x.posts(),afterDispatch?1:0);}
 assert.equal(f.provider,1,'no additional Vertex repair/retry');assert.equal(f.rpc.length,0,'no synthetic quota/new accounting subsystem');
});

test('existing query embedding integrates with the canonical KB parser and published version authority',async()=>{
 const x=await embeddingFixture();const scope=await resolveTenantScope(x.c.id,undefined,x.c.company_id);assert.equal(scope.resolved,true);
 globalThis.fetch=x.upstream;
 const result=await fetchKBRag({query:'What is the published subscription policy?',top_k:3},scope.scope,resolveKBEndpoint(),{uatContext:{conversationId:x.c.id,operationId:'kb:'+crypto.randomUUID()}});
 assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.documents.length,1);assert.equal(result.documents[0].authority.version,'fixture-version-2');assert.equal(result.documents[0].authority.publication_state,'published');assert.equal(x.posts(),1);
});

test('one opaque query-embedding permit cannot be concurrently consumed twice or replayed',async()=>{
 const x=await embeddingFixture();const permit=await authorizeOriginalPreviewKB(f.db,x.meta,x.endpoint,{method:'POST',body:x.request});assert(permit);
 assert.equal(consumeOriginalPreviewKBPermit(permit),false,'unverified evidence consumed');
 await x.prepare('authenticated_preview',permit);
 const outcomes=await Promise.all([Promise.resolve().then(()=>consumeOriginalPreviewKBPermit(permit)),Promise.resolve().then(()=>consumeOriginalPreviewKBPermit(permit))]);
 assert.deepEqual(outcomes,[true,false]);assert.equal(consumeOriginalPreviewKBPermit(permit),false);assert.equal(x.posts(),0);
 // This proves same-isolate opaque-capability consumption only, not a durable
 // cross-isolate billing cap or the existing database exactly-once contract.
});

test('continued send keeps two distinct control/fresh-owner reads, removes the third duplicate, and reports safe stages',async()=>{
 setup(ORIGINAL_PREVIEW_ACCOUNTS[0]);const {c}=await start();const from=f.db.from,transport=globalThis.fetch;let beforeReceive=true,ownerReads=0;
 f.db.from=function(table){if(beforeReceive&&table==='conversations')ownerReads++;return from.call(this,table);};
 globalThis.fetch=async(url,init)=>{if(String(url).endsWith('receive-widget-message'))beforeReceive=false;return await transport(url,init);};
 const r=await request({action:'original_preview_send',test_conversation_id:c.id,client_message_id:crypto.randomUUID(),query:'Please correct the service term to twelve months.'});
 assert.equal(r.status,200,JSON.stringify(r));assert.equal(ownerReads,2,'control snapshot + fresh pre-dispatch read, no redundant middle query');
 const trace=f.logs.at(-1);assert.equal(trace.stage,'visitor_receipt_verified');
 for(const k of ['admission_ms','ownership_read_ms','session_read_ms','receive_ms','receipt_read_ms'])assert(Number.isFinite(trace[k])&&trace[k]>=0,k);
 assert.equal(trace.poll_ms,0);assert.equal(f.provider,2);
 c.status='resolved';const closed=await request({action:'original_preview_send',test_conversation_id:c.id,client_message_id:crypto.randomUUID(),query:'Another service question'});assert.equal(closed.status,409);assert.equal(f.provider,2);
});
