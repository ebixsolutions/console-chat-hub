#!/bin/bash
set -u
set -o pipefail
stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }

REPO="${PR11_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
[ -d "$REPO/.git" ] || stop "authoritative repo unavailable"
cd "$REPO" || stop "cannot enter authoritative repo"
[ "$(git branch --show-current)" = "main" ] || stop "branch must be main"
git diff --quiet || stop "working tree has unstaged changes"
git diff --cached --quiet || stop "working tree has staged changes"

echo "== PR11 AUTHORIZED SOURCE / COMMIT LOCK =="
set +e
bash scripts/pr11-final-integration-source-lock.sh
LOCK_RC=$?
set -e
[ "$LOCK_RC" -eq 0 ] || {
  [ "$LOCK_RC" -eq 2 ] && stop "authorized source/commit lock unresolved"
  fail "authorized source/commit lock failed"
}

echo "== PR11 FINAL PRODUCT-READY INTEGRATION PREFLIGHT =="
set +e
bash scripts/pr11-final-product-ready-integration-preflight.sh
PREFLIGHT_RC=$?
set -e
[ "$PREFLIGHT_RC" -eq 0 ] || {
  [ "$PREFLIGHT_RC" -eq 2 ] && stop "final integration prerequisites incomplete"
  fail "final integration preflight failed"
}

# All writes are delegated to the frozen atomic deployment runner.
echo "== PR11 ATOMIC PRODUCT-READY DEPLOY =="
set +e
bash scripts/pr7-production-deploy.sh
DEPLOY_RC=$?
set -e
[ "$DEPLOY_RC" -eq 0 ] || {
  [ "$DEPLOY_RC" -eq 2 ] && stop "atomic production deploy stopped"
  fail "atomic production deploy failed, rc=$DEPLOY_RC"
}

echo "== PR11 WHOLE-PRODUCT FINAL ACCEPTANCE =="
set +e
bash scripts/pr11-whole-product-final-gate.sh
FINAL_RC=$?
set -e
[ "$FINAL_RC" -eq 0 ] || {
  [ "$FINAL_RC" -eq 2 ] && stop "whole-product final gate stopped"
  fail "whole-product final gate failed, rc=$FINAL_RC"
}

echo "FINAL PRODUCT-READY INTEGRATION STATUS: READY"
