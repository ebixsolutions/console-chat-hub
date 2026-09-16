#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { readContract, verifyEvidence, EVIDENCE_SCHEMA_VERSION, LIVE_EXPECTED } from "./c3_validation_evidence.mjs";
import { classifyMergeEvent } from "./c3_merge_no_redeploy_guard.mjs";

const contractPath = ".github/scripts/c3_validation_scenarios.json";
const contractInfo = readContract(contractPath);
execFileSync("python", [
  ".github/scripts/c3_validation_only_runner.py", "db-contract-test",
  "--out", "/tmp/c3-db-readback-contract-test",
  "--contract", contractPath,
], { stdio: "inherit" });
const head = "1".repeat(40);
const tree = "2".repeat(40);
const runId = "35045000000";
const attempt = "1";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const replyFor = (row) => {
  const expected = row.expected ?? {};
  return [
    ...(expected.include_all ?? []),
    ...(expected.include_any?.slice(0, 1) ?? []),
    ...(expected.include_any_secondary?.slice(0, 1) ?? []),
  ].join("；") || "controlled response";
};
const coreNames = [
  "request_deadline_cancellation", "terminal_budget_75000_15000_90000_120000",
  "source_bound_b2_atomic_commit", "late_completion_exactly_once", "memory_initial_creation",
  "memory_incremental_update", "stale_rejection_and_fresh_retry", "idempotency_exactly_once_event",
  "wrong_tenant_rejection", "canonical_snapshot_non_null", "takeover_suppression",
  "superseded_source_rejection", "c1_current_fact_authority", "c2_handoff_precedence",
  "agent_assist_tenant_safe", "return_to_ai_explicit_only", "no_direct_persistence_bypass",
];

function validEvidence() {
  const sourceIds = Array.from({ length: 100 }, (_, index) => uuid(index + 1000));
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    mode: "live_production",
    repository: "ebixsolutions/console-chat-hub",
    project: "nrfxhqabwblzxoushgnm",
    run: { id: runId, attempt, started_at: "2026-09-16T02:30:00Z" },
    runner: { head, tree },
    scenario_contract: { version: contractInfo.contract.contract_version, sha256: contractInfo.sha256 },
    artifact: { id: 10427225513, digest: "sha256:" + "a".repeat(64) },
    live_functions: Object.entries(LIVE_EXPECTED).map(([name, row]) => ({
      function: name, version: row.version, status: "ACTIVE", verify_jwt: row.verify_jwt,
      import_map: row.import_map, bundle: row.bundle, source_manifest_sha256: "b".repeat(64), source_parity: true,
    })),
    db_security: { pass: true, source: "management_api_read_only_sql", checks: { rls: true } },
    scenarios: contractInfo.contract.scenarios.map((row, index) => ({
      id: row.id, contract_version: contractInfo.contract.contract_version,
      actual_reply: replyFor(row), response_route: row.expected_route_family[0],
      customer_source_message_id: uuid(index + 1), assistant_message_id: uuid(index + 101),
      memory_revision: index + 1, commerce_revision: index,
      b2: { persistence_result: "success" }, observed_at: "2026-09-16T02:31:00Z",
    })),
    quick_gate: { all_pass: true, long_run_started_only_after_pass: true },
    historical_hkd_8000: { pass: true, source: "runtime_readback" },
    core_checks: coreNames.map((name) => ({ name, pass: true, observation: { source: "runtime_readback", id: uuid(500) } })),
    long_run: {
      fresh: true, transport_successes: 100, unique_customer_source_messages: 100, assistant_persistences: 100,
      semantic_correct: 15, semantic_total: 15, customer_source_message_ids: sourceIds,
      semantic_checks: Array.from({ length: 15 }, (_, index) => ({ name: `long-${index + 1}`, pass: true, source: "actual_assistant_reply" })),
      checkpoints: [20, 50, 105].map((turn, index) => ({
        turn, context_chars: 20000 + index, generation_context_chars: 20000 + index,
        memory_chars: 8000 + index, recent_raw_chars: 6000 + index,
        recent_window_count: 12, recent_window_unit: "messages", measurement_source: "runtime_observation",
        source_message_id: sourceIds[Math.min(turn - 1, 99)], memory_revision: turn, commerce_revision: turn,
      })),
    },
    rebuild_comparison: {
      source: "authoritative_history_and_canonical_state", equal: true,
      fields: Object.fromEntries(["current_facts", "latest_corrections", "entities", "cancellations", "transaction_state", "regions", "open_questions"].map((x) => [x, true])),
    },
    cleanup: {
      completed: true, source: "exact_fixture_manifest", fixture_manifest_sha256: "c".repeat(64),
      readback_source: "management_api_exact_id_transaction_and_post_delete_select",
      fixture_state: "inactive_deleted", exclude_training: true,
      safely_deletable_residue: 0, active_conversations: 0, active_jobs: 0,
      retained_audit_count: 2, training_eligible: 0, learning_candidates: 0,
    },
    created_at: "2026-09-16T03:00:00Z",
  };
}

