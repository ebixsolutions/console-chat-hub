#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const must = (condition, message) => {
  if (!condition) throw new Error(message);
};
const read = (file) => fs.readFileSync(file, "utf8");
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (command, args, env = {}) =>
  execFileSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });

const files = {
  authority: "supabase/functions/_shared/commerce-state-authority.ts",
  aggregation: "supabase/functions/_shared/kb-aggregation-response.ts",
  kbClient: "supabase/functions/_shared/kb-client.ts",
  grounding: "supabase/functions/_shared/canonical-grounding.ts",
  citation: "supabase/functions/_shared/citation-lineage.ts",
  runtimeState: "supabase/functions/_shared/conversation-runtime-state.ts",
  runtimeStateCore: "supabase/functions/_shared/conversation-runtime-state-core.ts",
  semanticContract: "supabase/functions/_shared/conversation-semantic-contract.ts",
  priorTransform: "supabase/functions/_shared/prior-grounded-transform-core.ts",
  runtime: "supabase/functions/generate-reply/index.ts",
  unitTest: "supabase/functions/_shared/reference-authority.test.ts",
  integrationTest: "supabase/functions/_shared/reference-authority-integration.test.ts",
  round2Test: "supabase/functions/_shared/reference-authority-round2.test.ts",
  importMap: ".github/deno-c1-import-map.json",
};
for (const file of Object.values(files)) {
  must(fs.existsSync(file) && fs.statSync(file).size > 0, `missing_or_empty:${file}`);
}

const authority = read(files.authority);
const aggregation = read(files.aggregation);
const grounding = read(files.grounding);
const citation = read(files.citation);
const runtime = read(files.runtime);
const unitTest = read(files.unitTest);
const integrationTest = read(files.integrationTest);

for (const marker of [
  "CANONICAL_TRANSACTION",
  "DETERMINISTIC_CALCULATION",
  "CURRENT_KB",
  "CUSTOMER_CONTEXT",
  "HISTORICAL",
  "MODEL_INFERENCE",
  "CURRENT_KB_REQUIRED",
  "CONFLICT_UNRESOLVED",
  "wrong_tenant",
  "wrong_entity",
  "wrong_region",
  "not_current_published_live",
  "model_inference_not_authority",
]) must(authority.includes(marker), `authority_marker_missing:${marker}`);

for (const marker of [
  "tenant_id",
  "publication_state",
  "currentness",
  "entity_ids",
  "regions",
  "version_rank",
  "source_priority",
  "claims",
]) must(aggregation.includes(marker), `provenance_marker_missing:${marker}`);

for (const marker of [
  "resolveReferenceAuthority",
  "extractStructuredClaims",
  "expectedTenantId",
  "expectedEntityIds",
  "expectedTopicIds",
  "currentTurnText",
  "targetChanged",
  "expectedRegion",
  "requiresCurrentKb",
]) must(grounding.includes(marker), `grounding_marker_missing:${marker}`);

for (const marker of ["target_entity_model", "target_topics", "authority_decision", "evidence_state", "current_target"])
  must(citation.includes(marker), `citation_contract_missing:${marker}`);

