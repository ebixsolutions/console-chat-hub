#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { DIMENSIONS } from "./c3_nonproduction_independent_grader.mjs";
import { GIT40, hashObject, HEX64 } from "./c3_real_customer_dataset.mjs";

const fail = (reason) => {
  throw new Error(reason);
};
const present = (value) => typeof value === "string" && value.trim().length > 0;
const forbiddenRoles = new Set([
  "implementation_agent",
  "dataset_builder",
  "coach_ai",
  "template_author",
  "rule_author",
]);

function identity(candidate, expected) {
  if (
    !candidate ||
    !GIT40.test(candidate.head) ||
    !GIT40.test(candidate.tree) ||
    candidate.head !== expected.head ||
    candidate.tree !== expected.tree
  )
    fail("deterministic_cross_release");
  if (
    !present(candidate.run_id) ||
    !Number.isInteger(candidate.run_attempt) ||
    candidate.run_attempt < 1
  )
    fail("deterministic_run_identity_invalid");
}

export function verifyObjectiveOracle({ dataset, overlay, freeze }) {
  if (
    overlay.schema_version !== "c3-deterministic-objective-oracle-1.0.0" ||
    freeze.schema_version !== "c3-deterministic-objective-freeze-1.0.0"
  )
    fail("objective_schema_invalid");
  if (
    dataset.source_type !== "DERIVED_ONLY" ||
    overlay.source_type !== "DERIVED_ONLY" ||
    overlay.evaluation_type !== "REAL_CASE_DERIVED_INTERIM"
  )
    fail("objective_evidence_type_invalid");
  if (
    overlay.dataset_sha256 !== hashObject(dataset) ||
    freeze.dataset_sha256 !== hashObject(dataset) ||
    freeze.overlay_sha256 !== hashObject(overlay)
  )
    fail("objective_freeze_binding_invalid");
  if (
    overlay.frozen_before_responses !== true ||
    overlay.responses_at_freeze !== 0 ||
    freeze.responses_at_freeze !== 0
  )
    fail("objective_response_before_freeze");
  if (
    overlay.quality_score !== "NOT_MEASURED" ||
    overlay.quality_denominator_eligible !== false ||
    freeze.quality_score !== "NOT_MEASURED" ||
    freeze.product_ready !== false
  )
    fail("objective_quality_gate_weakened");
  if (
    !Array.isArray(dataset.cases) ||
    dataset.cases.length !== 100 ||
    !Array.isArray(overlay.cases) ||
    overlay.cases.length !== 100
  )
    fail("objective_case_count_invalid");
  const source = new Map(dataset.cases.map((row) => [row.case_id, row]));
  const seen = new Set(),
    endpoints = new Map();
  for (const row of overlay.cases) {
    if (
      !source.has(row.case_id) ||
      seen.has(row.case_id) ||
      row.case_sha256 !== hashObject(source.get(row.case_id))
    )
      fail(`objective_case_binding_invalid:${row.case_id}`);
    if (row.expected_intent !== source.get(row.case_id).category) {
      fail(`objective_intent_not_source_bound:${row.case_id}`);
    }
    if (!["generate-reply", "agent-assist"].includes(row.endpoint)) {
      fail(`objective_endpoint_invalid:${row.case_id}`);
    }
    if (
      !Array.isArray(row.p0_prohibitions) ||
      row.p0_prohibitions.length < 9 ||
      !Array.isArray(row.forbidden_state_transitions) ||
      !present(row.acceptable_handoff)
    )
      fail(`objective_oracle_incomplete:${row.case_id}`);
    endpoints.set(row.endpoint, (endpoints.get(row.endpoint) ?? 0) + 1);
    seen.add(row.case_id);
  }
  if (endpoints.get("generate-reply") !== 50 || endpoints.get("agent-assist") !== 50)
    fail("objective_endpoint_distribution_invalid");
  return {
    case_count: 100,
    generate_reply: 50,
    agent_assist: 50,
    dataset_sha256: hashObject(dataset),
    overlay_sha256: hashObject(overlay),
    quality_score: "NOT_MEASURED",
  };
}

