-- PROPOSED ONLY. Last rollback step, after status + dispatch functions are removed.
-- No evidence, lease, session, conversation, message or safety registry is deleted.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.upstream_call_log IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF to_regprocedure('public.c3_uat_execution_status(uuid,text,uuid)') IS NOT NULL OR to_regprocedure('public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer)') IS NOT NULL OR to_regprocedure('public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer)') IS NOT NULL THEN RAISE EXCEPTION 'UAT_ROLLBACK_REQUIRES_PAUSE_AND_QUIESCENCE'; END IF;
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_run' AND request_payload->>'state' IS DISTINCT FROM 'paused') OR EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'state'='reserved') THEN RAISE EXCEPTION 'UAT_ROLLBACK_REQUIRES_PAUSE_AND_QUIESCENCE'; END IF;
 IF (SELECT md5(prosrc)FROM pg_proc WHERE oid='public.c3_uat_lease_authority(uuid,text,jsonb,uuid)'::regprocedure)IS DISTINCT FROM 'dd8b296177cea0d530b572eb2dddc4f5' THEN RAISE EXCEPTION 'UAT_ROLLBACK_OBJECT_DRIFT'; END IF;
END $$;
DROP FUNCTION public.c3_uat_lease_authority(uuid,text,jsonb,uuid);
COMMIT;
