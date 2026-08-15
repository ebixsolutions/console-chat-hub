#!/bin/bash
set -Eeuo pipefail

DB="${SUPABASE_DB_URL:-}"
CID="${PR7_CANONICAL_COMPANY_UUID:-}"
ACTOR="${PR11_PRIMARY_ACCEPTANCE_USER_UUID:-}"
RUN="${PR7_CONVERSATION_LINEAGE_RUN_ID:-}"
A_COMPANY="${PR10_TENANT_A_COMPANY_UUID:-}"
B_COMPANY="${PR10_TENANT_B_COMPANY_UUID:-}"
A_USER="${PR10_TENANT_A_USER_UUID:-}"
B_USER="${PR10_TENANT_B_USER_UUID:-}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }
pass(){ echo "PASS $1"; }

[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
for pair in \
  "PR7_CANONICAL_COMPANY_UUID:$CID" \
  "PR11_PRIMARY_ACCEPTANCE_USER_UUID:$ACTOR" \
  "PR7_CONVERSATION_LINEAGE_RUN_ID:$RUN"
do
  name="${pair%%:*}"; value="${pair#*:}"
  [[ "$value" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "$name missing/invalid"
done
command -v psql >/dev/null 2>&1 || stop "psql missing"

FOREIGN_USER=""
FOREIGN_COMPANY=""
if [ -n "$A_COMPANY" ] && [ "$A_COMPANY" != "$CID" ]; then
  FOREIGN_COMPANY="$A_COMPANY"; FOREIGN_USER="$A_USER"
elif [ -n "$B_COMPANY" ] && [ "$B_COMPANY" != "$CID" ]; then
  FOREIGN_COMPANY="$B_COMPANY"; FOREIGN_USER="$B_USER"
fi
[ -n "$FOREIGN_COMPANY" ] || stop "no foreign tenant fixture distinct from canonical company"
[[ "$FOREIGN_USER" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "foreign tenant user fixture invalid"

psql "$DB" -v ON_ERROR_STOP=1 \
  -v cid="$CID" -v actor="$ACTOR" -v run="$RUN" \
  -v foreign_user="$FOREIGN_USER" <<'SQL'
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.company WHERE id=:'cid'::uuid AND is_active
  ) THEN
    RAISE EXCEPTION 'PR20 canonical company inactive/missing';
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.company_membership
    WHERE company_id=:'cid'::uuid
      AND user_id=:'actor'::uuid
      AND is_active
      AND role::text='admin'
  ) THEN
    RAISE EXCEPTION 'PR20 primary acceptance user is not canonical admin';
  END IF;
END $$;

SELECT public.rebind_local_evaluations_v1(
  :'cid'::uuid,
  :'actor'::uuid,
  :'run'::uuid
);

DO $$
DECLARE v_result jsonb;
BEGIN
  SELECT public.finalize_local_evaluation_tenant_scope_v1(
    :'cid'::uuid,
    :'actor'::uuid
  ) INTO v_result;
  IF coalesce(v_result->>'result','') <> 'success' THEN
    RAISE EXCEPTION 'PR20 local tenant-scope finalization failed: %',
      coalesce(v_result->>'result','unknown');
  END IF;
END $$;

-- Fire the canonical outbox constraint triggers now, while the transaction can
-- still be rolled back if any lineage assertion fails.
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  v_local integer;
  v_map integer;
  v_outbox integer;
BEGIN
  SELECT count(*) INTO v_local FROM public.ce_local_evaluation;
  SELECT count(*) INTO v_map FROM public.ce_local_canonical_map;
  IF v_local<>v_map THEN
    RAISE EXCEPTION 'PR20 local/map count mismatch %/%',v_local,v_map;
  END IF;

  IF EXISTS(
    SELECT 1
    FROM public.ce_local_evaluation l
    JOIN public.conversations c ON c.id=l.conversation_id
    WHERE l.company_id IS DISTINCT FROM :'cid'::uuid
       OR l.canonical_evaluation_id IS NULL
       OR c.company_id IS DISTINCT FROM :'cid'::uuid
  ) THEN
    RAISE EXCEPTION 'PR20 local/canonical company binding incomplete';
  END IF;

  IF EXISTS(
    SELECT 1
    FROM public.ce_local_canonical_map m
    JOIN public.conversation_evaluation e ON e.id=m.canonical_evaluation_id
    JOIN public.conversations c ON c.id=e.conversation_id
    WHERE m.company_id IS DISTINCT FROM :'cid'::uuid
       OR e.company_id IS DISTINCT FROM :'cid'::uuid
       OR c.company_id IS DISTINCT FROM :'cid'::uuid
       OR e.conversation_id<>c.id
  ) THEN
    RAISE EXCEPTION 'PR20 canonical lineage mismatch';
  END IF;

  SELECT count(*) INTO v_outbox
  FROM public.evaluation_training_outbox o
  JOIN public.ce_local_canonical_map m ON m.canonical_evaluation_id=o.evaluation_id;

  IF v_outbox<>v_map THEN
    RAISE EXCEPTION 'PR20 canonical training outbox count mismatch %/%',v_outbox,v_map;
  END IF;

  IF EXISTS(
    SELECT 1
    FROM public.evaluation_training_outbox o
    JOIN public.ce_local_canonical_map m ON m.canonical_evaluation_id=o.evaluation_id
    WHERE o.company_id IS DISTINCT FROM :'cid'::uuid
       OR o.delivery_idempotency_key IS DISTINCT FROM o.evaluation_id::text
  ) THEN
    RAISE EXCEPTION 'PR20 training outbox lineage/idempotency mismatch';
  END IF;

  IF EXISTS(
    SELECT 1 FROM public.ce_local_qa_case q
    JOIN public.ce_local_evaluation l ON l.id=q.evaluation_id
    WHERE l.canonical_evaluation_id IS NOT NULL
      AND q.remote_sync_state<>'canonical_mapped'
  ) OR EXISTS(
    SELECT 1 FROM public.ce_local_root_cause r
    JOIN public.ce_local_evaluation l ON l.id=r.evaluation_id
    WHERE l.canonical_evaluation_id IS NOT NULL
      AND r.remote_sync_state<>'canonical_mapped'
  ) THEN
    RAISE EXCEPTION 'PR20 local detail mapping state incomplete';
  END IF;
END $$;

-- Authenticated RLS: canonical member sees all rebound local provenance.
SELECT set_config('request.jwt.claims',
  json_build_object('sub',:'actor','role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE total_count integer; visible_count integer;
BEGIN
  RESET ROLE;
  SELECT count(*) INTO total_count FROM public.ce_local_evaluation;
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO visible_count FROM public.ce_local_evaluation;
  IF visible_count<>total_count THEN
    RAISE EXCEPTION 'PR20 canonical member RLS visibility mismatch %/%',visible_count,total_count;
  END IF;
END $$;
RESET ROLE;

-- Foreign tenant user must see zero rebound local CE records.
SELECT set_config('request.jwt.claims',
  json_build_object('sub',:'foreign_user','role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.ce_local_evaluation;
  IF n<>0 THEN RAISE EXCEPTION 'PR20 cross-tenant local CE leak: %',n; END IF;
END $$;
RESET ROLE;

COMMIT;
SQL

pass "stored local evaluations rebound into canonical CE without LLM recomputation"
pass "canonical outbox created exactly once with company lineage"
pass "local QA/Root Cause provenance mapped"
pass "company-member and cross-tenant RLS assertions"
echo "PR20 TASK3 CANONICAL REBINDING RUNTIME STATUS: PASS"
