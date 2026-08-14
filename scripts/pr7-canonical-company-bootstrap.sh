#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
SINGLE="${PR7_LEGACY_DATA_IS_SINGLE_COMPANY:-}"
COMPANY_ID="${PR7_CANONICAL_COMPANY_ID:-}"
COMPANY_SLUG="${PR7_CANONICAL_COMPANY_SLUG:-}"
COMPANY_NAME="${PR7_CANONICAL_COMPANY_NAME:-}"
EXT_WORKSPACE="${PR7_CANONICAL_EXTERNAL_WORKSPACE_ID:-}"
EXT_TENANT="${PR7_CANONICAL_EXTERNAL_TENANT_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }

[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ "$SINGLE" = "YES" ] || stop "legacy single-company ownership not explicitly confirmed"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$COMPANY_ID" ] || stop "PR7_CANONICAL_COMPANY_ID missing"
[ -n "$COMPANY_SLUG" ] || stop "PR7_CANONICAL_COMPANY_SLUG missing"
[ -n "$COMPANY_NAME" ] || stop "PR7_CANONICAL_COMPANY_NAME missing"
[ -n "$EXT_WORKSPACE" ] || stop "PR7_CANONICAL_EXTERNAL_WORKSPACE_ID missing"
[ -n "$EXT_TENANT" ] || stop "PR7_CANONICAL_EXTERNAL_TENANT_ID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v company_id="$COMPANY_ID" \
  -v company_slug="$COMPANY_SLUG" \
  -v company_name="$COMPANY_NAME" \
  -v ext_workspace="$EXT_WORKSPACE" \
  -v ext_tenant="$EXT_TENANT" <<'SQL'
\set QUIET 1
BEGIN;

-- Fail closed if production is no longer the verified legacy shape.
DO $$
DECLARE
  v_company_count int;
  v_membership_count int;
  v_conv_count int;
  v_unbound_conv int;
  v_bound_other int;
BEGIN
  SELECT count(*) INTO v_company_count FROM public.company;
  SELECT count(*) INTO v_membership_count FROM public.company_membership;
  SELECT count(*) INTO v_conv_count FROM public.conversations;
  SELECT count(*) INTO v_unbound_conv FROM public.conversations WHERE company_id IS NULL;
  SELECT count(*) INTO v_bound_other
  FROM public.conversations
  WHERE company_id IS NOT NULL
    AND company_id <> :'company_id'::uuid;

  IF v_company_count > 1 THEN
    RAISE EXCEPTION 'bootstrap refused: existing multi-company production';
  END IF;
  IF v_membership_count > 0 AND v_company_count = 0 THEN
    RAISE EXCEPTION 'bootstrap refused: orphan memberships exist';
  END IF;
  IF v_bound_other > 0 THEN
    RAISE EXCEPTION 'bootstrap refused: conversations already owned by another company';
  END IF;
  IF v_conv_count > 0 AND v_unbound_conv <> v_conv_count AND v_bound_other = 0 THEN
    -- Partial prior bootstrap is only accepted when all bound rows already point
    -- at the exact requested canonical company.
    NULL;
  END IF;
END $$;

-- Canonical platform company identity.
INSERT INTO public.company(
  id, slug, display_name, external_workspace_id, external_tenant_id, is_active
)
VALUES(
  :'company_id'::uuid,
  :'company_slug',
  :'company_name',
  :'ext_workspace',
  :'ext_tenant',
  true
)
ON CONFLICT (id) DO UPDATE
SET slug = EXCLUDED.slug,
    display_name = EXCLUDED.display_name,
    external_workspace_id = EXCLUDED.external_workspace_id,
    external_tenant_id = EXCLUDED.external_tenant_id,
    is_active = true;

-- Reject identifier collisions against another company.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.company
    WHERE id <> :'company_id'::uuid
      AND (
        slug = :'company_slug'
        OR external_workspace_id = :'ext_workspace'
        OR external_tenant_id = :'ext_tenant'
      )
  ) THEN
    RAISE EXCEPTION 'canonical identifier collision';
  END IF;
