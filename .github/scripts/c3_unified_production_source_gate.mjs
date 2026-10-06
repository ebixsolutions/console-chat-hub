import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {resolveLocalModule} from './c3_module_graph.mjs';
const must=(ok,m)=>{if(!ok)throw Error(m)};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const APPROVED_ENTRYPOINTS=["supabase/functions/generate-reply/index.ts", "supabase/functions/agent-assist/index.ts", "supabase/functions/conversation-evaluate/index.ts", "supabase/functions/kb-search-proxy/index.ts", "supabase/functions/receive-widget-message/index.ts", "supabase/functions/widget-poll-messages/index.ts", "supabase/functions/agent-send-reply/index.ts", "supabase/functions/take-over-conversation/index.ts", "supabase/functions/return-to-ai/index.ts", "supabase/functions/deliver-feedback-request/index.ts"];
const APPROVED_CHANGES=[".github/workflows/task-ai-abc-c3-final-gate.yml", ".github/scripts/task_ai_abc_c3_final_gate.mjs", ".github/scripts/c3_director_generic_core_final_gate.mjs", ".github/scripts/c3_unified_production_source_gate.mjs", ".github/scripts/c3_unified_production_source_gate.test.mjs", ".github/scripts/c3_unified_production_profile.json", "src/lib/api/config.service.ts", "src/lib/api/feedback.service.ts", "supabase/functions/deliver-feedback-request/index.ts", "supabase/migrations/20261006120000_c3_uat_learning_isolation.sql", "supabase/migrations/20261006120001_c3_uat_feedback_isolation.sql", "sql/c3_uat_isolation_guarded_rollback.sql", "tests/c3-uat-isolation/native-guards.py", "tests/c3-uat-isolation/current-schema.sql", "src/routes/_authenticated/console.feedback-settings.tsx", "src/integrations/supabase/previewAuthStorage.ts"];
const APPROVED_EXTERNALS=["https://esm.sh/@supabase/supabase-js@2.45.0", "npm:@supabase/supabase-js@2.45.0", "npm:google-auth-library@9.15.0"];
const FROZEN_EVIDENCE=[".github/scripts/c3_deterministic_runtime_closure.mjs", ".github/scripts/c3_deterministic_runtime_closure.test.mjs", ".github/scripts/c3_deterministic_objective_oracle_v1.json", ".github/scripts/c3_deterministic_objective_freeze_v1.json", ".github/scripts/c3_real_case_derived_freeze_manifest_v1.json", ".github/scripts/c3_director_candidate_scope.json"];
const NORMALIZED_PREVIEW={".env": "047c87aec28e50e4d73d0cecda8ad176d7134ba8f59007193264dd24ab7127ef", "package.json": "6473a2cbc24d9c214e21c580c5f95f8c417fb84f1d1977172805362ff907ac5e", "bun.lock": "12465e6c8461f7f2af835059015a1dca3ff8ba1c2b47a2d53aa0a954aba3d5bc", "src/routes/__root.tsx": "4b6417326c1e05bcddcd72ff5a11b4b01fd12922f1018d8f0867d60bef2e898e", "src/integrations/supabase/previewAuthStorage.ts": "c11f61a80071f876a237b06f902f5e278283044e7202d28b33b8341b9fceafa2"};
export const PROFILE_PATH='.github/scripts/c3_unified_production_profile.json';
export function imports(source,file){
 const node=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
 const found=[];
 const visit=n=>{
  if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword)throw Error('dynamic_import_unresolved:'+file);
  if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)){
   const m=n.moduleSpecifier;if(m){
    must(ts.isStringLiteral(m),'import_not_literal:'+file);
    const c=n.importClause;
    const typeOnly=c?.isTypeOnly||n.isTypeOnly||(c&&!c.name&&c.namedBindings&&ts.isNamedImports(c.namedBindings)&&c.namedBindings.elements.every(e=>e.isTypeOnly));
    if(!typeOnly)found.push(m.text);
   }
  }
  ts.forEachChild(n,visit);
 };visit(node);return found;
}
export function productionClosure(root,profile){
 const pending=[...profile.entrypoints],seen=new Map();
 while(pending.length){
  const file=pending.pop();if(seen.has(file))continue;
  const abs=path.resolve(root,file);
  must(abs.startsWith(path.resolve(root)+path.sep)&&fs.existsSync(abs),'dependency_missing:'+file);
  const bytes=fs.readFileSync(abs),source=bytes.toString();seen.set(file,sha(bytes));
  for(const spec of imports(source,file)){
   if(spec.startsWith('.')){const target=resolveLocalModule(root,abs,spec);must(target,'dependency_missing:'+file+':'+spec);pending.push(path.relative(root,target).split(path.sep).join('/'));}
   else must(profile.external_imports.includes(spec),'unapproved_external_import:'+file+':'+spec);
  }
 }
 const files=[...seen.keys()].sort();
 must(JSON.stringify(files)===JSON.stringify(profile.runtime_files),'exact_closure_mismatch');
 for(const [f,h] of Object.entries(profile.frozen_runtime_sha256))must(seen.get(f)===h,'frozen_runtime_drift:'+f);
 for(const f of ['supabase/functions/_shared/llm-router.ts','supabase/functions/_shared/kb-client.ts','supabase/functions/_shared/conversation-long-memory.ts','supabase/functions/_shared/transaction-closure-handoff.ts','supabase/functions/_shared/pre-send-conversion-supervisor.ts'])must(seen.has(f),'governance_dependency_missing:'+f);
 for(const f of files)must(!f.endsWith('/deterministic-runtime-router.ts'),'offline_provider_substitute:'+f);
 return files.map(file=>({file,sha256:seen.get(file)}));
}
export function verifyIdentity(root,profile,expected){
 const head=git(root,'rev-parse','HEAD'),tree=git(root,'rev-parse','HEAD^{tree}');
 must(expected?.head===head&&expected?.tree===tree,'stale_identity');
 must(git(root,'merge-base',profile.baseline.head,'HEAD')===profile.baseline.head,'unapproved_lineage');
 must(git(root,'rev-parse',profile.baseline.head+'^{tree}')===profile.baseline.tree,'baseline_tree_drift');
 const changed=git(root,'diff','--name-only',profile.baseline.head,'HEAD').split('\n').filter(Boolean);
 for(const f of changed)must(profile.authorized_changes.includes(f),'source_scope:'+f);
 for(const f of [...new Set([...profile.runtime_files,...Object.keys(profile.frozen_evidence_sha256),...Object.keys(NORMALIZED_PREVIEW),PROFILE_PATH])]){
  must(fs.readFileSync(path.join(root,f)).equals(execFileSync('git',['show','HEAD:'+f],{cwd:root})),'uncommitted_source:'+f);
 }
 return {head,tree,changed};
}
export function verifyProductionSource({root=process.cwd(),profile=JSON.parse(fs.readFileSync(path.join(root,PROFILE_PATH))),expectedIdentity,sourceOnly=false}={}){
 must(JSON.stringify(profile.entrypoints)===JSON.stringify(APPROVED_ENTRYPOINTS),'entrypoint_scope_drift');
 must(JSON.stringify(profile.authorized_changes)===JSON.stringify(APPROVED_CHANGES),'authorization_scope_drift');
 must(JSON.stringify(profile.external_imports)===JSON.stringify(APPROVED_EXTERNALS),'external_scope_drift');
 must(JSON.stringify(Object.keys(profile.frozen_evidence_sha256))===JSON.stringify(FROZEN_EVIDENCE),'frozen_evidence_scope_drift');
 must(profile.baseline.head==='a7738e378176cb34103c2c3f3a48efc5b2b2830b'&&profile.baseline.tree==='a65da0ee7fa3165cd157ff1ec859aa00ecdb3515','baseline_identity_drift');
 must(profile.mode==='UNIFIED_PRODUCTION_GOVERNED','wrong_profile');
 must(profile.contract==='C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1'&&profile.authorization==='C3-A773-CONSOLIDATED-REPAIR-AUTH-20261006-v1'&&profile.backend==='nrfxhqabwblzxoushgnm','wrong_authority');
 must(JSON.stringify(profile.allowed_providers)===JSON.stringify(['vertex','anthropic']),'unapproved_provider');
 for(const [f,h] of Object.entries(profile.frozen_evidence_sha256))must(fs.existsSync(path.join(root,f))&&sha(fs.readFileSync(path.join(root,f)))===h,'frozen_evidence_drift:'+f);
 must(JSON.stringify(profile.normalized_preview_sha256)===JSON.stringify(NORMALIZED_PREVIEW),'preview_binding_profile_drift');
 for(const [f,h] of Object.entries(NORMALIZED_PREVIEW))must(fs.existsSync(path.join(root,f))&&sha(fs.readFileSync(path.join(root,f)))===h,'preview_binding_drift:'+f);
 const files=productionClosure(root,profile);
 if(!sourceOnly){
  const expectedFrozen=profile.runtime_files.filter(f=>f!=='supabase/functions/deliver-feedback-request/index.ts');
  must(JSON.stringify(Object.keys(profile.frozen_runtime_sha256).sort())===JSON.stringify(expectedFrozen.sort()),'frozen_runtime_scope_drift');
  for(const [f,h] of Object.entries({...profile.frozen_runtime_sha256,...profile.frozen_evidence_sha256}))must(sha(execFileSync('git',['show',profile.baseline.head+':'+f],{cwd:root}))===h,'baseline_hash_rewritten:'+f);
 }
 const worker=fs.readFileSync(path.join(root,'supabase/functions/deliver-feedback-request/index.ts'),'utf8');
 const ast=ts.createSourceFile('worker.ts',worker,ts.ScriptTarget.Latest,true);
 const scan=n=>{if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text==='fetch')throw Error('worker_direct_external_fetch');ts.forEachChild(n,scan)};scan(ast);
 must(profile.conditional_worker_sha256==='56b02b24abd5b64748f5931e9cf9b0b1df05fb920b852ebe4b8bd51c71a793de' && sha(Buffer.from(worker))===profile.conditional_worker_sha256,'conditional_worker_integrity');
 const identity=sourceOnly?null:verifyIdentity(root,profile,expectedIdentity);
 return {status:'SOURCE_VALIDATED',mode:profile.mode,contract:profile.contract,authorization:profile.authorization,backend:profile.backend,identity,files,closure_sha256:sha(JSON.stringify(files)),hosted_runtime:'NOT_TESTED',uat_start_allowed:false};
}
export function verifyChildEvidence(rows){
 must(Array.isArray(rows)&&rows.length>0,'missing_evidence');
 for(const row of rows){must(row.status==='PASS','child_not_pass:'+row.status);must(row.exit_code===0,'child_exit_ignored');must(Array.isArray(row.evidence)&&row.evidence.length>0,'missing_evidence');for(const f of row.evidence)must(fs.existsSync(f)&&fs.statSync(f).size>0,'missing_evidence:'+f);}
 return true;
}
export function runChild(command,args,options={}){const r=spawnSync(command,args,{stdio:'inherit',...options});must(!r.error&&r.status===0&&!r.signal,'child_failed:'+command+':'+r.status);return r.status;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=process.cwd(),head=process.env.GITHUB_SHA||git(root,'rev-parse','HEAD'),tree=git(root,'rev-parse','HEAD^{tree}');
 console.log(JSON.stringify(verifyProductionSource({root,expectedIdentity:{head,tree}}),null,2));
}
