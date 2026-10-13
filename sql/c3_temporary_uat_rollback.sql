-- Execute ONLY after exact target object/config hash guards and quiescence. Retain all log receipts.
BEGIN;
DO $$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer)'::regprocedure) IS DISTINCT FROM 'f5eee04f2a718bc39c23aae0fb9b7a2a' OR (SELECT NOT prosecdef FROM pg_proc WHERE oid='public.ce_conversation_evaluable_v1(uuid)'::regprocedure) THEN RAISE EXCEPTION 'UAT_ROLLBACK_OBJECT_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer)'::regprocedure) IS DISTINCT FROM 'b1134e9c478b002e4606b6c4cf63c1a9' OR (SELECT NOT prosecdef FROM pg_proc WHERE oid='public.ce_conversation_evaluable_v1(uuid)'::regprocedure) THEN RAISE EXCEPTION 'UAT_ROLLBACK_OBJECT_DRIFT'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ce_conversation_evaluable_v1(uuid)'::regprocedure) IS DISTINCT FROM '65835cd74aff458cb68855c1ef6a7475' OR (SELECT NOT prosecdef FROM pg_proc WHERE oid='public.ce_conversation_evaluable_v1(uuid)'::regprocedure) THEN RAISE EXCEPTION 'UAT_ROLLBACK_OBJECT_DRIFT'; END IF;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_run' AND request_payload->>'state'<>'paused') OR EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'state'='reserved') THEN RAISE EXCEPTION 'UAT_ROLLBACK_REQUIRES_PAUSE_AND_QUIESCENCE'; END IF;
END $$;
DROP FUNCTION public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer);
DROP FUNCTION public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer);
DROP POLICY c3_uat_log_insert_guard ON public.upstream_call_log;
DROP POLICY c3_uat_log_update_guard ON public.upstream_call_log;
DROP POLICY c3_uat_log_delete_guard ON public.upstream_call_log;
CREATE OR REPLACE FUNCTION public.ce_conversation_evaluable_v1(p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT CASE WHEN public.c3_uat_learning_excluded(p_conversation_id) OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = p_conversation_id AND COALESCE(c.metadata_source->>'source','') = 'widget_live_test' AND COALESCE((c.metadata_source->>'widget_live_test')::boolean,false) = true AND COALESCE((c.metadata_source->>'exclude_training')::boolean,false) = true) THEN false ELSE (count(*) FILTER (WHERE NOT COALESCE(m.is_recalled,false) AND lower(m.role) IN ('visitor','customer','user')) > 0 AND count(*) FILTER (WHERE NOT COALESCE(m.is_recalled,false) AND lower(m.role) IN ('assistant','ai','bot')) > 0) END FROM public.messages m WHERE m.conversation_id = p_conversation_id AND COALESCE(m.content,'') IS DISTINCT FROM '__THINKING__'
$function$;
COMMIT;
