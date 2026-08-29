-- Task 2.3 same-root runtime repair: finalizer claims use remote_sync_state=in_progress.
-- The previous CHECK omitted that state, making claim_pr6b_kb_finalize_tx impossible.
ALTER TABLE public.ce_kb_publish_state
  DROP CONSTRAINT IF EXISTS ce_kb_publish_state_remote_sync_state_check;
ALTER TABLE public.ce_kb_publish_state
  ADD CONSTRAINT ce_kb_publish_state_remote_sync_state_check
  CHECK (remote_sync_state = ANY (ARRAY['pending'::text,'in_progress'::text,'synced'::text,'failed'::text,'not_applicable'::text])) NOT VALID;
ALTER TABLE public.ce_kb_publish_state
  VALIDATE CONSTRAINT ce_kb_publish_state_remote_sync_state_check;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid='public.ce_kb_publish_state'::regclass
      AND conname='ce_kb_publish_state_remote_sync_state_check'
      AND convalidated
      AND pg_get_constraintdef(oid) LIKE '%in_progress%'
  ) THEN RAISE EXCEPTION 'TASK2_3_FINALIZER_STATE_CHECK_NOT_FIXED'; END IF;
END
$assert$;
