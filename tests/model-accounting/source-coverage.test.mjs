import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';
const read=p=>fs.readFileSync('supabase/functions/'+p,'utf8');
const router=read('_shared/llm-router.ts');
assert.equal((router.match(/await accountedModelFetch\(/g)||[]).length,2);
assert.equal((router.match(/await fetch\(req\.url/g)||[]).length,0);
assert(router.includes('verifierUsage.attempts++')&&router.includes('usage.attempts++'));
assert(router.includes('error instanceof ModelAccountingError')&&router.includes('e instanceof ModelAccountingError'));
const callers=['generate-reply/index.ts','agent-assist/index.ts','conversation-evaluate/index.ts','kb-search-proxy/index.ts','_shared/ce-automation-engine.ts','_shared/commerce-semantic-interpreter.ts','_shared/escalation-policy.ts'];
for(const f of callers){assert(read(f).includes('callModel('));assert(read(f).includes('llm-router.ts'));}
const guard=read('_shared/model-attempt-accounting.ts');assert(guard.indexOf('c3_reserve_model_attempt')<guard.indexOf('await upstream('));assert(guard.includes('MODEL_ACCOUNTING_FINALIZATION_UNAVAILABLE'));
for(const f of ['_shared/kb-client.ts','customer360-coach-sync/index.ts']){
 const s=read(f);assert(s.includes('prepareRemoteRetrieval'));assert(s.includes('accountingHeaders'));assert(s.includes('accounting_unproven')||s.includes('KB_DOWNSTREAM_ACCOUNTING_UNPROVEN'));
}
for(const f of ['ce-evaluation-worker/index.ts','ce-evaluation-control/index.ts'])assert(read(f).includes('ce-automation-engine.ts'));
// Scan executable source (not generated historical bundles or tests) for extra provider dispatches.
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()&&!['generated','node_modules'].includes(e.name)?walk(d+'/'+e.name):e.isFile()&&e.name.endsWith('.ts')&&!e.name.endsWith('.test.ts')?[d+'/'+e.name]:[]);
for(const p of walk('supabase/functions')){
 const s=fs.readFileSync(p,'utf8');
 if(/https:\/\/(?:api\.anthropic\.com|[^\s"']*aiplatform\.googleapis\.com|api\.openai\.com)/.test(s))assert(p.endsWith('/_shared/llm-router.ts'),'ungoverned provider: '+p);
}
const cb=read('model-attempt-accounting/index.ts');assert(cb.includes('x-c3-accounting-body-signature')&&cb.includes('verifyRemote'));
console.log(JSON.stringify({result:'PASS',scope:'executable source call-chain coverage; not remote Hosted acceptance',callers,provider_fetch_boundaries:2,external_unknown_paths:'DENY before outbound business request'}));
