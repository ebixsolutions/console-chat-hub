-- PR7 Workflow 2 / Task 2.1 — canonical company dual-identifier foundation
-- SOURCE-ONLY. No production apply without explicit authorization.
--
-- Canonical identity contract:
--   company.id                 = SU Platform canonical company UUID
--   company.platform_company_id = the SAME SU Platform company's canonical integer ID
--
-- AI Chatbot must never generate an independent company identity.

BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS platform_company_id bigint;

DO $assert_existing$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.company
    WHERE platform_company_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'PR7_COMPANY_IDENTITY_MIGRATION_BLOCKED: existing company row has no canonical platform integer id';
  END IF;
END
$assert_existing$;

ALTER TABLE public.company
  ALTER COLUMN platform_company_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_platform_company_id
  ON public.company(platform_company_id);

COMMENT ON COLUMN public.company.id IS
  'Canonical SU Platform company UUID. Never an AI Chatbot-generated tenant UUID.';
COMMENT ON COLUMN public.company.platform_company_id IS
  'Canonical SU Platform integer company ID for the same company represented by public.company.id.';

CREATE TABLE IF NOT EXISTS public.pr7_company_identity_bootstrap_run (
  run_id uuid PRIMARY KEY,
  company_uuid uuid NOT NULL,
  platform_company_id bigint NOT NULL,
  created_company boolean NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rolled_back_at timestamptz
);

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='company'
      AND column_name='id'
      AND udt_name='uuid'
      AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'ASSERT: company.id must remain UUID';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='company'
      AND column_name='platform_company_id'
      AND udt_name='int8'
      AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'ASSERT: platform_company_id must be NOT NULL bigint';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(i.indkey)
    WHERE n.nspname='public'
      AND t.relname='company'
      AND i.indisunique
      AND a.attname='platform_company_id'
  ) THEN
    RAISE EXCEPTION 'ASSERT: platform_company_id unique identity missing';
  END IF;
END
$assert$;

COMMIT;
