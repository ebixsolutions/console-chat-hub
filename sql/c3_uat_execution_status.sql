-- PROPOSED ONLY. Apply after exact Director authorization and the existing
-- c3_temporary_uat_execution.sql dependency package. No lease/data writes.
BEGIN;
DO $dependency$ BEGIN
 IF to_regprocedure('public.c3_uat_lease_authority(uuid,text,jsonb,uuid)') IS NULL THEN RAISE EXCEPTION 'UAT_DEPENDENCY_MISSING'; END IF;
END $dependency$;

CREATE FUNCTION public.c3_uat_execution_status(p_run_id uuid,p_revision text,p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v jsonb; q jsonb; e jsonb; item jsonb; charged bigint:=0; durable bigint; quota_rows bigint;
 scope text; quota_limit bigint; exposure bigint; total_conversations bigint; total_visitors bigint; total_assistants bigint;
 ids text[]:=ARRAY[]::text[]; missing text;
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'UAT_ROLE_DENIED' USING ERRCODE='42501'; END IF;
 IF p_run_id IS NULL OR p_company_id IS NULL OR p_revision IS NULL OR NOT ((p_company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid AND p_revision='c3-3322877-bounded-uat-r2') OR (p_company_id='3d6e17b5-ec79-4f75-aa7f-eaa824ff8493'::uuid AND p_revision='c3-frankie-tenant-bounded-demo-v1')) THEN RETURN jsonb_build_object('ready',false,'code','UAT_SOURCE_OR_RUN_DENIED'); END IF;
 IF to_regprocedure('public.c3_uat_reserve_dispatch(uuid,text,uuid,uuid,text,text,text,text,text,text,text,integer,integer,integer,integer)') IS NULL OR to_regprocedure('public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer)') IS NULL THEN RETURN jsonb_build_object('ready',false,'code','UAT_DEPENDENCY_MISSING'); END IF;
 SELECT request_payload INTO v FROM public.upstream_call_log WHERE id=p_run_id AND company_id=p_company_id AND request_payload->>'kind'='c3_uat_run';
 scope:=CASE WHEN p_company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid THEN 'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5/stage-A/3520' ELSE 'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5/frankie/model-attempt' END;
 IF v IS NULL THEN RETURN jsonb_build_object('ready',false,'code','UAT_RUN_MISSING'); END IF;
 IF NOT(v ?& ARRAY['revision','state','expires','issued_at','allowed_conversations']) OR EXISTS(SELECT 1 FROM jsonb_each(v) e WHERE e.value='null'::jsonb) THEN RETURN jsonb_build_object('ready',false,'code','UAT_POLICY_INCOMPLETE'); END IF;
 IF v->>'revision' IS DISTINCT FROM p_revision OR v->>'state' IS DISTINCT FROM 'active' OR (v->>'expires')::timestamptz<=clock_timestamp() OR (v->>'issued_at')::timestamptz>clock_timestamp() OR (v->>'expires')::timestamptz>(v->>'issued_at')::timestamptz+interval '7 days' OR jsonb_typeof(v->'allowed_conversations') IS DISTINCT FROM 'array' OR jsonb_array_length(v->'allowed_conversations')=0 THEN RETURN jsonb_build_object('ready',false,'code','UAT_AUTHORIZATION_DENIED'); END IF;
 IF NOT public.c3_uat_lease_authority(p_company_id,p_revision,v) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(v->'allowed_conversations') c(id) WHERE NOT public.c3_uat_lease_authority(p_company_id,p_revision,v,c.id::uuid)) THEN RETURN jsonb_build_object('ready',false,'code','UAT_AUTHORIZATION_DENIED'); END IF;
 -- Immutable, evidence-bound historical debit. This is NOT observed Provider usage.
 -- No evidence row is synthesized by these functions or by the proposed lease.
 SELECT count(*) INTO quota_rows FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_quota';
 IF quota_rows<>1 THEN RETURN jsonb_build_object('ready',false,'code','UAT_HISTORY_EVIDENCE_REQUIRED'); END IF;
 SELECT request_payload INTO q FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_quota';
 e=q->'evidence';
 IF q->>'scope' IS DISTINCT FROM scope OR v->>'quota_scope' IS DISTINCT FROM scope OR q->>'evidence_sha256' IS DISTINCT FROM v->>'quota_evidence_sha256'
 OR coalesce(q->>'evidence_sha256','') !~ '^[a-f0-9]{64}$'
 OR q->>'evidence_sha256' IS DISTINCT FROM encode(sha256(convert_to(e::text,'UTF8')),'hex')
 OR e->>'contract' IS DISTINCT FROM 'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5'
 OR e->>'company_id' IS DISTINCT FROM p_company_id::text OR e->>'scope' IS DISTINCT FROM scope
 OR e->>'authorization_sha256' IS DISTINCT FROM v->>'authorization_sha256' OR e->>'source_head' IS DISTINCT FROM v->>'source_head' OR e->>'source_tree' IS DISTINCT FROM v->>'source_tree'
 OR e->>'unit' IS DISTINCT FROM 'model_attempt' OR coalesce(e->>'limit','') !~ '^[1-9][0-9]{0,3}$' OR (e->>'limit')::int>3520 OR (p_company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid AND e->>'limit'<>'3520')
 OR coalesce(e->>'authorization_sha256','') !~ '^[a-f0-9]{64}$'
 OR coalesce(e->>'coverage_sha256','') !~ '^[a-f0-9]{64}$'
 OR e->>'period_start' IS NULL OR e->>'covered_through' IS NULL
 OR (e->>'period_start')::timestamptz>(e->>'covered_through')::timestamptz
 OR (e->>'covered_through')::timestamptz>(v->>'issued_at')::timestamptz
 OR jsonb_typeof(e->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'entries')=0
 THEN RETURN jsonb_build_object('ready',false,'code','UAT_HISTORY_EVIDENCE_INVALID'); END IF;
 quota_limit:=(e->>'limit')::bigint;
 IF NOT (e ?& ARRAY['budget_microusd','historical_cost_microusd','historical_conversations','historical_visitors','historical_assistants','conversation_limit','visitor_limit','assistant_limit']) OR EXISTS(SELECT 1 FROM jsonb_each_text(e) z(k,val) WHERE k IN ('budget_microusd','historical_cost_microusd','historical_conversations','historical_visitors','historical_assistants','conversation_limit','visitor_limit','assistant_limit') AND (val IS NULL OR val !~ '^[0-9]{1,12}$')) OR (e->>'budget_microusd')::bigint NOT BETWEEN 1 AND 300000000 OR (e->>'conversation_limit')::bigint NOT BETWEEN 1 AND 250 OR (e->>'visitor_limit')::bigint NOT BETWEEN 1 AND 800 OR (e->>'assistant_limit')::bigint NOT BETWEEN 1 AND 800 OR (p_company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid AND ((e->>'conversation_limit')::bigint>224 OR (e->>'visitor_limit')::bigint>480 OR (e->>'assistant_limit')::bigint>427)) THEN RETURN jsonb_build_object('ready',false,'code','UAT_HISTORY_EVIDENCE_INVALID'); END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(e->'entries') LOOP
  IF coalesce(item->>'id','')='' OR item->>'id'=ANY(ids) OR coalesce(item->>'units','') !~ '^[1-9][0-9]{0,3}$'
  OR (item->>'units')::int>3520 OR item->>'classification' IS NULL OR item->>'classification' NOT IN ('confirmed','uncertainty')
  OR coalesce(item->>'receipt_sha256','') !~ '^[a-f0-9]{64}$' OR item->>'unit' IS DISTINCT FROM 'model_attempt'
  OR item->>'scope' IS DISTINCT FROM scope OR jsonb_typeof(item->'request_ids') IS DISTINCT FROM 'array'
  OR jsonb_array_length(item->'request_ids')=0 THEN RETURN jsonb_build_object('ready',false,'code','UAT_HISTORY_EVIDENCE_INVALID'); END IF;
  ids:=array_append(ids,item->>'id');
  IF item->>'classification'='uncertainty' AND (
   item->'actual_usage' IS DISTINCT FROM 'null'::jsonb OR coalesce(item->>'call_chain_sha256','') !~ '^[a-f0-9]{64}$'
   OR NOT (item->'coverage' @> '["caller","pre-semantic","router-retries","fallback","verifier","async-sidecalls"]'::jsonb)
   OR item->>'overlap' IS NULL OR item->>'overlap' NOT IN ('disjoint-proved','conservative-double-reserve'))
  THEN RETURN jsonb_build_object('ready',false,'code','UAT_HISTORY_BOUND_UNPROVED'); END IF;
  -- Overlap without a reliable identity bridge is deliberately charged twice. No release path.
  charged:=charged+(item->>'units')::int;
 END LOOP;
 -- These exact missing historical operations cannot disappear from a replacement manifest.
 IF p_company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid THEN
 FOREACH missing IN ARRAY ARRAY[
 'commerce-semantic:83e12377-3e9f-435a-b3f3-32a9e7348edc','commerce-semantic:af02d94b-32bb-455d-ae91-030d7be729b2',
 'commerce-semantic:25b28f4e-462a-4f16-bc0e-c80f0e4576b0','commerce-semantic:47f004ca-4996-4a0e-a8df-ae622bd008ee',
 'commerce-semantic:10638698-3549-4d8d-a7e7-c76f276465d9','commerce-semantic:2f61d01e-0438-42c4-b739-5e64eb6ada85',
 'commerce-semantic:e2cce632-0681-409f-93a2-d274fff1bd79'] LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e->'entries') t(x) WHERE x->>'classification'='uncertainty' AND x->'request_ids' ? missing)
  THEN RETURN jsonb_build_object('ready',false,'code','UAT_HISTORY_BOUND_UNPROVED'); END IF;
 END LOOP;
 END IF;
 -- Every UAT reservation in this company belongs to the original quota. Untagged history
 -- cannot silently be excluded; finalized rows count once, not reservation + finalization.
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_dispatch' AND (
 request_payload->>'quota_scope' IS DISTINCT FROM scope OR request_payload->>'quota_evidence_sha256' IS DISTINCT FROM q->>'evidence_sha256'
 OR request_payload->>'unit' IS NULL OR request_payload->>'unit' NOT IN ('model_attempt','countTokens')
 OR request_payload->>'state' IS NULL OR request_payload->>'state' NOT IN ('reserved','response','remote_bound','unknown')))
 THEN RETURN jsonb_build_object('ready',false,'code','UAT_QUOTA_HISTORY_DRIFT'); END IF;
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'state' IN ('reserved','unknown'))
 THEN RETURN jsonb_build_object('ready',false,'code','UAT_PENDING_OBSERVATION'); END IF;
 SELECT count(*) INTO durable FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_dispatch' AND request_payload->>'unit'='model_attempt';
 IF charged+durable>=quota_limit THEN RETURN jsonb_build_object('ready',false,'code','UAT_CUMULATIVE_QUOTA_LIMIT','historical_debit',charged,'durable_debit',durable); END IF;
 SELECT coalesce(sum((request_payload->>'cost_microusd')::bigint),0) INTO exposure FROM public.upstream_call_log WHERE company_id=p_company_id AND request_payload->>'kind'='c3_uat_dispatch';
 exposure:=exposure+(e->>'historical_cost_microusd')::bigint;
 SELECT count(*) INTO total_conversations FROM public.conversations c WHERE c.company_id=p_company_id AND c.metadata_source->>'source'='c3_uat_widget' AND c.created_at>(e->>'covered_through')::timestamptz;
 SELECT count(*) FILTER(WHERE m.role='visitor'),count(*) FILTER(WHERE m.role='assistant' AND m.content<>'__THINKING__') INTO total_visitors,total_assistants FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id WHERE c.company_id=p_company_id AND c.metadata_source->>'source'='c3_uat_widget' AND m.created_at>(e->>'covered_through')::timestamptz;
 IF exposure>=(e->>'budget_microusd')::bigint OR total_conversations+(e->>'historical_conversations')::bigint>(e->>'conversation_limit')::bigint OR total_visitors+(e->>'historical_visitors')::bigint>(e->>'visitor_limit')::bigint OR total_assistants+(e->>'historical_assistants')::bigint>=(e->>'assistant_limit')::bigint THEN RETURN jsonb_build_object('ready',false,'code','UAT_CUMULATIVE_QUOTA_LIMIT'); END IF;
 RETURN jsonb_build_object('ready',true,'actor_id',v->>'actor_id','channel_id',v->>'channel_id','run_id',p_run_id,'revision',p_revision,'budget_remaining_microusd',(e->>'budget_microusd')::bigint-exposure,'quota_scope',scope,'quota_evidence_sha256',q->>'evidence_sha256','historical_debit',charged,'durable_debit',durable,'remaining',quota_limit-charged-durable,'remote_ready',v->>'kb_bounds_verified'='true' AND coalesce(v->>'kb_bound_receipt_sha256','') ~ '^[a-f0-9]{64}$','allowed_conversations',v->'allowed_conversations');
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range OR invalid_parameter_value THEN RETURN jsonb_build_object('ready',false,'code','UAT_POLICY_INCOMPLETE');
END $$;
REVOKE ALL ON FUNCTION public.c3_uat_execution_status(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.c3_uat_execution_status(uuid,text,uuid) TO service_role;
COMMIT;
