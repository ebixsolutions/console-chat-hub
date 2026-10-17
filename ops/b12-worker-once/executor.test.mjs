import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execute,BASELINE,SCOPE,BODY,sanitizeResponse,validateReceipt,readBounded} from './executor.mjs';
import {createHandler,CALLER} from './runtime.mjs';
import {SNAPSHOT_SQL} from './snapshot.mjs';
import {validateFinal} from './validate.mjs';
// No real networking is reachable: all transport is injected. A stray default
// fetch fails immediately instead of consuming any production quota.
globalThis.fetch=()=>{throw Error('NETWORK_EGRESS_DENIED');};
const input={mode:'execute',activation_id:SCOPE.activation};
const good={status:409,body:{error:'realtime_claim_rejected',reason:'conversation_not_evaluable',job_id:SCOPE.job}};
function fixture(options={}) {
  const dir=options.dir??mkdtempSync(join(tmpdir(),'b12-mock-'));
  let sends=0,finished=null;
  const io={snapshot:async()=>({...BASELINE,...options.snapshot}),
    prepare:async()=>{
      try {const fd=openSync(join(dir,'spent'),'wx',0o600);writeFileSync(fd,'send-intent');closeSync(fd);}catch(e){if(e.code==='EEXIST')return null;throw e;}
      return async()=>{sends++; assert.equal(readFileSync(join(dir,'spent'),'utf8'),'send-intent');
        if(options.fail)throw Error('FAKE_PRIVATE_SECRET_IN_EXCEPTION');return options.result??good;};
    },bindingUnchanged:async()=>options.binding!==false,finish:async r=>{finished=r;}};
  return {io,dir,get sends(){return sends;},get finished(){return finished;}};
}
test('default is dry-run: zero POST, zero credential prepare, no spent',async()=>{
  const f=fixture();const r=await execute({},f.io);assert.equal(r.state,'DRY_RUN');assert.equal(f.sends,0);
  assert.equal((await execute(input,f.io)).state,'PASS');});
test('reject arbitrary endpoint, job, payload, tenant and activation inputs',async()=>{
  for(const [k,v] of Object.entries({url:'https://evil.invalid',job_id:'other',body:'other',company:'other',activation_id:'other',mode:'other'})){
    const f=fixture();const r=await execute({...input,[k]:v},f.io);assert.equal(r.state,'STOP');assert.equal(f.sends,0);}
});
test('every before predicate/hash/counter guard failure sends zero POST',async()=>{
  for(const k of Object.keys(BASELINE)){const f=fixture({snapshot:{[k]:'drift'}});assert.equal((await execute(input,f.io)).state,'STOP');assert.equal(f.sends,0);}
});
test('durable spent survives a new executor instance and rejects restart',async()=>{
  const f=fixture();assert.equal((await execute(input,f.io)).state,'PASS');
  const resumed=fixture({dir:f.dir});assert.equal((await execute(input,resumed.io)).state,'STOP');assert.equal(resumed.sends,0);});
test('concurrent instances commit only one send-intent',async()=>{
  const a=fixture(),b=fixture({dir:a.dir});const rs=await Promise.all([execute(input,a.io),execute(input,b.io)]);
  assert.equal(a.sends+b.sends,1);assert.equal(rs.filter(r=>r.state==='PASS').length,1);});
test('timeout/unknown spends allowance, suppresses exception and cannot resend',async()=>{
  const f=fixture({fail:true});const r=await execute(input,f.io);assert.equal(r.state,'UNKNOWN');assert.equal(r.spent,true);
  assert(!JSON.stringify(r).includes('FAKE_PRIVATE_SECRET'));assert.equal((await execute(input,f.io)).state,'STOP');assert.equal(f.sends,1);});
