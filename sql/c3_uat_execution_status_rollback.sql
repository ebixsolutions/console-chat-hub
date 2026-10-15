-- PROPOSED ONLY. No log receipts or lease records are removed.
BEGIN;
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_execution_status(uuid,text,uuid)'::regprocedure) IS DISTINCT FROM 'd10ef5551f9060b9f48f3899931bb279' THEN RAISE EXCEPTION 'UAT_STATUS_ROLLBACK_OBJECT_DRIFT'; END IF;
END $$;
DROP FUNCTION public.c3_uat_execution_status(uuid,text,uuid);
COMMIT;
