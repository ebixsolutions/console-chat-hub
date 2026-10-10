import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {verifyProductionSource,verifyIdentity,verifyChildEvidence,runChild,imports,PROFILE_PATH} from './c3_unified_production_source_gate.mjs';
import {resolveAuthoritativeSupabaseBinding} from '../../src/integrations/supabase/runtime-authority.mjs';
import {verifyDeterministicClosure} from './c3_deterministic_runtime_closure.mjs';
const root=process.cwd(),profile=JSON.parse(fs.readFileSync(PROFILE_PATH));const tests=[];
function reject(name,fn,re){assert.throws(fn,re);tests.push({name,result:'PASS',rejected:true});}
const source=verifyProductionSource({root,profile,sourceOnly:true});assert.equal(source.status,'SOURCE_VALIDATED');assert.equal(source.hosted_runtime,'NOT_TESTED');
reject('Quality95 source repair cannot authorize live traffic',()=>verifyProductionSource({root,profile:{...profile,quality95_extra_traffic_authorized:true},sourceOnly:true}),/quality95_production_authority_masquerade/);
reject('Quality95 source repair cannot authorize deployment',()=>verifyProductionSource({root,profile:{...profile,quality95_production_deployment_authorized:true},sourceOnly:true}),/quality95_production_authority_masquerade/);
reject('wrong profile',()=>verifyProductionSource({root,profile:{...profile,mode:'DETERMINISTIC_ONLY'},sourceOnly:true}),/wrong_profile/);
reject('illegal provider',()=>verifyProductionSource({root,profile:{...profile,allowed_providers:['openai']},sourceOnly:true}),/unapproved_provider/);
reject('entrypoint omission',()=>verifyProductionSource({root,profile:{...profile,entrypoints:profile.entrypoints.slice(1)},sourceOnly:true}),/entrypoint_scope_drift/);
reject('scope expansion',()=>verifyProductionSource({root,profile:{...profile,authorized_changes:[...profile.authorized_changes,'package.json']},sourceOnly:true}),/authorization_scope_drift/);
reject('stale identity',()=>verifyIdentity(root,profile,{head:'0'.repeat(40),tree:'0'.repeat(40)}),/stale_identity/);
reject('unresolved dynamic import',()=>imports('await import(pathFromRequest);','unsafe.ts'),/dynamic_import_unresolved/);
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'c3-production-controls-'));
try{
 for(const f of [...Object.keys(profile.authorized_quality95_failure_repair_sha256),...profile.runtime_files,...Object.keys(profile.frozen_evidence_sha256),...Object.keys(profile.normalized_preview_sha256),...Object.keys(profile.widget_reply_stability_sha256),...Object.keys(profile.authorized_widget_auth_repair_sha256),...Object.keys(profile.authorized_unified_generic_service_repair_sha256),...Object.keys(profile.authorized_f13_f14_repair_sha256),...Object.keys(profile.authorized_b12_registry_repair_sha256),...Object.keys(profile.authorized_memory_reply_repair_sha256),...Object.keys(profile.authorized_preview_activation_sha256),...Object.keys(profile.accepted_demo_env_sha256),...Object.keys(profile.authorized_section15_repair_sha256)]){const dest=path.join(fixture,f);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,f),dest);}
 for(const f of Object.keys(profile.authorized_f13_f14_repair_sha256)){fs.mkdirSync(path.dirname(path.join(fixture,f)),{recursive:true});fs.copyFileSync(path.join(root,f),path.join(fixture,f));}
 for(const f of Object.keys(profile.normalized_preview_sha256)) {
  const original=fs.readFileSync(path.join(fixture,f));fs.appendFileSync(path.join(fixture,f),'\n// unapproved preview drift\n');
  reject('normalized preview binding drift '+f,()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/preview_binding_drift/);fs.writeFileSync(path.join(fixture,f),original);
 }
 for(const f of Object.keys(profile.widget_reply_stability_sha256)){const original=fs.readFileSync(path.join(fixture,f));fs.appendFileSync(path.join(fixture,f),'\n// unauthorized stability drift');reject('Widget reply stability drift '+f,()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/widget_stability_source_drift/);fs.writeFileSync(path.join(fixture,f),original);}
 for(const f of Object.keys(profile.authorized_memory_reply_repair_sha256)){const original=fs.readFileSync(path.join(fixture,f));fs.appendFileSync(path.join(fixture,f),'\n// unauthorized lifecycle drift');reject('Memory reply lifecycle source drift '+f,()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),profile.authorized_section15_repair_sha256[f]?/section15_source_drift/:/memory_reply_source_drift/);fs.writeFileSync(path.join(fixture,f),original);}
 for(const f of Object.keys(profile.authorized_preview_activation_sha256)){const original=fs.readFileSync(path.join(fixture,f));fs.appendFileSync(path.join(fixture,f),'\n// unapproved identity bypass');reject('preview activation source drift '+f,()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/preview_activation_source_drift/);fs.writeFileSync(path.join(fixture,f),original);}
 reject('pending SQL falsely authorized',()=>verifyProductionSource({root:fixture,profile:{...profile,memory_reply_sql_production_authorized:true},sourceOnly:true}),/memory_reply_sql_authority_masquerade/);
 for(const f of Object.keys(profile.authorized_widget_auth_repair_sha256)){const original=fs.readFileSync(path.join(fixture,f));fs.appendFileSync(path.join(fixture,f),'\n// unauthorized auth change');reject('Widget auth drift '+f,()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/widget_(?:auth|stability)_source_drift/);fs.writeFileSync(path.join(fixture,f),original);}
 reject('generic repair profile cannot authorize different bytes',()=>verifyProductionSource({root:fixture,profile:{...profile,authorized_unified_generic_service_repair_sha256:{}},sourceOnly:true}),/generic_repair_scope_drift/);
 for(const f of Object.keys(profile.authorized_unified_generic_service_repair_sha256)) {
  const original=fs.readFileSync(path.join(fixture,f));fs.appendFileSync(path.join(fixture,f),'\n// unapproved generic service drift');
  reject('generic repair source drift '+f,()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/(?:section15_source_drift|generic_repair_source_drift|widget_(?:stability|auth)_source_drift|memory_reply_source_drift)/);
  fs.writeFileSync(path.join(fixture,f),original);
 }
 reject('accepted Demo checkpoint cannot change',()=>verifyProductionSource({root:fixture,profile:{...profile,accepted_demo_checkpoint:{...profile.accepted_demo_checkpoint,head:'0'.repeat(40)}},sourceOnly:true}),/accepted_demo_profile_drift/);
 reject('Section15 scope cannot change',()=>verifyProductionSource({root:fixture,profile:{...profile,authorized_section15_repair_sha256:{}},sourceOnly:true}),/section15_scope_drift/);
 reject('Section15 source acceptance cannot authorize deployment',()=>verifyProductionSource({root:fixture,profile:{...profile,section15_deployment_authorized:true},sourceOnly:true}),/section15_production_authority_masquerade/);
 for(const f of Object.keys(profile.authorized_section15_repair_sha256)){
  const original=fs.readFileSync(path.join(fixture,f));fs.appendFileSync(path.join(fixture,f),'\n// unauthorized Section15 drift');
  reject('Section15 exact source drift '+f,()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/section15_source_drift/);fs.writeFileSync(path.join(fixture,f),original);
 }
 const workflow='.github/workflows/task-ai-abc-c3-final-gate.yml';const workflowBytes=fs.readFileSync(path.join(fixture,workflow));
 fs.appendFileSync(path.join(fixture,workflow),'\n# unauthorized CI source drift');
 reject('CI lockfile repair permits only exact workflow bytes',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/section15_validation_drift/);fs.writeFileSync(path.join(fixture,workflow),workflowBytes);
 const memoryStep=workflowBytes.toString().split('      - name: Bounded Memory receipt and service rendering regressions')[1].split('      - name:')[0];
 assert.equal((memoryStep.match(/deno (?:check|test) --no-lock /g)||[]).length,3);
 tests.push({name:'all Memory regression Deno commands avoid tracked lockfile writes',result:'PASS'});
 const authority='src/integrations/supabase/runtime-authority.mjs';const authorityBytes=fs.readFileSync(path.join(fixture,authority));
 fs.appendFileSync(path.join(fixture,authority),'\n// unauthorized authority change');
 reject('accepted Demo runtime authority drift',()=>verifyProductionSource({root:fixture,profile,sourceOnly:true}),/accepted_demo_env_source_drift/);fs.writeFileSync(path.join(fixture,authority),authorityBytes);
 // Exercise the real resolver with the exact retained .env; no key is logged.
 const values=Object.fromEntries(fs.readFileSync('.env','utf8').split('\n').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1).replace(/^"|"$/g,'')]}));
 const binding=resolveAuthoritativeSupabaseBinding({url:values.VITE_SUPABASE_URL,projectId:values.VITE_SUPABASE_PROJECT_ID,publishableKey:values.VITE_SUPABASE_PUBLISHABLE_KEY,functionsUrl:values.VITE_SUPABASE_FUNCTIONS_URL});
 assert.equal(binding.projectId,'nrfxhqabwblzxoushgnm');assert.equal(binding.url,'https://nrfxhqabwblzxoushgnm.supabase.co');assert.equal(binding.functionsUrl,'https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1');
 tests.push({name:'retained environment uses exact production authority resolver',result:'PASS',scope:'resolver execution only, not hosted runtime'});
 reject('B12 production permission cannot be invented',()=>verifyProductionSource({root:fixture,profile:{...profile,b12_sql_production_authorized:true},sourceOnly:true}),/b12_production_authority_masquerade/);
 reject('B12 exact scope cannot be changed',()=>verifyProductionSource({root:fixture,profile:{...profile,authorized_b12_registry_repair_sha256:{}},sourceOnly:true}),/b12_scope_drift/);
 reject('F13/F14 SQL permission cannot be invented',()=>verifyProductionSource({root:fixture,profile:{...profile,f13_f14_sql_production_authorized:true},sourceOnly:true}),/f13_f14_production_authority_masquerade/);
 reject('F13/F14 scope cannot be changed',()=>verifyProductionSource({root:fixture,profile:{...profile,authorized_f13_f14_repair_sha256:{}},sourceOnly:true}),/f13_f14_scope_drift/);
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
 // A later commit cannot exploit a path allowed by an older repair scope.
 const identityRepo=path.join(fixture,'identity-repo');
 execFileSync('git',['clone','--quiet','--shared',root,identityRepo]);
 fs.appendFileSync(path.join(identityRepo,'package.json'),'\n');
 execFileSync('git',['add','package.json'],{cwd:identityRepo});
 execFileSync('git',['-c','user.name=C3 isolated test','-c','user.email=c3-test@example.invalid','commit','--quiet','-m','isolated unauthorized successor'],{cwd:identityRepo});
 const identity={head:execFileSync('git',['rev-parse','HEAD'],{cwd:identityRepo,encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:identityRepo,encoding:'utf8'}).trim()};
 reject('historically allowed path cannot authorize a new unrelated successor',()=>verifyIdentity(identityRepo,profile,identity),/section15_successor_scope:package.json/);
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
