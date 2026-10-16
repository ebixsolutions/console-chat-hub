-- PROPOSED ONLY. Remove only exact temporary dispatch functions/policies.
-- Pause and quiesce the authorized lease first; retain all usage receipts.
BEGIN;
SELECT pg_advisory_xact_lock(20261006,3520);
LOCK TABLE public.upstream_call_log IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer)'::regprocedure) IS DISTINCT FROM 'fa4daedb56e1ca51c11fd34979e17806' OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer)'::regprocedure) IS DISTINCT FROM '9a1b4079ca1914c128cd7ce44cbf28ff' THEN RAISE EXCEPTION 'UAT_ROLLBACK_OBJECT_DRIFT'; END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_run' AND request_payload->>'state' IS DISTINCT FROM 'paused') OR EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'state'='reserved') THEN RAISE EXCEPTION 'UAT_ROLLBACK_REQUIRES_PAUSE_AND_QUIESCENCE'; END IF;
END $$;
DROP FUNCTION public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer);
DROP FUNCTION public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer);
-- Keep the three restrictive guards while any protected receipt/evidence remains.
-- They do not affect ordinary, non-UAT log records. No history/usage/audit is deleted.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind' LIKE 'c3_uat_%') THEN
 DROP POLICY c3_uat_log_insert_guard ON public.upstream_call_log;
 DROP POLICY c3_uat_log_update_guard ON public.upstream_call_log;
 DROP POLICY c3_uat_log_delete_guard ON public.upstream_call_log;
 END IF;
END $$;
COMMIT;
