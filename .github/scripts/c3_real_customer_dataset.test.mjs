#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DATASET_PATH,
  REGISTRY_PATH,
  createFreezeManifest,
  hashObject,
  sha256,
  verifyCommittedState,
  verifyFreezeManifest,
  verifyRealCustomerDataset,
  verifySourceBinding,
  verifySourceRegistry,
} from "./c3_real_customer_dataset.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const expectThrow = (fn, pattern) => assert.throws(fn, pattern);
const clone = (value) => structuredClone(value);
const families = ["shipping", "returns", "warranty", "calculation", "context", "knowledge", "emotion", "clarification", "handoff", "entitlement"];
const languages = ["zh-Hant-HK", "yue-Hant-HK", "en", "mixed-zh-en"];
const lengths = ["short", "medium", "long"];

function readyRegistry() {
  return {
    schema_version: "c3-real-customer-source-registry-1.0.0",
    policy: { paper_license_is_dataset_license: false, blocked_sources_importable: false },
    sources: ["a", "b", "c", "d"].map((id) => ({
      source_id: `test-${id}`, name: `Test ${id}`, publisher: "Test publisher", paper: "Test-only source contract", paper_url: `https://example.invalid/paper-${id}`, dataset_url: `https://example.invalid/data-${id}`, dataset_version: "test-v1", download_location: "Test fixture embedded in unit test", license_or_terms: "TEST-DATA-LICENSE", paper_license: "TEST-PAPER-LICENSE", real_human_dialogue_evidence: "Test-only schema control; never quality evidence", pii_status: "CLEARED_TEST_ONLY", restrictions: [], status: "READY", block_reason: "",
    })),
  };
}

function readyDataset() {
  const cases = Array.from({ length: 100 }, (_, index) => {
    const n = index + 1;
    const conversation = [
      { speaker: "customer", text: `Unit test customer utterance unique${n} item${n} situation${n} request${n}.` },
      { speaker: "agent", text: `Unit test agent response unique${n} action${n} resolution${n} followup${n}.` },
    ];
    return {
      case_id: `c3-rc-${String(n).padStart(3, "0")}`,
      source_id: `test-${["a", "b", "c"][index % 3]}`,
      dialogue_id: `dialogue-${n}`,
      source_file_sha256: hashObject({ source: n }),
      source_record_sha256: hashObject(`source-record-${n}`),
      conversation_sha256: hashObject(conversation),
      license_binding: "TEST-DATA-LICENSE",
      original_language: languages[index % languages.length],
      evaluation_language: languages[index % languages.length],
      transformation_log: ["unit_test_fixture_only"],
      pii_review: { status: "CLEARED", reviewer_provenance: "unit-test-only reviewer", method: "unit-test control" },
      oracle_facts: [`test-fact-${n}`],
      p0_labels: [],
      real_human_attestation: "publisher_source_verified_customer_and_agent",
      conversation,
      family: families[index % families.length],
      domain: index < 60 ? "ecommerce" : "customer_service",
      length: lengths[index % lengths.length],
    };
  });
  return {
    schema_version: "c3-real-customer-heldout-dataset-1.0.0", status: "READY", quality_score: "NOT_MEASURED", held_out_real_customer: true,
    target: { case_count: 100, minimum_corpora: 3, maximum_cases_per_corpus: 50, minimum_ecommerce_cases: 60, families, cases_per_family: 10, languages, lengths },
    actual_case_count: cases.length, cases,
  };
}

const committedRegistry = read(REGISTRY_PATH);
const committedDataset = read(DATASET_PATH);
const registryResult = verifySourceRegistry(committedRegistry);
assert.equal(registryResult.ready_count, 0);
assert.equal(registryResult.blocked_count, 5);
assert.deepEqual(verifyCommittedState().actual_case_count, 0);
assert.equal(committedDataset.status, "BLOCKED");

const registry = readyRegistry(), dataset = readyDataset();
assert.equal(verifyRealCustomerDataset(dataset, registry, { requireReady: true }).actual_case_count, 100);
const sourceBytes = Buffer.from("prefix source-record-1 suffix");
const sourceBound = clone(dataset.cases[0]); sourceBound.source_file_sha256 = sha256(sourceBytes); sourceBound.source_record_sha256 = sha256(Buffer.from("source-record-1"));
assert.equal(verifySourceBinding(sourceBound, sourceBytes, "source-record-1"), true);
expectThrow(() => verifySourceBinding(sourceBound, Buffer.from("tampered source-record-1"), "source-record-1"), /source_file_tamper/);
const candidate = { head: "1".repeat(40), tree: "2".repeat(40) };
const freeze = createFreezeManifest(dataset, registry, candidate);
assert.equal(verifyFreezeManifest(freeze, dataset, registry, candidate), true);

const license = clone(dataset); license.cases[0].license_binding = "WRONG";
expectThrow(() => verifyRealCustomerDataset(license, registry), /dataset_license_binding_invalid/);
const pii = clone(dataset); pii.cases[0].conversation[0].text = "Contact person@example.com for this order"; pii.cases[0].conversation_sha256 = hashObject(pii.cases[0].conversation);
expectThrow(() => verifyRealCustomerDataset(pii, registry), /dataset_pii_detected/);
const exact = clone(dataset); exact.cases[1].conversation = clone(exact.cases[0].conversation); exact.cases[1].conversation_sha256 = exact.cases[0].conversation_sha256;
expectThrow(() => verifyRealCustomerDataset(exact, registry), /dataset_exact_duplicate/);
const semantic = clone(dataset); semantic.cases[1].conversation = clone(semantic.cases[0].conversation); semantic.cases[1].conversation[0].text += " additional"; semantic.cases[1].conversation_sha256 = hashObject(semantic.cases[1].conversation);
expectThrow(() => verifyRealCustomerDataset(semantic, registry, { semanticThreshold: 0.7 }), /dataset_semantic_duplicate/);
const translated = clone(dataset); translated.cases[0].evaluation_language = "en";
expectThrow(() => verifyRealCustomerDataset(translated, registry), /dataset_translation_equivalence_missing/);
const response = clone(dataset); response.cases[0].response = "forbidden";
expectThrow(() => verifyRealCustomerDataset(response, registry), /dataset_response_before_freeze/);
const tampered = clone(freeze); tampered.case_hashes[0].sha256 = "f".repeat(64);
expectThrow(() => verifyFreezeManifest(tampered, dataset, registry, candidate), /freeze_case_tamper/);
expectThrow(() => verifyFreezeManifest(freeze, dataset, registry, { ...candidate, head: "3".repeat(40) }), /freeze_cross_release/);

console.log("C3_REAL_CUSTOMER_DATASET_TESTS=PASS");