const options = { expectedHead: head, expectedTree: tree, expectedProject: "nrfxhqabwblzxoushgnm", expectedRunId: runId, expectedAttempt: attempt };
const expectReject = (name, mutate, pattern) => {
  const evidence = structuredClone(validEvidence());
  mutate(evidence);
  assert.throws(() => verifyEvidence(evidence, contractInfo, options), pattern, name);
  console.log(`C3_NONPRODUCTION_CONTROL|name=${name}|result=PASS`);
};

assert.equal(verifyEvidence(validEvidence(), contractInfo, options).pass, true);
console.log("C3_NONPRODUCTION_CONTROL|name=mock_100_turn_complete_evidence|result=PASS");
assert.equal(contractInfo.contract.scenarios.filter((x) => x.origin === "recovered_failure_class").length, 11);
assert.equal(contractInfo.contract.scenarios.filter((x) => x.origin === "new_release_control").length, 4);
console.log("C3_NONPRODUCTION_CONTROL|name=15_row_contract_11_recovered_4_new|result=PASS");

expectReject("missing_row", (e) => e.scenarios.pop(), /15_scenario_rows/);
expectReject("duplicate_row", (e) => { e.scenarios[14] = structuredClone(e.scenarios[0]); }, /duplicate_scenario_row/);
expectReject("wrong_head", (e) => { e.runner.head = "f".repeat(40); }, /head_mismatch/);
expectReject("wrong_tree", (e) => { e.runner.tree = "f".repeat(40); }, /tree_mismatch/);
expectReject("wrong_project", (e) => { e.project = "wrong"; }, /project_mismatch/);
expectReject("wrong_live_source", (e) => { e.live_functions[0].source_parity = false; }, /source_parity_missing/);
expectReject("old_run_replay", (e) => { e.run.id = "1"; }, /run_id_mismatch_or_replay/);
expectReject("hand_filled_flags_without_evidence", (e) => { e.scenarios = []; e.C3_PRODUCT_READY_CORE_SMOKE = "PASS"; }, /15_scenario_rows/);
expectReject("checkpoint_bound_mismatch", (e) => { e.long_run.checkpoints[1].generation_context_chars = 32769; }, /generation_context_bound_exceeded/);
expectReject("rebuild_mismatch", (e) => { e.rebuild_comparison.equal = false; }, /rebuild_comparison_invalid/);
expectReject("cleanup_failure", (e) => { e.cleanup.completed = false; }, /cleanup_evidence_missing/);
expectReject("quick_failure_blocks_long_run", (e) => { e.quick_gate.all_pass = false; }, /quick_first_sequence_invalid/);
expectReject("synthetic_rejected_by_production", (e) => { e.mode = "synthetic_nonproduction"; }, /synthetic_or_nonproduction_evidence_rejected/);

const runner = fs.readFileSync(".github/scripts/c3_validation_only_runner.py", "utf8");
for (const forbidden of ["functions" + " deploy", "db" + " push", "migration" + " up", "apply_" + "migration", "rollback" + " deploy"]) {
  assert.equal(runner.toLowerCase().includes(forbidden), false, `validation runner contains forbidden operation: ${forbidden}`);
}
assert.ok(runner.indexOf("evidence[\"quick_gate\"]") < runner.indexOf("evidence[\"long_run\"] = self.long_run()"));
assert.ok(runner.includes("finally:"));
assert.ok(runner.includes("cleanup_manifest"));
assert.ok(runner.includes("recovered_from\":\"exact_durable_visitor_session_marker"));
assert.ok(runner.includes("visitor_metadata->>c3_validation_marker"));
console.log("C3_NONPRODUCTION_CONTROL|name=runner_quick_first_and_cleanup_finally|result=PASS");
console.log("C3_NONPRODUCTION_CONTROL|name=interrupted_runner_manifest_recovery|result=PASS");
console.log("C3_NONPRODUCTION_CONTROL|name=validation_runner_no_deploy_migration_rollback|result=PASS");

