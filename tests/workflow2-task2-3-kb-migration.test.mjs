import assert from 'node:assert/strict';
import {
  canonicalHash, normalizeManifest, reconcile, resolveControlHeader,
  resolveReviewExecutorConfig, invokeReviewExecutor, isStrictStaleLiveMetadata,
  buildSingaporeCandidate, classifyExistingTarget, executeMigration, verifyPublishedTarget,
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
assert.equal(resolveReviewExecutorConfig({ SINGAPORE_SERVICE_ROLE_SECRET: 'x'.repeat(20) }).secret, 'x'.repeat(20));

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

// V4 production write-engine invariants: candidate is non-live before review, no caller-controlled tenant/company.
const one = makeDoc(700);
const oneNormalized = normalizeManifest({ documents:[one] }, 1);
const candidate = buildSingaporeCandidate(oneNormalized.migration_documents[0]);
assert.equal(candidate.status, 'draft');
assert.equal(candidate.available_to_live_console, false);
assert.equal(candidate.production_vector_status, 'not_indexed');
assert.equal(candidate.content_hash, canonicalHash(one.raw_content));
assert.equal('company_id' in candidate, false);
assert.equal('tenant_id' in candidate, false);
assert.equal(classifyExistingTarget(oneNormalized.migration_documents[0], null), 'missing');
assert.equal(classifyExistingTarget(oneNormalized.migration_documents[0], { ...candidate, id:'sg-700' }), 'exact_candidate');
const live700 = { ...candidate, id:'sg-700', status:'published', production_vector_status:'indexed', available_to_live_console:true, active_version_id:'v700' };
assert.equal(classifyExistingTarget(oneNormalized.migration_documents[0], live700), 'exact_live');
assert.equal(classifyExistingTarget(oneNormalized.migration_documents[0], { ...live700, content_hash:'f'.repeat(64) }), 'conflict');
assert.equal(verifyPublishedTarget(oneNormalized.migration_documents[0], live700), true);

// Full mocked commit: list -> create exact draft -> real-review decision -> publish -> poll -> authoritative read-back.
const calls=[];
const env = {
  WORKFLOW2_TASK2_3_ENABLE_MIGRATION_WRITES:'true',
  SINGAPORE_SERVICE_ROLE_SECRET:'s'.repeat(24),
  KB_SINGAPORE_BASE_URL:'https://kb.example.test',
  KB_REVIEW_EXECUTOR_URL:'https://kb.example.test',
  KB_REVIEW_EXECUTOR_SERVICE_SECRET:'r'.repeat(24),
  KB_MIGRATION_PUBLISH_MAX_POLLS:'3', KB_MIGRATION_PUBLISH_POLL_MS:'0',
};
const finalLive = { ...candidate, id:'sg-700', status:'published', production_vector_status:'indexed', staging_vector_status:'indexed', available_to_live_console:true, active_version_id:'v700' };
const mockFetch = async (url, init={}) => {
  const pathname = new URL(url).pathname; const method=init.method||'GET'; calls.push({pathname,method,body:init.body?JSON.parse(init.body):null,headers:init.headers});
  let body;
  if (pathname.endsWith('/api/entities/KBDocument') && method==='GET') body=[];
  else if (pathname.endsWith('/api/entities/KBDocument') && method==='POST') body={ ...candidate, id:'sg-700' };
  else if (pathname.endsWith('/api/functions/kbReviewExecute')) body={ ok:true, review_id:'review-700', publish_decision:'ready', idempotent:false };
  else if (pathname.endsWith('/api/functions/kbPublishStart')) body={ operation:{id:'op-700'}, idempotent:false };
  else if (pathname.endsWith('/api/functions/kbPublishGetStatus')) body={ operation:{id:'op-700',status:'completed'} };
  else if (pathname.endsWith('/api/entities/KBDocument/sg-700') && method==='GET') body=finalLive;
  else throw new Error(`unexpected mock route ${method} ${pathname}`);
  return { ok:true, status:200, async json(){ return body; } };
};
const migrated = await executeMigration(oneNormalized, env, mockFetch, async()=>{});
assert.equal(migrated.processed,1);
assert.equal(migrated.results[0].state,'published');
assert.equal(migrated.parity.ready,true);
assert.equal(calls.filter(c=>c.pathname.endsWith('/api/entities/KBDocument') && c.method==='POST').length,1);
assert.equal(calls.filter(c=>c.pathname.endsWith('/api/functions/kbReviewExecute')).length,1);
assert.equal(calls.filter(c=>c.pathname.endsWith('/api/functions/kbPublishStart')).length,1);
const createBody=calls.find(c=>c.pathname.endsWith('/api/entities/KBDocument') && c.method==='POST').body;
assert.equal('company_id' in createBody,false); assert.equal('tenant_id' in createBody,false);
const publishBody=calls.find(c=>c.pathname.endsWith('/api/functions/kbPublishStart')).body;
assert.equal(publishBody.document_bindings[0].expected_content_hash,canonicalHash(one.raw_content));

// Idempotent rerun: exact live target => zero create/review/publish mutation calls.
const rerunCalls=[];
const rerunFetch=async(url,init={})=>{
  const pathname=new URL(url).pathname, method=init.method||'GET'; rerunCalls.push({pathname,method});
  if(pathname.endsWith('/api/entities/KBDocument')&&method==='GET') return {ok:true,status:200,async json(){return [finalLive];}};
  throw new Error('idempotent rerun attempted mutation');
};
const rerun=await executeMigration(oneNormalized,env,rerunFetch,async()=>{});
assert.equal(rerun.results[0].state,'skipped_existing_live');
assert.equal(rerun.parity.ready,true);
assert.equal(rerunCalls.length,1);

// Safety: missing B3 or control credential stops before first network/write.
let touched=false;
await assert.rejects(()=>executeMigration(oneNormalized,{WORKFLOW2_TASK2_3_ENABLE_MIGRATION_WRITES:'true'},async()=>{touched=true;}),/MIGRATION_CONTROL_CREDENTIAL_MISSING/);
assert.equal(touched,false);
await assert.rejects(()=>executeMigration(oneNormalized,{WORKFLOW2_TASK2_3_ENABLE_MIGRATION_WRITES:'true',SINGAPORE_BACKEND_TOKEN:'b'.repeat(24)},async()=>{touched=true;}),/MIGRATION_REVIEW_EXECUTOR_MISSING/);
assert.equal(touched,false);

console.log('PASS Workflow2 Task2.3: canonical validation + production write engine + review/publish/readback/idempotency safety');
