#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runtimeDependencyClosure } from "./c3_module_graph.mjs";

export const GENERATE_REPLY_RUNTIME_ROOT =
  "supabase/functions/generate-reply/index.ts";
const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

function normalizeRepoPath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.startsWith("functions/")) return "supabase/" + normalized;
  if (normalized.startsWith("_shared/") || normalized.startsWith("generate-reply/")) {
    return "supabase/functions/" + normalized;
  }
  return normalized;
}

function asActualEntry(item) {
  if (typeof item === "string") return { path: normalizeRepoPath(item) };
  if (!item || typeof item.path !== "string") {
    throw new Error("runtime_actual_entry_invalid");
  }
  return {
    path: normalizeRepoPath(item.path),
    ...(typeof item.sha256 === "string" ? { sha256: item.sha256 } : {}),
  };
}

/**
 * Separates source/governance coverage from deployable runtime dependency closure.
 * deployedFiles is the exact downloaded runtime manifest (paths and optional hashes).
 */
export function buildRuntimeParityReport({
  root = process.cwd(),
  entrypoint = GENERATE_REPLY_RUNTIME_ROOT,
  deployedFiles,
  sourceScopeFiles = [],
} = {}) {
  if (!Array.isArray(deployedFiles)) {
    throw new Error("runtime_actual_manifest_required");
  }
  if (!Array.isArray(sourceScopeFiles)) {
    throw new Error("source_scope_manifest_invalid");
  }

  const runtimeExpected = runtimeDependencyClosure({
    root,
    entrypoints: [entrypoint],
  }).map(normalizeRepoPath).sort();
  const expectedSet = new Set(runtimeExpected);
  const expectedHashes = new Map(
    runtimeExpected.map((file) => [
      file,
      sha256(fs.readFileSync(path.resolve(root, file))),
    ]),
  );

  const actualEntries = deployedFiles.map(asActualEntry);
  const actualCounts = new Map();
  for (const entry of actualEntries) {
    actualCounts.set(entry.path, (actualCounts.get(entry.path) ?? 0) + 1);
  }
  const runtimeActual = [...actualCounts.keys()].sort();
  const duplicateActual = [...actualCounts]
    .filter(([, count]) => count !== 1)
    .map(([file]) => file)
    .sort();
  const actualHashes = new Map(
    actualEntries
      .filter((entry) => typeof entry.sha256 === "string")
      .map((entry) => [entry.path, entry.sha256]),
  );
  const missing = runtimeExpected.filter((file) => !actualCounts.has(file));
  const extra = runtimeActual.filter((file) => !expectedSet.has(file));
  const mismatch = runtimeExpected.filter((file) =>
    actualHashes.has(file) && actualHashes.get(file) !== expectedHashes.get(file)
  );
  const sourceScope = [...new Set([
    ...runtimeExpected,
    ...sourceScopeFiles.map(normalizeRepoPath),
  ])].sort();
  const deterministicKbClient =
    "supabase/functions/_shared/deterministic-kb-client.ts";

  return {
    root: entrypoint,
    runtime_expected_files: runtimeExpected,
    runtime_actual_files: runtimeActual,
    source_scope_files: sourceScope,
    missing_files: missing,
    extra_files: extra,
    mismatch_files: mismatch,
    duplicate_actual_files: duplicateActual,
    missing_count: missing.length,
    extra_count: extra.length,
    mismatch_count: mismatch.length,
    duplicate_actual_count: duplicateActual.length,
    parity:
      missing.length === 0 &&
      extra.length === 0 &&
      mismatch.length === 0 &&
      duplicateActual.length === 0,
    deterministic_kb_client: {
      file: deterministicKbClient,
      runtime_reachable: expectedSet.has(deterministicKbClient),
      source_scope: sourceScope.includes(deterministicKbClient),
    },
  };
}

export function assertRuntimeParity(report) {
  if (!report?.parity) {
    throw new Error(
      "runtime_parity_failed:missing=" + (report?.missing_count ?? "?") +
      ":extra=" + (report?.extra_count ?? "?") +
      ":mismatch=" + (report?.mismatch_count ?? "?") +
      ":duplicates=" + (report?.duplicate_actual_count ?? "?"),
    );
  }
  return report;
}


function cliOption(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const actualManifestPath = cliOption(process.argv.slice(2), "--actual-manifest");
  if (!actualManifestPath) {
    throw new Error("usage: c3_edge_runtime_parity.mjs --actual-manifest <json> [--source-scope <json>]");
  }
  const actualManifest = JSON.parse(fs.readFileSync(actualManifestPath, "utf8"));
  const deployedFiles = Array.isArray(actualManifest)
    ? actualManifest
    : actualManifest.files;
  const sourceScopePath = cliOption(process.argv.slice(2), "--source-scope");
  const sourceScopeManifest = sourceScopePath
    ? JSON.parse(fs.readFileSync(sourceScopePath, "utf8"))
    : actualManifest.source_scope_files ?? [];
  const sourceScopeFiles = Array.isArray(sourceScopeManifest)
    ? sourceScopeManifest
    : sourceScopeManifest.files;
  const report = buildRuntimeParityReport({
    deployedFiles,
    sourceScopeFiles,
  });
  assertRuntimeParity(report);
  process.stdout.write(JSON.stringify({ ...report, result: "PASS" }, null, 2) + "\n");
}
