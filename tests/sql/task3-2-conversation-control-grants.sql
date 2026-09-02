\set ON_ERROR_STOP on
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.conversations (
  id uuid,
  visitor_session_id uuid,
  channel_config_id uuid,
  status text,
  assigned_agent_id uuid,
  priority text,
  tags text[],
  created_at timestamptz,
  updated_at timestamptz,
  resolved_at timestamptz,
  company_id uuid,
  customer_tier text,
  intent text,
  language text,
  metadata_source jsonb,
  metadata_updated_at timestamptz
);
GRANT UPDATE ON public.conversations TO anon, authenticated;
\ir ../../supabase/migrations/20260902171000_task3_2_conversation_control_grants.sql

DO $$ BEGIN
  IF has_column_privilege('anon','public.conversations','status','UPDATE') THEN RAISE EXCEPTION 'anon_status_update'; END IF;
  IF has_column_privilege('authenticated','public.conversations','status','UPDATE') THEN RAISE EXCEPTION 'authenticated_status_update'; END IF;
  IF has_column_privilege('authenticated','public.conversations','assigned_agent_id','UPDATE') THEN RAISE EXCEPTION 'authenticated_owner_update'; END IF;
  IF has_column_privilege('authenticated','public.conversations','company_id','UPDATE') THEN RAISE EXCEPTION 'authenticated_company_update'; END IF;
  IF has_column_privilege('authenticated','public.conversations','resolved_at','UPDATE') THEN RAISE EXCEPTION 'authenticated_resolved_update'; END IF;
  IF NOT has_column_privilege('authenticated','public.conversations','priority','UPDATE') THEN RAISE EXCEPTION 'priority_update_missing'; END IF;
  IF NOT has_column_privilege('authenticated','public.conversations','tags','UPDATE') THEN RAISE EXCEPTION 'tags_update_missing'; END IF;
  RAISE NOTICE 'TASK3_2_CONTROL_GRANTS_PASS';
END $$;
