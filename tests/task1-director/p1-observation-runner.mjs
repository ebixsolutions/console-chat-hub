/**
 * Non-gating P1 observation executor. The original Handler source, original
 * 580 tests, application tree and external boundaries are NOT modified.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const specPath='tests/task1-director/fixtures/task3c-replay/observations-60-plus-7.json';
const spec=JSON.parse(fs.readFileSync(path.join(root,specPath),'utf8'));
if(spec.case_count!==60||spec.probe_count!==7 ||
   spec.source_tier!=='OFFLINE_SCRIPTED_NOT_REAL_MODEL_NOT_REAL_KB_NOT_HOSTED')
 throw Error('p1_observation_manifest_contract_drift');
const cases=[];
for(const entry of spec.original_25_source){
 const pkg=JSON.parse(fs.readFileSync(path.join(root,entry.path),'utf8'));
 if(pkg.profile.industry!==entry.domain||pkg.tasks.length!==5)throw Error('p1_original_seed_mismatch');
 cases.push(...pkg.tasks.map(t=>t.seed_task_id));
}
cases.push(...spec.b2b.map(t=>t.id),...spec.sourced.map(t=>t.id));
if(cases.length!==60||new Set(cases).size!==60||
   spec.probes.length!==7||new Set(spec.probes.map(x=>x.id)).size!==7)
 throw Error('p1_incomplete_case_coverage');
const digest=createHash('sha256').update(JSON.stringify({cases,probes:spec.probes})).digest('hex');
const original=path.join(root,'tests/emergency-p0/chain.test.mjs');
const temp=path.join(path.dirname(original),'.p1-observation-'+process.pid+'.test.mjs');
const extra="\nimport { registerP1ObservationCases } from '../task1-director/p1-observation-register.mjs';\n"
 +"registerP1ObservationCases({test,assert,fixture,uuid,fs,root});\n";
let result;
try{
 fs.writeFileSync(temp,fs.readFileSync(original,'utf8')+extra,{flag:'wx',mode:0o600});
 const child=spawnSync(process.execPath,['--test','--test-name-pattern=^P1-OBS',temp],
  {cwd:root,encoding:'utf8',timeout:240000,maxBuffer:32*1024*1024,env:{...process.env}});
 const lines=((child.stdout||'')+'\n'+(child.stderr||'')).split(/\r?\n/);
 const evidence=[];
 for(const line of lines){
  const at=line.indexOf('P1_OBS_RESULT|');
  if(at>=0){try{evidence.push(JSON.parse(line.slice(at+14)))}catch{}}
 }
 const fails=evidence.filter(x=>Object.values(x.modes).some(v=>v.status==='FAIL'));
 result={source:'original_unchanged_full_handler_local_isolated',
  manifest_sha256:digest,scope:'P1_INTERNAL_NON_GATING',original_cases:60,
  independent_probes:7,expected_rows:67,executed_rows:evidence.length,
  missing:67-evidence.length,observed_fail_rows:fails.map(x=>x.id),
  observed_nonfail_rows:evidence.length-fails.length,subprocess_exit:child.status,
  subprocess_signal:child.signal??null,hosted:'NOT_RUN',real_model:'NOT_RUN',
  real_kb:'NOT_RUN',quality95:'NOT_RUN',full_oracle:'NOT_PROVEN'};
 console.log('P1_OBSERVATION_RESULT|'+JSON.stringify(result));
 for(const row of evidence)console.log('P1_OBSERVATION_ROW|'+JSON.stringify(row));
 if(evidence.length!==67)console.error('P1_OBSERVATION_INCOMPLETE|expected=67|actual='+evidence.length);
}finally{
 try{fs.unlinkSync(temp)}catch{}
}
if(!result||result.executed_rows!==67)process.exitCode=1;
// Observation failure is NEVER a new gate; the original C3 unchanged
// 580-handler suite follows and alone controls its original gate result.
