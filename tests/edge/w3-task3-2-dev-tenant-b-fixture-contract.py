#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else '.')
cfg=(r/'config/w3-task3-3-dev-identity.env').read_text(); b=(r/'scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh').read_text(); rb=(r/'scripts/w3-task3-2-dev-tenant-b-fixture-rollback.sh').read_text()
assert 'PR10_TENANT_B_PLATFORM_COMPANY_ID=5' in cfg
assert 'PR10_TENANT_B_USER_UUID=3b5c0844-245c-490b-b062-b877c7cd8c59' in cfg
assert 'W3_DEV_FIXTURE_WRITE_AUTHORIZED' in b
assert 'selected authenticated user missing/mismatch' in b
assert 'company identity collision' in b
assert 'INSERT INTO public.company_membership' in b and 'INSERT INTO public.agent_profile' in b
assert 'INSERT INTO public.visitor_session' in b and 'INSERT INTO public.conversations' in b
assert 'DELETE FROM public.company' in rb
print('PASS W3 Task 3.2 DEV Tenant B fixture source contract')
