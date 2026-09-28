-- Run only against a disposable local Postgres database, using psql -v ON_ERROR_STOP=1.
-- Authoritative source order: repository bootstrap, CE tenant schema, A1, C2, C3,
-- followed by the Director forward and its preserved exact rollback SQL.
\set ON_ERROR_STOP on
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
\i sql/c3-nonproduction/00_repository_baseline.sql
\i supabase/migrations/20260728093000_ce_task1.sql
\i supabase/migrations/20260909173000_task_a1_universal_commerce_state.sql
\i supabase/migrations/20260915000000_ai_abc_c2_director_closure_handoff.sql
\i supabase/migrations/20260915040000_ai_abc_c3_director_runtime_closure.sql

-- This pre-existing production R1 function was independently read back by
-- pg_get_functiondef in the Director takeover; it is a fixture, not a migration.
CREATE OR REPLACE FUNCTION public.explicit_handoff_tx(
  p_conversation_id uuid, p_safe_reply_content text, p_source_message_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_conv record; v_existing_handoff record;
BEGIN
  SELECT id,status,assigned_agent_id INTO v_conv FROM conversations
    WHERE id=p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  SELECT id,branch_tag INTO v_existing_handoff FROM handoff_event
    WHERE conversation_id=p_conversation_id AND source_message_id=p_source_message_id LIMIT 1;
  IF FOUND THEN RETURN jsonb_build_object('result','already_handled',
    'existing_branch',v_existing_handoff.branch_tag,'requested_branch','ESC_R1_EXPLICIT'); END IF;
  IF v_conv.status IN ('resolved','closed') THEN RETURN jsonb_build_object('result','already_resolved'); END IF;
  IF v_conv.status IN ('pending','transferred') OR v_conv.assigned_agent_id IS NOT NULL
    THEN RETURN jsonb_build_object('result','already_under_human_control'); END IF;
  IF NOT EXISTS(SELECT 1 FROM messages WHERE id=p_source_message_id
    AND conversation_id=p_conversation_id AND role='visitor') THEN
    RETURN jsonb_build_object('result','invalid_source_message'); END IF;
  INSERT INTO messages(conversation_id,role,content,status,is_recalled)
    VALUES(p_conversation_id,'assistant',p_safe_reply_content,'delivered',false);
  UPDATE conversations SET status='pending',updated_at=now() WHERE id=p_conversation_id;
  INSERT INTO handoff_event(conversation_id,source_message_id,handoff_type,branch_tag,
    escalation_rule,safe_reply_content,handoff_reason,created_at)
    VALUES(p_conversation_id,p_source_message_id,'ai_to_agent','ESC_R1_EXPLICIT',
      'R1',p_safe_reply_content,'Visitor explicitly requested human agent (R1)',now());
  RETURN jsonb_build_object('result','success');
END;
$function$;
REVOKE ALL ON FUNCTION public.explicit_handoff_tx(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.explicit_handoff_tx(uuid,text,uuid) TO service_role;

CREATE TEMP TABLE c3_before AS
SELECT jsonb_build_object(
  'functions', (SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(p.oid),
    'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig,'security',p.prosecdef)
    ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('c2_populate_handoff_package_tg','c3_enrich_handoff_from_memory_tg')),
  'triggers', (SELECT jsonb_agg(jsonb_build_object('name',t.tgname,
    'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname)
    FROM pg_trigger t WHERE t.tgrelid='public.handoff_event'::regclass AND NOT t.tgisinternal),
  'policies', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.policyname),'[]'::jsonb)
    FROM pg_policies p WHERE p.schemaname='public' AND p.tablename='handoff_event'),
  'table_owner', (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    WHERE c.oid='public.handoff_event'::regclass)
) AS catalog;

\i supabase/migrations/20260928100000_c3_director_handoff_context.sql

INSERT INTO public.company(id,slug,display_name,external_workspace_id,external_tenant_id)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','c3-director-test','Synthetic C3','test-workspace','test-tenant');
INSERT INTO public.conversations(id,company_id,status)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','open');
INSERT INTO public.messages(id,conversation_id,role,content)
VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'visitor','I need a human because the corrected booking and deferred parking were lost.');
INSERT INTO public.company(id,slug,display_name,external_workspace_id,external_tenant_id)
VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','c3-other-tenant','Other tenant','other-workspace','other-tenant');
INSERT INTO public.conversations(id,company_id,status)
VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','open');
INSERT INTO public.messages(id,conversation_id,role,content)
VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','ffffffff-ffff-4fff-8fff-ffffffffffff',
  'visitor','Separate tenant source');

