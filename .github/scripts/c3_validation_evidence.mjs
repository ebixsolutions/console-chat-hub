#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVIDENCE_SCHEMA_VERSION = "ai-abc-c3-validation-evidence-1.0.0";
export const PROJECT_REF = "nrfxhqabwblzxoushgnm";
export const LIVE_EXPECTED = Object.freeze({
  "generate-reply": {
    version: 108,
    bundle: "f5c85c002c99ca7f094d1e1c9b1cb7349e44e73a159a8970b78a6b2a2bf7e397",
    verify_jwt: true,
    import_map: false,
  },
  "agent-assist": {
    version: 43,
    bundle: "eeadc5c9dfb35c51e8778756fcae96ff0c0fc68fc68599ade565ef7479e4e4cb",
    verify_jwt: true,
    import_map: false,
  },
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => {
  throw new Error(message);
};
const requiredString = (value, name) => {
  if (typeof value !== "string" || value.trim() === "") fail(`missing:${name}`);
  return value;
};
const normalized = (value) => String(value ?? "").normalize("NFKC").toLowerCase();
const contains = (text, value) => normalized(text).includes(normalized(value));
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ""));

export function readContract(contractPath) {
  const raw = fs.readFileSync(contractPath);
  const contract = JSON.parse(raw);
  if (contract.contract_version !== "ai-abc-c3-release-acceptance-2026-09-16.1") {
    fail("scenario_contract_version_invalid");
  }
  if (!Array.isArray(contract.scenarios) || contract.scenarios.length !== 15) {
    fail("scenario_contract_must_have_15_rows");
  }
  const ids = contract.scenarios.map((row) => requiredString(row.id, "contract.row.id"));
  if (new Set(ids).size !== 15) fail("scenario_contract_duplicate_id");
  const required = ["T06", "T17", "T40", "T50", "T57", "T58", "T68", "T69", "T71", "T96", "T98", "C3-CONTROL-12", "C3-CONTROL-13", "C3-CONTROL-14", "C3-CONTROL-15"];
  if (required.some((id) => !ids.includes(id))) fail("scenario_contract_required_row_missing");
  return { contract, raw, sha256: sha256(raw) };
}

function evaluateText(row, actualReply) {
  const expected = row.expected ?? {};
  const checks = [];
  if (Array.isArray(expected.include_all)) {
    checks.push({ name: "include_all", pass: expected.include_all.every((v) => contains(actualReply, v)) });
  }
  if (Array.isArray(expected.include_any)) {
    const semanticEquivalent = row.id === "C3-CONTROL-13" &&
      ["請指明要核對的項目", "请指明要核对的项目", "specify the item"].some((v) => contains(actualReply, v));
    checks.push({ name: "include_any", pass: semanticEquivalent || expected.include_any.some((v) => contains(actualReply, v)) });
  }
  if (Array.isArray(expected.include_any_secondary)) {
    const semanticEquivalent = row.id === "T98" &&
      ["尚未形成正式訂單", "尚未形成正式订单", "not a confirmed purchase order"].some((v) => contains(actualReply, v));
    checks.push({ name: "include_any_secondary", pass: semanticEquivalent || expected.include_any_secondary.some((v) => contains(actualReply, v)) });
  }
  if (Array.isArray(expected.exclude_any)) {
    checks.push({ name: "exclude_any", pass: expected.exclude_any.every((v) => !contains(actualReply, v)) });
  }
  return checks;
}

