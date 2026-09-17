#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.join(ROOT, "c3_real_customer_source_registry.json");
export const DATASET_PATH = path.join(ROOT, "c3_real_customer_heldout_dataset_v1.json");
export const FREEZE_PATH = path.join(ROOT, "c3_real_customer_freeze_manifest_v1.json");
export const DERIVED_SCREENING_PATH = path.join(ROOT, "c3_real_case_derived_screening_v1.json");
export const DERIVED_DATASET_PATH = path.join(ROOT, "c3_real_case_derived_dataset_v1.json");
export const DERIVED_FREEZE_PATH = path.join(ROOT, "c3_real_case_derived_freeze_manifest_v1.json");
export const DERIVED_REVIEW_PREPARATION_PATH = path.join(ROOT, "c3_real_case_derived_review_preparation_v1.json");
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

export const DERIVED_SOURCE = Object.freeze({
  repository_url: "https://github.com/guyfe/Tweetsumm",
  commit: "4903b0f20665a59e4b5494abd83d8735893c0333",
  dataset_license: "CDLA-Sharing-1.0",
  dataset_license_url: "https://cdla.io/sharing-1-0/",
  attribution: "TweetSumm, A Dialog Summarization Dataset for Customer Service (Feigenblat et al., Findings of EMNLP 2021)",
  files: {
    "tweet_sum_data_files/final_test_tweetsum.jsonl": "5cfa68d7181b40fd179ef8d8208b0b1b86644f6fbc7d5ba4e4fd3e9e87c1e6e9",
    "tweet_sum_data_files/final_train_tweetsum.jsonl": "944e45800a4c17417a0cb421b880183e1a8a6b28214b519a748bfaf7371fb091",
    "tweet_sum_data_files/final_valid_tweetsum.jsonl": "0a571a3c3e246373d52185fb4ba38698d950a926ef86ee3e5c74a376eeeceaba",
  },
});

const DERIVED_CANDIDATE_PATTERN = /order|delivery|deliver|shipping|shipment|package|parcel|return|refund|exchange|purchase|bought|buy|seller|retail|store|checkout/i;
const DERIVED_NON_ECOMMERCE_PATTERN = /flight|airline|airport|train|ticket|booking|seat|baggage|luggage|journey|hotel|holiday|internet|broadband|wifi|wi-fi|mobile|iphone|phone|ios|android|app\b|software|playlist|stream|xbox|playstation|\bps[34]\b|game|gaming|cable|roku|television|tv\b|bank|atm|cash|loan|insurance|uber ride|driver trip|taxi|bus|account was hacked|miles|skymiles|sim\b|modem|data renewable|data bundle|wordpress|subscription|billing|bill\b|mpesa|m-pesa/i;
const DERIVED_MANUAL_EXCLUSIONS = new Map(Object.entries({
  "66ef0798511c37095b26b938be3c2d0b": "NON_ECOMMERCE_SELLER_ACCOUNT_SECURITY",
  "0378fec73afd1fa7962a4f6f5d0000d6": "STORE_ENVIRONMENT_NOT_COMMERCE_CASE",
  "26ae1132fda9219af2a13b1045f36c8b": "TRANSACTION_CONTEXT_NOT_ESTABLISHED",
  "b50df8ee981a32af08b95b935a85e7b1": "GENERAL_ASSORTMENT_FEEDBACK_NOT_TRANSACTION",
  "85a21f70bdfbab50e06bbb7c9382a5f0": "FINANCIAL_CARD_CASE",
  "f2962639decc0048380881f4702821a0": "DIGITAL_GAME_ENTITLEMENT",
  "265b7a378ddf2634bbe61147ba911b58": "GAMEPLAY_SUPPORT_FALSE_POSITIVE",
  "91f2b7b8c90cf3a3d018e23b793b2b17": "CAFE_MENU_FEEDBACK_NOT_ECOMMERCE",
  "eee126171b57647663ee571e280349dc": "NETWORK_ORDER_FALSE_POSITIVE",
  "835077deca33755c9522d8e0bbe6ea40": "CAFE_OPERATIONS_NOT_ECOMMERCE",
  "f43f6cb22a64dd3f1462d81629b338b0": "TELECOM_SUPPORT_FALSE_POSITIVE",
  "0c7ca829dad9d8f0199db931d8b861b3": "REFUND_WITHOUT_TRANSACTION_FACTS",
  "b9c55e7edf92d8010f3e276ceea0de52": "INSUFFICIENT_SERVICE_CONTEXT",
  "17f3be231950f68b4d642597687cbd02": "TELECOM_DATA_REFUND",
  "4d5602d2ec597c6fd1fbfba757ca5573": "TELECOM_DATA_PURCHASE",
  "c27520ae8e310ea7ef115733cd29e8d4": "STORE_HOURS_NOT_ECOMMERCE",
  "3f6074702e2881ace14fb77005d6d542": "CHARGE_WITHOUT_COMMERCE_CONTEXT",
  "c5f1c66557a6d73da5d8c5aa584f0c26": "STORE_QUEUE_NOT_ECOMMERCE",
  "39fe3eba64e68f45ac32e16dd866b20d": "STORE_CONTACT_WITHOUT_CASE_FACTS",
  "ad10c509c9fd6db420ab85ac37607047": "TELECOM_STORE_CASE",
  "a9fc9f6337888780314a1ddccfa545a1": "TELECOM_BILLING_CASE",
  "bfc29fd12cc8543641a6dfb19293d5d9": "AIR_TRAVEL_BAGGAGE_CASE",
  "2a1ace56f17af2d78548fd5d51705fad": "DIGITAL_GAME_PURCHASE",
  "1c3333d666b15abfaea8a04d2376eb59": "DIGITAL_GAME_CODE",
  "930ed47280b9656b912371e7b5ee9ec0": "PREPAID_FINANCIAL_PRODUCT",
  "a30d99e7b22b9ddc10ea969cc33dbf7e": "STORE_STAFFING_NOT_ECOMMERCE",
  "4906cf2deda014e27a19b0d3fd1b9d07": "INSUFFICIENT_PRODUCT_ISSUE_FACTS",
}));

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

