-- W2 Task 2.1 canonical company dual identity rollback.
-- Run only after canonical company bootstrap rollback.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $guard$
BEGIN
  IF to_regclass('public.pr7_company_identity_bootstrap_run') IS NOT NULL AND EXISTS (SELECT 1 FROM public.pr7_company_identity_bootstrap_run WHERE completed_at IS NOT NULL AND rolled_back_at IS NULL) THEN RAISE EXCEPTION 'W2_T2_1_ROLLBACK_BLOCKED: active bootstrap run exists'; END IF;
  IF EXISTS (SELECT 1 FROM public.company) THEN RAISE EXCEPTION 'W2_T2_1_ROLLBACK_BLOCKED: company rows still exist'; END IF;
END
$guard$;
DROP TABLE IF EXISTS public.pr7_company_identity_bootstrap_run;
DROP INDEX IF EXISTS public.uq_company_platform_company_id;
ALTER TABLE public.company DROP COLUMN IF EXISTS platform_company_id;
COMMIT;
