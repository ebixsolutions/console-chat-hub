#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { readContract, verifyEvidence, EVIDENCE_SCHEMA_VERSION, VALIDATED_FUNCTIONS } from "./c3_validation_evidence.mjs";
import { DIMENSIONS, verifyHumanCalibration } from "./c3_service_quality_evidence.mjs";
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
const rubric = JSON.parse(fs.readFileSync(".github/scripts/c3_service_quality_rubric.json", "utf8"));
const rubricSha256 = crypto.createHash("sha256").update(fs.readFileSync(".github/scripts/c3_service_quality_rubric.json")).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const hash = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
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

function validMachineQuality(evidence) {
  const knownAnswerTurns = new Set([6, 17, 40, 50, 55, 57, 58, 59, 68, 69, 71, 73, 90, 96, 98]);
  const rows = evidence.long_run.observations.map((observed, index) => {
    const response = observed.assistant.content;
    const metadata = observed.assistant.metadata;
    const deadEnd = /^(?:sorry[, .]*|抱歉[，,。 ]*)?(?:i (?:cannot|can't) help|我(?:不能|無法|无法)協助|請稍後再試)[。.!]?$/i.test(response.trim());
    const reask = knownAnswerTurns.has(index + 1) && /(?:請|请).{0,10}(?:再|重新).{0,10}(?:提供|確認|确认|說明|说明)|could you (?:re)?provide/i.test(response);
    return {
      id: `long-${String(index + 1).padStart(3, "0")}`,
      customer_source_message_id: observed.customer.id, assistant_message_id: observed.assistant.id,
      response_sha256: hash(response), response_route: metadata.response_route, source_bound: metadata.source_message_id === observed.customer.id,
      b2: { gate_contract: metadata.b2_gate_contract, commit_source: metadata.b2_commit_source, source_message_id: metadata.b2_source_message_id },
      assertions: { known_answer_dead_end: deadEnd, unnecessary_reask: reask, general_support_fallback: /fallback/i.test(metadata.response_route) || deadEnd },
    };
  });
  const deadEnds = rows.filter((row) => row.assertions.known_answer_dead_end).length;
  const reasks = rows.filter((row) => row.assertions.unnecessary_reask).length;
  const fallbacks = rows.filter((row) => row.assertions.general_support_fallback).length;
  const humanSamples = evidence.long_run.observations.flatMap((observed, index) => (index + 1) % 5 ? [] : [{
    id: `human-turn-${String(index + 1).padStart(3, "0")}`,
    runtime_observation_id: `long-${String(index + 1).padStart(3, "0")}`,
    customer_source_message_id: observed.customer.id, assistant_message_id: observed.assistant.id,
    context_sha256: hash({ customer_turn: observed.customer.content }), response_sha256: hash(observed.assistant.content),
  }]);
  return {
    schema_version: "c3-deterministic-machine-quality-1.0.0", mode: "live_production_deterministic", status: "PASS",
    subjective_quality_status: "AWAITING_INDEPENDENT_HUMAN_REVIEW",
    binding: {
      head, tree, release_id: releaseId, run_id: runId, attempt,
      scenario_contract_sha256: contractInfo.sha256, rubric_sha256: rubricSha256,
      closure_manifests: Object.fromEntries(Object.entries(releaseFunctions).map(([name, row]) => [name, row.manifest_sha256])),
    },
    dataset_sha256: hash(rows.map(({ id, customer_source_message_id, assistant_message_id, response_sha256 }) => ({ id, customer_source_message_id, assistant_message_id, response_sha256 }))),
    sample_count: rows.length, rows,
    human_review_preparation: { status: "AWAITING_INDEPENDENT_HUMAN_REVIEW", sample_count: 20, minimum_independent_reviewers: 2, rubric_sha256: rubricSha256, samples: humanSamples },
    metrics: { p0_count: deadEnds + reasks, known_answer_dead_end: deadEnds, unnecessary_reask: reasks, fallback_count: fallbacks, fallback_denominator: rows.length, fallback_rate: fallbacks / rows.length },
  };
}

function validEvidence() {
  const sourceIds = Array.from({ length: 100 }, (_, index) => uuid(index + 1000));
  const evidence = {
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
      observations: sourceIds.map((sourceId, index) => ({
        customer: { id: sourceId, content: `Business-purpose customer turn ${index + 1}` },
        assistant: { id: uuid(index + 4000), content: `Observed governed response ${index + 1}`, metadata: {
          response_route: "normal", source_message_id: sourceId,
          b2_gate_contract: "executeB2PersistenceGate:allow_after_revalidation",
          b2_commit_source: "commit_ai_reply_tx", b2_source_message_id: sourceId,
        } },
      })),
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
  evidence.machine_quality = validMachineQuality(evidence);
  return evidence;
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

function validHumanReviewArtifact() {
  const samples = Array.from({ length: 20 }, (_, index) => {
    const customer_context = `Full governed context ${index + 1}`;
    const customer_turn = `Customer request ${index + 1}`;
    const actual_response_or_action = `Actual candidate response ${index + 1}`;
    return {
      id: `human-${index + 1}`, family: `human-family-${index + 1}`,
      customer_context, customer_turn, actual_response_or_action,
      context_sha256: hash({ customer_context, customer_turn }), response_sha256: hash(actual_response_or_action),
      source_binding: { head, tree, release_id: releaseId, runtime_observation_id: `runtime-${index + 1}` },
      facets: index === 0
        ? { emotion: true, entitlement: "verified", handoff: true }
        : index === 1
        ? { emotion: true, entitlement: "self_claimed", handoff: false }
        : index === 2
        ? { emotion: false, entitlement: "unknown", handoff: true }
        : { emotion: index % 2 === 0, entitlement: "unknown", handoff: false },
    };
  });
  const sampleManifestSha256 = hash(samples.map((row) => ({ id: row.id, context_sha256: row.context_sha256, response_sha256: row.response_sha256 })));
  return {
    packet: {
      schema_version: "c3-human-calibration-packet-1.0.0",
      binding: { head, tree, release_id: releaseId, sample_manifest_sha256: sampleManifestSha256, rubric_sha256: rubricSha256 },
      samples,
    },
    collection: {
      status: "COLLECTION_COMPLETED", major_disagreement_count: 0, disagreement_resolution_status: "RESOLVED_OR_NONE",
      reviews: samples.map((sample, index) => ({
        sample_id: sample.id, blinded: true, reviewed_at: `2026-09-16T${String(index).padStart(2, "0")}:00:00Z`,
        context_sha256: sample.context_sha256, response_sha256: sample.response_sha256,
        reviewer: { source: "external_human_qa", reviewer_id: `reviewer-${index % 2 + 1}`, provenance: "independent QA roster record" },
        dimensions: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { score: 10, reason: `Observed evidence for ${dimension}` }])),
      })),
    },
  };
}

const calibrationManifest = JSON.parse(fs.readFileSync(".github/scripts/c3_service_quality_human_calibration.json", "utf8"));
const humanOptions = (artifact) => ({
  requireCompleted: true, reviewArtifact: artifact, rubric,
  expectedBinding: {
    head, tree, release_id: releaseId,
    sampleManifestSha256: artifact.packet.binding.sample_manifest_sha256,
    rubricSha256,
  },
});
assert.equal(verifyHumanCalibration(calibrationManifest, humanOptions(validHumanReviewArtifact())).status, "PASS");
console.log("C3_NONPRODUCTION_CONTROL|name=valid_external_human_calibration_artifact|result=PASS");
for (const [name, mutate, pattern] of [
  ["human_nonexistent_sample_rejected", (a) => { a.collection.reviews[0].sample_id = "missing"; }, /human_review_sample_missing/],
  ["human_duplicate_sample_rejected", (a) => { a.collection.reviews[1].sample_id = a.collection.reviews[0].sample_id; }, /human_duplicate_sample_review/],
  ["human_reviewer_provenance_rejected", (a) => { a.collection.reviews[0].reviewer.provenance = ""; }, /human_reviewer/],
  ["implementation_agent_human_self_certification_rejected", (a) => { a.collection.reviews[0].reviewer.source = "implementation_agent"; }, /human_reviewer/],
  ["human_missing_time_rejected", (a) => { a.collection.reviews[0].reviewed_at = ""; }, /human_blinding_or_time_invalid/],
  ["human_missing_reason_rejected", (a) => { a.collection.reviews[0].dimensions[DIMENSIONS[0]].reason = ""; }, /human_review_reason/],
  ["human_null_score_rejected", (a) => { a.collection.reviews[0].dimensions[DIMENSIONS[0]].score = null; }, /human_review_score_invalid/],
  ["human_low_quality_rejected", (a) => { for (const review of a.collection.reviews) for (const dimension of DIMENSIONS) review.dimensions[dimension].score = 0; }, /human_quality_dimension_below_threshold/],
  ["human_unresolved_disagreement_rejected", (a) => { a.collection.major_disagreement_count = 1; a.collection.disagreement_resolution_status = "OPEN"; }, /human_calibration_disagreement_unresolved/],
  ["human_old_candidate_rejected", (a) => { a.packet.binding.head = "f".repeat(40); }, /human_head_binding_mismatch/],
]) {
  const artifact = validHumanReviewArtifact(); mutate(artifact);
  assert.throws(() => verifyHumanCalibration(calibrationManifest, humanOptions(artifact)), pattern, name);
  console.log(`C3_NONPRODUCTION_CONTROL|name=${name}|result=PASS`);
}

assert.equal(verifyEvidence(validEvidence(), contractInfo, options).pass, true);
console.log("C3_NONPRODUCTION_CONTROL|name=synthetic_verifier_positive_control_not_release_evidence|result=PASS");
assert.equal(rubric.target.weighted_score_min, 95);
assert.equal(rubric.target.critical_p0_allowed, 0);
assert.deepEqual(Object.values(rubric.target.dimension_average_min), [9.5, 9.5, 9, 9, 9.5, 9]);
console.log("C3_NONPRODUCTION_CONTROL|name=frozen_95_and_dimension_thresholds_preserved|result=PASS");
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
expectReject("machine_arbitrary_true_assertions_and_fake_ids_rejected", (e) => { e.machine_quality.rows[0].customer_source_message_id = uuid(999999); }, /machine_quality_runtime_observation_mismatch/);
expectReject("machine_wrong_candidate_binding_rejected", (e) => { e.machine_quality.binding.head = "f".repeat(40); }, /machine_quality_head_binding_mismatch/);
expectReject("machine_wrong_release_binding_rejected", (e) => { e.machine_quality.binding.release_id = "e".repeat(64); }, /machine_quality_release_id_binding_mismatch/);
expectReject("machine_wrong_run_attempt_rejected", (e) => { e.machine_quality.binding.attempt = "2"; }, /machine_quality_attempt_binding_mismatch/);
expectReject("machine_cross_release_closure_rejected", (e) => { e.machine_quality.binding.closure_manifests["generate-reply"] = "e".repeat(64); }, /machine_quality_closure_binding_mismatch/);
expectReject("machine_response_substitution_rejected", (e) => { e.long_run.observations[0].assistant.content = "Replacement answer"; }, /machine_quality_runtime_observation_mismatch/);
expectReject("machine_dataset_rehash_without_binding_rejected", (e) => { e.machine_quality.dataset_sha256 = "f".repeat(64); }, /machine_quality_dataset_hash_mismatch/);
expectReject("implementation_agent_subjective_self_certification_rejected", (e) => { e.machine_quality.weighted_score = 100; }, /machine_quality_subjective_self_certification_forbidden/);
expectReject("human_review_response_substitution_rejected", (e) => { e.machine_quality.human_review_preparation.samples[0].response_sha256 = "f".repeat(64); }, /human_review_preparation_invalid/);
expectReject("machine_generic_dead_end_fails_closed", (e) => {
  e.long_run.observations[0].assistant.content = "我無法協助。";
  const rebuilt = validMachineQuality(e); e.machine_quality = rebuilt;
}, /machine_quality_threshold_failed/);
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
assert.ok(c3Workflow.includes("inputs.mode == 'evidence_finalize'"));
assert.equal(c3Workflow.includes("C3_QUALITY_ARTIFACT_DIGEST"), false);
assert.equal(c3Workflow.includes("quality_artifact_identity"), false);
assert.equal(validationBlock.includes("external_quality_grader"), false);
assert.equal(validationBlock.includes("C3_EXTERNAL_QUALITY_ASSESSMENT_PATH"), false);
assert.ok(c3Workflow.includes("C3_HUMAN_REVIEW_ARTIFACT_PATH"));
assert.ok(c3Workflow.includes("production_independent_quality_and_human_authorization_required") || fs.readFileSync(".github/scripts/task_ai_abc_c3_final_gate.mjs", "utf8").includes("production_independent_quality_and_human_authorization_required"));
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
