#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const SOURCE_TYPES = new Set([
  'FAQ','Product','TermsAndConditions','Policy','ReturnPolicy','DeliveryPolicy','WarrantyPolicy',
  'PaymentPolicy','PrivacyPolicy','SizeGuide','InstallationGuide','ServiceSOP','BrandToneGuide',
  'ManualQA','Article','Guide','GlossaryEntry','Other',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_EXPECTED_SOURCE_COUNT = 216;

export function canonicalHash(content) {
  const normalized = String(content ?? '').trim();
  if (!normalized) throw new Error('EMPTY_PUBLISH_CONTENT');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}
function text(v) { return typeof v === 'string' ? v.trim() : ''; }
function integer(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

export function normalizeQuarantine(input) {
  if (!input) return new Map();
  const rows = Array.isArray(input) ? input : input?.records;
  if (!Array.isArray(rows)) throw new Error('QUARANTINE_RECORDS_REQUIRED');
  const map = new Map();
  for (const [index, raw] of rows.entries()) {
    const gid = text(raw?.global_document_id);
    if (!UUID_RE.test(gid)) throw new Error(`QUARANTINE_GLOBAL_DOCUMENT_ID_INVALID:${index}`);
    if (map.has(gid)) throw new Error(`QUARANTINE_DUPLICATE_GLOBAL_DOCUMENT_ID:${gid}`);
    map.set(gid, {
      base44_document_id: text(raw?.base44_document_id || raw?.id),
      global_document_id: gid,
      name: text(raw?.name),
      source_type: text(raw?.source_type),
      version: text(raw?.version) || '1.0',
      reason: text(raw?.reason) || 'STALE_LIVE_METADATA_NO_AUTHORITATIVE_CONTENT',
    });
  }
  return map;
}

export function isStrictStaleLiveMetadata(d) {
  const rawMissing = !(typeof d?.raw_content === 'string' && d.raw_content.trim());
  const noActiveVersion = !text(d?.active_version_id);
  const noVectors = integer(d?.vector_count) === 0 && integer(d?.chunk_count) === 0;
  return rawMissing && noActiveVersion && noVectors &&
    text(d?.status) === 'published' && text(d?.production_vector_status) === 'indexed' && d?.available_to_live_console === true;
}
function quarantineMatches(d, q) {
  return !!q && text(d?.id || d?.base44_document_id) === q.base44_document_id && text(d?.global_document_id) === q.global_document_id &&
    text(d?.name) === q.name && text(d?.source_type) === q.source_type && (text(d?.version) || '1.0') === q.version;
}

export function normalizeManifest(input, expectedSourceCount = DEFAULT_EXPECTED_SOURCE_COUNT, quarantineInput = null) {
  const docs = Array.isArray(input) ? input : input?.documents;
  if (!Array.isArray(docs)) throw new Error('MANIFEST_DOCUMENTS_REQUIRED');
  const quarantine = normalizeQuarantine(quarantineInput);
  const seen = new Set(); const normalized = []; const migrationDocuments = [];
  const diagnostics = {
    expected_source_count: expectedSourceCount, actual_source_count: docs.length,
    duplicate_global_document_ids: [], invalid_global_document_ids: [], invalid_source_types: [], missing_required_metadata: [],
    content_unrecoverable: [], stale_live_metadata_quarantined: [], quarantine_mismatch: [], quarantine_not_observed: [],
    missing_hash_recomputed: [], stale_hash_recomputed: [],
  };
  for (const [index, raw] of docs.entries()) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const gid = text(d.global_document_id), sourceType = text(d.source_type), name = text(d.name), industry = text(d.industry), version = text(d.version) || '1.0';
    const rawContent = typeof d.raw_content === 'string' ? d.raw_content : null; const content = rawContent?.trim() ? rawContent : null;
    if (!UUID_RE.test(gid)) diagnostics.invalid_global_document_ids.push({ index, global_document_id: gid || null });
    if (gid && seen.has(gid)) diagnostics.duplicate_global_document_ids.push(gid); if (gid) seen.add(gid);
    if (!SOURCE_TYPES.has(sourceType)) diagnostics.invalid_source_types.push({ index, global_document_id: gid || null, source_type: sourceType || null });
    if (!name || !industry || !version) diagnostics.missing_required_metadata.push({ index, global_document_id: gid || null });
    let computedHash = null, hashSource = 'unavailable', disposition = 'migrate';
    if (content !== null) {
      computedHash = canonicalHash(rawContent); const persisted = text(d.content_hash).toLowerCase();
      if (!persisted) { diagnostics.missing_hash_recomputed.push(gid || `index:${index}`); hashSource = 'recomputed_missing'; }
      else if (persisted !== computedHash) { diagnostics.stale_hash_recomputed.push(gid || `index:${index}`); hashSource = 'recomputed_stale'; }
      else hashSource = 'persisted_verified';
    } else {
      const q = quarantine.get(gid);
      if (q && isStrictStaleLiveMetadata(d) && quarantineMatches(d, q)) {
        disposition = 'quarantine_stale_live_metadata';
        diagnostics.stale_live_metadata_quarantined.push({ global_document_id: gid, base44_document_id: text(d.id || d.base44_document_id), name, source_type: sourceType, version, reason: q.reason });
      } else {
        if (q) diagnostics.quarantine_mismatch.push({ global_document_id: gid, reason: 'FINGERPRINT_OR_STALE_SIGNATURE_MISMATCH' });
        diagnostics.content_unrecoverable.push({ global_document_id: gid || null, base44_document_id: text(d.id || d.base44_document_id) || null, name: name || null, source_type: sourceType || null, version, reason: 'RAW_CONTENT_VERSION_AND_ACTIVE_VECTOR_SOURCE_UNAVAILABLE' });
      }
    }
    const out = { ...d, global_document_id: gid, name, source_type: sourceType, industry, version, raw_content: rawContent,
      canonical_content_hash: computedHash, content_hash_source: hashSource, migration_disposition: disposition };
    normalized.push(out); if (disposition === 'migrate') migrationDocuments.push(out);
  }
  for (const [gid, q] of quarantine) if (!seen.has(gid)) diagnostics.quarantine_not_observed.push({ global_document_id: gid, base44_document_id: q.base44_document_id });
  diagnostics.source_count_mismatch = docs.length !== expectedSourceCount;
  diagnostics.migration_expected_count = migrationDocuments.length; diagnostics.content_resolvable = migrationDocuments.length;
  diagnostics.quarantine_count = diagnostics.stale_live_metadata_quarantined.length;
  diagnostics.blocking_issue_count = (diagnostics.source_count_mismatch ? 1 : 0) + diagnostics.duplicate_global_document_ids.length +
    diagnostics.invalid_global_document_ids.length + diagnostics.invalid_source_types.length + diagnostics.missing_required_metadata.length +
    diagnostics.content_unrecoverable.length + diagnostics.quarantine_mismatch.length + diagnostics.quarantine_not_observed.length;
  return { documents: normalized, migration_documents: migrationDocuments, diagnostics };
}