export function verifyObjectiveRuntime({ runtime, dataset, overlay, freeze, expectedCandidate }) {
  verifyObjectiveOracle({ dataset, overlay, freeze });
  if (
    runtime.schema_version !== "c3-deterministic-objective-runtime-1.0.0" ||
    runtime.evidence_type !== "DETERMINISTIC_CONFORMANCE_ONLY"
  )
    fail("objective_runtime_schema_invalid");
  identity(runtime.candidate, expectedCandidate);
  if (
    runtime.dataset_sha256 !== hashObject(dataset) ||
    runtime.overlay_sha256 !== hashObject(overlay)
  )
    fail("objective_runtime_release_binding_invalid");
  if (
    !runtime.engine ||
    !HEX64.test(runtime.engine.rule_pack_sha256) ||
    !HEX64.test(runtime.engine.template_pack_sha256) ||
    !HEX64.test(runtime.engine.fts_source_sha256) ||
    runtime.engine.external_model_calls !== 0 ||
    runtime.engine.external_api_cost_usd !== "0.00"
  )
    fail("objective_engine_identity_invalid");
  if ("weighted_score" in runtime || "quality_score" in runtime || "pass" in runtime)
    fail("objective_quality_aggregate_forbidden");
  if (!Array.isArray(runtime.observations) || runtime.observations.length !== 100)
    fail("objective_runtime_count_invalid");
  const oracles = new Map(overlay.cases.map((row) => [row.case_id, row]));
  const seen = new Set(),
    responseHashes = new Set();
  let conforming = 0;
  for (const row of runtime.observations) {
    const oracle = oracles.get(row.case_id);
    if (!oracle || seen.has(row.case_id)) {
      fail("objective_duplicate_replay_or_unknown_case");
    }
    for (const field of ["case_sha256", "request_sha256", "context_sha256", "response_sha256"]) {
      if (!HEX64.test(row[field])) {
        fail(`objective_hash_invalid:${row.case_id}:${field}`);
      }
    }
    if (
      row.case_sha256 !== oracle.case_sha256 ||
      hashObject(row.request) !== row.request_sha256 ||
      hashObject(row.context) !== row.context_sha256 ||
      hashObject(row.response) !== row.response_sha256
    )
      fail(`objective_response_substitution:${row.case_id}`);
    if (responseHashes.has(row.response_sha256)) {
      fail(`objective_duplicate_response:${row.case_id}`);
    }
    if (
      row.endpoint !== oracle.endpoint ||
      row.intent !== oracle.expected_intent ||
      !oracle.eligible_actions.includes(row.action)
    )
      fail(`objective_decision_nonconformant:${row.case_id}`);
    if (
      !Array.isArray(row.p0_labels) ||
      row.p0_labels.some((label) => !oracle.p0_prohibitions.includes(label))
    )
      fail(`objective_p0_invalid:${row.case_id}`);
    if (
      row.p0_labels.length === 0 &&
      row.forbidden_transition_count === 0 &&
      row.cross_tenant_access === false &&
      row.unapproved_template_used === false
    )
      conforming += 1;
    seen.add(row.case_id);
    responseHashes.add(row.response_sha256);
  }
  if (seen.size !== 100) fail("objective_coverage_incomplete");
  return {
    evidence_type: "DETERMINISTIC_CONFORMANCE_ONLY",
    case_count: 100,
    conforming_case_count: conforming,
    objective_conformance: conforming === 100,
    quality_score: "NOT_MEASURED",
    product_ready: false,
  };
}

