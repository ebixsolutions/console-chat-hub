#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const SOURCE_TYPES = new Set([
  'Product','FAQ','Article','Guide','Policy','DeliveryPolicy','RefundPolicy','PrivacyPolicy',
  'TermsAndConditions','PaymentPolicy','ServiceSOP','BrandToneGuide','InstallationGuide',
  'WarrantyPolicy','AfterSalesPolicy','SizeGuide','Other',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_EXPECTED_COUNT = 216;

export function canonicalHash(content) {
  return crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

function text(v) { return typeof v === 'string' ? v.trim() : ''; }

export function normalizeManifest(input, expectedCount = DEFAULT_EXPECTED_COUNT) {
  const docs = Array.isArray(input) ? input : input?.documents;
  if (!Array.isArray(docs)) throw new Error('MANIFEST_DOCUMENTS_REQUIRED');

  const seen = new Set();
  const normalized = [];
  const diagnostics = {
    expected_count: expectedCount,
    actual_count: docs.length,
    duplicate_global_document_ids: [],
    invalid_global_document_ids: [],
    invalid_source_types: [],
    missing_required_metadata: [],
    content_unrecoverable: [],
    missing_hash_recomputed: [],
    stale_hash_recomputed: [],
  };

  for (const [index, raw] of docs.entries()) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const gid = text(d.global_document_id);
    const sourceType = text(d.source_type);
    const name = text(d.name);
    const industry = text(d.industry);
    const version = text(d.version) || '1.0';
    const rawContent = typeof d.raw_content === 'string' ? d.raw_content : null;
    const content = rawContent?.trim() ? rawContent : null;

    if (!UUID_RE.test(gid)) diagnostics.invalid_global_document_ids.push({ index, global_document_id: gid || null });
    if (gid && seen.has(gid)) diagnostics.duplicate_global_document_ids.push(gid);
    if (gid) seen.add(gid);
    if (!SOURCE_TYPES.has(sourceType)) diagnostics.invalid_source_types.push({ index, global_document_id: gid || null, source_type: sourceType || null });
    if (!name || !industry || !version) diagnostics.missing_required_metadata.push({ index, global_document_id: gid || null });

    let computedHash = null;
    let hashSource = 'unavailable';
    if (content !== null) {
      computedHash = canonicalHash(rawContent);
      const persisted = text(d.content_hash).toLowerCase();
      if (!persisted) {
        diagnostics.missing_hash_recomputed.push(gid || `index:${index}`);
        hashSource = 'recomputed_missing';
      } else if (persisted !== computedHash) {
        diagnostics.stale_hash_recomputed.push(gid || `index:${index}`);
        hashSource = 'recomputed_stale';
      } else {
        hashSource = 'persisted_verified';
      }
    } else {
      diagnostics.content_unrecoverable.push({
        global_document_id: gid || null,
        base44_document_id: text(d.id || d.base44_document_id) || null,
        name: name || null,
        source_type: sourceType || null,
        version,
        reason: 'RAW_CONTENT_VERSION_AND_ACTIVE_VECTOR_SOURCE_UNAVAILABLE',
      });
    }

    normalized.push({
      ...d,
      global_document_id: gid,
      name,
      source_type: sourceType,
      industry,
      version,
      raw_content: rawContent,
      canonical_content_hash: computedHash,
      content_hash_source: hashSource,
    });
  }

  diagnostics.count_mismatch = docs.length !== expectedCount;
  diagnostics.content_resolvable = docs.length - diagnostics.content_unrecoverable.length;
  diagnostics.blocking_issue_count =
    (diagnostics.count_mismatch ? 1 : 0) +
    diagnostics.duplicate_global_document_ids.length +
    diagnostics.invalid_global_document_ids.length +
    diagnostics.invalid_source_types.length +
    diagnostics.missing_required_metadata.length +
    diagnostics.content_unrecoverable.length;

  return { documents: normalized, diagnostics };
}