const derivedPairs = (record) => (record.annotations ?? []).flatMap((annotation, annotationIndex) => {
  const abstractive = annotation?.abstractive;
  return Array.isArray(abstractive) && presentText(abstractive[0]) && presentText(abstractive[1])
    ? [{ annotation_index: annotationIndex, customer: abstractive[0].trim(), historical_agent: abstractive[1].trim() }]
    : [];
});
const derivedCustomerText = (record) => derivedPairs(record).map((row) => row.customer).join(" ");
const derivedCategory = (text) => {
  const categories = [
    ["returns_refunds", /return|refund|reimburse|money back/i],
    ["shipping_delivery", /deliver|shipping|shipment|package|parcel|courier|tracking|fulfilment/i],
    ["order_change_cancellation", /cancel|change.*order|wrong size|wrong address/i],
    ["product_quality_safety", /damag|broken|mould|rotten|expired|outdated|missing part|wrong item|taste|glass|melt/i],
    ["stock_availability", /stock|available|find|selling|supply|store/i],
    ["marketplace_seller", /seller|buyer|listing|auction|ebay|paypal/i],
    ["checkout_payment", /checkout|payment|charged|card|price|promo|discount/i],
  ];
  return categories.find(([, pattern]) => pattern.test(text))?.[0] ?? "order_product_support";
};
const derivedTokens = (text) => new Set(normalize(text).split(" ").filter((token) => token.length > 2));
const derivedSimilarity = (left, right) => {
  const a = derivedTokens(left), b = derivedTokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
};
const selectSummaryBasis = (record) => derivedPairs(record).sort((left, right) =>
  (right.customer.length + right.historical_agent.length) - (left.customer.length + left.historical_agent.length)
)[0];
const sourceSplit = (sourcePath) => sourcePath.match(/final_(test|train|valid)_tweetsum/)?.[1] ?? fail("derived_source_split_invalid");