test('actual409 contract parsed;401403other409empty bodies never pass',async()=>{
  for(const r of [{status:401,body:{}},{status:403,body:{}},{status:409,body:{error:'runtime_disabled'}},{status:409,body:{}},null]){
    const f=fixture({result:r});if(r===null)f.io.prepare=async()=>async()=>null;
    assert.equal((await execute(input,f.io)).state,'FAIL');}
  assert(validateReceipt(good));assert(!validateReceipt({...good,body:{...good.body,job_id:'wrong'}}));
});
test('after drift or credential/runtime binding drift is FAIL and stays spent',async()=>{
  const f=fixture({binding:false});assert.equal((await execute(input,f.io)).state,'FAIL');assert.equal(f.sends,1);
  let n=0;const g=fixture();g.io.snapshot=async()=>({...BASELINE,jobs:++n===1?BASELINE.jobs:'drift'});
  assert.equal((await execute(input,g.io)).state,'FAIL');assert.equal(g.sends,1);});
test('response whitelist never returns echoed secrets, headers or arbitrary error text',()=>{
  const token='FAKE_PRIVATE_CREDENTIAL';const raw=JSON.stringify({...good.body,token,headers:{'X-CE-Worker-Token':token},detail:token});
  const s=sanitizeResponse(409,raw,'bad '+token,[token]);assert(validateReceipt(s));assert(!JSON.stringify(s).includes(token));
  const id='01234567-89ab-cdef-0123-456789abcdef';const red=sanitizeResponse(409,JSON.stringify(good.body),id,[id]);assert.equal(red.response_redacted,true);
});
test('bounded response reader cancels oversized body without exposing content',async()=>{
  assert.equal(await readBounded(new Response('x'.repeat(5000))),'');assert.equal(await readBounded(new Response('{}')),'{}');});
test('canonical query file exactly matches protected runtime query',()=>{
  assert.equal(readFileSync(new URL('./snapshot.sql',import.meta.url),'utf8'),SNAPSHOT_SQL);
  assert(!/\b(insert|update|delete|decrypted_secret|worker_token_hash)\b/i.test(SNAPSHOT_SQL));});
function protectedFixture(status=409,raw=JSON.stringify(good.body),throws=false,capabilities={},authOptions={}) {
  const credential='FAKE_PRIVATE_WORKER_CREDENTIAL',key='FAKE_MANAGEMENT_ONLY',db='FAKE_DB_ONLY';let spent=false,armed=true;
  let calls=0,privateReads=0;const statements=[];let scopeChecks=0;
  const binding={worker_secret_id:'fake-ref',worker_token_hash:'502235035364556974fa8356190988f69f479d4d749fb995ecf00f5643acc535',worker_url:SCOPE.endpoint,enabled:false};
  const query=async(text)=>{
    statements.push(text);
    if(text.includes('authorized_scope'))return[{authorized_scope:authOptions.scope!==false && !(authOptions.revokeDuringPrepare && ++scopeChecks>1)}];
    if(text.includes('has_table_privilege'))return[{vault_read:true,ledger_select:true,ledger_update:true,verifier_access:true,...capabilities}];
    if(text.includes('select armed'))return authOptions.missingSlot?[]:[{armed,spent_at:spent?'spent':null,live:authOptions.live!==false,reviewed:true}];
    if(text.includes('from public.ce_automation_runtime'))return[binding];
    if(text.includes('from vault.decrypted_secrets')){privateReads++;return[{credential}];}
    if(text.includes('as valid'))return[{valid:true}];
    if(text.includes('set spent_at')){if(spent)return[];spent=true;armed=false;return[{operation:SCOPE.activation}];}
    if(text.includes('set receipt'))return[{operation:SCOPE.activation}];
    throw Error('FAKE_DB_ONLY_UNEXPECTED');
  };
  const sql=(parts,...values)=>query(parts.join('?')); sql.unsafe=async()=>[{...BASELINE}];
  sql.begin=async(_options,fn)=>fn(sql);sql.end=async()=>{};sql.json=x=>x;
  const env=n=>({SUPABASE_ANON_KEY:'FAKE_PUBLIC_ONLY',SUPABASE_URL:'https://nrfxhqabwblzxoushgnm.supabase.co',SUPABASE_DB_URL:db})[n];
  const handler=createHandler(env,()=>sql,async(url,init)=>{
    if(url.endsWith('/auth/v1/user')){assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
      if(authOptions.authThrow)throw Error(key);
      return new Response(JSON.stringify({id:CALLER.id,email:CALLER.email,role:'authenticated',...authOptions.user}),{status:init.headers.Authorization===`Bearer ${key}`?(authOptions.authStatus??200):401});}
    calls++;assert(spent);assert.equal(url,SCOPE.endpoint);assert.equal(init.body,BODY);assert.equal(init.method,'POST');
    assert.equal(init.redirect,'manual');assert(init.signal);assert.equal(init.headers['X-CE-Worker-Token'],credential);
    assert(!('Authorization' in init.headers)); if(throws)throw Error(credential+key+db);
    return new Response(raw,{status,headers:{location:'https://evil.invalid'}});
  });
  const req=(body,auth=`Bearer ${key}`)=>{if(!spent)armed=body.mode==='execute';return new Request('https://protected.invalid',{method:'POST',headers:{Authorization:auth},body:JSON.stringify(body)});};
  return {handler,req,get calls(){return calls;},get privateReads(){return privateReads;},secrets:[credential,key,db,binding.worker_token_hash]};
}
test('protected adapter dry-run does not resolve Vault or transmit',async()=>{
  const f=protectedFixture();assert.equal((await (await f.handler(f.req({}))).json()).state,'DRY_RUN');assert.equal(f.privateReads,0);assert.equal(f.calls,0);});
