import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WorkerOperations,OPS_SCOPE,OPS_KEY,safeOpsResponse,successfulDryRun,parseOpsResult} from './b12-worker-operations.mjs';
import {BASELINE} from '../../../ops/b12-worker-once/executor.mjs';
globalThis.fetch=()=>{throw Error('NO_EGRESS');};
const dry={state:'DRY_RUN',scope:OPS_SCOPE,before:BASELINE,send_attempts:0,credential_resolved:false};
function fixture(options={}){let values=new Map(),calls=[];const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const verify=options.verify??(async()=>{}),invoke=options.invoke??(async body=>{calls.push(body);return {status:200,body:body.mode==='dry-run'?dry:{state:'UNKNOWN',spent:true,send_attempts:1}};});
  return {controller:new WorkerOperations(storage,verify,invoke),storage,calls};}
test('construction and lifecycle invalidation emit zero POST; consumers frozen in actual dialog',()=>{
 const f=fixture();f.controller.invalidate();assert.equal(f.calls.length,0);
 const src=readFileSync(new URL('../../components/console/B12VerificationDialog.tsx',import.meta.url),'utf8');
 assert(!src.includes('invokeB12Negative'));assert(!src.includes('store.start'));assert(src.includes('<Button disabled>Control frozen</Button>'));assert(src.includes('<Button disabled>Manual frozen</Button>'));
 const effect=src.slice(src.indexOf('useEffect(()=>'),src.indexOf('async function send'));assert(!effect.includes('.run('));assert(!effect.includes('functions.invoke'));
});
test('execute blocked without a genuine exact HTTP200 dry-run response',async()=>{
 const f=fixture();assert.equal(await f.controller.run('execute'),null);assert.equal(f.calls.length,0);
 for(const bad of [{...dry,credential_resolved:true},{...dry,send_attempts:1},{...dry,scope:{}},{...dry,before:{...BASELINE,jobs:'drift'}}])assert(!successfulDryRun(safeOpsResponse(200,bad)));
 assert(!successfulDryRun(safeOpsResponse(401,dry)));
});
test('one dry-run, one explicit execute; double-click and cross-instance intent prevent resend',async()=>{
 const f=fixture();assert(successfulDryRun(await f.controller.run('dry-run')));
 assert.equal(await f.controller.run('dry-run'),null);
 const results=await Promise.all([f.controller.run('execute'),f.controller.run('execute')]);assert.equal(f.calls.length,2);assert.equal(results.filter(Boolean).length,1);
 const reload=new WorkerOperations(f.storage,async()=>{},async()=>{throw Error('must not send');});assert(!reload.can('execute'));assert(!reload.can('dry-run'));
 assert.equal(JSON.parse(f.storage.getItem(OPS_KEY)).execute,OPS_SCOPE.activation);
});
test('unknown timeout is conservative permanent intent; no secret-bearing exception display',async()=>{
 let calls=0;const f=fixture({invoke:async()=>{calls++;throw Error('FAKE_TOKEN_DB_URL');}});const r=await f.controller.run('dry-run');assert.equal(r.state,'UNKNOWN');assert(!JSON.stringify(r).includes('FAKE_'));assert.equal(await f.controller.run('dry-run'),null);assert.equal(calls,1);
});
test('identity failure sends no POST; late response cannot establish dry-run proof',async()=>{
 const bad=fixture({verify:async()=>{throw Error('FAKE_PRIVATE');}});await bad.controller.run('dry-run');assert.equal(bad.calls.length,0);
 let release;const f=fixture({invoke:()=>new Promise(resolve=>{release=resolve;})});const pending=f.controller.run('dry-run');await new Promise(r=>setImmediate(r));f.controller.invalidate();release({status:200,body:dry});assert.equal(await pending,null);assert(!f.controller.can('execute'));
});
test('rerender, re-login or dialog close invalidates proof; invalid storage fails closed',async()=>{
 const f=fixture();await f.controller.run('dry-run');f.controller.invalidate();assert(!f.controller.can('execute'));
 f.storage.setItem(OPS_KEY,'invalid');assert(!f.controller.can('dry-run'));assert.equal(await f.controller.run('dry-run'),null);
});
test('sanitized response protocol preserves dry-run booleans and strips arbitrary credentials/URLs',()=>{
 const r=safeOpsResponse(200,{...dry,token:'FAKE',secret:'FAKE',url:'postgres://private',detail:'FAKE',scope:OPS_SCOPE});
 assert(successfulDryRun(r));assert(!JSON.stringify(r).includes('FAKE'));assert(!JSON.stringify(r).includes('postgres://'));
});
test('actual SDK consumed-success and HTTP error envelope parse correctly without retry',async()=>{
 const response=new Response(JSON.stringify(dry),{status:200});await response.json();
 const r=await parseOpsResult({response,data:dry});assert(successfulDryRun(safeOpsResponse(r.status,r.body)));
 const failed=await parseOpsResult({error:{context:new Response(JSON.stringify({state:'STOP',code:'caller_scope_denied',secret:'FAKE'}),{status:403})}});
 assert.equal(failed.status,403);assert.equal(failed.body.code,'caller_scope_denied');assert(!JSON.stringify(failed).includes('FAKE'));
});
test('missing or malformed HTTP responses are UNKNOWN, never accepted dry-run',async()=>{
 for(const result of [{},{response:new Response('bad',{status:200})},{response:new Response('x'.repeat(18000),{status:200})}]){
 const r=await parseOpsResult(result);assert.equal(r.body.state,'UNKNOWN');assert(!successfulDryRun(r.body));}
});
