#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else '.')
a=(r/'scripts/w3-task3-3-production-activate.sh').read_text()
s=(r/'scripts/w3-task3-3-whole-product-smoke.sh').read_text()
f=(r/'scripts/w3-task3-3-final-gate.sh').read_text()
for marker in ['w2-task2-1-final-gate.sh','w2-task2-2-final-gate.sh','w2-task2-3-final-gate.sh','w1-task1-3-final-gate.sh','w3-task3-2-security-final-gate.sh']:
    assert marker in a
assert 'explicit final production activation authorization missing' in a
assert 'npm run build' in a
assert 'W3_T3_2_RUN_PRODUCTION=true' in a
assert 'widget-live-ai-test' in s
assert 'training-kb-finalize' in s
assert 'health-check' in s
assert 'w3-task3-1-product-surface-final-gate.sh' in s
assert 'w3-task3-3-production-activate.sh' in f
assert 'w3-task3-3-whole-product-smoke.sh' in f
print('PASS W3 Task 3.3 source contract')
