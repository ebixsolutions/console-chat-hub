#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { readContract, verifyEvidence } from "./c3_validation_evidence.mjs";
import { verifyComponentRegression, verifyHumanCalibration } from "./c3_service_quality_evidence.mjs";
import { verifyCommittedDerivedState, verifyCommittedState as verifyRealCustomerCommittedState, verifyFreezeManifest } from "./c3_real_customer_dataset.mjs";
import { verifyIndependentGraderArtifact } from "./c3_nonproduction_independent_grader.mjs";
import { verifyHumanCalibration as verifyBlindHumanCalibration } from "./c3_human_blind_calibration.mjs";

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
  if (binary) return run(binary, args);
  return process.env.CI ? run("deno", args) : run("npx", ["--yes", "deno", ...args]);
};

const files = {
  recall: "supabase/functions/_shared/conversation-recall.ts",
  recallUnit: "supabase/functions/_shared/conversation-recall.test.ts",
  recallIntegration: "supabase/functions/_shared/conversation-recall.integration.test.ts",
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
  servicePlanner: "supabase/functions/_shared/conversation-service-planner.ts",
  servicePlannerTest: "supabase/functions/_shared/conversation-service-planner.test.ts",
  serviceRuntime: "supabase/functions/_shared/conversation-service-runtime.ts",
  serviceRuntimeTest: "supabase/functions/_shared/conversation-service-runtime.test.ts",
  customer360EntitlementClient: "supabase/functions/_shared/customer360-entitlement-client.ts",
  customer360EntitlementContract: "supabase/functions/_shared/customer360-entitlement-contract.ts",
  customer360EntitlementClientTest: "supabase/functions/_shared/customer360-entitlement-client.test.ts",
  nonproductionSecret: "supabase/functions/_shared/nonproduction-secret.ts",
  nonproductionKbRuntime: "supabase/functions/kb-nonproduction-runtime/index.ts",
  nonproductionCustomer360Upstream: "supabase/functions/customer360-nonproduction-upstream/index.ts",
  customer360Adapter: "supabase/functions/customer360-adapter/index.ts",
  typecheck: "supabase/functions/deno.c3-check.json",
  migration:
    "supabase/migrations/20260915040000_ai_abc_c3_director_runtime_closure.sql",
  gate: ".github/scripts/task_ai_abc_c3_final_gate.mjs",
  workflow: ".github/workflows/task-ai-abc-c3-final-gate.yml",
  c2WorkflowRouting: ".github/workflows/task-ai-abc-c2-final-gate.yml",
  validationContract: ".github/scripts/c3_validation_scenarios.json",
  validationRunner: ".github/scripts/c3_validation_only_runner.py",
  evidenceVerifier: ".github/scripts/c3_validation_evidence.mjs",
  validationControlTests: ".github/scripts/c3_validation_control_tests.mjs",
  mergeGuard: ".github/scripts/c3_merge_no_redeploy_guard.mjs",
  releaseIdentity: ".github/scripts/c3_release_identity.mjs",
  releaseIdentityTest: ".github/scripts/c3_release_identity.test.mjs",
  serviceQualityRubric: ".github/scripts/c3_service_quality_rubric.json",
  serviceQualityCalibration: ".github/scripts/c3_service_quality_human_calibration.json",
  serviceQualityEvaluation: ".github/scripts/c3_service_quality_nonproduction.ts",
  serviceQualityVerifier: ".github/scripts/c3_service_quality_evidence.mjs",
  requirementEvidenceMatrix: ".github/scripts/c3_requirement_evidence_matrix.json",
  nonproductionBootstrap: "sql/c3-nonproduction/00_repository_baseline.sql",
  nonproductionSecurityClosure: "sql/c3-nonproduction/01_security_readback_closure.sql",
  nonproductionKbCrmContract: "sql/c3-nonproduction/02_kb_crm_contract.sql",
  nonproductionSyntheticFixture: "sql/c3-nonproduction/03_synthetic_fixture.sql",
  nonproductionRpcParity: "sql/c3-nonproduction/04_runtime_rpc_parity.sql",
  nonproductionCleanup: "sql/c3-nonproduction/99_cleanup_exact_fixture_ids.sql",
  nonproductionDataset: ".github/scripts/c3_nonproduction_heldout_dataset.json",
  nonproductionRunner: ".github/scripts/c3_nonproduction_external_quality.mjs",
  nonproductionRunnerTest: ".github/scripts/c3_nonproduction_external_quality.test.mjs",
  nonproductionRuntimeIdentity: ".github/scripts/c3_nonproduction_runtime_identity.json",
  realCustomerSourceRegistry: ".github/scripts/c3_real_customer_source_registry.json",
  realCustomerDatasetSchema: ".github/scripts/c3_real_customer_heldout_dataset_v1.schema.json",
  realCustomerDataset: ".github/scripts/c3_real_customer_heldout_dataset_v1.json",
  realCustomerFreeze: ".github/scripts/c3_real_customer_freeze_manifest_v1.json",
  realCustomerDatasetVerifier: ".github/scripts/c3_real_customer_dataset.mjs",
  realCustomerDatasetTest: ".github/scripts/c3_real_customer_dataset.test.mjs",
  independentGraderVerifier: ".github/scripts/c3_nonproduction_independent_grader.mjs",
  independentGraderTest: ".github/scripts/c3_nonproduction_independent_grader.test.mjs",
  humanBlindCalibration: ".github/scripts/c3_human_blind_calibration.mjs",
  humanBlindCalibrationTest: ".github/scripts/c3_human_blind_calibration.test.mjs",
  realCustomerEvidenceDoc: ".github/docs/c3-real-customer-quality-evidence.md",
  derivedScreening: ".github/scripts/c3_real_case_derived_screening_v1.json",
  derivedDataset: ".github/scripts/c3_real_case_derived_dataset_v1.json",
  derivedFreeze: ".github/scripts/c3_real_case_derived_freeze_manifest_v1.json",
  derivedReviewPreparation: ".github/scripts/c3_real_case_derived_review_preparation_v1.json",
  task42DeployWorkflow: ".github/workflows/task4-2-deploy-live-console-edge.yml",
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
    "prepareConversationRecall(",
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
    "conversation_memory:",
    "c3Memory",
    "conversation_memory_summary",
    "parsePersistedC2Handoff",
    "persisted_c2",
    "resolveConversationScope",
    "selectCanonicalGrounding",
    "callAssistModel",
  ]
) must(assist.includes(marker), `agent_assist_compatibility_missing:${marker}`);
must(/\.eq\(\s*"company_id",\s*companyId,?\s*\)/.test(assist), "agent_assist_company_scope_missing");
must(
  assist.lastIndexOf("parsePersistedC2Handoff") <
    assist.lastIndexOf("buildWarmHandoffPackage"),
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
    ![
      files.nonproductionKbRuntime,
      files.nonproductionKbCrmContract,
      files.nonproductionSyntheticFixture,
    ].includes(file) &&
    /(kb.*(?:publish|review|vector)|training-kb|review-executor)/i.test(file)
  ),
  "kb_lifecycle_change_forbidden",
);

