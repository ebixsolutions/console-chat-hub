#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
RUN_ID="${PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
PLATFORM_COMPANY_ID="${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$PLATFORM_COMPANY_ID" ] || stop "PR7_CANONICAL_PLATFORM_COMPANY_ID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" \
  -v company_uuid="$COMPANY_UUID" \
  -v platform_company_id="$PLATFORM_COMPANY_ID" <<'SQL'
\set QUIET 1
BEGIN;

SELECT set_config('pr7.membership_run_id', :'run_id', false);
SELECT set_config('pr7.company_uuid', :'company_uuid', false);
SELECT set_config('pr7.platform_company_id', :'platform_company_id', false);

DO $company$
DECLARE
  cid uuid:=current_setting('pr7.company_uuid')::uuid;
  pid bigint:=current_setting('pr7.platform_company_id')::bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company
    WHERE id=cid AND platform_company_id=pid AND is_active=true
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: canonical company UUID/integer identity missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pr7_membership_bootstrap_run
    WHERE run_id=current_setting('pr7.membership_run_id')::uuid
  ) THEN
    RAISE EXCEPTION 'membership bootstrap run_id already exists';
  END IF;
END
$company$;

-- Derive desired memberships from authenticated ACTIVE agent profiles, but
-- require legacy mirrors to agree before creating canonical authority.
CREATE TEMP TABLE pr7_desired_membership ON COMMIT DROP AS
SELECT
  ap.user_id,
  CASE ap.role
    WHEN 'super_admin' THEN 'admin'::public.app_role
    WHEN 'admin' THEN 'admin'::public.app_role
    WHEN 'supervisor' THEN 'supervisor'::public.app_role
    WHEN 'qa' THEN 'qa'::public.app_role
    WHEN 'agent' THEN 'agent'::public.app_role
    ELSE NULL::public.app_role
  END AS profile_role,
  ur.role AS legacy_role
FROM public.agent_profile ap
JOIN auth.users au ON au.id=ap.user_id
LEFT JOIN public.user_roles ur ON ur.user_id=ap.user_id
WHERE ap.status='active'
  AND ap.user_id IS NOT NULL;

DO $validate$
DECLARE
  cid uuid:=current_setting('pr7.company_uuid')::uuid;
  v_count int;
