import assert from 'node:assert/strict';
import {
  canonicalHash, normalizeManifest, reconcile, resolveControlHeader,
  resolveReviewExecutorConfig, invokeReviewExecutor,
} from '../scripts/workflow2-task2-3-kb-migration.mjs';

function uuid(i) {
  const tail = String(i).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}
function makeDoc(i, opts = {}) {
  const raw = opts.empty ? null : `canonical content ${i}`;
  return {
    id: `base44-${i}`,
    global_document_id: uuid(i),
    name: `Doc ${i}`,
    source_type: i % 5 === 0 ? 'FAQ' : 'Guide',
    industry: 'Home Appliances',
    language: 'zh-TW',
    version: '1.0',
    raw_content: raw,
    content_hash: opts.missingHash ? null : raw === null ? null : canonicalHash(raw),
  };
}

assert.equal(canonicalHash('  abc\n'), canonicalHash('abc'), 'canonical hash must match Base44 trim contract');
assert.throws(() => canonicalHash('   '), /EMPTY_PUBLISH_CONTENT/);

const docs = [];
for (let i = 1; i <= 216; i++) {
  docs.push(makeDoc(i, { empty: i <= 6, missingHash: i > 6 && i <= 43 }));
}
const blocked = normalizeManifest({ documents: docs }, 216);
assert.equal(blocked.diagnostics.actual_count, 216);
assert.equal(blocked.diagnostics.content_resolvable, 210);
assert.equal(blocked.diagnostics.content_unrecoverable.length, 6);
assert.equal(blocked.diagnostics.missing_hash_recomputed.length, 37);
assert.equal(blocked.diagnostics.blocking_issue_count, 6);

const repairedDocs = docs.map((d, idx) => idx < 6 ? { ...d, raw_content: `recovered ${idx + 1}`, content_hash: null } : d);
const readySource = normalizeManifest({ documents: repairedDocs }, 216);
assert.equal(readySource.diagnostics.content_unrecoverable.length, 0);
assert.equal(readySource.diagnostics.missing_hash_recomputed.length, 43);
assert.equal(readySource.diagnostics.blocking_issue_count, 0);

const singapore = readySource.documents.map(d => ({
  global_document_id: d.global_document_id,
  source_type: d.source_type,
  version: d.version,
  raw_content: d.raw_content,
  content_hash: d.canonical_content_hash,
  status: 'published',
  production_vector_status: 'indexed',
  available_to_live_console: true,
}));
const exact = reconcile(readySource.documents, singapore, 216);
assert.equal(exact.ready, true);
assert.equal(exact.missing.length, 0);
assert.equal(exact.unexpected.length, 0);
assert.equal(exact.mismatches.length, 0);

const drifted = structuredClone(singapore);
drifted[0].source_type = 'Other';
drifted[1].raw_content = 'tampered';
drifted[1].content_hash = '';
drifted.pop();
drifted.push({ ...singapore[0], global_document_id: uuid(999999) });
const drift = reconcile(readySource.documents, drifted, 216);
assert.equal(drift.ready, false);
assert.equal(drift.missing.length, 1);
assert.equal(drift.unexpected.length, 1);
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
const execCfg = resolveReviewExecutorConfig({ KB_REVIEW_EXECUTOR_URL: 'https://review.example.com/', KB_REVIEW_EXECUTOR_SERVICE_SECRET: 'secret-value' });
assert.equal(execCfg.url, 'https://review.example.com');

let captured;
const fakeFetch = async (url, init) => {
  captured = { url, init };
  return { ok: true, status: 200, async json() { return { ok: true, review_id: 'r1', publish_decision: 'ready', idempotent: false }; } };
};
const reviewDoc = readySource.documents[10];
const result = await invokeReviewExecutor(reviewDoc, 'sg-doc-11', {
  KB_REVIEW_EXECUTOR_URL: 'https://review.example.com',
  KB_REVIEW_EXECUTOR_SERVICE_SECRET: 'secret-value',
}, fakeFetch);
assert.equal(result.review_id, 'r1');
assert.equal(captured.url, 'https://review.example.com/api/functions/kbReviewExecute');
assert.equal(captured.init.headers['x-service-role-secret'], 'secret-value');
const requestBody = JSON.parse(captured.init.body);
assert.equal(requestBody.document_id, 'sg-doc-11');
assert.equal(requestBody.expected_global_document_id, reviewDoc.global_document_id);
assert.equal(requestBody.expected_content_hash, reviewDoc.canonical_content_hash);
assert.equal('company_id' in requestBody, false);
assert.equal('tenant_id' in requestBody, false);

const rejectedFetch = async () => ({ ok: true, status: 200, async json() { return { ok: true, publish_decision: 'needs_review' }; } });
await assert.rejects(
  () => invokeReviewExecutor(reviewDoc, 'sg-doc-11', { KB_REVIEW_EXECUTOR_URL: 'https://review.example.com', KB_REVIEW_EXECUTOR_SERVICE_SECRET: 'secret-value' }, rejectedFetch),
  /MIGRATION_REVIEW_NOT_APPROVED/,
);

console.log('PASS Workflow2 Task2.3 canonical migration + review executor assertions');
