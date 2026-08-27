#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
g=(r/"scripts/w2-task2-1-two-tenant-identity-runtime-gate.sh").read_text()
a=(r/"scripts/w3-task3-3-production-activate.sh").read_text()

assert "W2 TASK 2.1 TWO-TENANT IDENTITY STATUS: PASS" in g
assert "uq_company_platform_company_id" in g
assert "identity_collision" in g
assert "cross_membership" in g
assert "tenant_b_conversation" in g

# Fixed config is explicitly Product-ready; dynamic identity is deferred.
assert "W2_T2_1_CANONICAL_COMPANY_UUID" in g
assert "W2_T2_1_CANONICAL_PLATFORM_COMPANY_ID" in g
assert "PR10_TENANT_B_COMPANY_UUID" in g
assert "PR10_TENANT_B_PLATFORM_COMPANY_ID" in g

# The coexistence proof must run only after Tenant B is created and before learning/runtime.
bootstrap=a.index("bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh")
identity=a.index("bash scripts/w2-task2-1-two-tenant-identity-runtime-gate.sh")
learning=a.index("bash scripts/w2-task2-3-final-gate.sh")
assert bootstrap < identity < learning

# Never assume only two companies globally.
assert "count(*) FROM public.company" not in g
assert "=2" not in g

print("PASS W2 Task2.1 fixed two-tenant identity closure source contract")