export function generateFullBlindPacket({
  dataset,
  runtime,
  rubric,
  packetId = crypto.randomUUID(),
}) {
  if (!Array.isArray(runtime.observations) || runtime.observations.length !== 100)
    fail("full_blind_requires_100_responses");
  const cases = new Map(dataset.cases.map((row) => [row.case_id, row]));
  const seen = new Set();
  const samples = runtime.observations.map((row) => {
    if (
      !cases.has(row.case_id) ||
      seen.has(row.case_id) ||
      row.case_sha256 !== hashObject(cases.get(row.case_id))
    )
      fail(`full_blind_case_binding_invalid:${row.case_id}`);
    if (
      row.context_sha256 !== hashObject(row.context) ||
      row.response_sha256 !== hashObject(row.response)
    )
      fail(`full_blind_response_substitution:${row.case_id}`);
    seen.add(row.case_id);
    return {
      sample_id: crypto.randomUUID(),
      case_id: row.case_id,
      case_sha256: row.case_sha256,
      context: row.context,
      context_sha256: row.context_sha256,
      response: row.response,
      response_sha256: row.response_sha256,
      rubric_sha256: hashObject(rubric),
      dimensions: DIMENSIONS,
    };
  });
  return {
    schema_version: "c3-deterministic-full-human-blind-packet-1.0.0",
    packet_id: packetId,
    evidence_type: "DERIVED_ONLY_HUMAN_QUALITY",
    blindness: {
      candidate_engine_identity_hidden: true,
      objective_verifier_hidden: true,
      other_reviewers_hidden: true,
      expected_results_hidden: true,
      oracle_labels_hidden: true,
    },
    samples,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function verifyFullHumanReview({ artifact, packet, expectedCandidate, rubric }) {
  if (
    artifact.schema_version !== "c3-deterministic-full-human-review-1.0.0" ||
    packet.schema_version !== "c3-deterministic-full-human-blind-packet-1.0.0"
  )
    fail("full_human_schema_invalid");
  identity(artifact.candidate, expectedCandidate);
  if (
    artifact.packet_sha256 !== hashObject(packet) ||
    artifact.rubric_sha256 !== hashObject(rubric)
  )
    fail("full_human_packet_or_rubric_tamper");
  if (
    !Object.values(packet.blindness).every((value) => value === true) ||
    !Array.isArray(packet.samples) ||
    packet.samples.length !== 100
  )
    fail("full_human_blindness_or_coverage_invalid");
  for (const forbidden of [
    "weighted_score",
    "dimension_scores",
    "aggregate",
    "pass",
    "quality_gate",
  ]) {
    if (forbidden in artifact) {
      fail(`full_human_self_aggregate_forbidden:${forbidden}`);
    }
  }
  if (!Array.isArray(artifact.reviewers) || artifact.reviewers.length < 2) {
    fail("full_human_reviewer_count_invalid");
  }
  const reviewers = new Map();
  for (const reviewer of artifact.reviewers) {
    if (
      !present(reviewer.reviewer_id) ||
      reviewers.has(reviewer.reviewer_id) ||
      reviewer.human_attestation !== true ||
      !present(reviewer.provenance) ||
      forbiddenRoles.has(reviewer.role)
    )
      fail("full_human_reviewer_provenance_invalid");
    if (
      !Array.isArray(reviewer.excluded_roles_attestation) ||
      [...forbiddenRoles].some((role) => !reviewer.excluded_roles_attestation.includes(role))
    )
      fail(`full_human_reviewer_independence_missing:${reviewer.reviewer_id}`);
    reviewers.set(reviewer.reviewer_id, reviewer);
  }
  if (!Array.isArray(artifact.reviews) || artifact.reviews.length < 200) {
    fail("full_human_requires_200_records");
  }
  const samples = new Map(packet.samples.map((row) => [row.sample_id, row]));
  const grouped = new Map(),
    reviewIds = new Set();
  for (const review of artifact.reviews) {
    const sample = samples.get(review.sample_id);
    if (!sample || !reviewers.has(review.reviewer_id) || reviewIds.has(review.review_id))
      fail("full_human_review_identity_invalid");
    if (
      review.case_sha256 !== sample.case_sha256 ||
      review.response_sha256 !== sample.response_sha256 ||
      review.rubric_sha256 !== sample.rubric_sha256
    )
      fail(`full_human_review_binding_invalid:${review.review_id}`);
    if (
      review.human_submitted !== true ||
      review.blind_attestation !== true ||
      !/^\d{4}-\d{2}-\d{2}T/.test(review.timestamp) ||
      !present(review.reason) ||
      review.reason.trim().split(/\s+/).length < 4
    )
      fail(`full_human_review_provenance_invalid:${review.review_id}`);
    if (
      !review.scores ||
      Object.keys(review.scores).sort().join("|") !== [...DIMENSIONS].sort().join("|")
    )
      fail(`full_human_dimensions_invalid:${review.review_id}`);
    for (const dimension of DIMENSIONS) {
      if (
        !Number.isFinite(review.scores[dimension]) ||
        review.scores[dimension] < 0 ||
        review.scores[dimension] > 10
      )
        fail(`full_human_score_invalid:${review.review_id}:${dimension}`);
    }
    if (
      !Array.isArray(review.p0_labels) ||
      review.p0_labels.some((label) => !rubric.critical_p0.includes(label)) ||
      !["PASS", "FAIL"].includes(review.recommendation)
    )
      fail(`full_human_outcome_invalid:${review.review_id}`);
    const rows = grouped.get(review.sample_id) ?? [];
    if (rows.some((row) => row.reviewer_id === review.reviewer_id)) {
      fail(`full_human_duplicate_reviewer_sample:${review.sample_id}`);
    }
    rows.push(review);
    grouped.set(review.sample_id, rows);
    reviewIds.add(review.review_id);
  }
  const sums = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  let p0 = 0;
  for (const sample of packet.samples) {
    const rows = grouped.get(sample.sample_id) ?? [];
    if (rows.length < 2) {
      fail(`full_human_sample_under_reviewed:${sample.sample_id}`);
    }
    const [first, second] = rows;
    const conflict =
      DIMENSIONS.some(
        (dimension) => Math.abs(first.scores[dimension] - second.scores[dimension]) > 2,
      ) ||
      first.recommendation !== second.recommendation ||
      [...new Set([...first.p0_labels, ...second.p0_labels])].some(
        (label) => first.p0_labels.includes(label) !== second.p0_labels.includes(label),
      );
    if (
      conflict &&
      (rows.length < 3 ||
        rows[2].adjudicator !== true ||
        rows[2].reviewer_id === first.reviewer_id ||
        rows[2].reviewer_id === second.reviewer_id)
    ) {
      fail(`full_human_third_blind_adjudicator_required:${sample.sample_id}`);
    }
    for (const dimension of DIMENSIONS) {
      sums[dimension] += conflict
        ? median(rows.slice(0, 3).map((row) => row.scores[dimension]))
        : (first.scores[dimension] + second.scores[dimension]) / 2;
    }
    p0 += new Set(rows.flatMap((row) => row.p0_labels)).size;
  }
  const dimensionScores = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, Number((sums[dimension] / 100).toFixed(6))]),
  );
  const weightedScore = Number(
    (
      DIMENSIONS.reduce(
        (total, dimension) => total + dimensionScores[dimension] * rubric.weights[dimension],
        0,
      ) / 10
    ).toFixed(6),
  );
  const pass =
    weightedScore >= rubric.target.weighted_score_min &&
    p0 === 0 &&
    DIMENSIONS.every(
      (dimension) => dimensionScores[dimension] >= rubric.target.dimension_average_min[dimension],
    );
  return {
    evidence_type: "DERIVED_ONLY_HUMAN_QUALITY_VERIFIED",
    case_count: 100,
    review_count: artifact.reviews.length,
    reviewer_count: reviewers.size,
    weighted_score: weightedScore,
    dimension_scores: dimensionScores,
    critical_p0_count: p0,
    pass,
    a_class_ready: false,
    product_ready: false,
  };
}

