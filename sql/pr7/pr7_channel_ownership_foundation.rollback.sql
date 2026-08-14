-- PR7 Workflow 3 / Task 3.1 foundation rollback
BEGIN;

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pr7_channel_ownership_run
    WHERE rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'PR7_CHANNEL_SCHEMA_ROLLBACK_BLOCKED: active channel ownership run remains';
  END IF;
END
$guard$;

DROP TABLE public.pr7_channel_ownership_row;
DROP TABLE public.pr7_channel_ownership_run;

COMMIT;
