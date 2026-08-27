-- W2 Task 2.1 / PR7 — canonical SU Platform company dual identity foundation
-- SOURCE ONLY. Production apply requires explicit authorization.
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE public.company ADD COLUMN IF NOT EXISTS platform_company_id bigint;
DO $assert_existing$
BEGIN
  IF EXISTS (SELECT 1 FROM public.company WHERE platform_company_id IS NULL) THEN
    RAISE EXCEPTION 'W2_T2_1_IDENTITY_MIGRATION_BLOCKED: existing company row lacks canonical platform integer id';
  END IF;
END
$assert_existing$;
ALTER TABLE public.company ALTER COLUMN platform_company_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_platform_company_id ON public.company(platform_company_id);
COMMENT ON COLUMN public.company.id IS 'Canonical SU Platform company UUID. Never AI Chatbot generated.';
COMMENT ON COLUMN public.company.platform_company_id IS 'Canonical SU Platform integer company id for the same company as public.company.id.';
CREATE TABLE IF NOT EXISTS public.pr7_company_identity_bootstrap_run (run_id uuid PRIMARY KEY,company_uuid uuid NOT NULL,platform_company_id bigint NOT NULL,created_company boolean NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,rolled_back_at timestamptz);
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='company' AND column_name='id' AND udt_name='uuid' AND is_nullable='NO') THEN RAISE EXCEPTION 'ASSERT: company.id must remain NOT NULL uuid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='company' AND column_name='platform_company_id' AND udt_name='int8' AND is_nullable='NO') THEN RAISE EXCEPTION 'ASSERT: platform_company_id must be NOT NULL bigint'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_company_platform_company_id' AND indexdef ILIKE '%UNIQUE%') THEN RAISE EXCEPTION 'ASSERT: platform_company_id unique identity missing'; END IF;
END
$assert$;
COMMIT;
