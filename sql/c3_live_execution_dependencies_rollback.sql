-- PROPOSED ONLY. Remove only exact temporary dispatch functions/policies.
-- Pause and quiesce the authorized lease first; retain all usage receipts.
BEGIN;
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer)'::regprocedure) IS DISTINCT FROM '6af46dac5e62ae911038275ce9c35eea' OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer)'::regprocedure) IS DISTINCT FROM 'b1134e9c478b002e4606b6c4cf63c1a9' THEN RAISE EXCEPTION 'UAT_ROLLBACK_OBJECT_DRIFT'; END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_run' AND request_payload->>'state'<>'paused') OR EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'state'='reserved') THEN RAISE EXCEPTION 'UAT_ROLLBACK_REQUIRES_PAUSE_AND_QUIESCENCE'; END IF;
END $$;
DROP FUNCTION public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer);
DROP FUNCTION public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer);
DROP POLICY c3_uat_log_insert_guard ON public.upstream_call_log;
DROP POLICY c3_uat_log_update_guard ON public.upstream_call_log;
DROP POLICY c3_uat_log_delete_guard ON public.upstream_call_log;
COMMIT;
