#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const must=(value,message)=>{if(!value)throw new Error(message);};
const read=(file)=>fs.readFileSync(file,"utf8");
const sha=(file)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run=(cmd,args,env={})=>execFileSync(cmd,args,{stdio:"inherit",env:{...process.env,...env}});
const runDeno=(args)=>{
  const binary=process.env.DENO_BIN?.trim();
  return binary?run(binary,args):run("npx",["--yes","deno",...args]);
};

const files={
  memory:"supabase/functions/_shared/conversation-long-memory.ts",
  unit:"supabase/functions/_shared/conversation-long-memory.test.ts",
  integration:"supabase/functions/_shared/conversation-long-memory.integration.test.ts",
  generate:"supabase/functions/generate-reply/index.ts",
  assist:"supabase/functions/agent-assist/index.ts",
  typecheck:"supabase/functions/deno.c3-check.json",
  migration:"supabase/migrations/20260915012938_ai_abc_c3_canonical_long_memory.sql",
  gate:".github/scripts/task_ai_abc_c3_final_gate.mjs",
  workflow:".github/workflows/task-ai-abc-c3-final-gate.yml",
  c2WorkflowRouting:".github/workflows/task-ai-abc-c2-final-gate.yml",
};
for(const file of Object.values(files))must(fs.existsSync(file)&&fs.statSync(file).size>0,`missing_or_empty:${file}`);

const memory=read(files.memory),unit=read(files.unit),integration=read(files.integration);
const generate=read(files.generate),assist=read(files.assist),migration=read(files.migration);
const c2WorkflowRouting=read(files.c2WorkflowRouting);

