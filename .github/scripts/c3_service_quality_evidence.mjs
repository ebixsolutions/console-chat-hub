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
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

export function verifyHumanCalibration(calibration, { requireCompleted = false } = {}) {
  if (!calibration || calibration.version !== "c3-service-quality-human-calibration-2026-09-16.2") fail("human_calibration_version_invalid");
  if (!Array.isArray(calibration.samples) || calibration.samples.length < 20) fail("human_calibration_sample_count_invalid");
  for (const row of calibration.samples) {
    for (const key of ["id", "family", "customer_context", "customer_turn", "actual_response_or_action", "source_binding"]) {
      if (typeof row[key] !== "string" || !row[key].trim()) fail(`human_calibration_sample_missing:${row.id ?? "unknown"}:${key}`);
    }
    if (!/^[0-9a-f]{64}$/.test(row.response_sha256) || sha(row.actual_response_or_action) !== row.response_sha256) fail(`human_calibration_hash_invalid:${row.id}`);
    if (!Array.isArray(row.coverage) || row.coverage.length === 0) fail(`human_calibration_coverage_missing:${row.id}`);
  }
  const coverage = new Set(calibration.samples.flatMap((row) => row.coverage));
  for (const required of ["emotion", "entitlement", "handoff"]) if (!coverage.has(required)) fail(`human_calibration_coverage_missing:${required}`);
  if (requireCompleted) {
    if (calibration.status !== "COMPLETED") fail("human_calibration_incomplete");
    if (!Array.isArray(calibration.reviews) || calibration.reviews.length < 20) fail("human_calibration_reviews_missing");
    for (const review of calibration.reviews) {
      if (!review.blinded || typeof review.reviewer_id !== "string" || !review.reviewer_id.trim()) fail(`human_review_identity_or_blinding_missing:${review.sample_id ?? "unknown"}`);
      for (const dimension of DIMENSIONS) if (!(Number(review.scores?.[dimension]) >= 0 && Number(review.scores?.[dimension]) <= 10)) fail(`human_review_score_invalid:${review.sample_id}:${dimension}`);
    }
  } else if (!['AWAITING_HUMAN_CALIBRATION', 'COMPLETED'].includes(calibration.status)) fail("human_calibration_status_invalid");
  return { status: calibration.status, samples: calibration.samples.length };
}

export function verifyServiceQuality(evidence, rubric, { requireRuntime = false } = {}) {
  if (!evidence || evidence.schema_version !== "c3-service-quality-evidence-1.0.0") fail("quality_evidence_schema_invalid");
  if (requireRuntime && evidence.mode !== "live_production_runtime") fail("quality_evidence_not_live_runtime");
  if (!requireRuntime && evidence.mode !== "independent_held_out_nonproduction") fail("quality_evidence_not_nonproduction_held_out");
  if (!Array.isArray(evidence.rows) || evidence.rows.length < 100 || evidence.sample_count !== evidence.rows.length) fail("quality_evidence_sample_count_invalid");
  if (evidence.deterministic_samples_included !== false) fail("deterministic_cases_must_not_be_held_out");
  const ids = evidence.rows.map((row) => row.id);
  if (new Set(ids).size !== ids.length) fail("quality_evidence_duplicate_id");
  const totals = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  let criticalP0 = 0;
  for (const row of evidence.rows) {
    if (typeof row.response !== "string" || sha(row.response) !== row.response_sha256) fail(`quality_response_hash_mismatch:${row.id}`);
    if (requireRuntime && (!row.customer_source_message_id || !row.assistant_message_id || row.measurement_source !== "runtime_readback")) fail(`quality_runtime_binding_missing:${row.id}`);
    for (const dimension of DIMENSIONS) {
      const checks = row.assertions?.[dimension];
      if (!Array.isArray(checks) || checks.length === 0 || checks.some((check) => typeof check.name !== "string" || typeof check.pass !== "boolean")) fail(`quality_assertions_invalid:${row.id}:${dimension}`);
      const score = 10 * checks.filter((check) => check.pass).length / checks.length;
      if (Number(row.scores?.[dimension]) !== score) fail(`quality_score_not_derived:${row.id}:${dimension}`);
      totals[dimension] += score;
      criticalP0 += checks.filter((check) => check.critical_p0 === true && check.pass === false).length;
    }
  }
  const averages = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, totals[dimension] / evidence.rows.length]));
  const weighted = DIMENSIONS.reduce((sum, dimension) => sum + averages[dimension] / 10 * Number(rubric.weights?.[dimension]), 0);
  for (const dimension of DIMENSIONS) {
    if (Number(evidence.dimension_averages?.[dimension]) !== averages[dimension]) fail(`quality_average_not_derived:${dimension}`);
    if (averages[dimension] < Number(rubric.target.dimension_average_min?.[dimension])) fail(`quality_dimension_below_threshold:${dimension}:${averages[dimension]}`);
  }
  if (Number(evidence.weighted_score) !== weighted) fail("quality_weighted_score_not_derived");
  if (weighted < Number(rubric.target.weighted_score_min)) fail(`quality_weighted_below_threshold:${weighted}`);
  if (evidence.critical_p0 !== criticalP0 || criticalP0 !== Number(rubric.target.critical_p0_allowed)) fail(`quality_critical_p0:${criticalP0}`);
  return { pass: true, sample_count: evidence.rows.length, weighted_score: weighted, dimension_averages: averages, critical_p0: criticalP0 };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) => index % 2 === 0 ? [...pairs, [item.replace(/^--/, ""), all[index + 1]]] : pairs, []));
  const evidence = JSON.parse(fs.readFileSync(args.evidence, "utf8"));
  const rubric = JSON.parse(fs.readFileSync(args.rubric, "utf8"));
  const calibration = JSON.parse(fs.readFileSync(args.calibration, "utf8"));
  const result = verifyServiceQuality(evidence, rubric, { requireRuntime: args.phase === "production" });
  const human = verifyHumanCalibration(calibration, { requireCompleted: args.phase === "production" });
  console.log(`C3_SERVICE_QUALITY_VERIFIER|result=PASS|samples=${result.sample_count}|weighted_score=${result.weighted_score}|critical_p0=${result.critical_p0}|human_calibration=${human.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`C3_SERVICE_QUALITY_VERIFIER|result=FAIL|reason=${error.message}`); process.exitCode = 1; }
}
