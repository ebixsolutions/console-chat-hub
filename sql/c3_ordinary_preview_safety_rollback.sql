BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN IF EXISTS(SELECT FROM public.widget_control_preview_scope) THEN RAISE EXCEPTION 'PREVIEW_ROLLBACK_RETAINS_EXCLUSION: registered preview receipts exist; keep protective SQL, rollback application bytes only'; END IF; END $$;
DROP TRIGGER IF EXISTS widget_control_preview_seal ON public.conversations;
DROP TRIGGER IF EXISTS widget_control_preview_message_seal ON public.messages;
DROP TRIGGER trg_zz_ce_realtime_assistant_dispatch ON public.messages;
CREATE TRIGGER trg_zz_ce_realtime_assistant_dispatch AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION ce_realtime_assistant_message_trigger_v1();
CREATE OR REPLACE FUNCTION public.c3_uat_learning_excluded(p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT EXISTS(SELECT 1 FROM public.c3_uat_conversation_scope WHERE conversation_id=p_conversation_id)
$function$
;
CREATE OR REPLACE FUNCTION public.ce_mark_evaluation_dirty(p_conversation_id uuid, p_activity_at timestamp with time zone DEFAULT now())
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_company uuid;BEGIN IF p_conversation_id IS NULL THEN RETURN;END IF;IF NOT EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=p_conversation_id) THEN RETURN;END IF;IF EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=p_conversation_id AND COALESCE(c.metadata_source->>'source','')='widget_live_test' AND COALESCE((c.metadata_source->>'widget_live_test')::boolean,false)=true AND COALESCE((c.metadata_source->>'exclude_training')::boolean,false)=true) THEN RETURN;END IF;v_company:=public.ce_runtime_conversation_company(p_conversation_id);INSERT INTO public.ce_evaluation_state(conversation_id,company_id,state,revision,dirty_since,last_activity_at,updated_at) VALUES(p_conversation_id,v_company,'never_evaluated',1,now(),COALESCE(p_activity_at,now()),now()) ON CONFLICT(conversation_id) DO UPDATE SET company_id=EXCLUDED.company_id,revision=public.ce_evaluation_state.revision+1,state=CASE WHEN public.ce_evaluation_state.last_success_evaluation_id IS NULL THEN 'never_evaluated' ELSE 'dirty' END,dirty_since=COALESCE(public.ce_evaluation_state.dirty_since,now()),last_activity_at=GREATEST(COALESCE(public.ce_evaluation_state.last_activity_at,'-infinity'::timestamptz),COALESCE(EXCLUDED.last_activity_at,now())),queued_at=NULL,evaluating_started_at=NULL,last_error_code=NULL,updated_at=now();END;$function$
;
CREATE OR REPLACE FUNCTION public.ce_dispatch_realtime_evaluation_v1(p_conversation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_enqueue jsonb;
  v_job_id uuid;
  v_cfg public.ce_automation_runtime;
  v_token text;
  v_request_id bigint;
begin
  v_enqueue := public.ce_enqueue_current_snapshot_v1(p_conversation_id,'ce_dwell',now());
  if coalesce(v_enqueue->>'result','') not in ('queued','already_queued') then
    return v_enqueue;
  end if;
  v_job_id := nullif(v_enqueue->>'job_id','')::uuid;
  if v_job_id is null then return jsonb_build_object('result','job_id_missing'); end if;
  select * into v_cfg from public.ce_automation_runtime where singleton=true;
  if nullif(trim(coalesce(v_cfg.worker_url,'')),'') is null or v_cfg.worker_secret_id is null then
    return jsonb_build_object('result','worker_not_configured','job_id',v_job_id);
  end if;
  select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id=v_cfg.worker_secret_id;
  if nullif(coalesce(v_token,''),'') is null then return jsonb_build_object('result','worker_token_missing','job_id',v_job_id); end if;
  select net.http_post(
    url:=v_cfg.worker_url,
    headers:=jsonb_build_object('Content-Type','application/json','X-CE-Worker-Token',v_token),
    body:=jsonb_build_object('source','realtime','job_id',v_job_id),
    timeout_milliseconds:=5000
  ) into v_request_id;
  return jsonb_build_object('result','dispatched','job_id',v_job_id,'request_id',v_request_id);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.receive_widget_message_tx(p_conversation_id uuid, p_session_token text, p_content text, p_client_message_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_conv record; v_session record; v_message_id uuid; v_thinking_id uuid;
  v_human_control boolean; v_now timestamptz:=now(); v_client_id text;
begin
  if p_conversation_id is null or p_session_token is null or length(p_session_token)<32 or length(p_session_token)>256 or p_content is null or btrim(p_content)='' or length(btrim(p_content))>2000 then
    return jsonb_build_object('result','invalid_input');
  end if;
  v_client_id:=nullif(btrim(coalesce(p_client_message_id,'')),'');
  if v_client_id is not null and v_client_id !~ '^[0-9a-fA-F-]{36}$' then return jsonb_build_object('result','invalid_client_message_id'); end if;

  select vs.id,vs.channel_config_id,vs.visitor_metadata->>'origin' as origin into v_session
  from public.visitor_session vs where vs.session_token=p_session_token limit 1;
  if not found then return jsonb_build_object('result','invalid_session'); end if;

  select c.id,c.status,c.assigned_agent_id,c.visitor_session_id,c.channel_config_id into v_conv
  from public.conversations c where c.id=p_conversation_id for update;
  if not found or v_conv.visitor_session_id is distinct from v_session.id or v_conv.channel_config_id is distinct from v_session.channel_config_id then
    return jsonb_build_object('result','not_found');
  end if;
  if v_conv.status in ('resolved','closed') then return jsonb_build_object('result','resolved'); end if;

  if v_client_id is not null then
    select id into v_message_id from public.messages
    where conversation_id=p_conversation_id and role='visitor' and coalesce(is_recalled,false)=false
      and metadata->>'client_message_id'=v_client_id limit 1;
    if found then
      return jsonb_build_object('result','idempotent','message_id',v_message_id,'ai_reply_pending',
        exists(select 1 from public.messages where conversation_id=p_conversation_id and content='__THINKING__'
          and metadata->>'source_message_id'=v_message_id::text and coalesce(is_recalled,false)=false));
    end if;
  end if;

  v_human_control:=v_conv.assigned_agent_id is not null or v_conv.status in (
    'pending','transferred','human_needed','human_control','escalation_risk','unresolved'
  );

  insert into public.messages(conversation_id,role,content,status,is_recalled,metadata)
  values(p_conversation_id,'visitor',btrim(p_content),'delivered',false,
    case when v_client_id is null then '{}'::jsonb else jsonb_build_object('client_message_id',v_client_id) end)
  returning id into v_message_id;
  update public.visitor_session set last_seen_at=v_now where id=v_session.id;
  update public.conversations set updated_at=v_now where id=p_conversation_id;

  if v_human_control then return jsonb_build_object('result','human_control','message_id',v_message_id); end if;

  insert into public.messages(conversation_id,role,content,status,is_recalled,metadata)
  values(p_conversation_id,'assistant','__THINKING__','sending',false,
    jsonb_build_object('source_message_id',v_message_id::text,'control_claim','ai'))
  returning id into v_thinking_id;
  return jsonb_build_object('result','success','message_id',v_message_id,'thinking_message_id',v_thinking_id);
exception when unique_violation then
  if v_client_id is not null then
    select id into v_message_id from public.messages where conversation_id=p_conversation_id and role='visitor'
      and metadata->>'client_message_id'=v_client_id limit 1;
    return jsonb_build_object('result','idempotent','message_id',v_message_id);
  end if;
  raise;
end;
$function$
;
DROP FUNCTION public.widget_control_preview_message_tx(uuid,text,text,text);
DROP FUNCTION public.widget_control_preview_bootstrap(uuid,uuid);
DROP FUNCTION public.widget_control_preview_context(uuid,text);
DROP FUNCTION public.widget_control_preview_authorize(uuid,text);
DROP FUNCTION public.widget_control_preview_seal();
DROP FUNCTION public.widget_control_preview_receive_base(uuid,text,text,text);
DROP FUNCTION public.widget_control_preview_excluded(uuid);
DROP TABLE public.widget_control_preview_scope;
COMMIT;
