#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node --check scripts/workflow2-task2-3-kb-migration.mjs
node tests/workflow2-task2-3-kb-migration.test.mjs

python3 - <<'PY'
from pathlib import Path
import json
p = Path('scripts/workflow2-task2-3-kb-migration.mjs').read_text()
qpath = Path('scripts/workflow2-task2-3-stale-live-metadata-quarantine.json')
q = json.loads(qpath.read_text())
assert q['source_inventory_expected'] == 216
assert len(q['records']) == 6
assert len({r['global_document_id'] for r in q['records']}) == 6
assert len({r['base44_document_id'] for r in q['records']}) == 6
required = [
  'SINGAPORE_SERVICE_ROLE_SECRET','KB_SINGAPORE_SERVICE_ROLE_SECRET','SERVICE_ROLE_SECRET','SINGAPORE_BACKEND_TOKEN','x-service-role-secret',
  'MIGRATION_SOURCE_BLOCKED','MIGRATION_CONTROL_CREDENTIAL_MISSING','KB_REVIEW_EXECUTOR_URL','KB_REVIEW_EXECUTOR_SERVICE_SECRET',
  'MIGRATION_REVIEW_EXECUTOR_MISSING','invokeReviewExecutor','expected_global_document_id','expected_content_hash','MIGRATION_REVIEW_NOT_APPROVED',
  'MIGRATION_WRITE_ENGINE_NOT_ENABLED','content_unrecoverable','stale_live_metadata_quarantined','quarantine_mismatch','quarantine_not_observed',
  'migration_expected_count','migration_disposition','isStrictStaleLiveMetadata','canonical_content_hash',"String(content ?? '').trim()",
  "'ReturnPolicy'","'ManualQA'","'GlossaryEntry'",
]
for marker in required:
    assert marker in p, f'missing marker: {marker}'
assert 'MIGRATION_REVIEW_EXECUTOR_UNAVAILABLE' not in p
assert 'KB_SINGAPORE_TENANT_API_KEYS_JSON' not in p, 'RAG API key must not be used by migration control tooling'
assert 'company_id:' not in p[p.find('invokeReviewExecutor'):p.find('function parseArgs')]
assert 'tenant_id:' not in p[p.find('invokeReviewExecutor'):p.find('function parseArgs')]
assert 'console.log(resolveControlHeader' not in p
# Unsupported legacy names must not be accepted as canonical current Base44 source types.
source_decl = p[p.find('const SOURCE_TYPES'):p.find('const UUID_RE')]
assert 'RefundPolicy' not in source_decl
assert 'AfterSalesPolicy' not in source_decl
print('PASS source + B2 exact quarantine contract')
PY

git diff --check

echo "PASS Workflow2 Task2.3 final gate"
