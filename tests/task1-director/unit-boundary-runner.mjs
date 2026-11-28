import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync}from'node:child_process';
import{createHash}from'node:crypto';import{fileURLToPath,pathToFileURL}from'node:url';
import{UNIT_BOUNDARY_IDS}from'./unit-boundary-register.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(process.argv[2]??path.join(here,'../..'));
const out=path.resolve(process.argv[3]??fs.mkdtempSync(path.join(os.tmpdir(),'c3-unit-boundary-')));
fs.mkdirSync(out,{recursive:true});
if(fs.existsSync(path.join(out,'RESULTS.json')))throw Error('Preserve earlier evidence; supply a new output directory as argument 3');
const original=path.join(root,'tests/emergency-p0/chain.test.mjs'),source=fs.readFileSync(original,'utf8');
const sha=v=>createHash('sha256').update(v).digest('hex'),before=sha(source);
const temporary=path.join(path.dirname(original),'.unit-boundary-'+process.pid+'.test.mjs');
let child;const rows=[];
try{
 fs.writeFileSync(temporary,source+'\nimport{registerUnitBoundaryCases}from '+JSON.stringify(pathToFileURL(path.join(here,'unit-boundary-register.mjs')).href)+';\nregisterUnitBoundaryCases({test,assert,fixture,uuid,root});\n',{flag:'wx',mode:0o600});
 child=spawnSync(process.execPath,['--test','--test-name-pattern=^UNIT-BOUNDARY ',temporary],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024,env:{...process.env}});
 const log=(child.stdout??'')+'\n'+(child.stderr??'');fs.writeFileSync(path.join(out,'full-handler.log'),log);
 let encoded=null;
 const flush=()=>{if(encoded!==null){rows.push(JSON.parse(Buffer.from(encoded,'base64').toString('utf8')));encoded=null;}};
 for(const line of log.split(/\r?\n/)){
  const at=line.indexOf('UNIT_BOUNDARY_RESULT|');
  if(at>=0){flush();encoded=line.slice(at+'UNIT_BOUNDARY_RESULT|'.length).trim();continue;}
  // Node's TAP reporter can split one long stdout write into multiple
  // '# ' chunks. Retain all bytes rather than dropping failed-case evidence.
  if(encoded!==null&&/^# [A-Za-z0-9+/=]+$/.test(line)){encoded+=line.slice(2);continue;}
  flush();
 }
 flush();
}finally{try{fs.unlinkSync(temporary)}catch{}}
const unchanged=sha(fs.readFileSync(original,'utf8'))===before;
const complete=rows.length===UNIT_BOUNDARY_IDS.length&&new Set(rows.map(r=>r.id)).size===rows.length&&UNIT_BOUNDARY_IDS.every(id=>rows.some(r=>r.id===id));
const result={evidence_directory:out,expected:UNIT_BOUNDARY_IDS.length,executed:rows.length,passed:rows.filter(r=>r.status==='PASS').length,failed:rows.filter(r=>r.status==='FAIL').map(r=>r.id),
 subprocess_exit:child?.status??null,subprocess_signal:child?.signal??null,original_fixture_sha256:before,original_fixture_unchanged:unchanged,complete,rows};
fs.writeFileSync(path.join(out,'RESULTS.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,rows:rows.map(r=>({id:r.id,status:r.status,error:r.error,checks:r.checks.map(c=>({name:c.name,status:c.status})),first_reply:r.first?.commits?.[0]?.content,first_route:r.first?.commits?.[0]?.metadata?.response_route,followup_reply:r.followup?.commits?.[0]?.content}))}));
if(!complete||!unchanged||child?.status!==0||rows.some(r=>r.status!=='PASS'))process.exitCode=1;
