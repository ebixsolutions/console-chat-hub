#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { readContract, verifyEvidence } from "./c3_validation_evidence.mjs";
import { verifyComponentRegression, verifyHumanCalibration } from "./c3_service_quality_evidence.mjs";
import { verifyCommittedDerivedState, verifyCommittedState as verifyRealCustomerCommittedState, verifyFreezeManifest } from "./c3_real_customer_dataset.mjs";
import { verifyIndependentGraderArtifact } from "./c3_nonproduction_independent_grader.mjs";
import { verifyHumanCalibration as verifyBlindHumanCalibration } from "./c3_human_blind_calibration.mjs";
import { verifyObjectiveOracle } from "./c3_deterministic_quality.mjs";
import { verifyDeterministicClosure } from "./c3_deterministic_runtime_closure.mjs";

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
  deterministicEngine: "supabase/functions/_shared/deterministic-commerce-engine.ts",
  deterministicEngineTest: "supabase/functions/_shared/deterministic-commerce-engine.test.ts",
  deterministicRouter: "supabase/functions/_shared/deterministic-runtime-router.ts",
  deterministicKbClient: "supabase/functions/_shared/deterministic-kb-client.ts",
  turn37Harness: "scripts/task9-tungyu-100turn-production-smoke.py",
  turn37HarnessTest: "scripts/task9-turn37-contract-test.py",
  currentFactEvidence:
    "supabase/functions/_shared/current-fact-evidence.ts",
  currentFactEvidenceTest:
    "supabase/functions/_shared/current-fact-evidence.test.ts",
  handoffIntent: "supabase/functions/_shared/handoff-intent.ts",
  commerceStateReducer: "supabase/functions/_shared/commerce-state-reducer.ts",
  commerceStateAuthority: "supabase/functions/_shared/commerce-state-authority.ts",
  commerceStateRuntimeBase: "supabase/functions/_shared/commerce-state-runtime-base.ts",
  b2JourneyProgressContract:
    "supabase/functions/_shared/b2-journey-progress-contract.ts",
  preSendConversionSupervisor: "supabase/functions/_shared/pre-send-conversion-supervisor.ts",
  preSendConversionSupervisorTest:
    "supabase/functions/_shared/pre-send-conversion-supervisor.test.ts",
  resolutionContract:
    "supabase/functions/_shared/conversation-resolution-contract.ts",
  resolutionContractTest:
    "supabase/functions/_shared/conversation-resolution-contract.test.ts",
  authoritativeCommitReadback:
    "supabase/functions/_shared/authoritative-commit-readback.ts",
  authoritativeCommitReadbackTest:
    "supabase/functions/_shared/authoritative-commit-readback.test.ts",
  kbAggregationResponse: "supabase/functions/_shared/kb-aggregation-response.ts",
  deterministicCeGrounding: "supabase/functions/_shared/ce-grounding.ts",
  deterministicCanonicalGrounding: "supabase/functions/_shared/canonical-grounding.ts",
  deterministicCitationLineage: "supabase/functions/_shared/citation-lineage.ts",
  canonicalKbB2PriceTest: "supabase/functions/_shared/canonical-kb-b2-price.test.ts",
  canonicalKbDirectAnswer: "supabase/functions/_shared/canonical-kb-direct-answer.ts",
  canonicalKbDirectAnswerTest: "supabase/functions/_shared/canonical-kb-direct-answer.test.ts",
  canonicalKbRetrievalTest: "supabase/functions/_shared/kb-canonical-retrieval.test.ts",
  productFactualQueryTest: "supabase/functions/_shared/product-factual-query.test.ts",
  productReferentHistoryTest: "supabase/functions/_shared/product-referent-history.test.ts",
  productFollowUpArbitrationTest:
    "supabase/functions/_shared/product-follow-up-arbitration.test.ts",
  kbClient: "supabase/functions/_shared/kb-client.ts",
  semanticInterpreter:
    "supabase/functions/_shared/commerce-semantic-interpreter.ts",
  ceAutomation: "supabase/functions/_shared/ce-automation-engine.ts",
  escalationPolicy: "supabase/functions/_shared/escalation-policy.ts",
  generate: "supabase/functions/generate-reply/index.ts",
  assist: "supabase/functions/agent-assist/index.ts",
  conversationEvaluate: "supabase/functions/conversation-evaluate/index.ts",
  kbSearchProxy: "supabase/functions/kb-search-proxy/index.ts",
  servicePlanner: "supabase/functions/_shared/conversation-service-planner.ts",
  servicePlannerTest: "supabase/functions/_shared/conversation-service-planner.test.ts",
  serviceRuntime: "supabase/functions/_shared/conversation-service-runtime.ts",
  serviceRuntimeTest: "supabase/functions/_shared/conversation-service-runtime.test.ts",
  contextualCustomerUpdate: "supabase/functions/_shared/contextual-customer-update.ts",
  contextualCustomerUpdateTest: "supabase/functions/_shared/contextual-customer-update.test.ts",
  customerJourneyOrchestration: "supabase/functions/_shared/customer-journey-orchestration.ts",
  customerJourneyOrchestrationTest: "supabase/functions/_shared/customer-journey-orchestration.test.ts",
  conversationalRouting: "supabase/functions/_shared/conversational-routing.ts",
  conversationalRoutingTest: "supabase/functions/_shared/conversational-routing.test.ts",
  industryRuntimeAdapter: "supabase/functions/_shared/industry-runtime-adapter.ts",
  homeApplianceProfile: "supabase/functions/_shared/industry-profiles/home-appliance-v1.ts",
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
  deterministicMigration:
    "supabase/migrations/20260917062606_c3_deterministic_commerce_fts_governance.sql",
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
  moduleGraph: ".github/scripts/c3_module_graph.mjs",
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
  customerDemo20Source: ".github/scripts/c3_customer_demo_20_source.ts",
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
  deterministicOracle: ".github/scripts/c3_deterministic_objective_oracle_v1.json",
  deterministicFreeze: ".github/scripts/c3_deterministic_objective_freeze_v1.json",
  deterministicQuality: ".github/scripts/c3_deterministic_quality.mjs",
  deterministicQualityTest: ".github/scripts/c3_deterministic_quality.test.mjs",
  deterministicHumanReviewSchema: ".github/scripts/c3_deterministic_human_review.schema.json",
  deterministicClosure: ".github/scripts/c3_deterministic_runtime_closure.mjs",
  deterministicClosureTest: ".github/scripts/c3_deterministic_runtime_closure.test.mjs",
  deterministicFtsTest: ".github/scripts/c3_deterministic_fts.test.mjs",
  task42DeployWorkflow: ".github/workflows/task4-2-deploy-live-console-edge.yml",
  canonical103Fixture: ".github/scripts/c3_canonical_103_turns.json",
  canonical103Replay: ".github/scripts/c3_canonical_103_source_replay.ts",
  capturedProductionFailures:
    ".github/scripts/c3_captured_production_failure_envelopes.json",
  naturalCustomerResponse:
    "supabase/functions/_shared/natural-customer-response.ts",
  naturalCustomerResponseTest:
    "supabase/functions/_shared/natural-customer-response.test.ts",
};
for (const file of Object.values(files)) {
  must(
    fs.existsSync(file) && fs.statSync(file).size > 0,
    `missing_or_empty:${file}`,
  );
}