function verifyScenario(contractRow, evidenceRow, { requireLiveProduction }) {
  if (evidenceRow.id !== contractRow.id) fail(`scenario_id_mismatch:${contractRow.id}`);
  if (evidenceRow.contract_version !== "ai-abc-c3-release-acceptance-2026-09-16.1") fail(`scenario_contract_version_mismatch:${contractRow.id}`);
  const expectedSuppression = contractRow.id === "C3-CONTROL-15" && evidenceRow.response_suppressed === true;
  const suppression = evidenceRow.suppression_evidence;
  if (expectedSuppression) {
    if (!suppression || suppression.reason !== "existing_explicit_R1_handoff"
        || !isUuid(suppression.handoff_event_id) || !isUuid(suppression.handoff_source_message_id)
        || suppression.receive_control_state !== "human_control" || suppression.receive_ai_reply_pending !== false
        || suppression.conversation_status !== "pending" || suppression.resolved_at !== null
        || suppression.assistant_after_source !== false) fail(`scenario_suppression_evidence_invalid:${contractRow.id}`);
  } else if (evidenceRow.response_suppressed === true) {
    fail(`scenario_unexpected_suppression:${contractRow.id}`);
  }
  const reply = expectedSuppression
    ? requiredString(suppression.handoff_safe_reply, `${contractRow.id}.suppression_evidence.handoff_safe_reply`)
    : requiredString(evidenceRow.actual_reply, `${contractRow.id}.actual_reply`);
  const route = requiredString(evidenceRow.response_route, `${contractRow.id}.response_route`);
  const routeAllowed = contractRow.expected_route_family.some((family) => normalized(route).includes(normalized(family)));
  if (!routeAllowed) fail(`scenario_route_family_mismatch:${contractRow.id}:${route}`);
  const textChecks = evaluateText(contractRow, reply);
  for (const check of textChecks) if (!check.pass) fail(`scenario_text_assertion_failed:${contractRow.id}:${check.name}`);
  if (requireLiveProduction) {
    if (!isUuid(evidenceRow.customer_source_message_id)) fail(`scenario_source_message_invalid:${contractRow.id}`);
    if (expectedSuppression) {
      if (evidenceRow.assistant_message_id !== null) fail(`scenario_suppressed_assistant_must_be_null:${contractRow.id}`);
    } else if (!isUuid(evidenceRow.assistant_message_id)) fail(`scenario_assistant_message_invalid:${contractRow.id}`);
    if (!Number.isInteger(evidenceRow.memory_revision) || evidenceRow.memory_revision < 1) fail(`scenario_memory_revision_invalid:${contractRow.id}`);
    if (!(evidenceRow.commerce_revision === null || (Number.isInteger(evidenceRow.commerce_revision) && evidenceRow.commerce_revision >= 0))) fail(`scenario_commerce_revision_invalid:${contractRow.id}`);
    const binding = evidenceRow.source_binding;
    if (!binding || binding.exact_customer_source_match !== true ||
        binding.memory_source_message_id !== evidenceRow.customer_source_message_id ||
        (!expectedSuppression && binding.assistant_source_message_id !== evidenceRow.customer_source_message_id)) {
      fail(`scenario_source_binding_invalid:${contractRow.id}`);
    }
    if (normalized(route).includes("canonical_memory_recall")) {
      requiredString(evidenceRow.recall_authority, `${contractRow.id}.recall_authority`);
      requiredString(evidenceRow.recall_fact_type, `${contractRow.id}.recall_fact_type`);
      if (!Array.isArray(evidenceRow.recall_provenance) || evidenceRow.recall_provenance.length === 0) fail(`scenario_recall_provenance_missing:${contractRow.id}`);
      if (["T17", "T40", "T57"].includes(contractRow.id) &&
          !evidenceRow.recall_provenance.some((item) => isUuid(item?.source_message_id))) fail(`scenario_correction_lineage_missing:${contractRow.id}`);
    }
    const validPersistence = expectedSuppression
      ? evidenceRow.b2?.persistence_result === "suppressed_human_control"
      : ["success", "idempotent"].includes(evidenceRow.b2?.persistence_result) && evidenceRow.b2?.evidence === "persisted_assistant_exact_source_binding";
    if (!validPersistence) fail(`scenario_b2_persistence_missing:${contractRow.id}`);
    requiredString(evidenceRow.observed_at, `${contractRow.id}.observed_at`);
  }
  return { id: contractRow.id, route, checks: textChecks };
}

function verifyLiveIdentity(evidence) {
  if (!Array.isArray(evidence.live_functions)) fail("live_functions_missing");
  for (const [name, expected] of Object.entries(LIVE_EXPECTED)) {
    const actual = evidence.live_functions.find((row) => row.function === name);
    if (!actual) fail(`live_function_missing:${name}`);
    for (const key of ["version", "verify_jwt", "import_map"]) {
      if (actual[key] !== expected[key]) fail(`live_function_${key}_mismatch:${name}`);
    }
    if (actual.status !== "ACTIVE" || actual.bundle !== expected.bundle) fail(`live_function_identity_mismatch:${name}`);
    if (!actual.source_manifest_sha256 || actual.source_parity !== true) fail(`live_function_source_parity_missing:${name}`);
  }
}