test('unauthorized operations caller cannot reach private credential',async()=>{
  const f=protectedFixture();assert.equal((await f.handler(f.req(input,'Bearer FAKE_ADMIN'))).status,401);assert.equal(f.privateReads,0);assert.equal(f.calls,0);});
test('protected adapter private header stays internal; full response contains no secret',async()=>{
  const f=protectedFixture();const r=await (await f.handler(f.req(input))).json();assert.equal(r.state,'PASS');
  for(const s of f.secrets)assert(!JSON.stringify(r).includes(s));assert.equal(f.calls,1);
  assert.equal((await (await f.handler(f.req(input))).json()).state,'STOP');assert.equal(f.calls,1);});
test('redirect is not followed and is FAIL, spent',async()=>{
  const f=protectedFixture(302,'{}');const r=await (await f.handler(f.req(input))).json();assert.equal(r.state,'FAIL');assert.equal(f.calls,1);assert.equal(r.redirect,0);});
test('adapter secret-bearing transport exception returns UNKNOWN with no secret',async()=>{
  const f=protectedFixture(409,'',true);const r=await (await f.handler(f.req(input))).json();assert.equal(r.state,'UNKNOWN');
  for(const s of f.secrets)assert(!JSON.stringify(r).includes(s));assert.equal(f.calls,1);});
test('final validator requires scope, spent and full before/after proof',async()=>{
  const f=fixture();const r=await execute(input,f.io);assert(validateFinal(r));
  for(const k of ['scope','before','after','response'])assert(!validateFinal({...r,[k]:{}}));
  assert(!validateFinal({...r,spent:false}));assert(!validateFinal({...r,send_attempts:2}));
  assert(!validateFinal({...r,binding_unchanged:false}));});

// Approval-review regression tests. Mock adapter evidence only, not live SQL/RLS.
test('ledger SELECT without UPDATE rejects before snapshot, private read or POST',async()=>{
  const f=protectedFixture(409,JSON.stringify(good.body),false,{ledger_update:false});
  const response=await f.handler(f.req({mode:'dry-run'}));
  assert.equal(response.status,409);assert.equal((await response.json()).code,'protected_runtime_unavailable');
  assert.equal(f.privateReads,0);assert.equal(f.calls,0);
});
test('ledger UPDATE without SELECT rejects before snapshot, private read or POST',async()=>{
  const f=protectedFixture(409,JSON.stringify(good.body),false,{ledger_select:false});
  const response=await f.handler(f.req(input));
  assert.equal(response.status,409);assert.equal((await response.json()).code,'protected_runtime_unavailable');
  assert.equal(f.privateReads,0);assert.equal(f.calls,0);
});
test('missing, null, string or false capability never passes the actual handler',async()=>{
  for(const name of ['vault_read','ledger_select','ledger_update','verifier_access']){
    for(const value of [undefined,null,'true',false]){
      const f=protectedFixture(409,JSON.stringify(good.body),false,{[name]:value});
      const response=await f.handler(f.req(input));
      assert.equal(response.status,409);assert.equal((await response.json()).code,'protected_runtime_unavailable');
      assert.equal(f.privateReads,0);assert.equal(f.calls,0);
    }
  }
});

