-- PR-6B training-result ingest rollback.
-- Does not delete historical ce_training_link records already received.

BEGIN;

DROP FUNCTION IF EXISTS public.record_coachai_training_result_tx(
  text,uuid,uuid,text,text,text,jsonb
);

COMMIT;
