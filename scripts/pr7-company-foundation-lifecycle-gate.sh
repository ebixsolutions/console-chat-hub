#!/bin/bash
set -Eeuo pipefail

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ ! grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

must_have scripts/pr7-canonical-company-bootstrap.sh "idempotent no-op" "company bootstrap same-run no-op"
must_have scripts/pr7-company-membership-bootstrap.sh "idempotent no-op" "membership bootstrap same-run no-op"
must_have scripts/pr7-canonical-company-bootstrap-rollback.sh "already rolled back (idempotent no-op)" "company rollback repeat no-op"
must_have scripts/pr7-company-membership-bootstrap-rollback.sh "already rolled back (idempotent no-op)" "membership rollback repeat no-op"
must_have scripts/pr7-canonical-company-bootstrap-rollback.sh "SET rolled_back_at=now()" "company rollback preserves provenance"
must_have scripts/pr7-company-membership-bootstrap-rollback.sh "SET rolled_back_at=now()" "membership rollback preserves provenance"
must_have sql/pr7/pr7_company_dual_identity.rollback.sql "WHERE rolled_back_at IS NULL" "company schema rollback blocks only active runs"
must_have sql/pr7/pr7_company_membership_foundation.rollback.sql "WHERE rolled_back_at IS NULL" "membership schema rollback blocks only active runs"
must_have scripts/pr7-company-membership-bootstrap-rollback.sh "membership state changed after bootstrap" "membership drift blocks rollback"
must_have scripts/pr7-canonical-company-bootstrap-rollback.sh "Any Task 2.2/Workflow 3 or unrelated reference causes" "company rollback fails closed on downstream references"

if [ "$fail" -ne 0 ]; then
  echo "TASK 2.3 SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 2.3 SOURCE STATUS: PASS"
