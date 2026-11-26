#!/usr/bin/env node
// Complete implementation draft; approval=null prevents active CI adjudication.
import { createHash } from "node:crypto";
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,openSync,closeSync,readSync,realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve,join,dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync,execFileSync } from "node:child_process";
function invariant(ok,reason){if(!ok)throw Error(reason)}
function key(path,name){return path+"\u0000"+name}
function parseNative(raw,exitCode,digest){
 invariant(!raw.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).some(line=>line==="error: Test failed"),"global Deno failure footer appeared on stdout");
 const lines=raw.replace(/\x1b\[[0-9;]*m/g,"").replace(/\r\n/g,"\n").split("\n");
 const summaries=lines.map((l,i)=>({i,m:l.match(/^(ok|FAILED) \| (\d+) passed(?: \((\d+) steps?\))? \| (\d+) failed(?: \((\d+) steps?\))?(?: \| (\d+) ignored)?(?: \| (\d+) filtered out)? \([^)]+\)$/)})).filter(x=>x.m);
 invariant(summaries.length===1,"missing or duplicate native summary");
 const {i:end,m}=summaries[0];const summary={pass:+m[2],passSteps:+(m[3]||0),fail:+m[4],failSteps:+(m[5]||0),ignored:+(m[6]||0),filtered:+(m[7]||0),exitCode};
 invariant(summary.pass+summary.fail>0&&summary.ignored===0&&summary.filtered===0&&summary.failSteps===0,"zero/filtered/ignored/failed-step run");
 invariant(exitCode===(summary.fail?1:0)&&m[1]===(summary.fail?"FAILED":"ok"),"native exit and summary disagree");
 const errors=lines.findIndex(l=>l.trim()==="ERRORS"), failures=lines.findIndex(l=>l.trim()==="FAILURES");
 invariant(summary.fail?errors>=0&&failures>errors&&end>failures:errors<0&&failures<0,"missing or unexpected failure sections");
 const limit=summary.fail?errors:end;
 const groups=new Map(),records=new Map();let active=null;
 for(let i=0;i<limit;i++){const l=lines[i];
   const h=l.match(/^running (\d+) tests? from \.\/([A-Za-z0-9_./-]+)$/);
   if(h){invariant(!groups.has(h[2])&&!h[2].includes(".."),"duplicate/unsafe native file");active={path:h[2],declared:+h[1],names:[]};groups.set(h[2],active);continue}
   const t=l.match(/^(\S.*?) \.\.\. (ok|FAILED|ignored)(?: \([^)]+\))?$/);
   if(t){invariant(active&&t[2]!=="ignored","unbound or ignored result");const k=key(active.path,t[1]);invariant(!records.has(k),"duplicate native test identity");records.set(k,{path:active.path,name:t[1],status:t[2]==="ok"?"PASS":"FAIL"});active.names.push(t[1]);}
   if(/^error: (?!Test failed$)/.test(l))throw Error("unscoped native error");
 }
 invariant(records.size===summary.pass+summary.fail&&groups.size>0,"native top-level count mismatch");
 for(const g of groups.values())invariant(g.names.length===g.declared&&g.declared>0,"native registration count mismatch "+g.path);
 invariant([...records.values()].filter(r=>r.status==="FAIL").length===summary.fail,"native fail count mismatch");
 const coordinate=l=>l.match(/^(.*?) => \.\/([A-Za-z0-9_./-]+):(\d+):(\d+)$/);
 if(summary.fail){
   const listed=new Map();for(const l of lines.slice(failures+1,end)){if(!l.trim())continue;const x=coordinate(l);invariant(x,"malformed native failure list");const k=key(x[2],x[1]);invariant(!listed.has(k)&&records.get(k)?.status==="FAIL","duplicate or unexpected failure list entry");listed.set(k,x[3]+":"+x[4]);}
   invariant(listed.size===summary.fail,"incomplete native failure list");
   const blocks=new Map();let current=null;for(const l of lines.slice(errors+1,failures)){
     const x=coordinate(l);if(x){const k=key(x[2],x[1]);invariant(!blocks.has(k)&&listed.has(k),"unregistered/duplicate error block");current={k,registration:x[3]+":"+x[4],error:[],stack:[]};blocks.set(k,current);continue}
     if(!l.trim())continue;
     if(/^error: /.test(l)){invariant(current,"unbound error");current.error.push(l);}
     if(/^\s+at /.test(l)&&current)current.stack.push(l);
   }
   invariant(blocks.size===summary.fail,"missing native error blocks");
   for(const [k,b] of blocks){const r=records.get(k);invariant(b.registration===listed.get(k)&&b.error.length===1,"ambiguous native failure");const sites=b.stack.map(l=>l.match(/:(\d+):(\d+)\)?$/)).filter((x,i)=>x&&b.stack[i].includes("/"+r.path+":"));invariant(sites.length>0,"failure has no same-file source location");r.fingerprint={registration:b.registration,sites:sites.map(site=>site[1]+":"+site[2]),error_sha256:digest(b.error[0])};}
 }
 invariant(!lines.slice(end+1).some(l=>/^error: (?!Test failed$)|^running \d+ tests? from |^\S.* \.\.\. (ok|FAILED|ignored)(?: \([^)]+\))?$/.test(l)),"unexpected native trailing result or error");
 return {summary,groups:[...groups.values()],records:[...records.values()]};
}

