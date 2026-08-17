-- PR29 Task 2 scheduler-cutoff safety rollback.
-- Safe rollback is to stop automatic execution. We deliberately do NOT restore
-- the known-bad historical-backfill scheduler or terminal-job blocker.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF to_regprocedure('public.ce_deactivate_scheduler_v1()') IS NOT NULL THEN
    PERFORM public.ce_deactivate_scheduler_v1();
  END IF;
END
$$;

COMMIT;
