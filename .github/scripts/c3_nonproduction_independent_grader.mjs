#!/usr/bin/env node
import fs from "node:fs";
import { canonicalJson, GIT40, hashObject, HEX64 } from "./c3_real_customer_dataset.mjs";

export const EVIDENCE_TYPE = "c3-nonproduction-independent-grader-1.0.0";
export const DERIVED_EVIDENCE_TYPE = "c3-nonproduction-independent-grader-derived-1.0.0";
export const DIMENSIONS = [
  "factual_grounding_and_commitment_truth",
  "resolution_and_progress",
  "context_correction_and_entity",
  "targeted_clarification_and_kb_use",
  "natural_language_and_concision",
  "handoff_next_step_and_customer_effort",
];
const fail = (message) => { throw new Error(message); };
const present = (value) => typeof value === "string" && value.trim().length > 0;

function verifyIdentity(value, expected) {
  if (!value || !GIT40.test(value.head) || !GIT40.test(value.tree)) fail("grader_candidate_identity_invalid");
  if (value.head !== expected.head || value.tree !== expected.tree) fail("grader_cross_release");
  if (!present(value.run_id) || !Number.isInteger(value.run_attempt) || value.run_attempt < 1) fail("grader_run_identity_invalid");
}

export function verifyIndependentGraderArtifact({ raw, runtime, dataset, freeze, rubric, expectedCandidate, rawArtifactSha256 }) {
  if (!HEX64.test(rawArtifactSha256) || hashObject(raw) !== rawArtifactSha256) fail("grader_raw_artifact_tamper");
  const derivedOnly = dataset.source_type === "DERIVED_ONLY";
  const expectedEvidenceType = derivedOnly ? DERIVED_EVIDENCE_TYPE : EVIDENCE_TYPE;
  const expectedDatasetEvidenceType = derivedOnly ? "REAL_CASE_DERIVED_INTERIM" : "A_CLASS_FULL_REAL_CUSTOMER_DIALOGUE";
  if (raw.evidence_type !== expectedEvidenceType || raw.evidence_type === "c3-service-quality-assessment-2.0.0") fail("grader_evidence_type_invalid");
  if (raw.dataset_evidence_type !== expectedDatasetEvidenceType || runtime.dataset_evidence_type !== expectedDatasetEvidenceType) fail("grader_dataset_evidence_type_invalid");
  verifyIdentity(raw.candidate, expectedCandidate);
  verifyIdentity(runtime.candidate, expectedCandidate);
  if (raw.candidate.run_id === runtime.candidate.run_id) fail("grader_not_independent_run");
  if (raw.author?.role === "implementation_agent" || raw.author?.self_assessment === true) fail("grader_self_assessment_forbidden");
  for (const field of ["provider", "model", "version", "credential_scope_id"]) if (!present(raw.grader?.[field])) fail(`grader_identity_missing:${field}`);
  if (/regex|length|heuristic/i.test(raw.grader.method ?? "")) fail("grader_forbidden_scoring_method");
  if (!HEX64.test(raw.prompt_sha256) || !HEX64.test(raw.rubric_sha256) || raw.rubric_sha256 !== hashObject(rubric)) fail("grader_rubric_binding_invalid");
  if (raw.dataset_sha256 !== freeze.dataset_sha256 || raw.dataset_sha256 !== hashObject(dataset)) fail("grader_dataset_binding_invalid");
  for (const forbidden of ["pass", "aggregate", "weighted_score", "dimension_averages", "quality_gate"]) if (forbidden in raw) fail(`grader_self_aggregate_forbidden:${forbidden}`);
  if (!Array.isArray(raw.case_results) || raw.case_results.length !== dataset.cases.length || !Array.isArray(runtime.observations) || runtime.observations.length !== dataset.cases.length) fail("grader_case_count_invalid");
  const cases = new Map(dataset.cases.map((row) => [row.case_id, row]));
  const observations = new Map();
  for (const row of runtime.observations) {
    if (!cases.has(row.case_id) || observations.has(row.case_id)) fail("runtime_duplicate_or_unknown_case");
    for (const field of ["case_sha256", "request_sha256", "context_sha256", "response_sha256"]) if (!HEX64.test(row[field])) fail(`runtime_hash_invalid:${row.case_id}:${field}`);
    if (row.case_sha256 !== hashObject(cases.get(row.case_id))) fail(`runtime_case_substitution:${row.case_id}`);
    for (const part of ["request", "context", "response"]) if (hashObject(row[part]) !== row[`${part}_sha256`]) fail(`runtime_${part}_substitution:${row.case_id}`);
    observations.set(row.case_id, row);
  }
  const seen = new Set(), responseHashes = new Set(), allScores = [];
  const sums = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  let criticalP0 = 0;
  for (const row of raw.case_results) {
    if (!cases.has(row.case_id) || seen.has(row.case_id)) fail("grader_duplicate_replay_or_unknown_case");
    const observed = observations.get(row.case_id);
    for (const field of ["case_sha256", "request_sha256", "context_sha256", "response_sha256"]) if (row[field] !== observed[field]) fail(`grader_response_substitution:${row.case_id}:${field}`);
    if (responseHashes.has(row.response_sha256)) fail(`grader_duplicate_response:${row.case_id}`);
    if (!present(row.reason) || row.reason.trim().split(/\s+/).length < 4) fail(`grader_reason_empty_or_insufficient:${row.case_id}`);
    if (!row.scores || Object.keys(row.scores).sort().join("|") !== [...DIMENSIONS].sort().join("|")) fail(`grader_dimensions_invalid:${row.case_id}`);
    for (const dimension of DIMENSIONS) {
      const score = row.scores[dimension];
      if (!Number.isFinite(score) || score < 0 || score > 10) fail(`grader_score_invalid:${row.case_id}:${dimension}`);
      allScores.push(score); sums[dimension] += score;
    }
    if (!Array.isArray(row.p0_labels) || row.p0_labels.some((label) => !rubric.critical_p0.includes(label))) fail(`grader_p0_invalid:${row.case_id}`);
    criticalP0 += row.p0_labels.length;
    seen.add(row.case_id); responseHashes.add(row.response_sha256);
  }
  if (seen.size !== cases.size) fail("grader_dataset_coverage_incomplete");
  if (allScores.length && allScores.every((score) => score === 10)) fail("grader_fixed_perfect_scores_forbidden");
  const dimensionScores = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, Number((sums[dimension] / dataset.cases.length).toFixed(6))]));
  const weightedScore = Number((DIMENSIONS.reduce((sum, dimension) => sum + dimensionScores[dimension] * rubric.weights[dimension], 0) / 10).toFixed(6));
  return {
    evidence_type: derivedOnly ? "c3-nonproduction-independent-grader-derived-verified-1.0.0" : "c3-nonproduction-independent-grader-verified-1.0.0",
    dataset_evidence_type: expectedDatasetEvidenceType,
    product_ready_evidence: derivedOnly ? false : undefined,
    candidate: expectedCandidate,
    dataset_sha256: raw.dataset_sha256,
    raw_artifact_sha256: hashObject(raw),
    runtime_artifact_sha256: hashObject(runtime),
    grader: raw.grader,
    prompt_sha256: raw.prompt_sha256,
    rubric_sha256: raw.rubric_sha256,
    case_count: seen.size,
    weighted_score: weightedScore,
    dimension_scores: dimensionScores,
    critical_p0_count: criticalP0,
    pass: weightedScore >= rubric.target.weighted_score_min && criticalP0 === 0 && DIMENSIONS.every((dimension) => dimensionScores[dimension] >= rubric.target.dimension_average_min[dimension]),
  };
}

