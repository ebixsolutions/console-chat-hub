#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node --check scripts/workflow2-task2-3-kb-migration.mjs
node --check scripts/workflow2-task2-3-canonical-source.mjs
node tests/workflow2-task2-3-kb-migration.test.mjs
node tests/workflow2-task2-3-canonical-source.test.mjs

python3 - <<'PY'
from pathlib import Path
import json

contract = json.loads(Path('config/workflow2-task2-3-canonical-corpus.json').read_text())
assert contract['expected_canonical_count'] == 210
assert contract['predicate'] == {
    'status': 'published',
    'production_vector_status': 'indexed',
    'available_to_live_console': True,
}
assert contract['archived_legacy_records_excluded'] == 6
assert contract['hash_contract'] == 'SHA256(trim(raw_content))'

source = Path('scripts/workflow2-task2-3-canonical-source.mjs').read_text()
for marker in [
    'EXPECTED_CANONICAL_COUNT = 210',
    "document?.status === 'published'",
    "document?.production_vector_status === 'indexed'",
    'document?.available_to_live_console === true',
    'canonical_predicate_failures',
    'normalizeManifest',
    'reconcile',
]:
    assert marker in source, marker

# The latest canonical contract must never re-introduce the six archived records
# as required migration inputs or silently restore the stale 216 expectation.
assert 'EXPECTED_CANONICAL_COUNT = 216' not in source
print('PASS Task2.3 canonical corpus contract: 210')
PY

git diff --check

echo "PASS Workflow2 Task2.3 canonical source final gate"