BEGIN
  -- An active profile without a real auth user is never silently ignored.
  IF EXISTS (
    SELECT 1
    FROM public.agent_profile ap
    LEFT JOIN auth.users au ON au.id=ap.user_id
    WHERE ap.status='active'
      AND (ap.user_id IS NULL OR au.id IS NULL)
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: active agent profile has no authenticated user';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pr7_desired_membership
    WHERE profile_role IS NULL
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: unsupported active profile role';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pr7_desired_membership
    WHERE legacy_role IS NULL
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: active profile missing legacy role mirror';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pr7_desired_membership
    WHERE profile_role IS DISTINCT FROM legacy_role
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: agent_profile and user_roles role conflict';
  END IF;

  IF EXISTS (
    SELECT user_id FROM pr7_desired_membership
    GROUP BY user_id HAVING count(*)<>1
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: duplicate active agent identity';
  END IF;

  SELECT count(*) INTO v_count
  FROM pr7_desired_membership
  WHERE profile_role='admin'::public.app_role;

  IF v_count<1 THEN
    RAISE EXCEPTION 'membership bootstrap refused: at least one active canonical admin is required';
  END IF;

  -- No active cross-company membership may exist for a desired user.
  IF EXISTS (
    SELECT 1
    FROM pr7_desired_membership d
    JOIN public.company_membership cm ON cm.user_id=d.user_id
    WHERE cm.company_id<>cid AND cm.is_active=true
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: active cross-company membership conflict';
  END IF;

  -- Existing row for this company is accepted only when exact.
  IF EXISTS (
    SELECT 1
    FROM public.company_membership cm
    JOIN pr7_desired_membership d ON d.user_id=cm.user_id
    WHERE cm.company_id=cid
      AND (cm.role IS DISTINCT FROM d.profile_role OR cm.is_active<>true)
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: existing canonical membership conflicts with role mirrors';
  END IF;

  -- No unexpected membership rows are permitted in this bootstrap-only state.
  IF EXISTS (
    SELECT 1
    FROM public.company_membership cm
    WHERE cm.company_id=cid
      AND NOT EXISTS (
        SELECT 1 FROM pr7_desired_membership d WHERE d.user_id=cm.user_id
      )
  ) THEN
    RAISE EXCEPTION 'membership bootstrap refused: unexpected existing company membership';
  END IF;
END
$validate$;

INSERT INTO public.pr7_membership_bootstrap_run(run_id,company_id)
VALUES(
  current_setting('pr7.membership_run_id')::uuid,
  current_setting('pr7.company_uuid')::uuid
);

-- Record exact pre-existing accepted rows first (created_by_run=false).
INSERT INTO public.pr7_membership_bootstrap_row(
  run_id,membership_id,company_id,user_id,role,is_active,created_by_run
)
SELECT
  current_setting('pr7.membership_run_id')::uuid,
  cm.id,cm.company_id,cm.user_id,cm.role,cm.is_active,false
FROM public.company_membership cm
JOIN pr7_desired_membership d ON d.user_id=cm.user_id
WHERE cm.company_id=current_setting('pr7.company_uuid')::uuid;

-- Insert only missing canonical membership rows.
INSERT INTO public.company_membership(company_id,user_id,role,is_active)
SELECT
  current_setting('pr7.company_uuid')::uuid,
  d.user_id,d.profile_role,true
FROM pr7_desired_membership d
WHERE NOT EXISTS (
  SELECT 1 FROM public.company_membership cm
  WHERE cm.company_id=current_setting('pr7.company_uuid')::uuid
    AND cm.user_id=d.user_id
)
RETURNING id;

-- Record only rows created by this run.
INSERT INTO public.pr7_membership_bootstrap_row(
  run_id,membership_id,company_id,user_id,role,is_active,created_by_run
)
SELECT
  current_setting('pr7.membership_run_id')::uuid,
  cm.id,cm.company_id,cm.user_id,cm.role,cm.is_active,true
FROM public.company_membership cm
JOIN pr7_desired_membership d ON d.user_id=cm.user_id
WHERE cm.company_id=current_setting('pr7.company_uuid')::uuid
  AND NOT EXISTS (
    SELECT 1
    FROM public.pr7_membership_bootstrap_row p
    WHERE p.run_id=current_setting('pr7.membership_run_id')::uuid
      AND p.membership_id=cm.id
  );

DO $assert$
DECLARE
  cid uuid:=current_setting('pr7.company_uuid')::uuid;
  desired int;
  actual int;
  admins int;
BEGIN
  SELECT count(*) INTO desired FROM pr7_desired_membership;
  SELECT count(*) INTO actual
  FROM public.company_membership
  WHERE company_id=cid AND is_active=true;

  IF desired<>actual THEN
    RAISE EXCEPTION 'membership bootstrap assertion: desired=% active=%',desired,actual;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.company_membership cm
    JOIN pr7_desired_membership d ON d.user_id=cm.user_id
    WHERE cm.company_id=cid
      AND (cm.role IS DISTINCT FROM d.profile_role OR cm.is_active<>true)
  ) THEN
    RAISE EXCEPTION 'membership bootstrap assertion: canonical role mismatch';
  END IF;

  SELECT count(*) INTO admins
  FROM public.company_membership
  WHERE company_id=cid AND role='admin'::public.app_role AND is_active=true;
  IF admins<1 THEN
    RAISE EXCEPTION 'membership bootstrap assertion: no active admin';
  END IF;

  -- Task 2.2 must not bind tenant-owned business data.
  IF EXISTS (
    SELECT 1 FROM public.conversations WHERE company_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.channel_config WHERE company_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'membership bootstrap scope violation: conversation/channel ownership changed before Workflow 3';
  END IF;
END
$assert$;

UPDATE public.pr7_membership_bootstrap_run
SET completed_at=now()
WHERE run_id=current_setting('pr7.membership_run_id')::uuid;

COMMIT;
SQL

echo "PASS: canonical company memberships bootstrapped"
echo "company_membership is now the company-scoped role authority."
echo "No conversation/channel ownership was changed."
