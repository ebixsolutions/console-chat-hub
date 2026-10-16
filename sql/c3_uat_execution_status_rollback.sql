-- PROPOSED ONLY. No log receipts or lease records are removed.
BEGIN;
SELECT pg_advisory_xact_lock(20261006,3520);
LOCK TABLE public.upstream_call_log IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_run' AND request_payload->>'state' IS DISTINCT FROM 'paused') OR EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'state'='reserved') THEN RAISE EXCEPTION 'UAT_ROLLBACK_REQUIRES_PAUSE_AND_QUIESCENCE'; END IF;
END $$;
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_execution_status(uuid,text,uuid)'::regprocedure) IS DISTINCT FROM 'c3a84c62e08d327703644943d4292576' THEN RAISE EXCEPTION 'UAT_STATUS_ROLLBACK_OBJECT_DRIFT'; END IF;
END $$;
DROP FUNCTION public.c3_uat_execution_status(uuid,text,uuid);
COMMIT;
