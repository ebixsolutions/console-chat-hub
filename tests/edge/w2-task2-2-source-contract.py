#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else '.')
a=(r/'scripts/w2-task2-2-canonical-ce-activate.sh').read_text()
g=(r/'scripts/w2-task2-2-runtime-gate.sh').read_text()
rb=(r/'scripts/w2-task2-2-rollback.sh').read_text()
assert 'Task 2.1 canonical company identity not active/exact' in a
assert 'pr7-company-membership-bootstrap.sh' in a
assert 'pr7-channel-ownership-bootstrap.sh' in a
assert 'pr7-conversation-lineage-bootstrap.sh' in a
assert 'pr20-ce-local-to-canonical-migrate.sh' in a
assert 'LEGACY_SINGLE_COMPANY_CONFIRMED' in a
assert 'ORPHAN_CONVERSATIONS_CONFIRMED' in a
assert 'company_membership' in g and 'canonical_evaluation_id' in g
assert 'evaluation_training_outbox' in g
assert 'nonmember CE visibility leak' in g
assert 'rollback blocked to preserve data integrity' in rb
assert 'CASCADE' not in rb.upper()
print('PASS W2 Task 2.2 source contract')
