#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { runtimeDependencyClosure } from "./c3_module_graph.mjs";

import {verifyProductionSource, PROFILE_PATH} from './c3_unified_production_source_gate.mjs';
import {existsSync} from 'node:fs';
const unifiedProfile = existsSync(PROFILE_PATH) ? JSON.parse(readFileSync(PROFILE_PATH,'utf8')) : null;
const historicalContract = JSON.parse(readFileSync(".github/scripts/c3_director_candidate_scope.json", "utf8"));
const contract = unifiedProfile ? {baseline_head:unifiedProfile.baseline.head,baseline_tree:unifiedProfile.baseline.tree,changed_files:execFileSync('git',['diff','--name-only',unifiedProfile.baseline.head,'HEAD'],{encoding:'utf8'}).trim().split('\n').filter(Boolean)} : historicalContract;
if(unifiedProfile) verifyProductionSource({expectedIdentity:{head:process.env.GITHUB_SHA||execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim()}});
const baseline = contract.baseline_head;
const baselineTree = contract.baseline_tree;
const scope = contract.changed_files;
if (!unifiedProfile && (baseline !== "bc00aed2516607198a146fecd767828892e102f3" ||
    baselineTree !== "5e9e09d8007d1e73f6e90b85c3f922feacef61f0" ||
    new Set(scope).size !== scope.length || !scope.includes(".github/scripts/c3_director_candidate_scope.json"))) {
  throw new Error("C3_DIRECTOR_GATE|invalid_exact_baseline_or_scope_contract");
}
function git(...args) { return execFileSync("git", args, { encoding: "utf8", timeout: 15000 }).trim(); }
function fail(code, detail = "") { throw new Error(`C3_DIRECTOR_GATE|${code}|${detail}`); }
function sha(data) { return createHash("sha256").update(data).digest("hex"); }
function unapprovedWorkingTree() {
  // supabase/setup-cli creates precisely this ephemeral CLI discovery file.
  return git("status", "--porcelain", "--untracked-files=all").split("\n")
    .filter((row) => row && row !== "?? supabase/.temp/cli-latest");
}
if (git("rev-parse", `${baseline}^{tree}`) !== baselineTree) fail("baseline_tree_mismatch");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "director/ai-abc-c3-long-memory-final-cutover" && !process.env.CI) fail("branch_mismatch");
if (git("merge-base", baseline, "HEAD") !== baseline) fail("candidate_not_descended_from_baseline");
if (unapprovedWorkingTree().length) fail("uncommitted_candidate", JSON.stringify(unapprovedWorkingTree()));
const changed = git("diff", "--name-only", baseline, "HEAD").split("\n").filter(Boolean).sort();
if (JSON.stringify(changed) !== JSON.stringify([...scope].sort())) fail("changed_file_scope", JSON.stringify(changed));
const sourceHashes = {};
for (const file of scope) {
  let bytes;
  try { bytes = readFileSync(file); if (!statSync(file).size) fail("empty_file", file); }
  catch { fail("missing_file", file); }
  const committed = execFileSync("git", ["show", `HEAD:${file}`], { timeout: 15000 });
  if (!bytes.equals(committed)) fail("head_bytes_mismatch", file);
  sourceHashes[file] = sha(bytes);
}
for (const file of [
  "supabase/functions/_shared/commerce-state-contract.ts",
  "supabase/functions/_shared/commerce-state-reducer.ts",
  "supabase/functions/receive-widget-message/index.ts",
  "supabase/functions/agent-assist/index.ts",
]) {
  let frozenBytes = readFileSync(file);
  if (!unifiedProfile && file === "supabase/functions/_shared/commerce-state-reducer.ts") {
    // The reproduced generic quantity assignment opens only this operator
    // vocabulary. Every other reducer byte retains the frozen comparison.
    const current = frozenBytes.toString("utf8");
    const operator = String.raw`(?:改為|改为|改成|改做|change\s+to|set\s+to|係|是|=|:|：)?`;
    if (current.split(operator).length !== 2) fail("quantity_assignment_delta_missing_or_repeated", file);
    frozenBytes = Buffer.from(current.replace(operator, "(?:係|是|=|:|：)?"));
  }
  if (sha(frozenBytes) !== sha(execFileSync("git", ["show", `${baseline}:${file}`]))) fail("frozen_source_drift", file);
}
const closure = runtimeDependencyClosure({ root: process.cwd(), entrypoints: [
  "supabase/functions/generate-reply/index.ts",
  "supabase/functions/agent-assist/index.ts",
] });
if (!closure.includes("supabase/functions/_shared/commerce-state-runtime-base.ts") ||
    !closure.includes("supabase/functions/_shared/transaction-closure-handoff.ts")) fail("runtime_dependency_missing");
console.log(JSON.stringify({ assertion: "candidate_identity", head: git("rev-parse", "HEAD"),
  tree: git("rev-parse", "HEAD^{tree}"), changed, sourceHashes, runtime_file_count: closure.length }));

