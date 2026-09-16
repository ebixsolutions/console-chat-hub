#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readContract, verifyEvidence, EVIDENCE_SCHEMA_VERSION, VALIDATED_FUNCTIONS } from "./c3_validation_evidence.mjs";
import { classifyMergeEvent } from "./c3_merge_no_redeploy_guard.mjs";

const contractPath = ".github/scripts/c3_validation_scenarios.json";
const contractInfo = readContract(contractPath);
execFileSync("python", [
  ".github/scripts/c3_validation_only_runner.py", "db-contract-test",
  "--out", "/tmp/c3-db-readback-contract-test",
  "--contract", contractPath,
], { stdio: "inherit" });
execFileSync("python", [
  ".github/scripts/c3_validation_only_runner.py", "runtime-contract-test",
  "--out", "/tmp/c3-runtime-wait-contract-test",
  "--contract", contractPath,
], { stdio: "inherit" });
const head = "1".repeat(40);
const tree = "2".repeat(40);
const runId = "35045000000";
const attempt = "1";
const deploymentRunId = "35070000000";
const releaseId = "3".repeat(64);
const releaseDigest = "sha256:" + "4".repeat(64);
const releaseFunctions = Object.freeze({
  "generate-reply": { version: 109, status: "ACTIVE", bundle: "5".repeat(64), verify_jwt: true, import_map: false, manifest_sha256: "6".repeat(64) },
  "agent-assist": { version: 44, status: "ACTIVE", bundle: "7".repeat(64), verify_jwt: true, import_map: false, manifest_sha256: "8".repeat(64) },
});
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

function validRuntimeQuality() {
  const dimensions = ["factual_grounding_and_commitment_truth", "resolution_and_progress", "context_correction_and_entity", "targeted_clarification_and_kb_use", "natural_language_and_concision", "handoff_next_step_and_customer_effort"];
  const rows = Array.from({ length: 100 }, (_, index) => {
    const response = `Observed governed response ${index + 1}`;
    const assertions = Object.fromEntries(dimensions.map((dimension) => [dimension, [{ name: `${dimension}_runtime_observation`, pass: true }]]));
    return {
      id: `runtime-${index + 1}`, family: "control_fixture", response,
      response_sha256: crypto.createHash("sha256").update(response).digest("hex"),
      customer_source_message_id: uuid(index + 2000), assistant_message_id: uuid(index + 3000),
      measurement_source: "runtime_readback", assertions,
      scores: Object.fromEntries(dimensions.map((dimension) => [dimension, 10])),
    };
  });
  return {
    schema_version: "c3-service-quality-evidence-1.0.0", mode: "live_production_runtime",
    sample_count: 100, deterministic_regression_count: 112, deterministic_samples_included: false,
    scoring: { formula: "derived executable assertions only; no rounding" },
    dimension_averages: Object.fromEntries(dimensions.map((dimension) => [dimension, 10])),
    weighted_score: 100, critical_p0: 0, rows,
  };
}

