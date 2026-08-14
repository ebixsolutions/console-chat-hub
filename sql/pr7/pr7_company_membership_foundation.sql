-- PR7 Workflow 2 / Task 2.2 — canonical company membership foundation
-- SOURCE-ONLY. No production apply without explicit authorization.
--
-- Canonical authority:
--   public.company_membership is the company-scoped role authority.
--   agent_profile.role and user_roles.role are compatibility mirrors only.
--
-- One company + one user = exactly one membership row. Role changes UPDATE that
-- row; they must never create parallel role rows for the same company/user.

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $precheck$
BEGIN
  IF EXISTS (
    SELECT company_id,user_id
    FROM public.company_membership
    GROUP BY company_id,user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'PR7_MEMBERSHIP_SCHEMA_BLOCKED: duplicate company/user memberships already exist';
  END IF;
END
$precheck$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_membership_company_user
  ON public.company_membership(company_id,user_id);

CREATE TABLE IF NOT EXISTS public.pr7_membership_bootstrap_run (
  run_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rolled_back_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.pr7_membership_bootstrap_row (
  run_id uuid NOT NULL
    REFERENCES public.pr7_membership_bootstrap_run(run_id) ON DELETE CASCADE,
  membership_id uuid NOT NULL,
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  is_active boolean NOT NULL,
  created_by_run boolean NOT NULL,
  PRIMARY KEY (run_id,membership_id)
);

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(i.indkey)
    WHERE n.nspname='public'
      AND t.relname='company_membership'
      AND i.indisunique
      AND a.attname='company_id'
  ) THEN
    RAISE EXCEPTION 'ASSERT: canonical membership uniqueness missing';
  END IF;
END
$assert$;

COMMIT;