export function buildDerivedArtifacts(sourceDirectory, candidate) {
  if (!candidate || !GIT40.test(candidate.head) || !GIT40.test(candidate.tree)) fail("derived_candidate_invalid");
  const candidates = [];
  for (const [relativePath, expectedSha] of Object.entries(DERIVED_SOURCE.files)) {
    const sourcePath = path.resolve(sourceDirectory, relativePath);
    const sourceRoot = `${path.resolve(sourceDirectory)}${path.sep}`;
    if (!sourcePath.startsWith(sourceRoot) || !fs.existsSync(sourcePath)) fail(`derived_source_missing:${relativePath}`);
    const sourceBytes = fs.readFileSync(sourcePath);
    if (sha256(sourceBytes) !== expectedSha) fail(`derived_source_file_tamper:${relativePath}`);
    const lines = sourceBytes.toString("utf8").split(/\r?\n/).filter(Boolean);
    lines.forEach((line, index) => {
      const record = JSON.parse(line), customerText = derivedCustomerText(record);
      if (!DERIVED_CANDIDATE_PATTERN.test(customerText)) return;
      const pairs = derivedPairs(record);
      const matchedTerms = [...new Set(customerText.toLowerCase().match(new RegExp(DERIVED_CANDIDATE_PATTERN.source, "gi")) ?? [])].sort();
      let exclusionReason = "";
      if (pairs.length < 2) exclusionReason = "INSUFFICIENT_HUMAN_SUMMARY_PAIRS";
      else if (DERIVED_NON_ECOMMERCE_PATTERN.test(customerText)) exclusionReason = "NON_ECOMMERCE_CONTEXT";
      else if (DERIVED_MANUAL_EXCLUSIONS.has(record.conversation_id)) exclusionReason = DERIVED_MANUAL_EXCLUSIONS.get(record.conversation_id);
      candidates.push({
        conversation_id: record.conversation_id,
        source_path: relativePath,
        source_split: sourceSplit(relativePath),
        source_line: index + 1,
        source_file_sha256: expectedSha,
        source_record_sha256: sha256(Buffer.from(line)),
        summary_basis_sha256: hashObject(pairs),
        matched_terms: matchedTerms,
        pairs,
        exclusion_reason: exclusionReason,
      });
    });
  }
  if (candidates.length !== 251) fail(`derived_candidate_pool_drift:${candidates.length}`);
  const selected = [];
  for (const row of candidates) {
    if (row.exclusion_reason) continue;
    const basis = selectSummaryBasis({ annotations: row.pairs.map((pair) => ({ abstractive: [pair.customer, pair.historical_agent] })) });
    const duplicate = selected.find((prior) => derivedSimilarity(basis.customer, prior.basis.customer) >= 0.86);
    if (duplicate) {
      row.exclusion_reason = `NEAR_DUPLICATE_OF:${duplicate.row.conversation_id}`;
      continue;
    }
    if (selected.length >= 100) {
      row.exclusion_reason = "OVER_TARGET_AFTER_100_DISTINCT_ELIGIBLE_CASES";
      continue;
    }
    selected.push({ row, basis });
  }
  if (selected.length !== 100) fail(`derived_case_target_not_met:${selected.length}`);
  const cases = selected.map(({ row, basis }, index) => {
    const summaryBasis = {
      annotation_index: basis.annotation_index,
      customer_summary: basis.customer,
      historical_agent_summary: basis.historical_agent,
      historical_agent_summary_is_reference_only: true,
    };
    return {
      case_id: `c3-derived-${String(index + 1).padStart(3, "0")}`,
      source_type: "DERIVED_ONLY",
      evaluation_type: "REAL_CASE_DERIVED_INTERIM",
      source_corpus: "TweetSumm",
      source_repository: DERIVED_SOURCE.repository_url,
      source_commit: DERIVED_SOURCE.commit,
      conversation_id: row.conversation_id,
      source_path: row.source_path,
      source_split: row.source_split,
      source_line: row.source_line,
      source_file_sha256: row.source_file_sha256,
      source_record_sha256: row.source_record_sha256,
      summary_basis_sha256: hashObject(summaryBasis),
      license_binding: DERIVED_SOURCE.dataset_license,
      market: "UNKNOWN",
      original_language: "en",
      pii_status: "NO_DIRECT_IDENTIFIERS_IN_SELECTED_HUMAN_SUMMARY",
      category: derivedCategory(`${basis.customer} ${basis.historical_agent}`),
      human_summary_basis: summaryBasis,
      explicit_facts: [basis.customer],
      derived_customer_question: `Please help with this customer-service issue using only verified information: ${basis.customer}`,
      grading_basis: [
        "Acknowledge the explicit customer issue without adding unsupported transaction facts.",
        "Ask only for information required for a safe next step.",
        "Do not present the historical agent action as an action completed by the candidate.",
        "Do not confirm a refund, shipment, cancellation, replacement, transfer, or escalation without runtime evidence.",
      ],
      unknown_information: ["current account or order state", "customer entitlement and applicable policy", "whether any action has completed"],
      prohibited_promises: ["refund completed", "order changed or cancelled", "shipment delivered or rescheduled", "replacement approved", "handoff or escalation completed"],
      transformation_log: [
        "Selected one publisher-provided human abstractive customer/agent summary pair.",
        "Excluded raw tweet text, handles, links and direct identifiers.",
        "Converted the customer summary into a derived evaluation question without adding scenario facts.",
        "Retained the historical agent summary as non-oracle reference only.",
        "Assigned market UNKNOWN because language and platform do not prove market provenance.",
      ],
    };
  });
  const dataset = {
    schema_version: "c3-real-case-derived-dataset-1.0.0",
    status: "READY",
    evaluation_type: "REAL_CASE_DERIVED_INTERIM",
    source_type: "DERIVED_ONLY",
    replaces_a_class_requirement: false,
    held_out_real_customer: false,
    quality_score: "NOT_MEASURED",
    market_provenance: "UNKNOWN",
    source: DERIVED_SOURCE,
    candidate_pool_count: candidates.length,
    derived_case_count: cases.length,
    responses_at_freeze: 0,
    cases,
  };
  const screening = {
    schema_version: "c3-real-case-derived-screening-1.0.0",
    source: DERIVED_SOURCE,
    candidate_rule: DERIVED_CANDIDATE_PATTERN.source,
    candidate_count: candidates.length,
    selected_count: cases.length,
    excluded_count: candidates.length - cases.length,
    entries: candidates.map(({ pairs, exclusion_reason, ...row }) => ({
      ...row,
      decision: selected.some((selectedRow) => selectedRow.row.conversation_id === row.conversation_id) ? "SELECTED" : "EXCLUDED",
      reason: exclusion_reason || "DISTINCT_ECOMMERCE_CASE_WITH_SUFFICIENT_HUMAN_SUMMARY_FACTS",
    })),
  };
  const freeze = {
    schema_version: "c3-real-case-derived-freeze-manifest-1.0.0",
    status: "READY",
    evaluation_type: "REAL_CASE_DERIVED_INTERIM",
    source_type: "DERIVED_ONLY",
    prepared_from_candidate: candidate,
    source_commit: DERIVED_SOURCE.commit,
    dataset_sha256: hashObject(dataset),
    screening_sha256: hashObject(screening),
    rubric_sha256: hashObject(readJson(path.join(ROOT, "c3_service_quality_rubric.json"))),
    case_hashes: cases.map((row) => ({ case_id: row.case_id, sha256: hashObject(row) })),
    derived_case_count: cases.length,
    original_a_class_eligible_dialogue_count: 0,
    frozen_before_responses: true,
    responses_at_freeze: 0,
    response_hashes: [],
    derived_score: "NOT_MEASURED",
    human_calibration: "AWAITING",
    product_ready: false,
  };
  const reviewPreparation = {
    schema_version: "c3-real-case-derived-review-preparation-1.0.0",
    status: "REVIEW_PREPARATION",
    evaluation_type: "REAL_CASE_DERIVED_INTERIM",
    dataset_sha256: freeze.dataset_sha256,
    rubric_sha256: freeze.rubric_sha256,
    selected_case_ids: cases.filter((_, index) => index % 5 === 0).slice(0, 20).map((row) => row.case_id),
    minimum_independent_human_reviewers: 2,
    minimum_review_records_after_responses_exist: 40,
    actual_response_count: 0,
    actual_reviewer_count: 0,
    actual_review_record_count: 0,
    blindness: { model_identity_hidden: true, grader_scores_hidden: true, other_reviewers_hidden: true, expected_results_hidden: true, oracle_labels_hidden: true },
    form_template: {
      required_bindings: ["reviewer_provenance", "case_sha256", "response_sha256", "rubric_sha256", "timestamp"],
      required_assessment: ["six_dimension_scores", "reason", "p0_labels", "recommendation"],
      scores_or_reviews_prepopulated: false,
    },
  };
  verifyDerivedArtifacts({ screening, dataset, freeze, reviewPreparation }, candidate);
  return { screening, dataset, freeze, reviewPreparation };
}

