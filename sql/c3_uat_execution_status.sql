-- PROPOSED ONLY. Apply after exact Director authorization and the existing
-- c3_temporary_uat_execution.sql dependency package. No lease/data writes.
BEGIN;
CREATE FUNCTION public.c3_uat_execution_status(p_run_id uuid,p_revision text,p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v jsonb;
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'UAT_ROLE_DENIED' USING ERRCODE='42501'; END IF;
 IF p_company_id IS DISTINCT FROM '4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid OR p_revision IS DISTINCT FROM 'c3-3322877-bounded-uat-r2' OR p_run_id IS NULL THEN RETURN jsonb_build_object('ready',false,'code','UAT_SOURCE_OR_RUN_DENIED'); END IF;
 IF to_regprocedure('public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer)') IS NULL OR to_regprocedure('public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer)') IS NULL THEN RETURN jsonb_build_object('ready',false,'code','UAT_DEPENDENCY_MISSING'); END IF;
 SELECT request_payload INTO v FROM public.upstream_call_log WHERE id=p_run_id AND company_id=p_company_id AND request_payload->>'kind'='c3_uat_run';
 IF v IS NULL THEN RETURN jsonb_build_object('ready',false,'code','UAT_RUN_MISSING'); END IF;
 IF NOT(v ?& ARRAY['revision','state','expires','issued_at','allowed_conversations']) OR EXISTS(SELECT 1 FROM jsonb_each(v) e WHERE e.value='null'::jsonb) THEN RETURN jsonb_build_object('ready',false,'code','UAT_POLICY_INCOMPLETE'); END IF;
 IF v->>'revision' IS DISTINCT FROM p_revision OR v->>'state' IS DISTINCT FROM 'active' OR (v->>'expires')::timestamptz<=statement_timestamp() OR (v->>'issued_at')::timestamptz>statement_timestamp() OR (v->>'expires')::timestamptz>(v->>'issued_at')::timestamptz+interval '7 days' OR jsonb_typeof(v->'allowed_conversations') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'allowed_conversations')=0 THEN RETURN jsonb_build_object('ready',false,'code','UAT_AUTHORIZATION_DENIED'); END IF;
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'run_id'=p_run_id::text AND request_payload->>'state' IN ('reserved','unknown')) THEN RETURN jsonb_build_object('ready',false,'code','UAT_PENDING_OBSERVATION'); END IF;
 RETURN jsonb_build_object('ready',true,'remote_ready',v->>'kb_bounds_verified'='true' AND coalesce(v->>'kb_bound_receipt_sha256','') ~ '^[a-f0-9]{64}$','allowed_conversations',v->'allowed_conversations');
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN jsonb_build_object('ready',false,'code','UAT_POLICY_INCOMPLETE');
END $$;
REVOKE ALL ON FUNCTION public.c3_uat_execution_status(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.c3_uat_execution_status(uuid,text,uuid) TO service_role;
COMMIT;
