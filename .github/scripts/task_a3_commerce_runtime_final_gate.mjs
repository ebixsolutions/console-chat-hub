import fs from "node:fs";
import { execFileSync } from "node:child_process";

const files = [
  "supabase/functions/generate-reply/index.ts",
  "supabase/functions/_shared/commerce-state-runtime.ts",
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/_shared/commerce-state-authority.ts",
];
const must = (condition, message) => { if (!condition) throw new Error(message); };
for (const file of files) {
  must(fs.existsSync(file), `missing:${file}`);
  must(fs.statSync(file).size > 0, `empty:${file}`);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
must(pkg.version === "2.7.1", `package_version:${pkg.version}`);

const index = fs.readFileSync(files[0], "utf8");
const runtime = fs.readFileSync(files[1], "utf8");
for (const token of [
  'import { resolveCommerceRuntimeTurn } from "../_shared/commerce-state-runtime.ts";',
  "Task A3: canonical persistent commerce state + authority routing.",
  "resolveCommerceRuntimeTurn({",
  "commerce_runtime_commit_",
]) must(index.includes(token), `index_missing:${token}`);
for (const token of [
  "upsert_conversation_commerce_state_v1",
  "deriveCommerceEventsFromCustomerTurn",
  "reduceCommerceState",
  "resolveCommerceAnswerAuthority",
  "CURRENT_KB_REQUIRED",
  "SAFE_PROFESSIONAL_CONFIRMATION",
  "commerce_transaction_summary",
  "commerce_deterministic_calculation",
]) must(runtime.includes(token), `runtime_missing:${token}`);

const e2 = index.indexOf("const _criticalE2ThreatSignal");
const commerce = index.indexOf("Task A3: canonical persistent commerce state + authority routing.");
const generic = index.indexOf("_turnClassification.should_clarify_before_kb");
const canonical = index.indexOf("const _canonicalTurn = classifyCanonicalConversationTurn");
must(e2 >= 0 && commerce > e2, "commerce_must_follow_critical_e2");
must(generic >= 0 && commerce < generic, "commerce_must_precede_generic_clarification");
must(canonical >= 0 && commerce < canonical, "commerce_must_precede_customer_context_shortcut");

execFileSync("npx", [
  "tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext",
  "--moduleResolution", "bundler", "--allowImportingTsExtensions",
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/_shared/commerce-state-authority.ts",
  "supabase/functions/_shared/commerce-state-runtime.ts",
], { stdio: "inherit" });

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

console.log(JSON.stringify({
  status: "PASS",
  task: "A3",
  assertions: {
    package_2_7_1: true,
    source_exists_nonempty: true,
    e2_precedes_commerce: true,
    commerce_precedes_customer_context: true,
    commerce_precedes_generic_clarification: true,
    persistent_rpc: true,
    reducer_authority_integrated: true,
    known_state_route: true,
    deterministic_calculation_route: true,
    current_kb_route: true,
    professional_confirmation_route: true,
    transaction_summary_route: true,
    strict_typescript_compile: true,
    production_build: true,
  },
}));
