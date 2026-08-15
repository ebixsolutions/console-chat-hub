#!/bin/bash
set -u
set -o pipefail

REPO="${PR11_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
SOURCE_LOG="${TMPDIR:-/tmp}/pr11-source-final-gate.$$.log"
PROD_LOG="${TMPDIR:-/tmp}/pr11-production-final-gate.$$.log"
trap 'rm -f "$SOURCE_LOG" "$PROD_LOG"' EXIT

fail(){
  echo "WHOLE-PRODUCT FINAL STATUS: FAIL"
  echo "Reason: $1"
  exit 1
}
stop(){
  echo "WHOLE-PRODUCT FINAL STATUS: STOP"
  echo "Reason: $1"
  exit 2
}

[ -d "$REPO/.git" ] || stop "authoritative repo unavailable"
cd "$REPO" || stop "cannot enter authoritative repo"
[ "$(git branch --show-current)" = "main" ] || stop "branch must be main"

echo "== PR11 WHOLE-PRODUCT SOURCE FINAL GATE =="
set +e
bash scripts/pr7-final-gate.sh "$REPO" >"$SOURCE_LOG" 2>&1
SOURCE_RC=$?
set -e
cat "$SOURCE_LOG"

# pr7-final-gate source success is intentionally rc=2 because production has
# not been executed by that source-only gate.
[ "$SOURCE_RC" -eq 2 ] || fail "source final gate failed, rc=$SOURCE_RC"
grep -Fq 'SOURCE STATUS: PASS' "$SOURCE_LOG" || fail "source PASS marker missing"
grep -Fq 'PRODUCTION STATUS: STOP' "$SOURCE_LOG" || fail "source gate production-STOP marker missing"
echo "PASS whole-product source/build closure"

echo "== PR11 WHOLE-PRODUCT PRODUCTION FINAL GATE =="
set +e
bash scripts/pr7-production-final-gate.sh >"$PROD_LOG" 2>&1
PROD_RC=$?
set -e
cat "$PROD_LOG"

if [ "$PROD_RC" -eq 0 ]; then
  grep -Fq 'FINAL STATUS: READY' "$PROD_LOG" || fail "production returned rc=0 without READY marker"
  echo "WHOLE-PRODUCT FINAL STATUS: READY"
  exit 0
fi

if [ "$PROD_RC" -eq 2 ]; then
  # External/final-integration prerequisites such as canonical company identity,
  # secrets, approved real fixtures or not-yet-deployed runtime are legitimate STOP.
  # Never reinterpret them as PASS.
  stop "production final gate stopped on unresolved deployment/runtime prerequisite"
fi

fail "production final gate failed, rc=$PROD_RC"