INSERT INTO public.conversation_commerce_state(conversation_id,company_id,revision,source_message_id,state,state_hash)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',2,
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '{"version":"commerce-state-1.0.0","current_topic":"booking","current_intent":"Assess corrected booking",
    "entities":[{"entity_id":"booking:one","category":"booking","brand":null,"model":null,"quantity":3,
      "status":"researching","attributes":{"guest_count":3},"constraints":{"nights":3}},
      {"entity_id":"parking:one","category":"parking","brand":null,"model":null,"quantity":1,
      "status":"deferred","attributes":{},"constraints":{"max_height_mm":1900}}],
    "latest_corrections":["Booking now 3 nights, not 2"],
    "unresolved_items":["Confirm booking availability"],
    "conversion":{"order_status":"none","payment_status":"none"}}'::jsonb, repeat('0',64));

DO $test$
DECLARE r jsonb;
BEGIN
  SELECT public.c3_commit_conversation_memory_tx(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,0,
    '{"version":"conversation-memory-1.0.0"}'::jsonb,'Synthetic',1) INTO r;
  IF r->>'result'<>'stale_commerce_revision' THEN
    RAISE EXCEPTION 'stale commerce revision accepted: %',r; END IF;
  SELECT public.explicit_handoff_tx('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Cross tenant source','dddddddd-dddd-4ddd-8ddd-dddddddddddd') INTO r;
  IF r->>'result'<>'invalid_source_message' THEN RAISE EXCEPTION 'cross tenant source accepted: %',r; END IF;
  SELECT public.explicit_handoff_tx('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'A human will review your request.','cccccccc-cccc-4ccc-8ccc-cccccccccccc') INTO r;
  IF r->>'result' <> 'success' THEN RAISE EXCEPTION 'R1 transaction failed: %',r; END IF;
  SELECT (ai_summary::jsonb)->'structured_package' INTO r FROM public.handoff_event
    WHERE source_message_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  IF jsonb_array_length(r->'active_entities')<>1
    OR r->'active_entities'->0->>'category'<>'booking'
    OR r->'active_entities'->0->'constraints'->>'nights'<>'3'
    OR jsonb_array_length(r->'deferred_entities')<>1
    OR r->'deferred_entities'->0->>'category'<>'parking'
    OR r->'latest_corrections'->>0<>'Booking now 3 nights, not 2'
    OR r->'open_questions'->>0<>'Confirm booking availability'
    OR r->>'handoff_reason_code'<>'explicit_customer_request'
    OR r->>'generated_from_source_message_id'<>'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    OR (r->>'commerce_state_revision')::int<>2
    OR r->'transaction_state'->>'order'<>'none'
  THEN RAISE EXCEPTION 'persisted handoff package was lost: %',r; END IF;
  SELECT public.explicit_handoff_tx('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'A human will review your request.','cccccccc-cccc-4ccc-8ccc-cccccccccccc') INTO r;
  IF r->>'result'<>'already_handled' THEN RAISE EXCEPTION 'handoff not idempotent: %',r; END IF;
  SELECT public.explicit_handoff_tx('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Wrong tenant source','dddddddd-dddd-4ddd-8ddd-dddddddddddd') INTO r;
  IF r->>'result'<>'already_under_human_control' THEN RAISE EXCEPTION 'human control bypassed: %',r; END IF;
END;
$test$;

\i supabase/migrations/rollback/20260928100000_c3_director_handoff_context.rollback.sql
DO $rollback$
DECLARE before_catalog jsonb; after_catalog jsonb;
BEGIN
  SELECT catalog INTO before_catalog FROM c3_before;
  SELECT jsonb_build_object(
    'functions', (SELECT jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(p.oid),
      'owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'config',p.proconfig,'security',p.prosecdef)
      ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('c2_populate_handoff_package_tg','c3_enrich_handoff_from_memory_tg')),
    'triggers', (SELECT jsonb_agg(jsonb_build_object('name',t.tgname,
      'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid='public.handoff_event'::regclass AND NOT t.tgisinternal),
    'policies', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.policyname),'[]'::jsonb)
      FROM pg_policies p WHERE p.schemaname='public' AND p.tablename='handoff_event'),
    'table_owner', (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
      WHERE c.oid='public.handoff_event'::regclass)
  ) INTO after_catalog;
  IF before_catalog IS DISTINCT FROM after_catalog THEN
    RAISE EXCEPTION 'affected catalog drift after rollback'; END IF;
END;
$rollback$;
SELECT 'C3_DIRECTOR_HANDOFF_SQL_RUNTIME=PASS' AS assertion;
