#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
c=(r/"scripts/w3-task3-3-run-final-activation.command").read_text()
f=(r/"scripts/w3-task3-3-final-gate.sh").read_text()

assert 'W3_T3_3_PRODUCTION_AUTHORIZED=YES' in c
assert 'W3_T3_3_RUN_PRODUCTION=true' in c
assert 'bash scripts/w3-task3-3-final-gate.sh "$REPO"' in c
assert 'bash scripts/w3-task3-3-production-activate.sh' not in c

# True final gate must retain activation + whole-product smoke ordering.
a=f.index('bash scripts/w3-task3-3-production-activate.sh')
s=f.index('bash scripts/w3-task3-3-whole-product-smoke.sh')
ready=f.index('echo "W3 TASK 3.3 FINAL STATUS: READY"')
assert a < s < ready

assert 'FINAL PRODUCT-READY ACTIVATION: PASS' in c
print("PASS one-click final activation invokes true final gate")
