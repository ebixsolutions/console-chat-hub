#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(r/"scripts/w3-task3-3-production-activate.sh").read_text()

# Critical fix: fresh shell must auto-load DEV config by file existence.
assert 'CFG="$REPO/config/w3-task3-3-dev-identity.env"' in s
assert 'if [ -s "$CFG" ]; then' in s
assert 'source "$CFG"' in s
assert '[ "${W3_T3_3_DEV_CONFIG:-}" = "YES" ]' in s

# Regression guard: do not gate config loading on a variable defined by that config.
bad='if [ "${W3_T3_3_DEV_CONFIG:-}" = "YES" ]; then\n  CFG='
assert bad not in s

# Frozen sequencing.
source_gate=s.index("bash scripts/w3-task3-1-product-surface-final-gate.sh")
t21=s.index("bash scripts/w2-task2-1-final-gate.sh")
t22=s.index("bash scripts/w2-task2-2-final-gate.sh")
tb=s.index("bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh")
t23=s.index("bash scripts/w2-task2-3-final-gate.sh")
runtime_cfg=s.index("bash scripts/w3-task3-2-runtime-fixture-config-gate.sh")
security=s.index("bash scripts/w3-task3-2-security-final-gate.sh")
assert source_gate < t21 < t22 < tb < t23 < runtime_cfg < security

assert 'branch --show-current' in s
assert 'working tree must be clean' in s
assert 'W3_DEV_FIXTURE_WRITE_AUTHORIZED=YES' in s
print("PASS W3 Task 3.3 DEV autoload/final orchestration source contract")