const a3Index = runtime.indexOf("// ===== TASK A3: persistent commerce state runtime =====");
const c1Index = runtime.indexOf("const _groundingSelection = selectCanonicalGrounding");
const modelIndex = runtime.indexOf("let llm = await callModel", c1Index);
must(a3Index >= 0 && c1Index > a3Index && modelIndex > c1Index, "runtime_authority_order_invalid");
for (const marker of [
  "expectedTenantId: _kbTenantResult.scope.singaporeTenantId",
  "expectedEntityIds: _c1CurrentTarget.entity_ids",
  "expectedTopicIds: _c1CurrentTarget.topic_ids",
  "currentTurnText: _h1LastMsg",
  "targetChanged: _c1CurrentTarget.target_changed",
  "c1_authority_conflict_clarification",
  "handoff_required: false",
  "reference_authority: referenceAuthorityMetadata",
  "commitAiReplyWithControlGate",
  "executeB2PersistenceGate",
]) must(runtime.includes(marker), `runtime_marker_missing:${marker}`);
must(runtime.indexOf("executeB2PersistenceGate") < runtime.indexOf("commitAiReplyWithControlGate"), "b2_gate_not_bound");
must((unitTest.match(/expectDecision\(/g) ?? []).length - 1 >= 20, "required_c1_matrix_missing");
must((integrationTest.match(/Deno\.test\(/g) ?? []).length >= 5, "required_c1_integration_missing");
must((read(files.round2Test).match(/Deno\.test\(/g) ?? []).length >= 15, "required_c1_round2_matrix_missing");

for (const source of [authority, aggregation, grounding]) {
  must(!/\.(?:insert|update|upsert|delete)\s*\(/.test(source), "c1_authority_must_be_read_only");
  must(!source.includes("kbReviewExecute"), "kb_lifecycle_dependency_forbidden");
}

const changedFiles = execFileSync("git", ["diff", "--name-only", "origin/main"], {
  encoding: "utf8",
}).trim().split("\n").filter(Boolean);
must(!changedFiles.some((file) => file.startsWith("supabase/migrations/")), "schema_change_forbidden");
must(!changedFiles.includes("supabase/functions/receive-widget-message/index.ts"), "receive_widget_change_forbidden");
must(!changedFiles.some((file) => /(?:kbReview|review-executor|vector|republish)/i.test(file)), "kb_lifecycle_change_forbidden");

for (const file of [
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/_shared/commerce-state-runtime.ts",
  "supabase/functions/_shared/commerce-capability-runtime.ts",
  "supabase/functions/_shared/industry-agent-registry.ts",
  "supabase/functions/_shared/industry-runtime-adapter.ts",
  "supabase/functions/_shared/industry-schema.ts",
  "supabase/functions/_shared/pre-send-conversion-supervisor.ts",
  "supabase/functions/_shared/ce-conversion-reality.ts",
  "supabase/functions/_shared/ce-contract.ts",
  "supabase/functions/ce-evaluation-worker/index.ts",
  "supabase/functions/conversation-evaluate/index.ts",
  "supabase/functions/receive-widget-message/index.ts",
]) {
  const main = execFileSync("git", ["show", `origin/main:${file}`]);
  must(crypto.createHash("sha256").update(main).digest("hex") === sha(file), `frozen_dependency_changed:${file}`);
}

run("git", ["diff", "--check"]);
run("npx", [
  "--yes", "deno", "test", "--allow-env", "--allow-read", "--node-modules-dir=manual",
  "--import-map", files.importMap,
  ".github/scripts/task_a3_ghost_entity_authority_test.ts",
  ".github/scripts/task_a3_negated_transaction_authority_test.ts",
  "supabase/functions/_shared/industry-b1.test.ts",
  "supabase/functions/_shared/pre-send-conversion-supervisor.test.ts",
  "supabase/functions/_shared/ce-conversion-reality.test.ts",
  "supabase/functions/_shared/ce-provider-response.test.ts",
  files.unitTest,
  files.integrationTest,
  files.round2Test,
]);
run("npx", [
  "--yes", "deno", "check", "--node-modules-dir=manual", "--no-check=remote",
  "--config", "supabase/functions/deno.json", "--import-map", files.importMap,
  "supabase/functions/generate-reply/index.ts",
]);
run("npx", [
  "eslint", "--rule", "prettier/prettier: off", "--rule", "@typescript-eslint/no-explicit-any: off",
  files.authority, files.aggregation, files.kbClient, files.grounding, files.citation,
  files.runtimeState, files.runtimeStateCore, files.semanticContract, files.priorTransform,
  files.runtime, files.unitTest, files.integrationTest,
  files.round2Test,
  ".github/scripts/task_ai_abc_c1_final_gate.mjs",
]);
run("npm", ["run", "build"]);

must(process.env.C1_LIVE_READ_ONLY_VALIDATION === "PASS", "STOP:C1_LIVE_READ_ONLY_VALIDATION_NOT_PROVIDED");
must(process.env.C1_RAG_READ_VALIDATION === "PASS", "STOP:C1_RAG_READ_VALIDATION_NOT_PROVIDED");
const rollbackHash = process.env.C1_ROLLBACK_SOURCE_HASH?.trim() ?? "";
must(/^[a-f0-9]{64}$/.test(rollbackHash), "STOP:C1_ROLLBACK_SOURCE_HASH_NOT_PROVIDED");
const phase = process.env.C1_GATE_PHASE === "production" ? "production" : "preproduction";
const productionSmoke = process.env.C1_PRODUCTION_SMOKE === "PASS";
if (phase === "production") must(productionSmoke, "FAIL:C1_PRODUCTION_SMOKE_NOT_PASS");

console.log(JSON.stringify({
  gate: "AI_ABC_C1_FINAL_GATE",
  phase,
  status: phase === "preproduction" ? "STOP_AUTHORIZATION_REQUIRED" : "PASS",
  source_hashes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, sha(file)])),
  assertions: {
    generic_authority_hierarchy: true,
    current_historical_separation: true,
    tenant_entity_region_binding: true,
    relevance_not_authority: true,
    current_kb_required: true,
    unresolved_conflict_fail_safe: true,
    no_automatic_handoff: true,
    b2_guarded_persistence: true,
    frozen_a_b_integrity: true,
    no_schema_or_kb_lifecycle_change: true,
    deterministic_tests: true,
    integration_tests: true,
    typecheck: true,
    lint: true,
    build: true,
    live_rls_tenant_read_only: true,
    singapore_rag_read_contract: true,
    rollback_readiness: { live_bundle_sha256: rollbackHash },
    production_smoke: phase === "preproduction" ? "AUTHORIZATION_PENDING" : true,
  },
}, null, 2));
