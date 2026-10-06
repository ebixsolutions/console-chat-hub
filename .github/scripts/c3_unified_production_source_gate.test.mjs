import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {verifyProductionSource,verifyIdentity,verifyChildEvidence,runChild,imports,PROFILE_PATH} from './c3_unified_production_source_gate.mjs';
import {verifyDeterministicClosure} from './c3_deterministic_runtime_closure.mjs';
const root=process.cwd(),profile=JSON.parse(fs.readFileSync(PROFILE_PATH));const tests=[];
function reject(name,fn,re){assert.throws(fn,re);tests.push({name,result:'PASS',rejected:true});}
const source=verifyProductionSource({root,profile,sourceOnly:true});assert.equal(source.status,'SOURCE_VALIDATED');assert.equal(source.hosted_runtime,'NOT_TESTED');
reject('wrong profile',()=>verifyProductionSource({root,profile:{...profile,mode:'DETERMINISTIC_ONLY'},sourceOnly:true}),/wrong_profile/);
reject('illegal provider',()=>verifyProductionSource({root,profile:{...profile,allowed_providers:['openai']},sourceOnly:true}),/unapproved_provider/);
reject('entrypoint omission',()=>verifyProductionSource({root,profile:{...profile,entrypoints:profile.entrypoints.slice(1)},sourceOnly:true}),/entrypoint_scope_drift/);
reject('scope expansion',()=>verifyProductionSource({root,profile:{...profile,authorized_changes:[...profile.authorized_changes,'package.json']},sourceOnly:true}),/authorization_scope_drift/);
reject('stale identity',()=>verifyIdentity(root,profile,{head:'0'.repeat(40),tree:'0'.repeat(40)}),/stale_identity/);
reject('unresolved dynamic import',()=>imports('await import(pathFromRequest);','unsafe.ts'),/dynamic_import_unresolved/);
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'c3-production-controls-'));
try{
 for(const f of [...profile.runtime_files,...Object.keys(profile.frozen_evidence_sha256)]){const dest=path.join(fixture,f);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,f),dest);}
 const victim=profile.runtime_files.find(f=>f.endsWith('/kb-client.ts'));const original=fs.readFileSync(path.join(fixture,victim));fs.unlinkSync(path.join(fixture,victim));
 reject('missing dependency',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/dependency_missing/);fs.writeFileSync(path.join(fixture,victim),original);
 fs.appendFileSync(path.join(fixture,victim),'\nexport const tenantBypass=true;\n');reject('tenant / grounding frozen source changed',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/frozen_runtime_drift/);fs.writeFileSync(path.join(fixture,victim),original);
 const provider='supabase/functions/_shared/llm-router.ts';const providerBytes=fs.readFileSync(path.join(fixture,provider));fs.appendFileSync(path.join(fixture,provider),'\nconst illegal="https://api.openai.com/v1";');reject('illegal provider endpoint source',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/frozen_runtime_drift/);fs.writeFileSync(path.join(fixture,provider),providerBytes);
 const worker='supabase/functions/deliver-feedback-request/index.ts';const workerBytes=fs.readFileSync(path.join(fixture,worker));fs.appendFileSync(path.join(fixture,worker),'\nfetch("https://api.openai.com/v1");');reject('worker direct provider bypass',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/worker_direct_external_fetch/);fs.writeFileSync(path.join(fixture,worker),workerBytes);
 const workerText=workerBytes.toString();
 assert(workerText.includes('const actor = await validateAgent(req);'));
 fs.writeFileSync(path.join(fixture,worker),workerText.replace('const actor = await validateAgent(req);','const actor = requestBody.actor;'));
 reject('worker trusted actor bypass rejected',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/conditional_worker_integrity/);fs.writeFileSync(path.join(fixture,worker),workerBytes);
 fs.writeFileSync(path.join(fixture,worker),workerText.replace('const scope = await resolveAgentCompanyScope(actor.supabaseAdmin, actor.agent);','const scope = {companyId: requestBody.company_id};'));
 reject('worker client tenant spoof rejected',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/conditional_worker_integrity/);fs.writeFileSync(path.join(fixture,worker),workerBytes);
 fs.writeFileSync(path.join(fixture,worker),workerText+'\nconst hardcodedSuccess={success:true,delivered:1};');
 reject('worker hardcoded success addition rejected',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/conditional_worker_integrity/);fs.writeFileSync(path.join(fixture,worker),workerBytes);
 const frozen=Object.keys(profile.frozen_evidence_sha256)[0];fs.appendFileSync(path.join(fixture,frozen),'\n// altered\n');reject('frozen offline checker changed',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/frozen_evidence_drift/);
 for(const status of ['SKIPPED','BLOCKED'])reject(status+' cannot count as PASS',()=>verifyChildEvidence([{status,exit_code:0,evidence:[path.join(root,PROFILE_PATH)]}]),/child_not_pass/);
 reject('child nonzero cannot be ignored',()=>verifyChildEvidence([{status:'PASS',exit_code:1,evidence:[path.join(root,PROFILE_PATH)]}]),/child_exit_ignored/);
 reject('missing evidence',()=>verifyChildEvidence([{status:'PASS',exit_code:0,evidence:[]}]),/missing_evidence/);
 reject('actual child nonzero propagated',()=>runChild(process.execPath,['-e','process.exit(17)']),/child_failed/);
 const offline=path.join(fixture,'offline');fs.mkdirSync(path.join(offline,'supabase/functions/_shared'),{recursive:true});
 const rootFile='supabase/functions/_shared/root.ts';fs.writeFileSync(path.join(offline,'supabase/functions/_shared/deterministic-runtime-router.ts'),'export {};');fs.writeFileSync(path.join(offline,rootFile),'import "./deterministic-runtime-router.ts";');
 assert.equal(verifyDeterministicClosure({root:offline,roots:[rootFile]}).mode,'DETERMINISTIC_ONLY');
 fs.writeFileSync(path.join(offline,'supabase/functions/_shared/llm-router.ts'),'export {};');fs.writeFileSync(path.join(offline,rootFile),'import "./llm-router.ts";');reject('original offline provider exclusion retained',()=>verifyDeterministicClosure({root:offline,roots:[rootFile]}),/model_router_reachable/);
 fs.writeFileSync(path.join(offline,rootFile),'const x="https://api.openai.com/v1";');reject('original offline remote exclusion retained',()=>verifyDeterministicClosure({root:offline,roots:[rootFile]}),/external_model_endpoint_reachable/);
}finally{fs.rmSync(fixture,{recursive:true,force:true});}
console.log(JSON.stringify({status:'PASS',scope:'offline source / anti-fake controls only',hosted_runtime:'NOT_TESTED',tests},null,2));
