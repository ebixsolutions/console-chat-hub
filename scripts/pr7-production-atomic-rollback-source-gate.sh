#!/bin/bash
set -Eeuo pipefail
DEP="scripts/pr7-production-deploy.sh"
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

[ -s "$DEP" ] || { echo "FAIL missing $DEP"; exit 1; }

must_have "$DEP" 'rollback_bootstrap(){ bash scripts/pr7-canonical-company-bootstrap-rollback.sh; }' "bootstrap rollback helper exists"

# Helper must be defined before first production schema mutation.
DEF_LINE="$(grep -nF 'rollback_bootstrap(){ bash scripts/pr7-canonical-company-bootstrap-rollback.sh; }' "$DEP" | head -1 | cut -d: -f1)"
MUT_LINE="$(grep -nF '== APPLY CANONICAL COMPANY IDENTITY SCHEMA ==' "$DEP" | head -1 | cut -d: -f1)"
if [ -n "$DEF_LINE" ] && [ -n "$MUT_LINE" ] && [ "$DEF_LINE" -lt "$MUT_LINE" ]; then
  pass "bootstrap rollback helper defined before first mutation"
else
  bad "bootstrap rollback helper must be defined before first mutation"
fi

must_have "$DEP" 'SQL_ROLLBACK_FOR_FORWARD=(' "exact SQL rollback mapping exists"
must_have "$DEP" 'sql_rollback_stack=()' "exact SQL rollback journal exists"
must_have "$DEP" 'sql_rollback_stack+=("$rb")' "successful SQL records exact rollback path"
must_have "$DEP" 'for ((i=${#sql_rollback_stack[@]}-1; i>=0; i--)); do' "SQL rollback executes reverse order"
must_have "$DEP" 'for ((local_i=${#functions_deployed[@]}-1; local_i>=0; local_i--)); do' "Edge rollback executes reverse order"
must_not_have "$DEP" 'sql_applied+=("$i")' "fragile index-only rollback journal removed"
must_not_have "$DEP" '${SQL_ROLLBACK[$idx]}' "fragile rollback index lookup removed"

python3 - "$DEP" <<'PY' || exit 1
import re,sys
text=open(sys.argv[1]).read()
def arr(name):
    m=re.search(rf'{name}=\((.*?)\n\)',text,re.S)
    if not m: raise SystemExit(f'FAIL missing array {name}')
    return re.findall(r'"([^"]+)"',m.group(1))
fwd=arr('SQL_FORWARD'); rb=arr('SQL_ROLLBACK_FOR_FORWARD')
if len(fwd)!=len(rb):
    print(f'FAIL SQL mapping length {len(fwd)} != {len(rb)}'); raise SystemExit(1)
for i,(a,b) in enumerate(zip(fwd,rb)):
    expected=a[:-4]+'.rollback.sql' if a.endswith('.sql') else a+'.rollback.sql'
    if b!=expected:
        print(f'FAIL SQL mapping index {i}: {a} -> {b}, expected {expected}'); raise SystemExit(1)
print(f'PASS exact SQL forward/rollback mapping count = {len(fwd)}')
PY

if [ "$fail" -ne 0 ]; then
  echo "TASK 7.3 ATOMIC ROLLBACK SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 7.3 ATOMIC ROLLBACK SOURCE STATUS: PASS"
