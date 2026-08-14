#!/bin/bash
set -u
set -o pipefail

REPO="${PR7_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
PROJECT_REF="${PR7_PROJECT_REF:-}"
DB_URL="${SUPABASE_DB_URL:-}"
ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
CANONICAL_COMPANY="${PR7_CANONICAL_COMPANY_UUID:-}"
CANONICAL_PLATFORM_COMPANY="${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}"
TEST_USER_A="${PR7_TEST_USER_A:-}"
TEST_COMPANY_A="${PR7_TEST_COMPANY_A:-}"
TEST_USER_B="${PR7_TEST_USER_B:-}"
TEST_COMPANY_B="${PR7_TEST_COMPANY_B:-}"
FUNCTIONS_URL="${PR7_FUNCTIONS_URL:-https://${EXPECTED_PROJECT_REF}.supabase.co/functions/v1}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }

[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$ACCESS_TOKEN" ] || stop "SUPABASE_ACCESS_TOKEN missing"
[ -n "$CANONICAL_COMPANY" ] || stop "canonical company UUID missing"
[ -n "${KB_SINGAPORE_TENANT_MAP_JSON:-}" ] || stop "Singapore KB tenant mapping missing"
[ -n "$CANONICAL_PLATFORM_COMPANY" ] || stop "canonical platform integer company id missing"
[ -d "$REPO/.git" ] || stop "repo not found"
cd "$REPO" || stop "cannot enter repo"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v npx >/dev/null 2>&1 || stop "npx missing"
command -v curl >/dev/null 2>&1 || stop "curl missing"

set +e
bash scripts/pr7-final-gate.sh >/tmp/pr7-source-gate.log 2>&1
SOURCE_RC=$?
set -e
cat /tmp/pr7-source-gate.log
[ "$SOURCE_RC" -eq 2 ] || fail "source gate failed, rc=$SOURCE_RC"

# Verify complete deployed function inventory through Supabase control plane.
REQUIRED_FUNCTIONS=(
  get-public-widget-config create-visitor-session receive-widget-message
  widget-poll-messages generate-reply health-check submit-feedback-response
  deliver-feedback-request agent-send-reply assign-conversation
  take-over-conversation transfer-conversation return-to-ai
  resolve-conversation mark-unresolved recall-message kb-search-proxy
  visitor-analytics agent-assist agent-management conversation-evaluate
  customer360-local training-outbox-worker training-result-receiver
  training-kb-sync training-kb-finalize
)

echo "== EDGE INVENTORY ASSERTION =="
export SUPABASE_ACCESS_TOKEN="$ACCESS_TOKEN"
FN_LIST="$(npx supabase functions list --project-ref "$PROJECT_REF" 2>&1)" || fail "Supabase function inventory query failed"
printf '%s\n' "$FN_LIST"
for fn in "${REQUIRED_FUNCTIONS[@]}"; do
  printf '%s\n' "$FN_LIST" | grep -Fq "$fn" || fail "deployed function missing: $fn"
done
echo "PASS complete Edge inventory present"

# Public runtime smoke proves the deployed gateway actually answers.
echo "== EDGE RUNTIME SMOKE =="
HEALTH_BODY="$(curl --fail --silent --show-error --max-time 15 "$FUNCTIONS_URL/health-check")" || fail "health-check runtime unreachable"
printf '%s' "$HEALTH_BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("ok") is True and d.get("source")=="health-check"' \
  || fail "health-check runtime contract mismatch"
echo "PASS health-check runtime"

# Canonical DB/RLS assertions.
echo "== CANONICAL OWNERSHIP ASSERTIONS =="
echo "== SINGAPORE KB TENANT MAPPING =="
bash scripts/pr7-singapore-kb-mapping-source-gate.sh || stop "Singapore KB mapping source contract failed"
bash scripts/pr7-singapore-kb-tenant-mapping-gate.sh || stop "Singapore KB tenant mapping invalid"

echo "== SINGAPORE KB BACKEND JWT AUTH =="
bash scripts/pr7-singapore-kb-auth-source-gate.sh || stop "Singapore KB auth source contract failed"
bash scripts/pr7-singapore-kb-auth-env-gate.sh || stop "Singapore KB production auth env invalid"
bash scripts/pr7-singapore-kb-jwt-contract-test.sh || stop "Singapore KB JWT contract test failed"

echo "== SINGAPORE KB FULL CALL-CHAIN =="
bash scripts/pr7-singapore-kb-callchain-gate.sh || stop "Singapore KB full call-chain contract failed"

echo "== SINGAPORE KB AUTHENTICATED RUNTIME SMOKE =="
bash scripts/pr7-singapore-kb-runtime-smoke.sh || stop "Singapore KB authenticated runtime smoke failed"

psql "$DB_URL" -v ON_ERROR_STOP=1 -v company_id="$CANONICAL_COMPANY" -v platform_company_id="$CANONICAL_PLATFORM_COMPANY" <<'SQL'
SELECT set_config('pr7.company_id', :'company_id', false);
SELECT set_config('pr7.platform_company_id', :'platform_company_id', false);
DO $$
DECLARE cid uuid:=current_setting('pr7.company_id')::uuid;
        pid bigint:=current_setting('pr7.platform_company_id')::bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.company WHERE id=cid AND is_active=true) THEN RAISE EXCEPTION 'canonical company missing/inactive'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company
    WHERE id=cid AND platform_company_id=pid AND is_active=true
  ) THEN RAISE EXCEPTION 'canonical company UUID/integer identity mismatch'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.pr7_company_identity_bootstrap_run
    WHERE company_uuid=cid
      AND completed_at IS NULL
  ) THEN RAISE EXCEPTION 'canonical company bootstrap has incomplete run'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.pr7_membership_bootstrap_run
    WHERE company_id=cid
      AND completed_at IS NULL
  ) THEN RAISE EXCEPTION 'membership bootstrap has incomplete run'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.company_membership WHERE company_id=cid AND is_active=true) THEN RAISE EXCEPTION 'canonical company has no active membership'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.channel_config
    WHERE company_id IS NULL OR company_id<>cid
  ) THEN RAISE EXCEPTION 'channel ownership is not canonical'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations
    WHERE company_id IS NULL OR company_id<>cid
  ) THEN RAISE EXCEPTION 'conversation ownership is not canonical'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.conversations c
    JOIN public.channel_config ch ON ch.id=c.channel_config_id
    WHERE c.company_id<>ch.company_id
  ) THEN RAISE EXCEPTION 'conversation/channel company lineage mismatch'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.conversations'::regclass
      AND tgname='trg_pr7_conversation_tenant_lineage'
      AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'conversation tenant lineage trigger missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.feedback_request'::regclass
      AND tgname='trg_pr7_feedback_tenant_lineage'
      AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'feedback tenant lineage trigger missing'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.upstream_call_log u
    JOIN public.conversations c ON c.id=u.conversation_id
    WHERE u.company_id IS DISTINCT FROM c.company_id
  ) THEN RAISE EXCEPTION 'upstream-call/conversation company lineage mismatch'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.pr7_channel_ownership_run
    WHERE company_id=cid AND completed_at IS NULL
  ) THEN RAISE EXCEPTION 'channel ownership has incomplete run'; END IF;

  IF EXISTS (
    SELECT company_id,user_id FROM public.company_membership
    GROUP BY company_id,user_id HAVING count(*)>1
  ) THEN RAISE EXCEPTION 'duplicate canonical company/user membership rows'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership
    WHERE company_id=cid AND role='admin'::public.app_role AND is_active=true
  ) THEN RAISE EXCEPTION 'canonical company has no active admin'; END IF;
  IF EXISTS (
    SELECT 1
    FROM public.company_membership cm
    JOIN public.agent_profile ap ON ap.user_id=cm.user_id
    LEFT JOIN public.user_roles ur ON ur.user_id=cm.user_id
    WHERE cm.company_id=cid AND cm.is_active=true
      AND (
        CASE ap.role
          WHEN 'super_admin' THEN 'admin'
          ELSE ap.role
        END IS DISTINCT FROM cm.role::text
        OR ur.role IS DISTINCT FROM cm.role
      )
  ) THEN RAISE EXCEPTION 'canonical membership role mirror mismatch'; END IF;

  IF EXISTS (SELECT 1 FROM public.channel_config WHERE company_id IS NULL OR company_id<>cid) THEN RAISE EXCEPTION 'invalid channel ownership'; END IF;
  IF EXISTS (SELECT 1 FROM public.conversations WHERE company_id IS NULL OR company_id<>cid) THEN RAISE EXCEPTION 'invalid conversation ownership'; END IF;
  IF EXISTS (SELECT 1 FROM public.upstream_call_log WHERE conversation_id IS NOT NULL AND (company_id IS NULL OR company_id<>cid)) THEN RAISE EXCEPTION 'invalid upstream log ownership'; END IF;
  IF EXISTS (SELECT 1 FROM public.feedback_automation_config WHERE company_id IS NULL OR company_id<>cid) THEN RAISE EXCEPTION 'invalid feedback config ownership'; END IF;
  IF to_regprocedure('public.tenant_safe_add_agent(uuid,uuid,uuid,public.app_role,text)') IS NULL THEN RAISE EXCEPTION 'missing tenant_safe_add_agent'; END IF;
  IF to_regprocedure('public.commit_ai_reply_tx(uuid,uuid,text,jsonb)') IS NULL THEN RAISE EXCEPTION 'missing commit_ai_reply_tx'; END IF;
  IF to_regprocedure('public.recall_message_tx(uuid,uuid,uuid,uuid,text)') IS NULL THEN RAISE EXCEPTION 'missing recall_message_tx'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND policyname='conversations_company_select') THEN RAISE EXCEPTION 'core conversation RLS missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND policyname='visitor_session_company_select') THEN RAISE EXCEPTION 'secondary visitor RLS missing'; END IF;
  IF to_regprocedure('public.pr7_ce_canonical_company(uuid)') IS NULL THEN RAISE EXCEPTION 'CE canonical lineage resolver missing'; END IF;
  IF to_regprocedure('public.pr7_ce_guard_evaluation_lineage()') IS NULL THEN RAISE EXCEPTION 'CE evaluation lineage guard missing'; END IF;
  IF to_regprocedure('public.pr7_ce_guard_snapshot_lineage()') IS NULL THEN RAISE EXCEPTION 'CE snapshot lineage guard missing'; END IF;
  IF to_regprocedure('public.pr7_ce_guard_outbox_lineage()') IS NULL THEN RAISE EXCEPTION 'CE outbox lineage guard missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger tr
    WHERE tr.tgrelid='public.conversation_evaluation'::regclass
      AND tr.tgname='trg_pr6_enqueue_canonical_evaluation'
      AND NOT tr.tgisinternal
      AND tr.tgdeferrable=true
      AND tr.tginitdeferred=true
  ) THEN RAISE EXCEPTION 'PR6 deferred canonical outbox trigger missing'; END IF;
  IF has_function_privilege('authenticated','public.ce_purge_expired_snapshots()','EXECUTE') THEN RAISE EXCEPTION 'authenticated can still purge CE snapshots'; END IF;
  IF position('channel_config' in pg_get_functiondef('public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text)'::regprocedure))=0 THEN RAISE EXCEPTION 'CE tenant hardening missing channel resolution'; END IF;
  IF position('tenant_identity_conflict' in pg_get_functiondef('public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text)'::regprocedure))=0 THEN RAISE EXCEPTION 'CE tenant hardening missing conflict guard'; END IF;