const servicePlanner = read(files.servicePlanner);
for (const marker of [
  "planConversationService", "partial_answer_then_question", "bounded_kb_refinement",
  "historical_calculation", "offer_handoff_or_reframe", "renderTargetedServiceQuestion",
]) must(servicePlanner.includes(marker), `service_planner_contract_missing:${marker}`);
for (const marker of ["planConversationService(", "buildServicePlanPromptBlock("]) {
  must(generate.includes(marker), `generate_service_planner_integration_missing:${marker}`);
}
must(assist.includes("planConversationService("), "assist_service_planner_integration_missing");
for (const source of [generate, assist]) {
  must(source.includes("deriveServiceRuntimeInputs("), "service_runtime_derivation_not_wired");
  must(source.includes("applyServiceRuntimeDerivation("), "service_runtime_inputs_not_applied");
  must(source.includes("calculation_input_status"), "service_runtime_observability_missing");
}
const qualityRubric = JSON.parse(read(files.serviceQualityRubric));
must(qualityRubric.target?.weighted_score_min === 95, "quality_target_not_95");
must(qualityRubric.target?.critical_p0_allowed === 0, "quality_p0_not_zero");
const calibration = JSON.parse(read(files.serviceQualityCalibration));
const humanCalibration = verifyHumanCalibration(calibration, { requireCompleted: false });
const realCustomerDataset = verifyRealCustomerCommittedState();
must(["READY", "BLOCKED"].includes(realCustomerDataset.status), "real_customer_dataset_status_invalid");
must(realCustomerDataset.actual_case_count <= 100, "real_customer_dataset_count_invalid");
const derivedFreezeIdentity = JSON.parse(read(files.derivedFreeze)).prepared_from_candidate;
const derivedDataset = verifyCommittedDerivedState(derivedFreezeIdentity);
must(derivedDataset.derived_case_count === 100, "derived_dataset_count_invalid");
must(derivedDataset.original_a_class_eligible_dialogue_count === 0, "derived_dataset_must_not_change_a_class_count");
must(derivedDataset.derived_score === "NOT_MEASURED" && derivedDataset.human_calibration === "AWAITING" && derivedDataset.product_ready === false, "derived_dataset_gate_isolation_invalid");

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
runDeno(["test", "--no-lock", files.servicePlannerTest]);
runDeno(["test", "--no-lock", "--allow-read", files.serviceRuntimeTest]);
runDeno(["test", "--no-lock", files.customer360EntitlementClientTest]);
const qualityEvidencePath = process.env.C3_SERVICE_QUALITY_EVIDENCE_PATH?.trim() ||
  `${process.env.RUNNER_TEMP || "/tmp"}/c3-service-quality-nonproduction.json`;
