-- PR7 company membership foundation rollback
-- Must run only after membership bootstrap rollback.
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pr7_membership_bootstrap_run) THEN
    RAISE EXCEPTION 'PR7_MEMBERSHIP_SCHEMA_ROLLBACK_BLOCKED: bootstrap provenance still exists';
  END IF;
END
$guard$;

DROP TABLE public.pr7_membership_bootstrap_row;
DROP TABLE public.pr7_membership_bootstrap_run;
DROP INDEX IF EXISTS public.uq_company_membership_company_user;

COMMIT;
