#!/usr/bin/env python3
from pathlib import Path
import json, re, sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.')

def read(p):
    f = root / p
    assert f.is_file() and f.stat().st_size > 0, f'missing/empty {p}'
    return f.read_text()

cfg = json.loads(read('config/b3-1-review-executor-closure.json'))
migration = read('scripts/workflow2-task2-3-kb-migration.mjs')
auth = read('supabase/functions/_shared/kb-auth.ts')

assert cfg['task'] == 'B3.1'
assert cfg['authoritative_backend']['source_control'] == 'SVN'
assert cfg['authoritative_backend']['review_route'] == '/api/functions/kbReviewExecute'
assert cfg['frozen_package']['sha256'] == 'aa1309a7a95cb7688fccd884b34dc0a7b2429d1c94e3933e52e644eee1da4948'
assert cfg['frozen_package']['source_status'] == 'PASS_FROZEN'
assert cfg['credential_contract']['rag_tenant_api_key_forbidden'] is True
assert cfg['credential_contract']['manual_user_secret_handoff_forbidden'] is True

# Migration caller must bind exact source identity and never accept caller tenant/company identity.
for marker in [
    'invokeReviewExecutor',
    'expected_global_document_id',
    'expected_version',
    'expected_content_hash',
    'MIGRATION_REVIEW_NOT_APPROVED',
    "['ready','ready_with_review']",
    '/api/functions/kbReviewExecute',
]:
    assert marker in migration, f'missing migration marker: {marker}'
review_slice = migration[migration.index('export async function invokeReviewExecutor'):migration.index('export function buildSingaporeCandidate')]
assert 'company_id:' not in review_slice
assert 'tenant_id:' not in review_slice

# Control plane must not reuse the RAG x-api-key path.
control = auth[auth.index('export async function resolveSingaporeControlCredential'):auth.index('export function singaporeCredentialHeaders')]
assert 'tenantApiKeys' not in control, 'control resolver must not select tenant RAG API keys'
assert 'SINGAPORE_SERVICE_ROLE_SECRET' in auth
assert 'SINGAPORE_BACKEND_TOKEN' in auth
assert 'resolveSingaporeControlCredential' in auth

# Guard against reintroducing the historical false-PASS patterns.
for forbidden in [
    'fake KBReview',
    'fake KBAgentResult',
    'publish bypass',
]:
    assert forbidden.lower() not in migration.lower()

print('B3_1_SOURCE_CONTRACT=PASS')
