#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { DIMENSIONS } from "./c3_nonproduction_independent_grader.mjs";
import { GIT40, hashObject } from "./c3_real_customer_dataset.mjs";

const fail = (message) => { throw new Error(message); };
const present = (value) => typeof value === "string" && value.trim().length > 0;
const forbiddenReviewerRoles = new Set(["implementation_agent", "dataset_builder", "grader_prompt_author"]);

export function generateBlindPacket({ dataset, runtime, rubric, selectedCaseIds, packetId = crypto.randomUUID() }) {
  if (!Array.isArray(selectedCaseIds) || selectedCaseIds.length !== 20 || new Set(selectedCaseIds).size !== 20) fail("human_packet_requires_20_distinct_cases");
  const cases = new Map(dataset.cases.map((row) => [row.case_id, row]));
  const observations = new Map(runtime.observations.map((row) => [row.case_id, row]));
  const samples = selectedCaseIds.map((caseId) => {
    const source = cases.get(caseId), observation = observations.get(caseId);
    if (!source || !observation || observation.case_sha256 !== hashObject(source)) fail(`human_packet_binding_invalid:${caseId}`);
    if (observation.context_sha256 !== hashObject(observation.context) || observation.response_sha256 !== hashObject(observation.response)) fail(`human_packet_response_substitution:${caseId}`);
    return {
      sample_id: crypto.randomUUID(),
      case_id: caseId,
      case_sha256: observation.case_sha256,
      context: observation.context,
      context_sha256: observation.context_sha256,
      response: observation.response,
      response_sha256: observation.response_sha256,
      rubric_sha256: hashObject(rubric),
      dimensions: DIMENSIONS,
    };
  });
  return {
    schema_version: "c3-human-blind-packet-1.0.0",
    packet_id: packetId,
    blindness: {
      model_identity_hidden: true,
      grader_scores_hidden: true,
      other_reviewers_hidden: true,
      expected_results_hidden: true,
      oracle_labels_hidden: true,
    },
    samples,
  };
}

export function krippendorffAlpha(units, { metric = "interval" } = {}) {
  const usable = units.filter((ratings) => Array.isArray(ratings) && ratings.length >= 2);
  const values = usable.flat();
  if (!usable.length || values.length < 2) return null;
  const distance = metric === "nominal" ? (a, b) => a === b ? 0 : 1 : (a, b) => (a - b) ** 2;
  let observed = 0, observedPairs = 0;
  for (const ratings of usable) for (let i = 0; i < ratings.length; i += 1) for (let j = i + 1; j < ratings.length; j += 1) {
    observed += distance(ratings[i], ratings[j]); observedPairs += 1;
  }
  let expected = 0, expectedPairs = 0;
  for (let i = 0; i < values.length; i += 1) for (let j = i + 1; j < values.length; j += 1) {
    expected += distance(values[i], values[j]); expectedPairs += 1;
  }
  const observedMean = observed / observedPairs, expectedMean = expected / expectedPairs;
  if (expectedMean === 0) return observedMean === 0 ? 1 : 0;
  return Number((1 - observedMean / expectedMean).toFixed(6));
}

