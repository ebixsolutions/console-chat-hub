#!/usr/bin/env node
/** One local source closure command; no Supabase client/CLI or hosted traffic. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {backendDeploymentRequest} from './c3_backend_deployment_request.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const output=process.env.C3_FINAL_GATE_RESULT ?? '/tmp/c3-customer-quality-final-gate.json';
assert.ok(!path.resolve(output).startsWith(root+path.sep),'output must stay outside candidate');
const report={coverage:'SOURCE_LOCAL_CLOSURE_ONLY',commands:[],assertions:{},production_writes:0,production_deploys:0,pushed:false};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const rawGit=(...args)=>{const result=spawnSync('git',args,{cwd:root});report.commands.push({command:'git',args,exit_code:result.status,machine_assertion:'git_identity_scope_or_content_readback',stdout_sha256:sha(result.stdout??'')});assert.equal(result.status,0,'git readback failed');return result.stdout;};
const git=(...args)=>rawGit(...args).toString('utf8').trim();
const split=text=>text.split('\n').filter(Boolean).sort();
function check(label,fn){fn();report.assertions[label]=true;}
function run(command,args,label){
  const log=path.join(path.dirname(output),'c3-final-'+report.commands.length+'.log');
  const result=spawnSync(command,args,{cwd:root,env:{...process.env,C3_TEST_RESULT:path.join(path.dirname(output),'c3-final-runtime.json'),C3_TEST_LOG:path.join(path.dirname(output),'c3-final-handler.log')},encoding:'utf8',timeout:240000,maxBuffer:15*1024*1024});
  fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
  report.commands.push({command,args,exit_code:result.status,signal:result.signal,machine_assertion:label,log_sha256:sha(fs.readFileSync(log))});
  assert.equal(result.status,0,label+': '+(result.error?.message??'')+'; see '+log);
  report.assertions[label]=true;return result.stdout;
}
try{
  const scope=JSON.parse(fs.readFileSync(path.join(root,'.github/scripts/c3_customer_quality_scope.json')));
  check('candidate_head_tree_and_baseline',()=>{
    assert.equal(scope.baseline_head,'4b47bb2eac2f2403bb1bbb947e81bb4d9cbdbac6');
    assert.equal(scope.baseline_tree,'18866091177e2ef3c16d1637338cde1aa000f7a8');
    assert.equal(git('rev-parse',scope.baseline_head+'^{tree}'),scope.baseline_tree);
    assert.equal(git('merge-base',scope.baseline_head,'HEAD'),scope.baseline_head);
    assert.equal(git('branch','--show-current'),'director/ai-abc-c3-long-memory-final-cutover');
    report.head=git('rev-parse','HEAD');report.tree=git('rev-parse','HEAD^{tree}');
    assert.match(report.head,/^[a-f0-9]{40}$/);assert.match(report.tree,/^[a-f0-9]{40}$/);
    assert.equal(git('status','--porcelain','--untracked-files=all'),'');
  });
  check('changed_files_exact_scope_and_head_hashes',()=>{
    const changed=split(git('diff','--name-only',scope.baseline_head,'HEAD'));
    assert.deepEqual(changed,[...scope.changed_files].sort());
    assert.equal(new Set(scope.changed_files).size,scope.changed_files.length);
    report.changed_files=changed;report.source_hashes={};
    for(const file of changed){const bytes=fs.readFileSync(path.join(root,file));assert.ok(bytes.length);assert.deepEqual(bytes,rawGit('show','HEAD:'+file));report.source_hashes[file]=sha(bytes);}
    report.accepted_reference_head='575369d9a939f0e9a58da1863b8f94aa06f0b9c6';
    report.accepted_reference_tree=git('rev-parse',report.accepted_reference_head+'^{tree}');
    assert.equal(report.accepted_reference_tree,'0f22f206a93e75c1d42dc79fedd371ec1307c419');
    report.all_changed_from_reference=split(git('diff','--name-only',report.accepted_reference_head,'HEAD'));
  });
  check('frozen_source_and_security_function_drift',()=>{
    report.frozen_hashes={};
    for(const file of ['supabase/functions/_shared/commerce-state-contract.ts','supabase/functions/_shared/commerce-state-reducer.ts','supabase/functions/_shared/deterministic-runtime-router.ts','supabase/functions/receive-widget-message/index.ts','src/integrations/supabase/auth-middleware.ts','supabase/migrations/20260925093000_c3_t11_revision_bound_ai_reply.sql','supabase/migrations/20260928100000_c3_director_handoff_context.sql']){
      const bytes=fs.readFileSync(path.join(root,file));assert.deepEqual(bytes,rawGit('show',scope.baseline_head+':'+file));report.frozen_hashes[file]=sha(bytes);
    }
    // Hosted recap quality repair includes the shared selector and its noun/mutation boundary.
    // Preserve every other byte of the accepted authority contract.
    const authority='supabase/functions/_shared/commerce-state-authority.ts';
    const stripRecap=text=>{for(const name of ['export function isCurrentRequirementsRecap(', 'function explicitCustomerMutation(']){const start=text.indexOf(name);assert.ok(start>=0);const end=text.indexOf('\n}',start)+2;assert.ok(end>start);text=text.slice(0,start)+text.slice(end);}return text;};
    assert.equal(stripRecap(fs.readFileSync(path.join(root,authority),'utf8')),stripRecap(rawGit('show',scope.baseline_head+':'+authority).toString('utf8')),'unrelated authority bytes changed');
    const runtimeBase='supabase/functions/_shared/commerce-state-runtime-base.ts';
    const oldReceipt='    const reply = language === "en"';
    const newReceipt='    const reply = lifecycleVerified.plans[0].action === "cancelled"\n      ? (language === "en" ? `${target} is cancelled.` : `${target}已取消。`)\n      : language === "en"';
    assert.equal(fs.readFileSync(path.join(root,runtimeBase),'utf8').replace(newReceipt,oldReceipt),rawGit('show',scope.baseline_head+':'+runtimeBase).toString('utf8'),'only the causally proven cancellation receipt may change');
    const capability='supabase/functions/_shared/commerce-capability-runtime.ts';
    const stripQuantity=text=>{const start=text.indexOf('export function extractGenericCommerceEntity('),end=text.indexOf('\n}',start)+2;assert.ok(start>=0&&end>start);return text.slice(0,start)+text.slice(end);};
    assert.equal(stripQuantity(fs.readFileSync(path.join(root,capability),'utf8')),stripQuantity(rawGit('show',scope.baseline_head+':'+capability).toString('utf8')),'only the hosted-proven generic quantity binding may change');
    for(const frozen of ['supabase/functions/_shared/pre-send-conversion-supervisor.ts','supabase/functions/_shared/b2-response-persistence-gate.ts']){
      if(fs.existsSync(path.join(root,frozen)))assert.equal(fs.readFileSync(path.join(root,frozen),'utf8'),rawGit('show',scope.baseline_head+':'+frozen).toString('utf8'),'B2 must remain byte-identical');
    }
    const file='supabase/functions/_shared/pre-send-conversion-supervisor.ts';
    const before=rawGit('show',scope.baseline_head+':'+file).toString('utf8'),after=fs.readFileSync(path.join(root,file),'utf8');
    const section=(text,name)=>{const at=text.indexOf('function '+name+'(');assert.ok(at>=0,name);const end=text.indexOf('\nfunction ',at+1);return text.slice(at,end<0?text.length:end);};
    for(const name of ['evaluateCurrentKbSellingPrice','evaluateQuoteReality','evaluateTransactionReality','evaluateKnownContext','evaluateCorrections'])assert.equal(section(after,name),section(before,name),name);
    assert.equal(git('diff','--name-only',scope.baseline_head,'HEAD','--','src','supabase/functions/receive-widget-message','supabase/functions/agent-assist'),'');
  });
  check('rollback_preserves_original_handoff_and_restores_memory_rpc',()=>{
    const rollback='supabase/migrations/rollback/20260930090000_c3_handoff_grounded_facts.rollback.sql';
    const before=rawGit('show',scope.baseline_head+':'+rollback).toString('utf8');
    const after=fs.readFileSync(path.join(root,rollback),'utf8');
    assert.equal(after,before,'accepted rollback changed');
    const memoryOriginal=rawGit('show',scope.baseline_head+':supabase/migrations/20260915040000_ai_abc_c3_director_runtime_closure.sql').toString('utf8');
    const definition=memoryOriginal.slice(memoryOriginal.indexOf('CREATE OR REPLACE FUNCTION public.c3_commit_conversation_memory_tx('),memoryOriginal.indexOf('-- C2 remains authoritative')).trim();
    assert.equal(after.slice(after.indexOf('-- Restore the exact original Memory RPC as well.')).trim(),'-- Restore the exact original Memory RPC as well.\n'+definition);
    const forward='supabase/migrations/20260930090000_c3_handoff_grounded_facts.sql';
    const originalForward=rawGit('show',scope.baseline_head+':'+forward).toString('utf8'),newForward=fs.readFileSync(path.join(root,forward),'utf8');
    const memoryRpc=text=>text.slice(text.indexOf('-- Extend the existing Memory authority'));
    assert.equal(memoryRpc(newForward),memoryRpc(originalForward),'accepted Memory finalisation RPC changed');
  });
  const deno=path.join(process.env.C3_TEST_TOOLS??'','node_modules/.bin/deno');assert.ok(fs.existsSync(deno),'pinned C3_TEST_TOOLS required');
  const componentFiles=['customer-quality-state','customer-money-facts','natural-customer-response','conversation-service-runtime','conversation-service-planner','conversation-long-memory','conversation-recall','conversation-recall.integration','conversation-resolution-contract','pre-send-conversion-supervisor','canonical-kb-direct-answer','natural-dialogue-generic-core'].map(name=>'supabase/functions/_shared/'+name+'.test.ts');
  const componentLog=run(deno,['test','--no-lock','--cached-only','--allow-read','--allow-env',...componentFiles],'component_regressions_only');
  report.component_count=Number(componentLog.match(/ok \| (\d+) passed \| 0 failed/)?.[1]);assert.ok(report.component_count>=380);
  run('node',['--test','.github/scripts/c3_backend_deployment_request.test.mjs'],'deployment_request_positive_and_negative_contracts');
  check('runtime_closure_jwt_import_map_and_committed_content',()=>{
    const request=backendDeploymentRequest(root,'local-contract-only');assert.equal(request.verify_jwt,true);assert.equal(request.import_map_path,'');
    report.deployment_request={function:request.name,entrypoint:request.entrypoint_path,verify_jwt:request.verify_jwt,import_map_path:request.import_map_path,source_config_retained:fs.existsSync(path.join(root,'supabase/functions/deno.json')),runtime_files:request.files.map(file=>({name:file.name,sha256:sha(file.content)}))};
    for(const file of request.files)assert.equal(file.content,rawGit('show','HEAD:supabase/functions/'+file.name).toString('utf8'));
  });
  run('node',['.github/scripts/c3_actual_handler_runtime.mjs'],'actual_handler_local_sql_full_chain');
  report.runtime=JSON.parse(fs.readFileSync(path.join(path.dirname(output),'c3-final-runtime.json')));
  check('all_runtime_assertions_executed',()=>{assert.equal(report.runtime.coverage,'actual_handler_local_sql_integration');assert.ok(Object.keys(report.runtime.assertions).length>=18);for(const [key,value] of Object.entries(report.runtime.assertions)){assert.equal(value,true,key);report.assertions[key]=true;}assert.deepEqual(report.runtime.faults,[]);});
  check('four_customer_facing_state_closure_contracts',()=>{
    for(const key of ['generic_state_acknowledgement_not_meta','no_false_customer_goal_missing','same_turn_question_resolution','no_cross_domain_recap_language','handoff_summary_structured_parity','immediate_post_KB_R1_has_no_stale_question'])assert.equal(report.runtime.assertions[key],true,key);
    assert.equal(report.runtime.summaryReadback.length,6);
    assert.ok(report.runtime.results.length>=26);
  });
  check('handoff_semantic_and_actionability_contracts',()=>{
    for(const key of ['handoff_request_not_business_goal','handoff_request_not_active_constraint','handoff_request_not_current_topic_without_business_goal','business_goal_preserved_across_r1','actionable_pending_drives_human_next_action','generic_next_action_only_when_no_actionable_pending'])assert.equal(report.runtime.assertions[key],true,key);
    for(const key of ['H1','H2','H3','H4'])assert.equal(report.runtime.handoffSemanticReadback[key].length,2,key);
  });
  check('customer_facing_recap_closure',()=>{
    assert.ok(report.runtime.recapReadback.length>=10);
    for(const key of ['customer_recap_natural_no_internal_representation','customer_recap_unseen_bilingual_shared_semantics','customer_recap_read_only_source_company_binding'])assert.equal(report.runtime.assertions[key],true,key);
  });
  run(deno,['check','--no-lock','--cached-only','supabase/functions/generate-reply/index.ts'],'deno_check');
  run(path.join(root,'node_modules/.bin/tsc'),['--noEmit'],'repository_typescript');
  const route='src/routeTree.gen.ts',routeBytes=fs.readFileSync(path.join(root,route));
  run('npm',['run','build'],'local_production_build');
  check('build_only_generated_route_tree',()=>{const modified=split(git('diff','--name-only'));assert.ok(modified.every(file=>file===route));if(modified.includes(route))fs.writeFileSync(path.join(root,route),routeBytes);});
  run('git',['diff','--check',scope.baseline_head,'HEAD'],'git_diff_check');
  check('clean_worktree_and_candidate_unchanged_after_gate',()=>{assert.equal(git('status','--porcelain','--untracked-files=all'),'');assert.equal(git('rev-parse','HEAD'),report.head);assert.equal(git('rev-parse','HEAD^{tree}'),report.tree);});
  report.status='READY FOR HOSTED ACCEPTANCE';report.exit_code=0;
}catch(error){report.status='FAIL';report.exit_code=1;report.error=error.message;process.exitCode=1;}
fs.writeFileSync(output,JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,exit_code:report.exit_code,head:report.head,tree:report.tree,assertions:report.assertions,error:report.error,result:output}));
