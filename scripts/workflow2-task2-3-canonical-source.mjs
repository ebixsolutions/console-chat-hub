#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeManifest,
  reconcile,
} from './workflow2-task2-3-kb-migration.mjs';

export const EXPECTED_CANONICAL_COUNT = 210;

export function isCanonicalLiveDocument(document) {
  return document?.status === 'published' &&
    document?.production_vector_status === 'indexed' &&
    document?.available_to_live_console === true;
}

export function validateCanonicalSource(input) {
  const documents = Array.isArray(input) ? input : input?.documents;
  if (!Array.isArray(documents)) throw new Error('MANIFEST_DOCUMENTS_REQUIRED');

  const noncanonical = documents
    .map((document, index) => ({ document, index }))
    .filter(({ document }) => !isCanonicalLiveDocument(document))
    .map(({ document, index }) => ({
      index,
      id: document?.id ?? null,
      global_document_id: document?.global_document_id ?? null,
      status: document?.status ?? null,
      production_vector_status: document?.production_vector_status ?? null,
      available_to_live_console: document?.available_to_live_console ?? null,
    }));

  const normalized = normalizeManifest(
    { documents },
    EXPECTED_CANONICAL_COUNT,
    null,
  );

  const diagnostics = {
    ...normalized.diagnostics,
    canonical_predicate_failures: noncanonical,
  };
  diagnostics.blocking_issue_count += noncanonical.length;

  return {
    documents: normalized.documents,
    migration_documents: normalized.migration_documents,
    diagnostics,
    ready:
      diagnostics.actual_source_count === EXPECTED_CANONICAL_COUNT &&
      diagnostics.migration_expected_count === EXPECTED_CANONICAL_COUNT &&
      diagnostics.content_unrecoverable.length === 0 &&
      diagnostics.canonical_predicate_failures.length === 0 &&
      diagnostics.blocking_issue_count === 0,
  };
}

export function reconcileCanonicalSource(expectedManifest, singaporeData) {
  const source = validateCanonicalSource(expectedManifest);
  const parity = reconcile(
    expectedManifest,
    singaporeData,
    EXPECTED_CANONICAL_COUNT,
    null,
  );
  return {
    ...parity,
    source_ready: source.ready,
    canonical_predicate_failures: source.diagnostics.canonical_predicate_failures,
    ready: source.ready && parity.ready,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--singapore-export') out.singaporeExport = argv[++i];
    else if (arg === '--normalized-out') out.normalizedOut = argv[++i];
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  if (!out.manifest) throw new Error('MANIFEST_PATH_REQUIRED');
  return out;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeWrite(file, data) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function main() {
  const args = parseArgs(process.argv);
  const manifest = loadJson(args.manifest);
  const source = validateCanonicalSource(manifest);
  const parity = args.singaporeExport
    ? reconcileCanonicalSource(manifest, loadJson(args.singaporeExport))
    : null;

  const output = {
    authoritative_expected_count: EXPECTED_CANONICAL_COUNT,
    source,
    parity,
  };
  if (args.normalizedOut) safeWrite(args.normalizedOut, output);
  console.log(JSON.stringify(output, null, 2));

  if (!source.ready || (parity && !parity.ready)) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
