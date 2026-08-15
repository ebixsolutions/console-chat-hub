#!/bin/bash
set -Eeuo pipefail
B="scripts/pr12-production-runtime-identity-binding.sh"
P="scripts/pr7-production-final-gate.sh"
L="scripts/pr12-product-ready-activation-loader.py"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

for f in "$B" "$P" "$L"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done

has "$B" 'Tenant A bearer subject != declared Tenant A user' "Tenant A bearer subject binding enforced"
has "$B" 'Tenant B bearer subject != declared Tenant B user' "Tenant B bearer subject binding enforced"
has "$B" 'CE smoke bearer subject is not an active member of CE conversation company' "CE smoke token/company binding enforced"
has "$B" 'CE handoff bearer subject/evaluation/conversation/company binding invalid' "CE handoff full lineage binding enforced"
has "$B" 'primary acceptance user must have exactly one canonical membership' "primary acceptance exactly-one membership enforced"
has "$B" 'primary acceptance user must be canonical admin' "primary acceptance canonical admin enforced"

has "$B" 'PR7_TEST_USER_A' "legacy PR7 Tenant A fixture consistency checked"
has "$B" 'PR7_TEST_USER_B' "legacy PR7 Tenant B fixture consistency checked"

not_has "$B" 'print(t' "binding gate never prints bearer token"
not_has "$B" 'print(d' "binding gate never prints decoded JWT payload"

python3 - "$P" <<'PY' || { bad "production final ordering for identity binding"; }
import sys
t=open(sys.argv[1],encoding="utf-8").read()
binding=t.find("pr12-production-runtime-identity-binding.sh")
ce=t.find("pr8-ce-production-activation-gate.sh")
ready=t.rfind('FINAL STATUS: READY')
if min(binding,ce,ready)<0 or not (binding < ce < ready):
    raise SystemExit(1)
print("PASS identity binding executes before CE/KB runtime chain and READY")
PY

# Loader must contain every identity/token used by binding gate.
for name in \
  PR10_TENANT_A_BEARER_TOKEN PR10_TENANT_B_BEARER_TOKEN \
  PR8_CE_SMOKE_BEARER_TOKEN PR8_CE_HANDOFF_BEARER_TOKEN \
  PR11_PRIMARY_ACCEPTANCE_USER_UUID PR7_TEST_USER_A PR7_TEST_USER_B
do
  has "$L" "$name" "activation contract supplies $name"
done

if [ "$fail" -ne 0 ]; then
  echo "TASK 12.3 PRODUCTION RUNTIME IDENTITY BINDING SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 12.3 PRODUCTION RUNTIME IDENTITY BINDING SOURCE STATUS: PASS"
