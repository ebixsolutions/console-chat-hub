-- NONPRODUCTION ONLY. Restore the previous endpoint source before removing this overload.
DROP FUNCTION IF EXISTS public.agent_send_reply_tx(uuid,uuid,text,text,uuid);
