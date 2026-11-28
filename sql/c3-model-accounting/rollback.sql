-- Pause first; retain every durable receipt and counter. Never erase consumed usage.
BEGIN;
UPDATE c3_model_accounting.run SET state='paused' WHERE id='a0a8c36e-42b5-4d9f-bbee-095ddc731520' AND state<>'closed';
REVOKE EXECUTE ON FUNCTION public.c3_reserve_model_attempt(uuid,uuid,text,text,text,text,text,uuid) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.c3_finalize_model_attempt(uuid,uuid,text,text,integer) FROM service_role;
COMMIT;
-- Restore captured pre-cutover Edge payloads only after exact after-state guards.
-- This intentionally retains the isolated accounting schema for immutable spend evidence.