const memory = read(files.memory),
  unit = read(files.unit),
  integration = read(files.integration),
  recallIntegration = read(files.recallIntegration);
const terminalGuard = read(files.terminalGuard),
  terminalTest = read(files.terminalTest);
const generate = read(files.generate),
  assist = read(files.assist),
  commerceAuthority = read(files.commerceStateAuthority),
  commerceRuntime = read(files.commerceStateRuntimeBase),
  resolutionContract = read(files.resolutionContract),
  preSendConversionSupervisor = read(files.preSendConversionSupervisor),
  migration = read(files.migration);
const c2WorkflowRouting = read(files.c2WorkflowRouting);
const canonical103Fixture = JSON.parse(read(files.canonical103Fixture));
must(
  canonical103Fixture.frozen === true &&
    canonical103Fixture.turn_count === 103 &&
    canonical103Fixture.turns?.length === 103,
  "canonical_103_fixture_invalid",
);
const capturedProductionFailures = JSON.parse(
  read(files.capturedProductionFailures),
);
must(
  capturedProductionFailures.frozen === true &&
    capturedProductionFailures.failures?.length === 11,
  "captured_production_failures_invalid",
);
const migrationExecutableBody = migration.split("\n").slice(3).join("\n");
must(
  crypto.createHash("sha256").update(migrationExecutableBody).digest("hex") ===
    "c58361cc5a2c1516c8d33bca9c2f7c59b675d7b7a6a39a49dd2b9aae0c1797eb",
  "migration_rehearsed_executable_body_drift",
);

