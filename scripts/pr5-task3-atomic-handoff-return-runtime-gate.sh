#!/bin/bash
set -Eeuo pipefail

DB="${SUPABASE_DB_URL:-}"
stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
pass(){ echo "PASS $1"; }

[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

# Runtime gate is read-only. It does not mutate fixture or production rows.
psql "$DB" -v ON_ERROR_STOP=1 -At <<'SQL' >/tmp/pr5_task3_runtime.txt
WITH f AS (
  SELECT
    p.proname,
    pg_get_functiondef(p.oid) AS def,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN (
      'assign_conversation_tx',
      'takeover_conversation_tx',
      'transfer_conversation_tx',
      'return_to_ai_tx'
    )
)
SELECT proname || '|' ||
       CASE WHEN service_exec THEN 'service_pass' ELSE 'service_fail' END || '|' ||
       CASE WHEN NOT auth_exec THEN 'auth_pass' ELSE 'auth_fail' END || '|' ||
       CASE WHEN def LIKE '%company_membership%' THEN 'tenant_pass' ELSE 'tenant_fail' END || '|' ||
       CASE WHEN def LIKE '%FOR UPDATE%' THEN 'lock_pass' ELSE 'lock_fail' END
FROM f
ORDER BY proname;

SELECT 'active_assignment_unique|' ||
  CASE WHEN EXISTS(
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND tablename='conversation_assignment'
      AND indexname='conversation_assignment_one_active'
      AND indexdef LIKE '%WHERE (is_active = true)%'
  ) THEN 'pass' ELSE 'fail' END;

SELECT 'assignment_invariant_triggers|' ||
  CASE WHEN (
    SELECT count(*) FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT t.tgisinternal
      AND n.nspname='public'
      AND t.tgname IN ('enforce_assignment_invariant_a','enforce_assignment_invariant_c')
  ) = 2 THEN 'pass' ELSE 'fail' END;
SQL

cat /tmp/pr5_task3_runtime.txt

grep -q 'assign_conversation_tx|service_pass|auth_pass|tenant_pass|lock_pass' /tmp/pr5_task3_runtime.txt || fail "assign runtime contract"
grep -q 'takeover_conversation_tx|service_pass|auth_pass|tenant_pass|lock_pass' /tmp/pr5_task3_runtime.txt || fail "takeover runtime contract"
grep -q 'transfer_conversation_tx|service_pass|auth_pass|tenant_pass|lock_pass' /tmp/pr5_task3_runtime.txt || fail "transfer runtime contract"
grep -q 'return_to_ai_tx|service_pass|auth_pass|tenant_pass|lock_pass' /tmp/pr5_task3_runtime.txt || fail "return-to-AI runtime contract"
grep -q 'active_assignment_unique|pass' /tmp/pr5_task3_runtime.txt || fail "one-active-assignment invariant"
grep -q 'assignment_invariant_triggers|pass' /tmp/pr5_task3_runtime.txt || fail "assignment invariant triggers"

pass "runtime function ACL / tenant / lock contract"
pass "one-active assignment invariant"
echo "PR5 TASK3 RUNTIME STATUS: PASS"