const commands = [
  ["git", ["diff", "--check", baseline, "HEAD"]],
  ["deno", ["test", "--no-lock", "--allow-read", "--node-modules-dir=manual", "supabase/functions/_shared/natural-dialogue-generic-core.test.ts",
    "tests/edge/verified-widget-auth.test.ts"]],
  ["deno", ["test", "--no-lock", "--allow-read", "--node-modules-dir=manual", "supabase/functions/_shared/contextual-customer-update.test.ts"]],
  ["deno", ["test", "--no-lock", "--allow-read", "--node-modules-dir=manual", "supabase/functions/_shared/conversation-recall.integration.test.ts",
    "supabase/functions/_shared/transaction-closure-handoff.test.ts",
    "supabase/functions/_shared/pre-send-conversion-supervisor.test.ts"]],
  ["node", [".github/scripts/task_a2_commerce_reducer_authority_final_gate.mjs"]],
  ["./node_modules/.bin/tsc", ["--noEmit", "--project", "tsconfig.json"]],
  ["npm", ["run", "build"]],
];
for (const [cmd, args] of commands) {
  const result = spawnSync(cmd, args, { stdio: "inherit", timeout: 240000,
    env: { ...process.env, CI: "true" } });
  console.log(JSON.stringify({ command: [cmd, ...args], exit_code: result.status, signal: result.signal }));
  if (result.status !== 0) fail("command_failed", [cmd, ...args].join(" "));
}
// The existing C3 preproduction gate requires a separate historical live
// readback contract. Its same-head CI job must succeed before this isolated
// job starts; never forge the readback markers inside a credential-free job.
if (process.env.CI) {
  if (process.env.C3_EXISTING_C3_PREPRODUCTION_RESULT !== "success" ||
      process.env.GITHUB_SHA !== git("rev-parse", "HEAD") ||
      !process.env.GITHUB_RUN_ID) fail("existing_c3_exact_candidate_job_missing");
  console.log(JSON.stringify({ assertion: "existing_c3_exact_candidate_job",
    result: "PASS", head: process.env.GITHUB_SHA,
    run_id: process.env.GITHUB_RUN_ID, dependency: "c3-preproduction" }));
} else {
  const priorC3 = spawnSync("node", [".github/scripts/task_ai_abc_c3_final_gate.mjs"],
    { stdio: "inherit", timeout: 240000, env: process.env });
  console.log(JSON.stringify({ command: "existing C3 preproduction gate", exit_code: priorC3.status }));
  if (priorC3.status !== 0) fail("existing_c3_gate_failed");
}
// Vite regenerates a tracked route tree even without route changes.
const committedRouteTree = execFileSync("git", ["show", "HEAD:src/routeTree.gen.ts"]);
if (!readFileSync("src/routeTree.gen.ts").equals(committedRouteTree)) {
  writeFileSync("src/routeTree.gen.ts", committedRouteTree);
}
const dbUrl = process.env.C3_ISOLATED_DB_URL || "";
if (!/^postgres(?:ql)?:\/\/[^\s]*@(?:127\.0\.0\.1|localhost):(?:5432|54322)\//.test(dbUrl)) fail("isolated_database_missing");
const sql = spawnSync("psql", [dbUrl, "-X", "-v", "ON_ERROR_STOP=1", "-f",
  "sql/c3-nonproduction/06_director_handoff_runtime_test.sql"], { stdio: "inherit", timeout: 240000 });
console.log(JSON.stringify({ command: "isolated psql handoff forward/trigger/rollback", exit_code: sql.status, signal: sql.signal }));
if (sql.status !== 0) fail("isolated_sql_runtime_failed");
// The browser test must exercise issued Auth sessions and the actual UI/API route.
// A missing runner is an error: no helper mock may replace this boundary.
const browser = spawnSync("bash", ["tests/e2e/c3_widget_isolated_setup.sh"], {
  stdio: "inherit", timeout: 1200000, env: process.env,
});
console.log(JSON.stringify({ command: "isolated Widget browser Auth end-to-end", exit_code: browser.status, signal: browser.signal }));
if (browser.status !== 0) fail("isolated_widget_auth_failed");
// The browser harness starts Vite dev, which regenerates the tracked route
// tree after the earlier build-time normalization. Restore only those
// generated bytes; the final status check still rejects every other change.
if (!readFileSync("src/routeTree.gen.ts").equals(committedRouteTree)) {
  writeFileSync("src/routeTree.gen.ts", committedRouteTree);
}
if (unapprovedWorkingTree().length) fail("post_gate_source_dirty", JSON.stringify(unapprovedWorkingTree()));
console.log(`C3_DIRECTOR_GENERIC_CORE_FINAL_GATE|result=PASS|head=${git("rev-parse", "HEAD")}|tree=${git("rev-parse", "HEAD^{tree}")}`);
