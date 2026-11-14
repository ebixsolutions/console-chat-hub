CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE TYPE public.app_role AS ENUM ('admin','supervisor','agent','qa');
CREATE TABLE auth.users ("id" uuid NOT NULL,"email" character varying(255),"raw_user_meta_data" jsonb);
CREATE TABLE public.company ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"slug" text NOT NULL,"display_name" text NOT NULL,"external_workspace_id" text NOT NULL,"external_tenant_id" text NOT NULL,"is_active" boolean NOT NULL DEFAULT true,"created_at" timestamp with time zone NOT NULL DEFAULT now(),"platform_company_id" bigint NOT NULL);
CREATE TABLE public.agent_profile ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"user_id" uuid,"display_name" text NOT NULL,"email" text NOT NULL,"role" text NOT NULL DEFAULT 'agent'::text,"status" text DEFAULT 'active'::text,"avatar_url" text,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now());
CREATE TABLE public.human_support_queue ("conversation_id" uuid NOT NULL,"company_id" uuid NOT NULL,"queued_at" timestamp with time zone NOT NULL DEFAULT now(),"priority" integer NOT NULL DEFAULT 100,"state" text NOT NULL DEFAULT 'waiting'::text,"assigned_agent_id" uuid,"assigned_at" timestamp with time zone,"closed_at" timestamp with time zone,"updated_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.audit_log ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"actor_id" uuid,"actor_type" text,"action" text NOT NULL,"resource_type" text NOT NULL,"resource_id" uuid,"diff" jsonb DEFAULT '{}'::jsonb,"ip_address" text,"created_at" timestamp with time zone DEFAULT now());
CREATE TABLE public.company_membership ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"company_id" uuid NOT NULL,"user_id" uuid NOT NULL,"role" public.app_role NOT NULL,"is_active" boolean NOT NULL DEFAULT true,"created_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.conversation_assignment ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"conversation_id" uuid NOT NULL,"agent_id" uuid NOT NULL,"assigned_by" uuid,"assigned_at" timestamp with time zone DEFAULT now(),"unassigned_at" timestamp with time zone,"is_active" boolean DEFAULT true);
CREATE TABLE public.conversations ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"visitor_session_id" uuid,"channel_config_id" uuid,"status" text NOT NULL DEFAULT 'open'::text,"assigned_agent_id" uuid,"priority" text DEFAULT 'normal'::text,"tags" text[] DEFAULT '{}'::text[],"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"resolved_at" timestamp with time zone,"company_id" uuid,"customer_tier" text,"intent" text,"language" text,"metadata_source" jsonb NOT NULL DEFAULT '{}'::jsonb,"metadata_updated_at" timestamp with time zone);
CREATE TABLE public.user_roles ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"user_id" uuid NOT NULL,"role" public.app_role NOT NULL,"created_at" timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.widget_config ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"name" text NOT NULL,"header_title" text NOT NULL DEFAULT 'Customer Support'::text,"welcome_message" text DEFAULT 'Hi! How can I help you today?'::text,"placeholder_text" text DEFAULT 'Type your message...'::text,"primary_color" text DEFAULT '#6B5CE7'::text,"logo_url" text,"is_active" boolean DEFAULT true,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now());
CREATE TABLE public.channel_config ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"name" text NOT NULL,"channel_type" text NOT NULL DEFAULT 'web_widget'::text,"widget_config_id" uuid,"allowed_origins" text[] DEFAULT '{}'::text[],"is_active" boolean DEFAULT true,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"company_id" uuid);
CREATE TABLE public.visitor_session ("id" uuid NOT NULL DEFAULT gen_random_uuid(),"session_token" text NOT NULL DEFAULT (gen_random_uuid())::text,"channel_config_id" uuid,"visitor_fingerprint" text,"visitor_metadata" jsonb DEFAULT '{}'::jsonb,"last_seen_at" timestamp with time zone DEFAULT now(),"created_at" timestamp with time zone DEFAULT now());
ALTER TABLE auth.users ADD PRIMARY KEY(id);
ALTER TABLE public.visitor_session ADD PRIMARY KEY(id);
ALTER TABLE public.channel_config ADD PRIMARY KEY(id);
ALTER TABLE public.agent_profile ADD CONSTRAINT agent_profile_pkey PRIMARY KEY (id);
ALTER TABLE public.agent_profile ADD CONSTRAINT agent_profile_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin'::text, 'manager'::text, 'supervisor'::text, 'agent'::text, 'viewer'::text])));
ALTER TABLE public.agent_profile ADD CONSTRAINT agent_profile_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'suspended'::text])));
ALTER TABLE public.agent_profile ADD CONSTRAINT agent_profile_user_id_key UNIQUE (user_id);
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_actor_type_check CHECK ((actor_type = ANY (ARRAY['agent'::text, 'visitor'::text, 'system'::text, 'ai'::text])));
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE public.company ADD CONSTRAINT company_display_name_check CHECK ((length(btrim(display_name)) > 0));
ALTER TABLE public.company ADD CONSTRAINT company_external_tenant_id_check CHECK ((length(btrim(external_tenant_id)) > 0));
ALTER TABLE public.company ADD CONSTRAINT company_external_workspace_id_check CHECK ((length(btrim(external_workspace_id)) > 0));
ALTER TABLE public.company ADD CONSTRAINT company_external_workspace_id_external_tenant_id_key UNIQUE (external_workspace_id, external_tenant_id);
ALTER TABLE public.company ADD CONSTRAINT company_pkey PRIMARY KEY (id);
ALTER TABLE public.company ADD CONSTRAINT company_platform_company_id_positive_check CHECK ((platform_company_id > 0));
ALTER TABLE public.company ADD CONSTRAINT company_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'::text));
ALTER TABLE public.company ADD CONSTRAINT company_slug_key UNIQUE (slug);
ALTER TABLE public.company_membership ADD CONSTRAINT company_membership_company_id_user_id_role_key UNIQUE (company_id, user_id, role);
ALTER TABLE public.company_membership ADD CONSTRAINT company_membership_pkey PRIMARY KEY (id);
ALTER TABLE public.conversation_assignment ADD CONSTRAINT conversation_assignment_pkey PRIMARY KEY (id);
ALTER TABLE public.conversations ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);
ALTER TABLE public.conversations ADD CONSTRAINT conversations_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])));
ALTER TABLE public.conversations ADD CONSTRAINT conversations_status_check CHECK ((status = ANY (ARRAY['open'::text, 'pending'::text, 'resolved'::text, 'unresolved'::text, 'transferred'::text])));
ALTER TABLE public.human_support_queue ADD CONSTRAINT human_support_queue_pkey PRIMARY KEY (conversation_id);
ALTER TABLE public.human_support_queue ADD CONSTRAINT human_support_queue_priority_check CHECK (((priority >= 0) AND (priority <= 1000)));
ALTER TABLE public.human_support_queue ADD CONSTRAINT human_support_queue_state_check CHECK ((state = ANY (ARRAY['waiting'::text, 'assigned'::text, 'closed'::text])));
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_unique UNIQUE (user_id);
ALTER TABLE public.widget_config ADD CONSTRAINT widget_config_pkey PRIMARY KEY (id);
ALTER TABLE public.company_membership ADD CONSTRAINT company_membership_company_id_fkey FOREIGN KEY (company_id) REFERENCES company(id) ON DELETE CASCADE;
ALTER TABLE public.company_membership ADD CONSTRAINT company_membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.conversation_assignment ADD CONSTRAINT conversation_assignment_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES agent_profile(id);
ALTER TABLE public.conversation_assignment ADD CONSTRAINT conversation_assignment_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES agent_profile(id);
ALTER TABLE public.conversation_assignment ADD CONSTRAINT conversation_assignment_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_channel_config_id_fkey FOREIGN KEY (channel_config_id) REFERENCES channel_config(id);
ALTER TABLE public.conversations ADD CONSTRAINT conversations_company_id_fkey FOREIGN KEY (company_id) REFERENCES company(id);
ALTER TABLE public.conversations ADD CONSTRAINT conversations_visitor_session_id_fkey FOREIGN KEY (visitor_session_id) REFERENCES visitor_session(id);
ALTER TABLE public.human_support_queue ADD CONSTRAINT human_support_queue_assigned_agent_id_fkey FOREIGN KEY (assigned_agent_id) REFERENCES agent_profile(id) ON DELETE SET NULL;
ALTER TABLE public.human_support_queue ADD CONSTRAINT human_support_queue_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE OR REPLACE FUNCTION public.get_human_support_queue_snapshot(p_conversation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  q public.human_support_queue%rowtype;
  v_position integer;
  v_ahead integer;
  v_active_agents integer;
  v_history_count integer;
  v_avg_seconds numeric;
  v_eta_minutes integer;
begin
  select * into q
    from public.human_support_queue
   where conversation_id = p_conversation_id;

  if not found or q.state = 'closed' then
    return jsonb_build_object(
      'state','none',
      'queue_position',null,
      'customers_ahead',null,
      'estimated_wait_minutes',null,
      'estimate_confidence','unavailable'
    );
  end if;

  if q.state = 'assigned' then
    return jsonb_build_object(
      'state','assigned',
      'queue_position',0,
      'customers_ahead',0,
      'estimated_wait_minutes',0,
      'estimate_confidence','assigned',
      'assigned_agent_id',q.assigned_agent_id
    );
  end if;

  select count(*)::integer + 1 into v_position
    from public.human_support_queue x
   where x.company_id = q.company_id
     and x.state = 'waiting'
     and (x.priority, x.queued_at, x.conversation_id) < (q.priority, q.queued_at, q.conversation_id);
  v_ahead := greatest(v_position - 1, 0);

  select count(distinct ap.id)::integer into v_active_agents
    from public.agent_profile ap
    join public.company_membership cm on cm.user_id = ap.user_id
   where ap.status = 'active'
     and cm.company_id = q.company_id
     and cm.is_active = true;

  select count(*)::integer,
         avg(extract(epoch from (ca.unassigned_at - ca.assigned_at)))
    into v_history_count, v_avg_seconds
    from public.conversation_assignment ca
    join public.conversations c on c.id = ca.conversation_id
   where c.company_id = q.company_id
     and ca.assigned_at is not null
     and ca.unassigned_at is not null
     and ca.unassigned_at > ca.assigned_at
     and ca.unassigned_at >= now() - interval '30 days';

  if v_active_agents > 0 and v_history_count >= 3 and v_avg_seconds is not null then
    v_eta_minutes := greatest(1, ceil((v_ahead::numeric / v_active_agents::numeric) * v_avg_seconds / 60.0)::integer);
  else
    v_eta_minutes := null;
  end if;

  return jsonb_build_object(
    'state','waiting',
    'queue_position',v_position,
    'customers_ahead',v_ahead,
    'estimated_wait_minutes',v_eta_minutes,
    'estimate_confidence',case when v_eta_minutes is null then 'unavailable' else 'historical_average' end,
    'active_agents',v_active_agents,
    'history_samples',v_history_count
  );
end;
$function$
;
REVOKE ALL ON FUNCTION public.get_human_support_queue_snapshot(uuid) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.get_human_support_queue_snapshot(uuid) TO service_role;