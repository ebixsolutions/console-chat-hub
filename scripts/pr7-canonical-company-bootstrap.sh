#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
SINGLE="${PR7_LEGACY_DATA_IS_SINGLE_COMPANY:-}"
RUN_ID="${PR7_BOOTSTRAP_RUN_ID:-}"
COMPANY_ID="${PR7_CANONICAL_COMPANY_ID:-}"
COMPANY_SLUG="${PR7_CANONICAL_COMPANY_SLUG:-}"
COMPANY_NAME="${PR7_CANONICAL_COMPANY_NAME:-}"
EXT_WORKSPACE="${PR7_CANONICAL_EXTERNAL_WORKSPACE_ID:-}"
EXT_TENANT="${PR7_CANONICAL_EXTERNAL_TENANT_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }

[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ "$SINGLE" = "YES" ] || stop "legacy single-company ownership not explicitly confirmed"
[ -n "$RUN_ID" ] || stop "PR7_BOOTSTRAP_RUN_ID missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$COMPANY_ID" ] || stop "PR7_CANONICAL_COMPANY_ID missing"
[ -n "$COMPANY_SLUG" ] || stop "PR7_CANONICAL_COMPANY_SLUG missing"
[ -n "$COMPANY_NAME" ] || stop "PR7_CANONICAL_COMPANY_NAME missing"
[ -n "$EXT_WORKSPACE" ] || stop "PR7_CANONICAL_EXTERNAL_WORKSPACE_ID missing"
[ -n "$EXT_TENANT" ] || stop "PR7_CANONICAL_EXTERNAL_TENANT_ID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" \
  -v company_id="$COMPANY_ID" \
  -v company_slug="$COMPANY_SLUG" \
  -v company_name="$COMPANY_NAME" \
  -v ext_workspace="$EXT_WORKSPACE" \
  -v ext_tenant="$EXT_TENANT" <<'SQL'
\set QUIET 1
BEGIN;

-- psql variables are materialized into session settings OUTSIDE dollar-quoted
-- PL/pgSQL bodies. PL/pgSQL reads them via current_setting().
SELECT set_config('pr7.run_id', :'run_id', false);
SELECT set_config('pr7.company_id', :'company_id', false);
SELECT set_config('pr7.company_slug', :'company_slug', false);
SELECT set_config('pr7.company_name', :'company_name', false);
SELECT set_config('pr7.ext_workspace', :'ext_workspace', false);
SELECT set_config('pr7.ext_tenant', :'ext_tenant', false);

