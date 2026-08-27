#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
setup=(r/"scripts/w3-task3-3-runtime-inputs-setup.command").read_text()
load=(r/"scripts/w3-task3-3-runtime-inputs-load.sh").read_text()
activate=(r/"scripts/w3-task3-3-production-activate.sh").read_text()

marker="W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED"
assert marker in setup
assert marker in load
assert marker in activate
assert 'type YES' in setup
assert 'Lovable-native Supabase Edge deployment confirmation missing/invalid' in load

# Confirmation must be checked before any mutating activation task.
pre=activate.index('Lovable-native Supabase Edge deployment not confirmed before activation')
t21=activate.index('bash scripts/w2-task2-1-final-gate.sh')
t22=activate.index('bash scripts/w2-task2-2-final-gate.sh')
tb=activate.index('bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh')
assert pre < t21 < t22 < tb

# No fake auto-confirmation inside activation.
assert 'export W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED=YES' not in activate

print("PASS pre-mutation Lovable-native deployment confirmation contract")
