#!/bin/bash
set -Eeuo pipefail
L="scripts/pr11-final-integration-source-lock.sh"
R="scripts/pr11-final-product-ready-integration-runner.sh"
I="scripts/pr11-final-product-ready-integration-source-gate.sh"
D="scripts/pr7-production-deploy.sh"
P="scripts/pr7-production-final-gate.sh"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }
for f in "$L" "$R" "$I" "$D" "$P"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done

has "$L" 'PR11_AUTHORIZED_SOURCE_COMMIT' "explicit authorized commit required"
has "$L" 'git rev-parse HEAD' "exact local HEAD verified"
has "$L" 'git status --porcelain=v1 --untracked-files=all' "tracked/staged/untracked drift rejected"
has "$L" 'git ls-remote --exit-code origin refs/heads/main' "remote main verified read-only"
has "$L" 'git merge-base --is-ancestor' "rollback ancestry verified"
has "$L" '[ "$ROLLBACK" != "$AUTHORIZED" ]' "rollback must precede authorized commit"
has "$L" 'git cat-file -e "${AUTHORIZED}:${path}"' "critical paths verified in authorized tree"
has "$L" 'shasum -a 256' "critical Git-tree fingerprint produced"
not_has "$L" 'git fetch' "source lock does not update refs"
not_has "$L" 'git pull' "source lock does not change working tree"
not_has "$L" 'git checkout' "source lock does not checkout revisions"
not_has "$L" 'git reset' "source lock does not rewrite source"

python3 - "$R" <<'PY' || { bad "integration runner source-lock ordering"; }
import sys
t=open(sys.argv[1],encoding="utf-8").read()
a=t.find("pr11-final-integration-source-lock.sh")
b=t.find("pr11-final-product-ready-integration-preflight.sh")
c=t.find("pr7-production-deploy.sh")
d=t.find("pr11-whole-product-final-gate.sh")
if min(a,b,c,d)<0 or not (a<b<c<d): raise SystemExit(1)
print("PASS source lock executes before preflight/deploy/final gate")
PY

has "$D" 'pr11-final-integration-source-lock.sh' "atomic deploy rechecks source lock before writes"
has "$P" 'pr11-final-integration-source-lock.sh' "production final gate rechecks source lock before READY"
has "$I" 'PR7_CANONICAL_COMPANY_UUID' "Task 11.2 canonical identity contract retained"

if [ "$fail" -ne 0 ]; then
  echo "TASK 11.3 FINAL INTEGRATION SOURCE DRIFT LOCK STATUS: FAIL"
  exit 1
fi
echo "TASK 11.3 FINAL INTEGRATION SOURCE DRIFT LOCK STATUS: PASS"
