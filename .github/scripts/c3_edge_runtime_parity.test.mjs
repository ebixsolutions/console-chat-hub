#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertRuntimeParity,
  buildRuntimeParityReport,
  GENERATE_REPLY_RUNTIME_ROOT,
} from "./c3_edge_runtime_parity.mjs";

const root = process.cwd();
// Machine-derived from the accepted 086e77a generate-reply dependency closure.
const ACCEPTED_RUNTIME_FILE_SET_SHA256 =
  "da7da6b9d9bd5b9716ced54417c1801728d35aa1010f59f5a1c3d0520c968118";
const runtimeFileSetDigest = (files) => crypto.createHash("sha256")
  .update([...files].sort().join("\n") + "\n").digest("hex");
const assertAcceptedRuntimeFileSet = (files) => assert.equal(
  runtimeFileSetDigest(files),
  ACCEPTED_RUNTIME_FILE_SET_SHA256,
  "runtime expected file-set identity drift",
);
const sourceOnlyAdapter = "supabase/functions/_shared/deterministic-kb-client.ts";
const expectedRoot = buildRuntimeParityReport({
  root,
  deployedFiles: [],
  sourceScopeFiles: [sourceOnlyAdapter],
});
const syntheticManifest = expectedRoot.runtime_expected_files.map((file) => ({
  path: file,
  sha256: createHashForFile(path.resolve(root, file)),
}));
const report = buildRuntimeParityReport({
  root,
  deployedFiles: syntheticManifest,
  sourceScopeFiles: [sourceOnlyAdapter],
});
assertRuntimeParity(report);
assert.equal(report.root, GENERATE_REPLY_RUNTIME_ROOT);
assertAcceptedRuntimeFileSet(report.runtime_expected_files);
assert.equal(
  new Set(report.runtime_expected_files).size,
  report.runtime_expected_files.length,
);
assert(report.runtime_expected_files.includes(GENERATE_REPLY_RUNTIME_ROOT));
assert.deepEqual(report.runtime_actual_files, report.runtime_expected_files);
assert.equal(report.missing_count, 0);
assert.equal(report.extra_count, 0);
assert.equal(report.mismatch_count, 0);
assert.equal(report.duplicate_actual_count, 0);
assert.equal(report.deterministic_kb_client.runtime_reachable, false);
assert.equal(report.deterministic_kb_client.source_scope, true);

// Identity must reject missing, extra, and same-count substituted paths.
const fakeRuntimePath = "supabase/functions/_shared/unauthorized-runtime.ts";
for (const files of [
  report.runtime_expected_files.slice(1),
  [...report.runtime_expected_files, fakeRuntimePath],
  [fakeRuntimePath, ...report.runtime_expected_files.slice(1)],
]) assert.throws(() => assertAcceptedRuntimeFileSet(files), /file-set identity drift/u);

// Omitting a real transitive dependency must fail.
const missingReport = buildRuntimeParityReport({
  root,
  deployedFiles: syntheticManifest.slice(1),
  sourceScopeFiles: [sourceOnlyAdapter],
});
assert.equal(missingReport.missing_count, 1);
assert.throws(() => assertRuntimeParity(missingReport), /runtime_parity_failed/u);

// A source-only alternate adapter must not be silently bundled as runtime.
const extraReport = buildRuntimeParityReport({
  root,
  deployedFiles: [
    ...syntheticManifest,
    {
      path: sourceOnlyAdapter,
      sha256: createHashForFile(path.resolve(root, sourceOnlyAdapter)),
    },
  ],
  sourceScopeFiles: [sourceOnlyAdapter],
});
assert.equal(extraReport.extra_count, 1);
assert.throws(() => assertRuntimeParity(extraReport), /runtime_parity_failed/u);
const duplicateReport = buildRuntimeParityReport({
  root,
  deployedFiles: [...syntheticManifest, syntheticManifest[0]],
  sourceScopeFiles: [sourceOnlyAdapter],
});
assert.equal(duplicateReport.duplicate_actual_count, 1);
assert.throws(() => assertRuntimeParity(duplicateReport), /runtime_parity_failed/u);

const mismatchedManifest = syntheticManifest.map((entry, index) =>
  index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry
);
const mismatchReport = buildRuntimeParityReport({
  root,
  deployedFiles: mismatchedManifest,
  sourceScopeFiles: [sourceOnlyAdapter],
});
assert.equal(mismatchReport.mismatch_count, 1);
assert.throws(() => assertRuntimeParity(mismatchReport), /runtime_parity_failed/u);

// Runtime imports, re-exports, literal dynamic imports, and type erasure are explicit.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "c3-edge-runtime-"));
try {
  const fn = path.join(fixture, "supabase/functions/generate-reply");
  const shared = path.join(fixture, "supabase/functions/_shared");
  fs.mkdirSync(fn, { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(
    path.join(fn, "index.ts"),
    [
      'import "./static.ts";',
      'import type { T } from "./types.ts";',
      'export { value } from "../_shared/re-export.ts";',
      'const lazy = import("../_shared/lazy.ts");',
      'import "https://example.com/remote.ts";',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(fn, "static.ts"), "export {};\n");
  fs.writeFileSync(path.join(fn, "types.ts"), "export type T = string;\n");
  fs.writeFileSync(path.join(shared, "re-export.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(shared, "lazy.ts"), "export {};\n");
  const fixtureExpected = buildRuntimeParityReport({
    root: fixture,
    deployedFiles: [],
  }).runtime_expected_files;
  assert.deepEqual(
    fixtureExpected,
    [
      "supabase/functions/_shared/lazy.ts",
      "supabase/functions/_shared/re-export.ts",
      "supabase/functions/generate-reply/index.ts",
      "supabase/functions/generate-reply/static.ts",
    ],
  );
  assert(!fixtureExpected.includes("supabase/functions/generate-reply/types.ts"));
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

function createHashForFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

process.stdout.write(JSON.stringify({
  mode: "synthetic_deployment_manifest",
  root: report.root,
  runtime_expected_files: report.runtime_expected_files,
  runtime_actual_files: report.runtime_actual_files,
  runtime_file_set_sha256: runtimeFileSetDigest(report.runtime_expected_files),
  runtime_file_count: report.runtime_expected_files.length,
  source_scope_files: report.source_scope_files,
  missing: report.missing_count,
  extra: report.extra_count,
  mismatch: report.mismatch_count,
  duplicates: report.duplicate_actual_count,
  deterministic_kb_client: report.deterministic_kb_client,
  result: "PASS",
}, null, 2) + "\n");
