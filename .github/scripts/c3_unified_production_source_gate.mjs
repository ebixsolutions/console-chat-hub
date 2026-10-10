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
const PREVIOUS_APPROVED_CHANGES=[".github/workflows/task-ai-abc-c3-final-gate.yml", ".github/scripts/task_ai_abc_c3_final_gate.mjs", ".github/scripts/c3_director_generic_core_final_gate.mjs", ".github/scripts/c3_unified_production_source_gate.mjs", ".github/scripts/c3_unified_production_source_gate.test.mjs", ".github/scripts/c3_unified_production_profile.json", "src/lib/api/config.service.ts", "src/lib/api/feedback.service.ts", "supabase/functions/deliver-feedback-request/index.ts", "supabase/migrations/20261006120000_c3_uat_learning_isolation.sql", "supabase/migrations/20261006120001_c3_uat_feedback_isolation.sql", "sql/c3_uat_isolation_guarded_rollback.sql", "tests/c3-uat-isolation/native-guards.py", "tests/c3-uat-isolation/current-schema.sql", "src/routes/_authenticated/console.feedback-settings.tsx", "src/integrations/supabase/previewAuthStorage.ts", "src/routes/_authenticated/console.widget-preview.tsx", "src/lib/widget-message-merge.ts", "src/lib/widget-message-merge.test.mjs", "supabase/functions/_shared/conversation-long-memory.ts", "supabase/functions/_shared/conversation-service-planner.ts", "supabase/functions/_shared/memory-reply-lifecycle-readback.ts", "sql/c3_memory_reply_lineage_proposed.sql", "sql/c3_memory_reply_lineage_guarded_rollback_proposed.sql", "tests/c3-memory-reply-lineage/captured-memory-functions.sql", "tests/c3-memory-reply-lineage/memory-reply-caller.test.ts", "tests/c3-memory-reply-lineage/memory-reply-lifecycle-readback.test.ts", "tests/c3-memory-reply-lineage/minimal-memory-schema.sql", "tests/c3-memory-reply-lineage/native-guards.py", "vite.candidate-identity.mjs", "vite.candidate-identity.d.mts", "vite.config.ts", "tests/c3-candidate-identity/candidate-identity.test.mjs", ".github/scripts/c3_candidate_identity_build_check.mjs", "supabase/functions/widget-live-ai-test/index.ts", "tests/c3-widget-live-auth/handler.test.mjs", "tests/e2e/c3_widget_isolated_setup.sh", "sql/c3-nonproduction/08_widget_auth_isolation_context.sql", "tests/e2e/c3_widget_isolated_auth.mjs"];
const GENERIC_SERVICE_REPAIR={"src/components/console/CRMPanel.tsx": "357dc6f7fe24434d12fde6bc369ac33232b88fb995183925dd4c748f9b9636f5", "src/routes/_authenticated/console.widget-preview.tsx": "cb2b77b0487c15cf376c53ed4b781e450c4dc469357840a80d106ad1b6c2e428", "public/widget/chat.js": "77a09fb46fd3f19d0e77a75fe2a31767200c3d2264bc3aee7ffa3fc30b5c7676", "supabase/functions/_shared/commerce-semantic-interpreter.ts": "3c81b9ff6af878adbfc067443fdb5e34af658f681c7916b77641e8cdaf40590d", "supabase/functions/_shared/conversation-service-planner.ts": "57a654e6b56b011d173ded4060ff981c4e0c7fe591945593930dec3151f18a39", "supabase/functions/_shared/natural-customer-response.ts": "5f26399789280d169d29673e118ff1c637cf81202c3a68cc5489fa038363883b", "supabase/functions/_shared/natural-customer-response.test.ts": "4ca3524c97c510783bd136acaaca250a17c06d8bdda5b054af8920333b6b68ab", "supabase/functions/_shared/service-semantic-routing.ts": "117b06bc1365e1dddbb0c80f1515b934ee45116a2826004a6e8e9f892799cc3c", "supabase/functions/_shared/service-semantic-routing.test.ts": "c6a35f395e9e4503420ac0dc80d53de18bd221dfe1c214907753151e06a3126f", "supabase/functions/generate-reply/index.ts": "8127821d7e4216a02d05d85b908435fe47d23b7d3f9eb33a88c6fb53a6615774", "supabase/functions/widget-live-ai-test/index.ts": "cfb0342651abcf3781cd722ebcddce4c5c05573612303e816899dfa897a111a5", "supabase/functions/_shared/product-factual-query.test.ts": "20ea440d0b3e7fd037451da56b347614b2e0eb5d4f4f514f10c0779fce0bdf0f", "supabase/functions/_shared/bounded-decision-context.ts": "f93b59b56469f4a79518374f2cb3b73fab8d09028ce2b3c5c6cbb1c6c90f01f1", "supabase/functions/_shared/commerce-semantic-frame.ts": "fe5fbc5f0b4806001f39b7162890ad6d06e08a63ccc06406111e275675207a05"};
const F13_F14_REPAIR={".github/workflows/task-ai-abc-c3-final-gate.yml":"ee9fdf57c2749b5d222f37a6c3de33772fa755f5e099328d462fb81c4c9075c0","src/components/console/handoff-summary.ts":"128abe76c086c03efabe51985628b6f3061b482566072f9e4d0d0cea8e255f13","supabase/functions/_shared/commerce-semantic-interpreter.ts":"79c1efa7d92791c93e10b514c7576fc1bc5f315e9663a7e45c2a7677e2ec66a1","supabase/functions/_shared/commerce-state-authority.ts":"9c722eab711a65a7e3f6bbe5d744d1c7c54d2940880b8c7c9183d3adc023aa3a","supabase/functions/_shared/conversation-long-memory.ts":"c621da19845996cdc8e2644694d9cc7523fa3b4b196dcd12cb33f04213bc35d8","supabase/functions/_shared/conversation-recall.ts":"281fbccaa51198a1651a28f9500a3336a0031a6e503484e9ce82a6b1c5f2af3b","supabase/functions/_shared/conversation-runtime-state-core.ts":"12af48041e25e5cc3c5bd6b091906077e5cd4a35995fcbcd0144e933ae1ace9f","supabase/functions/_shared/conversation-service-planner.ts":"060f683fec577e1e9cefb1a51c3e47e626d0636e2b8c42da74889050d14b30cc","supabase/functions/_shared/llm-router.ts":"99b62f4a982a9d134f925c1a2af81b7664cb23788753bd15ff079b62e8c0afc7","supabase/functions/_shared/service-semantic-routing.test.ts":"2e4a68d193afc5660590b76e7576461984322e46c48d1a89deb9d024e0ceddff","supabase/functions/generate-reply/index.ts":"534ddecd77b4662716658fd6b09c5916a33d7693d10b44210633cb11bec3f07a","supabase/functions/_shared/f13-f14-root-cause.test.ts":"a0f3d56e521df2b70fd4027de75336b0084311fa8dd786d28d7c091377934b99","supabase/functions/_shared/f13-llm-failure.test.ts":"9a3220ab07ed2c8d1e03ea5d31ef8b1ea114fa55b2bd77464db6eaa43b17dc84","sql/c3_f13_f14_handoff_projection_proposed.sql":"b5a060c4b107a20fe57ed0ad00309765386ccd46533a28a952ac4c845e4dfed9","sql/c3_f13_f14_handoff_projection_rollback_proposed.sql":"562cc5a13723696b7c2ac8d0b5200c41fabf6aceada226835ba4e0ee6dbc0d09","tests/c3-f13-f14/captured-handoff-functions.sql":"6218241834db96acab20b672e0b8ede880a0615394273db2f4cdaa1051eb52e3","tests/c3-f13-f14/native-projection.py":"556b256e3a07b6ad3c19e4bfd945a026210fc1c84e18648c930ad98a16721fd6",".github/scripts/c3_unified_production_source_gate.test.mjs":"eed06c231da8fc76c5bb48a413c1e453d8fe79704d5b6fa94499da6333a7b44a","supabase/functions/_shared/commerce-state-runtime-base.ts":"5df9b7d9301aed079145ea87ef343a7d2de9743c7f295f44c3a23458303896d6","supabase/functions/_shared/conversation-resolution-contract.ts":"56e62a58ef4c1528e870d272244ac696bd548a95cafb7b8023bdc4c8beb4bb2f","supabase/functions/_shared/handoff-intent.ts":"40c6fdd391dbc68d0edcd8568b4bd5e38478c93f581f5c74455c2e5f7c5e2295","supabase/functions/_shared/conversation-intelligence.ts":"5c6e2b0973df9c41dee0fb9a324b661ce7835946e129210d37071519d5e41658","supabase/functions/_shared/commerce-semantic-frame.ts":"31d35d9876169db873410e6eda8ef7831f05bf814d45f1654711aec7c1c6632c","supabase/functions/_shared/f13-runtime-recovery.test.ts":"cb501231e9de70d10224c5c44ff60b83099b1c386961a5c1ae8b5fcae5d19160"};
const B12_REGISTRY_REPAIR={".github/workflows/c3-b12-registry-isolation.yml":"e8ba4cd18920571f853e6c88d8aa3c1402af9ef49db03ed5d347588e568524bc","supabase/functions/_shared/ce-automation-engine.ts":"00882832370e770ba23bd41ac9bcb3f7b6078dc5a4f2728bb54f250a3a2a3f6a","supabase/functions/ce-evaluation-worker/index.ts":"4ced4c0bd7ee05e1a11b401a964226f13ca9e5f9446c4b20b06da881ec4a5f5d","supabase/functions/ce-evaluation-control/index.ts":"d7e95c6594d828cf438394ba2bce199520ab775d40695e358a7ac4a0a4be01d8","supabase/functions/_shared/ce-registry-isolation.test.ts":"57e47471b894585db8ae02bb225fff6a5400e8b50616521a83ba0c275ff9672f","sql/c3_b12_registry_isolation_forward_proposed.sql":"809c29c40ff48e8b0ccfa025748e5a10f9db9dc7d413f5b1866bd1a9e8ce6bb1","sql/c3_b12_registry_isolation_rollback_proposed.sql":"c64d00fb7d958dad18b7ed795ebd1015a993d77e287d6bb4984a1986e9b3d743","tests/c3-b12-registry/captured-functions.json":"bcd824a2e0b47da18d06025c5382e9f672dabe19ade6e058a7e91434d23807b1","tests/c3-b12-registry/target-functions.json":"b2ed8031b341748804d9dfe65a1a755b4fbb2987bcfb0c3ec0269473d5d17a5e","tests/c3-b12-registry/native-registry.py":"a1f4d318e27d26fcd906b27ad7be04a2fd9a4459432907826dea147ec8fdf4a2",".github/scripts/c3_unified_production_source_gate.test.mjs":"36c4e870115a2d1ccb4e9af6db20e2dcc604979fbf6ea99bab9cea173b6358e0","tests/c3-b12-registry/captured-sink-dependency.json":"dca7f844a53ecf00cf26a4b9b09a84544a09d8faf9739e6d95a65d1918bf004a","tests/c3-b12-registry/captured-company-helper.json":"5ffd477ceb8c400f77de8e99f12c7bc7a8d386ca40a6f81e7eec17744fc5e8eb","tests/c3-b12-registry/build-payloads.py":"ce4a5e1a5cbb32d3edd4a06248fccdb84eb97b6618d406bdd9566f2db83a7deb","tests/c3-b12-registry/deployment-source-manifest.json":"9d69c77a6e6b1e834e817b8483bf859aed26f732979d86c380d5440734a3065f","supabase/functions/_shared/ce-evaluation-scope.ts":"8f1ef878a90fb55eb66aa2a732035bc151e77d12a0a4deabf6c22c4f4c7cfd7e","supabase/functions/conversation-evaluate/index.ts":"123d8fde288929e3a2d05606dca28ffa719219d5f57444b33867ce2e432e3203"};
// Accepted Demo checkpoint is immutable; it is not a new runtime or release PASS.
const ACCEPTED_DEMO={head:'d70a659cd91ce99aef28ef794e78723248c9c639',tree:'abae6c0f0475ab0fd632e9b89278e8203e3970a8'};
const ACCEPTED_DEMO_ENV={".env": "36e61f9ca901649c92508d3cfd6491a2a0748401f8043bec2efc047716497f33", "src/integrations/supabase/runtime-authority.mjs": "c20dfc393cc32de0d8ab9e626e0a449495378eee6594c99299ae425046786759", "package.json": "d5cfd6a2c1787ad935e96ce647dcc68cd1f671f2eef2c109be91138bf2f67028", "bun.lock": "c83b835e57f4b012f29998a54c0246d342930a13f0857dec495a5639bed7f08d"};
const SECTION15_REPAIR={"supabase/functions/_shared/handoff-intent.ts":"03e7513ddaf51d9c86363b122477b1bd79e58c7be388a8ba133d71bc62445759","supabase/functions/generate-reply/index.ts":"848288d54e5c5df00af69c1bc8839412c51e88fa24eb8c95430203ddbcfd537e","tests/section15/compound-handoff.test.mjs":"68d849eb80591ec45836065c1cb45641b3495b5c92b819f24341ae033b6fe863","supabase/functions/_shared/conversation-service-planner.ts":"861356e10d7e727699f7336ad043261c8f2e66ac12abe100a9060243781dbb96","tests/section15/handoff-service.test.ts":"7e13af9b1e7fa020ac15b77468c1bcffe645aa7ddd55365ae357f817b93b2d02"};
const SECTION15_VALIDATION_FILES=['.github/scripts/c3_unified_production_source_gate.mjs','.github/scripts/c3_unified_production_source_gate.test.mjs','.github/scripts/c3_unified_production_profile.json','.github/workflows/task-ai-abc-c3-final-gate.yml'];
const SECTION15_VALIDATION_SHA256={'.github/scripts/c3_unified_production_source_gate.test.mjs':'79a5a8dd2e2cc350b4fac2fd8629e1b67c320da223a26fedceec4bcb873b6d5f','.github/workflows/task-ai-abc-c3-final-gate.yml':'02090e7e9677adf2012203c728cf65330722ed6cf5452154dd41e0c908c81d18'};
const APPROVED_CHANGES=[...new Set([...PREVIOUS_APPROVED_CHANGES,...Object.keys(GENERIC_SERVICE_REPAIR),...Object.keys(F13_F14_REPAIR),...Object.keys(B12_REGISTRY_REPAIR),...Object.keys(SECTION15_REPAIR)])];
const APPROVED_EXTERNALS=["https://esm.sh/@supabase/supabase-js@2.45.0", "npm:@supabase/supabase-js@2.45.0", "npm:google-auth-library@9.15.0"];
const FROZEN_EVIDENCE=[".github/scripts/c3_deterministic_runtime_closure.mjs", ".github/scripts/c3_deterministic_runtime_closure.test.mjs", ".github/scripts/c3_deterministic_objective_oracle_v1.json", ".github/scripts/c3_deterministic_objective_freeze_v1.json", ".github/scripts/c3_real_case_derived_freeze_manifest_v1.json", ".github/scripts/c3_director_candidate_scope.json"];
const NORMALIZED_PREVIEW={".env": "047c87aec28e50e4d73d0cecda8ad176d7134ba8f59007193264dd24ab7127ef", "package.json": "6473a2cbc24d9c214e21c580c5f95f8c417fb84f1d1977172805362ff907ac5e", "bun.lock": "12465e6c8461f7f2af835059015a1dca3ff8ba1c2b47a2d53aa0a954aba3d5bc", "src/routes/__root.tsx": "4b6417326c1e05bcddcd72ff5a11b4b01fd12922f1018d8f0867d60bef2e898e", "src/integrations/supabase/previewAuthStorage.ts": "c11f61a80071f876a237b06f902f5e278283044e7202d28b33b8341b9fceafa2"};
const WIDGET_REPLY_STABILITY={"src/routes/_authenticated/console.widget-preview.tsx": "66a6cfb1473b7598b08aea5f7840626b926c4e1f64d6ec336b42a0e20a9758de", "src/lib/widget-message-merge.ts": "48dc0350ecccf6649b4b96901f9a35faa4f267e63c05d34d001538cacb40f65a", "src/lib/widget-message-merge.test.mjs": "750df02df775fde86181fbf0cc956373dcdf7b551cd9a7ec2cafb2763fe79340"};
const MEMORY_REPLY_REPAIR={"supabase/functions/_shared/conversation-long-memory.ts": "e407f0973a73d093ca515386952e3edfe2353430adb40afe4c13eb1cbbd8b594", "supabase/functions/_shared/conversation-service-planner.ts": "c44dd2a449a5a1a72e5b98603cdca4762123ff57dd72eb612c1ad5557896f2c3", "supabase/functions/_shared/memory-reply-lifecycle-readback.ts": "c4db46a3bffeac99879ed66f19b187189b47504ce95628b8d57d8408e3fe7062"};
const PREVIEW_ACTIVATION={"vite.candidate-identity.mjs": "c257b0d375c055361a6c3c3ff18f85366590c1f505f29bd2d059100a31598066", "vite.candidate-identity.d.mts": "18c6a612edf22deef4d41fc26216b2e1d856e8cd7a925fffe9c981b8dc8c93ee", "vite.config.ts": "33345ac9e52bd90de275e020a9f1226a178a5ee13a77d990b5c79ec293335f0a", "tests/c3-candidate-identity/candidate-identity.test.mjs": "11adab520ff5e2e8761453b9a8c772e76d4e1028c15687ae6fb254ce69081eda", ".github/scripts/c3_candidate_identity_build_check.mjs": "f1cf53c562e537a57402c3119adc7868d530d0958a9b99471bb21e289aa03a11"};
const WIDGET_AUTH_REPAIR={"src/routes/_authenticated/console.widget-preview.tsx": "15b7c579bbd91742106d6b81c4d76d193e467dd2f92390c4f07fe61bb8f84a5b", "src/lib/widget-message-merge.ts": "114bff85b5f2f467ca94da2b353f343d1611c5e09ab9fb833601380c5a78d067", "src/lib/widget-message-merge.test.mjs": "b219435b17ebb2a872d2e3a84547c3e6f0f58c71c1484451d0f64c80c81b705a", "supabase/functions/widget-live-ai-test/index.ts": "45322339028802d0709a835232e3fafc5254da3ce8fb7eca11e46b986d4a5784", "tests/c3-widget-live-auth/handler.test.mjs": "825f107c680d555e2a7a3868ab8da0f62135debc712345d012c3517ba5642e5d", "tests/e2e/c3_widget_isolated_setup.sh": "32a8553cb76447398d4ff19275875aaecd12e5b738c621c85b75b548d09449b5", "sql/c3-nonproduction/08_widget_auth_isolation_context.sql": "95e55961f090324f110f1684cb5df08da7a733ca339ea59101e4722552d8c8e9", "tests/e2e/c3_widget_isolated_auth.mjs": "71da546bc91c6bec9b95411ee10366ea0788d5fd2192f062c08a73de2d483ec6"};
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
 for(const [f,h] of Object.entries(profile.frozen_runtime_sha256))must(seen.get(f)===(SECTION15_REPAIR[f]??B12_REGISTRY_REPAIR[f]??F13_F14_REPAIR[f]??GENERIC_SERVICE_REPAIR[f]??MEMORY_REPLY_REPAIR[f]??h),'frozen_runtime_drift:'+f);
 for(const f of ['supabase/functions/_shared/llm-router.ts','supabase/functions/_shared/kb-client.ts','supabase/functions/_shared/conversation-long-memory.ts','supabase/functions/_shared/transaction-closure-handoff.ts','supabase/functions/_shared/pre-send-conversion-supervisor.ts'])must(seen.has(f),'governance_dependency_missing:'+f);
 for(const f of files)must(!f.endsWith('/deterministic-runtime-router.ts'),'offline_provider_substitute:'+f);
 return files.map(file=>({file,sha256:seen.get(file)}));
}
export function verifyIdentity(root,profile,expected){
 const head=git(root,'rev-parse','HEAD'),tree=git(root,'rev-parse','HEAD^{tree}');
 must(expected?.head===head&&expected?.tree===tree,'stale_identity');
 must(git(root,'merge-base',profile.baseline.head,'HEAD')===profile.baseline.head,'unapproved_lineage');
 must(git(root,'rev-parse',profile.baseline.head+'^{tree}')===profile.baseline.tree,'baseline_tree_drift');
 must(git(root,'rev-parse',ACCEPTED_DEMO.head+'^{tree}')===ACCEPTED_DEMO.tree,'accepted_demo_tree_drift');
 must(git(root,'merge-base',ACCEPTED_DEMO.head,'HEAD')===ACCEPTED_DEMO.head,'accepted_demo_lineage');
 const successor=git(root,'diff','--name-only',ACCEPTED_DEMO.head,'HEAD').split('\n').filter(Boolean);
 for(const f of successor)must([...Object.keys(SECTION15_REPAIR),...SECTION15_VALIDATION_FILES].includes(f),'section15_successor_scope:'+f);
 const accepted=git(root,'diff','--name-only',profile.baseline.head,ACCEPTED_DEMO.head).split('\n').filter(Boolean);
 const changed=git(root,'diff','--name-only',profile.baseline.head,'HEAD').split('\n').filter(Boolean);
 for(const f of changed)must(profile.authorized_changes.includes(f)||(accepted.includes(f)&&sha(execFileSync('git',['show','HEAD:'+f],{cwd:root}))===sha(execFileSync('git',['show',ACCEPTED_DEMO.head+':'+f],{cwd:root}))),'source_scope:'+f);
 for(const f of [...new Set([...profile.runtime_files,...Object.keys(profile.frozen_evidence_sha256),...Object.keys(NORMALIZED_PREVIEW),...Object.keys(WIDGET_REPLY_STABILITY),...Object.keys(WIDGET_AUTH_REPAIR),...Object.keys(MEMORY_REPLY_REPAIR),...Object.keys(PREVIEW_ACTIVATION),...Object.keys(GENERIC_SERVICE_REPAIR),...Object.keys(F13_F14_REPAIR),...Object.keys(B12_REGISTRY_REPAIR),...Object.keys(SECTION15_REPAIR),...Object.keys(ACCEPTED_DEMO_ENV),...accepted,PROFILE_PATH])]){
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
 must(JSON.stringify(profile.accepted_demo_checkpoint)===JSON.stringify(ACCEPTED_DEMO),'accepted_demo_profile_drift');
 must(JSON.stringify(profile.accepted_demo_env_sha256)===JSON.stringify(ACCEPTED_DEMO_ENV),'accepted_demo_env_profile_drift');
 for(const [f,h] of Object.entries(NORMALIZED_PREVIEW))must(fs.existsSync(path.join(root,f))&&sha(fs.readFileSync(path.join(root,f)))===(ACCEPTED_DEMO_ENV[f]??h),'preview_binding_drift:'+f);
 for(const [f,h] of Object.entries(ACCEPTED_DEMO_ENV))must(sha(fs.readFileSync(path.join(root,f)))===h,'accepted_demo_env_source_drift:'+f);
 must(JSON.stringify(profile.authorized_section15_repair_sha256)===JSON.stringify(SECTION15_REPAIR),'section15_scope_drift');
 must(profile.section15_deployment_authorized===false,'section15_production_authority_masquerade');
 for(const [f,h] of Object.entries(SECTION15_REPAIR))must(sha(fs.readFileSync(path.join(root,f)))===h,'section15_source_drift:'+f);
 for(const [f,h] of Object.entries(SECTION15_VALIDATION_SHA256))must(sha(fs.readFileSync(path.join(root,f)))===h,'section15_validation_drift:'+f);
 must(JSON.stringify(profile.widget_reply_stability_sha256)===JSON.stringify(WIDGET_REPLY_STABILITY),'widget_stability_profile_drift');
 for(const [f,h] of Object.entries(WIDGET_REPLY_STABILITY))must(fs.existsSync(path.join(root,f))&&sha(fs.readFileSync(path.join(root,f)))===(F13_F14_REPAIR[f]??GENERIC_SERVICE_REPAIR[f]??WIDGET_AUTH_REPAIR[f]??h),'widget_stability_source_drift:'+f);
 must(JSON.stringify(profile.authorized_widget_auth_repair_sha256)===JSON.stringify(WIDGET_AUTH_REPAIR),'widget_auth_profile_drift');
 for(const [f,h] of Object.entries(WIDGET_AUTH_REPAIR))must(sha(fs.readFileSync(path.join(root,f)))===(F13_F14_REPAIR[f]??GENERIC_SERVICE_REPAIR[f]??h),'widget_auth_source_drift:'+f);
 must(JSON.stringify(profile.authorized_memory_reply_repair_sha256)===JSON.stringify(MEMORY_REPLY_REPAIR),'memory_reply_profile_drift');
 must(profile.memory_reply_sql_production_authorized===false,'memory_reply_sql_authority_masquerade');
 for(const [f,h] of Object.entries(MEMORY_REPLY_REPAIR))must(sha(fs.readFileSync(path.join(root,f)))===(SECTION15_REPAIR[f]??F13_F14_REPAIR[f]??GENERIC_SERVICE_REPAIR[f]??h),'memory_reply_source_drift:'+f);
 must(JSON.stringify(profile.authorized_preview_activation_sha256)===JSON.stringify(PREVIEW_ACTIVATION),'preview_activation_profile_drift');
 for(const [f,h] of Object.entries(PREVIEW_ACTIVATION))must(sha(fs.readFileSync(path.join(root,f)))===h,'preview_activation_source_drift:'+f);
 must(profile.revision==='rev1.5-UNIFIED-GENERIC-SERVICE-AND-FULL-UAT','generic_repair_revision');
 must(JSON.stringify(profile.authorized_unified_generic_service_repair_sha256)===JSON.stringify(GENERIC_SERVICE_REPAIR),'generic_repair_scope_drift');
 for(const [f,h] of Object.entries(GENERIC_SERVICE_REPAIR))must(sha(fs.readFileSync(path.join(root,f)))===(SECTION15_REPAIR[f]??F13_F14_REPAIR[f]??h),'generic_repair_source_drift:'+f);
 must(JSON.stringify(profile.authorized_f13_f14_repair_sha256)===JSON.stringify(F13_F14_REPAIR),'f13_f14_scope_drift');
 for(const [f,h] of Object.entries(F13_F14_REPAIR))if(!profile.runtime_files.includes(f))must(sha(fs.readFileSync(path.join(root,f)))===(SECTION15_VALIDATION_SHA256[f]??B12_REGISTRY_REPAIR[f]??h),'f13_f14_source_drift:'+f);
 must(JSON.stringify(profile.authorized_b12_registry_repair_sha256)===JSON.stringify(B12_REGISTRY_REPAIR),'b12_scope_drift');
 for(const [f,h] of Object.entries(B12_REGISTRY_REPAIR))must(sha(fs.readFileSync(path.join(root,f)))===(SECTION15_VALIDATION_SHA256[f]??h),'b12_source_drift:'+f);
 must(profile.b12_sql_production_authorized===false&&profile.b12_deployment_authorized===false,'b12_production_authority_masquerade');
 must(profile.f13_f14_sql_production_authorized===false&&profile.f13_f14_deployment_authorized===false,'f13_f14_production_authority_masquerade');
 const files=productionClosure(root,profile);
 if(!sourceOnly){
  const expectedFrozen=profile.runtime_files.filter(f=>f!=='supabase/functions/_shared/ce-evaluation-scope.ts'&&f!=='supabase/functions/deliver-feedback-request/index.ts'&&f!=='supabase/functions/_shared/memory-reply-lifecycle-readback.ts'&&f!=='supabase/functions/_shared/service-semantic-routing.ts'&&f!=='supabase/functions/_shared/bounded-decision-context.ts');
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
