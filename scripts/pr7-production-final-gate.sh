#!/bin/bash
set -u
set -o pipefail

REPO="${PR7_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
PROJECT_REF="${PR7_PROJECT_REF:-}"
DB_URL="${SUPABASE_DB_URL:-}"
TEST_USER_A="${PR7_TEST_USER_A:-}"
TEST_COMPANY_A="${PR7_TEST_COMPANY_A:-}"
TEST_USER_B="${PR7_TEST_USER_B:-}"
TEST_COMPANY_B="${PR7_TEST_COMPANY_B:-}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }

[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$TEST_USER_A" ] || stop "PR7_TEST_USER_A missing"
[ -n "$TEST_COMPANY_A" ] || stop "PR7_TEST_COMPANY_A missing"
[ -n "$TEST_USER_B" ] || stop "PR7_TEST_USER_B missing"
[ -n "$TEST_COMPANY_B" ] || stop "PR7_TEST_COMPANY_B missing"
[ "$TEST_COMPANY_A" != "$TEST_COMPANY_B" ] || stop "two distinct company fixtures required"

[ -d "$REPO/.git" ] || stop "repo not found"
cd "$REPO" || stop "cannot enter repo"
command -v psql >/dev/null 2>&1 || stop "psql missing"

echo "== SOURCE + BUILD =="
set +e
bash scripts/pr7-final-gate.sh >/tmp/pr7-source-gate.log 2>&1
SOURCE_RC=$?
set -e
cat /tmp/pr7-source-gate.log
# Source gate intentionally exits 2 before production checks.
[ "$SOURCE_RC" -eq 2 ] || fail "source gate failed, rc=$SOURCE_RC"

echo "== DB OBJECT ASSERTIONS =="
psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v user_a="$TEST_USER_A" \
  -v company_a="$TEST_COMPANY_A" \
  -v user_b="$TEST_USER_B" \
  -v company_b="$TEST_COMPANY_B" <<'SQL'
\set QUIET 1

DO $$
BEGIN
  IF to_regprocedure('public.tenant_safe_add_agent(uuid,uuid,uuid,public.app_role,text)') IS NULL THEN
    RAISE EXCEPTION 'missing tenant_safe_add_agent';
  END IF;
  IF to_regprocedure('public.tenant_safe_change_role(uuid,uuid,uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'missing tenant_safe_change_role';
  END IF;
  IF to_regprocedure('public.commit_ai_reply_tx(uuid,uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'missing commit_ai_reply_tx';
  END IF;
  IF to_regprocedure('public.recall_message_tx(uuid,uuid,uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'missing recall_message_tx';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='feedback_automation_config'
      AND column_name='company_id'
  ) THEN
    RAISE EXCEPTION 'feedback_automation_config.company_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND policyname='conversations_company_select'
  ) THEN
    RAISE EXCEPTION 'core conversation RLS missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND policyname='visitor_session_company_select'
  ) THEN
    RAISE EXCEPTION 'secondary visitor RLS missing';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.ce_purge_expired_snapshots()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated can still purge CE snapshots';
  END IF;
END $$;

-- Verify supplied fixtures are real active memberships in distinct active companies.
DO $$
DECLARE
  ua uuid := :'user_a'::uuid;
  ca uuid := :'company_a'::uuid;
  ub uuid := :'user_b'::uuid;
  cb uuid := :'company_b'::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.company_membership cm
    JOIN public.company c ON c.id=cm.company_id AND c.is_active=true
    WHERE cm.user_id=ua AND cm.company_id=ca AND cm.is_active=true
  ) THEN
    RAISE EXCEPTION 'fixture A membership invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.company_membership cm
    JOIN public.company c ON c.id=cm.company_id AND c.is_active=true
    WHERE cm.user_id=ub AND cm.company_id=cb AND cm.is_active=true
  ) THEN
    RAISE EXCEPTION 'fixture B membership invalid';
  END IF;
END $$;

-- RLS tenant isolation smoke: authenticated A must not see B's conversations/messages.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'user_a', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'user_a', 'role', 'authenticated')::text,
  true
);

DO $$
DECLARE
  ca uuid := :'company_a'::uuid;
  cb uuid := :'company_b'::uuid;
  cross_conv int;
  cross_msg int;
  own_conv int;
BEGIN
  SELECT count(*) INTO cross_conv
  FROM public.conversations
  WHERE company_id=cb;
  IF cross_conv <> 0 THEN
    RAISE EXCEPTION 'RLS FAIL: user A can see company B conversations: %', cross_conv;
  END IF;

  SELECT count(*) INTO cross_msg
  FROM public.messages m
  JOIN public.conversations c ON c.id=m.conversation_id
  WHERE c.company_id=cb;
  IF cross_msg <> 0 THEN
    RAISE EXCEPTION 'RLS FAIL: user A can see company B messages: %', cross_msg;
  END IF;

  SELECT count(*) INTO own_conv
  FROM public.conversations
  WHERE company_id=ca;
  -- own_conv may legitimately be zero; query itself must be allowed.
END $$;
ROLLBACK;

-- Symmetric B -> A isolation.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :'user_b', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'user_b', 'role', 'authenticated')::text,
  true
);

DO $$
DECLARE
  ca uuid := :'company_a'::uuid;
  cross_conv int;
BEGIN
  SELECT count(*) INTO cross_conv
  FROM public.conversations
  WHERE company_id=ca;
  IF cross_conv <> 0 THEN
    RAISE EXCEPTION 'RLS FAIL: user B can see company A conversations: %', cross_conv;
  END IF;
END $$;
ROLLBACK;
SQL

echo "PASS DB objects / ACL / tenant RLS smoke"

echo "== AUTH CONFIG SOURCE ASSERTIONS =="
python3 - <<'PY'
from pathlib import Path
t=Path("supabase/config.toml").read_text()
required_true=["generate-reply","deliver-feedback-request","agent-management","agent-assist"]
required_false=["training-outbox-worker","training-result-receiver","training-kb-sync","training-kb-finalize"]
for fn in required_true:
    marker=f"[functions.{fn}]\nverify_jwt = true"
    if marker not in t:
        raise SystemExit(f"FAIL missing JWT=true: {fn}")
for fn in required_false:
    marker=f"[functions.{fn}]\nverify_jwt = false"
    if marker not in t:
        raise SystemExit(f"FAIL missing JWT=false: {fn}")
print("PASS gateway auth source assertions")
PY

echo "FINAL STATUS: READY"
exit 0
