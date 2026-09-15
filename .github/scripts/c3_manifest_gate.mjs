#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const getArg = (name, fallback = "") => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);
const repo = path.resolve(getArg("--repo", process.cwd()));
const tempDir = path.resolve(getArg("--temp", process.env.RUNNER_TEMP || "/tmp"));
const expectedGenerate = Number(getArg("--expected-generate", "47"));
const expectedAssist = Number(getArg("--expected-assist", "22"));
const diagnostic = has("--diagnostic");
fs.mkdirSync(tempDir, { recursive: true });

const assertLine = (name, expected, actual, ok, detail = "") => {
  console.log(`C3_MANIFEST_ASSERT|name=${name}|expected=${expected}|actual=${actual}|result=${ok ? "PASS" : "FAIL"}${detail ? `|detail=${detail}` : ""}`);
  if (!ok && !diagnostic) process.exitCode = 1;
  return ok;
};
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const rel = (p) => path.relative(repo, p).split(path.sep).join("/");
const importRx = /(?:from\s*|import\s*\()\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;

function buildClosure(entryRel, label, outFile) {
  const root = repo;
  const entry = path.resolve(root, entryRel);
  const seen = new Set();
  const stack = [entry];
  let unresolved = 0, escapes = 0, missing = 0, empty = 0;
  const unresolvedItems = [], escapeItems = [], missingItems = [], emptyItems = [];

  while (stack.length) {
    const p = path.resolve(stack.pop());
    if (seen.has(p)) continue;
    if (!p.startsWith(root + path.sep) && p !== root) {
      escapes++; escapeItems.push(p); continue;
    }
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
      missing++; missingItems.push(rel(p)); continue;
    }
    const data = fs.readFileSync(p);
    if (data.length === 0) { empty++; emptyItems.push(rel(p)); }
    seen.add(p);
    const text = data.toString("utf8");
    for (const m of text.matchAll(importRx)) {
      const spec = m[1] || m[2];
      if (!spec?.startsWith(".")) continue;
      const q = path.resolve(path.dirname(p), spec);
      const candidates = path.extname(q) ? [q] : [q, `${q}.ts`, path.join(q, "index.ts")];
      const target = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (!target) { unresolved++; unresolvedItems.push(`${rel(p)}=>${spec}`); continue; }
      if (!target.startsWith(root + path.sep) && target !== root) { escapes++; escapeItems.push(target); continue; }
      stack.push(target);
    }
  }

  const rows = [...seen].map((p) => ({ path: rel(p), sha256: sha256(fs.readFileSync(p)) }))
    .sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const duplicateCount = rows.length - new Set(rows.map((r) => r.path)).size;
  const serialized = rows.map((r) => `${r.sha256}  ${r.path}\n`).join("");
  fs.writeFileSync(outFile, serialized, "utf8");

  assertLine(`${label}_closure_discovery`, "success", missing + unresolved + escapes === 0 ? "success" : "error", missing + unresolved + escapes === 0);
  assertLine(`${label}_file_count`, label === "generate" ? expectedGenerate : expectedAssist, rows.length, rows.length === (label === "generate" ? expectedGenerate : expectedAssist));
  assertLine(`${label}_duplicate_paths`, 0, duplicateCount, duplicateCount === 0);
  assertLine(`${label}_missing_files`, 0, missing, missing === 0, missingItems.slice(0,5).join(","));
  assertLine(`${label}_empty_files`, 0, empty, empty === 0, emptyItems.slice(0,5).join(","));
  assertLine(`${label}_unresolved_dependencies`, 0, unresolved, unresolved === 0, unresolvedItems.slice(0,5).join(","));
  assertLine(`${label}_root_escapes`, 0, escapes, escapes === 0, escapeItems.slice(0,5).join(","));

  let shaMismatch = 0;
  for (const r of rows) {
    const p = path.join(root, r.path);
    if (!fs.existsSync(p) || sha256(fs.readFileSync(p)) !== r.sha256) shaMismatch++;
  }
  assertLine(`${label}_per_file_sha_recompute`, 0, shaMismatch, shaMismatch === 0);
  assertLine(`${label}_manifest_parse`, rows.length, serialized.trim() ? serialized.trim().split("\n").length : 0, rows.length === (serialized.trim() ? serialized.trim().split("\n").length : 0));
  return { rows, serialized, digest: sha256(Buffer.from(serialized)) };
}

function runDeno(entryRel, label) {
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  console.log(`C3_DENO_STATUS|phase=${label}_before|porcelain=${JSON.stringify(before.trim().split("\n").filter(Boolean))}`);
  const r = spawnSync("deno", ["check", "--no-lock", "--node-modules-dir=auto", entryRel], { cwd: repo, encoding: "utf8", stdio: "inherit" });
  assertLine(`${label}_deno_check_exit`, 0, r.status ?? -1, r.status === 0);
  const after = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
  const tracked = execFileSync("git", ["diff", "--name-only"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  console.log(`C3_DENO_STATUS|phase=${label}_after|porcelain=${JSON.stringify(after.trim().split("\n").filter(Boolean))}`);
  assertLine(`${label}_tracked_modified_deleted`, 0, tracked.length, tracked.length === 0, tracked.join(","));
  assertLine(`${label}_staged_added_modified_deleted`, 0, staged.length, staged.length === 0, staged.join(","));
  assertLine(`${label}_unauthorized_untracked_source`, 0, untracked.length, untracked.length === 0, untracked.join(","));
  return { tracked, staged, untracked };
}

const genAPath = path.join(tempDir, "generate-A.sha256");
const genBPath = path.join(tempDir, "generate-B.sha256");
const assistAPath = path.join(tempDir, "assist-A.sha256");
const assistBPath = path.join(tempDir, "assist-B.sha256");

const genA = buildClosure("supabase/functions/generate-reply/index.ts", "generate", genAPath);
const genB = buildClosure("supabase/functions/generate-reply/index.ts", "generate_rerun", genBPath);
const assistA = buildClosure("supabase/functions/agent-assist/index.ts", "assist", assistAPath);
const assistB = buildClosure("supabase/functions/agent-assist/index.ts", "assist_rerun", assistBPath);

assertLine("generate_manifest_deterministic", genA.digest, genB.digest, genA.digest === genB.digest);
assertLine("assist_manifest_deterministic", assistA.digest, assistB.digest, assistA.digest === assistB.digest);
assertLine("generated_output_outside_checkout", "true", String(!tempDir.startsWith(repo + path.sep)), !tempDir.startsWith(repo + path.sep), tempDir);

runDeno("supabase/functions/generate-reply/index.ts", "generate");
runDeno("supabase/functions/agent-assist/index.ts", "assist");

const tracked = execFileSync("git", ["diff", "--name-only"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8" }).trim().split("\n").filter(Boolean);
assertLine("source_tracked_modified_deleted", 0, tracked.length, tracked.length === 0, tracked.join(","));
assertLine("source_tracked_staged", 0, staged.length, staged.length === 0, staged.join(","));
assertLine("source_unauthorized_untracked", 0, untracked.length, untracked.length === 0, untracked.join(","));

console.log(`C3_MANIFEST_SUMMARY|generate_count=${genA.rows.length}|assist_count=${assistA.rows.length}|generate_manifest_sha256=${genA.digest}|assist_manifest_sha256=${assistA.digest}|result=${process.exitCode ? "FAIL" : "PASS"}`);
if (diagnostic) process.exitCode = 0;