runDeno(["run", "--no-lock", "--allow-read", "--allow-write", files.serviceQualityEvaluation, qualityEvidencePath]);
const nonproductionComponent = verifyComponentRegression(JSON.parse(read(qualityEvidencePath)));
runDeno(["test", "--no-lock", "--allow-read", files.integration, files.recallIntegration]);
runDeno([
  "check",
  "--no-lock",
  files.memory,
  files.recall,
  files.terminalGuard,
  files.terminalTest,
    files.servicePlanner,
    files.servicePlannerTest,
    files.serviceRuntime,
    files.serviceRuntimeTest,
    files.customer360EntitlementClient,
    files.customer360EntitlementContract,
    files.customer360EntitlementClientTest,
    files.nonproductionSecret,
    files.nonproductionKbRuntime,
    files.nonproductionCustomer360Upstream,
    files.customer360Adapter,
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
  files.recall,
  files.recallUnit,
  files.recallIntegration,
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
  files.evidenceVerifier,
  files.validationControlTests,
  files.serviceQualityVerifier,
  files.serviceRuntime,
  files.serviceRuntimeTest,
  files.mergeGuard,
  files.releaseIdentity,
  files.releaseIdentityTest,
  files.realCustomerDatasetVerifier,
  files.realCustomerDatasetTest,
  files.independentGraderVerifier,
  files.independentGraderTest,
  files.humanBlindCalibration,
  files.humanBlindCalibrationTest,
]);
run("python", ["-c", "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", files.validationRunner]);
run("node", [files.validationControlTests]);
run("node", [files.releaseIdentityTest]);
run("node", [files.realCustomerDatasetTest]);
run("node", [files.independentGraderTest]);
run("node", [files.humanBlindCalibrationTest]);
run("npm", ["run", "build"]);

const phase = process.env.C3_GATE_PHASE === "production"
  ? "production"
  : "preproduction";
