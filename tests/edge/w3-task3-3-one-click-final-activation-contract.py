#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(r/"scripts/w3-task3-3-run-final-activation.command").read_text()
assert 'branch --show-current' in s
assert 'working tree must be clean' in s
assert 'git -C "$REPO" fetch origin main --quiet' in s
assert 'LOCAL="$(git -C "$REPO" rev-parse HEAD)"' in s
assert 'REMOTE="$(git -C "$REPO" rev-parse origin/main)"' in s
assert '[ "$LOCAL" = "$REMOTE" ]' in s
assert 'run w3-task3-3-runtime-inputs-setup.command first' in s
assert 'Type ACTIVATE' in s
assert 'export W3_T3_3_PRODUCTION_AUTHORIZED=YES' in s
assert 'bash scripts/w3-task3-3-production-activate.sh' in s
print("PASS W3 Task 3.3 one-click final activation source contract")