export function verifyHumanCalibration({ artifact, packet, expectedCandidate, rubric }) {
  if (artifact.schema_version !== "c3-human-blind-calibration-1.0.0") fail("human_artifact_schema_invalid");
  if (artifact.candidate?.head !== expectedCandidate.head || artifact.candidate?.tree !== expectedCandidate.tree || !GIT40.test(artifact.candidate.head) || !GIT40.test(artifact.candidate.tree)) fail("human_cross_release");
  if (artifact.packet_sha256 !== hashObject(packet) || artifact.rubric_sha256 !== hashObject(rubric)) fail("human_packet_or_rubric_tamper");
  if (!Object.values(packet.blindness).every((value) => value === true)) fail("human_packet_not_blind");
  if (!Array.isArray(packet.samples) || packet.samples.length !== 20 || new Set(packet.samples.map((row) => row.case_id)).size !== 20) fail("human_packet_coverage_invalid");
  if (!Array.isArray(artifact.reviewers) || artifact.reviewers.length < 2) fail("human_reviewer_count_invalid");
  const reviewers = new Map();
  let hasHkQa = false;
  for (const reviewer of artifact.reviewers) {
    if (!present(reviewer.reviewer_id) || reviewers.has(reviewer.reviewer_id) || reviewer.human_attestation !== true || !present(reviewer.provenance) || !Array.isArray(reviewer.excluded_roles_attestation)) fail("human_reviewer_provenance_invalid");
    if ([...forbiddenReviewerRoles].some((role) => !reviewer.excluded_roles_attestation.includes(role))) fail(`human_reviewer_independence_missing:${reviewer.reviewer_id}`);
    hasHkQa ||= reviewer.hk_customer_service_or_qa_experience === true;
    reviewers.set(reviewer.reviewer_id, reviewer);
  }
  if (!hasHkQa) fail("human_hk_qa_reviewer_missing");
  if (!Array.isArray(artifact.reviews) || artifact.reviews.length < 40) fail("human_review_count_invalid");
  const samples = new Map(packet.samples.map((row) => [row.sample_id, row]));
  const grouped = new Map(), recordIds = new Set();
  for (const review of artifact.reviews) {
    const sample = samples.get(review.sample_id);
    if (!sample || !reviewers.has(review.reviewer_id) || recordIds.has(review.review_id)) fail("human_review_identity_invalid");
    if (review.case_sha256 !== sample.case_sha256 || review.response_sha256 !== sample.response_sha256 || review.rubric_sha256 !== sample.rubric_sha256) fail(`human_review_binding_invalid:${review.review_id}`);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(review.timestamp) || review.human_submitted !== true || review.blind_attestation !== true) fail(`human_review_provenance_invalid:${review.review_id}`);
    if (!present(review.reason) || review.reason.trim().split(/\s+/).length < 4) fail(`human_review_reason_invalid:${review.review_id}`);
    if (!review.scores || Object.keys(review.scores).sort().join("|") !== [...DIMENSIONS].sort().join("|")) fail(`human_review_dimensions_invalid:${review.review_id}`);
    for (const dimension of DIMENSIONS) if (!Number.isFinite(review.scores[dimension]) || review.scores[dimension] < 0 || review.scores[dimension] > 10) fail(`human_review_score_invalid:${review.review_id}:${dimension}`);
    if (!Array.isArray(review.p0_labels) || review.p0_labels.some((label) => !rubric.critical_p0.includes(label)) || !["PASS", "FAIL"].includes(review.recommendation)) fail(`human_review_outcome_invalid:${review.review_id}`);
    const rows = grouped.get(review.sample_id) ?? [];
    if (rows.some((row) => row.reviewer_id === review.reviewer_id)) fail(`human_duplicate_reviewer_sample:${review.sample_id}`);
    rows.push(review); grouped.set(review.sample_id, rows); recordIds.add(review.review_id);
  }
  for (const sample of packet.samples) {
    const rows = grouped.get(sample.sample_id) ?? [];
    if (rows.length < 2) fail(`human_sample_under_reviewed:${sample.sample_id}`);
    const first = rows[0], second = rows[1];
    const scoreConflict = DIMENSIONS.some((dimension) => Math.abs(first.scores[dimension] - second.scores[dimension]) > 2);
    const p0Conflict = [...new Set([...first.p0_labels, ...second.p0_labels])].some((label) => first.p0_labels.includes(label) !== second.p0_labels.includes(label));
    const passConflict = first.recommendation !== second.recommendation;
    if ((scoreConflict || p0Conflict || passConflict) && (rows.length < 3 || rows[2].adjudicator !== true || rows[2].reviewer_id === first.reviewer_id || rows[2].reviewer_id === second.reviewer_id)) fail(`human_third_blind_adjudicator_required:${sample.sample_id}`);
  }
  const alpha = {};
  for (const dimension of DIMENSIONS) alpha[dimension] = krippendorffAlpha(packet.samples.map((sample) => (grouped.get(sample.sample_id) ?? []).slice(0, 2).map((row) => row.scores[dimension])));
  for (const label of rubric.critical_p0) alpha[`p0:${label}`] = krippendorffAlpha(packet.samples.map((sample) => (grouped.get(sample.sample_id) ?? []).slice(0, 2).map((row) => row.p0_labels.includes(label) ? 1 : 0)), { metric: "nominal" });
  const below = Object.entries(alpha).filter(([, value]) => value !== null && value < 0.8);
  if (below.length) fail(`human_alpha_below_threshold:${below.map(([key]) => key).join(",")}`);
  return { status: "CALIBRATED", case_count: packet.samples.length, review_count: artifact.reviews.length, reviewer_count: reviewers.size, alpha, threshold: 0.8 };
}

const [command, datasetPath, runtimePath, rubricPath, selectionPath, outputPath] = process.argv.slice(2);
if (command === "packet") {
  if (![datasetPath, runtimePath, rubricPath, selectionPath, outputPath].every(Boolean)) fail("usage:packet DATASET RUNTIME RUBRIC SELECTION OUT");
  const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const packet = generateBlindPacket({ dataset: read(datasetPath), runtime: read(runtimePath), rubric: read(rubricPath), selectedCaseIds: read(selectionPath).case_ids });
  fs.writeFileSync(outputPath, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: "AWAITING_HUMAN_REVIEWS", output: outputPath, packet_sha256: hashObject(packet) }));
} else if (command && import.meta.url === `file://${process.argv[1]}`) fail("unknown_command");