const c3Workflow = fs.readFileSync(".github/workflows/task-ai-abc-c3-final-gate.yml", "utf8");
const validationStart = c3Workflow.indexOf("\n  c3-validation-only:\n") + 1;
const validationEnd = c3Workflow.indexOf("\n  c3-validation-cleanup-only:\n", validationStart);
const validationBlock = c3Workflow.slice(validationStart, validationEnd);
assert.ok(validationStart > 0 && validationEnd > validationStart);
assert.ok(validationBlock.includes("github.event_name == 'workflow_dispatch'"));
assert.ok(validationBlock.includes("inputs.mode == 'validation_only'"));
assert.ok(validationBlock.includes("github.actor == 'ebixsolutions'"));
assert.ok(validationBlock.includes('test "$(git rev-parse HEAD)" = "$C3_EXPECTED_HEAD"'));
assert.ok(validationBlock.includes('test "$(git rev-parse HEAD^{tree})" = "$C3_EXPECTED_TREE"'));
for (const forbidden of ["functions deploy", "db push", "migration up", "rollback deploy", "apply_migration"]) {
  assert.equal(validationBlock.toLowerCase().includes(forbidden), false);
}
console.log("C3_NONPRODUCTION_CONTROL|name=ordinary_events_cannot_trigger_validation_only|result=PASS");
console.log("C3_NONPRODUCTION_CONTROL|name=unauthorized_actor_or_wrong_identity_blocked|result=PASS");

const push = { ref: "refs/heads/main", before: "1".repeat(40), after: "2".repeat(40) };
const c3Pull = [{ number: 12, merged_at: "2026-09-16T03:00:00Z", base: { ref: "main" }, head: { ref: "director/ai-abc-c3-long-memory-final-cutover", sha: head } }];
assert.equal(classifyMergeEvent(push, c3Pull).mode, "c3_no_redeploy_candidate");
assert.equal(classifyMergeEvent(push, [{ number: 99, merged_at: "x", base: { ref: "main" }, head: { ref: "feature", sha: head } }]).mode, "normal_deploy");
assert.equal(classifyMergeEvent({ ...push, ref: "refs/heads/dev" }, c3Pull).mode, "normal_deploy");
assert.equal(classifyMergeEvent({ ref: "refs/heads/main" }, c3Pull).mode, "normal_deploy");
console.log("C3_NONPRODUCTION_CONTROL|name=c3_merge_guard_and_non_c3_behavior|result=PASS");

const task42 = fs.readFileSync(".github/workflows/task4-2-deploy-live-console-edge.yml", "utf8");
assert.ok(task42.includes("C3_VALIDATED_LIVE_RUNTIME_ALREADY_PRESENT"));
assert.ok((task42.match(/if: steps\.c3_guard\.outputs\.mode != 'c3_no_redeploy_candidate'/g) ?? []).length >= 3);
const workflows = fs.readdirSync(".github/workflows").filter((name) => name.endsWith(".yml"));
const derivedDeploy = workflows.filter((name) => {
  const source = fs.readFileSync(`.github/workflows/${name}`, "utf8").toLowerCase();
  return source.includes("workflow_run:") && source.includes("functions deploy");
});
assert.deepEqual(derivedDeploy, [], `derived workflow_run deployment chain exists: ${derivedDeploy}`);
const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const affectedAutoDeploy = workflows.filter((name) => {
  const source = fs.readFileSync(`.github/workflows/${name}`, "utf8");
  if (!source.includes("branches: [main]") || !source.includes("functions deploy")) return false;
  const lines = source.split("\n");
  const pathIndex = lines.findIndex((line) => /^\s{4}paths:\s*$/.test(line));
  if (pathIndex < 0) return false;
  const patterns = [];
  for (let i = pathIndex + 1; i < lines.length && /^\s{6}-\s+/.test(lines[i]); i++) {
    patterns.push(lines[i].replace(/^\s{6}-\s+['\"]?/, "").replace(/['\"]?\s*$/, ""));
  }
  return changed.some((file) => patterns.some((pattern) => pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -3)) : file === pattern));
});
assert.deepEqual(affectedAutoDeploy, ["task4-2-deploy-live-console-edge.yml"]);
console.log("C3_NONPRODUCTION_CONTROL|name=c3_merge_direct_and_derived_deploy_chain_guarded|result=PASS");
console.log("C3_NONPRODUCTION_VALIDATION_CONTROL_SUITE=PASS");
