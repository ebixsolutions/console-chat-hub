/** Isolated real-handler checks; the original 580-case file remains byte-identical. */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {CONTEXTUAL_GUIDANCE_CASE_IDS} from './contextual-guidance-register.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(process.argv[2]??path.join(here,'../..'));
const g1Only=process.argv.includes('--g1-only');
const ids=g1Only?CONTEXTUAL_GUIDANCE_CASE_IDS.filter(id=>id.startsWith('G1-')):CONTEXTUAL_GUIDANCE_CASE_IDS;
const pattern=g1Only?'^CTX-GUIDANCE G1-':'^CTX-GUIDANCE ';
const original=path.join(root,'tests/emergency-p0/chain.test.mjs');
const source=fs.readFileSync(original,'utf8');
const digest=text=>createHash('sha256').update(text).digest('hex');
const originalHash=digest(source);
const temporary=path.join(path.dirname(original),'.contextual-guidance-'+process.pid+'.test.mjs');
let child,records=[];
try{
 const registration=pathToFileURL(path.join(here,'contextual-guidance-register.mjs')).href;
 fs.writeFileSync(temporary,source+'\nimport {registerContextualGuidanceCases} from '+JSON.stringify(registration)+';\n'+
  'registerContextualGuidanceCases({test,assert,fixture,uuid,fs,root});\n',{flag:'wx',mode:0o600});
 child=spawnSync(process.execPath,['--test','--test-name-pattern='+pattern,temporary],
  {cwd:root,encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024,env:{...process.env}});
 for(const line of ((child.stdout??'')+'\n'+(child.stderr??'')).split(/\r?\n/)){
  const at=line.indexOf('CTX_GUIDANCE_RESULT|');
  if(at>=0){try{records.push(JSON.parse(Buffer.from(line.slice(at+'CTX_GUIDANCE_RESULT|'.length).trim(),'base64').toString('utf8')))}catch{}}
 }
}finally{try{fs.unlinkSync(temporary)}catch{}}
const actualIds=records.map(record=>record.id), unchanged=digest(fs.readFileSync(original,'utf8'))===originalHash;
const complete=ids.length===records.length&&new Set(actualIds).size===ids.length&&ids.every(id=>actualIds.includes(id));
console.log('CTX_GUIDANCE_SUMMARY|'+JSON.stringify({scope:g1Only?'G1_ONLY':'G1_R4_AND_MERCHANT_BOUNDARY',
 expected_cases:ids.length,executed_cases:records.length,missing_cases:ids.filter(id=>!actualIds.includes(id)),
 passed:records.filter(record=>record.status==='PASS').length,failed:records.filter(record=>record.status==='FAIL').map(record=>record.id),
 original_handler_suite_sha256:originalHash,original_handler_suite_unchanged:unchanged,
 subprocess_exit:child?.status??null,subprocess_signal:child?.signal??null,
 real_model:'NOT_RUN',real_kb:'NOT_RUN',hosted:'NOT_RUN'}));
for(const record of records)console.log('CTX_GUIDANCE_ROW|'+JSON.stringify(record));
if(!complete||!unchanged||child?.status!==0||records.some(record=>record.status!=='PASS')){
 if(child?.error)console.error(String(child.error));
 if(!complete)console.error(((child?.stderr??'')+'\n'+(child?.stdout??'')).slice(-9000));
 process.exitCode=1;
}
