import assert from 'node:assert/strict';
import {
  canonicalHash, normalizeManifest, reconcile, resolveControlHeader,
  resolveReviewExecutorConfig, invokeReviewExecutor, isStrictStaleLiveMetadata,
} from '../scripts/workflow2-task2-3-kb-migration.mjs';

function uuid(i) { return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`; }
function makeDoc(i, opts = {}) {
  const raw = opts.empty ? null : `canonical content ${i}`;
  return {
    id: `base44-${i}`, global_document_id: uuid(i), name: `Doc ${i}`,
    source_type: opts.sourceType || (i % 5 === 0 ? 'FAQ' : 'Guide'), industry: 'HomeAppliance', language: 'zh-TW', version: '1.0',
    raw_content: raw, content_hash: opts.missingHash ? null : raw === null ? null : canonicalHash(raw),
    active_version_id: opts.empty ? null : `version-${i}`, vector_count: opts.empty ? 0 : 1, chunk_count: opts.empty ? 0 : 1,
    status: 'published', production_vector_status: 'indexed', available_to_live_console: true,
  };
}
assert.equal(canonicalHash('  abc\n'), canonicalHash('abc'));
assert.throws(() => canonicalHash('   '), /EMPTY_PUBLISH_CONTENT/);

const docs = [];
for (let i = 1; i <= 216; i++) docs.push(makeDoc(i, { empty: i <= 6, missingHash: i > 6 && i <= 43 }));
const blocked = normalizeManifest({ documents: docs }, 216);
assert.equal(blocked.diagnostics.actual_source_count, 216);
assert.equal(blocked.diagnostics.content_unrecoverable.length, 6);
assert.equal(blocked.diagnostics.missing_hash_recomputed.length, 37);
assert.equal(blocked.diagnostics.blocking_issue_count, 6);

const quarantine = { records: docs.slice(0, 6).map(d => ({
  base44_document_id: d.id, global_document_id: d.global_document_id, name: d.name, source_type: d.source_type, version: d.version,
  reason: 'STALE_LIVE_METADATA_NO_AUTHORITATIVE_CONTENT',
})) };
const readySource = normalizeManifest({ documents: docs }, 216, quarantine);
assert.equal(readySource.diagnostics.actual_source_count, 216);
assert.equal(readySource.diagnostics.quarantine_count, 6);
assert.equal(readySource.diagnostics.migration_expected_count, 210);
assert.equal(readySource.diagnostics.content_unrecoverable.length, 0);
assert.equal(readySource.diagnostics.blocking_issue_count, 0);
assert.equal(readySource.migration_documents.length, 210);
assert.equal(isStrictStaleLiveMetadata(docs[0]), true);

const badFingerprint = structuredClone(quarantine);
badFingerprint.records[0].name = 'wrong title';
const mismatch = normalizeManifest({ documents: docs }, 216, badFingerprint);
assert.equal(mismatch.diagnostics.quarantine_mismatch.length, 1);
assert.ok(mismatch.diagnostics.blocking_issue_count > 0);
const absent = normalizeManifest({ documents: docs.slice(1) }, 215, quarantine);
assert.equal(absent.diagnostics.quarantine_not_observed.length, 1);
assert.ok(absent.diagnostics.blocking_issue_count > 0);

// Current Base44 source_type schema classes that were missing from the older validator must be accepted.
for (const sourceType of ['ReturnPolicy','ManualQA','GlossaryEntry']) {
  const one = makeDoc(999, { sourceType });
  const n = normalizeManifest({ documents: [one] }, 1);
  assert.equal(n.diagnostics.invalid_source_types.length, 0, sourceType);
}
for (const unsupported of ['RefundPolicy','AfterSalesPolicy']) {
  const one = makeDoc(998, { sourceType: unsupported });
  const n = normalizeManifest({ documents: [one] }, 1);
  assert.equal(n.diagnostics.invalid_source_types.length, 1, unsupported);
}

const singapore = readySource.migration_documents.map(d => ({
  global_document_id: d.global_document_id, source_type: d.source_type, version: d.version,
  raw_content: d.raw_content, content_hash: d.canonical_content_hash,
  status: 'published', production_vector_status: 'indexed', available_to_live_console: true,
}));
const exact = reconcile({ documents: docs }, singapore, 216, quarantine);
assert.equal(exact.ready, true);
assert.equal(exact.source_observed, 216);
assert.equal(exact.expected, 210);
assert.equal(exact.actual, 210);
assert.equal(exact.quarantined, 6);
assert.equal(exact.missing.length, 0);
assert.equal(exact.unexpected.length, 0);

const staleWasMigrated = structuredClone(singapore);
staleWasMigrated.push({ ...singapore[0], global_document_id: docs[0].global_document_id });
assert.equal(reconcile({ documents: docs }, staleWasMigrated, 216, quarantine).ready, false);
const drifted = structuredClone(singapore);
drifted[0].source_type = 'Other'; drifted[1].content_hash = 'bad';
const drift = reconcile({ documents: docs }, drifted, 216, quarantine);
assert.equal(drift.ready, false);
assert.ok(drift.mismatches.length >= 1);

assert.deepEqual(resolveControlHeader({ SINGAPORE_SERVICE_ROLE_SECRET: 'x'.repeat(20), SINGAPORE_BACKEND_TOKEN: 'y'.repeat(20) }), {
  header: 'x-service-role-secret', value: 'x'.repeat(20), kind: 'service_role',
});
assert.deepEqual(resolveControlHeader({ SINGAPORE_BACKEND_TOKEN: 'y'.repeat(20) }), {
  header: 'Authorization', value: `Bearer ${'y'.repeat(20)}`, kind: 'bearer',
});
assert.equal(resolveControlHeader({}), null);
assert.equal(resolveReviewExecutorConfig({}), null);
assert.throws(() => resolveReviewExecutorConfig({ KB_REVIEW_EXECUTOR_URL: 'http://example.com', KB_REVIEW_EXECUTOR_SERVICE_SECRET: 's' }), /HTTPS_REQUIRED/);

let captured;
const fakeFetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200, async json() { return { ok: true, review_id: 'r1', publish_decision: 'ready', idempotent: false }; } }; };
const reviewDoc = readySource.migration_documents[10];
const result = await invokeReviewExecutor(reviewDoc, 'sg-doc-11', {
  KB_REVIEW_EXECUTOR_URL: 'https://review.example.com', KB_REVIEW_EXECUTOR_SERVICE_SECRET: 'secret-value',
}, fakeFetch);
assert.equal(result.review_id, 'r1');
assert.equal(captured.init.headers['x-service-role-secret'], 'secret-value');
const requestBody = JSON.parse(captured.init.body);
assert.equal(requestBody.expected_global_document_id, reviewDoc.global_document_id);
assert.equal(requestBody.expected_content_hash, reviewDoc.canonical_content_hash);
assert.equal('company_id' in requestBody, false);
assert.equal('tenant_id' in requestBody, false);
const rejectedFetch = async () => ({ ok: true, status: 200, async json() { return { ok: true, publish_decision: 'needs_review' }; } });
await assert.rejects(() => invokeReviewExecutor(reviewDoc, 'sg-doc-11', {
  KB_REVIEW_EXECUTOR_URL: 'https://review.example.com', KB_REVIEW_EXECUTOR_SERVICE_SECRET: 'secret-value',
}, rejectedFetch), /MIGRATION_REVIEW_NOT_APPROVED/);

console.log('PASS Workflow2 Task2.3: 216 source inventory / 210 content-backed migration / 6 exact stale-metadata quarantine + review executor');
