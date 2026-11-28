#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DIMENSIONS = Object.freeze([
  "factual_grounding_and_commitment_truth", "resolution_and_progress",
  "context_correction_and_entity", "targeted_clarification_and_kb_use",
  "natural_language_and_concision", "handoff_next_step_and_customer_effort",
]);
const HEX64 = /^[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const fail = (message) => { throw new Error(message); };
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
  ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  : JSON.stringify(value);
const sha = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const strictNumber = (value, field) => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field}_must_be_finite_number`);
  return value;
};
const requiredText = (value, field) => {
  if (typeof value !== "string" || !value.trim()) fail(`${field}_missing`);
  return value.trim();
};
const exactBinding = (actual, expected, field) => {
  if (expected !== undefined && String(actual) !== String(expected)) fail(`${field}_binding_mismatch`);
};

export function verifyComponentRegression(evidence) {
  if (evidence?.schema_version !== "c3-service-component-evidence-2.0.0" || evidence.mode !== "component_runtime_wiring_regression") fail("component_evidence_schema_invalid");
  if (evidence.quality_status !== "NOT_MEASURED" || evidence.service_quality_scores !== "NOT_MEASURED") fail("component_must_not_claim_quality_score");
  if (evidence.independent_held_out !== false || evidence.human_calibrated !== false) fail("component_evidence_misclassified");
  if (!Array.isArray(evidence.samples) || evidence.samples.length !== 100 || evidence.sample_count !== 100) fail("component_sample_count_invalid");
  if (new Set(evidence.samples.map((row) => row.id)).size !== 100) fail("component_duplicate_id");
  if (!evidence.dataset || !HEX64.test(evidence.dataset.sha256) || evidence.dataset.status !== "observed_regression_not_held_out") fail("component_dataset_binding_invalid");
  const expectedDatasetHash = sha(evidence.samples.map((row) => ({ id: row.id, family: row.family, context_sha256: row.context_sha256 })));
  if (expectedDatasetHash !== evidence.dataset.sha256) fail("component_dataset_hash_mismatch");
  for (const row of evidence.samples) {
    if (!HEX64.test(row.context_sha256) || sha(row.context) !== row.context_sha256) fail(`component_context_hash_mismatch:${row.id}`);
    if (!HEX64.test(row.response_sha256) || sha(row.actual_response_or_action) !== row.response_sha256) fail(`component_response_hash_mismatch:${row.id}`);
    const checks = row.deterministic_checks;
    if (!checks || Object.keys(checks).length < 4 || Object.values(checks).some((value) => value !== true)) fail(`component_machine_check_failed:${row.id}`);
  }
  const hashes = evidence.candidate_source_hashes;
  if (!hashes || Object.keys(hashes).length < 4 || Object.values(hashes).some((value) => !HEX64.test(value))) fail("component_source_hashes_invalid");
  return { pass: true, sample_count: 100, quality_status: "NOT_MEASURED", machine_correctness: "PASS" };
}

function verifyCalibrationPacket(packet, expectedBinding = {}) {
  if (packet?.schema_version !== "c3-human-calibration-packet-1.0.0") fail("human_packet_schema_invalid");
  for (const field of ["head", "tree", "release_id", "sample_manifest_sha256", "rubric_sha256"]) requiredText(packet.binding?.[field], `human_packet_${field}`);
  exactBinding(packet.binding.head, expectedBinding.head, "human_head");
  exactBinding(packet.binding.tree, expectedBinding.tree, "human_tree");
  exactBinding(packet.binding.release_id, expectedBinding.release_id, "human_release");
  exactBinding(packet.binding.sample_manifest_sha256, expectedBinding.sampleManifestSha256, "human_sample_manifest");
  exactBinding(packet.binding.rubric_sha256, expectedBinding.rubricSha256, "human_rubric");
  if (!Array.isArray(packet.samples) || packet.samples.length < 20) fail("human_packet_sample_count_invalid");
  if (new Set(packet.samples.map((row) => row.id)).size !== packet.samples.length) fail("human_packet_duplicate_sample");
  const responseHashes = new Set();
  for (const row of packet.samples) {
    for (const field of ["id", "family", "customer_context", "customer_turn", "actual_response_or_action"]) requiredText(row[field], `human_sample_${field}`);
    if (!HEX64.test(row.context_sha256) || sha({ customer_context: row.customer_context, customer_turn: row.customer_turn }) !== row.context_sha256) fail(`human_context_hash_invalid:${row.id}`);
    if (!HEX64.test(row.response_sha256) || sha(row.actual_response_or_action) !== row.response_sha256) fail(`human_response_hash_invalid:${row.id}`);
    if (responseHashes.has(row.response_sha256)) fail(`human_duplicate_response:${row.id}`);
    responseHashes.add(row.response_sha256);
    const binding = row.source_binding;
    if (!binding || binding.head !== packet.binding.head || binding.tree !== packet.binding.tree || binding.release_id !== packet.binding.release_id || !requiredText(binding.runtime_observation_id, `human_runtime_observation:${row.id}`)) fail(`human_source_binding_invalid:${row.id}`);
    const facets = row.facets;
    if (!facets || typeof facets !== "object") fail(`human_facets_missing:${row.id}`);
  }
  const actualManifest = sha(packet.samples.map((row) => ({ id: row.id, context_sha256: row.context_sha256, response_sha256: row.response_sha256 })));
  if (packet.binding.sample_manifest_sha256 !== actualManifest) fail("human_sample_manifest_hash_mismatch");
  const has = (predicate) => packet.samples.some((row) => predicate(row.facets));
  if (!has((f) => f.emotion && f.entitlement === "verified" && f.handoff) ||
      !has((f) => f.emotion && f.entitlement === "self_claimed") ||
      !has((f) => f.entitlement === "unknown" && f.handoff)) fail("human_cross_coverage_incomplete");
  return new Map(packet.samples.map((row) => [row.id, row]));
}

export function verifyHumanCalibration(manifest, { requireCompleted = false, reviewArtifact = null, expectedBinding = {}, rubric = null } = {}) {
  if (!manifest || manifest.version !== "c3-service-quality-human-calibration-2026-09-16.3") fail("human_calibration_version_invalid");
  if (manifest.status !== "AWAITING_HUMAN_CALIBRATION") fail("human_manifest_status_must_remain_awaiting");
  if (!manifest.sampling_plan || manifest.sampling_plan.minimum_distinct_samples !== 20 || !Array.isArray(manifest.sampling_plan.required_cross_coverage)) fail("human_sampling_plan_invalid");
  if (!requireCompleted) {
    if (reviewArtifact !== null) fail("human_review_artifact_unexpected_preproduction");
    return { status: "AWAITING_HUMAN_CALIBRATION", samples: 0, review_artifact_required: true };
  }
  if (!reviewArtifact) fail("human_review_artifact_missing");
  const samples = verifyCalibrationPacket(reviewArtifact.packet, expectedBinding);
  const collection = reviewArtifact.collection;
  if (collection?.status !== "COLLECTION_COMPLETED") fail("human_review_collection_incomplete");
  if (!Array.isArray(collection.reviews) || collection.reviews.length < 20) fail("human_reviews_missing");
  const reviewedSamples = new Set(), reviewerIds = new Set();
  const totals = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  const counts = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  const bySample = new Map();
  for (const review of collection.reviews) {
    const sample = samples.get(review.sample_id);
    if (!sample) fail(`human_review_sample_missing:${review.sample_id}`);
    if (reviewedSamples.has(review.sample_id)) fail(`human_duplicate_sample_review:${review.sample_id}`);
    reviewedSamples.add(review.sample_id);
    const reviewer = review.reviewer;
    if (!reviewer || reviewer.source !== "external_human_qa" || !requiredText(reviewer.reviewer_id, `human_reviewer:${review.sample_id}`) || !requiredText(reviewer.provenance, `human_reviewer_provenance:${review.sample_id}`)) fail(`human_reviewer_invalid:${review.sample_id}`);
    reviewerIds.add(reviewer.reviewer_id);
    if (review.blinded !== true || !Number.isFinite(Date.parse(review.reviewed_at))) fail(`human_blinding_or_time_invalid:${review.sample_id}`);
    if (review.context_sha256 !== sample.context_sha256 || review.response_sha256 !== sample.response_sha256) fail(`human_review_content_binding_mismatch:${review.sample_id}`);
    for (const dimension of DIMENSIONS) {
      const assessment = review.dimensions?.[dimension];
      if (!assessment || typeof assessment.score !== "number" || !Number.isFinite(assessment.score) || assessment.score < 0 || assessment.score > 10) fail(`human_review_score_invalid:${review.sample_id}:${dimension}`);
      requiredText(assessment.reason, `human_review_reason:${review.sample_id}:${dimension}`);
      totals[dimension] += assessment.score; counts[dimension]++;
    }
    bySample.set(review.sample_id, review);
  }
  if (reviewedSamples.size < 20 || reviewerIds.size < 2) fail("human_review_independence_invalid");
  const averages = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, totals[dimension] / counts[dimension]]));
  const weights = rubric?.weights ?? {};
  const weighted = DIMENSIONS.reduce((sum, dimension) => sum + averages[dimension] / 10 * strictNumber(weights[dimension], `human_weight:${dimension}`), 0);
  const target = rubric?.target;
  for (const dimension of DIMENSIONS) if (averages[dimension] < strictNumber(target?.dimension_average_min?.[dimension], `human_target:${dimension}`)) fail(`human_quality_dimension_below_threshold:${dimension}:${averages[dimension]}`);
  if (weighted < strictNumber(target?.weighted_score_min, "human_weighted_target")) fail(`human_quality_weighted_below_threshold:${weighted}`);
  if (collection.major_disagreement_count !== 0 || collection.disagreement_resolution_status !== "RESOLVED_OR_NONE") fail("human_calibration_disagreement_unresolved");
  return { status: "PASS", collection_status: "COLLECTION_COMPLETED", samples: reviewedSamples.size, reviewers: reviewerIds.size, weighted_score: weighted, dimension_averages: averages };
}

function verifyProductionBinding(evidence, binding) {
  const root = evidence.binding;
  if (!root) fail("quality_binding_missing");
  for (const field of ["head", "tree", "release_id", "run_id", "attempt", "dataset_sha256", "rubric_sha256"]) requiredText(root[field], `quality_${field}`);
  for (const field of ["head", "tree", "release_id", "run_id", "attempt", "dataset_sha256", "rubric_sha256"]) exactBinding(root[field], binding?.[field], `quality_${field}`);
  if (!root.closure_manifests || Object.values(root.closure_manifests).some((value) => !HEX64.test(value))) fail("quality_closure_binding_invalid");
  if (binding?.closure_manifests && canonical(root.closure_manifests) !== canonical(binding.closure_manifests)) fail("quality_closure_binding_mismatch");
  const grader = evidence.grader_provenance;
  if (!grader || grader.source !== "external_quality_grader" || !requiredText(grader.provider, "grader_provider") || !requiredText(grader.model, "grader_model") || !requiredText(grader.model_version, "grader_model_version") || !HEX64.test(grader.prompt_sha256) || !HEX64.test(grader.rubric_sha256) || !SHA256.test(grader.artifact_digest) || String(grader.run_id) !== String(root.run_id) || String(grader.attempt) !== String(root.attempt)) fail("quality_grader_provenance_invalid");
  if (grader.rubric_sha256 !== root.rubric_sha256) fail("quality_grader_rubric_mismatch");
}

export function verifyServiceQuality(evidence, rubric, { requireRuntime = true, binding = {}, runtimeObservations = new Map() } = {}) {
  if (!requireRuntime) fail("quality_scores_require_independent_runtime_assessment");
  if (evidence?.schema_version !== "c3-service-quality-assessment-2.0.0" || evidence.mode !== "live_production_independent_assessment" || evidence.quality_status !== "MEASURED") fail("quality_assessment_schema_invalid");
  verifyProductionBinding(evidence, binding);
  if (!Array.isArray(evidence.rows) || evidence.rows.length < 100 || evidence.sample_count !== evidence.rows.length) fail("quality_sample_count_invalid");
  const ids = new Set(), customerIds = new Set(), assistantIds = new Set(), responseHashes = new Set(), contextHashes = new Set();
  const totals = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  let p0Violations = 0;
  for (const row of evidence.rows) {
    if (ids.has(row.id)) fail(`quality_duplicate_id:${row.id}`); ids.add(row.id);
    if (customerIds.has(row.customer_source_message_id) || assistantIds.has(row.assistant_message_id)) fail(`quality_duplicate_runtime_id:${row.id}`);
    customerIds.add(row.customer_source_message_id); assistantIds.add(row.assistant_message_id);
    const observed = runtimeObservations.get(row.customer_source_message_id);
    if (!observed || observed.assistant_message_id !== row.assistant_message_id || observed.response !== row.response || observed.release_id !== evidence.binding.release_id) fail(`quality_runtime_observation_mismatch:${row.id}`);
    if (!HEX64.test(row.response_sha256) || sha(row.response) !== row.response_sha256) fail(`quality_response_hash_mismatch:${row.id}`);
    if (!HEX64.test(row.context_sha256) || sha(row.context) !== row.context_sha256) fail(`quality_context_hash_mismatch:${row.id}`);
    if (responseHashes.has(row.response_sha256) || contextHashes.has(row.context_sha256)) fail(`quality_duplicate_response_or_context:${row.id}`);
    responseHashes.add(row.response_sha256); contextHashes.add(row.context_sha256);
    const graderInput = { id: row.id, context: row.context, response: row.response, action: row.action, oracle: row.oracle };
    if (!HEX64.test(row.grader_input_sha256) || sha(graderInput) !== row.grader_input_sha256) fail(`quality_grader_input_mismatch:${row.id}`);
    if (!HEX64.test(row.grader_raw_output_sha256) || sha(row.grader_raw_output) !== row.grader_raw_output_sha256 || row.grader_raw_output.sample_id !== row.id) fail(`quality_grader_output_mismatch:${row.id}`);
    if (!Array.isArray(row.p0_observations)) fail(`quality_p0_observations_missing:${row.id}`);
    const p0ByName = new Map(row.p0_observations.map((item) => [item.name, item]));
    for (const name of rubric.critical_p0 ?? []) {
      const observation = p0ByName.get(name);
      if (!observation || !["PASS", "FAIL", "NOT_APPLICABLE"].includes(observation.result) || !requiredText(observation.reason, `quality_p0_reason:${row.id}:${name}`) || !requiredText(observation.evidence_ref, `quality_p0_evidence:${row.id}:${name}`)) fail(`quality_p0_observation_invalid:${row.id}:${name}`);
      if (observation.result === "FAIL") p0Violations++;
    }
    for (const dimension of DIMENSIONS) {
      const grade = row.grader_raw_output.dimensions?.[dimension];
      const score = strictNumber(grade?.score, `quality_score:${row.id}:${dimension}`);
      if (score < 0 || score > 10) fail(`quality_score_range:${row.id}:${dimension}`);
      requiredText(grade?.reason, `quality_reason:${row.id}:${dimension}`);
      if (row.scores?.[dimension] !== score) fail(`quality_score_copy_mismatch:${row.id}:${dimension}`);
      totals[dimension] += score;
    }
    if (/^(?:sorry[, .]*|抱歉[，,。 ]*)?(?:i (?:cannot|can't) help|我(?:不能|無法|无法)協助|請稍後再試)[。.!]?$/i.test(row.response.trim()) && (row.scores?.resolution_and_progress ?? 0) >= 9) fail(`quality_generic_dead_end_overgraded:${row.id}`);
  }
  const averages = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, totals[dimension] / evidence.rows.length]));
  const weighted = DIMENSIONS.reduce((sum, dimension) => sum + averages[dimension] / 10 * strictNumber(rubric.weights?.[dimension], `quality_weight:${dimension}`), 0);
  for (const dimension of DIMENSIONS) {
    if (evidence.dimension_averages?.[dimension] !== averages[dimension]) fail(`quality_average_mismatch:${dimension}`);
    if (averages[dimension] < strictNumber(rubric.target?.dimension_average_min?.[dimension], `quality_target:${dimension}`)) fail(`quality_dimension_below_threshold:${dimension}:${averages[dimension]}`);
  }
  if (evidence.weighted_score !== weighted || weighted < strictNumber(rubric.target?.weighted_score_min, "quality_weighted_target")) fail(`quality_weighted_invalid:${weighted}`);
  if (evidence.critical_p0 !== p0Violations || p0Violations !== strictNumber(rubric.target?.critical_p0_allowed, "quality_p0_target")) fail(`quality_critical_p0:${p0Violations}`);
  return { pass: true, quality_status: "MEASURED", sample_count: evidence.rows.length, weighted_score: weighted, dimension_averages: averages, critical_p0: p0Violations };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => index % 2 === 0 ? [...pairs, [item.replace(/^--/, ""), all[index + 1]]] : pairs, []));
  const rubric = JSON.parse(fs.readFileSync(args.rubric, "utf8"));
  if (args.component) {
    const result = verifyComponentRegression(JSON.parse(fs.readFileSync(args.component, "utf8")));
    console.log(`C3_SERVICE_COMPONENT_VERIFIER|result=PASS|samples=${result.sample_count}|quality_score=NOT_MEASURED`);
    return;
  }
  const evidence = JSON.parse(fs.readFileSync(args.evidence, "utf8"));
  const result = verifyServiceQuality(evidence, rubric, { requireRuntime: true });
  console.log(`C3_SERVICE_QUALITY_VERIFIER|result=PASS|samples=${result.sample_count}|weighted_score=${result.weighted_score}|critical_p0=${result.critical_p0}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`C3_SERVICE_QUALITY_VERIFIER|result=FAIL|reason=${error.message}`); process.exitCode = 1; }
}
