-- ===========================================================================
-- Disposable-harness BASELINE: reproduces the pre-migration live schema
-- contract (public tables/enums/functions/policies + a minimal auth shim)
-- so the CE-P1 forward migration and rollback can be executed for real.
--
-- Column types / NOT NULL / defaults were read from the live catalog.
-- No production access is required to run this.
-- ===========================================================================

-- ---- roles -----------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---- auth shim -------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ---- enum ------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('admin','supervisor','agent','qa');
  END IF;
END $$;

-- ---- tables ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.widget_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  header_title text NOT NULL DEFAULT 'Customer Support',
  welcome_message text DEFAULT 'Hi! How can I help you today?',
  placeholder_text text DEFAULT 'Type your message...',
  primary_color text DEFAULT '#6B5CE7',
  logo_url text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.channel_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  channel_type text NOT NULL DEFAULT 'web_widget',
  widget_config_id uuid REFERENCES public.widget_config(id),
  allowed_origins text[] DEFAULT '{}'::text[],
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.visitor_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token text NOT NULL DEFAULT gen_random_uuid()::text,
  channel_config_id uuid REFERENCES public.channel_config(id),
  visitor_fingerprint text,
  visitor_metadata jsonb DEFAULT '{}'::jsonb,
  last_seen_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.agent_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  display_name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL DEFAULT 'agent',
  status text DEFAULT 'active',
  avatar_url text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_session_id uuid REFERENCES public.visitor_session(id),
  channel_config_id uuid REFERENCES public.channel_config(id),
  status text NOT NULL DEFAULT 'open',
  assigned_agent_id uuid,
  priority text DEFAULT 'normal',
  tags text[] DEFAULT '{}'::text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  content_type text DEFAULT 'text',
  status text DEFAULT 'delivered',
  is_recalled boolean DEFAULT false,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  sender_id uuid REFERENCES public.agent_profile(id),
  sender_identity_verified_at timestamptz,
  sender_identity_source text
);

CREATE TABLE IF NOT EXISTS public.upstream_call_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  upstream_service text NOT NULL,
  request_payload jsonb DEFAULT '{}'::jsonb,
  response_status integer,
  response_latency_ms integer,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ce_feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversation_evaluation_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  evaluation_contract_version text NOT NULL DEFAULT 'v1',
  input_snapshot_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  pipeline_run_id uuid NOT NULL DEFAULT gen_random_uuid(),
  initiated_by uuid NOT NULL,
  kb_snapshot_id text NOT NULL,
  policy_snapshot_id text NOT NULL,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  source_deployment text NOT NULL,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.conversation_evaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE REFERENCES public.conversation_evaluation_attempt(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  evaluation_contract_version text NOT NULL,
  input_snapshot_hash text NOT NULL,
  accuracy_score numeric(5,2) NOT NULL,
  policy_score numeric(5,2) NOT NULL,
  tone_score numeric(5,2) NOT NULL,
  sales_score numeric(5,2) NOT NULL,
  context_score numeric(5,2) NOT NULL,
  hallucination_risk_score numeric(5,2) NOT NULL,
  hallucination_quality_score numeric(5,2) NOT NULL DEFAULT 0,
  overall_score numeric(5,2) NOT NULL,
  severity text NOT NULL,
  has_verified_human_response boolean NOT NULL DEFAULT false,
  training_eligible boolean NOT NULL DEFAULT false,
  model_version text NOT NULL,
  prompt_version text NOT NULL,
  kb_snapshot_id text NOT NULL,
  policy_snapshot_id text NOT NULL,
  source_deployment text NOT NULL,
  evaluated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, evaluation_contract_version, input_snapshot_hash)
);

CREATE TABLE IF NOT EXISTS public.conversation_evaluation_detail (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
  evaluator_type text NOT NULL,
  raw_score numeric(5,2) NOT NULL,
  weight numeric(4,2) NOT NULL,
  weighted_score numeric(5,2) NOT NULL,
  justification text,
  raw_llm_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.evaluation_training_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL UNIQUE REFERENCES public.conversation_evaluation(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  delivery_attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_attempt_at timestamptz,
  last_error text,
  delivered_at timestamptz,
  delivery_idempotency_key text NOT NULL,
  source_app text NOT NULL DEFAULT 'ai_chatbot',
  source_deployment text NOT NULL,
  evaluation_contract_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---- baseline functions ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = _user_id
       AND role IN ('admin'::public.app_role,'supervisor'::public.app_role,
                    'agent'::public.app_role,'qa'::public.app_role))
$$;

CREATE OR REPLACE FUNCTION public.verified_human_response(p_conversation_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.messages m
     WHERE m.conversation_id = p_conversation_id
       AND m.role = 'agent'
       AND m.sender_id IS NOT NULL
       AND m.sender_identity_verified_at IS NOT NULL
       AND COALESCE(m.is_recalled,false) = false)
$$;

CREATE OR REPLACE FUNCTION public.ce_is_flag_enabled(p_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((SELECT enabled FROM public.ce_feature_flags WHERE key = p_key), false)
$$;

-- ---- baseline grants + RLS (pre-migration state) ---------------------------
GRANT SELECT ON public.widget_config, public.channel_config, public.visitor_session,
               public.agent_profile, public.user_roles, public.conversations,
               public.messages, public.upstream_call_log, public.ce_feature_flags,
               public.conversation_evaluation, public.conversation_evaluation_attempt,
               public.conversation_evaluation_detail, public.evaluation_training_outbox
  TO authenticated;
GRANT INSERT, UPDATE ON public.conversations, public.messages TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','messages','conversation_evaluation',
                           'conversation_evaluation_attempt','conversation_evaluation_detail',
                           'evaluation_training_outbox','ce_feature_flags','user_roles',
                           'agent_profile','channel_config']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY base_conversations_staff ON public.conversations
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY base_conversations_staff_upd ON public.conversations
  FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY base_conversations_staff_ins ON public.conversations
  FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY base_messages_staff ON public.messages
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY base_messages_staff_ins ON public.messages
  FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY base_eval_staff ON public.conversation_evaluation
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY base_attempt_staff ON public.conversation_evaluation_attempt
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY base_detail_staff ON public.conversation_evaluation_detail
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY base_outbox_staff ON public.evaluation_training_outbox
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY base_flags_read ON public.ce_feature_flags
  FOR SELECT TO authenticated USING (true);
CREATE POLICY base_roles_self ON public.user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY base_agent_profile_staff ON public.agent_profile
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY base_channel_staff ON public.channel_config
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
