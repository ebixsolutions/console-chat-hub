#!/bin/bash
set -Eeuo pipefail
DB="${SUPABASE_DB_URL:-}"
CID="${W2_T2_2_CANONICAL_COMPANY_UUID:-}"
PID="${W2_T2_2_CANONICAL_PLATFORM_COMPANY_ID:-}"
ADMIN="${W2_T2_2_PRIMARY_ADMIN_USER_UUID:-}"
stop(){ echo "STOP: $1" >&2; exit 2; }
fail(){ echo "FAIL: $1" >&2; exit 1; }
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[[ "$CID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "company UUID invalid"
[[ "$PID" =~ ^[1-9][0-9]*$ ]] || stop "platform company id invalid"
[[ "$ADMIN" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "admin UUID invalid"
command -v psql >/dev/null 2>&1 || stop "psql missing"

OUT="$(psql "$DB" -v ON_ERROR_STOP=1 -Atq -v cid="$CID" -v pid="$PID" -v admin="$ADMIN" <<'SQL'
SELECT 'identity|'||CASE WHEN EXISTS(
 SELECT 1 FROM public.company WHERE id=:'cid'::uuid AND platform_company_id=:'pid'::bigint AND is_active)
 THEN 'pass' ELSE 'fail' END;
SELECT 'admin_membership|'||CASE WHEN EXISTS(
 SELECT 1 FROM public.company_membership WHERE company_id=:'cid'::uuid
   AND user_id=:'admin'::uuid AND is_active AND role::text='admin')
 THEN 'pass' ELSE 'fail' END;
SELECT 'channels|'||CASE WHEN NOT EXISTS(
 SELECT 1 FROM public.channel_config WHERE company_id IS DISTINCT FROM :'cid'::uuid)
 THEN 'pass' ELSE 'fail' END;
SELECT 'conversations|'||CASE WHEN NOT EXISTS(
 SELECT 1 FROM public.conversations WHERE company_id IS DISTINCT FROM :'cid'::uuid)
 THEN 'pass' ELSE 'fail' END;
SELECT 'local_mapped|'||CASE WHEN NOT EXISTS(
 SELECT 1 FROM public.ce_local_evaluation
 WHERE company_id IS DISTINCT FROM :'cid'::uuid OR canonical_evaluation_id IS NULL)
 THEN 'pass' ELSE 'fail' END;
SELECT 'map_count|'||CASE WHEN
 (SELECT count(*) FROM public.ce_local_evaluation)=(SELECT count(*) FROM public.ce_local_canonical_map)
 THEN 'pass' ELSE 'fail' END;
SELECT 'canonical_lineage|'||CASE WHEN NOT EXISTS(
 SELECT 1 FROM public.ce_local_canonical_map m
 JOIN public.conversation_evaluation e ON e.id=m.canonical_evaluation_id
 JOIN public.conversations c ON c.id=e.conversation_id
 WHERE m.company_id IS DISTINCT FROM :'cid'::uuid
    OR e.company_id IS DISTINCT FROM :'cid'::uuid
    OR c.company_id IS DISTINCT FROM :'cid'::uuid)
 THEN 'pass' ELSE 'fail' END;
SELECT 'outbox|'||CASE WHEN
 (SELECT count(*) FROM public.evaluation_training_outbox o
  JOIN public.ce_local_canonical_map m ON m.canonical_evaluation_id=o.evaluation_id)
 = (SELECT count(*) FROM public.ce_local_canonical_map)
 AND NOT EXISTS(
  SELECT 1 FROM public.evaluation_training_outbox o
  JOIN public.ce_local_canonical_map m ON m.canonical_evaluation_id=o.evaluation_id
  WHERE o.company_id IS DISTINCT FROM :'cid'::uuid
     OR o.delivery_idempotency_key IS DISTINCT FROM o.evaluation_id::text)
 THEN 'pass' ELSE 'fail' END;
SELECT 'ce_functions|'||CASE WHEN
 to_regprocedure('public.rebind_local_evaluations_v1(uuid,uuid,uuid)') IS NOT NULL
 AND to_regprocedure('public.finalize_local_evaluation_tenant_scope_v1(uuid,uuid)') IS NOT NULL
 THEN 'pass' ELSE 'fail' END;
SQL
)"
printf '%s\n' "$OUT"
for k in identity admin_membership channels conversations local_mapped map_count canonical_lineage outbox ce_functions; do
 grep -q "^${k}|pass$" <<<"$OUT" || fail "$k"
done

# RLS: canonical member sees all local provenance; a nonmember sees zero.
NONMEMBER="00000000-0000-4000-8000-000000000001"
psql "$DB" -v ON_ERROR_STOP=1 -v admin="$ADMIN" -v nonmember="$NONMEMBER" <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims',json_build_object('sub',:'admin','role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE n int; t int; BEGIN
 RESET ROLE; SELECT count(*) INTO t FROM public.ce_local_evaluation;
 SET LOCAL ROLE authenticated; SELECT count(*) INTO n FROM public.ce_local_evaluation;
 IF n<>t THEN RAISE EXCEPTION 'canonical member RLS visibility mismatch %/%',n,t; END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims',json_build_object('sub',:'nonmember','role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$ DECLARE n int; BEGIN
 SELECT count(*) INTO n FROM public.ce_local_evaluation;
 IF n<>0 THEN RAISE EXCEPTION 'nonmember CE visibility leak: %',n; END IF;
END $$;
RESET ROLE;
ROLLBACK;
SQL

echo "PASS canonical CE RLS member/nonmember isolation"
echo "W2 TASK 2.2 RUNTIME STATUS: PASS"