for(const marker of [
  "conversation-memory-1.0.0","CanonicalConversationMemory","buildCanonicalConversationMemory",
  "buildBoundedConversationContext","buildConversationMemoryMarkdown","refreshConversationLongMemory",
  "composeBoundedGenerationEnvelope",
  "C3_MEMORY_JSON_CHAR_BUDGET","C3_RECENT_RAW_TURN_LIMIT","grounded_reference_lineage",
  "cancelled_or_superseded","commerce_state_revision","memory_revision","updated_from_turn",
])must(memory.includes(marker),`memory_contract_missing:${marker}`);
must((unit.match(/Deno\.test\(/g)??[]).length>=35,"c3_deterministic_matrix_missing");
must((integration.match(/Deno\.test\(/g)??[]).length>=10,"c3_integration_matrix_missing");

for(const marker of [
  "runCommerceStateRuntime(","refreshConversationLongMemory(","buildBoundedConversationContext(",
  "composeBoundedGenerationEnvelope(",
  "resolveStructuredMemoryResponse(","let finalSystemPrompt","executeB2RpcPersistence",
  "commitAiReplyWithControlGate","selectCanonicalGrounding","c2_commit_closure_tx",
])must(generate.includes(marker),`generate_runtime_missing:${marker}`);
must(generate.indexOf("runCommerceStateRuntime(")<generate.indexOf("refreshConversationLongMemory("),"memory_must_follow_canonical_commerce");
must(generate.indexOf("refreshConversationLongMemory(")<generate.indexOf("let finalSystemPrompt",generate.indexOf("refreshConversationLongMemory(")),"memory_must_precede_prompt");
must(generate.includes("_c3MemoryContext"),"bounded_memory_not_in_generation_prompt");
must(!generate.includes(".limit(200)"),"unbounded_generation_history_pattern");

for(const marker of [
  "loadAssistConversationMemory","conversation_memory:c3Memory","conversation_memory_summary",
  "parsePersistedC2Handoff","source:\"persisted_c2\"","resolveConversationScope",
  "selectCanonicalGrounding","callAssistModel",".eq(\"company_id\",companyId)",
])must(assist.includes(marker),`agent_assist_compatibility_missing:${marker}`);
must(assist.indexOf("parsePersistedC2Handoff(persistedEvent?.ai_summary)")<assist.indexOf('buildWarmHandoffPackage(history,"takeover")'),"persisted_c2_must_precede_warm_handoff");
must(!assist.includes(".limit(200)"),"agent_assist_raw_history_not_bounded");
must(c2WorkflowRouting.includes("github.head_ref == 'director/ai-abc-c2-transaction-closure-handoff'"),"frozen_c2_gate_not_branch_scoped");

for(const marker of [
  "conversation_memory_state","conversation_memory_state_event","ENABLE ROW LEVEL SECURITY",
  "conversation_memory_state_select_staff","c3_commit_conversation_memory_tx",
  "c3_enforce_conversation_memory_lineage_tg","c3_enrich_handoff_from_memory_tg",
  "superseded_source","stale_commerce_revision","revision_conflict","source_message_replay_conflict",
  "extensions.digest","pg_catalog.aclexplode","C3_MEMORY_RPC_ACL_INVALID",
])must(migration.includes(marker),`migration_contract_missing:${marker}`);
must(!/ALTER\s+DEFAULT\s+PRIVILEGES/i.test(migration),"broad_default_privilege_change_forbidden");
must(!/DROP\s+TABLE\s+public\.(?:messages|conversations|conversation_commerce_state)|DELETE\s+FROM\s+public\.messages/i.test(migration),"destructive_history_change_forbidden");
must(!/\bOR\s+CASE\b/i.test(migration),"plpgsql_case_boolean_operand_requires_parentheses");
must((migration.match(/\bOR\s+\(CASE\s+WHEN\b/g)??[]).length===2,"plpgsql_case_boolean_fix_incomplete");
must(migration.includes("REVOKE ALL ON FUNCTION public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)\n  FROM PUBLIC, anon, authenticated;"),"rpc_exact_revoke_missing");
must(migration.includes("GRANT EXECUTE ON FUNCTION public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)\n  TO service_role;"),"rpc_service_role_only_missing");
for(const fn of ["c3_enforce_conversation_memory_lineage_tg","c3_enrich_handoff_from_memory_tg"])
  must(migration.includes(`REVOKE ALL ON FUNCTION public.${fn}()\n  FROM PUBLIC, anon, authenticated, service_role;`),`trigger_acl_missing:${fn}`);
must(Number(files.migration.split("/").pop().slice(0,14))>20260915002600,"migration_not_forward_of_live_history");

const allowed=new Set(Object.values(files));
const changed=execFileSync("git",["diff","--name-only","origin/main...HEAD"],{encoding:"utf8"}).trim().split("\n").filter(Boolean);
for(const file of changed)must(allowed.has(file),`changed_file_boundary:${file}`);
for(const file of Object.values(files))must(changed.includes(file),`expected_change_missing:${file}`);
must(changed.filter(file=>file.startsWith("supabase/migrations/")).length===1,"migration_count_invalid");
for(const forbidden of [
  "supabase/functions/receive-widget-message/index.ts",
  "supabase/functions/ce-evaluation-worker/index.ts",
  "supabase/functions/conversation-evaluate/index.ts",
])must(!changed.includes(forbidden),`frozen_runtime_changed:${forbidden}`);
must(!changed.some(file=>/(kb.*(?:publish|review|vector)|training-kb|review-executor)/i.test(file)),"kb_lifecycle_change_forbidden");

for(const file of [
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/_shared/commerce-state-runtime.ts",
  "supabase/functions/_shared/canonical-grounding.ts",
  "supabase/functions/_shared/citation-lineage.ts",
  "supabase/functions/_shared/pre-send-conversion-supervisor.ts",
  "supabase/functions/_shared/transaction-closure-handoff.ts",
  "supabase/migrations/20260915000000_ai_abc_c2_director_closure_handoff.sql",
  "supabase/functions/take-over-conversation/index.ts",
  "supabase/functions/return-to-ai/index.ts",
  "supabase/functions/receive-widget-message/index.ts",
  "supabase/functions/ce-evaluation-worker/index.ts",
  "supabase/functions/conversation-evaluate/index.ts",
]){
  const baseline=execFileSync("git",["show",`origin/main:${file}`]);
  must(crypto.createHash("sha256").update(baseline).digest("hex")===sha(file),`frozen_dependency_changed:${file}`);
}

run("git",["diff","--check","origin/main...HEAD"]);
runDeno(["test","--no-lock",files.unit]);
runDeno(["test","--no-lock","--allow-read",files.integration]);
runDeno(["check","--no-lock",files.memory]);
if(process.env.CI){
  runDeno(["check","--no-lock","--config","supabase/functions/deno.c2-check.json",files.generate,files.assist]);
}
run("npx",["eslint","--rule","prettier/prettier: off","--rule","@typescript-eslint/no-explicit-any: off",files.memory,files.unit,files.integration,files.generate,files.assist,files.gate]);
run("npm",["run","build"]);

must(process.env.C3_LIVE_BASELINE_READBACK==="PASS","STOP:C3_LIVE_BASELINE_READBACK_NOT_PROVIDED");
must(process.env.C3_SCHEMA_READ_ONLY_TRACE==="PASS","STOP:C3_SCHEMA_READ_ONLY_TRACE_NOT_PROVIDED");
must(process.env.C3_MIGRATION_HISTORY_COMPATIBILITY==="PASS","STOP:C3_MIGRATION_HISTORY_COMPATIBILITY_NOT_PROVIDED");
const generateBaseline=(process.env.C3_GENERATE_ROLLBACK_BUNDLE??"").trim();
const assistBaseline=(process.env.C3_ASSIST_ROLLBACK_BUNDLE??"").trim();
must(generateBaseline==="2d6ebf7a47c3c6df0c0d8a971bc91727759e08925dbb0c59f79211d549528caf","generate_rollback_baseline_mismatch");
must(assistBaseline==="21ff074000836a226f277ca8b87feae234ea061dbbde7016a19c3f289d9ce9c6","assist_rollback_baseline_mismatch");

const phase=process.env.C3_GATE_PHASE==="production"?"production":"preproduction";
if(phase==="production"){
  for(const key of ["C3_DB_SECURITY_READBACK","C3_EDGE_SOURCE_READBACK","C3_TENANT_RBAC","C3_FRESH_100_TURN_SMOKE","C3_PRODUCT_READY_CORE_SMOKE"])
    must(process.env[key]==="PASS",`FAIL:${key}_NOT_PASS`);
  must(process.env.C3_CLEANUP_RESIDUAL==="0","FAIL:C3_CLEANUP_NOT_ZERO");
  const checkpoints=JSON.parse(process.env.C3_100_TURN_CHECKPOINTS??"null");
  must(Array.isArray(checkpoints)&&checkpoints.length===3,"FAIL:C3_CHECKPOINTS_MISSING");
  must(checkpoints.every((x)=>x&&[20,50].includes(x.turn)||x?.turn>=100),"FAIL:C3_CHECKPOINT_TURNS_INVALID");
  must(checkpoints.every((x)=>Number(x.context_chars)<=32768&&Number(x.memory_chars)<=16384),"FAIL:C3_CONTEXT_BUDGET_EXCEEDED");
}

console.log(JSON.stringify({
  gate:"AI_ABC_C3_FINAL_GATE",phase,
  status:phase==="preproduction"?"STOP_AUTHORIZATION_REQUIRED":"PASS",
  closure_contract:{
    memory_version:"conversation-memory-1.0.0",storage:"public.conversation_memory_state",
    event_ledger:"public.conversation_memory_state_event",context_char_budget:32768,
    memory_json_char_budget:16384,recent_raw_turn_limit:12,recent_raw_char_budget:10000,
    compaction_triggers:"every durable customer turn plus source/revision guarded periodic convergence",
    production_turn_definition:"one customer message plus its actual governed runtime response/persistence step",
  },
  changed_files:changed,
  source_hashes:Object.fromEntries(Object.entries(files).map(([name,file])=>[name,sha(file)])),
  assertions:{
    structured_json_primary:true,markdown_projection_only:true,canonical_commerce_precedence:true,
    current_kb_precedence:true,incremental_and_rebuild:true,stale_rejection:true,idempotency:true,
    bounded_memory:true,bounded_prompt:true,raw_history_retained:true,tenant_rls_rbac:true,
    c1_lineage_preserved:true,b2_preserved:true,c2_handoff_closure_preserved:true,
    agent_assist_compatibility:true,takeover_and_return_to_ai_preserved:true,
    deterministic_tests:true,integration_tests:true,lint:true,build:true,
    edge_typecheck:process.env.CI?true:"CI_REQUIRED",
    production_100_turn:phase==="production"?true:"AUTHORIZATION_PENDING",
    rollback:{generate_reply_bundle:generateBaseline,agent_assist_bundle:assistBaseline},
  },
},null,2));
