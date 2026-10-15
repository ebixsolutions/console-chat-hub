-- PROPOSED ONLY. Execute only with the final candidate's exact Director authorization.
-- Precondition: exact source/function/config baseline, legal existing Admin,
-- original cumulative usage reconciliation, and the two dependency SQL files verified.
-- No remote KB authority is granted. No Visitor/Assistant message is inserted here.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.c3_uat_execution_status(uuid,text,uuid)') IS NULL THEN RAISE EXCEPTION 'UAT_DEPENDENCY_MISSING'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.company_membership WHERE user_id='4348ee35-9632-4626-a846-e313bcc4a5f9' AND company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec' AND is_active AND role IN ('admin','supervisor')) THEN RAISE EXCEPTION 'UAT_ACTOR_DENIED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.channel_config WHERE id='0405282f-77dc-47cf-8074-99dd3dc6c393' AND company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec' AND is_active AND channel_type='web_widget') THEN RAISE EXCEPTION 'UAT_CHANNEL_DENIED'; END IF;
 IF EXISTS(SELECT 1 FROM public.upstream_call_log WHERE id='71657f35-88c4-4a73-a2e7-9abde643ad74') OR EXISTS(SELECT 1 FROM public.conversations WHERE id IN ('c7d3fa80-ed64-42d2-a48e-cda98dce5d71','a869150f-a69d-41ad-bb39-c070be8cc708')) OR EXISTS(SELECT 1 FROM public.visitor_session WHERE id IN ('4579cc72-1d8e-464f-b393-cae4f634bb55','97084394-abf7-4d50-ab18-d31092bc1384')) THEN RAISE EXCEPTION 'UAT_FIXTURE_ALREADY_EXISTS'; END IF;
END $$;
INSERT INTO public.upstream_call_log(id,company_id,upstream_service,request_payload,response_status)
VALUES('71657f35-88c4-4a73-a2e7-9abde643ad74','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec','c3_temp_uat',jsonb_build_object(
 'kind','c3_uat_run','revision','c3-3322877-bounded-uat-r2','state','active','issued_at',clock_timestamp(),'expires',clock_timestamp()+interval '45 minutes',
 'allowed_conversations',jsonb_build_array('c7d3fa80-ed64-42d2-a48e-cda98dce5d71','a869150f-a69d-41ad-bb39-c070be8cc708'),
 'allowed_purposes',jsonb_build_array('generation','evaluation'),'allowed_operation_prefixes',jsonb_build_array('generate-reply-','commerce-semantic-interpreter:'),
 'conversation_limit',2,'visitor_limit',5,'attempt_limit',12,'budget_microusd',400000,'batch_size',2,'batch_visitor_limit',5,'per_request_attempt_limit',6,'stage','A','kb_bounds_verified',false),0);
INSERT INTO public.visitor_session(id,session_token,visitor_fingerprint,visitor_metadata,last_seen_at,channel_config_id)
SELECT id, 'preview-test.'||gen_random_uuid()::text||'.'||replace(gen_random_uuid()::text,'-',''), 'widget-live-test:4348ee35-9632-4626-a846-e313bcc4a5f9',
 jsonb_build_object('source','c3_uat_widget','test_mode',true,'owner_user_id','4348ee35-9632-4626-a846-e313bcc4a5f9','exclude_training',true,'scope_mode','canonical'),clock_timestamp(),'0405282f-77dc-47cf-8074-99dd3dc6c393'::uuid
FROM unnest(ARRAY['4579cc72-1d8e-464f-b393-cae4f634bb55'::uuid,'97084394-abf7-4d50-ab18-d31092bc1384'::uuid]) AS t(id);
INSERT INTO public.conversations(id,visitor_session_id,channel_config_id,company_id,status,metadata_source,created_at)
SELECT id,session_id,'0405282f-77dc-47cf-8074-99dd3dc6c393'::uuid,'4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid,'open',
 jsonb_build_object('source','c3_uat_widget','synthetic',true,'owner_user_id','4348ee35-9632-4626-a846-e313bcc4a5f9','exclude_training',true,'scope_mode','canonical','contract_id','C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1'),clock_timestamp()
FROM (VALUES('c7d3fa80-ed64-42d2-a48e-cda98dce5d71'::uuid,'4579cc72-1d8e-464f-b393-cae4f634bb55'::uuid),('a869150f-a69d-41ad-bb39-c070be8cc708'::uuid,'97084394-abf7-4d50-ab18-d31092bc1384'::uuid)) AS t(id,session_id);
COMMIT;
