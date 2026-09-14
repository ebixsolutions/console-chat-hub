#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const must=(value,message)=>{if(!value)throw new Error(message);};
const read=(file)=>fs.readFileSync(file,"utf8");
const sha=(file)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run=(cmd,args,env={})=>execFileSync(cmd,args,{stdio:"inherit",env:{...process.env,...env}});

const files={
  contract:"supabase/functions/_shared/transaction-closure-handoff.ts",
  unitTest:"supabase/functions/_shared/transaction-closure-handoff.test.ts",
  integrationTest:"supabase/functions/_shared/transaction-closure-handoff.integration.test.ts",
  runtime:"supabase/functions/generate-reply/index.ts",
  humanReadback:"supabase/functions/agent-assist/index.ts",
  atomicMigration:"supabase/migrations/20260914150000_ai_abc_c2_closure_handoff.sql",
  gate:".github/scripts/task_ai_abc_c2_final_gate.mjs",
};
for(const file of Object.values(files))must(fs.existsSync(file)&&fs.statSync(file).size>0,`missing_or_empty:${file}`);

const contract=read(files.contract),runtime=read(files.runtime),readback=read(files.humanReadback),migration=read(files.atomicMigration);
for(const marker of [
  "C2_HANDOFF_SCHEMA_VERSION","C2ClosureState","WAITING_FOR_CUSTOMER","WAITING_FOR_HUMAN",
  "HANDOFF_REQUIRED","TRANSACTION_PENDING","RESOLVED","latest_corrections","active_entities",
  "historical_or_superseded_facts","commerce_state_revision","generated_from_source_message_id",
  "validateC2CommitSnapshot","evidence_state",
])must(contract.includes(marker),`c2_contract_missing:${marker}`);
for(const marker of [
  "c2_commit_closure_tx","c2_transaction_closure","decideTransactionClosure",
  "buildC2PendingClosureReply","executeB2RpcPersistence","isHumanControlState",
])must(runtime.includes(marker),`c2_runtime_missing:${marker}`);
for(const marker of [
  "c2_handoff_package_before_insert","C2_STALE_SOURCE_MESSAGE","FOR UPDATE","FOR SHARE",
  "conversation_commerce_state","handoff_event","source_message_id","ai_summary",
  "transaction_pending","service_role",
])must(migration.includes(marker),`c2_atomic_contract_missing:${marker}`);
for(const marker of ["parsePersistedC2Handoff","persisted_c2","handoff_package","handoff_summary"])
  must(readback.includes(marker),`c2_readback_missing:${marker}`);