END $$;
SQL
echo "PASS canonical ownership / objects / ACL"

# Mandatory two-tenant authenticated RLS smoke.
[ -n "$TEST_USER_A" ] || stop "two-tenant fixture A user missing"
[ -n "$TEST_COMPANY_A" ] || stop "two-tenant fixture A company missing"
[ -n "$TEST_USER_B" ] || stop "two-tenant fixture B user missing"
[ -n "$TEST_COMPANY_B" ] || stop "two-tenant fixture B company missing"
[ "$TEST_COMPANY_A" != "$TEST_COMPANY_B" ] || stop "two distinct company fixtures required"

psql "$DB_URL" -v ON_ERROR_STOP=1 -v user_a="$TEST_USER_A" -v company_a="$TEST_COMPANY_A" -v user_b="$TEST_USER_B" -v company_b="$TEST_COMPANY_B" <<'SQL'
SELECT set_config('pr7.user_a', :'user_a', false);
SELECT set_config('pr7.company_a', :'company_a', false);
SELECT set_config('pr7.user_b', :'user_b', false);
SELECT set_config('pr7.company_b', :'company_b', false);
DO $$
DECLARE ua uuid:=current_setting('pr7.user_a')::uuid; ca uuid:=current_setting('pr7.company_a')::uuid; ub uuid:=current_setting('pr7.user_b')::uuid; cb uuid:=current_setting('pr7.company_b')::uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.company_membership cm JOIN public.company c ON c.id=cm.company_id AND c.is_active=true WHERE cm.user_id=ua AND cm.company_id=ca AND cm.is_active=true) THEN RAISE EXCEPTION 'fixture A invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.company_membership cm JOIN public.company c ON c.id=cm.company_id AND c.is_active=true WHERE cm.user_id=ub AND cm.company_id=cb AND cm.is_active=true) THEN RAISE EXCEPTION 'fixture B invalid'; END IF;
END $$;
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('pr7.user_a'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub',current_setting('pr7.user_a'),'role','authenticated')::text, true);
DO $$ DECLARE cb uuid:=current_setting('pr7.company_b')::uuid; n int; BEGIN
  SELECT count(*) INTO n FROM public.conversations WHERE company_id=cb; IF n<>0 THEN RAISE EXCEPTION 'RLS FAIL A->B conversations: %',n; END IF;
  SELECT count(*) INTO n FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id WHERE c.company_id=cb; IF n<>0 THEN RAISE EXCEPTION 'RLS FAIL A->B messages: %',n; END IF;
END $$;
ROLLBACK;
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', current_setting('pr7.user_b'), true);
SELECT set_config('request.jwt.claims', json_build_object('sub',current_setting('pr7.user_b'),'role','authenticated')::text, true);
DO $$ DECLARE ca uuid:=current_setting('pr7.company_a')::uuid; n int; BEGIN
  SELECT count(*) INTO n FROM public.conversations WHERE company_id=ca; IF n<>0 THEN RAISE EXCEPTION 'RLS FAIL B->A conversations: %',n; END IF;
END $$;
ROLLBACK;
SQL

echo "PASS two-tenant RLS runtime smoke"
echo "FINAL STATUS: READY"
