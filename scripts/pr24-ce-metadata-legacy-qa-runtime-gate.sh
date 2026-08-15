#!/bin/bash
set -Eeuo pipefail
DB="${SUPABASE_DB_URL:-}"
stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

psql "$DB" -v ON_ERROR_STOP=1 -At <<'SQL' >/tmp/pr24_runtime.txt
SELECT
CASE WHEN EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='conversations' AND column_name='customer_tier'
) THEN 'tier_pass' ELSE 'tier_fail' END || '|' ||
CASE WHEN EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='conversations' AND column_name='intent'
) THEN 'intent_pass' ELSE 'intent_fail' END || '|' ||
CASE WHEN EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='conversations' AND column_name='language'
) THEN 'language_pass' ELSE 'language_fail' END || '|' ||
CASE WHEN to_regclass('public.ce_legacy_qa_metric') IS NOT NULL
  THEN 'legacy_table_pass' ELSE 'legacy_table_fail' END;

SELECT CASE WHEN NOT EXISTS(
  SELECT 1
  FROM public.ce_legacy_qa_metric
  WHERE quality_score IS DISTINCT FROM round(
    empathy_score*0.20 + policy_accuracy_score*0.25 +
    vip_awareness_score*0.25 + resolution_speed_score*0.15 +
    context_score*0.15, 2
  )
) THEN 'legacy_formula_pass' ELSE 'legacy_formula_fail' END;
SQL

cat /tmp/pr24_runtime.txt
grep -q 'tier_pass|intent_pass|language_pass|legacy_table_pass' /tmp/pr24_runtime.txt || fail "metadata schema"
grep -q 'legacy_formula_pass' /tmp/pr24_runtime.txt || fail "legacy QA generated formula"
echo "PR24 TASK3 RUNTIME STATUS: PASS"
