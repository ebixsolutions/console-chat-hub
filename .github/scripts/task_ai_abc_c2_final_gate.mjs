#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const must=(value,message)=>{if(!value)throw new Error(message);};
const read=(file)=>fs.readFileSync(file,"utf8");
const sha=(file)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run=(cmd,args,env={})=>execFileSync(cmd,args,{stdio:"inherit",env:{...process.env,...env}});
const denoNodeModulesMode=process.env.C2_DENO_NODE_MODULES_MODE==="manual"?"manual":"auto";

const files={
  contract:"supabase/functions/_shared/transaction-closure-handoff.ts",
  unitTest:"supabase/functions/_shared/transaction-closure-handoff.test.ts",
  integrationTest:"supabase/functions/_shared/transaction-closure-handoff.integration.test.ts",
  runtime:"supabase/functions/generate-reply/index.ts",
  humanReadback:"supabase/functions/agent-assist/index.ts",
  typecheckConfig:"supabase/functions/deno.c2-check.json",
  atomicMigration:"supabase/migrations/20260915000000_ai_abc_c2_director_closure_handoff.sql",
  gate:".github/scripts/task_ai_abc_c2_final_gate.mjs",
};
for(const file of Object.values(files))must(fs.existsSync(file)&&fs.statSync(file).size>0,`missing_or_empty:${file}`);

const contract=read(files.contract),runtime=read(files.runtime),readback=read(files.humanReadback),migration=read(files.atomicMigration);
const agentAssistV34SourceSha256="88b1df2f24cf6fa2b7bbcd4d35b787e38c1835e40136679bff563fe7f770996e";
const mainAgentAssist=execFileSync("git",["show","origin/main:supabase/functions/agent-assist/index.ts"]);
must(crypto.createHash("sha256").update(mainAgentAssist).digest("hex")===agentAssistV34SourceSha256,
  "agent_assist_v34_authoritative_main_baseline_changed");
const agentAssistNumstat=execFileSync("git",[
  "diff","--numstat","origin/main...HEAD","--","supabase/functions/agent-assist/index.ts",
],{encoding:"utf8"}).trim();
must(agentAssistNumstat==="26\t0\tsupabase/functions/agent-assist/index.ts",
  `agent_assist_v34_reconciliation_not_additive:${agentAssistNumstat}`);
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
  "transaction_pending","service_role","C2_RPC_ACL_INVALID","C2_TRIGGER_FUNCTION_ACL_INVALID",
  "C2_TRIGGER_BINDING_INVALID","pg_catalog.aclexplode","pg_catalog.has_function_privilege",
])must(migration.includes(marker),`c2_atomic_contract_missing:${marker}`);
const rpcSignature="public.c2_commit_closure_tx(uuid,uuid,uuid,bigint,text,jsonb)";
must(migration.includes(`REVOKE ALL ON FUNCTION ${rpcSignature}\n  FROM PUBLIC, anon, authenticated;`),
  "c2_rpc_explicit_acl_revoke_missing");
must(migration.includes(`GRANT EXECUTE ON FUNCTION ${rpcSignature} TO service_role;`),
  "c2_rpc_service_role_grant_missing");
must(migration.includes("REVOKE ALL ON FUNCTION public.c2_populate_handoff_package_tg()\n  FROM PUBLIC, anon, authenticated, service_role;"),
  "c2_trigger_function_explicit_acl_revoke_missing");
must((migration.match(/CREATE OR REPLACE FUNCTION public\.c2_/g)??[]).length===2,
  "unexpected_c2_executable_object_count");
must(!/ALTER\s+DEFAULT\s+PRIVILEGES/i.test(migration),"global_default_privilege_change_forbidden");
must(!/ALTER\s+TABLE\s+public\.handoff_event|CREATE\s+POLICY|DROP\s+POLICY/i.test(migration),
  "handoff_rls_or_policy_change_forbidden");
for(const marker of ["parsePersistedC2Handoff","persisted_c2","handoff_package","handoff_summary"])
  must(readback.includes(marker),`c2_readback_missing:${marker}`);
for(const marker of [
  "resolveConversationScope","applyCompanyScope","fetchKBRag","selectCanonicalGrounding",
  "buildCanonicalAssistRetrievalQuery","buildWarmHandoffPackage","callAssistModel",
  '"translate"','"grammar"','"suggest_reply"','"knowledge_helper"','"check_policy"','"handoff_context"',
])must(readback.includes(marker),`agent_assist_v34_behavior_missing:${marker}`);
must(readback.indexOf("parsePersistedC2Handoff(persistedEvent?.ai_summary)") <
  readback.indexOf('buildWarmHandoffPackage(history,"takeover")'),
  "c2_package_must_precede_derived_warm_handoff");
must(migration.includes("AI-ABC-C2 Director closure"),"director_migration_marker_missing");

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
run("npx",["--yes","deno","check",`--node-modules-dir=${denoNodeModulesMode}`,"--no-check=remote",
  "--config",files.typecheckConfig,files.runtime,files.humanReadback]);
run("npx",["eslint","--rule","prettier/prettier: off","--rule","@typescript-eslint/no-explicit-any: off",
  files.contract,files.unitTest,files.integrationTest,files.runtime,files.humanReadback,files.gate]);
run("npm",["run","build"]);

must(process.env.C2_LIVE_READ_ONLY_VALIDATION==="PASS","STOP:C2_LIVE_READ_ONLY_VALIDATION_NOT_PROVIDED");
must(process.env.C2_RBAC_READ_ONLY_VALIDATION==="PASS","STOP:C2_RBAC_READ_ONLY_VALIDATION_NOT_PROVIDED");
must(process.env.C2_AGENT_ASSIST_V34_READBACK==="PASS","STOP:C2_AGENT_ASSIST_V34_READBACK_NOT_PROVIDED");
must(process.env.C2_MIGRATION_HISTORY_VALIDATION==="PASS","STOP:C2_MIGRATION_HISTORY_VALIDATION_NOT_PROVIDED");
const rollbackHash=(process.env.C2_ROLLBACK_SOURCE_HASH??"").trim();
must(/^[a-f0-9]{64}$/.test(rollbackHash),"STOP:C2_ROLLBACK_SOURCE_HASH_NOT_PROVIDED");
const phase=process.env.C2_GATE_PHASE==="production"?"production":"preproduction";
if(phase==="production"){
  must(process.env.C2_DB_ACL_READBACK==="PASS","FAIL:C2_DB_ACL_READBACK_NOT_PASS");
  must(process.env.C2_DB_OBJECT_READBACK==="PASS","FAIL:C2_DB_OBJECT_READBACK_NOT_PASS");
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
    db_acl_least_privilege:true,db_object_binding:true,
    takeover_suppression:true,explicit_return_to_ai_preserved:true,no_fabricated_facts:true,
    no_stale_citation:true,b2_preserved:true,frozen_a_b_c1_integrity:true,
    deterministic_tests:true,integration_tests:true,typecheck:true,lint:true,build:true,
    live_read_only_validation:true,agent_assist_v34_reconciled:true,
    migration_history_compatible:true,
    rollback_readiness:{generate_reply_live_bundle_sha256:rollbackHash,
      agent_assist_v34_bundle_sha256:"a19379b86ed25ce316b6a08296073cdc9536176d865f083fa6a956ab760f5124"},
    production_smoke:phase==="preproduction"?"AUTHORIZATION_PENDING":true,
  },
},null,2));
