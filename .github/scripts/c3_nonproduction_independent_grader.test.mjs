#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { DIMENSIONS, EVIDENCE_TYPE, verifyIndependentGraderArtifact, verifyImmutableEnvelope } from "./c3_nonproduction_independent_grader.mjs";
import { hashObject } from "./c3_real_customer_dataset.mjs";

const rubric = JSON.parse(fs.readFileSync(new URL("./c3_service_quality_rubric.json", import.meta.url), "utf8"));
const clone = structuredClone;
const candidate = { head: "a".repeat(40), tree: "b".repeat(40) };
const cases = Array.from({ length: 4 }, (_, index) => ({ case_id: `c3-rc-00${index + 1}`, value: index }));
const dataset = { cases };
const observations = cases.map((row, index) => {
  const request = { input: index }, context = { facts: [index] }, response = { answer: `unique-${index}` };
  return { case_id: row.case_id, case_sha256: hashObject(row), request, request_sha256: hashObject(request), context, context_sha256: hashObject(context), response, response_sha256: hashObject(response) };
});
const runtime = { candidate: { ...candidate, run_id: "runtime-run", run_attempt: 1 }, observations };
const raw = {
  evidence_type: EVIDENCE_TYPE,
  candidate: { ...candidate, run_id: "grader-run", run_attempt: 1 },
  author: { role: "independent_external_grader", self_assessment: false },
  grader: { provider: "TEST_ONLY_UNSET_PROVIDER", model: "TEST_ONLY_UNSET_MODEL", version: "TEST_ONLY", credential_scope_id: "test-only-no-secret", method: "external model rubric assessment" },
  prompt_sha256: "c".repeat(64), rubric_sha256: hashObject(rubric), dataset_sha256: hashObject(dataset),
  case_results: observations.map((row, index) => ({
    case_id: row.case_id, case_sha256: row.case_sha256, request_sha256: row.request_sha256, context_sha256: row.context_sha256, response_sha256: row.response_sha256,
    scores: Object.fromEntries(DIMENSIONS.map((dimension, d) => [dimension, 8 + ((index + d) % 2)])), reason: `Independent test reason for case ${index}`, p0_labels: [],
  })),
};
const freeze = { dataset_sha256: hashObject(dataset) };
const verify = (candidateRaw = raw, candidateRuntime = runtime, expected = candidate, expectedRawHash = hashObject(candidateRaw)) => verifyIndependentGraderArtifact({ raw: candidateRaw, runtime: candidateRuntime, dataset, freeze, rubric, expectedCandidate: expected, rawArtifactSha256: expectedRawHash });
const result = verify();
assert.equal(result.case_count, 4);
assert.equal(result.raw_artifact_sha256, hashObject(raw));
assert.equal(verifyImmutableEnvelope({ raw, raw_artifact_sha256: hashObject(raw) }), true);
assert.throws(() => verifyImmutableEnvelope({ raw, raw_artifact_sha256: "0".repeat(64) }), /grader_raw_artifact_tamper/);
assert.throws(() => verify(raw, runtime, candidate, "0".repeat(64)), /grader_raw_artifact_tamper/);

const aggregate = clone(raw); aggregate.weighted_score = 100;
assert.throws(() => verify(aggregate), /grader_self_aggregate_forbidden/);
const replay = clone(raw); replay.case_results[1].case_id = replay.case_results[0].case_id;
assert.throws(() => verify(replay), /grader_duplicate_replay_or_unknown_case/);
const cross = clone(raw); cross.candidate.head = "d".repeat(40);
assert.throws(() => verify(cross), /grader_cross_release/);
const substitution = clone(raw); substitution.case_results[0].response_sha256 = observations[1].response_sha256;
assert.throws(() => verify(substitution), /grader_response_substitution/);
const fixed = clone(raw); for (const row of fixed.case_results) for (const dimension of DIMENSIONS) row.scores[dimension] = 10;
assert.throws(() => verify(fixed), /grader_fixed_perfect_scores_forbidden/);
const emptyReason = clone(raw); emptyReason.case_results[0].reason = "";
assert.throws(() => verify(emptyReason), /grader_reason_empty_or_insufficient/);
const self = clone(raw); self.author.role = "implementation_agent";
assert.throws(() => verify(self), /grader_self_assessment_forbidden/);

console.log("C3_INDEPENDENT_GRADER_TESTS=PASS");