export function reconcile(expectedManifest, singaporeData, expectedSourceCount = DEFAULT_EXPECTED_SOURCE_COUNT, quarantineInput = null) {
  const source = normalizeManifest(expectedManifest, expectedSourceCount, quarantineInput);
  const actualDocs = Array.isArray(singaporeData) ? singaporeData : singaporeData?.documents;
  if (!Array.isArray(actualDocs)) throw new Error('SINGAPORE_DOCUMENTS_REQUIRED');
  const expectedById = new Map(source.migration_documents.map(d => [d.global_document_id, d])); const actualById = new Map(); const duplicateActual = [];
  for (const d of actualDocs) { const gid = text(d?.global_document_id); if (actualById.has(gid)) duplicateActual.push(gid); actualById.set(gid, d); }
  const missing = [], mismatches = [];
  for (const [gid, e] of expectedById) {
    const a = actualById.get(gid); if (!a) { missing.push(gid); continue; }
    const actualHash = text(a.content_hash).toLowerCase() || (typeof a.raw_content === 'string' && a.raw_content.trim() ? canonicalHash(a.raw_content) : ''); const fields = [];
    if (text(a.source_type) !== e.source_type) fields.push('source_type'); if (text(a.version || '1.0') !== e.version) fields.push('version');
    if (e.canonical_content_hash && actualHash !== e.canonical_content_hash) fields.push('content_hash'); if (text(a.status) !== 'published') fields.push('status');
    if (text(a.production_vector_status) !== 'indexed') fields.push('production_vector_status'); if (a.available_to_live_console !== true) fields.push('available_to_live_console');
    if (fields.length) mismatches.push({ global_document_id: gid, fields });
  }
  const unexpected = [...actualById.keys()].filter(gid => gid && !expectedById.has(gid));
  const result = { source_observed: source.documents.length, expected: expectedById.size, actual: actualDocs.length, missing, unexpected,
    duplicate_global_document_ids: duplicateActual, mismatches, quarantined: source.diagnostics.quarantine_count, source_blockers: source.diagnostics.blocking_issue_count };
  result.ready = result.source_observed === expectedSourceCount && result.actual === result.expected && result.missing.length === 0 && result.unexpected.length === 0 &&
    result.duplicate_global_document_ids.length === 0 && result.mismatches.length === 0 && result.source_blockers === 0;
  return result;
}