END $$;

-- Bind active auth-backed agents into the canonical company.
-- Legacy super_admin/admin become tenant admin; supported app roles keep parity.
INSERT INTO public.company_membership(company_id, user_id, role, is_active)
SELECT
  :'company_id'::uuid,
  ap.user_id,
  CASE
    WHEN ap.role::text IN ('super_admin','admin') THEN 'admin'::public.app_role
    WHEN ap.role::text = 'supervisor' THEN 'supervisor'::public.app_role
    WHEN ap.role::text = 'qa' THEN 'qa'::public.app_role
    ELSE 'agent'::public.app_role
  END,
  true
FROM public.agent_profile ap
JOIN auth.users au ON au.id = ap.user_id
WHERE ap.status::text = 'active'
  AND ap.user_id IS NOT NULL
ON CONFLICT (company_id, user_id)
DO UPDATE SET role = EXCLUDED.role, is_active = true;

-- Bind legacy channel + conversation ownership before RLS is tightened.
UPDATE public.channel_config
SET company_id = :'company_id'::uuid
WHERE company_id IS NULL;

UPDATE public.conversations
SET company_id = :'company_id'::uuid
WHERE company_id IS NULL;

-- Backfill trace ownership only through authoritative conversation ownership.
UPDATE public.upstream_call_log u
SET company_id = c.company_id
FROM public.conversations c
WHERE u.conversation_id = c.id
  AND u.company_id IS NULL
  AND c.company_id = :'company_id'::uuid;

-- Existing CE/training rows, if any, may only be backfilled via conversation or
-- evaluation lineage. Never mass-assign unrelated rows.
UPDATE public.conversation_evaluation e
SET company_id = c.company_id
FROM public.conversations c
WHERE e.conversation_id = c.id
  AND e.company_id IS NULL
  AND c.company_id = :'company_id'::uuid;

UPDATE public.conversation_evaluation_attempt a
SET company_id = c.company_id
FROM public.conversations c
WHERE a.conversation_id = c.id
  AND a.company_id IS NULL
  AND c.company_id = :'company_id'::uuid;

UPDATE public.ce_bundle_snapshot s
SET company_id = c.company_id
FROM public.conversations c
WHERE s.conversation_id = c.id
  AND s.company_id IS NULL
  AND c.company_id = :'company_id'::uuid;

UPDATE public.evaluation_training_outbox o
SET company_id = e.company_id
FROM public.conversation_evaluation e
WHERE o.evaluation_id = e.id
  AND o.company_id IS NULL
  AND e.company_id = :'company_id'::uuid;

-- Assertions: every existing tenant-owned live row must now resolve.
DO $$
DECLARE
  v_active_members int;
  v_unbound_channels int;
  v_unbound_conv int;
  v_unbound_logs int;
BEGIN
  SELECT count(*) INTO v_active_members
  FROM public.company_membership
  WHERE company_id = :'company_id'::uuid AND is_active=true;

  SELECT count(*) INTO v_unbound_channels
  FROM public.channel_config WHERE company_id IS NULL;

  SELECT count(*) INTO v_unbound_conv
  FROM public.conversations WHERE company_id IS NULL;

  SELECT count(*) INTO v_unbound_logs
  FROM public.upstream_call_log
  WHERE conversation_id IS NOT NULL AND company_id IS NULL;

  IF v_active_members < 1 THEN
    RAISE EXCEPTION 'bootstrap assertion: no active company member';
  END IF;
  IF v_unbound_channels <> 0 THEN
    RAISE EXCEPTION 'bootstrap assertion: % unbound channels', v_unbound_channels;
  END IF;
  IF v_unbound_conv <> 0 THEN
    RAISE EXCEPTION 'bootstrap assertion: % unbound conversations', v_unbound_conv;
  END IF;
  IF v_unbound_logs <> 0 THEN
    RAISE EXCEPTION 'bootstrap assertion: % unbound upstream logs', v_unbound_logs;
  END IF;
END $$;

COMMIT;
SQL

echo "PASS: canonical company bootstrap/binding complete"