export function reconcile(expectedManifest, singaporeData, expectedCount = DEFAULT_EXPECTED_COUNT) {
  const source = normalizeManifest(expectedManifest, expectedCount);
  const actualDocs = Array.isArray(singaporeData) ? singaporeData : singaporeData?.documents;
  if (!Array.isArray(actualDocs)) throw new Error('SINGAPORE_DOCUMENTS_REQUIRED');

  const expectedById = new Map(source.documents.map(d => [d.global_document_id, d]));
  const actualById = new Map();
  const duplicateActual = [];
  for (const d of actualDocs) {
    const gid = text(d?.global_document_id);
    if (actualById.has(gid)) duplicateActual.push(gid);
    actualById.set(gid, d);
  }

  const missing = [];
  const mismatches = [];
  for (const [gid, e] of expectedById) {
    const a = actualById.get(gid);
    if (!a) { missing.push(gid); continue; }
    const actualHash = text(a.content_hash).toLowerCase() || (typeof a.raw_content === 'string' ? canonicalHash(a.raw_content) : '');
    const fields = [];
    if (text(a.source_type) !== e.source_type) fields.push('source_type');
    if (text(a.version || '1.0') !== e.version) fields.push('version');
    if (e.canonical_content_hash && actualHash !== e.canonical_content_hash) fields.push('content_hash');
    if (text(a.status) !== 'published') fields.push('status');
    if (text(a.production_vector_status) !== 'indexed') fields.push('production_vector_status');
    if (a.available_to_live_console !== true) fields.push('available_to_live_console');
    if (fields.length) mismatches.push({ global_document_id: gid, fields });
  }
  const unexpected = [...actualById.keys()].filter(gid => gid && !expectedById.has(gid));

  const result = {
    expected: expectedById.size,
    actual: actualDocs.length,
    missing,
    unexpected,
    duplicate_global_document_ids: duplicateActual,
    mismatches,
    source_blockers: source.diagnostics.blocking_issue_count,
  };
  result.ready = result.expected === expectedCount && result.actual === expectedCount &&
    result.missing.length === 0 && result.unexpected.length === 0 &&
    result.duplicate_global_document_ids.length === 0 && result.mismatches.length === 0 &&
    result.source_blockers === 0;
  return result;
}

export function resolveControlHeader(env = process.env) {
  const serviceRole = [env.SINGAPORE_SERVICE_ROLE_SECRET, env.KB_SINGAPORE_SERVICE_ROLE_SECRET, env.SERVICE_ROLE_SECRET]
    .map(v => text(v)).find(Boolean);
  if (serviceRole) return { header: 'x-service-role-secret', value: serviceRole, kind: 'service_role' };
  const bearer = text(env.SINGAPORE_BACKEND_TOKEN);
  if (bearer) return { header: 'Authorization', value: `Bearer ${bearer}`, kind: 'bearer' };
  return null;
}

function parseArgs(argv) {
  const out = { expectedCount: DEFAULT_EXPECTED_COUNT, commit: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--normalized-out') out.normalizedOut = argv[++i];
    else if (a === '--singapore-export') out.singaporeExport = argv[++i];
    else if (a === '--expected-count') out.expectedCount = Number(argv[++i]);
    else if (a === '--commit') out.commit = true;
    else throw new Error(`UNKNOWN_ARGUMENT:${a}`);
  }
  if (!out.manifest) throw new Error('MANIFEST_PATH_REQUIRED');
  if (!Number.isInteger(out.expectedCount) || out.expectedCount < 1) throw new Error('EXPECTED_COUNT_INVALID');
  return out;
}

function loadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function safeWrite(file, data) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const args = parseArgs(process.argv);
  const manifest = loadJson(args.manifest);
  const normalized = normalizeManifest(manifest, args.expectedCount);
  if (args.normalizedOut) safeWrite(args.normalizedOut, normalized);

  let reconciliation = null;
  if (args.singaporeExport) reconciliation = reconcile(normalized.documents, loadJson(args.singaporeExport), args.expectedCount);

  const output = {
    mode: args.commit ? 'commit' : 'dry_run',
    diagnostics: normalized.diagnostics,
    reconciliation,
    control_credential_present: !!resolveControlHeader(),
    control_credential_kind: resolveControlHeader()?.kind ?? null,
    review_executor_status: 'unavailable_in_current_singapore_openapi',
  };
  console.log(JSON.stringify(output, null, 2));

  if (args.commit) {
    if (normalized.diagnostics.blocking_issue_count > 0) throw new Error('MIGRATION_SOURCE_BLOCKED');
    if (!resolveControlHeader()) throw new Error('MIGRATION_CONTROL_CREDENTIAL_MISSING');
    // Current Singapore OpenAPI exposes KBReview/KBAgentResult entity CRUD but no
    // review/agent execution endpoint. Creating synthetic PASS rows would bypass
    // kbPublishStart release gates, so production writes intentionally fail closed.
    throw new Error('MIGRATION_REVIEW_EXECUTOR_UNAVAILABLE');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(String(err?.message || err));
    process.exitCode = 2;
  });
}
