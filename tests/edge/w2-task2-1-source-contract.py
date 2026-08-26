#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else '.')
def rd(p): return (r/p).read_text(encoding='utf-8')
f=rd('sql/pr7/pr7_company_dual_identity.sql')
rb=rd('sql/pr7/pr7_company_dual_identity.rollback.sql')
b=rd('scripts/w2-task2-1-company-identity-activate.sh')
br=rd('scripts/w2-task2-1-company-identity-rollback.sh')
g=rd('scripts/w2-task2-1-runtime-gate.sh')
assert 'platform_company_id bigint' in f
assert 'SET NOT NULL' in f
assert 'uq_company_platform_company_id' in f
assert 'pr7_company_identity_bootstrap_run' in f
assert 'company rows still exist' in rb
assert 'explicit production authorization missing' in b
assert 'Singapore mapping does not match canonical platform company id' in b
assert 'SELECT count(*) INTO n FROM public.company' in b
assert 'company_membership' not in b
assert 'conversation' not in b.lower()
assert 'No CASCADE' in br
assert 'rolled_back_at=now()' in br
assert 'membership_scope' in g
print('PASS W2 Task 2.1 source contract')
