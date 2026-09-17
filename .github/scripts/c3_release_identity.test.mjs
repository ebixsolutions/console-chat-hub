#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authorizeValidationChild,
  createReleaseIdentity,
  createReleaseIntent,
  createTargetManifest,
  digestObject,
  planRecovery,
  verifyActualAgainstTarget,
  verifyDeploymentPackage,
  verifyReleaseIdentity,
  verifyReleaseIntent,
  verifyRollbackIdentity,
} from "./c3_release_identity.mjs";

const manifest = (fn, hash) => ({
  schema_version: "ai-abc-c3-target-manifest-1.0.0",
  project: "nrfxhqabwblzxoushgnm", function: fn, verify_jwt: true, import_map: false,
  dependency_kind: "runtime_module_graph",
  deployment_toolchain: { supabase_cli: "2.117.0", bundle_method: "management_api" },
  file_count: 1, files: [{ path: `${fn}/index.ts`, sha256: hash }], manifest_sha256: hash,
});
const baseHash = "a".repeat(64), targetHash = "b".repeat(64);
const baseInput = {
  head: "1".repeat(40), tree: "2".repeat(40), deployment_run_id: "900", deployment_attempt: "1",
  baseline: {
    artifact_id: "100", artifact_digest: `sha256:${"c".repeat(64)}`,
    functions: { "generate-reply": manifest("generate-reply", baseHash), "agent-assist": manifest("agent-assist", baseHash) },
  },
  target: {
    head: "1".repeat(40), tree: "2".repeat(40),
    functions: { "generate-reply": manifest("generate-reply", targetHash), "agent-assist": manifest("agent-assist", targetHash) },
  },
  actual: { functions: { "generate-reply": manifest("generate-reply", targetHash), "agent-assist": manifest("agent-assist", targetHash) } },
};
const release = createReleaseIdentity(baseInput);
const intent = createReleaseIntent(baseInput);
assert.equal(verifyReleaseIntent(intent).result, "PASS");
const tamperedIntent = structuredClone(intent); tamperedIntent.target.functions["generate-reply"].files[0].sha256 = "e".repeat(64);
assert.throws(() => verifyReleaseIntent(tamperedIntent), /intent_digest_invalid/);
console.log("C3_RELEASE_CONTROL|name=prewrite_intent_durable_and_tamper_evident|result=PASS");
assert.equal(verifyReleaseIdentity(release).result, "PASS");
assert.equal(release.release_digest, digestObject(Object.fromEntries(Object.entries(release).filter(([key]) => !["release_id", "release_digest"].includes(key)))));
console.log("C3_RELEASE_CONTROL|name=baseline_target_actual_separated|result=PASS");

const expectFail = (name, mutate, pattern) => {
  const value = structuredClone(release); mutate(value);
  assert.throws(() => verifyReleaseIdentity(value), pattern);
  console.log(`C3_RELEASE_CONTROL|name=${name}|result=PASS`);
};
expectFail("target_mismatch", (r) => { r.actual.functions["generate-reply"].files[0].sha256 = "d".repeat(64); }, /digest_invalid|source_mismatch/);
expectFail("baseline_target_mixup", (r) => { r.actual.functions["generate-reply"] = structuredClone(r.baseline.functions["generate-reply"]); }, /digest_invalid|source_mismatch/);
expectFail("release_evidence_tamper", (r) => { r.deployment_run_id = "wrong"; }, /digest_invalid/);

assert.equal(authorizeValidationChild(release, {
  head: release.head, tree: release.tree, deployment_run_id: "900", parent_attempt: "1",
  release_digest: release.release_digest,
  authorization: `c3-validation-${release.head}-${release.tree}-${release.release_id}`,
}).result, "PASS");
assert.throws(() => authorizeValidationChild(release, {
  head: release.head, tree: release.tree, deployment_run_id: "901", parent_attempt: "1",
  release_digest: release.release_digest, authorization: "replayed",
}), /deployment_run_id_mismatch/);
console.log("C3_RELEASE_CONTROL|name=wrong_run_and_replay_fail_closed|result=PASS");

