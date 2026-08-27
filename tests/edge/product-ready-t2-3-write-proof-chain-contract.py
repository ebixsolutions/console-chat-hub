#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(r/"scripts/w2-task2-3-learning-loop-runtime-smoke.sh").read_text()
w=(r/"scripts/w1-task1-2-kb-contract-final-gate.sh").read_text()
a=(r/"scripts/w3-task3-3-production-activate.sh").read_text()

assert 'W2_T2_3_REQUIRE_KB_WRITE' in s
assert 'governed KB write path was not proven' in s
assert 'decision=trained did not include kb_update' in s
assert 'rag_new_content_verified' in s
assert 'export W2_T2_3_REQUIRE_KB_WRITE=YES' in a
assert 'W1_T1_2_WRITE_PROOF_CONFIRMED' in w
assert 'bash scripts/w2-task2-3-learning-loop-runtime-smoke.sh' not in w

t23=a.index('bash scripts/w2-task2-3-final-gate.sh')
proof=a.index('export W1_T1_2_WRITE_PROOF_CONFIRMED=YES')
t12=a.index('bash scripts/w1-task1-2-kb-contract-final-gate.sh')
assert t23 < proof < t12

print("PASS Task2.3 governed write proof chain source contract")