function validEvidence() {
  const sourceIds = Array.from({ length: 100 }, (_, index) => uuid(index + 1000));
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    mode: "live_production",
    repository: "ebixsolutions/console-chat-hub",
    project: "nrfxhqabwblzxoushgnm",
    run: { id: runId, attempt, started_at: "2026-09-16T02:30:00Z" },
    runner: { head, tree },
    release_identity: {
      release_id: releaseId, release_digest: releaseDigest, deployment_run_id: deploymentRunId,
      deployment_attempt: "1", target_head: head, target_tree: tree, functions: structuredClone(releaseFunctions),
    },
    scenario_contract: { version: contractInfo.contract.contract_version, sha256: contractInfo.sha256 },
    artifact: { id: 10427225513, digest: "sha256:" + "a".repeat(64) },
    live_functions: VALIDATED_FUNCTIONS.map((name) => {
      const row = releaseFunctions[name];
      return {
        function: name, version: row.version, status: "ACTIVE", verify_jwt: row.verify_jwt,
        import_map: row.import_map, bundle: row.bundle,
        source_manifest_sha256: row.manifest_sha256, source_parity: true,
      };
    }),
    db_security: { pass: true, source: "management_api_read_only_sql", checks: { rls: true } },
    service_quality: validRuntimeQuality(),
    scenarios: contractInfo.contract.scenarios.map((row, index) => ({
      id: row.id, contract_version: contractInfo.contract.contract_version,
      actual_reply: replyFor(row), response_route: row.id === "C3-CONTROL-13" ? "canonical_memory_clarification" : row.id === "T98" ? "canonical_memory_recall" : row.expected_route_family[0],
      recall_authority: row.id === "C3-CONTROL-13" || row.id === "C3-CONTROL-15" ? null : "CURRENT_CUSTOMER_MEMORY",
      recall_fact_type: row.id === "T98" ? "quotation_status+order_status" : row.id === "C3-CONTROL-13" || row.id === "C3-CONTROL-15" ? null : "summary",
      recall_reason: row.id === "C3-CONTROL-13" ? "ENTITY_REFERENCE_AMBIGUOUS" : null,
      recall_provenance: row.id === "C3-CONTROL-13" || row.id === "C3-CONTROL-15" ? [] : [{ fact_type: row.id === "T98" ? "order_status" : "summary", authority: "CURRENT_CUSTOMER_MEMORY", source_message_id: uuid(index + 1) }],
      customer_source_message_id: uuid(index + 1), assistant_message_id: uuid(index + 101),
      memory_revision: index + 1, commerce_revision: index,
      source_binding: { assistant_source_message_id: uuid(index + 1), memory_source_message_id: uuid(index + 1), commerce_source_message_id: uuid(index + 1), exact_customer_source_match: true },
      b2: {
        persistence_result: "success", evidence: "server_persisted_b2_gate_and_commit_source",
        gate_contract: "executeB2PersistenceGate:allow_after_revalidation", commit_source: "commit_ai_reply_tx",
        source_message_id: uuid(index + 1), persisted_message_id: uuid(index + 101),
      }, observed_at: "2026-09-16T02:31:00Z",
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

const options = {
  expectedHead: head, expectedTree: tree, expectedProject: "nrfxhqabwblzxoushgnm",
  expectedRunId: runId, expectedAttempt: attempt, expectedReleaseId: releaseId,
  expectedReleaseDigest: releaseDigest, expectedDeploymentRunId: deploymentRunId,
};
const expectReject = (name, mutate, pattern) => {
  const evidence = structuredClone(validEvidence());
  mutate(evidence);
  assert.throws(() => verifyEvidence(evidence, contractInfo, options), pattern, name);
  console.log(`C3_NONPRODUCTION_CONTROL|name=${name}|result=PASS`);
};

assert.equal(verifyEvidence(validEvidence(), contractInfo, options).pass, true);
console.log("C3_NONPRODUCTION_CONTROL|name=mock_100_turn_complete_evidence|result=PASS");
{
  const workflow = fs.readFileSync(".github/workflows/task-ai-abc-c3-final-gate.yml", "utf8");
  const gate = fs.readFileSync(".github/scripts/task_ai_abc_c3_final_gate.mjs", "utf8");
  assert.match(workflow, /C3_CURRENT_LIVE_SOURCE_PARITY: NOT_APPLICABLE/);
  assert.match(workflow, /C3_SOURCE_DEPLOYMENT_BOUNDARY: PASS/);
  assert.match(workflow, /conversation-service-planner\.ts/);
  assert.match(workflow, /C3-release-identity-/);
  assert.match(workflow, /authorize-validation/);
  assert.match(workflow, /C3_DEPLOYMENT_ALLOWLIST=generate-reply,agent-assist/);
  assert.match(gate, /liveSourceParity \|\| sourceDeploymentBoundary/);
  console.log("C3_NONPRODUCTION_CONTROL|name=source_vs_deployment_identity_boundary|result=PASS");
}
{
  const equivalent = validEvidence();
  equivalent.scenarios.find((row) => row.id === "T98").actual_reply = "報價階段: 草擬中\n訂單階段: 未建立\n尚未形成正式訂單。";
  equivalent.scenarios.find((row) => row.id === "C3-CONTROL-13").actual_reply = "請指明要核對的項目或時間點；我不會把舊記錄或推測當作答案。";
  assert.equal(verifyEvidence(equivalent, contractInfo, options).pass, true);
  console.log("C3_NONPRODUCTION_CONTROL|name=bounded_semantic_equivalence_t98_c13|result=PASS");
}
assert.equal(contractInfo.contract.scenarios.filter((x) => x.origin === "recovered_failure_class").length, 11);
assert.equal(contractInfo.contract.scenarios.filter((x) => x.origin === "new_release_control").length, 4);
console.log("C3_NONPRODUCTION_CONTROL|name=15_row_contract_11_recovered_4_new|result=PASS");

{
  const suppressed = validEvidence();
  const row = suppressed.scenarios.find((item) => item.id === "C3-CONTROL-15");
  row.actual_reply = "";
  row.response_route = "human_control";
  row.assistant_message_id = null;
  row.response_suppressed = true;
  row.b2.persistence_result = "suppressed_human_control";
  row.suppression_evidence = {
    reason: "existing_explicit_R1_handoff", handoff_event_id: uuid(800),
    handoff_source_message_id: uuid(801), handoff_safe_reply: "真人客服已轉交接手",
    receive_control_state: "human_control", receive_ai_reply_pending: false,
    conversation_status: "pending", resolved_at: null, assistant_after_source: false,
  };
  assert.equal(verifyEvidence(suppressed, contractInfo, options).pass, true);
  console.log("C3_NONPRODUCTION_CONTROL|name=expected_human_control_suppression_evidence|result=PASS");
}

expectReject("missing_row", (e) => e.scenarios.pop(), /15_scenario_rows/);
expectReject("duplicate_row", (e) => { e.scenarios[14] = structuredClone(e.scenarios[0]); }, /duplicate_scenario_row/);
expectReject("wrong_head", (e) => { e.runner.head = "f".repeat(40); }, /head_mismatch/);
expectReject("wrong_tree", (e) => { e.runner.tree = "f".repeat(40); }, /tree_mismatch/);
expectReject("wrong_project", (e) => { e.project = "wrong"; }, /project_mismatch/);
expectReject("wrong_live_source", (e) => { e.live_functions[0].source_parity = false; }, /source_parity_missing/);
expectReject("baseline_target_mixup", (e) => { e.live_functions[0].source_manifest_sha256 = "9".repeat(64); }, /source_parity_missing/);
expectReject("wrong_release_parent", (e) => { e.release_identity.deployment_run_id = "1"; }, /release_deployment_run_mismatch/);
expectReject("release_replay", (e) => { e.release_identity.release_digest = "sha256:" + "a".repeat(64); }, /release_digest_mismatch/);
expectReject("old_run_replay", (e) => { e.run.id = "1"; }, /run_id_mismatch_or_replay/);
expectReject("source_binding_mismatch", (e) => { e.scenarios[0].source_binding.memory_source_message_id = uuid(999); }, /source_binding_invalid/);
expectReject("b2_status_without_source_proof", (e) => { e.scenarios[0].b2.evidence = "unobserved"; }, /b2_persistence_missing/);
expectReject("quality_nonempty_reply_is_not_resolution_proof", (e) => {
  e.service_quality.rows[0].assertions.resolution_and_progress[0].pass = false;
}, /quality_(?:score_not_derived|average_not_derived|dimension_below_threshold)/);
expectReject("quality_length_is_not_naturalness_proof", (e) => {
  e.service_quality.rows[0].assertions.natural_language_and_concision = [];
}, /quality_assertions_invalid/);
expectReject("quality_fixed_score_rejected", (e) => {
  e.service_quality.rows[0].scores.factual_grounding_and_commitment_truth = 10;
  e.service_quality.rows[0].assertions.factual_grounding_and_commitment_truth[0].pass = false;
}, /quality_score_not_derived/);
expectReject("quality_deterministic_reuse_rejected", (e) => { e.service_quality.deterministic_samples_included = true; }, /deterministic_cases_must_not_be_held_out/);
expectReject("known_single_fact_replaced_by_clarification", (e) => {
  const row = e.scenarios.find((item) => item.id === "T06");
  row.actual_reply = "請指明要核對的項目。"; row.response_route = "canonical_memory_clarification";
}, /scenario_(?:route_family_mismatch|text_assertion_failed):T06/);
expectReject("ambiguous_referent_arbitrarily_selected", (e) => {
  const row = e.scenarios.find((item) => item.id === "C3-CONTROL-13");
  row.actual_reply = "ALPHA 是 1.5匹。";
}, /scenario_text_assertion_failed:C3-CONTROL-13:ambiguous_referent_has_no_selected_value/);
expectReject("contradictory_unbuilt_and_confirmed_order", (e) => {
  const row = e.scenarios.find((item) => item.id === "T98");
  row.actual_reply = "報價階段；尚未形成正式訂單，但已確認訂單。";
}, /scenario_text_assertion_failed:T98:no_contradictory_confirmed_order/);
expectReject("hand_filled_flags_without_evidence", (e) => { e.scenarios = []; e.C3_PRODUCT_READY_CORE_SMOKE = "PASS"; }, /15_scenario_rows/);
expectReject("checkpoint_bound_mismatch", (e) => { e.long_run.checkpoints[1].generation_context_chars = 32769; }, /generation_context_bound_exceeded/);
expectReject("rebuild_mismatch", (e) => { e.rebuild_comparison.equal = false; }, /rebuild_comparison_invalid/);
expectReject("cleanup_failure", (e) => { e.cleanup.completed = false; }, /cleanup_evidence_missing/);
expectReject("quick_failure_blocks_long_run", (e) => { e.quick_gate.all_pass = false; }, /quick_first_sequence_invalid/);
expectReject("synthetic_rejected_by_production", (e) => { e.mode = "synthetic_nonproduction"; }, /synthetic_or_nonproduction_evidence_rejected/);
expectReject("suppression_without_persisted_handoff", (e) => {
  const row = e.scenarios.find((item) => item.id === "C3-CONTROL-15");
  row.response_suppressed = true;
  row.assistant_message_id = null;
  row.b2.persistence_result = "suppressed_human_control";
  row.suppression_evidence = { reason: "existing_explicit_R1_handoff" };
}, /suppression_evidence_invalid/);

const runner = fs.readFileSync(".github/scripts/c3_validation_only_runner.py", "utf8");
for (const forbidden of ["functions" + " deploy", "db" + " push", "migration" + " up", "apply_" + "migration", "rollback" + " deploy"]) {
  assert.equal(runner.toLowerCase().includes(forbidden), false, `validation runner contains forbidden operation: ${forbidden}`);
}
assert.ok(runner.indexOf("evidence[\"quick_gate\"]") < runner.indexOf("evidence[\"long_run\"] = self.long_run()"));
assert.ok(runner.includes("finally:"));
assert.ok(runner.includes("cleanup_manifest"));
assert.ok(runner.includes("recovered_from\":\"exact_durable_visitor_session_marker"));
assert.ok(runner.includes("visitor_metadata->>c3_validation_marker"));
assert.ok(runner.includes("fixture[\"customer_source_message_ids\"].append(customer[\"id\"])"));
assert.ok(runner.includes("C3_RUNTIME_WAIT|"));
assert.ok(runner.includes("C3_RUNTIME_TIMEOUT|"));
assert.ok(runner.includes("deadline = wait_started + timeout_seconds"));
for (const field of ["assistant_count=", "ai_generating=", "conversation_status=", "last_messages=", "expected_deadline_ms="]) {
  assert.ok(runner.includes(field), `runtime wait telemetry missing ${field}`);
}
assert.ok(runner.includes("a.resource_id=t.id) as retained_audit_count"));
assert.equal(runner.includes("a.resource_id=t.id::text"), false);
console.log("C3_NONPRODUCTION_CONTROL|name=runner_quick_first_and_cleanup_finally|result=PASS");
console.log("C3_NONPRODUCTION_CONTROL|name=interrupted_runner_manifest_recovery|result=PASS");
console.log("C3_NONPRODUCTION_CONTROL|name=validation_runner_no_deploy_migration_rollback|result=PASS");
execFileSync("node", [".github/scripts/c3_release_identity.test.mjs"], { stdio: "inherit" });

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
