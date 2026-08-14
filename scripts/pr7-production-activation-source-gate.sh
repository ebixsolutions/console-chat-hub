#!/bin/bash
set -Eeuo pipefail

DEP="scripts/pr7-production-deploy.sh"
FINAL="scripts/pr7-production-final-gate.sh"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

for f in "$DEP" "$FINAL"; do [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }; done

for fn in customer360-adapter customer360-coach-sync; do
  must_have "$DEP" "\"$fn\"" "production deploy inventory includes $fn"
  must_have "$FINAL" "$fn" "production final inventory requires $fn"
done

# Both internal functions must bypass Supabase JWT gateway and enforce their own
# server-side internal token contracts.
VERIFY_BLOCK="$(sed -n '/^VERIFY_JWT_FALSE=(/,/^)/p' "$DEP")"
printf '%s\n' "$VERIFY_BLOCK" | grep -Fq '"customer360-adapter"' \
  && pass "customer360-adapter verify_jwt=false" \
  || bad "customer360-adapter verify_jwt=false"
printf '%s\n' "$VERIFY_BLOCK" | grep -Fq '"customer360-coach-sync"' \
  && pass "customer360-coach-sync verify_jwt=false" \
  || bad "customer360-coach-sync verify_jwt=false"

COUNT="$(sed -n '/^FUNCTIONS=(/,/^)/p' "$DEP" | grep -c '^  "')" || true
[ "$COUNT" -eq 28 ] && pass "production Edge inventory count = 28" \
  || bad "production Edge inventory count expected 28 got $COUNT"

if [ "$fail" -ne 0 ]; then
  echo "TASK 7.1 PRODUCTION ACTIVATION SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 7.1 PRODUCTION ACTIVATION SOURCE STATUS: PASS"