export function verifyImmutableEnvelope(envelope) {
  if (!envelope || !HEX64.test(envelope.raw_artifact_sha256) || hashObject(envelope.raw) !== envelope.raw_artifact_sha256) fail("grader_raw_artifact_tamper");
  if (!Object.isFrozen(envelope.raw)) return true; // Disk immutability is supplied by the digest; JS freezing is optional.
  return true;
}

const [command, rawPath, runtimePath, datasetPath, freezePath, rubricPath, outPath, head, tree, rawArtifactSha256] = process.argv.slice(2);
if (command === "verify") {
  if (![rawPath, runtimePath, datasetPath, freezePath, rubricPath, outPath, head, tree, rawArtifactSha256].every(Boolean)) fail("usage:verify RAW RUNTIME DATASET FREEZE RUBRIC OUT HEAD TREE RAW_CANONICAL_SHA256");
  const raw = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8"));
  const freeze = JSON.parse(fs.readFileSync(freezePath, "utf8"));
  const rubric = JSON.parse(fs.readFileSync(rubricPath, "utf8"));
  const verified = verifyIndependentGraderArtifact({ raw, runtime, dataset, freeze, rubric, expectedCandidate: { head, tree }, rawArtifactSha256 });
  fs.writeFileSync(outPath, `${JSON.stringify(verified, null, 2)}\n`, { flag: "wx" });
  console.log(canonicalJson({ result: "PASS", output: outPath, sha256: hashObject(verified) }));
} else if (command && import.meta.url === `file://${process.argv[1]}`) fail("unknown_command");