export function verifyDerivedArtifacts({ screening, dataset, freeze, reviewPreparation }, expectedCandidate = freeze?.prepared_from_candidate) {
  if (screening?.schema_version !== "c3-real-case-derived-screening-1.0.0" || screening.candidate_count !== 251 || screening.selected_count !== 100 || screening.excluded_count !== 151 || screening.entries?.length !== 251) fail("derived_screening_invalid");
  const conversationIds = new Set(), sourceRecords = new Set();
  for (const row of screening.entries) {
    if (!presentText(row.conversation_id) || conversationIds.has(row.conversation_id) || !HEX64.test(row.source_file_sha256) || !HEX64.test(row.source_record_sha256) || !HEX64.test(row.summary_basis_sha256)) fail("derived_screening_binding_invalid");
    if (!Object.hasOwn(DERIVED_SOURCE.files, row.source_path) || DERIVED_SOURCE.files[row.source_path] !== row.source_file_sha256) fail(`derived_screening_source_invalid:${row.conversation_id}`);
    if (!['SELECTED', 'EXCLUDED'].includes(row.decision) || !presentText(row.reason)) fail(`derived_screening_decision_invalid:${row.conversation_id}`);
    conversationIds.add(row.conversation_id); sourceRecords.add(row.source_record_sha256);
  }
  if (dataset?.schema_version !== "c3-real-case-derived-dataset-1.0.0" || dataset.status !== "READY" || dataset.evaluation_type !== "REAL_CASE_DERIVED_INTERIM" || dataset.source_type !== "DERIVED_ONLY" || dataset.replaces_a_class_requirement !== false || dataset.held_out_real_customer !== false || dataset.quality_score !== "NOT_MEASURED" || dataset.responses_at_freeze !== 0) fail("derived_dataset_classification_invalid");
  if (dataset.derived_case_count !== 100 || dataset.cases?.length !== 100 || dataset.candidate_pool_count !== 251) fail("derived_dataset_count_invalid");
  const selectedEntries = new Map(screening.entries.filter((row) => row.decision === "SELECTED").map((row) => [row.conversation_id, row]));
  const caseIds = new Set(), bindingIds = new Set();
  for (const row of dataset.cases) {
    const source = selectedEntries.get(row.conversation_id);
    if (!/^c3-derived-[0-9]{3}$/.test(row.case_id) || caseIds.has(row.case_id) || bindingIds.has(row.conversation_id) || !source) fail(`derived_case_identity_invalid:${row.case_id}`);
    if (row.source_type !== "DERIVED_ONLY" || row.evaluation_type !== "REAL_CASE_DERIVED_INTERIM" || row.market !== "UNKNOWN" || row.license_binding !== DERIVED_SOURCE.dataset_license || row.source_commit !== DERIVED_SOURCE.commit) fail(`derived_case_classification_invalid:${row.case_id}`);
    if (row.source_file_sha256 !== source.source_file_sha256 || row.source_record_sha256 !== source.source_record_sha256 || !HEX64.test(row.summary_basis_sha256)) fail(`derived_case_source_binding_invalid:${row.case_id}`);
    if (!presentText(row.human_summary_basis?.customer_summary) || !presentText(row.human_summary_basis?.historical_agent_summary) || row.human_summary_basis?.historical_agent_summary_is_reference_only !== true || row.summary_basis_sha256 !== hashObject(row.human_summary_basis)) fail(`derived_case_summary_binding_invalid:${row.case_id}`);
    if (!Array.isArray(row.explicit_facts) || row.explicit_facts.length !== 1 || row.explicit_facts[0] !== row.human_summary_basis.customer_summary || !presentText(row.derived_customer_question)) fail(`derived_case_facts_invalid:${row.case_id}`);
    if (!Array.isArray(row.grading_basis) || row.grading_basis.length < 4 || !Array.isArray(row.unknown_information) || !row.unknown_information.length || !Array.isArray(row.prohibited_promises) || !row.prohibited_promises.length || !Array.isArray(row.transformation_log) || row.transformation_log.length < 5) fail(`derived_case_controls_invalid:${row.case_id}`);
    if (row.response !== undefined || row.grader !== undefined || row.human_review !== undefined) fail(`derived_response_before_freeze:${row.case_id}`);
    const piiText = `${row.human_summary_basis.customer_summary} ${row.human_summary_basis.historical_agent_summary}`;
    for (const [kind, pattern] of PII) if (pattern.test(piiText)) fail(`derived_pii_detected:${row.case_id}:${kind}`);
    caseIds.add(row.case_id); bindingIds.add(row.conversation_id);
  }
  if (freeze?.schema_version !== "c3-real-case-derived-freeze-manifest-1.0.0" || freeze.status !== "READY" || freeze.source_type !== "DERIVED_ONLY" || freeze.derived_case_count !== 100 || freeze.original_a_class_eligible_dialogue_count !== 0 || freeze.frozen_before_responses !== true || freeze.responses_at_freeze !== 0 || freeze.response_hashes?.length || freeze.derived_score !== "NOT_MEASURED" || freeze.human_calibration !== "AWAITING" || freeze.product_ready !== false) fail("derived_freeze_state_invalid");
  if (!expectedCandidate || freeze.prepared_from_candidate?.head !== expectedCandidate.head || freeze.prepared_from_candidate?.tree !== expectedCandidate.tree) fail("derived_freeze_cross_release");
  if (freeze.dataset_sha256 !== hashObject(dataset) || freeze.screening_sha256 !== hashObject(screening) || freeze.rubric_sha256 !== hashObject(readJson(path.join(ROOT, "c3_service_quality_rubric.json")))) fail("derived_freeze_hash_invalid");
  if (canonicalJson(freeze.case_hashes) !== canonicalJson(dataset.cases.map((row) => ({ case_id: row.case_id, sha256: hashObject(row) })))) fail("derived_freeze_case_hash_invalid");
  if (reviewPreparation?.schema_version !== "c3-real-case-derived-review-preparation-1.0.0" || reviewPreparation.status !== "REVIEW_PREPARATION" || reviewPreparation.actual_response_count !== 0 || reviewPreparation.actual_reviewer_count !== 0 || reviewPreparation.actual_review_record_count !== 0 || reviewPreparation.selected_case_ids?.length !== 20 || new Set(reviewPreparation.selected_case_ids).size !== 20 || reviewPreparation.form_template?.scores_or_reviews_prepopulated !== false) fail("derived_review_preparation_invalid");
  if (reviewPreparation.dataset_sha256 !== freeze.dataset_sha256 || reviewPreparation.rubric_sha256 !== freeze.rubric_sha256 || reviewPreparation.selected_case_ids.some((id) => !caseIds.has(id))) fail("derived_review_binding_invalid");
  return { status: "READY", source_type: "DERIVED_ONLY", candidate_count: 251, derived_case_count: 100, original_a_class_eligible_dialogue_count: 0, responses_at_freeze: 0, derived_score: "NOT_MEASURED", human_calibration: "AWAITING", product_ready: false };
}

