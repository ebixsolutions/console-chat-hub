\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.agent_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text,
  display_name text NOT NULL DEFAULT 'Agent'
);
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'open',
  assigned_agent_id uuid,
  company_id uuid,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  content_type text DEFAULT 'text',
  status text DEFAULT 'delivered',
  sender_id uuid,
  is_recalled boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_type text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  diff jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.handoff_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  handoff_reason text NOT NULL,
  handoff_type text NOT NULL,
  from_agent_id uuid,
  to_agent_id uuid,
  created_at timestamptz DEFAULT now()
);

\ir ../../supabase/migrations/20260902170000_task3_2_agent_console_runtime.sql

DO $$
DECLARE
  company uuid := gen_random_uuid();
  a1 uuid := gen_random_uuid();
  a2 uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  source uuid := gen_random_uuid();
  r jsonb;
  n int;
BEGIN
  INSERT INTO agent_profile(id,status,display_name) VALUES
    (a1,'active','A1'), (a2,'active','A2');
  INSERT INTO conversations(id,status,assigned_agent_id,company_id)
    VALUES(c,'pending',a1,company);
  INSERT INTO messages(conversation_id,role,content,metadata)
    VALUES(c,'assistant','__THINKING__',jsonb_build_object('source_message_id',source::text));

  r := agent_send_reply_tx(c,a1,'  human answer  ','A1');
  IF r->>'result' <> 'success' THEN RAISE EXCEPTION 'send_success_failed %',r; END IF;
  SELECT count(*) INTO n FROM messages WHERE conversation_id=c AND content='__THINKING__';
  IF n <> 0 THEN RAISE EXCEPTION 'thinking_not_cleared'; END IF;
  SELECT count(*) INTO n FROM messages WHERE conversation_id=c AND role='agent' AND content='human answer' AND sender_id=a1 AND metadata->>'control_commit'='human';
  IF n <> 1 THEN RAISE EXCEPTION 'human_message_not_committed'; END IF;

  r := agent_send_reply_tx(c,a2,'wrong owner','A2');
  IF r->>'result' <> 'owned_by_another_agent' THEN RAISE EXCEPTION 'wrong_owner_not_denied %',r; END IF;

  UPDATE conversations SET assigned_agent_id=NULL,status='open' WHERE id=c;
  r := agent_send_reply_tx(c,a1,'no takeover','A1');
  IF r->>'result' <> 'takeover_required' THEN RAISE EXCEPTION 'takeover_not_required %',r; END IF;

  UPDATE conversations SET assigned_agent_id=a1,status='resolved' WHERE id=c;
  r := agent_send_reply_tx(c,a1,'resolved send','A1');
  IF r->>'result' <> 'resolved' THEN RAISE EXCEPTION 'resolved_not_blocked %',r; END IF;

  -- Normal AI commit before any human-control boundary remains valid.
  DELETE FROM messages WHERE conversation_id=c;
  DELETE FROM handoff_event WHERE conversation_id=c;
  UPDATE conversations SET assigned_agent_id=NULL,status='open' WHERE id=c;
  source := gen_random_uuid();
  INSERT INTO messages(id,conversation_id,role,content,is_recalled,created_at)
    VALUES(source,c,'visitor','question',false,now()-interval '2 minutes');
  r := commit_ai_reply_tx(c,source,'normal ai answer','{}'::jsonb);
  IF r->>'result' <> 'success' THEN RAISE EXCEPTION 'normal_ai_commit_failed %',r; END IF;

  -- A generation sourced before takeover cannot cross takeover + Return-to-AI.
  DELETE FROM messages WHERE conversation_id=c;
  source := gen_random_uuid();
  INSERT INTO messages(id,conversation_id,role,content,is_recalled,created_at)
    VALUES(source,c,'visitor','old question',false,now()-interval '2 minutes');
  INSERT INTO messages(conversation_id,role,content,metadata)
    VALUES(c,'assistant','__THINKING__',jsonb_build_object('source_message_id',source::text));
  INSERT INTO handoff_event(conversation_id,handoff_reason,handoff_type,from_agent_id,to_agent_id,created_at)
    VALUES(c,'Agent takeover','agent_to_agent',NULL,a1,now()-interval '1 minute');
  INSERT INTO handoff_event(conversation_id,handoff_reason,handoff_type,from_agent_id,to_agent_id,created_at)
    VALUES(c,'Return to AI','agent_to_agent',a1,NULL,now());
  UPDATE conversations SET assigned_agent_id=NULL,status='open' WHERE id=c;
  r := commit_ai_reply_tx(c,source,'stale ai answer','{}'::jsonb);
  IF r->>'result' <> 'superseded_source' THEN RAISE EXCEPTION 'control_epoch_not_blocked %',r; END IF;
  SELECT count(*) INTO n FROM messages WHERE conversation_id=c AND role='assistant' AND content='stale ai answer';
  IF n <> 0 THEN RAISE EXCEPTION 'stale_ai_committed'; END IF;
  SELECT count(*) INTO n FROM messages WHERE conversation_id=c AND content='__THINKING__';
  IF n <> 0 THEN RAISE EXCEPTION 'stale_thinking_not_cleared'; END IF;

  IF has_function_privilege('anon','public.agent_send_reply_tx(uuid,uuid,text,text)','EXECUTE') THEN RAISE EXCEPTION 'anon_exec'; END IF;
  IF has_function_privilege('authenticated','public.agent_send_reply_tx(uuid,uuid,text,text)','EXECUTE') THEN RAISE EXCEPTION 'authenticated_exec'; END IF;
  IF NOT has_function_privilege('service_role','public.agent_send_reply_tx(uuid,uuid,text,text)','EXECUTE') THEN RAISE EXCEPTION 'service_role_missing_exec'; END IF;

  RAISE NOTICE 'TASK3_2_SQL_RUNTIME_PASS';
END $$;
