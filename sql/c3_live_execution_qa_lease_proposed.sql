-- PROPOSED ONLY. NOT AUTHORIZED for Production execution.
-- Supply c3.qa_company_id, actor_id, run_id, conversation_1, conversation_2,
-- source_head, source_tree, authorization_sha256 on the same SQL session.
-- One explicit Tenant, no manufactured quota/history evidence or message sends.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$
DECLARE company uuid:=nullif(current_setting('c3.qa_company_id',true),'')::uuid;
 actor uuid:=nullif(current_setting('c3.qa_actor_id',true),'')::uuid;
 run uuid:=nullif(current_setting('c3.qa_run_id',true),'')::uuid;
 ticket1 uuid:=nullif(current_setting('c3.qa_conversation_1',true),'')::uuid;
 ticket2 uuid:=nullif(current_setting('c3.qa_conversation_2',true),'')::uuid;
 issued timestamptz:=clock_timestamp(); channel uuid; revision text; scope text; evidence text; lease jsonb; item uuid; session uuid;
BEGIN
 IF company IS NULL OR actor IS NULL OR run IS NULL OR ticket1 IS NULL OR ticket2 IS NULL OR ticket1=ticket2 THEN RAISE EXCEPTION 'UAT_POLICY_INCOMPLETE'; END IF;
 PERFORM pg_advisory_xact_lock(20261006,hashtext(company::text));
 channel:=CASE company WHEN '4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid THEN '0405282f-77dc-47cf-8074-99dd3dc6c393'::uuid WHEN '3d6e17b5-ec79-4f75-aa7f-eaa824ff8493'::uuid THEN 'b0000000-0000-0000-0000-000000000001'::uuid END;
 revision:=CASE WHEN company='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid THEN 'c3-3322877-bounded-uat-r2' ELSE 'c3-frankie-tenant-bounded-demo-v1' END;
 scope:=CASE WHEN company='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid THEN 'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5/stage-A/3520' ELSE 'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5/frankie/model-attempt' END;
 SELECT request_payload->>'evidence_sha256' INTO evidence FROM public.upstream_call_log WHERE company_id=company AND request_payload->>'kind'='c3_uat_quota';
 IF evidence IS NULL THEN RAISE EXCEPTION 'UAT_HISTORY_EVIDENCE_REQUIRED'; END IF;
 lease:=jsonb_build_object('kind','c3_uat_run','revision',revision,'actor_id',actor,'channel_id',channel,
 'source_head',current_setting('c3.qa_source_head',true),'source_tree',current_setting('c3.qa_source_tree',true),'authorization_sha256',current_setting('c3.qa_authorization_sha256',true),
 'quota_scope',scope,'quota_evidence_sha256',evidence,'state','active','issued_at',issued,'expires',issued+interval '45 minutes',
 'allowed_conversations',jsonb_build_array(ticket1,ticket2),'allowed_purposes',jsonb_build_array('generation','assist'),
 'allowed_operation_prefixes',jsonb_build_array('generate-reply-','commerce-semantic-interpreter:'),'count_tokens_limit',6,
 'conversation_limit',2,'visitor_limit',4,'attempt_limit',6,'budget_microusd',200000,'batch_size',2,'batch_visitor_limit',4,'per_request_attempt_limit',6,'stage','A','kb_bounds_verified',false);
 IF NOT public.c3_uat_lease_authority(company,revision,lease) THEN RAISE EXCEPTION 'UAT_AUTHORIZATION_DENIED'; END IF;
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE id=run) OR EXISTS(SELECT 1 FROM public.conversations WHERE id IN(ticket1,ticket2)) THEN RAISE EXCEPTION 'UAT_FIXTURE_ALREADY_EXISTS'; END IF;
 INSERT INTO public.upstream_call_log(id,company_id,upstream_service,request_payload,response_status) VALUES(run,company,'c3_temp_uat',lease,0);
 FOREACH item IN ARRAY ARRAY[ticket1,ticket2] LOOP
  session:=gen_random_uuid();
  INSERT INTO public.visitor_session(id,session_token,visitor_fingerprint,visitor_metadata,last_seen_at,channel_config_id)
  VALUES(session,'preview-test.'||gen_random_uuid()::text||'.'||replace(gen_random_uuid()::text,'-',''),'widget-live-test:'||actor::text,
   jsonb_build_object('source','c3_uat_widget','test_mode',true,'owner_user_id',actor,'exclude_training',true,'scope_mode','canonical'),clock_timestamp(),channel);
  INSERT INTO public.conversations(id,visitor_session_id,channel_config_id,company_id,status,metadata_source,created_at)
  VALUES(item,session,channel,company,'open',jsonb_build_object('source','c3_uat_widget','synthetic',true,'owner_user_id',actor,'exclude_training',true,'scope_mode','canonical'),clock_timestamp());
 END LOOP;
 -- The original order checked admission BEFORE ownership-bound tickets existed.
 PERFORM set_config('role','service_role',true);
 lease:=public.c3_uat_execution_status(run,revision,company);
 IF lease->>'ready' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION '%',coalesce(lease->>'code','UAT_ADMISSION_DENIED'); END IF;
END $$;
RESET ROLE;
COMMIT;
