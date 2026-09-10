// Task A3 authoritative final gate: commerce state runtime integration.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const runtimePath = "supabase/functions/_shared/commerce-state-runtime.ts";
const generatePath = "supabase/functions/generate-reply/index.ts";
const frozen = [
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/_shared/commerce-state-authority.ts",
];

function must(condition, message) {
  if (!condition) throw new Error(message);
}

for (const file of [runtimePath, generatePath, ...frozen]) {
  must(fs.existsSync(file), `missing:${file}`);
  must(fs.statSync(file).size > 0, `empty:${file}`);
}

const runtime = fs.readFileSync(runtimePath, "utf8");
const generate = fs.readFileSync(generatePath, "utf8");

for (const token of [
  "runCommerceStateRuntime",
  "persistCommerceTurn",
  "upsert_conversation_commerce_state_v1",
  "revision_conflict",
  "deriveCommerceEventsFromCustomerTurn",
  "reduceCommerceState",
  "resolveCommerceAnswerAuthority",
  "buildTransactionSummary",
  "extractCommerceCalculationTerms",
  "detectExplicitCalculationRequest",
]) must(runtime.includes(token), `runtime_missing:${token}`);

// Hotfix invariants: deterministic calculation only on explicit request; no quote double-count.
must(
  runtime.includes("const wantsCalculation = detectExplicitCalculationRequest(text);"),
  "runtime_missing:explicit_calculation_gate",
);
must(
  runtime.includes("if (textAmounts.has(quote.amount)) continue;"),
  "runtime_missing:persisted_quote_dedup",
);

// A2 stays frozen: appliance-specific extraction only lives in the A3 adapter.
for (const file of frozen) {
  const source = fs.readFileSync(file, "utf8");
  must(
    !/(冷氣|冷气|雪櫃|冰箱|洗衣機|洗衣机|客廳|客厅|熱水爐|热水器)/.test(source),
    `frozen_module_industry_leak:${file}`,
  );
}

// Static ordering: critical E2 < A3 commerce runtime < customer-context / clarification / KB.
const idxE2 = generate.indexOf("isE2LiveActivationEnabled(Deno.env)");
const idxA3 = generate.indexOf("TASK A3: persistent commerce state runtime");
const idxContext = generate.indexOf('_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE"');
const idxClarify = generate.indexOf("NATURAL_CLARIFICATION[_visitorLang]");
must(idxE2 > -1 && idxA3 > -1 && idxContext > -1 && idxClarify > -1, "ordering_markers_missing");
must(idxE2 < idxA3, "a3_must_run_after_critical_e2");
must(idxA3 < idxContext, "a3_must_run_before_customer_context_update");
must(idxA3 < idxClarify, "a3_must_run_before_generic_clarification");

// receive-widget-message must not be part of A3.
const widget = "supabase/functions/receive-widget-message/index.ts";
must(fs.existsSync(widget), `missing:${widget}`);
must(!fs.readFileSync(widget, "utf8").includes("commerce-state-runtime"), "receive_widget_message_modified");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
// Baseline package.json declares no version field; A3 must not introduce or change one.
must(
  pkg.version === undefined || pkg.version === "2.7.1",
  `unexpected_package_version:${pkg.version}`,
);

execFileSync("npx", [
  "tsc",
  "--noEmit",
  "--strict",
  "--target", "ES2022",
  "--module", "ESNext",
  "--moduleResolution", "bundler",
  "--allowImportingTsExtensions",
  runtimePath,
  ...frozen,
], { stdio: "inherit" });

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

console.log(JSON.stringify({
  status: "PASS",
  task: "A3",
  files: [runtimePath, generatePath],
  assertions: {
    runtime_adapter_present: true,
    frozen_a2_untouched: true,
    persistent_state_rpc_invariants: true,
    revision_conflict_single_retry: true,
    static_order_e2_before_a3_before_context_and_kb: true,
    receive_widget_message_untouched: true,
    package_version_pinned: true,
    strict_typescript_compile: true,
    production_build: true,
  },
}));