export function verifyCommittedDerivedState(expectedCandidate) {
  return verifyDerivedArtifacts({
    screening: readJson(DERIVED_SCREENING_PATH),
    dataset: readJson(DERIVED_DATASET_PATH),
    freeze: readJson(DERIVED_FREEZE_PATH),
    reviewPreparation: readJson(DERIVED_REVIEW_PREPARATION_PATH),
  }, expectedCandidate);
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
} else if (command === "build-derived") {
  if (!input || !output || !head || !tree) fail("usage:build-derived TWEETSUM_SOURCE_DIR OUTPUT_DIR BASE_HEAD BASE_TREE");
  const artifacts = buildDerivedArtifacts(input, { head, tree });
  const outputs = [
    ["c3_real_case_derived_screening_v1.json", artifacts.screening],
    ["c3_real_case_derived_dataset_v1.json", artifacts.dataset],
    ["c3_real_case_derived_freeze_manifest_v1.json", artifacts.freeze],
    ["c3_real_case_derived_review_preparation_v1.json", artifacts.reviewPreparation],
  ];
  for (const [name, value] of outputs) fs.writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(canonicalJson({ result: "PASS", candidate_count: 251, derived_case_count: 100, dataset_sha256: hashObject(artifacts.dataset), screening_sha256: hashObject(artifacts.screening), responses_at_freeze: 0 }));
} else if (command === "verify-derived") {
  if (!input || !output) fail("usage:verify-derived BASE_HEAD BASE_TREE");
  console.log(canonicalJson(verifyCommittedDerivedState({ head: input, tree: output })));
} else if (command && import.meta.url === `file://${process.argv[1]}`) fail("unknown_command");
