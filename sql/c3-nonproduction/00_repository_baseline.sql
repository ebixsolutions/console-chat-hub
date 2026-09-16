-- C3 disposable nonproduction bootstrap.
--
-- The committed migration chain starts from the original application schema.
-- A new Supabase project has no such tables, so this file recreates only that
-- pre-migration contract from repository-owned harness/types. It contains no
-- production data, project identifiers, credentials, or external endpoints.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('admin', 'supervisor', 'agent', 'qa');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.widget_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  header_title text NOT NULL DEFAULT 'Customer Support',
  welcome_message text DEFAULT 'Hi! How can I help you today?',
  placeholder_text text DEFAULT 'Type your message...',
  primary_color text DEFAULT '#6B5CE7', logo_url text,
  is_active boolean DEFAULT true, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.channel_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  channel_type text NOT NULL DEFAULT 'web_widget',
  widget_config_id uuid REFERENCES public.widget_config(id),
  allowed_origins text[] DEFAULT '{}'::text[], is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.visitor_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token text NOT NULL DEFAULT gen_random_uuid()::text,
  channel_config_id uuid REFERENCES public.channel_config(id),
  visitor_fingerprint text, visitor_metadata jsonb DEFAULT '{}'::jsonb,
  last_seen_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.agent_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  display_name text NOT NULL, email text NOT NULL, role text NOT NULL DEFAULT 'agent',
  status text DEFAULT 'active', avatar_url text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_session_id uuid REFERENCES public.visitor_session(id),
  channel_config_id uuid REFERENCES public.channel_config(id),
  status text NOT NULL DEFAULT 'open', assigned_agent_id uuid,
  priority text DEFAULT 'normal', tags text[] DEFAULT '{}'::text[],
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role text NOT NULL, content text NOT NULL, content_type text DEFAULT 'text',
  status text DEFAULT 'delivered', is_recalled boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), sender_id uuid REFERENCES public.agent_profile(id),
  sender_identity_verified_at timestamptz, sender_identity_source text
);
CREATE TABLE IF NOT EXISTS public.upstream_call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  upstream_service text NOT NULL, request_payload jsonb DEFAULT '{}'::jsonb,
  response_status integer, response_latency_ms integer, error_message text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ai_reply_draft (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
  message_id uuid, draft_content text NOT NULL, draft_status text DEFAULT 'pending',
  confidence_score numeric, model_used text, prompt_version_id text,
  rag_sources jsonb, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL,
  actor_id uuid, actor_type text, resource_type text NOT NULL, resource_id uuid,
  diff jsonb, ip_address inet, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.conversation_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
  agent_id uuid NOT NULL, assigned_by uuid, assigned_at timestamptz DEFAULT now(),
  unassigned_at timestamptz, is_active boolean DEFAULT true
);
CREATE TABLE IF NOT EXISTS public.conversation_status_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
  old_status text, new_status text NOT NULL, changed_by uuid,
  changed_by_type text, reason text, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.feedback_automation_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  trigger_event text NOT NULL, delay_minutes integer, config jsonb,
  is_active boolean DEFAULT true, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.feedback_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
  visitor_session_id uuid, request_type text, status text,
  rating integer, feedback_text text, sent_at timestamptz, responded_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.final_prompt_trace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid,
  message_id uuid, system_prompt_snapshot text, user_message text,
  rag_context jsonb, tool_calls jsonb, model_used text,
  token_input integer, token_output integer, latency_ms integer,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.handoff_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
  handoff_type text NOT NULL, handoff_reason text NOT NULL,
  from_agent_id uuid, to_agent_id uuid, ai_summary text,
  escalation_rule text, branch_tag text, safe_reply_content text,
  source_message_id uuid, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.rag_trace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid,
  message_id uuid, query_sent text, retrieved_chunks jsonb,
  top_score numeric, kb_source text, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.widget_session_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), visitor_session_id uuid,
  event_type text NOT NULL, event_data jsonb, page_url text,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.ce_feature_flags (
  key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.conversation_evaluation_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL,
  evaluation_contract_version text NOT NULL DEFAULT 'v1', input_snapshot_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running', pipeline_run_id uuid NOT NULL DEFAULT gen_random_uuid(),
  initiated_by uuid NOT NULL, kb_snapshot_id text NOT NULL, policy_snapshot_id text NOT NULL,
  model_version text NOT NULL, prompt_version text NOT NULL, source_deployment text NOT NULL,
  error_message text, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.conversation_evaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id uuid NOT NULL UNIQUE,
  conversation_id uuid NOT NULL, evaluation_contract_version text NOT NULL,
  input_snapshot_hash text NOT NULL, accuracy_score numeric(5,2) NOT NULL,
  policy_score numeric(5,2) NOT NULL, tone_score numeric(5,2) NOT NULL,
  sales_score numeric(5,2) NOT NULL, context_score numeric(5,2) NOT NULL,
  hallucination_risk_score numeric(5,2) NOT NULL,
  hallucination_quality_score numeric(5,2) NOT NULL DEFAULT 0,
  overall_score numeric(5,2) NOT NULL, severity text NOT NULL,
  has_verified_human_response boolean NOT NULL DEFAULT false,
  training_eligible boolean NOT NULL DEFAULT false, model_version text NOT NULL,
  prompt_version text NOT NULL, kb_snapshot_id text NOT NULL,
  policy_snapshot_id text NOT NULL, source_deployment text NOT NULL,
  evaluated_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, evaluation_contract_version, input_snapshot_hash)
);
CREATE TABLE IF NOT EXISTS public.conversation_evaluation_detail (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), evaluation_id uuid NOT NULL,
  evaluator_type text NOT NULL, raw_score numeric(5,2) NOT NULL,
  weight numeric(4,2) NOT NULL, weighted_score numeric(5,2) NOT NULL,
  justification text, raw_llm_response jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.evaluation_training_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), evaluation_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending', delivery_attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3, last_attempt_at timestamptz,
  last_error text, delivered_at timestamptz, delivery_idempotency_key text NOT NULL,
  source_app text NOT NULL DEFAULT 'ai_chatbot', source_deployment text NOT NULL,
  evaluation_contract_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);