export function resolveControlHeader(env = process.env) {
  const serviceRole = [env.SINGAPORE_SERVICE_ROLE_SECRET, env.KB_SINGAPORE_SERVICE_ROLE_SECRET, env.SERVICE_ROLE_SECRET].map(v => text(v)).find(Boolean);
  if (serviceRole) return { header: 'x-service-role-secret', value: serviceRole, kind: 'service_role' };
  const bearer = text(env.SINGAPORE_BACKEND_TOKEN); if (bearer) return { header: 'Authorization', value: `Bearer ${bearer}`, kind: 'bearer' }; return null;
}
export function resolveReviewExecutorConfig(env = process.env) {
  const url = text(env.KB_REVIEW_EXECUTOR_URL).replace(/\/$/, ''), secret = text(env.KB_REVIEW_EXECUTOR_SERVICE_SECRET); if (!url || !secret) return null;
  let parsed; try { parsed = new URL(url); } catch { throw new Error('REVIEW_EXECUTOR_URL_INVALID'); }
  if (parsed.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(parsed.hostname)) throw new Error('REVIEW_EXECUTOR_HTTPS_REQUIRED'); return { url, secret };
}
export async function invokeReviewExecutor(document, singaporeDocumentId, env = process.env, fetchImpl = fetch) {
  const cfg = resolveReviewExecutorConfig(env); if (!cfg) throw new Error('MIGRATION_REVIEW_EXECUTOR_MISSING');
  const gid = text(document?.global_document_id), version = text(document?.version) || '1.0', hash = text(document?.canonical_content_hash).toLowerCase();
  if (!UUID_RE.test(gid) || !singaporeDocumentId || !hash) throw new Error('REVIEW_EXECUTOR_BINDING_REQUIRED');
  const response = await fetchImpl(`${cfg.url}/api/functions/kbReviewExecute`, { method:'POST', headers:{'Content-Type':'application/json','x-service-role-secret':cfg.secret},
    body:JSON.stringify({ document_id:singaporeDocumentId, review_mode:'smart', idempotency_key:`migration:${gid}:${version}:${hash}`, expected_global_document_id:gid, expected_version:version, expected_content_hash:hash }) });
  const payload = await response.json().catch(() => ({})); if (!response.ok || payload?.ok !== true) throw new Error(`MIGRATION_REVIEW_EXECUTOR_FAILED:${response.status}`);
  if (!['ready','ready_with_review'].includes(payload.publish_decision)) throw new Error(`MIGRATION_REVIEW_NOT_APPROVED:${payload.publish_decision || 'unknown'}`);
  return { review_id:text(payload.review_id), publish_decision:payload.publish_decision, idempotent:payload.idempotent === true };
}
function parseArgs(argv) {
  const out = { expectedSourceCount:DEFAULT_EXPECTED_SOURCE_COUNT, commit:false };
  for (let i=2;i<argv.length;i++) { const a=argv[i];
    if (a==='--manifest') out.manifest=argv[++i]; else if (a==='--quarantine-manifest') out.quarantineManifest=argv[++i]; else if (a==='--normalized-out') out.normalizedOut=argv[++i];
    else if (a==='--singapore-export') out.singaporeExport=argv[++i]; else if (a==='--expected-count' || a==='--expected-source-count') out.expectedSourceCount=Number(argv[++i]); else if (a==='--commit') out.commit=true;
    else throw new Error(`UNKNOWN_ARGUMENT:${a}`); }
  if (!out.manifest) throw new Error('MANIFEST_PATH_REQUIRED'); if (!Number.isInteger(out.expectedSourceCount) || out.expectedSourceCount<1) throw new Error('EXPECTED_COUNT_INVALID'); return out;
}
function loadJson(file) { return JSON.parse(fs.readFileSync(file,'utf8')); }
function safeWrite(file,data) { const target=path.resolve(file); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,`${JSON.stringify(data,null,2)}\n`,{mode:0o600}); }
async function main() {
  const args=parseArgs(process.argv), manifest=loadJson(args.manifest), quarantine=args.quarantineManifest?loadJson(args.quarantineManifest):null;
  const normalized=normalizeManifest(manifest,args.expectedSourceCount,quarantine); if(args.normalizedOut)safeWrite(args.normalizedOut,normalized);
  const reconciliation=args.singaporeExport?reconcile(manifest,loadJson(args.singaporeExport),args.expectedSourceCount,quarantine):null; const reviewCfg=resolveReviewExecutorConfig();
  console.log(JSON.stringify({ mode:args.commit?'commit':'dry_run', diagnostics:normalized.diagnostics, reconciliation, control_credential_present:!!resolveControlHeader(),
    control_credential_kind:resolveControlHeader()?.kind??null, review_executor_status:reviewCfg?'configured':'not_configured' },null,2));
  if(args.commit){ if(normalized.diagnostics.blocking_issue_count>0)throw new Error('MIGRATION_SOURCE_BLOCKED'); if(!resolveControlHeader())throw new Error('MIGRATION_CONTROL_CREDENTIAL_MISSING');
    if(!reviewCfg)throw new Error('MIGRATION_REVIEW_EXECUTOR_MISSING'); throw new Error('MIGRATION_WRITE_ENGINE_NOT_ENABLED'); }
}
if(import.meta.url===`file://${process.argv[1]}`) main().catch(err=>{console.error(String(err?.message||err));process.exitCode=2;});