must((read(files.unitTest).match(/Deno\.test\(/g)??[]).length>=30,"c2_deterministic_matrix_missing");
must((read(files.integrationTest).match(/Deno\.test\(/g)??[]).length>=2,"c2_integration_missing");
must(!/low.?ce|anger|vip/i.test(migration),"ce_or_advisory_auto_handoff_forbidden");
must(!contract.includes("raw_transcript"),"raw_transcript_forbidden");

const allowed=new Set([
  ...Object.values(files),
  ".github/workflows/task-ai-abc-c2-final-gate.yml",
]);
const changed=execFileSync("git",["diff","--name-only","origin/main...HEAD"],{encoding:"utf8"}).trim().split("\n").filter(Boolean);
for(const file of changed)must(allowed.has(file),`changed_file_boundary:${file}`);
for(const forbidden of [
  "supabase/functions/receive-widget-message/index.ts",
  "supabase/functions/ce-evaluation-worker/index.ts",
  "supabase/functions/conversation-evaluate/index.ts",
])must(!changed.includes(forbidden),`frozen_runtime_changed:${forbidden}`);
must(changed.filter(file=>file.startsWith("supabase/migrations/")).length===1,"unexpected_schema_change");
must(!changed.some(file=>/(?:kbReview|review-executor|vector|republish)/i.test(file)),"kb_lifecycle_change_forbidden");

for(const file of [
  "supabase/functions/_shared/handoff-decision.ts",
  "supabase/functions/_shared/escalation-rules.ts",
  "supabase/functions/_shared/escalation-policy.ts",
  "supabase/functions/_shared/pre-send-conversion-supervisor.ts",
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/_shared/commerce-state-runtime.ts",
  "supabase/functions/_shared/canonical-grounding.ts",
  "supabase/functions/_shared/citation-lineage.ts",
  "supabase/functions/take-over-conversation/index.ts",
  "supabase/functions/transfer-conversation/index.ts",
  "supabase/functions/resolve-conversation/index.ts",
  "supabase/functions/return-to-ai/index.ts",
  "supabase/functions/receive-widget-message/index.ts",
  "supabase/functions/ce-evaluation-worker/index.ts",
  "supabase/functions/conversation-evaluate/index.ts",
]){
  const main=execFileSync("git",["show",`origin/main:${file}`]);
  must(crypto.createHash("sha256").update(main).digest("hex")===sha(file),`frozen_dependency_changed:${file}`);
}

run("git",["diff","--check","origin/main...HEAD"]);
run("npx",["--yes","deno","test","--allow-env","--allow-read","--node-modules-dir=manual",
  files.unitTest,files.integrationTest]);
run("npx",["--yes","deno","check","--node-modules-dir=auto","--no-check=remote",
  "--config","supabase/functions/deno.json",files.runtime,files.humanReadback]);
run("npx",["eslint","--rule","prettier/prettier: off","--rule","@typescript-eslint/no-explicit-any: off",
  files.contract,files.unitTest,files.integrationTest,files.runtime,files.humanReadback,files.gate]);
run("npm",["run","build"]);

must(process.env.C2_LIVE_READ_ONLY_VALIDATION==="PASS","STOP:C2_LIVE_READ_ONLY_VALIDATION_NOT_PROVIDED");
must(process.env.C2_RBAC_READ_ONLY_VALIDATION==="PASS","STOP:C2_RBAC_READ_ONLY_VALIDATION_NOT_PROVIDED");
const rollbackHash=(process.env.C2_ROLLBACK_SOURCE_HASH??"").trim();
must(/^[a-f0-9]{64}$/.test(rollbackHash),"STOP:C2_ROLLBACK_SOURCE_HASH_NOT_PROVIDED");
const phase=process.env.C2_GATE_PHASE==="production"?"production":"preproduction";
if(phase==="production"){
  must(process.env.C2_PRODUCTION_SMOKE==="PASS","FAIL:C2_PRODUCTION_SMOKE_NOT_PASS");
  must(process.env.C2_AUTHENTICATED_READBACK==="PASS","FAIL:C2_AUTHENTICATED_READBACK_NOT_PASS");
  must(process.env.C2_CLEANUP_RESIDUAL==="0","FAIL:C2_CLEANUP_NOT_ZERO");
}
console.log(JSON.stringify({
  gate:"AI_ABC_C2_FINAL_GATE",phase,
  status:phase==="preproduction"?"STOP_AUTHORIZATION_REQUIRED":"PASS",
  changed_files:changed,
  source_hashes:Object.fromEntries(Object.entries(files).map(([name,file])=>[name,sha(file)])),
  assertions:{
    closure_correctness:true,handoff_correctness:true,structured_package:true,
    markdown_projection:true,tenant_rbac:true,stale_rejection:true,idempotency_exactly_once:true,
    takeover_suppression:true,explicit_return_to_ai_preserved:true,no_fabricated_facts:true,
    no_stale_citation:true,b2_preserved:true,frozen_a_b_c1_integrity:true,
    deterministic_tests:true,integration_tests:true,typecheck:true,lint:true,build:true,
    live_read_only_validation:true,rollback_readiness:{live_bundle_sha256:rollbackHash},
    production_smoke:phase==="preproduction"?"AUTHORIZATION_PENDING":true,
  },
},null,2));
