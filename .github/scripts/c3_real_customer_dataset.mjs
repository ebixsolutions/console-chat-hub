#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.join(ROOT, "c3_real_customer_source_registry.json");
export const DATASET_PATH = path.join(ROOT, "c3_real_customer_heldout_dataset_v1.json");
export const FREEZE_PATH = path.join(ROOT, "c3_real_customer_freeze_manifest_v1.json");
export const HEX64 = /^[0-9a-f]{64}$/;
export const GIT40 = /^[0-9a-f]{40}$/;
const fail = (message) => { throw new Error(message); };
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : value;
export const canonicalJson = (value) => JSON.stringify(canonical(value));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const hashObject = (value) => sha256(Buffer.from(canonicalJson(value)));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const registryFields = ["source_id", "name", "publisher", "paper", "paper_url", "dataset_url", "dataset_version", "download_location", "license_or_terms", "paper_license", "real_human_dialogue_evidence", "pii_status", "restrictions", "status", "block_reason"];

export function verifySourceRegistry(registry) {
  if (registry.schema_version !== "c3-real-customer-source-registry-1.0.0") fail("registry_schema_invalid");
  if (registry.policy?.paper_license_is_dataset_license !== false || registry.policy?.blocked_sources_importable !== false) fail("registry_policy_invalid");
  if (!Array.isArray(registry.sources) || registry.sources.length < 4) fail("registry_sources_missing");
  const ids = new Set();
  for (const source of registry.sources) {
    for (const field of registryFields) if (!(field in source)) fail(`registry_field_missing:${source.source_id ?? "unknown"}:${field}`);
    if (!source.source_id || ids.has(source.source_id)) fail("registry_source_identity_invalid");
    if (!/^https:\/\//.test(source.paper_url) || !/^https:\/\//.test(source.dataset_url)) fail(`registry_url_invalid:${source.source_id}`);
    if (!["READY", "BLOCKED"].includes(source.status)) fail(`registry_status_invalid:${source.source_id}`);
    if (!Array.isArray(source.restrictions)) fail(`registry_restrictions_invalid:${source.source_id}`);
    if (source.status === "READY") {
      if (/unknown|unverified|not verified|no authoritative/i.test(`${source.license_or_terms} ${source.pii_status} ${source.download_location}`)) fail(`registry_ready_without_clearance:${source.source_id}`);
      if (source.restrictions.length) fail(`registry_ready_with_restrictions:${source.source_id}`);
      if (source.block_reason) fail(`registry_ready_with_block_reason:${source.source_id}`);
    } else if (!source.block_reason.trim()) fail(`registry_block_reason_missing:${source.source_id}`);
    ids.add(source.source_id);
  }
  return { source_count: ids.size, ready_count: registry.sources.filter((s) => s.status === "READY").length, blocked_count: registry.sources.filter((s) => s.status === "BLOCKED").length };
}

const normalize = (text) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tokens = (text) => normalize(text).split(/\s+/).filter(Boolean);
const shingles = (text) => {
  const value = tokens(text);
  const out = new Set();
  if (value.length < 2) return new Set(value);
  for (let i = 0; i < value.length - 1; i += 1) out.add(`${value[i]} ${value[i + 1]}`);
  return out;
};
const similarity = (left, right) => {
  const a = shingles(left), b = shingles(right);
  if (!a.size && !b.size) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
};
const conversationText = (row) => row.conversation.map((turn) => `${turn.speaker}:${turn.text}`).join("\n");
const PII = [
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
  ["phone", /(?:\+?\d[\s().-]*){8,}/],
  ["credit_card", /\b(?:\d[ -]*?){13,19}\b/],
  ["social_handle", /(^|\s)@[A-Za-z0-9_]{2,}/],
];

export function verifySourceBinding(row, sourceBytes, sourceRecordText) {
  if (!Buffer.isBuffer(sourceBytes)) fail(`source_binding_bytes_invalid:${row.case_id}`);
  if (!presentText(sourceRecordText) || !sourceBytes.includes(Buffer.from(sourceRecordText))) fail(`source_record_not_in_file:${row.case_id}`);
  if (sha256(sourceBytes) !== row.source_file_sha256) fail(`source_file_tamper:${row.case_id}`);
  if (sha256(Buffer.from(sourceRecordText)) !== row.source_record_sha256) fail(`source_record_tamper:${row.case_id}`);
  return true;
}

const presentText = (value) => typeof value === "string" && value.trim().length > 0;

export function verifyRealCustomerDataset(dataset, registry, { requireReady = false, semanticThreshold = 0.9 } = {}) {
  const registryResult = verifySourceRegistry(registry);
  if (dataset.schema_version !== "c3-real-customer-heldout-dataset-1.0.0") fail("dataset_schema_invalid");
  if (!["READY", "BLOCKED"].includes(dataset.status)) fail("dataset_status_invalid");
  if (dataset.quality_score !== "NOT_MEASURED" || dataset.held_out_real_customer !== true) fail("dataset_quality_classification_invalid");
  if (!Array.isArray(dataset.cases) || dataset.actual_case_count !== dataset.cases.length) fail("dataset_case_count_invalid");
  if (dataset.cases.length > 100) fail("dataset_over_target");
  if (requireReady && dataset.status !== "READY") fail("real_customer_dataset_blocked");
  const sources = new Map(registry.sources.map((source) => [source.source_id, source]));
  const ids = new Set(), dialogueBindings = new Set(), conversationHashes = new Set(), normalized = new Set();
  const bySource = new Map(), byFamily = new Map(), languages = new Set(), lengths = new Set();
  let ecommerce = 0;
  const texts = [];
  for (const row of dataset.cases) {
    if (!/^c3-rc-[0-9]{3}$/.test(row.case_id) || ids.has(row.case_id)) fail(`dataset_case_identity_invalid:${row.case_id}`);
    const source = sources.get(row.source_id);
    if (!source || source.status !== "READY") fail(`dataset_source_not_ready:${row.case_id}`);
    if (!row.dialogue_id || dialogueBindings.has(`${row.source_id}:${row.dialogue_id}`)) fail(`dataset_dialogue_reuse:${row.case_id}`);
    if (!HEX64.test(row.source_file_sha256) || !HEX64.test(row.source_record_sha256) || !HEX64.test(row.conversation_sha256)) fail(`dataset_source_hash_invalid:${row.case_id}`);
    if (conversationHashes.has(row.conversation_sha256)) fail(`dataset_exact_duplicate:${row.case_id}`);
    if (row.license_binding !== source.license_or_terms) fail(`dataset_license_binding_invalid:${row.case_id}`);
    if (!Array.isArray(row.conversation) || row.conversation.length < 2) fail(`dataset_conversation_invalid:${row.case_id}`);
    const speakers = new Set(row.conversation.map((turn) => turn.speaker));
    if (!speakers.has("customer") || !speakers.has("agent")) fail(`dataset_human_roles_invalid:${row.case_id}`);
    if (row.real_human_attestation !== "publisher_source_verified_customer_and_agent") fail(`dataset_human_attestation_invalid:${row.case_id}`);
    if (row.response !== undefined || row.grader !== undefined || row.human_review !== undefined) fail(`dataset_response_before_freeze:${row.case_id}`);
    if (!Array.isArray(row.transformation_log) || !row.transformation_log.length) fail(`dataset_transformation_log_invalid:${row.case_id}`);
    if (row.pii_review?.status !== "CLEARED" || !presentText(row.pii_review?.reviewer_provenance) || !presentText(row.pii_review?.method)) fail(`dataset_pii_review_missing:${row.case_id}`);
    if (row.original_language !== row.evaluation_language && (row.translation_review?.second_human_equivalence_verified !== true || !presentText(row.translation_review?.reviewer_provenance) || row.translation_review?.reviewer_id === row.translation_review?.translator_id)) fail(`dataset_translation_equivalence_missing:${row.case_id}`);
    if (!Array.isArray(row.oracle_facts) || !row.oracle_facts.length || !Array.isArray(row.p0_labels)) fail(`dataset_oracle_invalid:${row.case_id}`);
    if (!dataset.target.families.includes(row.family) || !dataset.target.lengths.includes(row.length) || !dataset.target.languages.includes(row.evaluation_language)) fail(`dataset_coverage_value_invalid:${row.case_id}`);
    const text = conversationText(row);
    for (const [kind, pattern] of PII) if (pattern.test(text)) fail(`dataset_pii_detected:${row.case_id}:${kind}`);
    if (hashObject(row.conversation) !== row.conversation_sha256) fail(`dataset_conversation_hash_mismatch:${row.case_id}`);
    const normalizedText = normalize(text);
    if (normalized.has(normalizedText)) fail(`dataset_exact_text_duplicate:${row.case_id}`);
    for (const prior of texts) if (similarity(text, prior.text) >= semanticThreshold) fail(`dataset_semantic_duplicate:${row.case_id}:${prior.id}`);
    ids.add(row.case_id); dialogueBindings.add(`${row.source_id}:${row.dialogue_id}`); conversationHashes.add(row.conversation_sha256); normalized.add(normalizedText); texts.push({ id: row.case_id, text });
    bySource.set(row.source_id, (bySource.get(row.source_id) ?? 0) + 1);
    byFamily.set(row.family, (byFamily.get(row.family) ?? 0) + 1);
    languages.add(row.evaluation_language); lengths.add(row.length);
    if (row.domain === "ecommerce") ecommerce += 1;
  }
  if (dataset.status === "READY") {
    if (dataset.cases.length !== 100) fail("dataset_ready_without_100_cases");
    if (bySource.size < 3 || Math.max(...bySource.values()) > 50) fail("dataset_corpus_distribution_invalid");
    if (ecommerce < 60) fail("dataset_ecommerce_coverage_invalid");
    for (const family of dataset.target.families) if (byFamily.get(family) !== 10) fail(`dataset_family_coverage_invalid:${family}`);
    for (const language of dataset.target.languages) if (!languages.has(language)) fail(`dataset_language_coverage_invalid:${language}`);
    for (const length of dataset.target.lengths) if (!lengths.has(length)) fail(`dataset_length_coverage_invalid:${length}`);
  } else {
    if (!dataset.block_reason?.trim()) fail("dataset_block_reason_missing");
    if (dataset.cases.length === 100) fail("dataset_blocked_with_complete_target");
  }
  return { status: dataset.status, actual_case_count: dataset.cases.length, registry: registryResult, corpus_count: bySource.size, ecommerce_count: ecommerce };
}

export function buildDataset(importManifest, registry, importDirectory = process.cwd()) {
  if (importManifest.schema_version !== "c3-real-customer-import-1.0.0" || !Array.isArray(importManifest.cases)) fail("import_manifest_invalid");
  const cases = importManifest.cases.map((input) => {
    if (!presentText(input.source_file_path) || !presentText(input.source_record_text)) fail(`import_source_binding_missing:${input.case_id ?? "unknown"}`);
    const file = path.resolve(importDirectory, input.source_file_path);
    const root = `${path.resolve(importDirectory)}${path.sep}`;
    if (!file.startsWith(root)) fail(`import_source_path_escape:${input.case_id}`);
    verifySourceBinding(input, fs.readFileSync(file), input.source_record_text);
    const row = { ...input };
    delete row.source_file_path;
    delete row.source_record_text;
    return row;
  });
  const dataset = { ...importManifest.dataset, actual_case_count: cases.length, cases };
  verifyRealCustomerDataset(dataset, registry, { requireReady: dataset.status === "READY" });
  return dataset;
}

export function createFreezeManifest(dataset, registry, candidate) {
  verifyRealCustomerDataset(dataset, registry, { requireReady: true });
  if (!GIT40.test(candidate.head) || !GIT40.test(candidate.tree)) fail("freeze_candidate_invalid");
  return {
    schema_version: "c3-real-customer-freeze-manifest-1.0.0",
    status: "READY",
    candidate,
    dataset_sha256: hashObject(dataset),
    registry_sha256: hashObject(registry),
    case_hashes: dataset.cases.map((row) => ({ case_id: row.case_id, sha256: hashObject(row) })),
    actual_case_count: dataset.cases.length,
    frozen_before_responses: true,
    response_count_at_freeze: 0,
    response_hashes: [],
    quality_score: "NOT_MEASURED",
    human_calibration: "AWAITING",
    product_ready: false,
  };
}

export function verifyFreezeManifest(manifest, dataset, registry, candidate) {
  if (manifest.schema_version !== "c3-real-customer-freeze-manifest-1.0.0" || manifest.status !== "READY") fail("freeze_manifest_not_ready");
  if (manifest.frozen_before_responses !== true || manifest.response_count_at_freeze !== 0 || manifest.response_hashes?.length) fail("freeze_response_contamination");
  if (manifest.dataset_sha256 !== hashObject(dataset) || manifest.registry_sha256 !== hashObject(registry)) fail("freeze_source_tamper");
  if (manifest.candidate?.head !== candidate.head || manifest.candidate?.tree !== candidate.tree) fail("freeze_cross_release");
  const expected = dataset.cases.map((row) => ({ case_id: row.case_id, sha256: hashObject(row) }));
  if (canonicalJson(manifest.case_hashes) !== canonicalJson(expected)) fail("freeze_case_tamper");
  verifyRealCustomerDataset(dataset, registry, { requireReady: true });
  return true;
}

export function verifyCommittedState() {
  const registry = readJson(REGISTRY_PATH), dataset = readJson(DATASET_PATH), freeze = readJson(FREEZE_PATH);
  const result = verifyRealCustomerDataset(dataset, registry);
  if (freeze.status !== "BLOCKED" || freeze.actual_case_count !== result.actual_case_count || freeze.quality_score !== "NOT_MEASURED" || freeze.human_calibration !== "AWAITING" || freeze.product_ready !== false) fail("blocked_freeze_status_invalid");
  return result;
}

const [command, input, output, head, tree] = process.argv.slice(2);
if (command === "verify-registry") console.log(JSON.stringify(verifySourceRegistry(readJson(input || REGISTRY_PATH))));
else if (command === "verify-dataset") console.log(JSON.stringify(verifyCommittedState()));
else if (command === "build") {
  if (!input || !output) fail("usage:build IMPORT_MANIFEST OUT");
  const dataset = buildDataset(readJson(input), readJson(REGISTRY_PATH), path.dirname(path.resolve(input)));
  fs.writeFileSync(output, `${JSON.stringify(dataset, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: dataset.status, actual_case_count: dataset.actual_case_count, output, sha256: hashObject(dataset) }));
}
else if (command === "freeze") {
  if (!input || !output || !head || !tree) fail("usage:freeze DATASET OUT HEAD TREE");
  const dataset = readJson(input), registry = readJson(REGISTRY_PATH);
  const manifest = createFreezeManifest(dataset, registry, { head, tree });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ status: "READY", output, sha256: hashObject(manifest) }));
} else if (command && import.meta.url === `file://${process.argv[1]}`) fail("unknown_command");
