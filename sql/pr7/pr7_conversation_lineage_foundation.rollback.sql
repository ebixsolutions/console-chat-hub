-- PR7 Workflow 3 / Task 3.2 foundation rollback
BEGIN;
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pr7_conversation_lineage_run
    WHERE rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'PR7_CONVERSATION_LINEAGE_SCHEMA_ROLLBACK_BLOCKED: active run remains';
  END IF;
END
$guard$;

DROP TABLE public.pr7_conversation_lineage_row;
DROP TABLE public.pr7_conversation_lineage_run;
COMMIT;
