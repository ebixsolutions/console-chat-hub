#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
cfg=(r/"config/w3-task3-3-dev-identity.env").read_text()
act=(r/"scripts/w3-task3-3-production-activate.sh").read_text()
assert "W2_T2_2_LEGACY_SINGLE_COMPANY_CONFIRMED=YES" in cfg
assert "W2_T2_2_ORPHAN_CONVERSATIONS_CONFIRMED=YES" in cfg
assert "W2_T2_1_CANONICAL_PLATFORM_COMPANY_ID=1" in cfg
assert "PR10_TENANT_B_PLATFORM_COMPANY_ID=5" in cfg
assert "API key MUST come from secret/env" in cfg
active=[x for x in cfg.splitlines() if not x.lstrip().startswith("#")]
assert not any("API_KEY=" in x or "TOKEN=" in x for x in active)
assert 'source "$CFG"' in act
assert "branch --show-current" in act and "= main" in act
print("PASS W3 Task 3.3 DEV identity/config contract")
