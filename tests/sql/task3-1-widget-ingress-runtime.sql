\set ON_ERROR_STOP on
create extension if not exists pgcrypto;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.visitor_session (
  id uuid primary key default gen_random_uuid(),
  session_token text not null unique,
  channel_config_id uuid,
  visitor_metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now()
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  visitor_session_id uuid not null,
  channel_config_id uuid,
  status text not null,
  assigned_agent_id uuid,
  updated_at timestamptz not null default now()
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  role text not null,
  content text not null,
  status text,
  is_recalled boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

\ir ../../supabase/migrations/20260902142000_task3_1_widget_human_control_ingress.sql

do $$
declare
  v_session uuid := gen_random_uuid();
  v_conv uuid := gen_random_uuid();
  v_channel uuid := gen_random_uuid();
  v_status text;
  v_result jsonb;
  v_client uuid;
begin
  insert into public.visitor_session(id,session_token,channel_config_id,visitor_metadata)
  values(v_session, repeat('a',64), v_channel, '{}'::jsonb);
  insert into public.conversations(id,visitor_session_id,channel_config_id,status)
  values(v_conv,v_session,v_channel,'open');

  foreach v_status in array array['pending','transferred','human_needed','human_control','escalation_risk','unresolved'] loop
    update public.conversations set status=v_status, assigned_agent_id=null where id=v_conv;
    v_client := gen_random_uuid();
    select public.receive_widget_message_tx(v_conv,repeat('a',64),'customer message',v_client::text) into v_result;
    if v_result->>'result' <> 'human_control' then
      raise exception 'expected human_control for %, got %', v_status, v_result;
    end if;
    if exists(select 1 from public.messages where conversation_id=v_conv and content='__THINKING__' and metadata->>'source_message_id'=v_result->>'message_id') then
      raise exception 'thinking claim created under human control status %', v_status;
    end if;
  end loop;

  update public.conversations set status='open', assigned_agent_id=gen_random_uuid() where id=v_conv;
  v_client := gen_random_uuid();
  select public.receive_widget_message_tx(v_conv,repeat('a',64),'assigned human message',v_client::text) into v_result;
  if v_result->>'result' <> 'human_control' then raise exception 'assigned agent did not force human_control: %', v_result; end if;

  update public.conversations set status='open', assigned_agent_id=null where id=v_conv;
  v_client := gen_random_uuid();
  select public.receive_widget_message_tx(v_conv,repeat('a',64),'AI path message',v_client::text) into v_result;
  if v_result->>'result' <> 'success' then raise exception 'open AI path did not succeed: %', v_result; end if;
  if not exists(select 1 from public.messages where id=(v_result->>'thinking_message_id')::uuid and content='__THINKING__') then
    raise exception 'open AI path missing thinking claim';
  end if;

  select public.receive_widget_message_tx(v_conv,repeat('a',64),'AI path message',v_client::text) into v_result;
  if v_result->>'result' <> 'idempotent' then raise exception 'client retry not idempotent: %', v_result; end if;

  update public.conversations set status='resolved', assigned_agent_id=null where id=v_conv;
  v_client := gen_random_uuid();
  select public.receive_widget_message_tx(v_conv,repeat('a',64),'terminal message',v_client::text) into v_result;
  if v_result->>'result' <> 'resolved' then raise exception 'resolved conversation accepted input: %', v_result; end if;
end $$;

select 'TASK3_1_WIDGET_INGRESS_RUNTIME=PASS' as result;
