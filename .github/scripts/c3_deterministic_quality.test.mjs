#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  generateFullBlindPacket,
  verifyFullHumanReview,
  verifyObjectiveOracle,
  verifyObjectiveRuntime,
} from "./c3_deterministic_quality.mjs";
import { hashObject } from "./c3_real_customer_dataset.mjs";
import { DIMENSIONS } from "./c3_nonproduction_independent_grader.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const dataset = read(".github/scripts/c3_real_case_derived_dataset_v1.json");
const overlay = read(
  ".github/scripts/c3_deterministic_objective_oracle_v1.json",
);
const freeze = read(
  ".github/scripts/c3_deterministic_objective_freeze_v1.json",
);
const rubric = read(".github/scripts/c3_service_quality_rubric.json");
const expectedCandidate = { head: "a".repeat(40), tree: "b".repeat(40) };

assert.equal(
  verifyObjectiveOracle({ dataset, overlay, freeze }).quality_score,
  "NOT_MEASURED",
);
const runtime = {
  schema_version: "c3-deterministic-objective-runtime-1.0.0",
  evidence_type: "DETERMINISTIC_CONFORMANCE_ONLY",
  candidate: { ...expectedCandidate, run_id: "test-run", run_attempt: 1 },
  dataset_sha256: hashObject(dataset),
  overlay_sha256: hashObject(overlay),
  engine: {
    rule_pack_sha256: "1".repeat(64),
    template_pack_sha256: "2".repeat(64),
    fts_source_sha256: "3".repeat(64),
    external_model_calls: 0,
    external_api_cost_usd: "0.00",
  },
  observations: overlay.cases.map((oracle, index) => {
    const request = { case_id: oracle.case_id, index };
    const context = {
      source_case: dataset.cases[index].case_id,
      memory_turns: index % 101,
    };
    const response = {
      text: `deterministic response ${index}`,
      template_id: `T-${index}`,
    };
    return {
      case_id: oracle.case_id,
      case_sha256: oracle.case_sha256,
      endpoint: oracle.endpoint,
      request,
      request_sha256: hashObject(request),
      context,
      context_sha256: hashObject(context),
      response,
      response_sha256: hashObject(response),
      intent: oracle.expected_intent,
      action: oracle.eligible_actions[0],
      p0_labels: [],
      forbidden_transition_count: 0,
      cross_tenant_access: false,
      unapproved_template_used: false,
    };
  }),
};
const conformance = verifyObjectiveRuntime({
  runtime,
  dataset,
  overlay,
  freeze,
  expectedCandidate,
});
assert.equal(conformance.objective_conformance, true);
assert.equal(conformance.quality_score, "NOT_MEASURED");
assert.equal(conformance.product_ready, false);

const replay = structuredClone(runtime);
replay.observations[1] = structuredClone(replay.observations[0]);
assert.throws(
  () =>
    verifyObjectiveRuntime({
      runtime: replay,
      dataset,
      overlay,
      freeze,
      expectedCandidate,
    }),
  /duplicate_replay/,
);
const substituted = structuredClone(runtime);
substituted.observations[0].response.text = "substituted";
assert.throws(
  () =>
    verifyObjectiveRuntime({
      runtime: substituted,
      dataset,
      overlay,
      freeze,
      expectedCandidate,
    }),
  /response_substitution/,
);
const crossRelease = structuredClone(runtime);
crossRelease.candidate.head = "c".repeat(40);
assert.throws(
  () =>
    verifyObjectiveRuntime({
      runtime: crossRelease,
      dataset,
      overlay,
      freeze,
      expectedCandidate,
    }),
  /cross_release/,
);
const fakeAggregate = structuredClone(runtime);
fakeAggregate.quality_score = 100;
assert.throws(
  () =>
    verifyObjectiveRuntime({
      runtime: fakeAggregate,
      dataset,
      overlay,
      freeze,
      expectedCandidate,
    }),
  /quality_aggregate_forbidden/,
);

const packet = generateFullBlindPacket({
  dataset,
  runtime,
  rubric,
  packetId: "packet-test",
});
assert.equal(packet.samples.length, 100);
assert(!JSON.stringify(packet).includes("rule_pack_sha256"));
const excluded = [
  "implementation_agent",
  "dataset_builder",
  "coach_ai",
  "template_author",
  "rule_author",
];
const passingScores = Object.fromEntries(
  DIMENSIONS.map((
    dimension,
    index,
  ) => [dimension, [9.6, 9.6, 9.4, 9.4, 9.6, 9.4][index]]),
);
const artifact = {
  schema_version: "c3-deterministic-full-human-review-1.0.0",
  candidate: { ...expectedCandidate, run_id: "human-run", run_attempt: 1 },
  packet_sha256: hashObject(packet),
  rubric_sha256: hashObject(rubric),
  reviewers: ["reviewer-one", "reviewer-two"].map((reviewer_id) => ({
    reviewer_id,
    human_attestation: true,
    provenance: "independent customer-support QA reviewer",
    role: "human_qa",
    excluded_roles_attestation: excluded,
  })),
  reviews: packet.samples.flatMap((sample) =>
    ["reviewer-one", "reviewer-two"].map((reviewer_id, reviewerIndex) => ({
      review_id: `${sample.sample_id}-${reviewerIndex}`,
      sample_id: sample.sample_id,
      reviewer_id,
      case_sha256: sample.case_sha256,
      response_sha256: sample.response_sha256,
      rubric_sha256: sample.rubric_sha256,
      human_submitted: true,
      blind_attestation: true,
      timestamp: "2026-09-17T12:00:00.000Z",
      reason: "The answer is grounded, safe, and appropriately scoped.",
      scores: passingScores,
      p0_labels: [],
      recommendation: "PASS",
    }))
  ),
};
const verified = verifyFullHumanReview({
  artifact,
  packet,
  expectedCandidate,
  rubric,
});
assert.equal(verified.review_count, 200);
assert.equal(verified.a_class_ready, false);
assert.equal(verified.product_ready, false);
const underReviewed = structuredClone(artifact);
underReviewed.reviews.pop();
assert.throws(
  () =>
    verifyFullHumanReview({
      artifact: underReviewed,
      packet,
      expectedCandidate,
      rubric,
    }),
  /requires_200_records/,
);
const conflict = structuredClone(artifact);
conflict.reviews[0].scores[DIMENSIONS[0]] = 5;
conflict.reviews[0].recommendation = "FAIL";
assert.throws(
  () =>
    verifyFullHumanReview({
      artifact: conflict,
      packet,
      expectedCandidate,
      rubric,
    }),
  /third_blind_adjudicator_required/,
);
console.log("c3 deterministic objective and full-human review tests: PASS");
