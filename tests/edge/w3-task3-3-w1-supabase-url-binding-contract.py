#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
a=(r/"scripts/w3-task3-3-production-activate.sh").read_text()
w=(r/"scripts/w1-task1-3-widget-runtime-smoke.sh").read_text()

assert 'export SUPABASE_URL="${SUPABASE_URL:-https://${W3_T3_3_PROJECT_REF}.supabase.co}"' in a
assert 'SUPABASE_URL="${SUPABASE_URL:-}"' in w
assert '[ -n "$SUPABASE_URL" ] || stop "SUPABASE_URL missing"' in w

# URL binding must occur before W1 Task1.2 / Task1.3 runtime gates.
bind=a.index('export SUPABASE_URL="${SUPABASE_URL:-https://${W3_T3_3_PROJECT_REF}.supabase.co}"')
t12=a.index('bash scripts/w1-task1-2-kb-contract-final-gate.sh')
t13=a.index('bash scripts/w1-task1-3-final-gate.sh')
assert bind < t12 < t13

# Never derive privileged credentials from project metadata.
assert 'SUPABASE_SERVICE_ROLE_KEY=' not in a
assert 'SUPABASE_ACCESS_TOKEN=' not in a

print("PASS W1 Supabase runtime URL binding source contract")
