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
c = json.loads(Path('config/workflow2-task2-3-canonical-corpus.json').read_text())
assert c['schema_version'] == '1.0'
assert c['authoritative_source'] == 'Base44 KBDocument live canonical predicate'
assert c['expected_canonical_count'] == 210
assert c['archived_legacy_records_excluded'] == 6
assert c['predicate'] == {
  'status': 'published',
  'production_vector_status': 'indexed',
  'available_to_live_console': True,
}
assert c['hash_contract'] == 'SHA256(trim(raw_content))'
required = [
  'SINGAPORE_SERVICE_ROLE_SECRET','KB_SINGAPORE_SERVICE_ROLE_SECRET','SERVICE_ROLE_SECRET','SINGAPORE_BACKEND_TOKEN','x-service-role-secret',
  'MIGRATION_SOURCE_BLOCKED','MIGRATION_CONTROL_CREDENTIAL_MISSING','WORKFLOW2_TASK2_3_ENABLE_MIGRATION_WRITES','MIGRATION_WRITES_NOT_AUTHORIZED',
  'KB_REVIEW_EXECUTOR_URL','KB_REVIEW_EXECUTOR_SERVICE_SECRET','MIGRATION_REVIEW_EXECUTOR_MISSING','invokeReviewExecutor',
  'expected_global_document_id','expected_version','expected_content_hash','MIGRATION_REVIEW_NOT_APPROVED',
  'buildSingaporeCandidate','createSingaporeCandidate','classifyExistingTarget','MIGRATION_EXISTING_DOCUMENT_CONFLICT',
  'document_bindings','kbPublishStart','kbPublishGetStatus','waitForPublish','verifyPublishedTarget','MIGRATION_FINAL_PARITY_FAILED',
  'content_unrecoverable','canonical_content_hash',"String(content ?? '').trim()",
  "'ReturnPolicy'","'ManualQA'","'GlossaryEntry'",
]
for marker in required:
    assert marker in p, f'missing marker: {marker}'
assert 'MIGRATION_WRITE_ENGINE_NOT_ENABLED' not in p, 'write engine must be implemented'
assert 'MIGRATION_REVIEW_EXECUTOR_UNAVAILABLE' not in p
assert 'KB_SINGAPORE_TENANT_API_KEYS_JSON' not in p, 'RAG API key must not be used by migration control tooling'
review_slice = p[p.find('invokeReviewExecutor'):p.find('export function buildSingaporeCandidate')]
assert 'company_id:' not in review_slice
assert 'tenant_id:' not in review_slice
candidate_slice = p[p.find('export function buildSingaporeCandidate'):p.find('function actualHash')]
assert 'company_id:' not in candidate_slice
assert 'tenant_id:' not in candidate_slice
source_decl = p[p.find('const SOURCE_TYPES'):p.find('const UUID_RE')]
assert 'RefundPolicy' not in source_decl
assert 'AfterSalesPolicy' not in source_decl
print('TASK2_3_MIGRATION_SOURCE_CONTRACT=PASS')
PY

git diff --check

echo "TASK2_3_MIGRATION_FINAL_GATE=PASS"