// Actual Auth/tenant boundary with injected Auth server responses, never live JWTs.
test('expired, invalid, wrong-user and wrong-email Auth responses fail closed',async()=>{
  for(const options of [{authStatus:401},{authStatus:403},{authStatus:302},{authThrow:true},{user:{id:'other'}},{user:{email:'other@example.test'}},{user:{role:'service_role'}}]){
    const f=protectedFixture(409,JSON.stringify(good.body),false,{},options);
    const r=await f.handler(f.req(input));assert.equal(r.status,401);assert.equal(f.calls,0);assert.equal(f.privateReads,0);}
});
test('revoked Admin, inactive membership or wrong tenant cannot reach Vault',async()=>{
  const f=protectedFixture(409,JSON.stringify(good.body),false,{}, {scope:false});
  const r=await f.handler(f.req(input));assert.equal(r.status,403);assert.equal(f.calls,0);assert.equal(f.privateReads,0);
  const source=readFileSync(new URL('./runtime.mjs',import.meta.url),'utf8');
  for(const condition of ["m.is_active=true","m.role='admin'","ch.is_active=true",'m.company_id=${SCOPE.company}','ch.id=${SCOPE.channel}','c.id=${SCOPE.conversation}'])assert(source.includes(condition));
});
test('CORS preflight makes zero Auth, DB, Vault or Worker calls',async()=>{
  let calls=0;const h=createHandler(()=>{calls++;return'';},()=>{calls++;throw 0;},()=>{calls++;throw 0;});
  const r=await h(new Request('https://protected.invalid',{method:'OPTIONS'}));assert.equal(r.status,204);assert.equal(calls,0);
});
test('runtime never returns unverified Auth strings or exports a caller token',async()=>{
  const f=protectedFixture(409,JSON.stringify({...good.body,detail:'FAKE_MANAGEMENT_ONLY'}));
  const r=await (await f.handler(f.req(input))).json();for(const value of f.secrets)assert(!JSON.stringify(r).includes(value));
  const source=readFileSync(new URL('./runtime.mjs',import.meta.url),'utf8');assert(!source.includes("env('SUPABASE_SERVICE_ROLE_KEY')"));assert(!/console\.(log|error|warn)/.test(source));
});

test('expired or missing permanent ledger prevents even dry-run success',async()=>{
  for(const options of [{live:false},{missingSlot:true}]){
    const f=protectedFixture(409,JSON.stringify(good.body),false,{},options);
    const r=await f.handler(f.req({mode:'dry-run'}));assert.equal(r.status,409);assert.equal(f.calls,0);assert.equal(f.privateReads,0);}
});
test('membership revoked between initial read and prepare refuses before private read',async()=>{
  const f=protectedFixture(409,JSON.stringify(good.body),false,{}, {revokeDuringPrepare:true});
  const r=await (await f.handler(f.req(input))).json();assert.equal(r.state,'STOP');assert.equal(f.calls,0);assert.equal(f.privateReads,0);
});
test('parallel actual handlers spend one intent and send at most once',async()=>{
  const f=protectedFixture();await Promise.all([f.handler(f.req(input)),f.handler(f.req(input))]);assert.equal(f.calls,1);
});
test('operations runtime has no ledger reset, recreation or renewal statements',()=>{
  const s=readFileSync(new URL('./runtime.mjs',import.meta.url),'utf8');
  assert(!/spent_at\s*=\s*null|expires_at\s*=|delete\s+from|create\s+table|drop\s+table/i.test(s));
});