let realCustomerQualityComplete = false;
let verifiedRealCustomerQuality = null;
if (realCustomerDataset.status === "READY") {
  const requiredPaths = {
    runtime: process.env.C3_REAL_CUSTOMER_RUNTIME_ARTIFACT_PATH?.trim(),
    rawGrader: process.env.C3_RAW_GRADER_ARTIFACT_PATH?.trim(),
    humanPacket: process.env.C3_HUMAN_BLIND_PACKET_PATH?.trim(),
    humanReviews: process.env.C3_HUMAN_BLIND_REVIEW_ARTIFACT_PATH?.trim(),
  };
  for (const [name, file] of Object.entries(requiredPaths)) must(file && fs.existsSync(file), `real_customer_artifact_missing:${name}`);
  const candidate = { head: process.env.C3_EXPECTED_HEAD, tree: process.env.C3_EXPECTED_TREE };
  const dataset = JSON.parse(read(files.realCustomerDataset));
  const registry = JSON.parse(read(files.realCustomerSourceRegistry));
  const freeze = JSON.parse(read(files.realCustomerFreeze));
  verifyFreezeManifest(freeze, dataset, registry, candidate);
  const grader = verifyIndependentGraderArtifact({
    raw: JSON.parse(read(requiredPaths.rawGrader)),
    runtime: JSON.parse(read(requiredPaths.runtime)),
    dataset,
    freeze,
    rubric: qualityRubric,
    expectedCandidate: candidate,
    rawArtifactSha256: process.env.C3_RAW_GRADER_CANONICAL_SHA256,
  });
  must(grader.pass === true, "real_customer_quality_threshold_not_met");
  const human = verifyBlindHumanCalibration({
    artifact: JSON.parse(read(requiredPaths.humanReviews)),
    packet: JSON.parse(read(requiredPaths.humanPacket)),
    expectedCandidate: candidate,
    rubric: qualityRubric,
  });
  realCustomerQualityComplete = human.status === "CALIBRATED";
  verifiedRealCustomerQuality = { grader, human };
}
let rollbackAssertion;
if (phase === "preproduction") {
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
  const interimRecoveryBaseline = process.env.C3_RECOVERY_INTERIM_BASELINE === "PASS";
  must(
    interimRecoveryBaseline,
    "STOP:C3_INTERIM_RECOVERY_BASELINE_NOT_PROVIDED",
  );
  must(
    process.env.C3_CURRENT_LIVE_DURABLE_CAPTURE === "PASS",
    "current_live_v108_v43_durable_capture_not_verified",
  );
  const liveSourceParity = process.env.C3_CURRENT_LIVE_SOURCE_PARITY === "PASS";
  const sourceDeploymentBoundary =
    process.env.C3_CURRENT_LIVE_SOURCE_PARITY === "NOT_APPLICABLE" &&
    process.env.C3_SOURCE_DEPLOYMENT_BOUNDARY === "PASS";
  must(
    liveSourceParity || sourceDeploymentBoundary,
    "current_live_source_identity_or_deployment_boundary_not_verified",
  );
  rollbackAssertion = {
    identity: "INTERIM_LIVE_RECOVERY_BASELINE",
    classification: "NOT_PRODUCT_READY",
    generate_reply: { version: 108, source_closure: "DURABLY_CAPTURED" },
    agent_assist: { version: 43, source_closure: "DURABLY_CAPTURED" },
    prior_v107_v42_exact_closure: "UNRECOVERED",
  };
}
let productionEvidence = null;
if (phase === "production") {
  const humanReviewPath = process.env.C3_HUMAN_REVIEW_ARTIFACT_PATH?.trim();
  must(humanReviewPath && fs.existsSync(humanReviewPath), "FAIL:C3_HUMAN_REVIEW_ARTIFACT_MISSING");
  verifyHumanCalibration(calibration, {
    requireCompleted: true,
    reviewArtifact: JSON.parse(read(humanReviewPath)),
    expectedBinding: {
      head: process.env.C3_EXPECTED_HEAD,
      tree: process.env.C3_EXPECTED_TREE,
      release_id: process.env.C3_RELEASE_ID,
      rubricSha256: sha(files.serviceQualityRubric),
    },
    rubric: qualityRubric,
  });
  const evidencePath = process.env.C3_EVIDENCE_PATH?.trim();
  const contractPath = process.env.C3_SCENARIO_CONTRACT_PATH?.trim() ||
    files.validationContract;
  must(evidencePath && fs.existsSync(evidencePath), "FAIL:C3_RUNTIME_EVIDENCE_MISSING");
  const evidence = JSON.parse(read(evidencePath));
  const verified = verifyEvidence(evidence, readContract(contractPath), {
    requireLiveProduction: true,
    expectedHead: process.env.C3_EXPECTED_HEAD,
    expectedTree: process.env.C3_EXPECTED_TREE,
    expectedProject: process.env.C3_EXPECTED_PROJECT,
    expectedRunId: process.env.C3_EXPECTED_RUN_ID,
    expectedAttempt: process.env.C3_EXPECTED_RUN_ATTEMPT,
    expectedReleaseId: process.env.C3_RELEASE_ID,
    expectedReleaseDigest: process.env.C3_RELEASE_DIGEST,
    expectedDeploymentRunId: process.env.C3_DEPLOYMENT_RUN_ID,
  });
  must(verified.pass === true, "FAIL:C3_RUNTIME_EVIDENCE_NOT_VERIFIED");
  productionEvidence = {
    verified: true,
    rows: verified.scenario_results.length,
    contract_sha256: verified.contract_sha256,
    run_id: evidence.run.id,
    attempt: evidence.run.attempt,
  };
  rollbackAssertion = {
    identity: evidence.release_identity.release_id,
    classification: "RELEASE_ACTUAL_TARGET_EVIDENCE_VERIFIED",
    generate_reply: evidence.release_identity.functions["generate-reply"],
    agent_assist: evidence.release_identity.functions["agent-assist"],
    prior_v107_v42_exact_closure: "UNRECOVERED",
  };
  console.log(`C3_PRODUCTION_EVIDENCE_GATE|result=PASS|rows=${verified.scenario_results.length}|contract_sha256=${verified.contract_sha256}`);
}

