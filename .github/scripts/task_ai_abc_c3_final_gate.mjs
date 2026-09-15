#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const must = (value, message) => {
  if (!value) throw new Error(message);
};
const read = (file) => fs.readFileSync(file, "utf8");
const sha = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
const runDeno = (args) => {
  const binary = process.env.DENO_BIN?.trim();
  return binary ? run(binary, args) : run("npx", ["--yes", "deno", ...args]);
};

const files = {
  memory: "supabase/functions/_shared/conversation-long-memory.ts",
  unit: "supabase/functions/_shared/conversation-long-memory.test.ts",
  integration:
    "supabase/functions/_shared/conversation-long-memory.integration.test.ts",
  terminalGuard: "supabase/functions/_shared/generation-terminal-guard.ts",
  terminalTest: "supabase/functions/_shared/generation-terminal-guard.test.ts",
  llmRouter: "supabase/functions/_shared/llm-router.ts",
  kbClient: "supabase/functions/_shared/kb-client.ts",
  semanticInterpreter:
    "supabase/functions/_shared/commerce-semantic-interpreter.ts",
  escalationPolicy: "supabase/functions/_shared/escalation-policy.ts",
  generate: "supabase/functions/generate-reply/index.ts",
  assist: "supabase/functions/agent-assist/index.ts",
  typecheck: "supabase/functions/deno.c3-check.json",
  migration:
    "supabase/migrations/20260915040000_ai_abc_c3_director_runtime_closure.sql",
  gate: ".github/scripts/task_ai_abc_c3_final_gate.mjs",
  workflow: ".github/workflows/task-ai-abc-c3-final-gate.yml",
  c2WorkflowRouting: ".github/workflows/task-ai-abc-c2-final-gate.yml",
};
for (const file of Object.values(files)) {
  must(
    fs.existsSync(file) && fs.statSync(file).size > 0,
    `missing_or_empty:${file}`,
  );
}

const memory = read(files.memory),
  unit = read(files.unit),
  integration = read(files.integration);
const terminalGuard = read(files.terminalGuard),
  terminalTest = read(files.terminalTest);
const generate = read(files.generate),
  assist = read(files.assist),
  migration = read(files.migration);
const c2WorkflowRouting = read(files.c2WorkflowRouting);
const migrationExecutableBody = migration.split("\n").slice(3).join("\n");
must(
  crypto.createHash("sha256").update(migrationExecutableBody).digest("hex") ===
    "c58361cc5a2c1516c8d33bca9c2f7c59b675d7b7a6a39a49dd2b9aae0c1797eb",
  "migration_rehearsed_executable_body_drift",
);

