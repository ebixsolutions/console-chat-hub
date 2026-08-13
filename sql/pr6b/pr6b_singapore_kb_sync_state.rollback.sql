BEGIN;
DROP FUNCTION IF EXISTS public.finish_pr6b_kb_sync_tx(uuid,boolean,text,text);
DROP FUNCTION IF EXISTS public.claim_pr6b_kb_sync_tx();
DROP INDEX IF EXISTS public.uq_ce_kb_publish_state_eval_action;
COMMIT;
