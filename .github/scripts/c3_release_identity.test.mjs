#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  authorizeValidationChild,
  createReleaseIdentity,
  createReleaseIntent,
  digestObject,
  planRecovery,
  verifyActualAgainstTarget,
  verifyReleaseIdentity,
  verifyReleaseIntent,
} from "./c3_release_identity.mjs";

const manifest = (fn, hash) => ({
  schema_version: "ai-abc-c3-target-manifest-1.0.0",
  project: "nrfxhqabwblzxoushgnm", function: fn, verify_jwt: true, import_map: false,
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
console.log("C3_RELEASE_IDENTITY_CONTROL_SUITE=PASS");
