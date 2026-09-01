import assert from 'node:assert/strict';
import { canonicalHash } from '../scripts/workflow2-task2-3-kb-migration.mjs';
import {
  EXPECTED_CANONICAL_COUNT,
  isCanonicalLiveDocument,
  validateCanonicalSource,
  reconcileCanonicalSource,
} from '../scripts/workflow2-task2-3-canonical-source.mjs';

function uuid(i) {
  return `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

function makeCanonical(i, { missingHash = false } = {}) {
  const raw = `canonical content ${i}`;
  return {
    id: `base44-${i}`,
    global_document_id: uuid(i),
    name: `Doc ${i}`,
    source_type: i % 5 === 0 ? 'FAQ' : 'Guide',
    industry: 'HomeAppliance',
    language: 'zh-TW',
    version: '1.0',
    raw_content: raw,
    content_hash: missingHash ? null : canonicalHash(raw),
    active_version_id: `version-${i}`,
    vector_count: 1,
    chunk_count: 1,
    status: 'published',
    production_vector_status: 'indexed',
    available_to_live_console: true,
  };
}

assert.equal(EXPECTED_CANONICAL_COUNT, 210);

const docs = Array.from({ length: 210 }, (_, i) =>
  makeCanonical(i + 1, { missingHash: i < 37 }),
);
const source = validateCanonicalSource({ documents: docs });
assert.equal(source.ready, true);
assert.equal(source.diagnostics.actual_source_count, 210);
assert.equal(source.diagnostics.migration_expected_count, 210);
assert.equal(source.diagnostics.missing_hash_recomputed.length, 37);
assert.equal(source.diagnostics.content_unrecoverable.length, 0);
assert.equal(source.diagnostics.canonical_predicate_failures.length, 0);
assert.equal(source.diagnostics.blocking_issue_count, 0);
assert.equal(source.migration_documents.length, 210);
assert.equal(isCanonicalLiveDocument(docs[0]), true);

const singapore = source.migration_documents.map((document) => ({
  global_document_id: document.global_document_id,
  source_type: document.source_type,
  version: document.version,
  raw_content: document.raw_content,
  content_hash: document.canonical_content_hash,
  status: 'published',
  production_vector_status: 'indexed',
  available_to_live_console: true,
}));
const exact = reconcileCanonicalSource({ documents: docs }, singapore);
assert.equal(exact.ready, true);
assert.equal(exact.source_observed, 210);
assert.equal(exact.expected, 210);
assert.equal(exact.actual, 210);
assert.equal(exact.missing.length, 0);
assert.equal(exact.unexpected.length, 0);
assert.equal(exact.mismatches.length, 0);

// The six Director-authorized archived metadata records are not canonical source.
const archivedLegacy = {
  ...makeCanonical(999),
  id: '6a1509c9b1d3a6d760fef004',
  global_document_id: '92c817c7-7e60-4853-aeef-dd8b91dac91b',
  name: '常見問題 FAQ - 洗衣機',
  raw_content: null,
  content_hash: null,
  active_version_id: null,
  vector_count: 0,
  chunk_count: 0,
  status: 'archived',
  production_status: 'archived',
  production_vector_status: 'not_indexed',
  available_to_live_console: false,
};
const contaminated = validateCanonicalSource({ documents: [...docs, archivedLegacy] });
assert.equal(contaminated.ready, false);
assert.equal(contaminated.diagnostics.actual_source_count, 211);
assert.equal(contaminated.diagnostics.canonical_predicate_failures.length, 1);
assert.ok(contaminated.diagnostics.blocking_issue_count > 0);

const short = validateCanonicalSource({ documents: docs.slice(0, 209) });
assert.equal(short.ready, false);
assert.equal(short.diagnostics.source_count_mismatch, true);

const missingContent = structuredClone(docs);
missingContent[0].raw_content = null;
missingContent[0].content_hash = null;
const blocked = validateCanonicalSource({ documents: missingContent });
assert.equal(blocked.ready, false);
assert.equal(blocked.diagnostics.content_unrecoverable.length, 1);

const drifted = structuredClone(singapore);
drifted[0].content_hash = 'bad';
assert.equal(reconcileCanonicalSource({ documents: docs }, drifted).ready, false);

console.log('PASS Workflow2 Task2.3 canonical source: 210 live canonical documents; archived legacy metadata excluded; 37 missing hashes deterministically recomputable');
