// Actual builds in a git checkout and disposable exported copy; no hosted product.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {candidateIdentity} from '../../vite.candidate-identity.mjs';
const root=process.cwd(), output=path.resolve(process.env.C3_IDENTITY_EVIDENCE_DIR || path.join(os.tmpdir(),'c3-identity-build-evidence'));
fs.mkdirSync(output,{recursive:true});
const copy=fs.mkdtempSync(path.join(os.tmpdir(),'c3-no-git-build-'));
const records=[];
const expected=candidateIdentity(false);
function build(where,script,label,noGit){
 const env={...process.env,C3_CONSOLE_ENV:'production',LOVABLE_SANDBOX:'1',PRIVATE_CANDIDATE_SENTINEL:'C3_PRIVATE_SENTINEL_NOT_FOR_EMISSION'};
 if(noGit){env.PATH=path.join(copy,'blocked-git')+path.delimiter+process.env.PATH;env.LOVABLE_COMMIT_SHA='f'.repeat(40);env.LOVABLE_TREE_SHA='bad-tree';}
 for(const folder of ['dist','.output'])fs.rmSync(path.join(where,folder),{recursive:true,force:true});
 const result=spawnSync('npm',['run',script],{cwd:where,env,encoding:'utf8',timeout:240000,maxBuffer:20*1024*1024});
 fs.writeFileSync(path.join(output,label+'.log'),(result.stdout||'')+(result.stderr||''));
 const record={command:['npm','run',script],mode:label,exit_code:result.status,signal:result.signal};records.push(record);
 fs.writeFileSync(path.join(output,'commands.json'),JSON.stringify(records,null,2));
 assert.equal(result.status,0,label+' build failed: see '+path.join(output,label+'.log'));
 const builtRoot=['dist/client','.output/public'].map(p=>path.join(where,p)).find(p=>fs.existsSync(path.join(p,'c3-candidate.json')));
 assert.ok(builtRoot,'fresh candidate asset missing');
 const candidatePath=path.join(builtRoot,'c3-candidate.json'),widgetPath=path.join(builtRoot,'widget/chat.js');
 assert.ok(fs.existsSync(candidatePath));assert.ok(fs.existsSync(widgetPath));
 const bytes=fs.readFileSync(candidatePath,'utf8'),widget=fs.readFileSync(widgetPath,'utf8');
 assert.ok(!bytes.includes(env.PRIVATE_CANDIDATE_SENTINEL));assert.ok(!widget.includes(env.PRIVATE_CANDIDATE_SENTINEL));
 const actual=JSON.parse(bytes),stamp=JSON.parse(widget.match(/^\/\* C3 candidate (.*?) \*\//)[1]);
 assert.deepEqual(stamp,actual);assert.equal(actual.sourceBackendRef,'nrfxhqabwblzxoushgnm');
 assert.equal(actual.sourceSha256,expected.sourceSha256);assert.equal(actual.backendRuntimeVerified,false);
 if(noGit){assert.equal(actual.head,null);assert.equal(actual.tree,null);assert.equal(actual.modified,null);assert.equal(actual.identitySource,'source_fingerprint');}
 else{assert.equal(actual.head,expected.head);assert.equal(actual.tree,expected.tree);assert.equal(actual.identitySource,'git');}
 fs.copyFileSync(candidatePath,path.join(output,label+'-candidate.json'));
 record.result='PASS';console.log(JSON.stringify(record));
}
try{
 const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
 // During local precommit validation, include the new causal repair files too.
 files.push('tests/c3-candidate-identity/candidate-identity.test.mjs','.github/scripts/c3_candidate_identity_build_check.mjs');
 for(const file of new Set(files)){
  const from=path.join(root,file);if(!fs.existsSync(from)||!fs.lstatSync(from).isFile())continue;
  const to=path.join(copy,file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);
 }
 fs.symlinkSync(path.resolve('node_modules'),path.join(copy,'node_modules'),'dir');
 fs.mkdirSync(path.join(copy,'blocked-git'));fs.writeFileSync(path.join(copy,'blocked-git/git'),'#!/bin/sh\nexit 127\n',{mode:0o700});
 assert.ok(!fs.existsSync(path.join(copy,'.git')));
 build(root,'build:dev','git-development',false);
 build(root,'build','git-production',false);
 build(copy,'build:dev','no-git-development',true);
 build(copy,'build','no-git-production',true);
 fs.writeFileSync(path.join(output,'commands.json'),JSON.stringify(records,null,2));
 console.log('C3_CANDIDATE_BUILD_CHECK=PASS');
}finally{fs.rmSync(copy,{recursive:true,force:true});}
