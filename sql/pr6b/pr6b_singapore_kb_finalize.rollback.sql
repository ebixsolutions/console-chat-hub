BEGIN;
DROP FUNCTION IF EXISTS public.finish_pr6b_kb_finalize_tx(uuid,text,text);
DROP FUNCTION IF EXISTS public.claim_pr6b_kb_finalize_tx();
COMMIT;