function verifyCheckpoints(evidence, contract) {
  const cps = evidence.long_run?.checkpoints;
  if (!Array.isArray(cps) || cps.length !== 3) fail("checkpoint_count_invalid");
  const turns = cps.map((x) => x.turn);
  if (turns[0] !== 20 || turns[1] !== 50 || turns[2] < 100) fail("checkpoint_turns_invalid");
  for (const cp of cps) {
    if (cp.measurement_source !== "runtime_observation") fail(`checkpoint_not_runtime_observed:${cp.turn}`);
    if (cp.memory_chars > contract.bounds.structured_memory_chars) fail(`memory_bound_exceeded:${cp.turn}`);
    if (cp.generation_context_chars > contract.bounds.generation_context_chars) fail(`generation_context_bound_exceeded:${cp.turn}`);
    if (cp.recent_raw_chars > contract.bounds.recent_raw_chars) fail(`recent_raw_bound_exceeded:${cp.turn}`);
    if (cp.recent_window_unit !== contract.bounds.recent_window_unit || cp.recent_window_count > contract.bounds.recent_window_count) fail(`recent_window_contract_mismatch:${cp.turn}`);
    if (!isUuid(cp.source_message_id) || !Number.isInteger(cp.memory_revision)) fail(`checkpoint_lineage_invalid:${cp.turn}`);
  }
}

function verifyCoreAndRebuild(evidence) {
  const requiredCore = [
    "request_deadline_cancellation", "terminal_budget_75000_15000_90000_120000",
    "source_bound_b2_atomic_commit", "late_completion_exactly_once", "memory_initial_creation",
    "memory_incremental_update", "stale_rejection_and_fresh_retry", "idempotency_exactly_once_event",
    "wrong_tenant_rejection", "canonical_snapshot_non_null", "takeover_suppression",
    "superseded_source_rejection", "c1_current_fact_authority", "c2_handoff_precedence",
    "agent_assist_tenant_safe", "return_to_ai_explicit_only", "no_direct_persistence_bypass",
  ];
  const byName = new Map((evidence.core_checks ?? []).map((x) => [x.name, x]));
  for (const name of requiredCore) {
    const row = byName.get(name);
    if (!row || row.pass !== true || !row.observation || row.observation.source !== "runtime_readback") fail(`core_check_missing_or_unobserved:${name}`);
  }
  const rebuild = evidence.rebuild_comparison;
  if (!rebuild || rebuild.source !== "authoritative_history_and_canonical_state" || rebuild.equal !== true) fail("rebuild_comparison_invalid");
  const fields = ["current_facts", "latest_corrections", "entities", "cancellations", "transaction_state", "regions", "open_questions"];
  if (fields.some((field) => rebuild.fields?.[field] !== true)) fail("rebuild_semantic_field_mismatch");
}

function verifyCleanup(evidence) {
  const c = evidence.cleanup;
  if (!c || c.completed !== true || c.source !== "exact_fixture_manifest") fail("cleanup_evidence_missing");
  if (c.readback_source !== "management_api_exact_id_transaction_and_post_delete_select") fail("cleanup_readback_source_untrusted");
  if (c.fixture_state !== "inactive_deleted" || c.exclude_training !== true) fail("cleanup_fixture_classification_invalid");
  for (const key of ["safely_deletable_residue", "active_conversations", "active_jobs", "training_eligible", "learning_candidates"]) {
    if (c[key] !== 0) fail(`cleanup_nonzero:${key}`);
  }
  if (!Number.isInteger(c.retained_audit_count) || c.retained_audit_count < 0) fail("cleanup_retained_audit_invalid");
  requiredString(c.fixture_manifest_sha256, "cleanup.fixture_manifest_sha256");
}