console.log(JSON.stringify(
  {
    gate: "AI_ABC_C3_FINAL_GATE",
    phase,
    status: realCustomerQualityComplete && phase === "production" ? "PASS" : "STOP_AUTHORIZATION_REQUIRED",
    closure_contract: {
      memory_version: "conversation-memory-1.0.0",
      storage: "public.conversation_memory_state",
      event_ledger: "public.conversation_memory_state_event",
      context_char_budget: 32768,
      memory_json_char_budget: 16384,
      recent_raw_message_limit: 12,
      recent_raw_window_unit: "messages",
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
      source_closure_rollback_identity: "INTERIM_V108_V43_DURABLE_CAPTURE",
      migration_runtime_rehearsal: true,
      edge_typecheck: process.env.CI ? true : "CI_REQUIRED",
      production_100_turn: phase === "production"
        ? true
        : "AUTHORIZATION_PENDING",
      production_runtime_evidence: phase === "production"
        ? productionEvidence
        : "AUTHORIZATION_PENDING",
      nonproduction_component_regression: nonproductionComponent,
      independent_held_out_quality: realCustomerQualityComplete ? "VERIFIED_REAL_CUSTOMER" : "NOT_MEASURED",
      human_calibration: humanCalibration.status,
      real_customer_dataset: realCustomerDataset.status,
      real_customer_case_count: realCustomerDataset.actual_case_count,
      real_customer_quality_score: realCustomerQualityComplete ? verifiedRealCustomerQuality.grader.weighted_score : "NOT_MEASURED",
      real_customer_human_calibration: realCustomerQualityComplete ? "CALIBRATED" : "AWAITING",
      verified_real_customer_quality: verifiedRealCustomerQuality,
      product_ready: realCustomerQualityComplete && phase === "production",
      rollback: rollbackAssertion,
    },
  },
  null,
  2,
));
if (!realCustomerQualityComplete || phase === "preproduction") {
  console.error("C3_FINAL_GATE|result=STOP|reason=production_independent_quality_and_human_authorization_required|exit_code=78");
  process.exitCode = 78;
}
