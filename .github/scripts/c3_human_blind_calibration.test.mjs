#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { DIMENSIONS } from "./c3_nonproduction_independent_grader.mjs";
import { generateBlindPacket, krippendorffAlpha, verifyHumanCalibration } from "./c3_human_blind_calibration.mjs";
import { hashObject } from "./c3_real_customer_dataset.mjs";

const rubric = JSON.parse(fs.readFileSync(new URL("./c3_service_quality_rubric.json", import.meta.url), "utf8"));
const candidate = { head: "4".repeat(40), tree: "5".repeat(40) };
const cases = Array.from({ length: 20 }, (_, index) => ({ case_id: `c3-rc-${String(index + 1).padStart(3, "0")}`, test: index }));
const dataset = { cases };
const runtime = { observations: cases.map((row, index) => {
  const context = { message: `blind context ${index}` }, response = { message: `blind response ${index}` };
  return { case_id: row.case_id, case_sha256: hashObject(row), context, context_sha256: hashObject(context), response, response_sha256: hashObject(response) };
}) };
const packet = generateBlindPacket({ dataset, runtime, rubric, selectedCaseIds: cases.map((row) => row.case_id), packetId: "unit-test-packet" });
assert.equal(packet.samples.length, 20);
assert.equal("model" in packet.samples[0], false);
assert.equal("oracle" in packet.samples[0], false);
assert.equal(krippendorffAlpha([[1, 1], [2, 2], [3, 3]]), 1);
const substitutedRuntime = structuredClone(runtime); substitutedRuntime.observations[0].response = { message: "substituted" };
assert.throws(() => generateBlindPacket({ dataset, runtime: substitutedRuntime, rubric, selectedCaseIds: cases.map((row) => row.case_id) }), /human_packet_response_substitution/);

const reviewers = [
  { reviewer_id: "human-a", human_attestation: true, provenance: "test-only human schema fixture A", excluded_roles_attestation: ["implementation_agent", "dataset_builder", "grader_prompt_author"], hk_customer_service_or_qa_experience: true },
  { reviewer_id: "human-b", human_attestation: true, provenance: "test-only human schema fixture B", excluded_roles_attestation: ["implementation_agent", "dataset_builder", "grader_prompt_author"], hk_customer_service_or_qa_experience: false },
];
const review = (sample, reviewer, index, score = 8, adjudicator = false) => ({
  review_id: `${sample.sample_id}-${reviewer.reviewer_id}`, sample_id: sample.sample_id, reviewer_id: reviewer.reviewer_id,
  case_sha256: sample.case_sha256, response_sha256: sample.response_sha256, rubric_sha256: sample.rubric_sha256,
  timestamp: `2026-09-17T00:${String(index).padStart(2, "0")}:00Z`, human_submitted: true, blind_attestation: true,
  scores: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, score + (index % 2)])), reason: "Test-only review reason with provenance", p0_labels: [], recommendation: "PASS", adjudicator,
});
const reviews = packet.samples.flatMap((sample, index) => reviewers.map((reviewer) => review(sample, reviewer, index)));
const artifact = { schema_version: "c3-human-blind-calibration-1.0.0", candidate, packet_sha256: hashObject(packet), rubric_sha256: hashObject(rubric), reviewers, reviews };
assert.equal(verifyHumanCalibration({ artifact, packet, expectedCandidate: candidate, rubric }).status, "CALIBRATED");

const noProvenance = structuredClone(artifact); noProvenance.reviewers[0].provenance = "";
assert.throws(() => verifyHumanCalibration({ artifact: noProvenance, packet, expectedCandidate: candidate, rubric }), /human_reviewer_provenance_invalid/);
const notBlindPacket = structuredClone(packet); notBlindPacket.blindness.model_identity_hidden = false;
const notBlind = structuredClone(artifact); notBlind.packet_sha256 = hashObject(notBlindPacket);
assert.throws(() => verifyHumanCalibration({ artifact: notBlind, packet: notBlindPacket, expectedCandidate: candidate, rubric }), /human_packet_not_blind/);
const conflict = structuredClone(artifact); conflict.reviews.find((row) => row.sample_id === packet.samples[0].sample_id && row.reviewer_id === "human-b").scores[DIMENSIONS[0]] = 1;
assert.throws(() => verifyHumanCalibration({ artifact: conflict, packet, expectedCandidate: candidate, rubric }), /human_third_blind_adjudicator_required/);
const lowAlpha = structuredClone(artifact);
lowAlpha.reviewers.push({ reviewer_id: "human-c", human_attestation: true, provenance: "test-only adjudicator", excluded_roles_attestation: ["implementation_agent", "dataset_builder", "grader_prompt_author"], hk_customer_service_or_qa_experience: false });
for (let index = 0; index < packet.samples.length; index += 1) {
  const sample = packet.samples[index];
  const second = lowAlpha.reviews.find((row) => row.sample_id === sample.sample_id && row.reviewer_id === "human-b");
  for (const dimension of DIMENSIONS) second.scores[dimension] = index % 2 ? 1 : 10;
  second.recommendation = index % 2 ? "FAIL" : "PASS";
  lowAlpha.reviews.push(review(sample, lowAlpha.reviewers[2], index, 7, true));
}
assert.throws(() => verifyHumanCalibration({ artifact: lowAlpha, packet, expectedCandidate: candidate, rubric }), /human_alpha_below_threshold/);

console.log("C3_HUMAN_BLIND_CALIBRATION_TESTS=PASS");
