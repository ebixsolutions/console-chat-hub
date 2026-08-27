#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
cfg=(r/"config/w3-task3-3-dev-identity.env").read_text()
g=(r/"scripts/w3-task3-2-runtime-fixture-config-gate.sh").read_text()
assert "PR10_TENANT_A_USER_UUID=3bdf936e-b543-41d8-9fff-fa020a85f3f6" in cfg
assert "PR10_TENANT_A_AGENT_PROFILE_UUID=d4a09559-e99d-4fd7-9da5-6bddf0937795" in cfg
assert "PR10_TENANT_A_VISITOR_SESSION_UUID=5c3bce83-b6eb-4bc9-87be-ba950cac8347" in cfg
assert "PR10_TENANT_A_CONVERSATION_UUID=9da10c25-dcd9-42d2-926b-393b79763214" in cfg
assert "PR10_TENANT_B_USER_UUID=3b5c0844-245c-490b-b062-b877c7cd8c59" in cfg
assert "PR10_TWO_TENANT_FIXTURES_APPROVED=YES" in cfg
assert "PR10_EDGE_API_FIXTURES_APPROVED=YES" in cfg
assert "PR10_MUTATION_FIXTURES_APPROVED=YES" in cfg
active=[x for x in cfg.splitlines() if not x.lstrip().startswith("#")]
assert not any("BEARER_TOKEN=" in x or "API_KEYS_JSON=" in x or "ACCESS_TOKEN=" in x for x in active)
for required in ["PR10_TENANT_A_BEARER_TOKEN","PR10_TENANT_B_BEARER_TOKEN","KB_SINGAPORE_TENANT_MAP_JSON","KB_SINGAPORE_TENANT_API_KEYS_JSON"]:
    assert required in g
print("PASS W3 Task 3.2 DEV runtime fixture config source contract")
