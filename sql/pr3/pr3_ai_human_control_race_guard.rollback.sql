BEGIN;
DROP FUNCTION IF EXISTS public.commit_ai_reply_tx(uuid,uuid,text,jsonb);
DROP FUNCTION IF EXISTS public.begin_ai_reply_tx(uuid,uuid);
COMMIT;
