#!/bin/bash
set -u
set -o pipefail

REPO="${PR7_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
PROJECT_REF="${PR7_PROJECT_REF:-}"
DB_URL="${SUPABASE_DB_URL:-}"
CANONICAL_COMPANY="${PR7_CANONICAL_COMPANY_ID:-}"
TEST_USER_A="${PR7_TEST_USER_A:-}"
TEST_COMPANY_A="${PR7_TEST_COMPANY_A:-}"
TEST_USER_B="${PR7_TEST_USER_B:-}"
TEST_COMPANY_B="${PR7_TEST_COMPANY_B:-}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }

[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$CANONICAL_COMPANY" ] || stop "canonical company id missing"
[ -d "$REPO/.git" ] || stop "repo not found"
cd "$REPO" || stop "cannot enter repo"
command -v psql >/dev/null 2>&1 || stop "psql missing"

set +e
bash scripts/pr7-final-gate.sh >/tmp/pr7-source-gate.log 2>&1
SOURCE_RC=$?
set -e
cat /tmp/pr7-source-gate.log
[ "$SOURCE_RC" -eq 2 ] || fail "source gate failed, rc=$SOURCE_RC"

echo "== CANONICAL OWNERSHIP ASSERTIONS =="
psql "$DB_URL" -v ON_ERROR_STOP=1 -v company_id="$CANONICAL_COMPANY" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company
    WHERE id=:'company_id'::uuid AND is_active=true
  ) THEN RAISE EXCEPTION 'canonical company missing/inactive'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership
    WHERE company_id=:'company_id'::uuid AND is_active=true
  ) THEN RAISE EXCEPTION 'canonical company has no active membership'; END IF;

  IF EXISTS (SELECT 1 FROM public.channel_config WHERE company_id IS NULL) THEN
    RAISE EXCEPTION 'unbound channel_config rows remain';
  END IF;
  IF EXISTS (SELECT 1 FROM public.conversations WHERE company_id IS NULL) THEN
    RAISE EXCEPTION 'unbound conversations remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.upstream_call_log
    WHERE conversation_id IS NOT NULL AND company_id IS NULL
  ) THEN RAISE EXCEPTION 'unbound upstream logs remain'; END IF;
  IF EXISTS (SELECT 1 FROM public.feedback_automation_config WHERE company_id IS NULL) THEN
    RAISE EXCEPTION 'unbound feedback config remains'; END IF;

  IF to_regprocedure('public.tenant_safe_add_agent(uuid,uuid,uuid,public.app_role,text)') IS NULL THEN
    RAISE EXCEPTION 'missing tenant_safe_add_agent';
  END IF;
  IF to_regprocedure('public.commit_ai_reply_tx(uuid,uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'missing commit_ai_reply_tx';
  END IF;
  IF to_regprocedure('public.recall_message_tx(uuid,uuid,uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'missing recall_message_tx';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND policyname='conversations_company_select'
  ) THEN RAISE EXCEPTION 'core conversation RLS missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND policyname='visitor_session_company_select'
  ) THEN RAISE EXCEPTION 'secondary visitor RLS missing'; END IF;
  IF has_function_privilege('authenticated','public.ce_purge_expired_snapshots()','EXECUTE') THEN
    RAISE EXCEPTION 'authenticated can still purge CE snapshots';
  END IF;
END $$;
SQL

echo "PASS canonical ownership / objects / ACL"

# Two-tenant runtime isolation is a P0 gate. If the production owner has not
# provided two real active tenant fixtures, deployment may be source-correct but
# cannot be declared READY.
[ -n "$TEST_USER_A" ] || stop "two-tenant fixture A user missing"
[ -n "$TEST_COMPANY_A" ] || stop "two-tenant fixture A company missing"
[ -n "$TEST_USER_B" ] || stop "two-tenant fixture B user missing"
[ -n "$TEST_COMPANY_B" ] || stop "two-tenant fixture B company missing"
[ "$TEST_COMPANY_A" != "$TEST_COMPANY_B" ] || stop "two distinct company fixtures required"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v user_a="$TEST_USER_A" -v company_a="$TEST_COMPANY_A" \
  -v user_b="$TEST_USER_B" -v company_b="$TEST_COMPANY_B" <<'SQL'
DO $$
DECLARE ua uuid:=:'user_a'::uuid; ca uuid:=:'company_a'::uuid;
        ub uuid:=:'user_b'::uuid; cb uuid:=:'company_b'::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership cm
    JOIN public.company c ON c.id=cm.company_id AND c.is_active=true
    WHERE cm.user_id=ua AND cm.company_id=ca AND cm.is_active=true
  ) THEN RAISE EXCEPTION 'fixture A invalid'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership cm
    JOIN public.company c ON c.id=cm.company_id AND c.is_active=true
    WHERE cm.user_id=ub AND cm.company_id=cb AND cm.is_active=true
  ) THEN RAISE EXCEPTION 'fixture B invalid'; END IF;
END $$;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'user_a', true);
SELECT set_config('request.jwt.claims', json_build_object('sub',:'user_a','role','authenticated')::text,true);
DO $$
DECLARE cb uuid:=:'company_b'::uuid; n int;
BEGIN
  SELECT count(*) INTO n FROM public.conversations WHERE company_id=cb;
  IF n<>0 THEN RAISE EXCEPTION 'RLS FAIL A->B conversations: %',n; END IF;
  SELECT count(*) INTO n FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id WHERE c.company_id=cb;
  IF n<>0 THEN RAISE EXCEPTION 'RLS FAIL A->B messages: %',n; END IF;
END $$;
ROLLBACK;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'user_b', true);
SELECT set_config('request.jwt.claims', json_build_object('sub',:'user_b','role','authenticated')::text,true);
DO $$
DECLARE ca uuid:=:'company_a'::uuid; n int;
BEGIN
  SELECT count(*) INTO n FROM public.conversations WHERE company_id=ca;
  IF n<>0 THEN RAISE EXCEPTION 'RLS FAIL B->A conversations: %',n; END IF;
END $$;
ROLLBACK;
SQL

echo "PASS two-tenant RLS runtime smoke"
echo "FINAL STATUS: READY"
