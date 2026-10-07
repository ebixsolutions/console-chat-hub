import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {candidateIdentity, sourceFingerprint, renderCandidateIdentity, candidateIdentityPlugin} from '../../vite.candidate-identity.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-no-git-unit-'));
 fs.mkdirSync(path.join(dir,'public/widget'),{recursive:true});
 fs.mkdirSync(path.join(dir,'src'),{recursive:true});
 fs.writeFileSync(path.join(dir,'public/widget/chat.js'),'window.widget=true;');
 fs.copyFileSync(path.join(root,'vite.candidate-identity.mjs'),path.join(dir,'vite.candidate-identity.mjs'));
 fs.writeFileSync(path.join(dir,'src/app.ts'),'export const app = 1;');
 return dir;
}
test('real git HEAD/TREE, modified state and deterministic source fingerprint',()=>{
 const a=candidateIdentity(false),b=candidateIdentity(false);
 assert.equal(a.head,git('rev-parse','HEAD'));assert.equal(a.tree,git('rev-parse','HEAD^{tree}'));
 assert.equal(a.modified,Boolean(git('status','--porcelain')));assert.equal(a.identitySource,'git');
 assert.equal(a.sourceSha256,b.sourceSha256);assert.match(a.sourceSha256,/^[0-9a-f]{64}$/);
});
test('exported copy has honest null git identity and fingerprint rendering',()=>{
 const dir=fixture();try{
 const a=candidateIdentity(false,{root:dir,env:{}});
 assert.equal(a.head,null);assert.equal(a.tree,null);assert.equal(a.modified,null);
 assert.equal(a.identitySource,'source_fingerprint');assert.match(renderCandidateIdentity(a),/GIT IDENTITY UNAVAILABLE/);
 assert.equal(a.sourceSha256,sourceFingerprint(dir).sourceSha256);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('git executable failure is optional, not a build-config exception',()=>{
 const dir=fixture();try{
 const code=`import {candidateIdentity} from ${JSON.stringify(new URL('../../vite.candidate-identity.mjs',import.meta.url).href)}; console.log(JSON.stringify(candidateIdentity(false,{root:${JSON.stringify(dir)}})));`;
 const a=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code],{env:{PATH:dir},encoding:'utf8'}));
 assert.equal(a.identitySource,'source_fingerprint');assert.equal(a.head,null);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('malformed AND well-formed unattested env SHAs cannot spoof production identity',()=>{
 const dir=fixture();try{for(const value of ['not-a-sha','a'.repeat(40)]){
 const a=candidateIdentity(false,{root:dir,env:{LOVABLE_COMMIT_SHA:value,LOVABLE_TREE_SHA:value,GITHUB_SHA:value,C3_BUILD_HEAD:value,C3_BUILD_TREE:value}});
 assert.equal(a.head,null);assert.equal(a.tree,null);assert.equal(a.buildEnvIdentity,null);
 assert.equal(a.buildEnvMetadataStatus,'ignored_unverified_provenance');assert.equal(a.sourceBackendRef,'nrfxhqabwblzxoushgnm');
 }}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('source mutation matters; ordering, mtimes, excluded secrets/caches/runtime and symlinks do not',()=>{
 const dir=fixture();try{
 const a=sourceFingerprint(dir).sourceSha256;
 fs.utimesSync(path.join(dir,'src/app.ts'),1,1);
 for(const d of ['node_modules','dist','src/.cache','src/session','src/runtime-data']){fs.mkdirSync(path.join(dir,d),{recursive:true});fs.writeFileSync(path.join(dir,d,'secret.ts'),'SENTINEL_PRIVATE');}
 fs.writeFileSync(path.join(dir,'.env'),'SENTINEL_PRIVATE');fs.writeFileSync(path.join(dir,'src/credentials.json'),'SENTINEL_PRIVATE');
 fs.symlinkSync(os.tmpdir(),path.join(dir,'src/outside'));
 assert.equal(sourceFingerprint(dir).sourceSha256,a);
 fs.writeFileSync(path.join(dir,'src/app.ts'),'export const app=2;');assert.notEqual(sourceFingerprint(dir).sourceSha256,a);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('actual emitted candidate JSON and widget stamp contain no secret metadata',()=>{
 const dir=fixture();try{
 const a=candidateIdentity(false,{root:dir,env:{SECRET_TOKEN:'SENTINEL_PRIVATE',LOVABLE_COMMIT_SHA:'SENTINEL_PRIVATE'}});
 const emitted=[];candidateIdentityPlugin(a).generateBundle.call({emitFile:x=>emitted.push(x)});
 assert.deepEqual(emitted.map(x=>x.fileName),['c3-candidate.json','widget/chat.js']);
 for(const x of emitted)assert.ok(!x.source.includes('SENTINEL_PRIVATE'));
 const json=JSON.parse(emitted[0].source);assert.equal(json.head,null);assert.equal(json.backendRuntimeVerified,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