const authorizedTargetedRepairHashes = new Map([
  [
    "supabase/functions/_shared/commerce-state-reducer.ts",
    "e03bd84248a6b3a0a5128bf18e780c361c442c02243b6eb866dad5359c45bbcb",
  ],
  [
    "supabase/functions/_shared/commerce-state-runtime-base.ts",
    "e9c2a521a473fe0da6193b4076796ac03e5c783eeb96762093edea2583da01ba",
  ],
  [
    "supabase/functions/_shared/pre-send-conversion-supervisor.ts",
    "e8523687fcd9c17f762c21dc1c814d2f8be10a083a52ec01f13fe627ae1e20c3",
  ],
]);
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
for (const marker of [
  "buildResolvedAddressCorrectionAnswer",
  "resolveCommittedAddressCorrection",
  "authoritative_address_correction_resolved",
  "explicit_address_correction_applied",
  "previous_state",
]) must(commerceRuntime.includes(marker), `commerce_correction_reply_missing:${marker}`);
for (const marker of [
  "READ_ONLY_CURRENT_STATE_QUERY",
  "isReadOnlyCurrentStateQuery",
  "READ_ONLY_MEMORY_OR_CURRENT_STATE_RECALL",
  "read_only_current_state_query_resolved",
  "read_only_memory_or_current_state_recall_resolved",
  "read_only_current_state_aggregate_query_resolved",
  "read_only_current_state_aggregate_query_unresolved",
]) must(commerceRuntime.includes(marker), `commerce_read_only_contract_missing:${marker}`);
for (const marker of [
  "classifyB2AuthoritativePersistence",
  "NO_SEMANTIC_CHANGE",
  "B2_ALLOW_NO_SEMANTIC_CHANGE_AFTER_AUTHORITATIVE_READBACK",
]) must(preSendConversionSupervisor.includes(marker), `b2_read_only_readback_contract_missing:${marker}`);
for (const marker of [
  "canonicalTenantScopeFromAuthoritativeCompany",
  "authoritativeCompanyId",
]) must(read(files.deterministicKbClient).includes(marker), `turn36_scope_repair_missing:${marker}`);
for (const marker of [
  "HUMAN_CONTROL_SUPPRESSED",
  "classify_ingress_terminal",
  "if terminal:",
]) must(read(files.turn37Harness).includes(marker), `turn37_harness_contract_missing:${marker}`);
for (const marker of [
  "questionExplicitlyAsksQuantity",
  "inferEntityStatusPath",
  "isReadOnlyMemoryOrCurrentStateRecall",
  "isReadOnlyCurrentStateAggregateQuery",
]) must(commerceAuthority.includes(marker), `commerce_known_answer_authority_missing:${marker}`);
for (const marker of [
  "59b89c91-f150-4120-b226-a2944f0eb2da",
  "generic:定兩部",
  "C3 captured production turn 55 known quantity is read-only and outranks clarification",
  "Turn-55 state hash changed",
  "Turn-55 B2 receipt invalid",
  "Turn-55 P0=",
]) must(recallIntegration.includes(marker), `turn55_regression_missing:${marker}`);
for (const marker of [
  "35bea890-7c24-41c2-9e3d-7b5aa56f5afb",
  "C3 captured production turn 25 memory recall is read-only and outranks clarification",
  "read-only recall created",
]) must(recallIntegration.includes(marker), `turn25_regression_missing:${marker}`);
for (const marker of [
  "cab996a5-f99b-4f66-b89e-3bb0e73e5ecc",
  "C3 captured production turn 27 rejects AC quantity and resolves refrigerator width constraint",
  "C3 attribute-compatible referent routing is fail-closed across topic switches and quantities",
  "customer_constraints.refrigerator.width",
]) must(recallIntegration.includes(marker), `turn27_regression_missing:${marker}`);
for (const marker of [
  "d4c905ae-35bf-4c4b-bc5b-c9e377e70fc7",
  "C3 captured production turn 48 resolves pending technician count read-only before clarification",
  "read_only_current_state_aggregate_query_resolved",
  "installation.pending_checks",
]) must(recallIntegration.includes(marker), `turn48_regression_missing:${marker}`);
for (const marker of [
  "read_only_attribute_constraint_query_resolved",
  "resolveAttributeQueryCategory",
  "compatibleQuantityStatePath",
  "parseCommerceDimensionMeasurement",
]) must(commerceRuntime.includes(marker), `attribute_compatibility_contract_missing:${marker}`);
must(
  commerceAuthority.includes("A product article followed by a dimension") &&
    commerceAuthority.includes("inferCommerceDimensionAttribute"),
  "dimension_must_not_be_quantity_recall",
);
must(
  generate.includes("resolveCommittedAddressCorrection({") &&
    generate.includes("_c3ResolvedAddressCorrection"),
  "resolved_address_correction_must_outrank_clarification",
);
must(
  generate.includes("_c3Resolution = resolveCanonicalCommerceResolution") &&
    generate.includes("_c3Resolution.bypass_service_plan") &&
    resolutionContract.includes("AUTHORITATIVE_READ_ONLY"),
  "known_read_only_answer_must_outrank_clarification",
);
must(
  generate.includes("_c3PreMemoryResolution.skip_memory_refresh") &&
    generate.includes("? null") &&
    generate.includes(": await refreshConversationLongMemory("),
  "read_only_recall_must_not_rebind_memory_provenance",
);
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
for (const marker of [
  "const _explicitHandoffRequested = isHandoffIntent(_h1LastMsg)",
  "if (_c3PlannedReply && !_explicitHandoffRequested)",
  "if (_c3CommerceReply && !_explicitHandoffRequested)",
  'response_route: "explicit_handoff"',
]) must(generate.includes(marker), `explicit_handoff_precedence_missing:${marker}`);

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
    2,
  "migration_count_invalid",
);
for (
  const forbidden of [
    "supabase/functions/receive-widget-message/index.ts",
    "supabase/functions/ce-evaluation-worker/index.ts",
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
    "supabase/functions/_shared/pre-send-conversion-supervisor.ts",
    "supabase/functions/_shared/transaction-closure-handoff.ts",
    "supabase/migrations/20260915000000_ai_abc_c2_director_closure_handoff.sql",
    "supabase/functions/take-over-conversation/index.ts",
    "supabase/functions/return-to-ai/index.ts",
    "supabase/functions/receive-widget-message/index.ts",
    "supabase/functions/ce-evaluation-worker/index.ts",
  ]
) {
  const baseline = execFileSync("git", ["show", `origin/main:${file}`]);
  const expected = authorizedTargetedRepairHashes.get(file) ??
    crypto.createHash("sha256").update(baseline).digest("hex");
  must(
    expected === sha(file),
    `frozen_dependency_changed:${file}`,
  );
}