for (
  const marker of [
    "conversation-memory-1.0.0",
    "CanonicalConversationMemory",
    "buildCanonicalConversationMemory",
    "buildBoundedConversationContext",
    "buildConversationMemoryMarkdown",
    "refreshConversationLongMemory",
    "composeBoundedGenerationEnvelope",
    "C3_MEMORY_JSON_CHAR_BUDGET",
    "C3_RECENT_RAW_TURN_LIMIT",
    "grounded_reference_lineage",
    "cancelled_or_superseded",
    "commerce_state_revision",
    "memory_revision",
    "updated_from_turn",
  ]
) must(memory.includes(marker), `memory_contract_missing:${marker}`);
must(
  (unit.match(/Deno\.test\(/g) ?? []).length >= 35,
  "c3_deterministic_matrix_missing",
);
must(
  (integration.match(/Deno\.test\(/g) ?? []).length >= 10,
  "c3_integration_matrix_missing",
);
must(
  (terminalTest.match(/Deno\.test\(/g) ?? []).length >= 5,
  "terminal_regression_matrix_missing",
);
for (
  const marker of [
    "GENERATION_WORK_BUDGET_MS = 75_000",
    "GENERATION_TERMINAL_RESERVE_MS = 15_000",
    "GENERATION_RESPONSE_BUDGET_MS",
    "runWithTerminalDeadline",
    "historicalQuoteValidityReply",
    "terminalRecoveryReply",
  ]
) must(terminalGuard.includes(marker), `terminal_contract_missing:${marker}`);

for (
  const marker of [
    "runCommerceStateRuntime(",
    "refreshConversationLongMemory(",
    "buildBoundedConversationContext(",
    "composeBoundedGenerationEnvelope(",
    "resolveStructuredMemoryResponse(",
    "let finalSystemPrompt",
    "executeB2RpcPersistence",
    "commitAiReplyWithControlGate",
    "selectCanonicalGrounding",
    "c2_commit_closure_tx",
    "runWithTerminalDeadline(",
    "persistTerminalRecovery(",
    "terminal_failure_recovery",
    "previous_quote_not_authoritative_for_current_price",
    "signal: requestSignal",
  ]
) must(generate.includes(marker), `generate_runtime_missing:${marker}`);
must(
  generate.indexOf("runCommerceStateRuntime(") <
    generate.indexOf("refreshConversationLongMemory("),
  "memory_must_follow_canonical_commerce",
);
must(
  generate.indexOf("refreshConversationLongMemory(") <
    generate.indexOf(
      "let finalSystemPrompt",
      generate.indexOf("refreshConversationLongMemory("),
    ),
  "memory_must_precede_prompt",
);
must(
  generate.includes("_c3MemoryContext"),
  "bounded_memory_not_in_generation_prompt",
);
must(!generate.includes(".limit(200)"), "unbounded_generation_history_pattern");
must(
  generate.indexOf("runWithTerminalDeadline(") <
    generate.indexOf("orchestrationGenerateReply("),
  "terminal_deadline_must_wrap_orchestration",
);
must(
  terminalTest.includes("passes frozen B2 without asserting current price"),
  "turn5_historical_quote_regression_missing",
);
must(
  terminalTest.includes("fallback was not exactly once"),
  "terminal_exactly_once_regression_missing",
);

for (
  const marker of [
    "loadAssistConversationMemory",
    "conversation_memory:c3Memory",
    "conversation_memory_summary",
    "parsePersistedC2Handoff",
    'source:"persisted_c2"',
    "resolveConversationScope",
    "selectCanonicalGrounding",
    "callAssistModel",
    '.eq("company_id",companyId)',
  ]
) must(assist.includes(marker), `agent_assist_compatibility_missing:${marker}`);
must(
  assist.indexOf("parsePersistedC2Handoff(persistedEvent?.ai_summary)") <
    assist.indexOf('buildWarmHandoffPackage(history,"takeover")'),
  "persisted_c2_must_precede_warm_handoff",
);
must(!assist.includes(".limit(200)"), "agent_assist_raw_history_not_bounded");
must(
  c2WorkflowRouting.includes(
    "github.head_ref == 'director/ai-abc-c2-transaction-closure-handoff'",
  ),
  "frozen_c2_gate_not_branch_scoped",
);

for (
  const marker of [
    "conversation_memory_state",
    "conversation_memory_state_event",
    "ENABLE ROW LEVEL SECURITY",
    "conversation_memory_state_select_staff",
    "c3_commit_conversation_memory_tx",
    "c3_enforce_conversation_memory_lineage_tg",
    "c3_enrich_handoff_from_memory_tg",
    "superseded_source",
    "stale_commerce_revision",
    "revision_conflict",
    "source_message_replay_conflict",
    "extensions.digest",
    "pg_catalog.aclexplode",
    "C3_MEMORY_RPC_ACL_INVALID",
  ]
) must(migration.includes(marker), `migration_contract_missing:${marker}`);
must(
  !/ALTER\s+DEFAULT\s+PRIVILEGES/i.test(migration),
  "broad_default_privilege_change_forbidden",
);
must(
  !/DROP\s+TABLE\s+public\.(?:messages|conversations|conversation_commerce_state)|DELETE\s+FROM\s+public\.messages/i
    .test(migration),
  "destructive_history_change_forbidden",
);
must(
  !/\bOR\s+CASE\b/i.test(migration),
  "plpgsql_case_boolean_operand_requires_parentheses",
);
must(
  (migration.match(/\bOR\s+\(CASE\s+WHEN\b/g) ?? []).length === 2,
  "plpgsql_case_boolean_fix_incomplete",
);
must(
  migration.includes(
    "REVOKE ALL ON FUNCTION public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)\n  FROM PUBLIC, anon, authenticated;",
  ),
  "rpc_exact_revoke_missing",
);
must(
  migration.includes(
    "GRANT EXECUTE ON FUNCTION public.c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)\n  TO service_role;",
  ),
  "rpc_service_role_only_missing",
);
for (
  const fn of [
    "c3_enforce_conversation_memory_lineage_tg",
    "c3_enrich_handoff_from_memory_tg",
  ]
) {
  must(
    migration.includes(
      `REVOKE ALL ON FUNCTION public.${fn}()\n  FROM PUBLIC, anon, authenticated, service_role;`,
    ),
    `trigger_acl_missing:${fn}`,
  );
}
must(
  Number(files.migration.split("/").pop().slice(0, 14)) > 20260915033054,
  "migration_not_forward_of_apply_rollback_history",
);
must(
  migration.includes(
    "prior 20260915012938 version is intentionally not replayed",
  ),
  "forward_migration_history_contract_missing",
);

const allowed = new Set(Object.values(files));
const changed = execFileSync("git", [
  "diff",
  "--name-only",
  "origin/main...HEAD",
], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
for (const file of changed) {
  must(allowed.has(file), `changed_file_boundary:${file}`);
}
for (const file of Object.values(files)) {
  must(changed.includes(file), `expected_change_missing:${file}`);
}
must(
  changed.filter((file) => file.startsWith("supabase/migrations/")).length ===
    1,
  "migration_count_invalid",
);
for (
  const forbidden of [
    "supabase/functions/receive-widget-message/index.ts",
    "supabase/functions/ce-evaluation-worker/index.ts",
    "supabase/functions/conversation-evaluate/index.ts",
  ]
) must(!changed.includes(forbidden), `frozen_runtime_changed:${forbidden}`);
must(
  !changed.some((file) =>
    /(kb.*(?:publish|review|vector)|training-kb|review-executor)/i.test(file)
  ),
  "kb_lifecycle_change_forbidden",
);

for (
  const file of [
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
  ]
) {
  const baseline = execFileSync("git", ["show", `origin/main:${file}`]);
  must(
    crypto.createHash("sha256").update(baseline).digest("hex") === sha(file),
    `frozen_dependency_changed:${file}`,
  );
}

run("git", ["diff", "--check", "origin/main...HEAD"]);
runDeno(["test", "--no-lock", files.unit, files.terminalTest]);
runDeno(["test", "--no-lock", "--allow-read", files.integration]);
runDeno([
  "check",
  "--no-lock",
  files.memory,
  files.terminalGuard,
  files.terminalTest,
]);
if (process.env.CI) {
  runDeno([
    "check",
    "--no-lock",
    "--config",
    "supabase/functions/deno.c2-check.json",
    files.generate,
    files.assist,
  ]);
}
run("npx", [
  "eslint",
  "--rule",
  "prettier/prettier: off",
  "--rule",
  "@typescript-eslint/no-explicit-any: off",
  files.memory,
  files.unit,
  files.integration,
  files.terminalGuard,
  files.terminalTest,
  files.llmRouter,
  files.kbClient,
  files.semanticInterpreter,
  files.escalationPolicy,
  files.generate,
  files.assist,
  files.gate,
]);
run("npm", ["run", "build"]);

must(
  process.env.C3_LIVE_BASELINE_READBACK === "PASS",
  "STOP:C3_LIVE_BASELINE_READBACK_NOT_PROVIDED",
);
must(
  process.env.C3_SCHEMA_READ_ONLY_TRACE === "PASS",
  "STOP:C3_SCHEMA_READ_ONLY_TRACE_NOT_PROVIDED",
);
must(
  process.env.C3_MIGRATION_HISTORY_COMPATIBILITY === "PASS",
  "STOP:C3_MIGRATION_HISTORY_COMPATIBILITY_NOT_PROVIDED",
);
must(
  process.env.C3_MIGRATION_RUNTIME_REHEARSAL === "PASS",
  "STOP:C3_MIGRATION_RUNTIME_REHEARSAL_NOT_PROVIDED",
);
const generateBaseline = (process.env.C3_GENERATE_ROLLBACK_BUNDLE ?? "").trim();
const assistBaseline = (process.env.C3_ASSIST_ROLLBACK_BUNDLE ?? "").trim();
must(
  generateBaseline ===
    "2d6ebf7a47c3c6df0c0d8a971bc91727759e08925dbb0c59f79211d549528caf",
  "generate_rollback_baseline_mismatch",
);
must(
  assistBaseline ===
    "2ec8c764205b79f11730e31b9f3624a872f050f96f24fef396d6e700e7a37aa2",
  "assist_rollback_baseline_mismatch",
);
must(
  process.env.C3_ROLLBACK_IDENTITY_MODE === "SOURCE_CLOSURE",
  "rollback_identity_must_use_source_closure",
);
must(
  process.env.C3_GENERATE_ROLLBACK_SOURCE_CLOSURE === "PASS",
  "generate_rollback_source_closure_mismatch",
);
must(
  process.env.C3_ASSIST_ROLLBACK_SOURCE_CLOSURE === "PASS",
  "assist_rollback_source_closure_mismatch",
);
must(
  process.env.C3_GENERATE_ROLLBACK_FILE_COUNT === "44",
  "generate_rollback_file_count_mismatch",
);
must(
  process.env.C3_ASSIST_ROLLBACK_FILE_COUNT === "19",
  "assist_rollback_file_count_mismatch",
);
must(
  process.env.C3_GENERATE_ROLLBACK_SOURCE_MISMATCH === "0",
  "generate_rollback_source_mismatch",
);
must(
  process.env.C3_ASSIST_ROLLBACK_SOURCE_MISMATCH === "0",
  "assist_rollback_source_mismatch",
);
must(
  process.env.C3_ASSIST_BUNDLE_REBUILD_RECONCILED === "PASS",
  "assist_bundle_rebuild_not_reconciled",
);

const phase = process.env.C3_GATE_PHASE === "production"
  ? "production"
  : "preproduction";
if (phase === "production") {
  for (
    const key of [
      "C3_DB_SECURITY_READBACK",
      "C3_EDGE_SOURCE_READBACK",
      "C3_TENANT_RBAC",
      "C3_FRESH_100_TURN_SMOKE",
      "C3_PRODUCT_READY_CORE_SMOKE",
    ]
  ) {
    must(process.env[key] === "PASS", `FAIL:${key}_NOT_PASS`);
  }
  must(process.env.C3_CLEANUP_RESIDUAL === "0", "FAIL:C3_CLEANUP_NOT_ZERO");
  const checkpoints = JSON.parse(process.env.C3_100_TURN_CHECKPOINTS ?? "null");
  must(
    Array.isArray(checkpoints) && checkpoints.length === 3,
    "FAIL:C3_CHECKPOINTS_MISSING",
  );
  must(
    checkpoints.every((x) => x && [20, 50].includes(x.turn) || x?.turn >= 100),
    "FAIL:C3_CHECKPOINT_TURNS_INVALID",
  );
  must(
    checkpoints.every((x) =>
      Number(x.context_chars) <= 32768 && Number(x.memory_chars) <= 16384
    ),
    "FAIL:C3_CONTEXT_BUDGET_EXCEEDED",
  );
}

console.log(JSON.stringify(
  {
    gate: "AI_ABC_C3_FINAL_GATE",
    phase,
    status: phase === "preproduction" ? "STOP_AUTHORIZATION_REQUIRED" : "PASS",
    closure_contract: {
      memory_version: "conversation-memory-1.0.0",
      storage: "public.conversation_memory_state",
      event_ledger: "public.conversation_memory_state_event",
      context_char_budget: 32768,
      memory_json_char_budget: 16384,
      recent_raw_turn_limit: 12,
      recent_raw_char_budget: 10000,
      compaction_triggers:
        "every durable customer turn plus source/revision guarded periodic convergence",
      production_turn_definition:
        "one customer message plus its actual governed runtime response/persistence step",
    },
    changed_files: changed,
    source_hashes: Object.fromEntries(
      Object.entries(files).map(([name, file]) => [name, sha(file)]),
    ),
    assertions: {
      structured_json_primary: true,
      markdown_projection_only: true,
      canonical_commerce_precedence: true,
      current_kb_precedence: true,
      incremental_and_rebuild: true,
      stale_rejection: true,
      idempotency: true,
      bounded_memory: true,
      bounded_prompt: true,
      raw_history_retained: true,
      tenant_rls_rbac: true,
      c1_lineage_preserved: true,
      b2_preserved: true,
      c2_handoff_closure_preserved: true,
      agent_assist_compatibility: true,
      takeover_and_return_to_ai_preserved: true,
      deterministic_tests: true,
      integration_tests: true,
      lint: true,
      build: true,
      historical_quote_currentness: true,
      terminal_response_budget_ms: 90000,
      source_closure_rollback_identity: true,
      migration_runtime_rehearsal: true,
      edge_typecheck: process.env.CI ? true : "CI_REQUIRED",
      production_100_turn: phase === "production"
        ? true
        : "AUTHORIZATION_PENDING",
      rollback: {
        identity: "SOURCE_CLOSURE",
        generate_reply_bundle_observed: generateBaseline,
        agent_assist_bundle_observed: assistBaseline,
      },
    },
  },
  null,
  2,
));
