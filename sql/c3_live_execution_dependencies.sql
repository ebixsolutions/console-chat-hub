-- PROPOSED ONLY. Existing upstream_call_log persistence; no permanent accounting schema/endpoint.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='upstream_call_log' AND c.relrowsecurity) THEN RAISE EXCEPTION 'UAT_LOG_RLS_REQUIRED'; END IF;
 IF to_regprocedure('public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer)') IS NOT NULL THEN RAISE EXCEPTION 'UAT_OBJECT_ALREADY_EXISTS'; END IF;
END $$;
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.upstream_call_log'::regclass AND polname IN ('c3_uat_log_insert_guard','c3_uat_log_update_guard','c3_uat_log_delete_guard')) THEN
  IF (SELECT count(*) FROM pg_policy WHERE polrelid='public.upstream_call_log'::regclass AND polname IN ('c3_uat_log_insert_guard','c3_uat_log_update_guard','c3_uat_log_delete_guard') AND NOT polpermissive AND polroles=ARRAY['anon'::regrole::oid,'authenticated'::regrole::oid])<>3
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.upstream_call_log'::regclass AND polname IN ('c3_uat_log_insert_guard','c3_uat_log_update_guard','c3_uat_log_delete_guard') AND (
   CASE polname WHEN 'c3_uat_log_insert_guard' THEN polcmd<>'a' OR polqual IS NOT NULL OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM '(COALESCE((request_payload ->> ''kind''::text), ''''::text) !~~ ''c3_uat_%''::text)'
   WHEN 'c3_uat_log_update_guard' THEN polcmd<>'w' OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '(COALESCE((request_payload ->> ''kind''::text), ''''::text) !~~ ''c3_uat_%''::text)' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM pg_get_expr(polqual,polrelid)
   ELSE polcmd<>'d' OR polwithcheck IS NOT NULL OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '(COALESCE((request_payload ->> ''kind''::text), ''''::text) !~~ ''c3_uat_%''::text)' END))
  THEN RAISE EXCEPTION 'UAT_POLICY_DRIFT'; END IF;
 ELSE
CREATE POLICY c3_uat_log_insert_guard ON public.upstream_call_log AS RESTRICTIVE FOR INSERT TO anon,authenticated WITH CHECK (coalesce(request_payload->>'kind','') NOT LIKE 'c3_uat_%');
CREATE POLICY c3_uat_log_update_guard ON public.upstream_call_log AS RESTRICTIVE FOR UPDATE TO anon,authenticated USING (coalesce(request_payload->>'kind','') NOT LIKE 'c3_uat_%') WITH CHECK (coalesce(request_payload->>'kind','') NOT LIKE 'c3_uat_%');
CREATE POLICY c3_uat_log_delete_guard ON public.upstream_call_log AS RESTRICTIVE FOR DELETE TO anon,authenticated USING (coalesce(request_payload->>'kind','') NOT LIKE 'c3_uat_%');
 END IF;
END $guard$;
CREATE FUNCTION public.c3_uat_reserve_dispatch(p_run_id uuid,p_revision text,p_company_id uuid,p_conversation_id uuid,p_operation text,p_slot text,p_identity text,p_request_hash text,p_provider text,p_purpose text,p_model text,p_attempt integer,p_input_ceiling integer,p_output_ceiling integer,p_cost_microusd integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE l public.upstream_call_log%ROWTYPE; prior public.upstream_call_log%ROWTYPE; v jsonb; anchor uuid; attempts bigint; spend bigint; n bigint; per_request bigint; gate jsonb; unit text;
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'UAT_ROLE_DENIED' USING ERRCODE='42501'; END IF;
 IF p_company_id IS DISTINCT FROM '4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid OR p_revision IS DISTINCT FROM 'c3-3322877-bounded-uat-r2' OR p_run_id IS NULL OR p_conversation_id IS NULL OR p_identity IS NULL OR p_identity !~ '^[a-f0-9]{64}$' OR p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$' OR p_attempt IS NULL OR p_attempt NOT BETWEEN 1 AND 3 OR p_cost_microusd IS NULL OR p_cost_microusd NOT BETWEEN 1 AND 100000 OR p_input_ceiling IS NULL OR p_input_ceiling NOT BETWEEN 1 AND 20000 OR p_output_ceiling IS NULL OR p_output_ceiling NOT BETWEEN 0 AND 9216 OR p_operation IS NULL OR length(p_operation)>240 OR p_slot IS NULL OR length(p_slot)>120 THEN RAISE EXCEPTION 'UAT_SCOPE_DENIED'; END IF;
 IF p_provider='vertex' THEN
  IF p_model IS DISTINCT FROM 'gemini-2.5-flash' OR p_purpose IS NULL OR p_purpose NOT IN ('generation','evaluation','assist') OR p_cost_microusd<ceil(p_input_ceiling*0.30+p_output_ceiling*2.50) THEN RAISE EXCEPTION 'UAT_PROVIDER_COST_DENIED'; END IF;
 ELSIF p_provider='singapore-kb' THEN
  IF p_model IS DISTINCT FROM 'gemini-embedding-001' OR p_purpose IS DISTINCT FROM 'kb_embedding' OR p_input_ceiling>2048 OR p_output_ceiling<>0 OR p_cost_microusd<>100000 OR p_operation NOT LIKE 'kb:%' THEN RAISE EXCEPTION 'UAT_EMBEDDING_DENIED'; END IF;
 ELSE RAISE EXCEPTION 'UAT_PROVIDER_DENIED'; END IF;
 -- A company-bound logical-quota lock precedes all run locks, across actual connections.
 -- Reject snapshot isolation: a stale transaction snapshot cannot prove a current balance.
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'UAT_ISOLATION_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(20261006,3520);
 unit:=CASE WHEN p_slot LIKE 'countTokens:%' THEN 'countTokens' ELSE 'model_attempt' END;

 SELECT count(*) INTO n FROM public.upstream_call_log WHERE id=p_run_id AND company_id=p_company_id AND request_payload->>'kind'='c3_uat_run';
 IF n<>1 THEN RAISE EXCEPTION 'UAT_RUN_MISSING'; END IF;
 SELECT * INTO l FROM public.upstream_call_log WHERE id=p_run_id FOR UPDATE;
 v=l.request_payload;
 gate:=public.c3_uat_execution_status(p_run_id,p_revision,p_company_id);
 IF gate->>'ready' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION '%',coalesce(gate->>'code','UAT_ADMISSION_DENIED'); END IF;
 IF p_run_id='71657f35-88c4-4a73-a2e7-9abde643ad74'::uuid AND (
 (v->>'expires')::timestamptz>(v->>'issued_at')::timestamptz+interval '45 minutes'
 OR (v->>'attempt_limit')::int>6 OR (v->>'count_tokens_limit')::int IS DISTINCT FROM 6
 OR (v->>'budget_microusd')::bigint>200000 OR (v->>'conversation_limit')::int>2 OR (v->>'visitor_limit')::int>4
 OR p_provider<>'vertex' OR v->>'kb_bounds_verified' IS DISTINCT FROM 'false') THEN RAISE EXCEPTION 'UAT_CONTROLLED_ENVELOPE_DENIED'; END IF;
 IF coalesce(v->>'count_tokens_limit','') !~ '^[1-6]$' THEN RAISE EXCEPTION 'UAT_COUNT_TOKENS_LIMIT_REQUIRED'; END IF;
 IF unit='countTokens' AND (p_provider<>'vertex' OR p_output_ceiling<>0) THEN RAISE EXCEPTION 'UAT_COUNT_TOKENS_SCOPE_DENIED'; END IF;

 IF NOT(v ?& ARRAY['revision','state','expires','issued_at','allowed_conversations','allowed_purposes','allowed_operation_prefixes','conversation_limit','visitor_limit','attempt_limit','budget_microusd','batch_size','batch_visitor_limit','per_request_attempt_limit','stage']) OR EXISTS(SELECT 1 FROM jsonb_each(v) e WHERE e.value='null'::jsonb) OR jsonb_typeof(v->'allowed_conversations') IS DISTINCT FROM 'array' OR jsonb_typeof(v->'allowed_purposes') IS DISTINCT FROM 'array' OR jsonb_typeof(v->'allowed_operation_prefixes') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v->'allowed_operation_prefixes') t(prefix) WHERE prefix='' OR prefix LIKE '%\%%' ESCAPE '\' OR prefix LIKE '%\_%' ESCAPE '\') THEN RAISE EXCEPTION 'UAT_POLICY_INCOMPLETE'; END IF;
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'run_id'=p_run_id::text AND request_payload->>'state'='reserved') THEN RAISE EXCEPTION 'UAT_PENDING_OBSERVATION'; END IF;
 IF v->>'revision' IS DISTINCT FROM p_revision OR v->>'state' IS DISTINCT FROM 'active' OR (v->>'expires')::timestamptz<=clock_timestamp() OR (v->>'issued_at')::timestamptz>clock_timestamp() OR (v->>'expires')::timestamptz>(v->>'issued_at')::timestamptz+interval '7 days' OR NOT (v->'allowed_conversations' ? p_conversation_id::text) OR NOT(v->'allowed_purposes' ? p_purpose) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v->'allowed_operation_prefixes') t(prefix) WHERE p_operation LIKE prefix||'%') THEN RAISE EXCEPTION 'UAT_AUTHORIZATION_DENIED'; END IF;
 IF p_provider='singapore-kb' AND (v->>'kb_bounds_verified' IS DISTINCT FROM 'true' OR v->>'kb_bound_receipt_sha256' !~ '^[a-f0-9]{64}$' OR v->>'kb_bound_receipt_sha256' IS NULL) THEN RAISE EXCEPTION 'UAT_REMOTE_BOUND_UNVERIFIED'; END IF;
 IF jsonb_array_length(v->'allowed_conversations')>(v->>'conversation_limit')::int OR (v->>'conversation_limit')::int NOT BETWEEN 1 AND 250 OR (v->>'visitor_limit')::int NOT BETWEEN 1 AND 800 OR (v->>'attempt_limit')::int NOT BETWEEN 1 AND 10000 OR (v->>'budget_microusd')::bigint NOT BETWEEN 1 AND 300000000 OR (v->>'batch_size')::int NOT BETWEEN 1 AND 50 OR (v->>'batch_visitor_limit')::int>(v->>'visitor_limit')::int OR (v->>'per_request_attempt_limit')::int NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'UAT_ENVELOPE_DENIED'; END IF;
 IF (v->>'stage')='calibration' AND ((v->>'batch_size')::int>20 OR (v->>'visitor_limit')::int>20) THEN RAISE EXCEPTION 'UAT_CALIBRATION_LIMIT'; END IF;
 IF (v->>'stage')='A' AND ((v->>'conversation_limit')::int>116 OR (v->>'visitor_limit')::int>301 OR (v->>'attempt_limit')::int>3520) THEN RAISE EXCEPTION 'UAT_STAGE_A_LIMIT'; END IF;
 IF v->>'stage' NOT IN ('calibration','A','B') OR v->>'stage' IS NULL THEN RAISE EXCEPTION 'UAT_STAGE_DENIED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.conversations WHERE id=p_conversation_id AND company_id=p_company_id AND metadata_source->>'exclude_training'='true' AND created_at>=(v->>'issued_at')::timestamptz) THEN RAISE EXCEPTION 'UAT_CONVERSATION_DENIED'; END IF;
 SELECT id INTO anchor FROM public.messages WHERE conversation_id=p_conversation_id AND role='visitor' AND created_at>=(v->>'issued_at')::timestamptz ORDER BY created_at DESC,id DESC LIMIT 1;
 IF anchor IS NULL THEN RAISE EXCEPTION 'UAT_REQUEST_ANCHOR_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'run_id'=p_run_id::text AND NOT(v->'allowed_conversations' ? conversation_id::text)) THEN RAISE EXCEPTION 'UAT_MEMBERSHIP_HISTORY_DRIFT'; END IF;
 SELECT count(*) INTO n FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id WHERE c.company_id=p_company_id AND v->'allowed_conversations' ? c.id::text AND m.role='visitor' AND m.created_at>=(v->>'issued_at')::timestamptz;
 IF n>(v->>'visitor_limit')::int OR n>(v->>'batch_visitor_limit')::int THEN RAISE EXCEPTION 'UAT_VISITOR_BATCH_LIMIT'; END IF;
 SELECT * INTO prior FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'identity'=p_identity;
 IF FOUND THEN
  IF prior.request_payload->>'run_id' IS DISTINCT FROM p_run_id::text OR prior.conversation_id IS DISTINCT FROM p_conversation_id OR prior.request_payload->>'request_hash' IS DISTINCT FROM p_request_hash THEN RAISE EXCEPTION 'UAT_REPLAY_CONFLICT'; END IF;
  RETURN jsonb_build_object('dispatch',false,'run_id',p_run_id,'identity',p_identity,'state',prior.request_payload->>'state');
 END IF;
 SELECT count(*) FILTER(WHERE request_payload->>'unit'=unit),coalesce(sum((request_payload->>'cost_microusd')::bigint),0),count(*) FILTER(WHERE request_payload->>'request_anchor'=anchor::text) INTO attempts,spend,per_request FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'run_id'=p_run_id::text;
 IF attempts+1>(CASE WHEN unit='countTokens' THEN (v->>'count_tokens_limit')::int ELSE (v->>'attempt_limit')::int END) OR spend+p_cost_microusd>(v->>'budget_microusd')::bigint OR per_request+1>(v->>'per_request_attempt_limit')::int THEN RAISE EXCEPTION 'UAT_ATTEMPT_OR_BUDGET_EXPOSURE_LIMIT'; END IF;
 INSERT INTO public.upstream_call_log(company_id,conversation_id,upstream_service,request_payload,response_status) VALUES(p_company_id,p_conversation_id,'c3_temp_uat',jsonb_build_object('kind','c3_uat_dispatch','quota_scope',gate->>'quota_scope','quota_evidence_sha256',gate->>'quota_evidence_sha256','unit',unit,'run_id',p_run_id,'revision',p_revision,'identity',p_identity,'request_hash',p_request_hash,'request_anchor',anchor,'operation',p_operation,'slot',p_slot,'provider',p_provider,'purpose',p_purpose,'model',p_model,'attempt',p_attempt,'input_ceiling',p_input_ceiling,'output_ceiling',p_output_ceiling,'cost_microusd',p_cost_microusd,'state','reserved'),0);
 RETURN jsonb_build_object('dispatch',true,'run_id',p_run_id,'identity',p_identity,'state','reserved','expires_epoch',extract(epoch from (v->>'expires')::timestamptz));
END $$;
CREATE FUNCTION public.c3_uat_finalize_dispatch(p_run_id uuid,p_company_id uuid,p_identity text,p_state text,p_status integer,p_input integer,p_output integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE l public.upstream_call_log%ROWTYPE; a public.upstream_call_log%ROWTYPE;
BEGIN
 IF current_setting('role',true)<>'service_role' OR p_company_id IS DISTINCT FROM '4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid THEN RAISE EXCEPTION 'UAT_FINALIZER_ROLE_DENIED'; END IF;
 IF p_state IS NULL OR p_state NOT IN ('response','remote_bound','unknown') OR p_status IS NULL OR p_status NOT BETWEEN 0 AND 599 THEN RAISE EXCEPTION 'UAT_FINALIZATION_INVALID'; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'UAT_ISOLATION_DENIED'; END IF;
 PERFORM pg_advisory_xact_lock(20261006,3520);
 SELECT * INTO l FROM public.upstream_call_log WHERE id=p_run_id AND company_id=p_company_id AND request_payload->>'kind'='c3_uat_run' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'UAT_RUN_MISSING'; END IF;
 SELECT * INTO a FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'run_id'=p_run_id::text AND request_payload->>'identity'=p_identity FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'UAT_RECEIPT_MISSING'; END IF;
 IF a.request_payload->>'state'<>'reserved' THEN
  IF a.request_payload->>'state' IS DISTINCT FROM p_state OR a.response_status IS DISTINCT FROM p_status OR (a.request_payload->>'input_tokens')::int IS DISTINCT FROM p_input OR (a.request_payload->>'output_tokens')::int IS DISTINCT FROM p_output THEN RAISE EXCEPTION 'UAT_FINALIZATION_CONFLICT'; END IF;
  RETURN jsonb_build_object('state',p_state);
 END IF;
 IF p_state='response' AND (p_input IS NULL OR p_output IS NULL OR p_input<0 OR p_output<0 OR p_input>(a.request_payload->>'input_ceiling')::int OR p_output>(a.request_payload->>'output_ceiling')::int) THEN RAISE EXCEPTION 'UAT_OBSERVATION_INVALID'; END IF;
 IF p_state='remote_bound' AND (a.request_payload->>'provider'<>'singapore-kb' OR p_input IS NOT NULL OR p_output IS NOT NULL) THEN RAISE EXCEPTION 'UAT_REMOTE_OBSERVATION_INVALID'; END IF;
 IF p_state='unknown' THEN UPDATE public.upstream_call_log SET request_payload=jsonb_set(request_payload,'{state}','"paused"'::jsonb) WHERE id=l.id; END IF;
 UPDATE public.upstream_call_log SET response_status=p_status,request_payload=request_payload||jsonb_build_object('state',p_state,'input_tokens',p_input,'output_tokens',p_output,'finalized_at',clock_timestamp()) WHERE id=a.id;
 RETURN jsonb_build_object('state',p_state);
END $$;
REVOKE ALL ON FUNCTION public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer),public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer) TO service_role;
COMMIT;