run("git", ["diff", "--check", "origin/main...HEAD"]);
runDeno(["test", "--no-lock", files.unit, files.terminalTest]);
runDeno(["test", "--no-lock", files.deterministicEngineTest]);
runDeno(["test", "--no-lock", files.currentFactEvidenceTest]);
runDeno([
  "test",
  "--no-lock",
  "--allow-read",
  files.resolutionContractTest,
  files.preSendConversionSupervisorTest,
  files.authoritativeCommitReadbackTest,
]);
runDeno(["test", "--no-lock", files.servicePlannerTest]);
runDeno(["test", "--no-lock", "--allow-read", files.serviceRuntimeTest]);
runDeno(["test", "--no-lock", files.customer360EntitlementClientTest]);
const qualityEvidencePath = process.env.C3_SERVICE_QUALITY_EVIDENCE_PATH?.trim() ||
  `${process.env.RUNNER_TEMP || "/tmp"}/c3-service-quality-nonproduction.json`;
runDeno(["run", "--no-lock", "--allow-read", "--allow-write", files.serviceQualityEvaluation, qualityEvidencePath]);
const nonproductionComponent = verifyComponentRegression(JSON.parse(read(qualityEvidencePath)));
runDeno(["test", "--no-lock", "--allow-read", files.integration, files.recallIntegration]);
runDeno([
  "test",
  "--no-lock",
  "--config",
  files.typecheck,
  "--allow-env",
  "--allow-read",
  files.naturalCustomerResponseTest,
  files.contextualCustomerUpdateTest,
  files.customerJourneyOrchestrationTest,
  files.productFactualQueryTest,
  files.productReferentHistoryTest,
  files.productFollowUpArbitrationTest,
]);
runDeno(["run", "--no-lock", "--allow-read", files.canonical103Replay]);
if (!process.env.CI) {
  runDeno([
    "check",
    "--no-lock",
    "--config",
    files.typecheck,
    "--node-modules-dir=auto",
    files.memory,
    files.recall,
    files.terminalGuard,
    files.terminalTest,
    files.commerceStateAuthority,
    files.commerceStateReducer,
    files.commerceStateRuntimeBase,
    files.b2JourneyProgressContract,
    files.customerJourneyOrchestration,
    files.customerJourneyOrchestrationTest,
    files.naturalCustomerResponse,
    files.naturalCustomerResponseTest,
    files.preSendConversionSupervisor,
    files.canonical103Replay,
  ]);
} else runDeno([
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
    files.deterministicEngine,
    files.deterministicRouter,
    files.deterministicKbClient,
    files.currentFactEvidence,
    files.handoffIntent,
    files.authoritativeCommitReadback,
    files.authoritativeCommitReadbackTest,
    files.resolutionContract,
    files.resolutionContractTest,
    files.canonical103Replay,
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
  files.moduleGraph,
  files.deterministicClosure,
  files.deterministicClosureTest,
  files.deterministicKbClient,
  files.handoffIntent,
  files.authoritativeCommitReadback,
  files.authoritativeCommitReadbackTest,
  files.b2JourneyProgressContract,
  files.preSendConversionSupervisorTest,
  files.resolutionContract,
  files.resolutionContractTest,
  files.canonical103Replay,
  files.naturalCustomerResponse,
  files.naturalCustomerResponseTest,
  files.kbAggregationResponse,
  files.realCustomerDatasetVerifier,
  files.realCustomerDatasetTest,
  files.independentGraderVerifier,
  files.independentGraderTest,
  files.humanBlindCalibration,
  files.humanBlindCalibrationTest,
]);
run("python", ["-c", "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())", files.validationRunner]);
run("python", [files.turn37HarnessTest]);
run("node", [files.validationControlTests]);
run("node", [files.releaseIdentityTest]);
run("node", [files.realCustomerDatasetTest]);
run("node", [files.independentGraderTest]);
run("node", [files.humanBlindCalibrationTest]);
run("node", [files.deterministicClosureTest]);
run("node", [files.deterministicFtsTest]);
run("node", [files.deterministicQualityTest]);
const deterministicClosure = verifyDeterministicClosure();
const deterministicObjective = verifyObjectiveOracle({
  dataset: JSON.parse(read(files.derivedDataset)),
  overlay: JSON.parse(read(files.deterministicOracle)),
  freeze: JSON.parse(read(files.deterministicFreeze)),
});
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
    "current_live_v112_v43_durable_capture_not_verified",
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
    generate_reply: { version: 112, source_closure: "DURABLY_CAPTURED", bundle_identity: "CAPTURED" },
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