function validateNative(report,expected,digest){
 const {summary,groups,records}=report;
 invariant(expected&&summary.pass+summary.fail===expected.total&&summary.passSteps===expected.steps&&
  summary.ignored===0&&summary.filtered===0&&summary.failSteps===0&&summary.exitCode===(summary.fail?1:0),"native counts/exit drift");
 const inventory=Object.fromEntries(groups.map(g=>[g.path,{count:g.declared,names_sha256:digest(JSON.stringify([...g.names].sort()))}]));
 invariant(Object.keys(inventory).length===groups.length&&Object.keys(inventory).length===Object.keys(expected.files).length,"native module drift");
 for(const [path,v] of Object.entries(expected.files))invariant(inventory[path]?.count===v.count&&inventory[path]?.names_sha256===v.names_sha256,"native name inventory drift "+path);
 const keys=new Set(groups.flatMap(g=>g.names.map(n=>key(g.path,n))));
 const actual=new Set(records.map(r=>key(r.path,r.name)));
 invariant(records.length===expected.total&&actual.size===records.length&&keys.size===records.length&&records.every(r=>keys.has(key(r.path,r.name))&&["PASS","FAIL"].includes(r.status))&&records.filter(r=>r.status==="FAIL").length===summary.fail,"native identity or status drift");
 return report;
}
function parseHandler(raw,exit,expected,digest){
 invariant(exit===0,"Handler exit not zero");
 const l=raw.replace(/\x1b\[[0-9;]*m/g,"").split(/\r?\n/);
 const number=label=>{const a=l.filter(x=>new RegExp("^# "+label+" [0-9]+$").test(x));invariant(a.length===1,"Handler summary "+label);return +a[0].split(" ").at(-1)};
 const names=l.flatMap(x=>{const m=x.match(/^ok (\d+) - (.+)$/);return m?[{index:+m[1],name:m[2]}]:[]});
 invariant(number("tests")===expected.total&&number("pass")===expected.total&&["fail","cancelled","skipped","todo"].every(x=>number(x)===0)&&names.length===expected.total&&new Set(names.map(x=>x.index)).size===expected.total&&names.every(x=>x.index>=1&&x.index<=expected.total)&&digest(JSON.stringify(names.map(x=>x.name).sort()))===expected.names_sha256,"Handler full inventory/status mismatch");
 return names.map(x=>x.name);
}
function parseRunner(raw,exit,expected,handlerHash){
 invariant(exit===0,"required auxiliary runner exit not zero");
 const l=raw.split(/\r?\n/),p=expected.prefix;
 const s=l.filter(x=>x.startsWith(p+"_SUMMARY|"));invariant(s.length===1,"runner summary missing/duplicate");
 const q=JSON.parse(s[0].slice((p+"_SUMMARY|").length));
 const rows=l.filter(x=>x.startsWith(p+"_ROW|")).map(x=>JSON.parse(x.slice((p+"_ROW|").length)));
 invariant(q.expected_cases===expected.ids.length&&q.executed_cases===expected.ids.length&&q.passed===expected.ids.length&&Array.isArray(q.failed)&&!q.failed.length&&q.original_handler_suite_unchanged===true&&q.original_handler_suite_sha256===handlerHash&&q.subprocess_exit===0&&q.subprocess_signal===null&&["real_model","real_kb","hosted"].every(k=>q[k]==="NOT_RUN"),"runner summary invalid");
 invariant(rows.length===expected.ids.length&&new Set(rows.map(r=>r.id)).size===rows.length&&expected.ids.every(id=>rows.some(r=>r.id===id&&r.status==="PASS")),"runner row missing or failed");
 return rows.map(r=>r.id);
}
function adjudicate(reports,aux,policy,ids,requiredGroups,digest){
 invariant(Object.keys(reports).sort().join("|")===requiredGroups.slice().sort().join("|"),"native group missing/extra");
 const allApproved=policy.candidates.filter(r=>ids.includes(r.id));
 invariant(allApproved.length===ids.length&&new Set(ids).size===ids.length,"unknown or duplicate approval");
 const allDeclaredPaths=new Set(Object.values(policy.groups).flatMap(group=>Object.keys(group.files)));
 invariant(allApproved.every(row=>allDeclaredPaths.has(row.path)),"approved original has no declared group");
 const applicablePaths=new Set(requiredGroups.flatMap(group=>Object.keys(policy.groups[group].files)));
 const approved=allApproved.filter(row=>applicablePaths.has(row.path));
 const union=new Map(),occurrences=[];
 for(const group of requiredGroups){
  const r=validateNative(reports[group],policy.groups[group],digest);
  for(const t of r.records){const k=key(t.path,t.name),prev=union.get(k);invariant(!prev||JSON.stringify(prev)===JSON.stringify(t),"cross-group disagreement "+t.name);union.set(k,t);if(t.status==="FAIL")occurrences.push({group,...t});}
 }
 const auxiliaryOK=Boolean(aux&&aux.verified===true&&["handler","guidance","retention"].every(k=>Array.isArray(aux[k]))&&
  aux.handler.length===policy.aux.handler.total&&digest(JSON.stringify([...aux.handler].sort()))===policy.aux.handler.names_sha256&&
  ["guidance","retention"].every(k=>aux[k].length===policy.aux[k].ids.length&&new Set(aux[k]).size===aux[k].length&&policy.aux[k].ids.every(id=>aux[k].includes(id))));
 const lookup=t=>t.kind==="native"?union.get(key(t.path,t.name))?.status==="PASS":
  auxiliaryOK&&aux[t.kind].filter(n=>n===t.name).length===1;
 const byKey=new Map(approved.map(r=>[key(r.path,r.name),r]));
 const parked=[],blocking=[],recovered=[],recoveredBlockers=[];
 for(const [k,r] of union){if(r.status!=="FAIL")continue;const a=byKey.get(k);
  if(!a){blocking.push({path:r.path,name:r.name,reason:"UNAPPROVED_FAILURE"});continue}
  if(JSON.stringify(a.fingerprint)!==JSON.stringify(r.fingerprint)){blocking.push({id:a.id,reason:"CHANGED_FAILURE_SIGNATURE"});continue}
  if(!Array.isArray(a.twins)||a.twins.length===0){blocking.push({id:a.id,reason:"REPLACEMENT_MAPPING_MISSING"});continue}
  const strict=requiredGroups.some(group=>policy.groups[group].exception_policy==="NONE"&&reports[group].records.some(t=>key(t.path,t.name)===k));if(strict){blocking.push({id:a.id,reason:"STRICT_GROUP_FAILURE_CANNOT_BE_EXCEPTED"});continue}
  const missing=a.twins.filter(t=>!lookup(t));if(missing.length){blocking.push({id:a.id,reason:"REPLACEMENT_MISSING_OR_FAILED",missing});continue}
  parked.push({id:a.id,path:r.path,name:r.name,status:policy.mode==="OWNER_APPROVED_EFFECTIVE"?"EXECUTED_FAIL_APPROVED_EXCEPTION":"CANDIDATE_EXECUTED_FAIL_NOT_EFFECTIVE",counted_as_pass:false});
 }
 for(const a of approved){const r=union.get(key(a.path,a.name));invariant(r,"approved original missing from joint group");if(r.status==="PASS"){recovered.push(a.id);if(!Array.isArray(a.twins)||a.twins.length===0){recoveredBlockers.push({id:a.id,reason:"RECOVERED_ORIGINAL_REPLACEMENT_MAPPING_MISSING"});continue}const missing=a.twins.filter(t=>!lookup(t));if(missing.length)recoveredBlockers.push({id:a.id,reason:"RECOVERED_ORIGINAL_REPLACEMENT_MISSING_OR_FAILED",missing});}}
 const distinctFailures=[...union.values()].filter(r=>r.status==="FAIL").length;
 invariant(distinctFailures===parked.length+blocking.length,"failure partition incomplete");
 blocking.push(...recoveredBlockers);
 if(!auxiliaryOK)blocking.push({reason:"REQUIRED_HANDLER_G_K_RECEIPT_MISSING"});
 const effective=policy.mode==="OWNER_APPROVED_EFFECTIVE",candidateExit=blocking.length?1:0;
 return {raw:requiredGroups.map(group=>({group,...reports[group].summary})),executed_unique:union.size,failed_unique:distinctFailures,failed_occurrences:occurrences.length,parked,blocking,recovered,candidate_adjudicated_exit:candidateExit,adjudicated_exit:(!effective&&distinctFailures)||candidateExit?1:0,scope_status:blocking.length?"FAIL":parked.length?(effective?"ACCEPTED_WITH_EXECUTED_EXCEPTIONS":"REVIEW_ONLY_RAW_FAILURES_RETAINED"):"PASS_NATIVE",formal_uat_acceptance:false};
}



const digest = value => createHash("sha256").update(value).digest("hex");
const git = (root,...args)=>execFileSync("git",args,{cwd:root,encoding:"utf8",timeout:15000}).trim();
const cleanText = bytes => new TextDecoder("utf-8",{fatal:true}).decode(bytes).replace(/\x1b\[[0-9;]*m/g,"").replace(/\r\n/g,"\n");
function assertNativeStderr(raw,report,expected,cwd){
 const lines=cleanText(raw).split("\n").filter(line=>line!=="");
 const paths=Object.keys(expected.files),checkLines=new Map(),seen=new Map();
 for(const path of paths){
  invariant(path&&!path.startsWith("/")&&!path.split("/").includes(".."),"unsafe diagnostic test path");
  const line=expected.native_deno_version==="2.5.0"?"Check "+pathToFileURL(resolve(cwd,path)).href:"Check "+path;
  checkLines.set(line,path);
 }
 const extras=expected.stderr?.reviewed_exact_diagnostics??{};
 invariant(extras&&typeof extras==="object"&&!Array.isArray(extras),"invalid diagnostic allowlist");
 const sources=expected.stderr?.reviewed_diagnostic_sources??{};
 const sourceFor=entry=>entry?.source?sources[entry.source]:entry;
 const validSource=entry=>entry&&/^[0-9a-f]{64}$/.test(entry.evidence_stderr_sha256??"")&&/^[0-9a-f]{40}$/.test(entry.evidence_head??"")&&entry.native_deno_version===expected.native_deno_version;
 const notices=expected.stderr?.reviewed_nonfatal_dependency_notices??[];
 invariant(Array.isArray(notices),"invalid dependency notice list");
 let footer=0;const diagnostics=[];
 for(let index=0;index<lines.length;index++){const line=lines[index];
  if(line==="error: Test failed"){footer++;continue}
  if(checkLines.has(line)){
   const path=checkLines.get(line),count=(seen.get("check:"+path)||0)+1;seen.set("check:"+path,count);
   invariant(count===1,"duplicate native Check diagnostic");diagnostics.push({kind:"CHECK_INPUT",path,line});continue;
  }
  if(line==="╭ Warning"){
   const matching=notices.filter(n=>{
    if(!Array.isArray(n.lines)||n.lines.length<=4)return false;
    const actual=lines.slice(index,index+n.lines.length);
    if(n.dependency_record_order!=="UNORDERED_EXACT_RECORD_SET")return n.lines.every((l,i)=>actual[i]===l);
    return actual.length===n.lines.length&&n.lines.slice(0,3).every((l,i)=>actual[i]===l)&&actual.at(-1)===n.lines.at(-1)&&JSON.stringify(actual.slice(3,-1).sort())===JSON.stringify(n.lines.slice(3,-1).sort());
   });
   invariant(matching.length===1,"unreviewed dependency warning block");const notice=matching[0],source=sourceFor(notice);
   invariant(notice.kind==="NONFATAL_DEPENDENCY_NOTICE"&&validSource(source)&&notice.max_occurrences===1&&notice.lines[0]==="╭ Warning"&&notice.lines[1]==="│"&&notice.lines[2]==="│  The following packages are deprecated:"&&notice.lines.at(-1)==="╰─"&&Array.isArray(notice.dependencies)&&notice.dependencies.length===notice.lines.length-4,"invalid dependency notice contract");
   const middle=notice.lines.slice(3,-1);
   invariant(notice.dependencies.every((dependency,i)=>typeof dependency==="string"&&/^(@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+@[0-9][A-Za-z0-9_.+-]*$/.test(dependency)&&middle[i].startsWith("│  npm:"+dependency+" (")&&middle[i].endsWith(")")&&!/[\r\n]/.test(middle[i]))&&new Set(notice.dependencies).size===notice.dependencies.length,"dependency notice identity drift");
   const noticeKey="notice:"+digest(notice.lines.slice(3,-1).sort().join("\n")),count=(seen.get(noticeKey)||0)+1;seen.set(noticeKey,count);invariant(count===1,"duplicate dependency notice");
   diagnostics.push({kind:"REVIEWED_NONFATAL_DEPENDENCY_NOTICE",lines:lines.slice(index,index+notice.lines.length),dependencies:notice.dependencies,evidence_stderr_sha256:source.evidence_stderr_sha256});index+=notice.lines.length-1;continue;
  }
  const extra=extras[line];
  const source=sourceFor(extra);
  invariant(extra&&Number.isInteger(extra.max_occurrences)&&extra.max_occurrences>0&&validSource(source),
    "unreviewed native stderr: "+line);
  invariant(/^(?:Download https:\/\/\S+|Initialize [@A-Za-z0-9][@A-Za-z0-9._/+:-]*)$/.test(line),"only exact observed Download/Initialize diagnostics may be admitted; errors/warnings forbidden");
  const count=(seen.get("extra:"+line)||0)+1;seen.set("extra:"+line,count);
  invariant(count<=extra.max_occurrences,"native diagnostic occurrence drift");diagnostics.push({kind:"REVIEWED_EXACT_DIAGNOSTIC",line,evidence_stderr_sha256:source.evidence_stderr_sha256});
 }
 invariant(footer===(report.summary.fail>0?1:0),"native stderr failure footer count disagrees with stdout/exit");
 return {footer_count:footer,diagnostics};
}
function assertAuxStderr(raw,expected){
 const lines=cleanText(raw).split("\n").filter(Boolean),allowed=expected.reviewed_stderr_exact_lines??[];
 invariant(lines.every(line=>allowed.includes(line)),"unreviewed auxiliary stderr");
 return {diagnostics:lines};
}
function sameIdentity(actual,expected,{strictRun=false,job=null}={}){
 invariant(actual&&actual.head===expected.head&&actual.tree===expected.tree&&actual.policy_sha256===expected.policy_sha256,"receipt source/policy mismatch");
 if(strictRun)invariant(actual.run===expected.run&&actual.attempt===expected.attempt&&actual.execution_class==="GITHUB_NATIVE_CHECKED_COMMAND","receipt run/attempt/class mismatch");
 if(job)invariant(actual.job===job,"receipt job mismatch");
}
function captureProcess(id,cmd,args,cwd,evidenceDir,identity,{timeout=240000,extraEnv={}}={}){
 invariant(/^[a-z0-9][a-z0-9-]*$/.test(id),"unsafe receipt id");mkdirSync(evidenceDir,{recursive:true});
 const outPath=join(evidenceDir,id+".stdout.log"),errPath=join(evidenceDir,id+".stderr.log");
 const outFd=openSync(outPath,"wx"),errFd=openSync(errPath,"wx");let r;
 try{r=spawnSync(cmd,args,{cwd,stdio:["ignore",outFd,errFd],timeout,env:{...process.env,...extraEnv,NO_COLOR:"1",CI:"true"}})}finally{closeSync(outFd);closeSync(errFd)}
 const stdout=readFileSync(outPath),stderr=readFileSync(errPath);
 const receipt={schema_version:3,id,identity,cmd,args,cwd,exit:r.status,signal:r.signal??null,error:r.error?.message??null,
  stdout:{file:id+".stdout.log",bytes:stdout.length,sha256:digest(stdout)},stderr:{file:id+".stderr.log",bytes:stderr.length,sha256:digest(stderr)}};
 writeFileSync(join(evidenceDir,id+".process.json"),JSON.stringify(receipt,null,2)+"\n",{flag:"wx"});
 process.stdout.write(stdout);process.stderr.write(stderr);
 return {stdout,stderr,receipt};
}
function validateProcess(receipt){invariant(!receipt.error&&!receipt.signal&&Number.isInteger(receipt.exit),"runner error/timeout/signal");}
function readCaptured(dir,id,expectedArgs,cmd,identity,options={}){
 const p=JSON.parse(readFileSync(join(dir,id+".process.json"),"utf8"));
 invariant(p.schema_version===3&&p.id===id&&p.cmd===cmd&&JSON.stringify(p.args)===JSON.stringify(expectedArgs),"process command receipt mismatch "+id);
 validateProcess(p);sameIdentity(p.identity,identity,options);
 invariant(p.stdout?.file===id+".stdout.log"&&p.stderr?.file===id+".stderr.log","stream path mismatch");
 const stdout=readFileSync(join(dir,p.stdout.file)),stderr=readFileSync(join(dir,p.stderr.file));
 for(const [name,bytes] of [["stdout",stdout],["stderr",stderr]])invariant(p[name].bytes===bytes.length&&p[name].sha256===digest(bytes),"stream hash/size mismatch "+id+" "+name);
 return {stdout,stderr,receipt:p};
}
function nativeBinary(version,mode){
 const envName="C3_REVIEW_DENO_"+version.replaceAll(".","_");
 const command=mode==="review"&&process.env[envName]?process.env[envName]:execFileSync("which",["deno"],{encoding:"utf8"}).trim();
 const binary=realpathSync(command),fd=openSync(binary,"r"),magic=Buffer.alloc(4);try{readSync(fd,magic,0,4,0)}finally{closeSync(fd)}
 invariant(magic.equals(Buffer.from([0x7f,0x45,0x4c,0x46])),"native Linux Deno binary required; wrappers/stand-ins forbidden");
 const actual=execFileSync(binary,["--version"],{encoding:"utf8",timeout:15000}).split("\n")[0];
 invariant(actual==="deno "+version||actual.startsWith("deno "+version+" "),"Deno version drift");
 return {binary,version:actual,binary_sha256:digest(readFileSync(binary))};
}
function parseNativeCapture(captured,expected,cwd){
 validateProcess(captured.receipt);
 const report=validateNative(parseNative(cleanText(captured.stdout),captured.receipt.exit,digest),expected,digest);
 const streams=assertNativeStderr(captured.stderr,report,expected,cwd);
 return {report,streams};
}
function collectNativeGroups(groupNames,root,policy,mode,evidenceDir,identity){
 const reports={},errors=[];
 for(const group of groupNames){let engine=null,captured=null;
  try{
   const expected=policy.groups[group];invariant(expected,"native group undefined");
   engine=nativeBinary(expected.native_deno_version,mode);
   captured=captureProcess(group,engine.binary,expected.args,root,evidenceDir,identity);
   writeFileSync(join(evidenceDir,group+".engine.json"),JSON.stringify({identity,...engine,command:captured.receipt},null,2)+"\n",{flag:"wx"});
   const parsed=parseNativeCapture(captured,expected,root);reports[group]=parsed.report;
   writeFileSync(join(evidenceDir,group+".native-receipt.json"),JSON.stringify({identity,group,command:captured.receipt,engine,streams:parsed.streams,report:parsed.report},null,2)+"\n",{flag:"wx"});
  }catch(error){
   const failure={group,reason:error.message,executed:Boolean(captured),raw_exit:captured?.receipt.exit??null};errors.push(failure);
   writeFileSync(join(evidenceDir,group+".rejected.json"),JSON.stringify({identity,...failure,engine,command:captured?.receipt??null},null,2)+"\n",{flag:"wx"});
  }
 }
 return {reports,errors};
}
function groupAdjudication(collected,aux,policy,ids,requiredGroups){
 if(collected.errors.length||requiredGroups.some(group=>!collected.reports[group]))return {raw:requiredGroups.map(group=>({group,...collected.reports[group]?.summary,executed:!!collected.reports[group]})),blocking:collected.errors,adjudicated_exit:1,scope_status:"FAIL",formal_uat_acceptance:false};
 return adjudicate(collected.reports,aux,policy,ids,requiredGroups,digest);
}
const CI_PATHS=Object.freeze({checker:".github/scripts/c3_named_legacy_checker.mjs",policy:".github/scripts/c3_named_legacy_policy.json",workflow:".github/workflows/task-ai-abc-c3-final-gate.yml",isolated:".github/scripts/c3_director_generic_core_final_gate.mjs",profile:".github/scripts/c3_unified_production_profile.json",gate:".github/scripts/c3_unified_production_source_gate.mjs"});
const CURRENT_MAP="authorized_task3c_d4_no_industry_sha256";
function replaceJSONValue(raw,keys,replacement){
 JSON.parse(raw);const hits=[];
 const ws=i=>{while(/\s/.test(raw[i]??"")&&i<raw.length)i++;return i;};
 const stringEnd=i=>{i++;while(i<raw.length){if(raw[i]==="\\"){i+=2;continue}if(raw[i]==='"')return i+1;i++}throw Error("unterminated JSON string");};
 function walk(index,path){let i=ws(index),start=i;
  if(raw[i]==="{"){i=ws(i+1);const seen=new Set();while(raw[i]!=="}"){const keyStart=i,keyEnd=stringEnd(i),key=JSON.parse(raw.slice(keyStart,keyEnd));invariant(!seen.has(key),"duplicate JSON property");seen.add(key);i=ws(keyEnd);invariant(raw[i]===":","JSON colon missing");i=ws(walk(i+1,[...path,key]));if(raw[i]===",")i=ws(i+1);else break;}invariant(raw[i]==="}","JSON object unclosed");i++;}
  else if(raw[i]==="["){i=ws(i+1);let n=0;while(raw[i]!=="]"){i=ws(walk(i,[...path,String(n++)]));if(raw[i]===",")i=ws(i+1);else break;}invariant(raw[i]==="]","JSON array unclosed");i++;}
  else if(raw[i]==='"')i=stringEnd(i);
  else{while(i<raw.length&&!/[\s,}\]]/.test(raw[i]))i++;}
  if(JSON.stringify(path)===JSON.stringify(keys))hits.push([start,i]);return i;
 }
 invariant(ws(walk(0,[]))===raw.length&&hits.length===1,"JSON value pin location missing/duplicate");
 return raw.slice(0,hits[0][0])+JSON.stringify(replacement)+raw.slice(hits[0][1]);
}
function gateMap(raw){const matches=[...raw.matchAll(/^const TASK3C_D4_NO_INDUSTRY_SOURCE=Object\.freeze\((\{.*\})\);$/gm)];invariant(matches.length===1,"current source map constant missing/duplicate");const m=matches[0];return {json:m[1],start:m.index+m[0].indexOf(m[1]),end:m.index+m[0].indexOf(m[1])+m[1].length};}
function normalizePayload(path,raw){
 if(path===CI_PATHS.policy)return replaceJSONValue(replaceJSONValue(replaceJSONValue(raw,["approval"],"__APPROVAL_FIELDS__"),["mode"],"__ACTIVATION_MODE__"),["reviewed_payload_sha256"],"__PAYLOAD_PINS__");
 if(path===CI_PATHS.profile)return replaceJSONValue(raw,[CURRENT_MAP,CI_PATHS.policy],"__ACTIVATED_POLICY_SHA256__");
 if(path===CI_PATHS.gate){const m=gateMap(raw);return raw.slice(0,m.start)+replaceJSONValue(m.json,[CI_PATHS.policy],"__ACTIVATED_POLICY_SHA256__")+raw.slice(m.end);}
 return raw;
}
function verifyPayloadPins(contents,policy,{effective=false}={}){
 const paths=Object.values(CI_PATHS).sort(),pins=policy.reviewed_payload_sha256;
 invariant(pins&&JSON.stringify(Object.keys(pins).sort())===JSON.stringify(paths)&&JSON.stringify(Object.keys(contents).sort())===JSON.stringify(paths),"six reviewed payload pins missing/extra");
 for(const path of paths)invariant(/^[0-9a-f]{64}$/.test(pins[path])&&digest(normalizePayload(path,contents[path]))===pins[path],"reviewed payload byte drift: "+path);
 const payloadDigest=digest(JSON.stringify(Object.fromEntries(Object.entries(pins).sort(([a],[b])=>a.localeCompare(b)))));
 if(effective)invariant(policy.approval?.reviewed_payload_digest===payloadDigest,"Owner reviewed payload digest missing/mismatch");
 return payloadDigest;
}
function verifyControlMaps(contents,baseProfile,baseGate){
 const actualProfile=contents[CI_PATHS.profile],actualGate=contents[CI_PATHS.gate];
 invariant(replaceJSONValue(actualProfile,[CURRENT_MAP],"__CURRENT_MAP__")===replaceJSONValue(baseProfile,[CURRENT_MAP],"__CURRENT_MAP__"),"profile change outside existing current map");
 const a=gateMap(actualGate),b=gateMap(baseGate);
 invariant(actualGate.slice(0,a.start)+"__CURRENT_MAP__"+actualGate.slice(a.end)===baseGate.slice(0,b.start)+"__CURRENT_MAP__"+baseGate.slice(b.end),"source gate change outside existing current map");
 const current=JSON.parse(actualProfile)[CURRENT_MAP],base=JSON.parse(baseProfile)[CURRENT_MAP],constant=JSON.parse(a.json);
 invariant(JSON.stringify(current)===JSON.stringify(constant),"profile/source current-map mismatch");
 const changed=[CI_PATHS.checker,CI_PATHS.policy,CI_PATHS.workflow,CI_PATHS.isolated];
 invariant(JSON.stringify(Object.keys(current).sort())===JSON.stringify([...new Set([...Object.keys(base),...changed])].sort()),"current-map path scope drift");
 for(const [path,sha] of Object.entries(base))if(!changed.includes(path))invariant(current[path]===sha,"functional/historical pin changed: "+path);
 for(const path of changed)invariant(current[path]===digest(contents[path]),"current-map CI byte hash mismatch: "+path);
}


// P1 diagnostic-only continuation. Never adjudicates a named exception on an
// unapproved functional head. The original strict modes below are unchanged.
const P1_POLICY_SHA256="6894280fe1eae944f330ef930d4b6465bb5c268c4ae8ec469e2e77c4ba7d23ef";
const P1_BASE="f1e67f96d764944c6ee6c7ec097b3eeaded2ccf5";
const P1_MISMATCH="C3_NAMED_LEGACY_FAIL: approved CI exact-path scope mismatch";
function p1RunnerEnv(env,head,job){
 return env.GITHUB_ACTIONS==="true"&&env.GITHUB_REPOSITORY==="ebixsolutions/console-chat-hub"&&
 env.GITHUB_REF==="refs/heads/director/ai-abc-c3-long-memory-final-cutover"&&env.GITHUB_EVENT_NAME==="push"&&
 env.GITHUB_SHA===head&&env.GITHUB_JOB===job&&env.C3_P1_OFFLINE_RESULT==="success"&&
 /^\d+$/.test(env.GITHUB_RUN_ID??"")&&/^\d+$/.test(env.GITHUB_RUN_ATTEMPT??"")&&
 !["SUPABASE_ACCESS_TOKEN","SUPABASE_SERVICE_ROLE_KEY","SUPABASE_DB_URL","DATABASE_URL","GOOGLE_APPLICATION_CREDENTIALS","OPENAI_API_KEY","ANTHROPIC_API_KEY","VERTEX_API_KEY","GEMINI_API_KEY","KB_API_KEY","KB_SERVICE_KEY"].some(k=>Boolean(env[k]));
}
function p1Identity(actual,expected,job){
 return actual&&["head","tree","run","attempt","policy_sha256"].every(k=>actual[k]===expected[k])&&
 actual.job===job&&actual.execution_class==="GITHUB_P1_DIAGNOSTIC_ONLY";
}
function p1StrictMismatch(c){
 return c.receipt.exit===1&&!c.receipt.error&&!c.receipt.signal&&c.stdout.length===0&&cleanText(c.stderr).trim()===P1_MISMATCH;
}
function p1ReadAdmission(dir,identity){
 const a=JSON.parse(readFileSync(join(dir,"admission.json"),"utf8"));
 invariant(p1Identity(a.identity,identity,"c3-preproduction"),"P1 prior admission identity mismatch");
 const p=JSON.parse(readFileSync(join(dir,"strict-aux.process.json"),"utf8"));
 invariant(p1Identity(p.identity,identity,"c3-preproduction")&&p.id==="strict-aux"&&/(?:^|\/)node(?:\.exe)?$/.test(p.cmd),"P1 prior process identity mismatch");
 const expected=[join(p.cwd,CI_PATHS.checker),"ci-aux",join(p.cwd,CI_PATHS.policy),p.cwd,a.strict_dir];
 invariant(JSON.stringify(p.args)===JSON.stringify(expected)&&typeof a.strict_dir==="string"&&a.strict_dir.endsWith("/c3-named-legacy-evidence"),"P1 prior strict argv mismatch");
 const c=readCaptured(dir,"strict-aux",expected,p.cmd,identity);
 invariant(p1StrictMismatch(c)&&a.strict_receipt_sha256===digest(readFileSync(join(dir,"strict-aux.process.json"))),"P1 prior strict failure mismatch");
 const aux=JSON.parse(readFileSync(join(dir,"aux-completion.json"),"utf8"));
 invariant(p1Identity(aux.identity,identity,"c3-preproduction")&&JSON.stringify(aux.commands.map(x=>x.id))===JSON.stringify(["handler","guidance","retention"]),"P1 prior aux coverage mismatch");
 for(const row of aux.commands){
  invariant(row.receipt_sha256===digest(readFileSync(join(dir,row.id+".process.json"))),"P1 auxiliary receipt hash drift");
  const q=JSON.parse(readFileSync(join(dir,row.id+".process.json"),"utf8"));
  invariant(p1Identity(q.identity,identity,"c3-preproduction")&&q.id===row.id,"P1 auxiliary identity drift");
  for(const k of ["stdout","stderr"]){const b=readFileSync(join(dir,row.id+"."+k+".log"));invariant(q[k].file===row.id+"."+k+".log"&&q[k].bytes===b.length&&q[k].sha256===digest(b),"P1 auxiliary stream drift")}
 }
 return a;
}
async function p1Diagnostic({mode,policyPath,policy,root,evidenceDir,identity,ppGroups,isolatedGroups}){
 const isolated=mode==="ci-p1-isolated",aux=mode==="ci-p1-aux",job=isolated?"c3-director-generic-core-isolated-final":"c3-preproduction";
 const strict=aux?"ci-aux":isolated?"ci-isolated":"ci-preproduction";
 const workspace=resolve(process.env.GITHUB_WORKSPACE??root);
 const runner=resolve(process.env.RUNNER_TEMP??"");
 invariant(process.env.RUNNER_TEMP&&process.env.GITHUB_WORKSPACE,"P1 runner paths required");
 const diag=join(runner,isolated?"c3-p1-diagnostic-isolated":"c3-p1-diagnostic-preproduction");
 const prior=join(runner,"c3-p1-diagnostic-preproduction");
 invariant(policyPath===join(workspace,CI_PATHS.policy)&&resolve(process.argv[1])===join(workspace,CI_PATHS.checker),"P1 exact checker/policy paths required");
 invariant(root===(aux||isolated?workspace:join(runner,"c3-deno-checkout"))&&evidenceDir===join(runner,isolated?"c3-named-legacy-isolated":"c3-named-legacy-evidence"),"P1 exact checkout/evidence paths required");
 const id={...identity,execution_class:"GITHUB_P1_DIAGNOSTIC_ONLY"};
 // A normal strict run is still authoritative. Capture the original process
 // without intercepting or rewriting its own output/exit or approval logic.
 mkdirSync(diag,{recursive:true});
 const argv=[resolve(process.argv[1]),strict,policyPath,root,evidenceDir,...(isolated?[resolve(process.argv[6]??"")]:[])];
 const c=captureProcess("strict-"+(aux?"aux":isolated?"isolated":"preproduction"),process.execPath,argv,root,diag,id,{timeout:1100000});
 if(c.receipt.exit===0&&!c.receipt.error&&!c.receipt.signal){invariant(!isolated,"P1 diagnostic isolated unexpectedly accepted");return}
 invariant(p1StrictMismatch(c),"P1 strict failure is not the exact approved-scope mismatch");
 invariant(p1RunnerEnv(process.env,identity.head,job),"P1 diagnostic runner/credential boundary rejected");
 invariant(identity.policy_sha256===P1_POLICY_SHA256&&digest(readFileSync(join(root,CI_PATHS.policy)))===P1_POLICY_SHA256,"P1 immutable policy drift");
 invariant(git(root,"merge-base",identity.head,P1_BASE)===P1_BASE&&git(root,"merge-base",identity.head,policy.functional_head)===policy.functional_head&&git(root,"rev-parse",policy.functional_head+"^{tree}")===policy.functional_tree,"P1 lineage rejected");
 const diff=git(root,"diff","--name-only",policy.functional_head,identity.head).split("\n").filter(Boolean).sort();
 invariant(JSON.stringify(diff)!==JSON.stringify([...policy.allowed_ci_paths].sort()),"P1 mismatch not independently reproduced");
 invariant(git(root,"diff","--name-only","HEAD")===""&&git(root,"diff","--cached","--name-only","HEAD")==="","P1 tracked source dirty");
 const {verifyProductionSource}=await import(pathToFileURL(join(root,CI_PATHS.gate)).href);
 const source=verifyProductionSource({root,expectedIdentity:{head:identity.head,tree:identity.tree}});
 invariant(source.status==="SOURCE_VALIDATED"&&source.uat_start_allowed===false,"P1 source identity not validated");
 if(isolated){
  invariant(process.env.C3_EXISTING_C3_PREPRODUCTION_RESULT==="failure"&&resolve(process.argv[6]??"")===prior,"P1 actual failed dependency required");
  const db=new URL(process.env.C3_ISOLATED_DB_URL??"");
  invariant(["postgres:","postgresql:"].includes(db.protocol)&&["127.0.0.1","localhost"].includes(db.hostname)&&db.port==="5432"&&db.pathname==="/c3closure","P1 nonlocal database rejected");
  p1ReadAdmission(prior,id);
 }else if(!aux){p1ReadAdmission(diag,id)}
 if(aux){
  writeFileSync(join(diag,"admission.json"),JSON.stringify({identity:id,strict_dir:evidenceDir,strict_receipt_sha256:digest(readFileSync(join(diag,"strict-aux.process.json"))),disposition:"DIAGNOSTIC_ONLY_STRICT_FAIL"},null,2)+"\n",{flag:"wx"});
  const commands=[];
  for(const name of ["handler","guidance","retention"]){
   const x=captureProcess(name,process.execPath,policy.aux[name].args,root,diag,id);
   commands.push({id:name,exit:x.receipt.exit,signal:x.receipt.signal,error:x.receipt.error,receipt_sha256:digest(readFileSync(join(diag,name+".process.json")))});
  }
  writeFileSync(join(diag,"aux-completion.json"),JSON.stringify({identity:id,commands,acceptance:false},null,2)+"\n",{flag:"wx"});
 }else{
  const groups=isolated?isolatedGroups:ppGroups;
  const collected=collectNativeGroups(groups,root,policy,mode,diag,id);
  writeFileSync(join(diag,isolated?"isolated-completion.json":"preproduction-completion.json"),JSON.stringify({identity:id,groups,raw:collected.reports,errors:collected.errors,acceptance:false},null,2)+"\n",{flag:"wx"});
 }
 console.log(JSON.stringify({disposition:"DIAGNOSTIC_ONLY_STRICT_FAIL",identity:id,mode,acceptance:false}));
}

async function main(){
 const mode=process.argv[2],policyPath=resolve(process.argv[3]||"");
 const policy=JSON.parse(readFileSync(policyPath,"utf8")),root=resolve(process.argv[4]||process.cwd());
 const evidenceDir=resolve(process.argv[5]||mkdtempSync(join(tmpdir(),"c3-legacy-streams-")));
 mkdirSync(evidenceDir,{recursive:true});
 const head=git(root,"rev-parse","HEAD"),tree=git(root,"rev-parse","HEAD^{tree}");
 const identity={head,tree,run:process.env.GITHUB_RUN_ID??null,attempt:process.env.GITHUB_RUN_ATTEMPT??null,job:process.env.GITHUB_JOB??null,policy_sha256:digest(readFileSync(policyPath)),execution_class:mode==="review"?"LOCAL_CHECKED_NATIVE_REVIEW_NOT_CI":"GITHUB_NATIVE_CHECKED_COMMAND"};
 const ppGroups=["preproduction","current-factual"],isolatedGroups=["isolated-generic","isolated-compound","isolated-contextual","isolated-recall"];
 if(["ci-p1-aux","ci-p1-preproduction","ci-p1-isolated"].includes(mode)){await p1Diagnostic({mode,policyPath,policy,root,evidenceDir,identity,ppGroups,isolatedGroups});return;}
 function checkSource(){
  invariant(policy.schema_version===3,"policy version");
  invariant(git(root,"rev-parse",policy.functional_head+"^{tree}")===policy.functional_tree,"functional base tree mismatch");
  invariant(policy.groups["current-factual"].exception_policy==="NONE","additional factual group must remain strict");
  if(mode==="review")invariant(head===policy.functional_head&&tree===policy.functional_tree,"review exact functional source required");
  else{
   invariant(policy.mode==="OWNER_APPROVED_EFFECTIVE"&&policy.approval&&/^[0-9a-f]{40}$/.test(policy.approval.owner_receipt_sha)&&Array.isArray(policy.approval.ids)&&policy.approval.ids.length>0&&policy.approval.executed_failure_semantics===true&&policy.approval.functional_head===policy.functional_head&&Number.isInteger(policy.approval.functional_ci_run_id)&&/^[0-9a-f]{40}$/.test(policy.approval.supervisor_review_receipt_sha??""),"CI exception not authorized");
   invariant(process.env.GITHUB_ACTIONS==="true"&&process.env.GITHUB_SHA===head&&identity.run&&identity.attempt&&identity.job,"exact GitHub runner required");
   invariant(git(root,"merge-base",head,policy.functional_head)===policy.functional_head,"functional base drift");
   const files=git(root,"diff","--name-only",policy.functional_head,head).split("\n").filter(Boolean);
   invariant(JSON.stringify(files.sort())===JSON.stringify([...policy.allowed_ci_paths].sort()),"approved CI exact-path scope mismatch");
  }
  invariant(git(root,"diff","--name-only","HEAD")==="","tracked source dirty");
  const contents={};for(const path of Object.values(CI_PATHS)){
   const relative=policy.review_payload_locations?.[path];
   if(mode==="review")invariant(typeof relative==="string"&&!relative.startsWith("/")&&!relative.split("/").includes(".."),"unsafe/missing review payload location");
   contents[path]=readFileSync(mode==="review"?resolve(dirname(policyPath),relative):resolve(root,path),"utf8");
  }
  invariant(digest(readFileSync(process.argv[1]))===digest(contents[CI_PATHS.checker]),"loaded checker is not reviewed payload");
  verifyPayloadPins(contents,policy,{effective:mode!=="review"});
  verifyControlMaps(contents,execFileSync("git",["show",policy.functional_head+":"+CI_PATHS.profile],{cwd:root,encoding:"utf8"}),execFileSync("git",["show",policy.functional_head+":"+CI_PATHS.gate],{cwd:root,encoding:"utf8"}));
 }
 function collectAux(){
  const captures={};for(const id of ["handler","guidance","retention"])captures[id]=captureProcess(id,process.execPath,policy.aux[id].args,root,evidenceDir,identity);
  for(const id of Object.keys(captures)){validateProcess(captures[id].receipt);assertAuxStderr(captures[id].stderr,policy.aux[id]);}
  return {verified:true,handler:parseHandler(cleanText(captures.handler.stdout),captures.handler.receipt.exit,policy.aux.handler,digest),guidance:parseRunner(cleanText(captures.guidance.stdout),captures.guidance.receipt.exit,policy.aux.guidance,policy.aux.handler.original_handler_sha256),retention:parseRunner(cleanText(captures.retention.stdout),captures.retention.receipt.exit,policy.aux.retention,policy.aux.handler.original_handler_sha256)};
 }
 function readAux(dir,strict){
  const options={strictRun:strict,job:strict?"c3-preproduction":null};
  sameIdentity(JSON.parse(readFileSync(join(dir,"aux-identity.json"),"utf8")),identity,options);
  const captures={};for(const id of ["handler","guidance","retention"]){const processReceipt=JSON.parse(readFileSync(join(dir,id+".process.json"),"utf8"));invariant(/(?:^|\/)node(?:\.exe)?$/.test(processReceipt.cmd),"not Node");captures[id]=readCaptured(dir,id,policy.aux[id].args,processReceipt.cmd,identity,options);assertAuxStderr(captures[id].stderr,policy.aux[id]);}
  return {verified:true,handler:parseHandler(cleanText(captures.handler.stdout),captures.handler.receipt.exit,policy.aux.handler,digest),guidance:parseRunner(cleanText(captures.guidance.stdout),captures.guidance.receipt.exit,policy.aux.guidance,policy.aux.handler.original_handler_sha256),retention:parseRunner(cleanText(captures.retention.stdout),captures.retention.receipt.exit,policy.aux.retention,policy.aux.handler.original_handler_sha256)};
 }
 function readPriorNative(dir,groups){const reports={};for(const group of groups){
  const expected=policy.groups[group],p=JSON.parse(readFileSync(join(dir,group+".process.json"),"utf8"));invariant(/(?:^|\/)deno(?:\.exe)?$/.test(p.cmd),"prior command not Deno");
  const captured=readCaptured(dir,group,expected.args,p.cmd,identity,{strictRun:true,job:"c3-preproduction"});
  const engine=JSON.parse(readFileSync(join(dir,group+".engine.json"),"utf8"));sameIdentity(engine.identity,identity,{strictRun:true,job:"c3-preproduction"});
  invariant((engine.version==="deno "+expected.native_deno_version||engine.version.startsWith("deno "+expected.native_deno_version+" "))&&/^[0-9a-f]{64}$/.test(engine.binary_sha256)&&JSON.stringify(engine.command)===JSON.stringify(p),"prior native engine proof mismatch");
  reports[group]=parseNativeCapture(captured,expected,p.cwd).report;
 }return {reports,errors:[]};}
 checkSource();
 if(mode==="review"){
  let aux=null,auxError=null;try{aux=collectAux();writeFileSync(join(evidenceDir,"aux-identity.json"),JSON.stringify(identity,null,2)+"\n",{flag:"wx"});}catch(e){auxError=e.message;}
  const all=collectNativeGroups([...ppGroups,...isolatedGroups],root,policy,mode,evidenceDir,identity);
  const reviewPolicy={...policy,mode:"DRAFT_NOT_APPROVED",approval:null},ids=policy.candidates.map(x=>x.id);
  const pick=groups=>({reports:Object.fromEntries(groups.filter(g=>all.reports[g]).map(g=>[g,all.reports[g]])),errors:all.errors.filter(e=>groups.includes(e.group))});
  const preproduction=groupAdjudication(pick(ppGroups),aux,reviewPolicy,ids,ppGroups),isolated=groupAdjudication(pick(isolatedGroups),aux,reviewPolicy,ids,isolatedGroups);
  const result={mode:"REVIEW_ONLY_NO_EFFECTIVE_APPROVAL",identity,aux_error:auxError,preproduction,isolated,application_build:"NOT_RUN_BY_CHECKER",formal_uat_acceptance:false};
  writeFileSync(join(evidenceDir,"review-adjudication.json"),JSON.stringify(result,null,2)+"\n",{flag:"wx"});console.log(JSON.stringify(result));
  checkSource();process.exitCode=auxError||all.errors.length||[preproduction,isolated].some(r=>r.adjudicated_exit!==0||r.raw?.some(g=>g.exitCode!==0))?1:0;
 }else if(mode==="ci-aux"){
  invariant(identity.job==="c3-preproduction","aux wrong CI job");collectAux();checkSource();writeFileSync(join(evidenceDir,"aux-identity.json"),JSON.stringify(identity,null,2)+"\n",{flag:"wx"});
 }else if(mode==="ci-preproduction"){
  invariant(identity.job==="c3-preproduction","native wrong CI job");const aux=readAux(evidenceDir,true);
  const collected=collectNativeGroups(ppGroups,root,policy,mode,evidenceDir,identity),result=groupAdjudication(collected,aux,policy,policy.approval.ids,ppGroups);
  writeFileSync(join(evidenceDir,"preproduction-adjudication.json"),JSON.stringify({identity,result},null,2)+"\n",{flag:"wx"});console.log(JSON.stringify(result));checkSource();process.exitCode=result.adjudicated_exit;
 }else if(mode==="ci-isolated"){
  invariant(identity.job==="c3-director-generic-core-isolated-final"&&process.env.C3_EXISTING_C3_PREPRODUCTION_RESULT==="success","original preproduction dependency not accepted");
  const auxDir=resolve(process.argv[6]||""),aux=readAux(auxDir,true),prior=JSON.parse(readFileSync(join(auxDir,"preproduction-adjudication.json"),"utf8"));
  sameIdentity(prior.identity,identity,{strictRun:true,job:"c3-preproduction"});invariant(prior.result.adjudicated_exit===0,"prior preproduction not accepted");
  const priorResult=groupAdjudication(readPriorNative(auxDir,ppGroups),aux,policy,policy.approval.ids,ppGroups);invariant(priorResult.adjudicated_exit===0&&JSON.stringify(priorResult)===JSON.stringify(prior.result),"prior raw evidence/adjudication drift");
  const collected=collectNativeGroups(isolatedGroups,root,policy,mode,evidenceDir,identity),result=groupAdjudication(collected,aux,policy,policy.approval.ids,isolatedGroups);
  writeFileSync(join(evidenceDir,"isolated-adjudication.json"),JSON.stringify({identity,result},null,2)+"\n",{flag:"wx"});console.log(JSON.stringify(result));checkSource();process.exitCode=result.adjudicated_exit;
 }else throw Error("unknown mode");
}
export {normalizePayload,verifyPayloadPins,verifyControlMaps,replaceJSONValue,CI_PATHS,parseNative,validateNative,parseHandler,parseRunner,adjudicate,assertNativeStderr,parseNativeCapture,captureProcess,readCaptured,sameIdentity,collectNativeGroups,groupAdjudication};
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){main().catch(error=>{console.error("C3_NAMED_LEGACY_FAIL:",error.message);process.exitCode=1;});}
