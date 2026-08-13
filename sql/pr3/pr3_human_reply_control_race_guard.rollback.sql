-- PR-3 human reply control race guard rollback.
-- Does not delete historical messages already sent through the RPC.

BEGIN;

DROP FUNCTION IF EXISTS public.agent_send_reply_tx(uuid,uuid,text,text);

COMMIT;