export function verifyEvidence(evidence, contractInfo, options = {}) {
  const requireLiveProduction = options.requireLiveProduction !== false;
  if (evidence.schema_version !== EVIDENCE_SCHEMA_VERSION) fail("evidence_schema_version_invalid");
  if (requireLiveProduction && evidence.mode !== "live_production") fail("synthetic_or_nonproduction_evidence_rejected");
  if (evidence.project !== (options.expectedProject ?? PROJECT_REF)) fail("evidence_project_mismatch");
  if (evidence.repository !== "ebixsolutions/console-chat-hub") fail("evidence_repository_mismatch");
  if (options.expectedHead && evidence.runner?.head !== options.expectedHead) fail("evidence_head_mismatch");
  if (options.expectedTree && evidence.runner?.tree !== options.expectedTree) fail("evidence_tree_mismatch");
  if (options.expectedRunId && String(evidence.run?.id) !== String(options.expectedRunId)) fail("evidence_run_id_mismatch_or_replay");
  if (options.expectedAttempt && String(evidence.run?.attempt) !== String(options.expectedAttempt)) fail("evidence_attempt_mismatch_or_replay");
  if (evidence.scenario_contract?.sha256 !== contractInfo.sha256 || evidence.scenario_contract?.version !== contractInfo.contract.contract_version) fail("scenario_contract_identity_mismatch");
  requiredString(evidence.run?.started_at, "run.started_at");
  requiredString(evidence.created_at, "created_at");
  if (Date.parse(evidence.created_at) < Date.parse(evidence.run.started_at)) fail("evidence_time_precedes_run");
  if (evidence.artifact?.id === undefined || !/^sha256:[0-9a-f]{64}$/.test(String(evidence.artifact?.digest ?? ""))) fail("durable_artifact_identity_missing");
  verifyLiveIdentity(evidence);
  if (requireLiveProduction && (evidence.db_security?.pass !== true || evidence.db_security?.source !== "management_api_read_only_sql")) {
    fail("db_security_readback_missing_or_untrusted");
  }

  const rows = evidence.scenarios;
  if (!Array.isArray(rows) || rows.length !== 15) fail("evidence_must_have_15_scenario_rows");
  const ids = rows.map((row) => row.id);
  if (new Set(ids).size !== 15) fail("evidence_duplicate_scenario_row");
  const evidenceById = new Map(rows.map((row) => [row.id, row]));
  const scenarioResults = contractInfo.contract.scenarios.map((row) => {
    const actual = evidenceById.get(row.id);
    if (!actual) fail(`evidence_scenario_missing:${row.id}`);
    return verifyScenario(row, actual, { requireLiveProduction });
  });

  if (requireLiveProduction) {
    const longRun = evidence.long_run;
    if (!longRun || longRun.fresh !== true || longRun.transport_successes < 100 || longRun.unique_customer_source_messages < 100 || longRun.assistant_persistences < 100) fail("fresh_100_turn_completion_invalid");
    if (!Array.isArray(longRun.semantic_checks) || longRun.semantic_checks.length !== 15) fail("long_run_semantic_checks_invalid");
    if (longRun.semantic_checks.some((row) => row.pass !== true || row.source !== "actual_assistant_reply")) fail("long_run_semantic_correctness_incomplete");
    if (longRun.semantic_total !== 15 || longRun.semantic_correct !== 15) fail("long_run_semantic_count_invalid");
    if (new Set(longRun.customer_source_message_ids ?? []).size !== longRun.unique_customer_source_messages) fail("long_run_source_message_uniqueness_invalid");
    verifyCheckpoints(evidence, contractInfo.contract);
    verifyCoreAndRebuild(evidence);
    verifyCleanup(evidence);
    if (evidence.quick_gate?.all_pass !== true || evidence.quick_gate?.long_run_started_only_after_pass !== true) fail("quick_first_sequence_invalid");
    if (evidence.historical_hkd_8000?.pass !== true || evidence.historical_hkd_8000?.source !== "runtime_readback") fail("historical_hkd_8000_probe_missing");
  }
  return { pass: true, scenario_results: scenarioResults, contract_sha256: contractInfo.sha256 };
}

function parseArgs(argv) {
  const out = { command: argv[2] ?? "verify" };
  for (let i = 3; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.command !== "verify") fail(`unsupported_command:${args.command}`);
  const evidencePath = path.resolve(requiredString(args.evidence, "--evidence"));
  const contractPath = path.resolve(requiredString(args.contract, "--contract"));
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const result = verifyEvidence(evidence, readContract(contractPath), {
    requireLiveProduction: args["allow-synthetic"] !== "true",
    expectedHead: args["expected-head"],
    expectedTree: args["expected-tree"],
    expectedProject: args["expected-project"],
    expectedRunId: args["expected-run-id"],
    expectedAttempt: args["expected-attempt"],
  });
  console.log(`C3_EVIDENCE_VERIFIER|result=PASS|contract_sha256=${result.contract_sha256}|rows=${result.scenario_results.length}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { main(); } catch (error) {
    console.error(`C3_EVIDENCE_VERIFIER|result=FAIL|reason=${error.message}`);
    process.exitCode = 1;
  }
}
