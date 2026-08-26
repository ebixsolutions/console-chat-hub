-- PR7 canonical company dual-identifier foundation rollback
-- Must run only after the Task 2.1 company bootstrap rollback.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pr7_company_identity_bootstrap_run
    WHERE rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'PR7_COMPANY_IDENTITY_ROLLBACK_BLOCKED: active bootstrap run still exists';
  END IF;

  IF EXISTS (SELECT 1 FROM public.company) THEN
    RAISE EXCEPTION
      'PR7_COMPANY_IDENTITY_ROLLBACK_BLOCKED: company rows still exist';
  END IF;
END
$guard$;

DROP TABLE public.pr7_company_identity_bootstrap_run;
DROP INDEX IF EXISTS public.uq_company_platform_company_id;
ALTER TABLE public.company DROP COLUMN IF EXISTS platform_company_id;

COMMIT;
