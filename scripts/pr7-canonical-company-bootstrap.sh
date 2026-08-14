#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
RUN_ID="${PR7_BOOTSTRAP_RUN_ID:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
PLATFORM_COMPANY_ID="${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}"
COMPANY_SLUG="${PR7_CANONICAL_COMPANY_SLUG:-}"
COMPANY_NAME="${PR7_CANONICAL_COMPANY_NAME:-}"
EXT_WORKSPACE="${PR7_CANONICAL_EXTERNAL_WORKSPACE_ID:-}"
EXT_TENANT="${PR7_CANONICAL_EXTERNAL_TENANT_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }

[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ -n "$RUN_ID" ] || stop "PR7_BOOTSTRAP_RUN_ID missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$PLATFORM_COMPANY_ID" ] || stop "PR7_CANONICAL_PLATFORM_COMPANY_ID missing"
[ -n "$COMPANY_SLUG" ] || stop "PR7_CANONICAL_COMPANY_SLUG missing"
[ -n "$COMPANY_NAME" ] || stop "PR7_CANONICAL_COMPANY_NAME missing"
[ -n "$EXT_WORKSPACE" ] || stop "PR7_CANONICAL_EXTERNAL_WORKSPACE_ID missing"
[ -n "$EXT_TENANT" ] || stop "PR7_CANONICAL_EXTERNAL_TENANT_ID missing"
[[ "$PLATFORM_COMPANY_ID" =~ ^[0-9]+$ ]] || stop "canonical platform company id must be an integer"
command -v psql >/dev/null 2>&1 || stop "psql missing"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" \
  -v company_uuid="$COMPANY_UUID" \
  -v platform_company_id="$PLATFORM_COMPANY_ID" \
  -v company_slug="$COMPANY_SLUG" \
  -v company_name="$COMPANY_NAME" \
  -v ext_workspace="$EXT_WORKSPACE" \
  -v ext_tenant="$EXT_TENANT" <<'SQL'
\set QUIET 1
BEGIN;

SELECT set_config('pr7.run_id', :'run_id', false);
SELECT set_config('pr7.company_uuid', :'company_uuid', false);
SELECT set_config('pr7.platform_company_id', :'platform_company_id', false);
SELECT set_config('pr7.company_slug', :'company_slug', false);
SELECT set_config('pr7.company_name', :'company_name', false);
SELECT set_config('pr7.ext_workspace', :'ext_workspace', false);
SELECT set_config('pr7.ext_tenant', :'ext_tenant', false);

DO $validate$
DECLARE
  rid uuid := current_setting('pr7.run_id')::uuid;
  cuid uuid := current_setting('pr7.company_uuid')::uuid;
  pid bigint := current_setting('pr7.platform_company_id')::bigint;
  v_count int;
  v_exact boolean;
BEGIN
  IF pid <= 0 THEN
    RAISE EXCEPTION 'canonical platform company id must be > 0';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pr7_company_identity_bootstrap_run WHERE run_id=rid
  ) THEN
    RAISE EXCEPTION 'bootstrap run_id already exists';
  END IF;

  SELECT count(*) INTO v_count FROM public.company;

  SELECT EXISTS (
    SELECT 1
    FROM public.company
    WHERE id=cuid
      AND platform_company_id=pid
      AND slug=current_setting('pr7.company_slug')
      AND display_name=current_setting('pr7.company_name')
      AND external_workspace_id=current_setting('pr7.ext_workspace')
      AND external_tenant_id=current_setting('pr7.ext_tenant')
      AND is_active=true
  ) INTO v_exact;

  IF v_count=0 THEN
    INSERT INTO public.company(
      id,platform_company_id,slug,display_name,
      external_workspace_id,external_tenant_id,is_active
    ) VALUES (
      cuid,pid,current_setting('pr7.company_slug'),
      current_setting('pr7.company_name'),
      current_setting('pr7.ext_workspace'),
      current_setting('pr7.ext_tenant'),true
    );

    INSERT INTO public.pr7_company_identity_bootstrap_run(
      run_id,company_uuid,platform_company_id,created_company,completed_at
    ) VALUES(rid,cuid,pid,true,now());
    RETURN;
  END IF;

  -- Task 2.1 is deliberately single-company/bootstrap-only. Existing company
  -- state is accepted only when it is the exact same SU Platform identity.
  IF v_count<>1 OR NOT v_exact THEN
    RAISE EXCEPTION
      'canonical company bootstrap refused: existing company identity differs from supplied SU Platform UUID/integer mapping';
  END IF;

  -- Independent collision checks make the failure reason fail-closed even if
  -- future data contains more than one company.
  IF EXISTS (
    SELECT 1 FROM public.company
    WHERE id=cuid AND platform_company_id<>pid
  ) OR EXISTS (
    SELECT 1 FROM public.company
    WHERE platform_company_id=pid AND id<>cuid
  ) THEN
    RAISE EXCEPTION 'canonical UUID/integer company identity collision';
  END IF;

  INSERT INTO public.pr7_company_identity_bootstrap_run(
    run_id,company_uuid,platform_company_id,created_company,completed_at
  ) VALUES(rid,cuid,pid,false,now());
END
$validate$;

-- Task 2.1 MUST NOT own membership or legacy data binding.
DO $assert_scope$
DECLARE
  cuid uuid := current_setting('pr7.company_uuid')::uuid;
  pid bigint := current_setting('pr7.platform_company_id')::bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company
    WHERE id=cuid
      AND platform_company_id=pid
      AND is_active=true
  ) THEN
    RAISE EXCEPTION 'bootstrap assertion: canonical company identity missing';
  END IF;

  IF (SELECT count(*) FROM public.company)<>1 THEN
    RAISE EXCEPTION 'bootstrap assertion: expected exactly one canonical company';
  END IF;
END
$assert_scope$;

COMMIT;
SQL

echo "PASS: canonical SU Platform company UUID + integer identity bootstrap complete"
echo "Task 2.1 intentionally made no membership or conversation/channel ownership changes."
