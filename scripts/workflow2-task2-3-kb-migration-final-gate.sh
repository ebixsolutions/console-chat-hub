#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node --check scripts/workflow2-task2-3-kb-migration.mjs
node tests/workflow2-task2-3-kb-migration.test.mjs

python3 - <<'PY'
from pathlib import Path
p = Path('scripts/workflow2-task2-3-kb-migration.mjs').read_text()
required = [
  'SINGAPORE_SERVICE_ROLE_SECRET',
  'KB_SINGAPORE_SERVICE_ROLE_SECRET',
  'SERVICE_ROLE_SECRET',
  'SINGAPORE_BACKEND_TOKEN',
  'x-service-role-secret',
  'MIGRATION_SOURCE_BLOCKED',
  'MIGRATION_CONTROL_CREDENTIAL_MISSING',
  'KB_REVIEW_EXECUTOR_URL',
  'KB_REVIEW_EXECUTOR_SERVICE_SECRET',
  'MIGRATION_REVIEW_EXECUTOR_MISSING',
  'invokeReviewExecutor',
  'expected_global_document_id',
  'expected_content_hash',
  'MIGRATION_REVIEW_NOT_APPROVED',
  'MIGRATION_WRITE_ENGINE_NOT_ENABLED',
  'content_unrecoverable',
  'duplicate_global_document_ids',
  'canonical_content_hash',
  "String(content ?? '').trim()",
]
for marker in required:
    assert marker in p, f'missing marker: {marker}'
assert 'MIGRATION_REVIEW_EXECUTOR_UNAVAILABLE' not in p, 'obsolete unavailable marker must be removed after B3 implementation'
assert 'KB_SINGAPORE_TENANT_API_KEYS_JSON' not in p, 'RAG API key must not be used by migration control tooling'
assert 'company_id:' not in p[p.find('invokeReviewExecutor'):p.find('function parseArgs')], 'review caller must not inject company identity'
assert 'tenant_id:' not in p[p.find('invokeReviewExecutor'):p.find('function parseArgs')], 'review caller must not inject tenant identity'
assert 'console.log(resolveControlHeader' not in p
print('PASS source contract')
PY

git diff --check

echo "PASS Workflow2 Task2.3 final gate"
