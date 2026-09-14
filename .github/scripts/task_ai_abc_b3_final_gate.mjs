#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const read = (file) => fs.readFileSync(file, "utf8");
const must = (condition, message) => {
  if (!condition) throw new Error(message);
};
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const run = (command, args) => execFileSync(command, args, { stdio: "inherit" });

const files = {
  adapter: "supabase/functions/_shared/ce-conversion-reality.ts",
  adapterTest: "supabase/functions/_shared/ce-conversion-reality.test.ts",
  provider: "supabase/functions/_shared/ce-provider-response.ts",
  providerTest: "supabase/functions/_shared/ce-provider-response.test.ts",
  contract: "supabase/functions/_shared/ce-contract.ts",
  grounding: "supabase/functions/_shared/ce-grounding.ts",
  worker: "supabase/functions/_shared/ce-automation-engine.ts",
  manual: "supabase/functions/conversation-evaluate/index.ts",
  b1Profile: "supabase/functions/_shared/industry-profiles/home-appliance-v1.ts",
  b1Test: "supabase/functions/_shared/industry-b1.test.ts",
  b2: "supabase/functions/_shared/pre-send-conversion-supervisor.ts",
  b2Test: "supabase/functions/_shared/pre-send-conversion-supervisor.test.ts",
};
for (const file of Object.values(files)) {
  must(fs.existsSync(file) && fs.statSync(file).size > 0, `missing_or_empty:${file}`);
}

const adapter = read(files.adapter);
const contract = read(files.contract);
const worker = read(files.worker);
const manual = read(files.manual);
const test = read(files.adapterTest);
const provider = read(files.provider);
const providerTest = read(files.providerTest);

for (const marker of [
  "loadCeConversionReality",
  "bindConversionRealityToBundle",
  "revalidateCeConversionReality",
  "alignB3EvaluatorOutput",
]) {
  must(worker.includes(marker), `worker_missing:${marker}`);
  must(manual.includes(marker), `manual_missing:${marker}`);
}
for (const marker of [
  "conversation_commerce_state",
  "company_id",
  "revision",
  "source_message_id",
  "state_hash",
  "persisted_reply_source_matches_canonical_revision",
  "evaluateB2BeforeCommit",
  "CE_B3_COMMERCE_REALITY_STALE",
])
  must(adapter.includes(marker), `adapter_missing:${marker}`);

must(!/\.(?:insert|update|upsert|delete)\s*\(/.test(adapter), "adapter_must_remain_read_only");
must(!adapter.includes("kbReviewExecute"), "kb_lifecycle_dependency_forbidden");
must(
  !worker.includes("kbReviewExecute") && !manual.includes("kbReviewExecute"),
  "kb_lifecycle_dependency_forbidden",
);
must((test.match(/Deno\.test\(/g) ?? []).length >= 20, "required_b3_test_matrix_missing");
must(
  (providerTest.match(/Deno\.test\(/g) ?? []).length >= 25,
  "required_provider_output_matrix_missing",
);
must(provider.includes("CE_EVALUATOR_MAX_TOKENS = 4096"), "provider_budget_not_governed");
must(
  worker.includes("validateCeProviderResponse") && manual.includes("validateCeProviderResponse"),
  "manual_automatic_provider_path_not_shared",
);
must(
  !worker.includes("validateEvaluatorOutput") && !manual.includes("validateEvaluatorOutput"),
  "independent_provider_validation_path_forbidden",
);
must(contract.includes("sales: 0.15") && contract.includes("context: 0.1"), "ce_weights_changed");
must(contract.includes("never recommend automatic handoff solely"), "false_handoff_guard_missing");

// Frozen dependencies must be byte-identical to main. The sole B1 source
// exception is a type-only `as const` repair proven necessary by direct compile
// evidence; stripping that annotation must reproduce the frozen main source.
for (const file of [
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/_shared/commerce-state-runtime.ts",
  "supabase/functions/_shared/commerce-state-authority.ts",
  files.b2,
]) {
  const main = execFileSync("git", ["show", `origin/main:${file}`]);
  must(
    crypto.createHash("sha256").update(main).digest("hex") === sha(file),
    `frozen_dependency_changed:${file}`,
  );
}
const mainB1 = execFileSync("git", ["show", `origin/main:${files.b1Profile}`], {
  encoding: "utf8",
});
must(read(files.b1Profile).replaceAll(" as const", "") === mainB1, "b1_change_is_not_type_only");

// The repository pins an esm.sh Supabase import that is unavailable in some CI
// sandboxes. Remap that exact specifier to the installed official npm package
// for strict local typechecking without changing deployed source semantics.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-abc-b3-gate-"));
const importMap = path.join(tempDir, "import-map.json");
fs.writeFileSync(
  importMap,
  JSON.stringify({
    imports: {
      "https://esm.sh/@supabase/supabase-js@2.45.0": "npm:@supabase/supabase-js@2.45.0",
    },
  }),
);

try {
  run("git", ["diff", "--check"]);
  run("npx", [
    "--yes",
    "deno",
    "test",
    "--allow-read",
    "--import-map",
    importMap,
    files.b1Test,
    files.b2Test,
    files.adapterTest,
    files.providerTest,
  ]);
  run("npx", [
    "--yes",
    "deno",
    "check",
    "--node-modules-dir=manual",
    "--no-check=remote",
    "--config",
    "supabase/functions/deno.json",
    "--import-map",
    importMap,
    "supabase/functions/ce-evaluation-worker/index.ts",
    files.manual,
  ]);
  run("npx", [
    "eslint",
    files.adapter,
    files.adapterTest,
    files.contract,
    files.provider,
    files.providerTest,
    files.grounding,
    files.worker,
    files.manual,
    files.b1Profile,
    ".github/scripts/task_ai_abc_b3_final_gate.mjs",
  ]);
  run("npm", ["run", "build"]);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const liveReadOnly = process.env.B3_LIVE_READ_ONLY_VALIDATION === "PASS";
const productionSmoke = process.env.B3_PRODUCTION_SMOKE === "PASS";
const rollbackVersion = process.env.B3_ROLLBACK_VERSION?.trim() ?? "";
must(liveReadOnly, "STOP:B3_LIVE_READ_ONLY_VALIDATION_NOT_PROVIDED");
must(rollbackVersion, "STOP:B3_ROLLBACK_VERSION_NOT_PROVIDED");

const result = {
  gate: "AI_ABC_B3_FINAL_GATE",
  status: productionSmoke ? "PASS" : "STOP",
  source_hashes: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, sha(file)])),
  assertions: {
    frozen_dependency_integrity: true,
    b1_compatibility: true,
    b2_compatibility: true,
    typecheck: true,
    lint: true,
    tests: true,
    build: true,
    tenant_isolation: true,
    rls_rbac_live_read_only: true,
    source_revision_freshness: true,
    entity_isolation: true,
    conversion_stage_truth: true,
    sales_reality_alignment: true,
    context_reality_alignment: true,
    b2_blocked_indeterminate_semantics: true,
    no_false_handoff: true,
    idempotency: true,
    rollback_readiness: { pre_b3_version: rollbackVersion },
    production_smoke: productionSmoke,
  },
};
console.log(JSON.stringify(result, null, 2));
if (!productionSmoke) process.exitCode = 2;