const productReady = realCustomerQualityComplete && phase === "production";
const machineSourceReady = phase === "preproduction";

console.log(JSON.stringify(
  {
    gate: "AI_ABC_C3_FINAL_GATE",
    phase,
    status: machineSourceReady || productReady ? "PASS" : "STOP_AUTHORIZATION_REQUIRED",
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
      source_closure_rollback_identity: "INTERIM_V112_V43_DURABLE_CAPTURE_WITH_EXACT_BUNDLE_VERIFICATION",
      migration_runtime_rehearsal: true,
      edge_typecheck: process.env.CI ? true : "CHANGED_CLOSURE_PASS",
      production_100_turn: phase === "production"
        ? true
        : "AUTHORIZATION_PENDING",
      production_runtime_evidence: phase === "production"
        ? productionEvidence
        : "AUTHORIZATION_PENDING",
      nonproduction_component_regression: nonproductionComponent,
      independent_held_out_quality: realCustomerQualityComplete ? "VERIFIED_REAL_CUSTOMER" : "NOT_MEASURED",
      deterministic_runtime_closure: deterministicClosure,
      deterministic_objective_conformance_contract: deterministicObjective,
      deterministic_external_model_calls: 0,
      deterministic_external_api_cost_usd: "0.00",
      full_human_quality_reviews: "AWAITING_200_RECORDS",
      human_calibration: humanCalibration.status,
      real_customer_dataset: realCustomerDataset.status,
      real_customer_case_count: realCustomerDataset.actual_case_count,
      real_customer_quality_score: realCustomerQualityComplete ? verifiedRealCustomerQuality.grader.weighted_score : "NOT_MEASURED",
      real_customer_human_calibration: realCustomerQualityComplete ? "CALIBRATED" : "AWAITING",
      verified_real_customer_quality: verifiedRealCustomerQuality,
      machine_source_candidate_ready: machineSourceReady,
      product_ready: productReady,
      rollback: rollbackAssertion,
    },
  },
  null,
  2,
));
if (machineSourceReady) {
  console.log("C3_FINAL_GATE|result=PASS|scope=preproduction_machine_source|human_review=AWAITING_INDEPENDENT_HUMAN_REVIEW");
} else if (!productReady) {
  console.error("C3_FINAL_GATE|result=STOP|reason=production_independent_quality_and_human_authorization_required|exit_code=78");
  process.exitCode = 78;
} else {
  console.log("C3_FINAL_GATE|result=PASS|scope=final_product_ready");
}