CREATE TABLE IF NOT EXISTS public.pr7_canonical_bootstrap_run (
  run_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  state_before text NOT NULL CHECK (state_before IN ('pre_tenant','already_bound')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rolled_back_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.pr7_canonical_bootstrap_row (
  run_id uuid NOT NULL REFERENCES public.pr7_canonical_bootstrap_run(run_id) ON DELETE CASCADE,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  previous_company_id uuid,
  PRIMARY KEY (run_id, table_name, row_id)
);

CREATE TABLE IF NOT EXISTS public.pr7_canonical_bootstrap_membership (
  run_id uuid NOT NULL REFERENCES public.pr7_canonical_bootstrap_run(run_id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  PRIMARY KEY (run_id, membership_id)
);

CREATE TABLE IF NOT EXISTS public.pr7_canonical_bootstrap_company (
  run_id uuid PRIMARY KEY REFERENCES public.pr7_canonical_bootstrap_run(run_id) ON DELETE CASCADE,
  company_id uuid NOT NULL
);

-- Determine exactly one accepted baseline: verified pre-tenant, or exact
-- idempotent already-bound canonical state. Anything else stops.
DO $$
DECLARE
  cid uuid := current_setting('pr7.company_id')::uuid;
  rid uuid := current_setting('pr7.run_id')::uuid;
  v_company_count int;
  v_membership_count int;
  v_conv_total int;
  v_conv_null int;
  v_conv_other int;
  v_channel_other int;
  v_log_other int;
  v_state text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.pr7_canonical_bootstrap_run WHERE run_id=rid) THEN
    RAISE EXCEPTION 'bootstrap run_id already exists';
  END IF;

  SELECT count(*) INTO v_company_count FROM public.company;
  SELECT count(*) INTO v_membership_count FROM public.company_membership;
  SELECT count(*) INTO v_conv_total FROM public.conversations;
  SELECT count(*) INTO v_conv_null FROM public.conversations WHERE company_id IS NULL;
  SELECT count(*) INTO v_conv_other FROM public.conversations WHERE company_id IS NOT NULL AND company_id<>cid;
  SELECT count(*) INTO v_channel_other FROM public.channel_config WHERE company_id IS NOT NULL AND company_id<>cid;
  SELECT count(*) INTO v_log_other FROM public.upstream_call_log WHERE company_id IS NOT NULL AND company_id<>cid;

  IF v_company_count=0
     AND v_membership_count=0
     AND v_conv_null=v_conv_total
     AND v_conv_other=0
     AND v_channel_other=0
     AND v_log_other=0 THEN
    v_state := 'pre_tenant';
  ELSIF v_company_count=1
     AND EXISTS (SELECT 1 FROM public.company WHERE id=cid AND is_active=true)
     AND v_conv_null=0
     AND v_conv_other=0
     AND NOT EXISTS (SELECT 1 FROM public.channel_config WHERE company_id IS NULL OR company_id<>cid)
     AND NOT EXISTS (
       SELECT 1 FROM public.upstream_call_log
       WHERE conversation_id IS NOT NULL AND (company_id IS NULL OR company_id<>cid)
     )
     AND NOT EXISTS (SELECT 1 FROM public.company_membership WHERE company_id<>cid) THEN
    v_state := 'already_bound';
  ELSE
    RAISE EXCEPTION 'bootstrap refused: production is neither verified pre-tenant nor exact canonical-bound state';
  END IF;

  PERFORM set_config('pr7.state_before', v_state, false);
  INSERT INTO public.pr7_canonical_bootstrap_run(run_id,company_id,state_before)
  VALUES(rid,cid,v_state);
END $$;

-- In already-bound mode, identifiers must match exactly. Never mutate them
-- silently during an idempotent retry.
DO $$
DECLARE
  cid uuid := current_setting('pr7.company_id')::uuid;
BEGIN
  IF current_setting('pr7.state_before')='already_bound' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.company
      WHERE id=cid
        AND slug=current_setting('pr7.company_slug')
        AND display_name=current_setting('pr7.company_name')
        AND external_workspace_id=current_setting('pr7.ext_workspace')
        AND external_tenant_id=current_setting('pr7.ext_tenant')
        AND is_active=true
    ) THEN
      RAISE EXCEPTION 'canonical identifier mismatch on idempotent retry';
    END IF;
  END IF;
END $$;

-- Record exact rows that will be mutated, only on first bootstrap.
INSERT INTO public.pr7_canonical_bootstrap_row(run_id,table_name,row_id,previous_company_id)
SELECT current_setting('pr7.run_id')::uuid,'channel_config',id,company_id
FROM public.channel_config
WHERE current_setting('pr7.state_before')='pre_tenant' AND company_id IS NULL;

INSERT INTO public.pr7_canonical_bootstrap_row(run_id,table_name,row_id,previous_company_id)
SELECT current_setting('pr7.run_id')::uuid,'conversations',id,company_id
FROM public.conversations
WHERE current_setting('pr7.state_before')='pre_tenant' AND company_id IS NULL;

INSERT INTO public.pr7_canonical_bootstrap_row(run_id,table_name,row_id,previous_company_id)
SELECT current_setting('pr7.run_id')::uuid,'upstream_call_log',id,company_id
FROM public.upstream_call_log
WHERE current_setting('pr7.state_before')='pre_tenant'
  AND conversation_id IS NOT NULL AND company_id IS NULL;

INSERT INTO public.pr7_canonical_bootstrap_row(run_id,table_name,row_id,previous_company_id)
SELECT current_setting('pr7.run_id')::uuid,'conversation_evaluation',id,company_id
FROM public.conversation_evaluation
WHERE current_setting('pr7.state_before')='pre_tenant' AND company_id IS NULL;

INSERT INTO public.pr7_canonical_bootstrap_row(run_id,table_name,row_id,previous_company_id)
SELECT current_setting('pr7.run_id')::uuid,'conversation_evaluation_attempt',id,company_id
FROM public.conversation_evaluation_attempt
WHERE current_setting('pr7.state_before')='pre_tenant' AND company_id IS NULL;

INSERT INTO public.pr7_canonical_bootstrap_row(run_id,table_name,row_id,previous_company_id)
SELECT current_setting('pr7.run_id')::uuid,'ce_bundle_snapshot',id,company_id
FROM public.ce_bundle_snapshot
WHERE current_setting('pr7.state_before')='pre_tenant' AND company_id IS NULL;

INSERT INTO public.pr7_canonical_bootstrap_row(run_id,table_name,row_id,previous_company_id)
SELECT current_setting('pr7.run_id')::uuid,'evaluation_training_outbox',id,company_id
FROM public.evaluation_training_outbox
WHERE current_setting('pr7.state_before')='pre_tenant' AND company_id IS NULL;

-- First bootstrap only: insert canonical company.
INSERT INTO public.company(id,slug,display_name,external_workspace_id,external_tenant_id,is_active)
SELECT
  current_setting('pr7.company_id')::uuid,
  current_setting('pr7.company_slug'),
  current_setting('pr7.company_name'),
  current_setting('pr7.ext_workspace'),
  current_setting('pr7.ext_tenant'),
  true
WHERE current_setting('pr7.state_before')='pre_tenant';

INSERT INTO public.pr7_canonical_bootstrap_company(run_id,company_id)
SELECT current_setting('pr7.run_id')::uuid,current_setting('pr7.company_id')::uuid
WHERE current_setting('pr7.state_before')='pre_tenant';

-- Desired membership roles for active auth-backed agents.
CREATE TEMP TABLE pr7_desired_membership ON COMMIT DROP AS
SELECT
  ap.user_id,
  CASE
    WHEN ap.role::text IN ('super_admin','admin') THEN 'admin'::public.app_role
    WHEN ap.role::text='supervisor' THEN 'supervisor'::public.app_role
    WHEN ap.role::text='qa' THEN 'qa'::public.app_role
    ELSE 'agent'::public.app_role
  END AS role
FROM public.agent_profile ap
JOIN auth.users au ON au.id=ap.user_id
WHERE ap.status::text='active' AND ap.user_id IS NOT NULL;

-- Deactivate stale alternate roles on idempotent retries.
UPDATE public.company_membership cm
SET is_active=false
FROM pr7_desired_membership d
WHERE cm.company_id=current_setting('pr7.company_id')::uuid
  AND cm.user_id=d.user_id
  AND cm.role<>d.role
  AND cm.is_active=true;

INSERT INTO public.company_membership(company_id,user_id,role,is_active)
SELECT current_setting('pr7.company_id')::uuid,d.user_id,d.role,true
FROM pr7_desired_membership d
ON CONFLICT (company_id,user_id,role)
DO UPDATE SET is_active=true;

-- Record memberships created by first bootstrap. Pre-tenant guarantees there
-- were zero memberships beforehand.
INSERT INTO public.pr7_canonical_bootstrap_membership(run_id,membership_id)
SELECT current_setting('pr7.run_id')::uuid,cm.id
FROM public.company_membership cm
WHERE current_setting('pr7.state_before')='pre_tenant'
  AND cm.company_id=current_setting('pr7.company_id')::uuid;

UPDATE public.channel_config
SET company_id=current_setting('pr7.company_id')::uuid
WHERE current_setting('pr7.state_before')='pre_tenant' AND company_id IS NULL;

UPDATE public.conversations
SET company_id=current_setting('pr7.company_id')::uuid
WHERE current_setting('pr7.state_before')='pre_tenant' AND company_id IS NULL;

UPDATE public.upstream_call_log u
SET company_id=c.company_id
FROM public.conversations c
WHERE current_setting('pr7.state_before')='pre_tenant'
  AND u.conversation_id=c.id AND u.company_id IS NULL
  AND c.company_id=current_setting('pr7.company_id')::uuid;

UPDATE public.conversation_evaluation e
SET company_id=c.company_id
FROM public.conversations c
WHERE current_setting('pr7.state_before')='pre_tenant'
  AND e.conversation_id=c.id AND e.company_id IS NULL
  AND c.company_id=current_setting('pr7.company_id')::uuid;

UPDATE public.conversation_evaluation_attempt a
SET company_id=c.company_id
FROM public.conversations c
WHERE current_setting('pr7.state_before')='pre_tenant'
  AND a.conversation_id=c.id AND a.company_id IS NULL
  AND c.company_id=current_setting('pr7.company_id')::uuid;

UPDATE public.ce_bundle_snapshot s
SET company_id=c.company_id
FROM public.conversations c
WHERE current_setting('pr7.state_before')='pre_tenant'
  AND s.conversation_id=c.id AND s.company_id IS NULL
  AND c.company_id=current_setting('pr7.company_id')::uuid;

UPDATE public.evaluation_training_outbox o
SET company_id=e.company_id
FROM public.conversation_evaluation e
WHERE current_setting('pr7.state_before')='pre_tenant'
  AND o.evaluation_id=e.id AND o.company_id IS NULL
  AND e.company_id=current_setting('pr7.company_id')::uuid;

DO $$
DECLARE cid uuid:=current_setting('pr7.company_id')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership WHERE company_id=cid AND is_active=true
  ) THEN RAISE EXCEPTION 'bootstrap assertion: no active company member'; END IF;
  IF EXISTS (SELECT 1 FROM public.channel_config WHERE company_id IS NULL OR company_id<>cid) THEN
    RAISE EXCEPTION 'bootstrap assertion: invalid channel ownership'; END IF;
  IF EXISTS (SELECT 1 FROM public.conversations WHERE company_id IS NULL OR company_id<>cid) THEN
    RAISE EXCEPTION 'bootstrap assertion: invalid conversation ownership'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.upstream_call_log
    WHERE conversation_id IS NOT NULL AND (company_id IS NULL OR company_id<>cid)
  ) THEN RAISE EXCEPTION 'bootstrap assertion: invalid upstream log ownership'; END IF;
END $$;

UPDATE public.pr7_canonical_bootstrap_run
SET completed_at=now()
WHERE run_id=current_setting('pr7.run_id')::uuid;

COMMIT;
SQL

echo "PASS: canonical company bootstrap/binding complete"