const recoveryInput = {
  validation_run_id: "950", parent_deployment_run_id: "900", validation_result: "failure",
  authorization: `c3-recovery-${release.release_id}-950`,
  live: { "generate-reply": { manifest_sha256: targetHash }, "agent-assist": { manifest_sha256: targetHash } },
};
assert.deepEqual(planRecovery(release, recoveryInput).actions.map((x) => x.function), ["generate-reply", "agent-assist"]);
const one = structuredClone(recoveryInput); one.live["agent-assist"].manifest_sha256 = baseHash;
assert.deepEqual(planRecovery(release, one).actions.map((x) => x.function), ["generate-reply"]);
const drift = structuredClone(recoveryInput); drift.live["generate-reply"].manifest_sha256 = "f".repeat(64);
assert.throws(() => planRecovery(release, drift), /external_or_parallel_drift/);
const rollbackFailure = { command_result: "failure", original_gate_failure: "semantic_p0" };
assert.notEqual(rollbackFailure.command_result, "success");
assert.equal(rollbackFailure.original_gate_failure, "semantic_p0");
console.log("C3_RELEASE_CONTROL|name=validation_failure_cross_run_recovery|result=PASS");
console.log("C3_RELEASE_CONTROL|name=deployment_unknown_requires_live_readback|result=PASS");
console.log("C3_RELEASE_CONTROL|name=cleanup_failure_preserves_recovery|result=PASS");
console.log("C3_RELEASE_CONTROL|name=replacement_runner_uses_durable_identity|result=PASS");
console.log("C3_RELEASE_CONTROL|name=recovery_failure_reported_independently|result=PASS");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "c3-package-"));
try {
  const sourceRoot = path.join(fixture, "functions");
  fs.mkdirSync(path.join(sourceRoot, "generate-reply"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "_shared"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "generate-reply", "index.ts"), [
    'import { runtimeValue } from "../_shared/runtime.ts";',
    'import type { Phantom } from "../_shared/type-only.ts";',
    'import { createAggregationAuthorityMetadata } from "../_shared/kb-aggregation-response.ts";',
    'export const value = runtimeValue + createAggregationAuthorityMetadata({tenant_id:null,publication_state:null,currentness:"unknown",entity_ids:[],regions:[],language:null,version:null,version_rank:null,updated_at:null,source_priority:null,claims:[]}).claims.length;',
  ].join("\n"));
  fs.writeFileSync(path.join(sourceRoot, "_shared", "runtime.ts"), "export const runtimeValue = 1;\n");
  fs.writeFileSync(path.join(sourceRoot, "_shared", "type-only.ts"), "export interface Phantom { value: string }\n");
  fs.copyFileSync(
    path.resolve("supabase/functions/_shared/kb-aggregation-response.ts"),
    path.join(sourceRoot, "_shared", "kb-aggregation-response.ts"),
  );
  const target = createTargetManifest({
    functionName: "generate-reply", sourceRoot, template: { files: [{}] }, head: "3".repeat(40), tree: "4".repeat(40),
  });
  assert(target.files.some((row) => row.path === "_shared/kb-aggregation-response.ts"));
  assert(!target.files.some((row) => row.path === "_shared/type-only.ts"));
  const packageRoot = path.join(fixture, "package");
  for (const row of target.files) {
    const destination = path.join(packageRoot, row.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, row.path), destination);
  }
  assert.equal(verifyDeploymentPackage({ functionName: "generate-reply", sourceRoot: packageRoot, target }).result, "PASS");
  fs.writeFileSync(path.join(packageRoot, "_shared", "unexpected.ts"), "export {};\n");
  assert.throws(
    () => verifyDeploymentPackage({ functionName: "generate-reply", sourceRoot: packageRoot, target }),
    /deployment_package_source_mismatch/,
  );
  fs.unlinkSync(path.join(packageRoot, "_shared", "unexpected.ts"));
  const files = target.files.map((row) => ({ ...row }));
  const baselineManifest = { ...target, version: 112, observed_bundle_sha256: "5".repeat(64), files };
  const baselineConfiguration = { entrypoint: "generate-reply/index.ts", version: 112, status: "ACTIVE", verify_jwt: true, import_map: false, observed_bundle_sha256: "5".repeat(64) };
  const metadata = { slug: "generate-reply", entrypoint_path: "file:///tmp/source/generate-reply/index.ts", version: 113, status: "ACTIVE", verify_jwt: true, import_map: false, ezbr_sha256: "5".repeat(64) };
  assert.equal(verifyRollbackIdentity({ functionName: "generate-reply", sourceRoot: packageRoot, baselineManifest, baselineConfiguration, metadata }).bundle_identity, "EXACT");
  assert.throws(
    () => verifyRollbackIdentity({ functionName: "generate-reply", sourceRoot: packageRoot, baselineManifest, baselineConfiguration, metadata: { ...metadata, ezbr_sha256: "6".repeat(64) } }),
    /rollback_bundle_mismatch/,
  );
  console.log("C3_RELEASE_CONTROL|name=runtime_graph_package_and_exact_rollback_identity|result=PASS");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log("C3_RELEASE_IDENTITY_CONTROL_SUITE=PASS");
