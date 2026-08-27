#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(r/"scripts/w3-task3-3-production-activate.sh").read_text()
a=s.index("bash scripts/w3-task3-1-product-surface-final-gate.sh")
b=s.index("bash scripts/w2-task2-1-final-gate.sh")
assert a < b
t21=s.index("bash scripts/w2-task2-1-final-gate.sh")
t22=s.index("bash scripts/w2-task2-2-final-gate.sh")
tb=s.index("bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh")
assert t21 < t22 < tb
t23=s.index("bash scripts/w2-task2-3-final-gate.sh")
assert tb < t23
cfg=s.index("bash scripts/w3-task3-2-runtime-fixture-config-gate.sh")
sec=s.index("bash scripts/w3-task3-2-security-final-gate.sh")
assert cfg < sec
assert "W3_DEV_FIXTURE_WRITE_AUTHORIZED=YES" in s
assert 'branch --show-current' in s and '= main' in s
print("PASS W3 Task 3.3 DEV final activation orchestrator source contract")
