-- Task 3.3 rollback — remove the conversation resolution RPC.
-- Existing conversation/status/audit rows are preserved; this rollback only
-- removes the callable database function restored by PR30 closure.
BEGIN;
DROP FUNCTION IF EXISTS public.set_conversation_resolution_tx(uuid,uuid,uuid,uuid,text,text);
COMMIT;
