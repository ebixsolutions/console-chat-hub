import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const files = [
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/_shared/commerce-state-authority.ts",
  ".github/scripts/task_a2_commerce_reducer_authority_test.ts",
];

function must(condition, message) {
  if (!condition) throw new Error(message);
}

for (const file of files) {
  must(fs.existsSync(file), `missing:${file}`);
  must(fs.statSync(file).size > 0, `empty:${file}`);
}

const reducer = fs.readFileSync(files[1], "utf8");
const authority = fs.readFileSync(files[2], "utf8");
const test = fs.readFileSync(files[3], "utf8");

for (const token of [
  "ENSURE_ENTITY",
  "SET_ENTITY_QUANTITY",
  "SET_ENTITY_STATUS",
  "SET_ENTITY_CONSTRAINT",
  "REMOVE_ENTITY_CONSTRAINT",
  "ADD_QUOTE",
  "SET_DELIVERY",
  "SET_CONVERSION",
  "deriveCommerceEventsFromCustomerTurn",
]) must(reducer.includes(token), `reducer_missing:${token}`);

for (const token of [
  "CONVERSATION_STATE",
  "DETERMINISTIC_CALCULATION",
  "CURRENT_KB_REQUIRED",
  "SAFE_PROFESSIONAL_CONFIRMATION",
  "INSUFFICIENT_INFORMATION",
  "resolveCommerceAnswerAuthority",
]) must(authority.includes(token), `authority_missing:${token}`);

must(!/(冷氣|冷气|雪櫃|冰箱|洗衣機|洗衣机|fashion|beauty|restaurant)/i.test(reducer), "industry_specific_reducer_leak");
must(!/(冷氣|冷气|雪櫃|冰箱|洗衣機|洗衣机|fashion|beauty|restaurant)/i.test(authority), "industry_specific_authority_leak");
must(test.includes("ensure_entity_no_reset"), "no_reset_assertion_missing");
must(test.includes("deterministic_calculation"), "calculation_assertion_missing");
must(test.includes("quote_provenance_preserved"), "quote_provenance_assertion_missing");
must(test.includes("quotation_not_order"), "transaction_state_assertion_missing");

execFileSync("npx", [
  "tsc",
  "--noEmit",
  "--strict",
  "--target", "ES2022",
  "--module", "ESNext",
  "--moduleResolution", "bundler",
  "--allowImportingTsExtensions",
  ...files,
], { stdio: "inherit" });

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-a2-"));
try {
  execFileSync("npx", [
    "tsc",
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--rewriteRelativeImportExtensions",
    "--outDir", outDir,
    ...files,
  ], { stdio: "inherit" });

  execFileSync(
    "node",
    [path.join(outDir, ".github/scripts/task_a2_commerce_reducer_authority_test.js")],
    { stdio: "inherit" },
  );
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}

execFileSync("npm", ["run", "build"], { stdio: "inherit" });

console.log(JSON.stringify({
  status: "PASS",
  task: "A2",
  assertions: {
    strict_typescript_compile: true,
    reducer_behavior: true,
    latest_value_wins: true,
    ensure_entity_no_reset: true,
    cancellation_reconciliation: true,
    quote_provenance: true,
    cross_industry_state: true,
    authority_hierarchy: true,
    deterministic_calculation: true,
    current_kb_routing: true,
    safe_professional_confirmation: true,
    production_build: true,
  },
}));