-- Legacy CE functions are part of the pre-migration catalog contract. Fresh
-- nonproduction must never turn their absence into a fake successful result.
CREATE OR REPLACE FUNCTION public.initiate_evaluation(
  p_cid uuid, p_ver text, p_kb text, p_pol text, p_model text,
  p_prompt text, p_hash text, p_src text
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  RAISE EXCEPTION 'legacy initiate_evaluation unavailable before CE runtime migration';
END $$;
CREATE OR REPLACE FUNCTION public.initiate_evaluation(
  p_cid uuid, p_ver text, p_kb text, p_pol text, p_model text,
  p_prompt text, p_hash text, p_initiated_by uuid, p_src text
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  RAISE EXCEPTION 'legacy tenant initiate_evaluation unavailable before CE runtime migration';
END $$;
CREATE OR REPLACE FUNCTION public.complete_evaluation(p_attempt uuid, p_scores jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  RAISE EXCEPTION 'legacy complete_evaluation unavailable before CE runtime migration';
END $$;
CREATE OR REPLACE FUNCTION public.fail_evaluation(p_attempt uuid, p_error text)
RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $$
BEGIN
  RAISE EXCEPTION 'legacy fail_evaluation unavailable before CE runtime migration';
END $$;

CREATE OR REPLACE FUNCTION public.verified_human_response(p_conversation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.messages m
    WHERE m.conversation_id = p_conversation_id
      AND m.role = 'agent' AND m.sender_id IS NOT NULL
      AND m.sender_identity_verified_at IS NOT NULL
      AND COALESCE(m.is_recalled, false) = false
  )
$$;

CREATE OR REPLACE FUNCTION public.ce_is_flag_enabled(p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((SELECT enabled FROM public.ce_feature_flags WHERE key = p_key), false)
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'widget_config','channel_config','visitor_session','agent_profile','user_roles',
    'conversations','messages','upstream_call_log','ai_reply_draft','audit_log',
    'conversation_assignment','conversation_status_log','feedback_automation_config',
    'feedback_request','final_prompt_trace','handoff_event','rag_trace',
    'widget_session_event','ce_feature_flags','conversation_evaluation_attempt',
    'conversation_evaluation','conversation_evaluation_detail','evaluation_training_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;
