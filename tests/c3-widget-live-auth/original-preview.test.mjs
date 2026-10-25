import './semantic-bounds.test.mjs';
import './semantic-provider-transport.test.mjs';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';
// Actual wrapper + signed persisted authority + paid-dispatch boundary. Only
// Auth/DB/Widget transport/provider are isolated adapters. Never Hosted PASS.
const f={};globalThis.Deno={env:{get:k=>f.env?.[k]},serve(){}};
const out=await build({stdin:{contents:`export {kbErrorFamily,knowledgeFailureState} from './supabase/functions/_shared/kb-error-contract.ts'; export {createWidgetLiveHandler} from './supabase/functions/widget-live-ai-test/index.ts'; export * from './supabase/functions/_shared/original-widget-preview.ts'; export {authenticatedInboxAuthority,trustedDispatchScope} from './supabase/functions/_shared/uat-execution-contract.ts'; export {accountedModelFetch,authorizeOriginalPreviewKB,consumeOriginalPreviewKBPermit} from './supabase/functions/_shared/model-attempt-accounting.ts'; export {prepareRemoteRetrieval,signRemote} from './supabase/functions/_shared/remote-model-accounting.ts'; export {selectCanonicalGrounding,deriveCurrentGroundingTarget} from './supabase/functions/_shared/canonical-grounding.ts'; export {createKBStageDiagnostics,fetchKBRag,resolveTenantScope,resolveKBEndpoint} from './supabase/functions/_shared/kb-client.ts';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'sdk-transport-only',setup(b){if(process.env.C3_KB_ADMISSION_SOURCE_REF)b.onLoad({filter:/supabase\/functions\/_shared\/(kb-client|model-attempt-accounting|remote-model-accounting)\.ts$/},a=>({contents:execFileSync('git',['show',process.env.C3_KB_ADMISSION_SOURCE_REF+':'+a.path.slice(process.cwd().length+1)],{encoding:'utf8'}),loader:'ts'}));b.onResolve({filter:/^https:\/\/esm.sh\//},a=>({path:a.path,namespace:'sdk'}));b.onLoad({filter:/.*/,namespace:'sdk'},()=>({contents:'export const createClient=(url,key)=>globalThis.__c3KbClient(url,key);'}));}}]});
const {kbErrorFamily,knowledgeFailureState,createWidgetLiveHandler,ORIGINAL_PREVIEW_AUTHORIZATION,ORIGINAL_PREVIEW_ACCOUNTS,signOriginalPreview,verifyOriginalPreview,authenticatedInboxAuthority,trustedDispatchScope,accountedModelFetch,authorizeOriginalPreviewKB,consumeOriginalPreviewKBPermit,createKBStageDiagnostics,fetchKBRag,resolveTenantScope,resolveKBEndpoint,selectCanonicalGrounding,deriveCurrentGroundingTarget,prepareRemoteRetrieval,signRemote}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
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
 const legacyDiagnostics=diagnostics.map(line=>JSON.parse(line)).filter(entry=>entry.endpoint==='generate-reply');assert.equal(legacyDiagnostics.length,2);for(const entry of legacyDiagnostics){assert.equal(entry.canonical_kb_tenant,mapped);assert.equal(entry.source_message_id,f.rows.messages.find(m=>m.role==='visitor').id);assert.equal(entry.company_id,account.company);}const stages=diagnostics.map(line=>JSON.parse(line)).filter(entry=>entry.endpoint==='kb-stage');assert(stages.some(e=>e.stage==='accounting_admission'&&e.outcome==='error'));assert(!stages.some(e=>['remote_preparation','rag_transport'].includes(e.stage)));assert(!JSON.stringify(diagnostics).includes('isolated-existing-tenant-key'));assert(!JSON.stringify(diagnostics).includes('Please check the current'));
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
  documents:[{document_id:'fixture-published-policy',version_id:'fixture-version-2',chunks:[{chunk_id:'fixture-chunk-2',chunk_type:'full_content',content_sha256:await fixtureDigest(content)}]}]};
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
  const d={document_id:'fixture-published-policy',title:'Fixture policy',source_type:'policy',document_score:0.99,metadata:{regions:['HK'],entity_ids:['subscription-fixture']},evidence:[{chunk_id:'fixture-chunk-2',chunk_type:'full_content',content:fault==='changed-content'?'Changed unreviewed content':content,score:0.99}]};
  if(fault==='foreign-response')d.tenant_id='35';
  if(fault==='old-version')d.version_id='fixture-version-1';
  if(fault==='draft')d.authority={publication_state:'draft'};
  if(fault==='unreviewed-chunk')d.evidence[0].chunk_id='unreviewed-chunk';
  if(fault==='chunk-type')d.evidence[0].chunk_type='rag_summary';
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

for(const fault of ['none','no-match','no-grant','BO-revoked','human-control','assigned-agent','actor','mapping','attempt','signature','expired','future','runtime','lineage-digest','retries','generation','ingestion','mutable-runtime','mutable-lineage','foreign-attestation','proof-bypass','revoke-prepare','revoke-response','foreign-response','old-version','draft','changed-content','unreviewed-chunk','chunk-type','unknown'])test('Frankie separately authorized existing query embedding, closed controls and current lineage: '+fault,async()=>{
 const x=await embeddingFixture(fault);let result,error;
 try{result=await accountedModelFetch(f.db,x.meta,x.endpoint,{method:'POST',body:x.request},x.upstream,undefined,x.prepare);}catch(e){error=e;}
 const afterDispatch=['revoke-response','foreign-response','old-version','draft','changed-content','unreviewed-chunk','chunk-type','unknown'].includes(fault);
 if(['none','no-match'].includes(fault)) {
  assert.equal(error,undefined);assert.equal(x.posts(),1);
  const data=await result.json();assert.equal(data.context_found,fault==='none');
  if(fault==='none'){assert.equal(data.selected_documents[0].authority.tenant_id,'34');assert.equal(data.selected_documents[0].authority.version_id,'fixture-version-2');assert.equal(data.selected_documents[0].authority.currentness,'current');assert(!JSON.stringify(data).includes('UNTRUSTED COMBINED TEXT'));}
  if(fault==='none'){assert.deepEqual(data.selected_documents[0].authority.regions,['HK']);assert.deepEqual(data.selected_documents[0].authority.entity_ids,['subscription-fixture']);}
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

// Inbox entrypoints are bundled with all actual decision/authorization/router/
// parsing modules. Only Auth SDK transport, OAuth token transport and network
// adapters are isolated; these assertions are NOT Hosted or live KB evidence.
async function inboxHandler(slug){
 const oldServe=Deno.serve;let handler;Deno.serve=h=>{handler=h;};
 try {
  const out=await build({entryPoints:[`supabase/functions/${slug}/index.ts`],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'isolated-auth-transport',setup(b){
   b.onResolve({filter:/^(?:https:\/\/esm.sh\/|npm:)@supabase\/supabase-js/},()=>({path:'sdk',namespace:'transport'}));
   b.onResolve({filter:/^npm:google-auth-library/},()=>({path:'oauth',namespace:'transport'}));
   b.onLoad({filter:/.*/,namespace:'transport'},a=>({contents:a.path==='sdk'?'export const createClient=(url,key)=>globalThis.__c3InboxClient(url,key);':'export class GoogleAuth {async getClient(){return {getAccessToken:async()=>({token:"isolated-not-production"})}}}'}));
  }}]});
  await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));assert.equal(typeof handler,'function');return handler;
 }finally{Deno.serve=oldServe;}
}
const knowledgeHandler=await inboxHandler('kb-search-proxy'),policyHandler=await inboxHandler('agent-assist');
const priorInboxClient=globalThis.__c3InboxClient;test.after(()=>{if(priorInboxClient===undefined)delete globalThis.__c3InboxClient;else globalThis.__c3InboxClient=priorInboxClient;});
async function setupInbox(fault='none'){
 const x=await embeddingFixture(['signature','expired','foreign-response','changed-content','no-match'].includes(fault)?fault:'none');
 f.env.SUPABASE_SERVICE_ROLE_KEY=f.env.SUPABASE_SECRET_KEY;f.env.LLM_MODEL_ASSIST='gemini-2.5-flash';f.env.GOOGLE_SERVICE_ACCOUNT_JSON='{}';
 f.rows.user_roles=[{user_id:f.user.id,role:'admin'}];f.rows.agent_profile=[{id:crypto.randomUUID(),user_id:f.user.id,role:'admin',status:'active',display_name:'Isolated actor'}];f.rows.upstream_call_log=[];
 const binding=JSON.parse(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION).bindings[0];
 f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION=JSON.stringify({version:1,bindings:[{...binding,operations:['knowledge','policy'],allow_assist:true}]});
 if(fault==='no-inbox-grant')delete f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION;
 if(fault==='no-assist'){const g=JSON.parse(f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION);g.bindings[0].allow_assist=false;f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION=JSON.stringify(g);}
 if(fault==='BO-revoked')delete f.env.ORIGINAL_WIDGET_PREVIEW_AUTHORIZATION;
 if(fault==='no-preview-grant')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
 if(fault==='human-control')x.c.status='pending';
 if(fault==='role')f.rows.user_roles[0].role='qa';
 if(fault==='inactive-membership')f.rows.company_membership[0].is_active=false;
 if(fault==='foreign-ticket')x.c.company_id=crypto.randomUUID();
 if(fault==='synthetic'){x.c.metadata_source={...x.c.metadata_source,source:'c3_uat_widget',synthetic:true};}
 if(fault==='wrong-channel')f.rows.channel_config[0].company_id=crypto.randomUUID();
 if(fault==='assigned-agent'||fault==='unassigned-agent'){
  f.rows.user_roles[0].role='agent';f.rows.company_membership[0].role='agent';f.rows.agent_profile[0].role='agent';x.c.assigned_agent_id=fault==='assigned-agent'?f.rows.agent_profile[0].id:crypto.randomUUID();
 }
 const from=f.db.from;f.db.from=function(table){const q=from.call(this,table);q.in=()=>q;q.not=()=>q;return q;};
 const auth={getUser:async()=>({data:{user:fault==='unauthenticated'?null:f.user},error:null})};f.db.auth=auth;
 globalThis.__c3InboxClient=(url,key)=>{assert.equal(url,f.env.SUPABASE_URL);assert([f.env.SUPABASE_SECRET_KEY,f.env.SUPABASE_ANON_KEY].includes(key));return f.db;};
 let model=0;const prompts=[];
 globalThis.fetch=async(url,init)=>{
  if(String(url)===x.endpoint){if(fault==='tool-failure')return new Response(null,{status:503});if(fault==='revoke-on-return')delete f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION;return await x.upstream(url,init);}
  assert.equal(String(url),f.url,'no unrelated provider or accounting endpoint');model++;const b=JSON.parse(init.body);const text=b.contents.map(c=>c.parts.map(p=>p.text??'').join('')).join('');prompts.push(text);
  if(text.includes('proposed_claims'))return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({grounded:fault!=='unsupported-policy',unsupported_claims:fault==='unsupported-policy'?['unsupported full refund']:[],evidence_ids:['E1'],resolution:fault==='unsupported-policy'?'unsupported':'supported'})}]}}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:20}});
  let answer={queries:[]};if(text.includes('Text to check:'))answer=fault==='unsupported-policy'?{status:'compliant',summary:'Every cancellation receives an unconditional full refund.',issues:[]}:fault==='invalid-policy'?{status:'violation',summary:'invalid fixture',issues:[]}:{status:'warning',summary:'Isolated policy assessment',issues:[{excerpt:'fixture',policy_label:'Evidence 1',severity:'warning'}]};
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]}}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:20}});
 };
 const request=async(slug,content='Please assess my subscription cancellation draft.')=>{
  const body=slug==='knowledge'?{query:'published subscription policy',top_k:3,conversation_id:x.c.id}:{tool_type:'check_policy',conversation_id:x.c.id,content,context_mode:'conversation'};
  const r=await(slug==='knowledge'?knowledgeHandler:policyHandler)(new Request('https://isolated.invalid',{method:'POST',headers:{Authorization:'Bearer isolated',Origin:'https://console-chat-hub.lovable.app','Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:r.status,data:await r.json()};
 };
 return {...x,send:request,model:()=>model,prompts};
}
for(const fault of ['none','BO-revoked','no-preview-grant','human-control','no-inbox-grant','role','inactive-membership','foreign-ticket','synthetic','wrong-channel','signature','expired','foreign-response','changed-content','tool-failure','no-match','revoke-on-return'])test('actual Inbox Knowledge handler preserves ticket and separates staff authority/paid scope: '+fault,async()=>{
 const x=await setupInbox(fault);const marker=JSON.stringify(x.c.metadata_source),before=f.rows.messages.length;
 const r=await x.send('knowledge');
 if(['none','BO-revoked','no-preview-grant','human-control','no-match'].includes(fault)){assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.success,true);if(fault==='no-match')assert.equal(r.data.results.length,0);else assert(r.data.results.length>0,JSON.stringify(r));}
 else {assert(r.status>=400,JSON.stringify(r));assert.notEqual(r.data.failure?.code,'KB_NO_MATCH');assert.equal(r.data.success===true,false);if(['no-inbox-grant','role','inactive-membership','foreign-ticket','synthetic','wrong-channel','signature','expired'].includes(fault))assert.equal(x.posts(),0);}
 assert.equal(JSON.stringify(x.c.metadata_source),marker);assert.equal(f.rows.messages.length,before,'Inbox does not dispatch customer replies');assert.equal(f.rpc.length,0);
});
for(const fault of ['none','BO-revoked','human-control','assigned-agent','unassigned-agent','no-inbox-grant','no-assist','signature','no-match','tool-failure','invalid-policy'])test('actual Policy handler grounds evidence and refuses false compliant: '+fault,async()=>{
 const x=await setupInbox(fault);const r=await x.send('policy','DRAFT DISTINCT: Please check this text.');
 if(['none','BO-revoked','human-control'].includes(fault)){assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.result.status,'warning');assert(x.prompts.some(p=>p.includes('DRAFT DISTINCT')));assert(x.prompts.some(p=>p.includes('Isolated published subscription policy')));}
 else if(fault==='no-match'){assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.result.status,'insufficient_evidence');assert.equal(x.model(),0);}
 else {assert(r.status>=400,JSON.stringify(r));assert.notEqual(r.data.result?.status,'compliant');}
});
for(const fault of ['none','role-revoked','membership-revoked','channel-revoked','forged','foreign-conversation','operation'])test('opaque Inbox context rechecks revocation and cannot be serialized/spoofed: '+fault,async()=>{
 const x=await setupInbox();const token=await authenticatedInboxAuthority(f.db,f.user.id,x.c.company_id,x.c.id,'knowledge');
 if(fault==='role-revoked')f.rows.user_roles=[];
 if(fault==='membership-revoked')f.rows.company_membership[0].is_active=false;
 if(fault==='channel-revoked')f.rows.channel_config[0].is_active=false;
 if(fault==='operation'){const g=JSON.parse(f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION);g.bindings[0].operations=['policy'];f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION=JSON.stringify(g);}
 const meta={...x.meta,legacyAuthority:fault==='forged'?JSON.parse(JSON.stringify(token)):token,conversationId:fault==='foreign-conversation'?crypto.randomUUID():x.c.id};let error;
 try {await accountedModelFetch(f.db,meta,x.endpoint,{method:'POST',body:x.request},x.upstream,undefined,x.prepare);}catch(e){error=e;}
 if(fault==='none'){assert.equal(error,undefined);assert.equal(x.posts(),1);}else {assert(error);assert.equal(x.posts(),0);}
});

for(const fault of ['none','missing','duplicate','runtime','config','expired','signature','revoked'])test('standing permission consumes independently renewable signed evidence: '+fault,async()=>{
 const x=await setupInbox(fault==='expired'||fault==='signature'?fault:'none');
 const original=JSON.parse(f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION),b=original.bindings[0];
 const keys=['remote_mode','remote_runtime_sha256','deployment_evidence_sha256','embedding_config_sha256','lineage_evidence_sha256','attestation_payload','attestation_signature'];
 const record=Object.fromEntries(keys.map(k=>[k,b[k]]));record.reference_id='frankie-tenant34-query-embedding';
 for(const k of ['deployment_evidence_sha256','lineage_evidence_sha256','attestation_payload','attestation_signature'])delete b[k];
 b.evidence_reference=record.reference_id;
 f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION=JSON.stringify(original);
 if(fault==='runtime')record.remote_runtime_sha256='b'.repeat(64);
 if(fault==='config')record.embedding_config_sha256='c'.repeat(64);
 if(fault!=='missing')f.env.KB_QUERY_EMBEDDING_EVIDENCE_JSON=JSON.stringify({version:1,records:fault==='duplicate'?[record,record]:[record]});
 if(fault==='revoked')delete f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION;
 const unchanged=f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION,r=await x.send('knowledge');
 if(fault==='none'){assert.equal(r.status,200,JSON.stringify(r));assert(r.data.results.length);assert.equal(f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION,unchanged);}
 else {assert(r.status>=400,JSON.stringify(r));assert.equal(x.posts(),0);}
});
test('same opaque Inbox operation concurrent duplicate has at most one dispatch; unknown stays consumed in this isolate',async()=>{
 const x=await setupInbox();const token=await authenticatedInboxAuthority(f.db,f.user.id,x.c.company_id,x.c.id,'knowledge');const meta={...x.meta,legacyAuthority:token};
 const run=()=>accountedModelFetch(f.db,meta,x.endpoint,{method:'POST',body:x.request},x.upstream,undefined,x.prepare);
 const r=await Promise.allSettled([run(),run()]);assert.equal(r.filter(r=>r.status==='fulfilled').length,1);assert.equal(r.filter(r=>r.status==='rejected'&&r.reason.code==='INBOX_REPLAY_DENIED').length,1);assert.equal(x.posts(),1);await assert.rejects(run(),e=>e.code==='INBOX_REPLAY_DENIED');assert.equal(x.posts(),1);
});
test('Policy conversation and draft checks pass their distinct submitted input to the governed model',async()=>{
 const x=await setupInbox();for(const text of ['CONVERSATION INPUT: Please check these statements.','DRAFT INPUT: Please check this reply.']){const r=await x.send('policy',text);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.result.status,'warning');assert(x.prompts.some(p=>p.includes(text)));}
 assert.equal(x.posts(),2);assert.equal(f.rows.messages.filter(m=>m.role==='assistant').length,1,'no Inbox result sent to visitor');
});
test('omitting conversation cannot turn a manual Inbox request into legacy paid dispatch',async()=>{
 const x=await setupInbox();const r=await knowledgeHandler(new Request('https://isolated.invalid',{method:'POST',headers:{Authorization:'Bearer isolated',Origin:'https://console-chat-hub.lovable.app','Content-Type':'application/json'},body:JSON.stringify({query:'published subscription policy'})}));
 assert.equal(r.status,403,await r.clone().text());assert.equal((await r.json()).failure.code,'INBOX_CONVERSATION_REQUIRED');assert.equal(x.posts(),0);
});
test('Preview B-O and policy grant cannot fund a different authenticated staff tool',async()=>{
 const x=await setupInbox();const r=await policyHandler(new Request('https://isolated.invalid',{method:'POST',headers:{Authorization:'Bearer isolated',Origin:'https://console-chat-hub.lovable.app','Content-Type':'application/json'},body:JSON.stringify({tool_type:'grammar',conversation_id:x.c.id,content:'Please check this text.'})}));
 assert.equal(r.status,502);assert.equal(x.posts(),0);assert.equal(x.model(),0);
});
test('unknown Inbox network outcome cannot be replayed with the same opaque operation',async()=>{
 const x=await setupInbox();const token=await authenticatedInboxAuthority(f.db,f.user.id,x.c.company_id,x.c.id,'knowledge');const meta={...x.meta,legacyAuthority:token};let calls=0;
 const run=()=>accountedModelFetch(f.db,meta,x.endpoint,{method:'POST',body:x.request},async()=>{calls++;throw new TypeError('isolated unknown delivery');},undefined,x.prepare);
 await assert.rejects(run(),/isolated unknown delivery/);await assert.rejects(run(),e=>e.code==='INBOX_REPLAY_DENIED');assert.equal(calls,1);
});
test('assigned independent Agent can obtain only its own policy context; original owner markers are preserved',async()=>{
 const x=await setupInbox();const staff=crypto.randomUUID(),profile=crypto.randomUUID();f.rows.company_membership.push({user_id:staff,company_id:x.c.company_id,role:'agent',is_active:true});f.rows.agent_profile.push({id:profile,user_id:staff,status:'active',role:'agent'});x.c.assigned_agent_id=profile;x.c.status='pending';
 const token=await authenticatedInboxAuthority(f.db,staff,x.c.company_id,x.c.id,'policy');assert.equal(await trustedDispatchScope(f.db,x.c.company_id,x.c.id,token),'authenticated_inbox');assert.equal(x.c.metadata_source.owner_user_id,f.user.id);assert.equal(x.c.status,'pending');
 x.c.assigned_agent_id=crypto.randomUUID();await assert.rejects(trustedDispatchScope(f.db,x.c.company_id,x.c.id,token),e=>e.code==='INBOX_AUTHORITY_DENIED');assert.equal(x.posts(),0);
});

test('server jurisdiction unspecified cannot invent a specification topic; real specs still require grounded evidence',()=>{
 for(const text of ['Please check this policy.\nJurisdiction: unspecified','請檢查這份政策。\nJurisdiction: unspecified','请检查这份政策。\nJurisdiction: unspecified'])assert(!deriveCurrentGroundingTarget(text).topic_ids.includes('specification'));
 for(const text of ['What are the specs?','Show the specification.','請提供規格','请提供规格'])assert(deriveCurrentGroundingTarget(text).topic_ids.includes('specification'));
});

test('Policy profile revocation denies an already minted context without requiring a global role row',async()=>{
 const x=await setupInbox();f.rows.user_roles=[];const token=await authenticatedInboxAuthority(f.db,f.user.id,x.c.company_id,x.c.id,'policy');assert.equal(await trustedDispatchScope(f.db,x.c.company_id,x.c.id,token),'authenticated_inbox');f.rows.agent_profile[0].status='inactive';await assert.rejects(trustedDispatchScope(f.db,x.c.company_id,x.c.id,token),e=>e.code==='INBOX_AUTHORITY_DENIED');assert.equal(x.posts(),0);
});

test('evidence expiring during the final asynchronous role recheck denies before Inbox paid I/O',async()=>{
 const x=await setupInbox();const token=await authenticatedInboxAuthority(f.db,f.user.id,x.c.company_id,x.c.id,'knowledge');const meta={...x.meta,legacyAuthority:token};const originalNow=Date.now,from=f.db.from;let prepared=false;
 f.db.from=function(table){if(prepared&&table==='channel_config')Date.now=()=>originalNow()+600000;return from.call(this,table);};
 try{await assert.rejects(accountedModelFetch(f.db,meta,x.endpoint,{method:'POST',body:x.request},x.upstream,undefined,async(mode,permit)=>{const h=await x.prepare(mode,permit);prepared=true;return h;}),e=>e.code==='UAT_REMOTE_BOUND_UNVERIFIED');assert.equal(x.posts(),0);}finally{Date.now=originalNow;}
});

// Revised contract proposal: actual handler + dynamic authenticated Singapore
// metadata adapters. Isolated only; zero live model/KB calls and no Hosted PASS.
async function liveMetadataFixture(fault='none') {
 const x=await embeddingFixture();let sequence=1,posts=0,gets=0,docReads=0;
 const mode='query_embedding_live_metadata_v1',reference_id='frankie-live-metadata';
 const original=JSON.parse(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION).bindings[0];
 const binding=Object.fromEntries(['actor_id','company_id','channel_id','tenant_id','endpoint','provider','purpose'].map(k=>[k,original[k]]));
 Object.assign(binding,{remote_mode:mode,allow_remote_embedding:true,evidence_reference:reference_id});
 f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify({version:fault==='old-grant'?2:3,bindings:[binding]});
 f.env.KB_QUERY_EMBEDDING_EVIDENCE_JSON=JSON.stringify({version:2,records:[{reference_id,remote_mode:mode,metadata_tenant_id:'fixture-remote-tenant',metadata_api_contract:'singapore_entities_bearer_v1',accepted_remote_risk:fault==='no-risk-approval'?'not-approved':'unattested_runtime_cost_and_publication_race_v1',max_query_bytes:2048}]});
 f.env.KB_RAG_TENANT_TOKENS_JSON=JSON.stringify({'34':fault==='reuse-api-key'?x.secret:'isolated-existing-metadata-bearer'});
 if(fault==='no-bearer')delete f.env.KB_RAG_TENANT_TOKENS_JSON;
 if(fault==='human-control')x.c.status='pending';
 if(fault==='synthetic'){x.c.metadata_source.source='c3_uat_widget';x.c.metadata_source.synthetic=true;}
 if(fault==='cross-company')x.meta.companyId=ORIGINAL_PREVIEW_ACCOUNTS[1].company;
 if(fault==='foreign-actor'){const g=JSON.parse(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION);g.bindings[0].actor_id=crypto.randomUUID();f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify(g);}
 const doc=()=>({id:'dynamic-doc-'+sequence,company_id:34,tenant_id:'fixture-remote-tenant',name:'Current service policy',source_type:'policy',status:'published',available_to_live_console:true,production_vector_status:'indexed',active_version_id:'dynamic-version-'+sequence,content_hash:null});
 const content='Current subscription pause and service policy '+sequence;
 const hash=await fixtureDigest(content);
 const row=()=>({...doc(),content_hash:hash});
 const up=async(url,init)=>{
  const headers=new Headers(init.headers);assert.equal(init.redirect,'error');
  if(init.method==='POST'){
   posts++;assert.equal(String(url),x.endpoint);assert.equal(headers.get('x-api-key'),x.secret);assert.equal(headers.has('authorization'),false);
   if(fault==='revoke-after-dispatch')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
   if(fault==='no-match')return Response.json({success:true,context_found:false,selected_documents:[]});
   const hit={document_id:row().id,title:row().name,source_type:'policy',document_score:0.99,evidence:[{chunk_id:'dynamic-chunk-'+sequence,chunk_type:'full_content',content,score:0.99}]};
   if(fault==='payload-version')hit.version_id='other-version';
   if(fault==='wrong-content')hit.evidence[0].content='Unverified policy';
   if(fault==='duplicate-chunk')hit.evidence.push({...hit.evidence[0]});
   return Response.json({success:true,context_found:true,selected_documents:[hit],llm_context:{combined_text:'NEVER TRUST THIS'}});
  }
  gets++;assert.equal(init.method,'GET');assert.equal(headers.get('authorization'),'Bearer isolated-existing-metadata-bearer');assert.equal(headers.has('x-api-key'),false);assert.equal(headers.has('x-service-role-secret'),false);
  const u=new URL(url);assert.equal(u.origin,'https://py.ebixmall.com');assert(u.pathname.startsWith('/py-knowledge-base/api/entities/'));
  if(fault==='metadata-unauthorized')return Response.json({}, {status:403});
  if(fault==='revoke-preflight')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
  if(fault==='rotate-rag-key')f.env.KB_SINGAPORE_TENANT_API_KEYS_JSON=JSON.stringify({'34':'rotated'});
  if(fault==='rotate-bearer')f.env.KB_RAG_TENANT_TOKENS_JSON=JSON.stringify({'34':'rotated'});
  if(fault==='rotate-evidence')f.env.KB_QUERY_EMBEDDING_EVIDENCE_JSON='null';
  if(u.search&&!u.searchParams.has('q')){const d=row();if(fault==='preflight-foreign')d.company_id=35;return Response.json([d]);}
  let value;
  if(u.pathname.endsWith('/KBDocument')){
   docReads++;value=row();if(fault==='unpublished')value.status='draft';if(fault==='publication-race'&&docReads>1)value.active_version_id='changed-version';
  }else if(u.pathname.endsWith('/KBDocumentVersion')){
   value={id:row().active_version_id,document_id:row().id,company_id:34,tenant_id:'fixture-remote-tenant',content_hash:hash,raw_content_snapshot:content,review_status:'approved',vector_status:'generated'};
   if(fault==='unknown-version')delete value.id;
   if(fault==='python-published-shape'){value.review_status='pending';value.vector_status='not_generated';value.raw_content_snapshot=' \n'+content+'\u0085';}
   if(fault==='rejected-version')value.review_status='rejected';
   if(fault==='stale-hash')value.raw_content_snapshot='Stale source';
  }else{
   value={id:'dynamic-chunk-'+sequence,document_id:row().id,version_id:row().active_version_id,company_id:34,tenant_id:'fixture-remote-tenant',chunk_type:'full_content',chunk_text:content,environment:'production',status:'active',embedding_status:'generated',embedding_dimensions:768,embedding_vector:{values:Array(768).fill(0.1)}};
   if(fault==='stale-chunk-version')value.version_id='old';if(fault==='foreign-chunk')value.company_id=35;
   if(fault==='python-published-shape')value.chunk_text='\u0085'+content+' \n';
   if(fault==='bad-vector-shape')value.embedding_vector={values:[1]};
   if(fault==='wrong-metadata-tenant')value.tenant_id='foreign';if(fault==='staging-chunk')value.environment='staging';
  }
  return Response.json([value]);
 };
 return {...x,binding,up,posts:()=>posts,gets:()=>gets,next:()=>{sequence++;docReads=0;},prepare:async(mode,permit)=>await prepareRemoteRetrieval(x.c.company_id,'34',x.secret,x.endpoint,up,undefined,'kb',x.request,mode,permit)};
}
for(const fault of ['none','no-match','old-grant','no-risk-approval','reuse-api-key','metadata-unauthorized','preflight-foreign','revoke-preflight','rotate-rag-key','rotate-bearer','rotate-evidence','revoke-after-dispatch','payload-version','wrong-content','duplicate-chunk','unpublished','publication-race','unknown-version','stale-hash','stale-chunk-version','foreign-chunk','wrong-metadata-tenant','staging-chunk','no-bearer','human-control','synthetic','cross-company','foreign-actor','python-published-shape','rejected-version','bad-vector-shape'])test('dynamic Singapore metadata/full admission contract: '+fault,async()=>{
 const x=await liveMetadataFixture(fault);
 const action=()=>accountedModelFetch(f.db,x.meta,x.endpoint,{method:'POST',body:x.request,headers:{'x-api-key':x.secret}},x.up,undefined,x.prepare);
 if(['none','no-match','python-published-shape'].includes(fault)){
  const r=await action(),v=await r.json();assert.equal(v.context_found,fault!=='no-match');assert.equal(x.posts(),1);if(fault!=='no-match'){assert.equal(v.selected_documents[0].authority.version_id,'dynamic-version-1');assert.equal(v.llm_context,undefined);assert(x.gets()>=5);}
 }else{await assert.rejects(action,e=>e.code && e.code!=='KB_NO_MATCH');if(['old-grant','no-risk-approval','reuse-api-key','metadata-unauthorized','preflight-foreign','revoke-preflight','rotate-rag-key','rotate-bearer','rotate-evidence','no-bearer','human-control','synthetic','cross-company','foreign-actor'].includes(fault))assert.equal(x.posts(),0);}
});
test('dynamic metadata supports newly published documents beyond a fixed ten-document snapshot',async()=>{
 const x=await liveMetadataFixture();
 for(let n=1;n<=12;n++){const r=await accountedModelFetch(f.db,{...x.meta,operationId:'dynamic:'+crypto.randomUUID()},x.endpoint,{method:'POST',body:x.request,headers:{'x-api-key':x.secret}},x.up,undefined,x.prepare);const v=await r.json();assert.equal(v.selected_documents[0].authority.version_id,'dynamic-version-'+n);x.next();}
 assert.equal(x.posts(),12);
});
test('dynamic metadata canonical fetchKBRag preserves grounded version/source and safe failure classification',async()=>{
 const x=await liveMetadataFixture();globalThis.__c3KbClient=()=>f.db;globalThis.fetch=x.up;
 try{const scope=await resolveTenantScope(x.c.id,undefined,x.c.company_id);const r=await fetchKBRag({query:'Please explain the current subscription policy',top_k:3},scope.scope,resolveKBEndpoint(),{uatContext:{conversationId:x.c.id,operationId:'dynamic-parser:'+crypto.randomUUID()}});assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.documents[0].authority.version,'dynamic-version-1');assert.equal(r.documents[0].chunks[0].content.includes('subscription'),true);}finally{globalThis.fetch=realFetch;}
});
async function dynamicInboxFixture(fault='none'){
 const x=await liveMetadataFixture(fault);f.env.SUPABASE_SERVICE_ROLE_KEY=f.env.SUPABASE_SECRET_KEY;f.env.LLM_MODEL_ASSIST='gemini-2.5-flash';f.env.GOOGLE_SERVICE_ACCOUNT_JSON='{}';
 f.rows.user_roles=[{user_id:f.user.id,role:'admin'}];f.rows.agent_profile=[{id:crypto.randomUUID(),user_id:f.user.id,role:'admin',status:'active',display_name:'Isolated actor'}];f.rows.upstream_call_log=[];
 f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION=JSON.stringify({version:2,bindings:[{...x.binding,operations:['knowledge','policy'],allow_assist:true}]});
 if(fault==='inbox-revoked')delete f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION;
 if(fault==='agent-revoked')f.rows.agent_profile[0].status='inactive';
 const from=f.db.from;f.db.from=function(table){const q=from.call(this,table);q.in=()=>q;q.not=()=>q;return q;};f.db.auth={getUser:async()=>({data:{user:f.user},error:null})};globalThis.__c3InboxClient=()=>f.db;
 let models=0;const prompts=[];
 globalThis.fetch=async(url,init)=>{
  if(String(url)!==f.url)return await x.up(url,init);
  models++;const b=JSON.parse(init.body);const prompt=b.contents.flatMap(c=>c.parts.map(p=>p.text??'')).join('');prompts.push(prompt);
  const answer=prompt.includes('proposed_claims')?{grounded:!f.rejectAssistClaims,unsupported_claims:f.rejectAssistClaims?['unsupported fixture claim']:[],evidence_ids:['E1'],resolution:f.rejectAssistClaims?'unsupported':'supported'}:prompt.includes('Customer message:')?{suggestions:[{content:directorOriginalRag.selected_documents[0].evidence[0].content,tone_label:'Informative'}]}:prompt.includes('Text to check:')?{status:'warning',summary:'Isolated grounded assessment',issues:[{excerpt:'subscription',policy_label:'Evidence 1',severity:'warning'}]}:{queries:[]};
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(answer)}]}}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:20}});
 };
 const send=async(kind)=>{
  const body=kind==='knowledge'?{query:'current service policy',top_k:3,conversation_id:x.c.id}:{tool_type:'check_policy',conversation_id:x.c.id,content:kind==='draft'?'DRAFT UNIQUE: Please pause my subscription.':'CONVERSATION UNIQUE: Please pause my subscription.',context_mode:kind==='draft'?'draft':'conversation'};
  const response=await(kind==='knowledge'?knowledgeHandler:policyHandler)(new Request('https://isolated.invalid',{method:'POST',headers:{Authorization:'Bearer isolated',Origin:'https://console-chat-hub.lovable.app','Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:response.status,data:await response.json()};
 };
 return {...x,send,models:()=>models,prompts};
}
for(const kind of ['knowledge','conversation','draft'])for(const fault of ['none','no-match','metadata-unauthorized','wrong-content','inbox-revoked','agent-revoked'])test('actual dynamic metadata Inbox '+kind+': '+fault,async()=>{
 const x=await dynamicInboxFixture(fault);try{
  const r=await x.send(kind);
  if(fault==='none'){assert.equal(r.status,200,JSON.stringify(r));if(kind==='knowledge'){assert.equal(r.data.results?.[0]?.document_id,'dynamic-doc-1',JSON.stringify(r));assert.equal(r.data.results?.[0]?.content.includes('subscription'),true);}else{assert.equal(r.data.result.status,'warning');assert(x.prompts.some(p=>p.includes(kind==='draft'?'DRAFT UNIQUE':'CONVERSATION UNIQUE')));}}
  else if(fault==='no-match'){assert.equal(r.status,200,JSON.stringify(r));if(kind!=='knowledge'){assert.equal(r.data.result.status,'insufficient_evidence');assert.equal(x.models(),0);}}
  else if(fault==='agent-revoked'&&kind==='knowledge'){assert.equal(r.status,200,JSON.stringify(r));}
  else{assert(r.status>=400,JSON.stringify(r));assert.notEqual(r.data.result?.status,'compliant');assert.notEqual(r.data.failure?.code,'KB_NO_MATCH');}
 }finally{globalThis.fetch=realFetch;}
});
test('renewable signed evidence remains compatible inside revised mixed evidence settings',async()=>{
 const x=await embeddingFixture();const g=JSON.parse(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION),b=g.bindings[0];
 const keys=['remote_mode','remote_runtime_sha256','deployment_evidence_sha256','embedding_config_sha256','lineage_evidence_sha256','attestation_payload','attestation_signature'];
 const record=Object.fromEntries(keys.map(k=>[k,b[k]]));record.reference_id='existing-attestation';
 for(const k of ['deployment_evidence_sha256','lineage_evidence_sha256','attestation_payload','attestation_signature'])delete b[k];b.evidence_reference='existing-attestation';
 f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify(g);f.env.KB_QUERY_EMBEDDING_EVIDENCE_JSON=JSON.stringify({version:2,records:[record,{reference_id:'unrelated-preserved-record'}]});
 const r=await accountedModelFetch(f.db,x.meta,x.endpoint,{method:'POST',body:x.request},x.upstream,undefined,x.prepare);assert.equal(r.status,200);assert.equal(x.posts(),1);
});
test('dynamic permission does not consume, drop or rewrite unrelated standing bindings',async()=>{
 const x=await liveMetadataFixture();const g=JSON.parse(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION),other={...x.binding,actor_id:crypto.randomUUID(),company_id:crypto.randomUUID()};g.bindings.push(other);f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify(g);const before=f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
 const r=await accountedModelFetch(f.db,x.meta,x.endpoint,{method:'POST',body:x.request,headers:{'x-api-key':x.secret}},x.up,undefined,x.prepare);assert.equal(r.status,200);assert.equal(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION,before);assert.deepEqual(JSON.parse(before).bindings[1],other);
});

async function ragApiFixture(fault='none'){
 const x=await embeddingFixture(),base=JSON.parse(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION).bindings[0];
 const binding=Object.fromEntries(['actor_id','company_id','channel_id','tenant_id','endpoint','provider','purpose'].map(k=>[k,base[k]]));
 Object.assign(binding,{remote_mode:'query_embedding_rag_authority_v1',allow_remote_embedding:true,rag_api_contract:'singapore_rag_published_v1',accepted_remote_risk:'authenticated_rag_authority_no_independent_metadata_v1'});
 f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify({version:fault==='old-grant'?3:4,bindings:[binding]});
 delete f.env.KB_RAG_TENANT_TOKENS_JSON;delete f.env.KB_QUERY_EMBEDDING_EVIDENCE_JSON;
 if(fault==='grant-absent')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
 if(fault==='risk-not-approved'){const g=JSON.parse(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION);g.bindings[0].accepted_remote_risk='not-approved';f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify(g);}
 if(fault==='human-control')x.c.status='pending';
 if(fault==='foreign-actor')x.c.metadata_source.owner_user_id=crypto.randomUUID();
 if(fault==='synthetic'){x.c.metadata_source.source='c3_uat_widget';x.c.metadata_source.synthetic=true;}
 let posts=0;const requests=[];
 const up=async(url,init)=>{
  requests.push({url:String(url),method:init.method,query:JSON.parse(init.body).query});assert.equal(String(url),x.endpoint);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  const h=new Headers(init.headers);assert.equal(h.get('x-api-key'),x.secret);assert(!h.has('authorization'));assert(!h.has('x-service-role-secret'));posts++;
  if(fault==='http-denied')return Response.json({success:false},{status:403});
  if(fault==='tool-failure')return Response.json({success:false},{status:502});
  if(fault==='invalid-json')return new Response('not JSON');
  if(fault==='revoked')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
  if(fault==='rotate-key')f.env.KB_SINGAPORE_TENANT_API_KEYS_JSON=JSON.stringify({'34':'rotated'});
  if(fault==='remap')f.env.KB_SINGAPORE_TENANT_MAP_JSON=JSON.stringify({[x.c.company_id]:'35'});
  const content='Published service subscription: you may request a pause; eligibility requires review.';
  const part={document_id:'api-doc-'+posts,chunk_id:'api-chunk-'+posts,version_id:'api-version-'+posts,chunk_type:'full_content',content,score:0.99,content_sha256:await fixtureDigest(content)};
  const doc={document_id:part.document_id,title:'Current service policy',source_type:'policy',document_score:0.99,evidence:[part],authority:{tenant_id:'34',version_id:part.version_id,content_sha256:await fixtureDigest('Full current policy source'),publication_state:'published',currentness:'current'}};
  const data={success:true,company_id:34,authority_contract:'singapore_rag_published_v1',context_found:true,selected_documents:[doc],llm_context:{combined_text:'UNTRUSTED answer; never use as customer input'}};
  if(fault==='no-match'){data.context_found=false;data.selected_documents=[];}
  if(fault==='original-unversioned-response'){delete data.authority_contract;delete data.company_id;delete doc.authority;delete part.document_id;delete part.version_id;delete part.content_sha256;}
  if(fault==='missing-version')delete doc.authority.version_id;
  if(fault==='missing-currentness')delete doc.authority.currentness;
  if(fault==='draft')doc.authority.publication_state='draft';
  if(fault==='superseded')doc.authority.currentness='superseded';
  if(fault==='foreign-response')data.company_id=35;
  if(fault==='foreign-document')doc.authority.tenant_id='35';
  if(fault==='foreign-chunk')part.document_id='other-document';
  if(fault==='stale-chunk')part.version_id='old-version';
  if(fault==='tampered-content')part.content='Unsupported refund promise';
  if(fault==='duplicate-chunk')doc.evidence.push({...part});
  if(fault==='metadata-conflict')doc.metadata={currentness:'historical'};
  return Response.json(data);
 };
 return {...x,binding,up,posts:()=>posts,requests,prepare:async(mode,permit)=>prepareRemoteRetrieval(x.c.company_id,'34',x.secret,x.endpoint,up,undefined,'kb',x.request,mode,permit)};
}
test('server retrieval labels cannot become cross-line commerce entity identifiers',()=>{
 for(const input of ['pause subscription\nCanonical customer context: business','請暫停訂閱\nCanonical customer context: business','pause subscription\r\nJurisdiction: unspecified']){
  const t=deriveCurrentGroundingTarget(input);assert(!t.entity_ids.some(id=>/canonical|jurisdiction/i.test(id)),JSON.stringify(t));
 }
 for(const input of ['subscription ID SUB-123','order # ORD-456','訂閱編號 SUB-123'])assert(deriveCurrentGroundingTarget(input).entity_ids.some(id=>/123|456/.test(id)),input);
});
for(const fault of ['none','no-match','old-grant','grant-absent','risk-not-approved','human-control','foreign-actor','synthetic','http-denied','tool-failure','invalid-json','revoked','rotate-key','remap','original-unversioned-response','missing-version','missing-currentness','draft','superseded','foreign-response','foreign-document','foreign-chunk','stale-chunk','tampered-content','duplicate-chunk','metadata-conflict'])test('original RAG API authority / complete paid boundary: '+fault,async()=>{
 const x=await ragApiFixture(fault);const action=()=>accountedModelFetch(f.db,x.meta,x.endpoint,{method:'POST',body:x.request,headers:{'x-api-key':x.secret}},x.up,undefined,x.prepare);
 if(['none','no-match','http-denied','tool-failure'].includes(fault)){
  const r=await action();assert.equal(r.status,fault==='http-denied'?403:fault==='tool-failure'?502:200);if(r.ok){const v=await r.json();assert.equal(v.context_found,fault!=='no-match');assert.equal(v.llm_context,undefined);if(fault==='none')assert.equal(v.selected_documents[0].authority.version_id,'api-version-1');}assert.equal(x.posts(),1);
 }else{
  await assert.rejects(action,e=>e.code && e.code!=='KB_NO_MATCH');
  if(['old-grant','grant-absent','risk-not-approved','human-control','foreign-actor','synthetic'].includes(fault))assert.equal(x.posts(),0);
 }
 assert(x.requests.every(r=>r.method==='POST'&&r.url===x.endpoint),'no metadata GET or accounting endpoint');assert.equal(f.rpc.length,0,'no new accounting backend');
});
test('native RAG adapter retains exact lineage and distinguishes no-match from missing authority',async()=>{
 for(const fault of ['none','no-match','original-unversioned-response','http-denied']){
  const x=await ragApiFixture(fault),scope=await resolveTenantScope(x.c.id,undefined,x.c.company_id);globalThis.fetch=x.up;
  try{const result=await fetchKBRag({query:'A new service subscription policy',top_k:3},scope.scope,resolveKBEndpoint(),{uatContext:{conversationId:x.c.id,operationId:crypto.randomUUID()}});
   if(fault==='none'){assert(result.success,JSON.stringify(result));assert.equal(result.documents[0].authority.version,'api-version-1');assert.equal(result.documents[0].authority.currentness,'current');}
   else if(fault==='no-match'){assert(result.success);assert.equal(result.failure.code,'KB_NO_MATCH');}
   else{assert(!result.success);assert.equal(result.failure.code,'KB_TOOL_FAILURE');}
  }finally{globalThis.fetch=realFetch;}
 }
});
async function ragApiInboxFixture(fault='none'){
 const x=await ragApiFixture(fault);f.env.SUPABASE_SERVICE_ROLE_KEY=f.env.SUPABASE_SECRET_KEY;f.env.LLM_MODEL_ASSIST='gemini-2.5-flash';f.env.GOOGLE_SERVICE_ACCOUNT_JSON='{}';
 f.rows.user_roles=[{user_id:f.user.id,role:'admin'}];f.rows.agent_profile=[{id:crypto.randomUUID(),user_id:f.user.id,role:'admin',status:'active'}];f.rows.upstream_call_log=[];
 f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION=JSON.stringify({version:3,bindings:[{...x.binding,operations:['knowledge','policy'],allow_assist:true}]});
 if(fault==='inbox-grant-absent')delete f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION;
 if(fault==='role-revoked')f.rows.agent_profile[0].status='inactive';
 const from=f.db.from;f.db.from=function(table){const q=from.call(this,table);q.in=()=>q;q.not=()=>q;return q;};f.db.auth={getUser:async()=>({data:{user:f.user},error:null})};globalThis.__c3InboxClient=()=>f.db;
 let models=0;const prompts=[];globalThis.fetch=async(url,init)=>{if(String(url)!==f.url)return x.up(url,init);models++;const prompt=JSON.parse(init.body).contents.flatMap(c=>c.parts.map(p=>p.text??'')).join('');prompts.push(prompt);return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(prompt.includes('proposed_claims')?{grounded:!f.rejectAssistClaims,unsupported_claims:f.rejectAssistClaims?['unsupported fixture claim']:[],evidence_ids:['E1'],resolution:f.rejectAssistClaims?'unsupported':'supported'}:prompt.includes('Customer message:')?{suggestions:[{content:directorOriginalRag.selected_documents[0].evidence[0].content,tone_label:'Informative'}]}:prompt.includes('Text to check:')?{status:'warning',summary:'Source-backed policy review',issues:[{excerpt:'subscription',policy_label:'Evidence 1',severity:'warning'}]}:{queries:[]})}]}}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:20}});};
 const send=async(kind)=>{const body=kind==='knowledge'?{query:'published service policy',top_k:3,conversation_id:x.c.id}:{tool_type:'check_policy',conversation_id:x.c.id,content:kind==='draft'?'DRAFT: pause subscription':'CONVERSATION: pause subscription',context_mode:kind==='draft'?'draft':'conversation'};const r=await(kind==='knowledge'?knowledgeHandler:policyHandler)(new Request('https://isolated.invalid',{method:'POST',headers:{Authorization:'Bearer isolated',Origin:'https://console-chat-hub.lovable.app','Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:r.status,data:await r.json()};};return {...x,send,models:()=>models,prompts};
}
test('KB diagnostics redact untrusted labels and never consume bodies or alter failures',async()=>{
 const saved=console.log,events=[];
 try{
  console.log=value=>events.push(JSON.parse(value));
  const d=createKBStageDiagnostics('PRIVATE-QUERY-AND-SECRET');
  const response=new Response('PRIVATE-BODY');assert.equal(await d.run('response_decode',async()=>response),response);assert.equal(await response.text(),'PRIVATE-BODY');
  d.event('auth','complete',{code:'PRIVATE-ERROR',url:'PRIVATE-URL',http_status:200});
  assert(!JSON.stringify(events).includes('PRIVATE-'));assert(events.every(e=>e.http_status===undefined || e.http_status===200));
  console.log=()=>{throw Error('logger unavailable');};
  const marker={same:true};assert.equal(await d.run('auth',async()=>marker),marker);
  const error=new Error('original failure');await assert.rejects(()=>d.run('auth',async()=>{throw error;}),e=>e===error);
  const hostile={get code(){throw Error('unsafe diagnostic property');}};await assert.rejects(()=>d.run('auth',async()=>{throw hostile;}),e=>e===hostile);
 }finally{console.log=saved;}
});
// Reproduce ambiguous 504s through the complete original handler, without a
// Visitor sourceMessageId, a live provider or a shortened production deadline.
for(const fault of ['none','admission-denied','transport-timeout','binding-timeout','invalid-json','preparation-timeout'])test('C4 504 stage evidence without source message: '+fault,async()=>{
 const x=await (fault==='preparation-timeout'?dynamicInboxFixture():ragApiInboxFixture());
 const upstream=globalThis.fetch,originalLog=console.log,events=[];let actualRagPosts=0,preparationCalls=0;
 console.log=(...args)=>{for(const a of args){try{const row=JSON.parse(a);if(row.endpoint==='kb-stage')events.push(row);}catch{}}};
 const pending=signal=>new Promise((resolve,reject)=>{const abort=()=>reject(new DOMException('PRIVATE-PROVIDER-SECRET','AbortError'));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
 globalThis.fetch=async(url,init)=>{
  if(String(url)===x.endpoint){actualRagPosts++;
   if(fault==='transport-timeout')return await pending(init.signal);
   if(fault==='binding-timeout')return new Response(new ReadableStream({start(c){init.signal.addEventListener('abort',()=>c.error(new DOMException('PRIVATE-PROVIDER-SECRET','AbortError')),{once:true});}}),{status:200});
   if(fault==='invalid-json')return new Response('{PRIVATE-PROVIDER-SECRET',{status:200});
  }else if(fault==='preparation-timeout' && init.method==='GET'){preparationCalls++;return await pending(init.signal);}
  return upstream(url,init);
 };
 if(fault==='admission-denied')delete f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION;
 try{
  const result=await x.send('knowledge');
  for(const stage of ['auth','membership','tenant_scope','inbox_admission','credential','accounting_admission'])assert(events.some(e=>e.stage===stage),stage);
  if(fault==='none'){assert.equal(result.status,200);assert(result.data.results.length);for(const stage of ['remote_preparation','rag_transport','response_binding','response_decode','authority_validation','expansion','rerank'])assert(events.some(e=>e.stage===stage&&e.outcome==='complete'),stage);}
  if(fault.endsWith('timeout')){assert.equal(result.status,504,JSON.stringify(result));assert.equal(result.data.error,'kb_api_timeout');const stage=fault==='preparation-timeout'?'remote_preparation':fault==='binding-timeout'?'response_binding':'rag_transport';assert(events.some(e=>e.stage===stage&&e.outcome==='abort'),JSON.stringify(events));assert.equal(x.models(),0,'no expansion/rerank after timeout');assert.equal(actualRagPosts,fault==='preparation-timeout'?0:1);if(fault==='preparation-timeout')assert.equal(preparationCalls,1);}
  if(fault==='admission-denied'){assert.equal(result.status,403);assert.equal(actualRagPosts,0);assert(!events.some(e=>e.stage==='rag_transport'));}
  if(fault==='invalid-json'){assert.equal(result.status,502);assert.notEqual(result.data.failure?.code,'KB_NO_MATCH');assert(events.some(e=>e.stage==='response_decode'&&e.outcome==='error'));}
  for(const secret of [x.secret,'PRIVATE-PROVIDER-SECRET','published service policy','current service policy','Bearer isolated'])assert(!JSON.stringify(events).includes(secret),'trace leaked '+secret);
  assert(events.every(e=>Object.keys(e).every(k=>['endpoint','request_id','stage','outcome','elapsed_ms','duration_ms','http_status','call','timeout_ms','code'].includes(k))));
 }finally{console.log=originalLog;globalThis.fetch=realFetch;}
});
for(const kind of ['knowledge','conversation','draft'])for(const fault of ['none','no-match','original-unversioned-response','http-denied','tampered-content','inbox-grant-absent'])test('complete Inbox native RAG '+kind+': '+fault,async()=>{
 const x=await ragApiInboxFixture(fault);try{const r=await x.send(kind);
  if(fault==='none'){assert.equal(r.status,200,JSON.stringify(r));if(kind==='knowledge')assert.equal(r.data.results?.[0]?.document_id,'api-doc-1');else{assert.equal(r.data.result.status,'warning',JSON.stringify({r,requests:x.requests,targets:x.requests.map(r=>deriveCurrentGroundingTarget(r.query))}));assert(x.prompts.some(p=>p.includes(kind==='draft'?'DRAFT:':'CONVERSATION:')));}}
  else if(fault==='no-match'){assert.equal(r.status,200,JSON.stringify(r));if(kind!=='knowledge'){assert.equal(r.data.result.status,'insufficient_evidence');assert.equal(x.models(),0);}}
  else{assert(r.status>=400,JSON.stringify(r));assert.notEqual(r.data.result?.status,'compliant');assert.notEqual(r.data.failure?.code,'KB_NO_MATCH');}
 }finally{globalThis.fetch=realFetch;}
});
test('native RAG same-ticket supplementary clues perform a new request with new returned document authority',async()=>{
 const x=await ragApiFixture(),scope=await resolveTenantScope(x.c.id,undefined,x.c.company_id);globalThis.fetch=x.up;
 try{for(const query of ['service pause','service pause after renewal clarification']){const r=await fetchKBRag({query,top_k:3},scope.scope,resolveKBEndpoint(),{uatContext:{conversationId:x.c.id,operationId:crypto.randomUUID()}});assert(r.success,JSON.stringify(r));assert.equal(r.documents[0].authority.version,'api-version-'+x.posts());}assert.equal(x.posts(),2);assert(x.requests.every(r=>r.method==='POST'));}finally{globalThis.fetch=realFetch;}
});
test('native API paid permit is one-use under concurrent consumption; preparation cannot replace the bound credential',async()=>{
 const x=await ragApiFixture(),permit=await authorizeOriginalPreviewKB(f.db,x.meta,x.endpoint,{method:'POST',body:x.request,headers:{'x-api-key':x.secret}});assert(permit);
 await x.prepare('authenticated_preview',permit);assert.equal(x.posts(),0);
 const outcomes=await Promise.all([Promise.resolve().then(()=>consumeOriginalPreviewKBPermit(permit)),Promise.resolve().then(()=>consumeOriginalPreviewKBPermit(permit))]);assert.equal(outcomes.filter(Boolean).length,1);assert(!consumeOriginalPreviewKBPermit(permit));
 await assert.rejects(()=>accountedModelFetch(f.db,{...x.meta,operationId:crypto.randomUUID()},x.endpoint,{method:'POST',body:x.request,headers:{'x-api-key':x.secret}},x.up,undefined,async(mode,p)=>{await x.prepare(mode,p);return {'x-api-key':'other-company-key'};}),e=>e.code==='UAT_REMOTE_BOUND_UNVERIFIED');assert.equal(x.posts(),0);
});

const directorOriginalRag=JSON.parse(readFileSync(new URL('./fixtures/director-original-rag-response.json',import.meta.url),'utf8'));
test('original Widget readiness reflects the same server grant/mapping/endpoint/key configuration as dispatch, without remote I/O or a KB success claim',async()=>{
 const x=await ragApiFixture();
 const baseline={provider:f.provider,transport:f.transport.length,writes:f.writes};
 const r=await request({action:'readiness'});assert.equal(r.status,200);assert.equal(r.data.execution_ready,true);assert.equal(r.data.remote_ready,true);
 assert.equal(r.data.remote_admission,'configuration_ready');assert.equal(r.data.remote_readiness_basis,'server_configuration_only');assert.equal(r.data.kb_retrieval_verified,false);
 assert.equal(x.posts(),0);assert.equal(f.provider,baseline.provider);assert.equal(f.transport.length,baseline.transport);assert.equal(f.writes,baseline.writes);
 const text=JSON.stringify(r);assert(!text.includes(x.secret));assert(!text.includes(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION));
});
for(const [fault,expected,mutate] of [
 ['missing-grant','authorization_absent',()=>delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION],
 ['invalid-grant','authorization_invalid',()=>f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION='{broken'],
 ['duplicate-binding','scope_denied',()=>{const g=JSON.parse(f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION);g.bindings.push(g.bindings[0]);f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify(g);}],
 ['remapped-tenant','tenant_mapping_unverified',()=>f.env.KB_SINGAPORE_TENANT_MAP_JSON=JSON.stringify({[f.account.company]:'35'})],
 ['coerced-tenant','tenant_mapping_unverified',()=>f.env.KB_SINGAPORE_TENANT_MAP_JSON=JSON.stringify({[f.account.company]:[34]})],
 ['invalid-map-row','tenant_mapping_unverified',()=>f.env.KB_SINGAPORE_TENANT_MAP_JSON=JSON.stringify({[f.account.company]:'34',other:34})],
 ['missing-key','credential_unavailable',()=>delete f.env.KB_SINGAPORE_TENANT_API_KEYS_JSON],
 ['invalid-key-row','credential_unavailable',()=>f.env.KB_SINGAPORE_TENANT_API_KEYS_JSON=JSON.stringify({'34':'isolated-scope-key',other:34})],
 ['changed-endpoint','endpoint_unverified',()=>f.env.KB_RAG_ENDPOINT='https://not-authorized.invalid/api/v1/rag/context-search'],
 ['wrong-header','endpoint_unverified',()=>f.env.KB_SINGAPORE_API_KEY_HEADER='authorization'],
])test('readiness immediately reflects '+fault+' without granting paid dispatch',async()=>{
 const x=await ragApiFixture();const ready=await request({action:'readiness'});assert.equal(ready.data.remote_ready,true);
 mutate();const denied=await request({action:'readiness'});assert.equal(denied.data.execution_ready,true,'KB config must not revoke independently valid original Vertex authority');
 assert.equal(denied.data.remote_ready,false);assert.equal(denied.data.remote_admission,expected);assert.equal(denied.data.kb_retrieval_verified,false);assert.equal(x.posts(),0);
 await assert.rejects(()=>accountedModelFetch(f.db,x.meta,x.endpoint,{method:'POST',body:x.request,headers:{'x-api-key':x.secret}},x.up,undefined,x.prepare));assert.equal(x.posts(),0);
});
test('configuration readiness cannot mint authority for a cross-actor or human-controlled ticket',async()=>{
 for(const fault of ['foreign-actor','human-control','synthetic']){
  const x=await ragApiFixture(fault);const r=await request({action:'readiness'});assert.equal(r.data.remote_ready,true,'this is only configuration scope, not ticket permission');
  await assert.rejects(()=>accountedModelFetch(f.db,x.meta,x.endpoint,{method:'POST',body:x.request,headers:{'x-api-key':x.secret}},x.up,undefined,x.prepare));assert.equal(x.posts(),0);
 }
});
async function originalAggregationFixture(fault='none',inbox=false,responseFixture=directorOriginalRag){
 const x=inbox?await ragApiInboxFixture():await ragApiFixture();
 const binding={...x.binding,rag_api_contract:'singapore_rag_aggregation_v1',accepted_remote_risk:'authenticated_tenant_rag_filter_unversioned_v1'};
 f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify({version:4,bindings:[binding]});
 if(inbox)f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION=JSON.stringify({version:3,bindings:[{...binding,operations:['knowledge','policy'],allow_assist:true}]});
 if(fault==='grant-absent')delete f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION;
 if(fault==='inbox-absent')delete f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION;
 if(fault==='old-risk'){binding.accepted_remote_risk='authenticated_rag_authority_no_independent_metadata_v1';f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify({version:4,bindings:[binding]});}
 if(fault==='human-control')x.c.status='pending';
 if(fault==='foreign-actor')x.c.metadata_source.owner_user_id=crypto.randomUUID();
 let posts=0;const queries=[],vertex=inbox?globalThis.fetch:null;
 const up=async(url,init)=>{
  if(String(url)===f.url && vertex){
   const request=JSON.parse(init.body);
   if(request.systemInstruction?.parts?.some(p=>p.text?.includes('multilingual relevance judge'))){assert(request.contents.some(c=>c.parts.some(p=>p.text?.includes('四電一腦'))));if(fault==='rerank-provider-error')return Response.json({error:{message:'isolated provider failure'}},{status:400});return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({relevant:true,confidence:0.96})}]}}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:20}});}
   return vertex(url,init);
  }
  assert.equal(String(url),x.endpoint);assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('x-api-key'),x.secret);assert(!new Headers(init.headers).has('authorization'));
  posts++;queries.push(JSON.parse(init.body).query);
  if(fault==='401'||fault==='403')return Response.json({success:false},{status:Number(fault)});
  if(fault==='timeout')throw new DOMException('isolated','AbortError');
  if(fault==='invalid-json')return new Response('{broken');
  if(fault==='oversized')return new Response(' '.repeat(2_000_001));
  if(fault==='empty-body')return new Response(null);
  if(fault==='revoke')delete f.env[inbox?'AUTHENTICATED_INBOX_KB_AUTHORIZATION':'ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION'];
  const data=structuredClone(responseFixture),doc=data.selected_documents[0],chunk=doc.evidence[0];
  if(fault==='no-match')return Response.json({success:true,context_found:false,selected_documents:[],citations:[]});
  if(fault==='foreign-response')data.company_id=35;
  if(fault==='foreign-document')doc.authority={tenant_id:'35'};
  if(fault==='foreign-chunk')chunk.tenant_id=35;
  if(fault==='draft')doc.authority={publication_state:'draft'};
  if(fault==='active-document')doc.status='active';
  if(fault==='staging-chunk')chunk.environment='staging';
  if(fault==='foreign-meta')data.meta.company_id=35;
  if(fault==='superseded')doc.authority={currentness:'superseded'};
  if(fault==='version-conflict'){doc.authority={version_id:'current-version'};chunk.version_id='old-version';}
  if(fault==='content-hash-conflict')chunk.content_sha256='a'.repeat(64);
  if(fault==='citation-conflict')data.citations[0].document_id='foreign-doc';
  if(fault==='chunk-conflict')chunk.document_id='foreign-doc';
  return Response.json(data);
 };
 if(inbox)globalThis.fetch=up;
 const search=async(query='什麼是四電一腦？')=>{
  globalThis.fetch=up;const scope=await resolveTenantScope(x.c.id,undefined,x.c.company_id);
  return fetchKBRag({query,top_k:3},scope.scope,resolveKBEndpoint(),{uatContext:{conversationId:x.c.id,operationId:crypto.randomUUID()}});
 };
 const send=async(kind,query='什麼是四電一腦？')=>{
  const body=kind==='knowledge'?{query,top_k:3,conversation_id:x.c.id}:['helper','manual-policy','manual-suggest'].includes(kind)?{tool_type:kind==='helper'?'knowledge_helper':kind==='manual-suggest'?'suggest_reply':'check_policy',conversation_id:x.c.id,content:query,context_mode:'manual'}:{tool_type:'check_policy',conversation_id:x.c.id,content:kind==='draft'?'DRAFT: 四電一腦免費除舊服務須知':'CONVERSATION: 四電一腦免費除舊服務須知',context_mode:kind==='draft'?'draft':'conversation'};
  const r=await(kind==='knowledge'?knowledgeHandler:policyHandler)(new Request('https://isolated.invalid',{method:'POST',headers:{Authorization:'Bearer isolated',Origin:'https://console-chat-hub.lovable.app','Content-Type':'application/json'},body:JSON.stringify(body)}));return {status:r.status,data:await r.json()};
 };
 return {...x,binding,up,search,send,posts:()=>posts,queries};
}
test('Director original sample is retained unchanged including missing fields and low relevance',()=>{
 assert.equal(directorOriginalRag.selected_documents[0].document_id,'c8db6f2c410a4be0af56e955117320ff');
 assert.equal(directorOriginalRag.citations[0].relevance,'low');
 for(const k of ['authority_contract','company_id'])assert(!Object.hasOwn(directorOriginalRag,k));
 assert(!Object.hasOwn(directorOriginalRag.selected_documents[0],'authority'));
});

for(const [question,label] of [
 ['香港四電一腦回收計劃係點運作？','policy.hong kong waste electrical and electronic equipment recycling programme.how it works'],
 ['四電一腦係咩？','regulated equipment definition'],
 ['四電一腦包括邊幾類電器？','equipment categories'],
])test('v244 free English facet is not a Chinese evidence taxonomy: '+question,async()=>{
 const x=await originalAggregationFixture();try{
  const r=await x.search(question);assert(r.success);
  const options={requestText:question,currentTurnText:question,semanticFactDescriptions:[label],expectedTenantId:'34',expectedRegion:'hong_kong',minScore:0.45};
  const g=selectCanonicalGrounding(r.documents,options);
  assert.equal(g.document?.document_id,directorOriginalRag.selected_documents[0].document_id,JSON.stringify(g));
  assert.equal(g.authority_decision.provenance.currentness,'unknown');
  assert.equal(selectCanonicalGrounding(r.documents,{...options,expectedTopicIds:['unrelated_canonical_topic']}).document,null,'free descriptions never override a canonical topic requirement');
  r.documents[0].authority.regions=['HK'];assert(selectCanonicalGrounding(r.documents,options).document);
  r.documents[0].authority.regions=['Singapore'];assert.equal(selectCanonicalGrounding(r.documents,options).document,null);
  r.documents[0].authority.regions=[];
  const d=r.documents[0];d.llm_context.full_content_evidence.forEach(e=>e.content='香港軟件月租服務，與本次查詢沒有同一主題。');
  assert.equal(selectCanonicalGrounding(r.documents,options).document,null,'title and summary cannot establish the subject');
 }finally{globalThis.fetch=realFetch;}
});

for(const [subject,question] of [
 ['循環器材','循環器材係點運作？'],['醫療運送','醫療運送包括邊啲？'],['cloud tenancy','How does cloud tenancy work?'],
])test('generic subject binding across free semantic facets: '+subject,async()=>{
 const sample=JSON.parse(JSON.stringify(directorOriginalRag).replaceAll('四電一腦',subject));
 const x=await originalAggregationFixture('none',false,sample);try{
  const r=await x.search(question);const opts={requestText:question,semanticFactDescriptions:['abstract English operation label'],expectedTenantId:'34'};
  assert(selectCanonicalGrounding(r.documents,opts).document);
  assert.equal(selectCanonicalGrounding(r.documents,{...opts,expectedTenantId:'35'}).document,null);
  assert.equal(selectCanonicalGrounding(r.documents,{...opts,expectedRegion:'singapore'}).document,null);
  // Canonical IDs supplied by a server contract retain exact authority checks.
  assert.equal(selectCanonicalGrounding(r.documents,{...opts,requestText:'Unrelated named subject?',semanticFactDescriptions:[],expectedTopicIds:['unrelated_canonical_topic']}).document,null);
 }finally{globalThis.fetch=realFetch;}
});

test('subject in a discarded chunk cannot authorize the unrelated surviving generation evidence',async()=>{
 const x=await originalAggregationFixture();try{
  const r=await x.search(),d=r.documents[0],e=d.llm_context.full_content_evidence[0],c=d.chunks.find(c=>c.chunk_type==='full_content');
  e.score=c.score=0.001;
  const other={...e,chunk_id:'separate-unrelated-chunk',content:'香港軟件月租收費資料。',score:0.99};
  d.llm_context.full_content_evidence.push(other);d.chunks.push({...c,...other,chunk_type:'full_content',status:'unknown'});
  const g=selectCanonicalGrounding(r.documents,{requestText:'香港四電一腦回收計劃係點運作？',semanticFactDescriptions:['how it works'],expectedTenantId:'34',minScore:0.45});
  assert.equal(g.document,null,JSON.stringify(g));
 }finally{globalThis.fetch=realFetch;}
});

test('source quote is not an alias for an unsupported subject qualifier',async()=>{
 const sample=JSON.parse(JSON.stringify(directorOriginalRag).replaceAll('四電一腦','Harbor Care'));sample.selected_documents[0].evidence[0].content='"Harbor Care" provides inspection and collection.';
 const x=await originalAggregationFixture('none',false,sample);try{const r=await x.search();assert.equal(selectCanonicalGrounding(r.documents,{requestText:'How does Harbor Care Premium work?',semanticFactDescriptions:['how it works'],expectedTenantId:'34'}).document,null);assert(selectCanonicalGrounding(r.documents,{requestText:'How does Harbor Care work?',semanticFactDescriptions:['how it works'],expectedTenantId:'34'}).document);}finally{globalThis.fetch=realFetch;}
});

test('unknown metadata without authenticated service proof cannot be promoted to current',async()=>{
 const x=await originalAggregationFixture();try{const r=await x.search(),forged=structuredClone(r.documents);forged[0].authority.publication_state='published';forged[0].authority.currentness='unknown';for(const c of forged[0].chunks)c.status='published';
  const selected=selectCanonicalGrounding(forged,{requestText:'什麼是四電一腦？',expectedTenantId:'34'});assert.equal(selected.document,null,JSON.stringify(selected));
  const genuine=selectCanonicalGrounding(r.documents,{requestText:'什麼是四電一腦？',expectedTenantId:'34'});assert(genuine.document);assert.equal(genuine.authority_decision.provenance.currentness,'unknown');
 }finally{globalThis.fetch=realFetch;}
});
for(const fault of ['none','no-match','401','403','timeout','invalid-json','foreign-response','foreign-document','foreign-chunk','draft','active-document','staging-chunk','foreign-meta','superseded','version-conflict','content-hash-conflict','citation-conflict','chunk-conflict','revoke','grant-absent','old-risk','human-control','foreign-actor'])test('original unmodified aggregation complete adapter: '+fault,async()=>{
 const x=await originalAggregationFixture(fault);try{
  const r=await x.search();
  if(fault==='none'){assert(r.success,JSON.stringify(r));const d=r.documents[0];assert.equal(d.authority.version,null);assert.equal(d.authority.currentness,'unknown');assert.equal(d.authority.publication_state,null);assert.equal(d.chunks[0].status,'unknown');assert.equal(d.citations[0].retrieval_relevance,'low');assert.equal(d.llm_context.full_content_evidence[0].content,directorOriginalRag.selected_documents[0].evidence[0].content);}
  else if(fault==='no-match'){assert(r.success);assert.equal(r.failure.code,'KB_NO_MATCH');}
  else{assert(!r.success,JSON.stringify(r));assert.notEqual(r.failure?.code,'KB_NO_MATCH');}
  assert.equal(x.posts(),['grant-absent','old-risk','human-control','foreign-actor'].includes(fault)?0:1);
 }finally{globalThis.fetch=realFetch;}
});
for(const kind of ['knowledge','conversation','draft'])for(const fault of ['none','no-match','foreign-response','draft','superseded','403','inbox-absent','revoke'])test('Director original JSON through actual Inbox '+kind+': '+fault,async()=>{
 const x=await originalAggregationFixture(fault,true);try{
  const r=await x.send(kind);
  if(fault==='none'){assert.equal(r.status,200,JSON.stringify(r));if(kind==='knowledge')assert.equal(r.data.results?.[0]?.document_id,directorOriginalRag.selected_documents[0].document_id,JSON.stringify(r));else{assert.equal(r.data.result.status,'warning',JSON.stringify(r));assert(x.prompts.some(p=>p.includes(kind==='draft'?'DRAFT:':'CONVERSATION:')));}}
  else if(fault==='no-match'){assert.equal(r.status,200,JSON.stringify(r));if(kind!=='knowledge'){assert.equal(r.data.result.status,'insufficient_evidence');assert.equal(x.models(),0);}}
  else{assert(r.status>=400,JSON.stringify(r));assert.notEqual(r.data.result?.status,'compliant');assert.notEqual(r.data.failure?.code,'KB_NO_MATCH');}
 }finally{globalThis.fetch=realFetch;}
});
test('same-ticket original aggregation actually requeries supplementary, correction and cancellation clues',async()=>{
 const x=await originalAggregationFixture();try{for(const query of ['四電一腦：洗衣機','更正，是雪櫃，不是洗衣機','取消雪櫃；暫緩訂閱服務，請查取消政策']){const r=await x.search(query);assert(r.success,JSON.stringify(r));}assert.equal(x.posts(),3);assert.deepEqual(x.queries,['四電一腦：洗衣機','更正，是雪櫃，不是洗衣機','取消雪櫃；暫緩訂閱服務，請查取消政策']);}finally{globalThis.fetch=realFetch;}
});
test('original low result needs actual contextual support and cannot spoof source eligibility after serialization',async()=>{
 const x=await originalAggregationFixture();try{
  const r=await x.search();assert(r.success);
  const supported=selectCanonicalGrounding(r.documents,{requestText:'什麼是四電一腦？',expectedTenantId:'34',requiresCurrentKb:true});assert(supported.ok);assert.equal(supported.document.document_id,directorOriginalRag.selected_documents[0].document_id);assert.equal(supported.authority_decision.provenance.currentness,'unknown');assert.equal(supported.authority_decision.provenance.version,null);
  const unrelated=selectCanonicalGrounding(r.documents,{requestText:'What is the monthly rental price for software subscription?',expectedTenantId:'34'});assert.equal(unrelated.document,null);
  const forged=JSON.parse(JSON.stringify(r.documents));forged[0].source_assurance={contract:'singapore_rag_aggregation_v1',tenant:'34'};const untrusted=selectCanonicalGrounding(forged,{requestText:'什麼是四電一腦？',expectedTenantId:'34'});assert.equal(untrusted.document,null);
 }finally{globalThis.fetch=realFetch;}
});

for(const label of ['definition of 四電一腦','meaning of 四電一腦','四電一腦 definition','四電一腦的定義'])test('actual v240 wrong_topic regression: request-bound descriptive fact label '+label,async()=>{
 const x=await originalAggregationFixture();try{
  const r=await x.search();assert(r.success);
  const selected=selectCanonicalGrounding(r.documents,{requestText:'什麼是四電一腦？',currentTurnText:'什麼是四電一腦？',expectedTopicIds:[label],expectedTenantId:'34',minScore:0.45});
  assert.equal(selected.document?.document_id,directorOriginalRag.selected_documents[0].document_id,JSON.stringify(selected.authority_decision));
  assert.equal(selected.authority_decision.provenance.currentness,'unknown');assert.equal(selected.authority_decision.provenance.version,null);
  assert(selected.evidence.some(e=>e.chunk_id==='2ff14f99973c4f2eb1caa5454310f8ee'));
  for(const wrong of ['definition of software rental','definition of 電腦','definition of current information']){
   const rejected=selectCanonicalGrounding(r.documents,{requestText:'什麼是四電一腦？',expectedTopicIds:[wrong],expectedTenantId:'34',minScore:0.45});
   assert.equal(rejected.document,null,wrong);
  }
  assert.equal(selectCanonicalGrounding(r.documents,{requestText:'什麼是四電一腦？',expectedTopicIds:[label],expectedTenantId:'35'}).document,null);
 }finally{globalThis.fetch=realFetch;}
});

for(const [subject,question,label] of [
 ['circular economy','What is circular economy?','definition of circular economy'],
 ['cloud tenancy','Please explain cloud tenancy.','meaning of cloud tenancy'],
 ['循環經濟','何謂循環經濟？','循環經濟的定義'],
])test('descriptive fact binding is generic and needs actual full evidence: '+subject,async()=>{
 const sample=JSON.parse(JSON.stringify(directorOriginalRag).replaceAll('四電一腦',subject));
 const x=await originalAggregationFixture('none',false,sample);try{
  const r=await x.search(question);assert(r.success);
  const options={requestText:question,currentTurnText:question,expectedTopicIds:[label],expectedTenantId:'34',minScore:0.45};
  const selected=selectCanonicalGrounding(r.documents,options);assert(selected.document,JSON.stringify(selected.authority_decision));
  // A title/summary match cannot substitute for a subject absent in the body.
  const doc=r.documents[0];doc.llm_context.full_content_evidence.forEach(e=>e.content='Unrelated published body without that subject.');
  assert.equal(selectCanonicalGrounding(r.documents,options).document,null);
 }finally{globalThis.fetch=realFetch;}
});

for(const [fault,family,stage] of [['invalid-json','validation_failure','decode'],['foreign-response','validation_failure','canonical_validation'],['draft','validation_failure','canonical_validation'],['403','denied','provider_http'],['timeout','service_failure','timeout'],['inbox-absent','denied','admission']])test('actual Inbox failure envelope preserves closed family instead of collapsing to unavailable: '+fault,async()=>{
 const x=await originalAggregationFixture(fault,true);try{
  const r=await x.send('knowledge');assert(r.status>=400,JSON.stringify(r));assert.equal(r.data.knowledge_state,family,JSON.stringify(r));
  if(['invalid-json','foreign-response','draft'].includes(fault))assert.equal(r.data.failure.stage,stage);
  const context=Response.json(r.data,{status:r.status});assert.equal(await knowledgeFailureState(null,{context}),family);assert.equal(context.bodyUsed,false);
  assert(!JSON.stringify(r.data).includes(x.secret));assert(!Object.hasOwn(r.data,'results'));
 }finally{globalThis.fetch=realFetch;}
});
test('Knowledge UI response parser separates success/no-match from service, access, setup and evidence faults without raw error reflection',async()=>{
 for(const body of [{success:true,results:[]},{success:true,results:[{document_id:'doc',chunk_id:'chunk'}]}])assert.equal(await knowledgeFailureState(body,null),null);
 for(const [body,status,expected] of [[{error:'forbidden_tenant_role'},403,'denied'],[{error:'kb_tenant_unresolved'},503,'not_configured'],[{error:'kb_api_error',failure:{code:'UAT_REMOTE_BOUND_UNVERIFIED',stage:'admission'}},503,'not_configured'],[{error:'kb_api_error',failure:{code:'KB_TOOL_FAILURE',stage:'decode'}},502,'validation_failure'],[{error:'kb_api_error',detail:'KB_HTTP_503',failure:{stage:'provider_http'}},502,'service_failure']]){
  assert.equal(await knowledgeFailureState(null,{context:Response.json(body,{status})}),expected);
 }
 assert.equal(await knowledgeFailureState(null,{context:new Response('private provider payload and credentials',{status:502})}),'service_failure');
 assert.equal(kbErrorFamily({error:'<script>secret</script>'},502),'service_failure');
});

// Producer contract: vector_store.py selects summary chunks independently of
// content chunks (0..max_full_content_chunks). This is a derived fixture,
// never the uncaptured body of the v243 Hosted failure.
function withSummaryOnlyCandidate(sample=directorOriginalRag) {
 const data=structuredClone(sample),d=structuredClone(data.selected_documents[0]);
 d.document_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';d.summary.chunk_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';d.evidence=[];
 data.selected_documents.unshift(d);data.citations.unshift({...data.citations[0],document_id:d.document_id});return data;
}
test('authenticated legacy response with summary-only candidate preserves other full-content evidence',async()=>{
 const data=withSummaryOnlyCandidate(),x=await originalAggregationFixture('none',false,data);try{const r=await x.search();assert(r.success,JSON.stringify(r));assert.equal(r.documents.length,2);assert.equal(r.documents[0].llm_context.full_content_evidence.length,0);const g=selectCanonicalGrounding(r.documents,{requestText:'什麼是四電一腦？',expectedTenantId:'34',requiresCurrentKb:true});assert.equal(g.document?.document_id,directorOriginalRag.selected_documents[0].document_id);assert.equal(g.authority_decision.provenance.currentness,'unknown');assert.equal(x.posts(),1);}finally{globalThis.fetch=realFetch;}
});

test('complete Inbox search never displays a summary-only candidate as answer evidence',async()=>{
 const sample=structuredClone(directorOriginalRag);sample.selected_documents[0].evidence=[];
 const x=await originalAggregationFixture('none',true,sample);try{const r=await x.send('knowledge');assert.equal(r.status,200);assert.equal(r.data.results.length,0);assert.equal(r.data.selected_document_id,null);}finally{globalThis.fetch=realFetch;}
});
test('complete Inbox mixed candidates retain only full-content document/chunk lineage',async()=>{
 const x=await originalAggregationFixture('none',true,withSummaryOnlyCandidate());try{
  const r=await x.send('knowledge');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.selected_document_id,directorOriginalRag.selected_documents[0].document_id);
  assert(r.data.results.length);for(const c of r.data.results){assert.equal(c.chunk_type,'full_content');assert.equal(c.chunk_id,'2ff14f99973c4f2eb1caa5454310f8ee');assert.equal(c.document_id,r.data.selected_document_id);assert(c.score>=0.75);}
 }finally{globalThis.fetch=realFetch;}
});
test('complete Inbox rerank technical failure remains a real failure through the frontend decoder',async()=>{
 const x=await originalAggregationFixture('rerank-provider-error',true);try{
  const r=await x.send('knowledge','How can I arrange a removal service?');assert.equal(r.status,502,JSON.stringify(r));assert.equal(r.data.failure.code,'LLM_NON_2XX');assert.equal(r.data.diagnostic_code,'rerank_llm_non_2xx');
  assert.equal(await knowledgeFailureState(null,{context:Response.json(r.data,{status:r.status})}),'service_failure');assert(!r.data.results);
 }finally{globalThis.fetch=realFetch;}
});
test('actual Agent Assist policy handler resolves manual pronoun using source-bound message IDs and fresh KB',async()=>{
 const x=await originalAggregationFixture('none',true);try{
  const id=crypto.randomUUID();f.rows.messages=[{id:crypto.randomUUID(),conversation_id:x.c.id,role:'assistant',content:'「四電一腦」包括受管制電器。',metadata:{source_message_id:id,citations:[{document_id:directorOriginalRag.selected_documents[0].document_id,label:'「四電一腦」生產者責任計劃'}],citation_lineage:{selected_document_id:directorOriginalRag.selected_documents[0].document_id,evidence_chunk_ids:['2ff14f99973c4f2eb1caa5454310f8ee']}}},{id,conversation_id:x.c.id,role:'visitor',content:'四電一腦係咩？'}];
  for(const row of f.rows.messages)row.is_recalled=false;
  const r=await x.send('manual-policy','咁佢包括邊幾類電器？');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.selected_document_id,directorOriginalRag.selected_documents[0].document_id,JSON.stringify(r));assert(x.queries.some(q=>q.includes('四電一腦')));
 }finally{globalThis.fetch=realFetch;}
});

for(const [name,mutate,valid] of [
 ['summary-only response',d=>{d.selected_documents=d.selected_documents.slice(0,1);d.citations=d.citations.slice(0,1);d.selected_documents[0].evidence=[];},true],
 ['empty optional display metadata',d=>{d.selected_documents[0].title='';d.selected_documents[0].source_type='';},true],
 ['nullable optional authority metadata',d=>{d.selected_documents[0].authority=null;d.selected_documents[0].metadata=null;},true],
 ['empty evidence without summary',d=>{d.selected_documents[0].summary=null;d.selected_documents[0].evidence=[];},false],
 ['non-array evidence',d=>{d.selected_documents[0].evidence={};},false],
 ['malformed summary',d=>{d.selected_documents[0].summary=false;},false],
 ['malformed authority',d=>{d.selected_documents[0].authority=42;},false],
 ['malformed descriptive type',d=>{d.selected_documents[0].source_type=42;},false],
 ['foreign summary candidate',d=>{d.selected_documents[0].evidence=[];d.selected_documents[0].tenant_id=35;},false],
 ['conflicting summary authority',d=>{d.selected_documents[0].evidence=[];d.selected_documents[0].authority={version_id:'v1'};d.selected_documents[0].summary.version_id='v2';},false],
 ['duplicate document',d=>{d.selected_documents.push(structuredClone(d.selected_documents[0]));},false],
 ['invalid envelope',d=>{d.context_found='true';},false],
])test('legacy binding and canonical parser: '+name,async()=>{
 const data=structuredClone(directorOriginalRag);mutate(data);const x=await originalAggregationFixture('none',false,data);try{const r=await x.search();assert.equal(r.success,valid,JSON.stringify(r));assert.equal(x.posts(),1);if(valid){assert.equal(r.documents[0].authority.currentness,'unknown');assert.equal(r.documents[0].authority.version,null);if(!data.selected_documents[0].evidence.length){const g=selectCanonicalGrounding(r.documents,{requestText:'四電一腦',expectedTenantId:'34'});assert.equal(g.document,null,'orientation never becomes full-content authority');}}else{assert.equal(r.failure.code,'KB_TOOL_FAILURE');assert.notEqual(r.failure.code,'KB_NO_MATCH');}}finally{globalThis.fetch=realFetch;}
});
for(const [fault,code] of [['oversized','KB_RESPONSE_TOO_LARGE'],['empty-body','KB_RESPONSE_EMPTY']])test('authenticated binding retains bounded decode failure: '+fault,async()=>{const x=await originalAggregationFixture(fault);try{const r=await x.search();assert.equal(r.success,false);assert.equal(r.diagnostic_code,code);assert.equal(r.failure.stage,'decode');assert.equal(x.posts(),1);}finally{globalThis.fetch=realFetch;}});

test('actual repository Python aggregation producer interoperates with authenticated binding and canonical grounding',async()=>{
 const data=JSON.parse(execFileSync('python3',['tests/edge/singapore-aggregation-producer-contract.py'],{encoding:'utf8'}));
 const x=await originalAggregationFixture('none',false,data);try{const r=await x.search('What is Harbor Care?');assert(r.success,JSON.stringify(r));const g=selectCanonicalGrounding(r.documents,{requestText:'What is Harbor Care?',expectedTenantId:'34'});assert.equal(g.document?.document_id,'2'.repeat(32));assert.equal(g.authority_decision.provenance.currentness,'unknown');assert.equal(g.authority_decision.provenance.version,null);assert.equal(x.posts(),1);}finally{globalThis.fetch=realFetch;}
});

test('Task1B Policy cannot mark unsupported model claims as grounded compliant',async()=>{
 const x=await setupInbox('unsupported-policy');const r=await x.send('policy','DRAFT DISTINCT: Please check this text.');
 assert.notEqual(r.data.result?.status,'compliant',JSON.stringify(r));assert.notEqual(r.data.knowledge_grounded,true);
});

for(const query of ['What is 四電一腦?','Could you explain 四電一腦?','I would like to know what 四電一腦 includes.','四電一腦 有啲咩服務？'])test('Task1B actual Knowledge natural query preserves usable full evidence: '+query,async()=>{
 const x=await originalAggregationFixture('none',true);try{const r=await x.send('knowledge',query);assert.equal(r.status,200,JSON.stringify(r));assert(r.data.results.length>0,JSON.stringify(r));}finally{globalThis.fetch=realFetch;}
});

for(const rejected of [false,true])test('Task1B Suggest Reply full handler verifies claims and remains an unsent draft: '+rejected,async()=>{
 const x=await originalAggregationFixture('none',true);f.rejectAssistClaims=rejected;try{const before=f.rows.messages.length,r=await x.send('manual-suggest','什麼是四電一腦？');if(rejected){assert(r.status>=400,JSON.stringify(r));assert.notEqual(r.data.knowledge_grounded,true);}else{assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.draft_only,true);assert.equal(r.data.knowledge_grounded,true);assert(r.data.citation_lineage.evidence_chunk_ids.length);assert(r.data.result.suggestions.length);}assert.equal(f.rows.messages.length,before);}finally{delete f.rejectAssistClaims;globalThis.fetch=realFetch;}
});

for(const denied of [false,true])test('Task1B Knowledge Helper uses existing knowledge grant without borrowing policy scope: '+denied,async()=>{
 const x=await originalAggregationFixture('none',true);try{if(denied){const g=JSON.parse(f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION);g.bindings[0].operations=['policy'];f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION=JSON.stringify(g);}const r=await x.send('helper','什麼是四電一腦？');if(denied){assert(r.status>=400,JSON.stringify(r));assert.equal(x.posts(),0);}else{assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.result.status,'available');assert(r.data.result.evidence.every(e=>e.document_id===r.data.selected_document_id && e.chunk_id));assert.equal(r.data.reference_authority.provenance.currentness,'unknown');}}finally{globalThis.fetch=realFetch;}
});

test('Task1C complete Inbox bounded slow DB admission still returns useful full evidence with unchanged RAG allowance',async()=>{
 const x=await ragApiInboxFixture(),from=f.db.from,fetcher=globalThis.fetch;let reads=0,rag=0,aborted=false;const started=Date.now();
 f.db.from=function(table){const q=from.call(this,table),then=q.then;q.then=function(resolve,reject){reads++;return new Promise(done=>setTimeout(done,250)).then(()=>({then:then.bind(q)})).then(resolve,reject);};return q;};
 globalThis.fetch=async(url,init)=>{if(String(url)===x.endpoint){rag++;aborted=init.signal.aborted;}return fetcher(url,init);};
 try{const r=await x.send('knowledge');assert.equal(r.status,200,JSON.stringify(r));assert(r.data.results.length>0);assert.equal(aborted,false);assert.equal(rag,1);assert(Date.now()-started<12000,'useful full handler should fit former shared deadline after read de-duplication');assert(reads>0);}finally{globalThis.fetch=realFetch;}
});
test('Task1C expired accounting admission fails before dispatch even when its DB read later resolves',async()=>{
 const x=await ragApiInboxFixture(),from=f.db.from,savedLog=console.log;let admission=false,delayed=false,rag=0;const events=[];
 console.log=value=>{try{const e=JSON.parse(value);events.push(e);if(e.endpoint==='kb-stage'&&e.stage==='accounting_admission'&&e.outcome==='start')admission=true;}catch{}};
 f.db.from=function(table){const q=from.call(this,table),then=q.then;q.then=function(resolve,reject){return (async()=>{if(admission&&!delayed){delayed=true;await new Promise(r=>setTimeout(r,12500));}return await {then:then.bind(q)};})().then(resolve,reject);};return q;};
 globalThis.fetch=async()=>{rag++;throw Error('No provider dispatch after expired admission');};
 try{const r=await x.send('knowledge');assert.equal(r.status,504);assert.equal(r.data.error,'kb_api_timeout');await new Promise(r=>setTimeout(r,600));assert.equal(rag,0);assert.equal(x.models(),0);assert(events.some(e=>e.stage==='accounting_admission'&&e.outcome==='abort'));}finally{console.log=savedLog;globalThis.fetch=realFetch;}
});
for(const revoked of ['membership','grant','channel'])test('Task1C final permission recheck survives de-duplication after remote preparation: '+revoked,async()=>{
 const x=await ragApiInboxFixture(),savedLog=console.log,up=globalThis.fetch;let rag=0,changed=false;
 console.log=(...args)=>{for(const a of args){try{const e=JSON.parse(a);if(!changed&&e.endpoint==='kb-stage'&&e.stage==='remote_preparation'&&e.outcome==='complete'){changed=true;if(revoked==='membership')f.rows.company_membership[0].is_active=false;if(revoked==='grant')delete f.env.AUTHENTICATED_INBOX_KB_AUTHORIZATION;if(revoked==='channel')f.rows.channel_config[0].is_active=false;}}catch{}}};
 globalThis.fetch=async(url,init)=>{if(String(url)===x.endpoint)rag++;return up(url,init);};
 try{const r=await x.send('knowledge');assert(changed);assert.equal(r.status,403,JSON.stringify(r));assert.equal(rag,0);assert.equal(x.models(),0);}finally{console.log=savedLog;globalThis.fetch=realFetch;}
});

test('Task1C full handler admission and RAG have independent bounds and produce useful evidence beyond old shared deadline',async()=>{
 const x=await ragApiInboxFixture(),from=f.db.from,up=globalThis.fetch,log=console.log;let inAdmission=false,delayed=false,posts=0;const started=Date.now();
 console.log=value=>{try{const e=JSON.parse(value);if(e.endpoint==='kb-stage'&&e.stage==='accounting_admission'&&e.outcome==='start')inAdmission=true;}catch{}};
 f.db.from=function(table){const q=from.call(this,table),then=q.then;q.then=function(resolve,reject){return (async()=>{if(inAdmission&&!delayed){delayed=true;await new Promise(r=>setTimeout(r,9000));}return await {then:then.bind(q)};})().then(resolve,reject);};return q;};
 globalThis.fetch=async(url,init)=>{if(String(url)===x.endpoint){posts++;assert.equal(init.signal.aborted,false);await new Promise((resolve,reject)=>{const done=()=>{init.signal.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,4000);const abort=()=>{clearTimeout(timer);reject(new DOMException('fixture cancelled','AbortError'));};init.signal.addEventListener('abort',abort,{once:true});});}return up(url,init);};
 try{const r=await x.send('knowledge');assert.equal(r.status,200,JSON.stringify(r));assert(r.data.results.length>0);assert.equal(posts,1);assert(Date.now()-started>=13000);assert(Date.now()-started<36000);}finally{console.log=log;globalThis.fetch=realFetch;}
});
