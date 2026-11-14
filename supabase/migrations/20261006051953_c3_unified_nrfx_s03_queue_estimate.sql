-- s03_queue_estimate / nrfxhqabwblzxoushgnm / C3-UNIFIED-NRFX-SCOPED-AUTH-20261006-v1
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF to_regclass('public.c3_human_queue_estimate') IS NOT NULL THEN
   RAISE EXCEPTION 'F03_CACHE_ALREADY_EXISTS_PREFLIGHT_CHANGED'; END IF;
 IF coalesce((SELECT md5(pg_get_functiondef(p.oid)) FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
   AND p.proname='get_human_support_queue_snapshot'
   AND pg_get_function_identity_arguments(p.oid)='p_conversation_id uuid'),'')
   <> '0d9f2ccf0a3951e68d9ad89a66ecc093' THEN
   RAISE EXCEPTION 'F03_RPC_BASELINE_CHANGED'; END IF;
END $guard$;
CREATE TABLE public.c3_human_queue_estimate (
 conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES public.company(id),
 basis text NOT NULL CHECK (basis ~ '^[0-9a-f]{32}$'),
 estimate_generated_at timestamptz NOT NULL,
 estimate_deadline timestamptz NOT NULL,
 estimated_wait_minutes integer NOT NULL CHECK(estimated_wait_minutes>0),
 CHECK(estimate_deadline>=estimate_generated_at)
);
ALTER TABLE public.c3_human_queue_estimate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.c3_human_queue_estimate FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.c3_human_queue_estimate TO service_role;
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
  v_estimate_basis text;
  v_estimate public.c3_human_queue_estimate%rowtype;
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

  -- Same server-derived basis keeps generation/deadline stable across polling/reload.
  -- This cache does not change queue position, ordering, state, exclusions or retained rows.
  if v_eta_minutes is not null then
    v_estimate_basis := md5(jsonb_build_array(q.company_id,q.conversation_id,
      q.priority,q.queued_at,v_position,v_ahead,v_active_agents,
      v_history_count,v_avg_seconds,v_eta_minutes)::text);
    insert into public.c3_human_queue_estimate as existing
      (conversation_id,company_id,basis,estimate_generated_at,estimate_deadline,estimated_wait_minutes)
    values (q.conversation_id,q.company_id,v_estimate_basis,now(),
      now()+make_interval(mins=>v_eta_minutes),v_eta_minutes)
    on conflict(conversation_id) do update set
      company_id=excluded.company_id,basis=excluded.basis,
      estimate_generated_at=excluded.estimate_generated_at,
      estimate_deadline=excluded.estimate_deadline,
      estimated_wait_minutes=excluded.estimated_wait_minutes
    where existing.basis is distinct from excluded.basis
    returning * into v_estimate;
    if not found then
      select * into v_estimate from public.c3_human_queue_estimate
        where conversation_id=q.conversation_id and company_id=q.company_id;
    end if;
  end if;

  return jsonb_build_object(
    'state','waiting',
    'queue_position',v_position,
    'customers_ahead',v_ahead,
    'estimated_wait_minutes',v_eta_minutes,
    'estimate_confidence',case when v_eta_minutes is null then 'unavailable' else 'historical_average' end,
    'estimate_generated_at',v_estimate.estimate_generated_at,
    'estimate_deadline',v_estimate.estimate_deadline,
    'estimate_basis',v_estimate.basis,
    'server_now',now(),
    'active_agents',v_active_agents,
    'history_samples',v_history_count
  );
end;
$function$
;
COMMIT;