const [command, ...args] = process.argv.slice(2);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
if (command === "verify-oracle") {
  const [datasetPath, overlayPath, freezePath] = args;
  console.log(
    JSON.stringify({
      result: "PASS",
      ...verifyObjectiveOracle({
        dataset: read(datasetPath),
        overlay: read(overlayPath),
        freeze: read(freezePath),
      }),
    }),
  );
} else if (command === "packet") {
  const [datasetPath, runtimePath, rubricPath, outputPath] = args;
  const packet = generateFullBlindPacket({
    dataset: read(datasetPath),
    runtime: read(runtimePath),
    rubric: read(rubricPath),
  });
  fs.writeFileSync(outputPath, `${JSON.stringify(packet, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      status: "AWAITING_200_HUMAN_REVIEWS",
      packet_sha256: hashObject(packet),
    }),
  );
} else if (command === "verify-human") {
  const [artifactPath, packetPath, rubricPath, expectedHead, expectedTree] = args;
  console.log(
    JSON.stringify({
      result: "PASS",
      ...verifyFullHumanReview({
        artifact: read(artifactPath),
        packet: read(packetPath),
        rubric: read(rubricPath),
        expectedCandidate: { head: expectedHead, tree: expectedTree },
      }),
    }),
  );
} else if (command && import.meta.url === `file://${process.argv[1]}`) {
  fail("unsupported_command");
}
