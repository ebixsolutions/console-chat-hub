BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.c3_uat_learning_excluded(uuid)'::regprocedure) IS DISTINCT FROM 'e3eb65d27dc42d927129b36e7fa97852' THEN RAISE EXCEPTION 'PREVIEW_BASELINE_DRIFT: c3_uat_learning_excluded(uuid)'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ce_mark_evaluation_dirty(uuid,timestamp with time zone)'::regprocedure) IS DISTINCT FROM '8f8753f30ba2acd16b4a5b3fdafde2df' THEN RAISE EXCEPTION 'PREVIEW_BASELINE_DRIFT: ce_mark_evaluation_dirty(uuid,timestamp with time zone)'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.ce_dispatch_realtime_evaluation_v1(uuid)'::regprocedure) IS DISTINCT FROM 'ce3e6810d3a5cf0bb001ae14a2467bf3' THEN RAISE EXCEPTION 'PREVIEW_BASELINE_DRIFT: ce_dispatch_realtime_evaluation_v1(uuid)'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.receive_widget_message_tx(uuid,text,text,text)'::regprocedure) IS DISTINCT FROM '58a866c67d0db817823e907bb790262a' THEN RAISE EXCEPTION 'PREVIEW_BASELINE_DRIFT: receive_widget_message_tx(uuid,text,text,text)'; END IF;
IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid='public.messages'::regclass AND tgname='trg_zz_ce_realtime_assistant_dispatch') IS DISTINCT FROM 'CREATE TRIGGER trg_zz_ce_realtime_assistant_dispatch AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION ce_realtime_assistant_message_trigger_v1()' THEN RAISE EXCEPTION 'PREVIEW_BASELINE_DRIFT: realtime trigger'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.widget_control_preview_receive_base(p_conversation_id uuid, p_session_token text, p_content text, p_client_message_id text)
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
REVOKE ALL ON FUNCTION public.widget_control_preview_receive_base(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.widget_control_preview_scope (
 conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id),
 visitor_session_id uuid NOT NULL UNIQUE REFERENCES public.visitor_session(id),
 actor_id uuid NOT NULL, company_id uuid NOT NULL REFERENCES public.company(id),
 channel_id uuid NOT NULL REFERENCES public.channel_config(id),
 origin text NOT NULL, token_sha256 text NOT NULL,
 contract text NOT NULL CHECK(contract='ordinary-widget-control-v2'),
 revision text NOT NULL CHECK(revision='c3-preview-ce-zero-paid-v2'),
 request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_id,channel_id,request_id)
);
ALTER TABLE public.widget_control_preview_scope ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.widget_control_preview_scope FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.widget_control_preview_excluded(p_conversation_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 -- Exclusion is durable even after Actor revocation or visitor-token rotation.
 -- Registry rows can only be established by the authenticated bootstrap and cannot promote existing customer rows.
 SELECT EXISTS(SELECT FROM public.widget_control_preview_scope s WHERE s.conversation_id=p_conversation_id
 AND s.contract='ordinary-widget-control-v2' AND s.revision='c3-preview-ce-zero-paid-v2')
$$;
REVOKE ALL ON FUNCTION public.widget_control_preview_excluded(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.widget_control_preview_excluded(uuid) TO service_role;
CREATE FUNCTION public.widget_control_preview_authorize(p_conversation_id uuid,p_session_token text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT FROM public.widget_control_preview_scope s
 JOIN public.conversations c ON c.id=s.conversation_id AND c.company_id=s.company_id AND c.channel_config_id=s.channel_id AND c.visitor_session_id=s.visitor_session_id
 JOIN public.visitor_session vs ON vs.id=s.visitor_session_id AND vs.channel_config_id=s.channel_id AND encode(extensions.digest(vs.session_token,'sha256'),'hex')=s.token_sha256
 JOIN public.company co ON co.id=s.company_id AND co.is_active
 JOIN public.channel_config ch ON ch.id=s.channel_id AND ch.company_id=s.company_id AND ch.is_active AND ch.channel_type='web_widget'
 JOIN public.company_membership m ON m.user_id=s.actor_id AND m.company_id=s.company_id AND m.is_active AND m.role::text IN ('admin','supervisor')
 WHERE s.conversation_id=p_conversation_id AND s.actor_id=auth.uid()
 AND s.origin=coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'origin','')
 AND s.origin=ANY(ch.allowed_origins) AND public.widget_control_preview_excluded(p_conversation_id)
 AND encode(extensions.digest(p_session_token,'sha256'),'hex')=s.token_sha256)
$$;
REVOKE ALL ON FUNCTION public.widget_control_preview_authorize(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.widget_control_preview_context(p_conversation_id uuid,p_session_token text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.widget_control_preview_scope;
BEGIN
 IF NOT public.widget_control_preview_authorize(p_conversation_id,p_session_token) THEN RAISE EXCEPTION 'preview_actor_scope_denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.widget_control_preview_scope WHERE conversation_id=p_conversation_id;
 RETURN jsonb_build_object('contract',s.contract,'revision',s.revision,'actor_id',s.actor_id,'company_id',s.company_id,'channel_id',s.channel_id,'conversation_id',s.conversation_id,'paid_dispatch',false);
END $$;
REVOKE ALL ON FUNCTION public.widget_control_preview_context(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.widget_control_preview_context(uuid,text) TO authenticated;
CREATE FUNCTION public.widget_control_preview_bootstrap(p_channel_id uuid,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ch public.channel_config; s public.widget_control_preview_scope; token text; tx jsonb; o text;
BEGIN
 IF auth.uid() IS NULL OR p_request_id IS NULL THEN RAISE EXCEPTION 'preview_auth_required' USING ERRCODE='42501'; END IF;
 o:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'origin','');
 SELECT * INTO ch FROM public.channel_config WHERE id=p_channel_id FOR SHARE;
 IF ch.id IS NULL OR NOT ch.is_active OR ch.channel_type<>'web_widget' OR NOT EXISTS(SELECT FROM public.company WHERE id=ch.company_id AND is_active)
 OR NOT EXISTS(SELECT FROM public.company_membership WHERE user_id=auth.uid() AND company_id=ch.company_id AND is_active AND role::text IN ('admin','supervisor'))
 OR o !~ '^https://[a-z0-9.-]+(:[0-9]+)?$' OR NOT coalesce(o=ANY(ch.allowed_origins),false)
 THEN RAISE EXCEPTION 'preview_actor_channel_origin_denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':'||p_channel_id::text||':'||p_request_id::text,0));
 SELECT * INTO s FROM public.widget_control_preview_scope WHERE actor_id=auth.uid() AND channel_id=p_channel_id AND request_id=p_request_id;
 IF FOUND THEN
  SELECT session_token INTO token FROM public.visitor_session WHERE id=s.visitor_session_id;
  IF NOT public.widget_control_preview_authorize(s.conversation_id,token) THEN RAISE EXCEPTION 'preview_restore_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('session_token',token,'session_id',s.visitor_session_id,'conversation_id',s.conversation_id,'preview_contract',s.contract,'preview_revision',s.revision);
 END IF;
 token:=gen_random_uuid()::text||'.'||replace(gen_random_uuid()::text,'-','');
 tx:=public.create_widget_session_tx(p_channel_id,token,NULL,jsonb_build_object('origin',o),o);
 IF tx->>'result'<>'success' THEN RAISE EXCEPTION 'preview_session_create_failed'; END IF;
 INSERT INTO public.widget_control_preview_scope(conversation_id,visitor_session_id,actor_id,company_id,channel_id,origin,token_sha256,contract,revision,request_id)
 VALUES((tx->>'conversation_id')::uuid,(tx->>'session_id')::uuid,auth.uid(),ch.company_id,ch.id,o,encode(extensions.digest(token,'sha256'),'hex'),'ordinary-widget-control-v2','c3-preview-ce-zero-paid-v2',p_request_id);
 UPDATE public.conversations SET metadata_source=coalesce(metadata_source,'{}')||jsonb_build_object('source','ordinary_widget_control_preview','preview_contract','ordinary-widget-control-v2','preview_revision','c3-preview-ce-zero-paid-v2') WHERE id=(tx->>'conversation_id')::uuid;
 RETURN jsonb_build_object('session_token',token,'session_id',tx->>'session_id','conversation_id',tx->>'conversation_id','preview_contract','ordinary-widget-control-v2','preview_revision','c3-preview-ce-zero-paid-v2');
END $$;
REVOKE ALL ON FUNCTION public.widget_control_preview_bootstrap(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.widget_control_preview_bootstrap(uuid,uuid) TO authenticated;
CREATE FUNCTION public.widget_control_preview_seal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='messages' THEN
  IF public.widget_control_preview_excluded(OLD.conversation_id) AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN RAISE EXCEPTION 'preview_message_binding_immutable'; END IF;
 ELSE
  IF public.widget_control_preview_excluded(OLD.id) AND (NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.channel_config_id IS DISTINCT FROM OLD.channel_config_id OR NEW.visitor_session_id IS DISTINCT FROM OLD.visitor_session_id OR NEW.metadata_source->>'source' IS DISTINCT FROM 'ordinary_widget_control_preview' OR NEW.metadata_source->>'preview_contract' IS DISTINCT FROM 'ordinary-widget-control-v2') THEN RAISE EXCEPTION 'preview_binding_immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.widget_control_preview_seal() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER widget_control_preview_seal BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.widget_control_preview_seal();
CREATE TRIGGER widget_control_preview_message_seal BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.widget_control_preview_seal();
CREATE FUNCTION public.widget_control_preview_message_tx(p_conversation_id uuid,p_session_token text,p_content text,p_client_message_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE tx jsonb; outcome jsonb; source_id uuid; assistant_id uuid; existing_ids uuid[]; reply text; handoff boolean;
BEGIN
 IF NOT public.widget_control_preview_authorize(p_conversation_id,p_session_token) THEN RAISE EXCEPTION 'preview_actor_scope_denied' USING ERRCODE='42501'; END IF;
 IF p_content IS NULL OR btrim(p_content) NOT IN ('你是誰？','Who are you?','請轉真人客服','Please connect me to a human.') OR p_client_message_id IS NULL OR p_client_message_id !~ '^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION 'preview_control_input_denied' USING ERRCODE='22023'; END IF;
 -- The original transaction locks the same conversation row. All completion, cleanup and receipts commit atomically.
 tx:=public.widget_control_preview_receive_base(p_conversation_id,p_session_token,p_content,p_client_message_id);
 IF tx->>'result' NOT IN ('success','idempotent','human_control') THEN RETURN tx; END IF;
 source_id:=(tx->>'message_id')::uuid;
 IF NOT EXISTS(SELECT FROM public.messages WHERE id=source_id AND conversation_id=p_conversation_id AND role='visitor' AND content=btrim(p_content)) THEN RAISE EXCEPTION 'preview_client_message_reuse' USING ERRCODE='22023'; END IF;
 IF tx->>'result'='human_control' THEN RETURN tx||jsonb_build_object('preview_contract','ordinary-widget-control-v2','preview_revision','c3-preview-ce-zero-paid-v2','ai_reply_pending',false); END IF;
 SELECT id INTO assistant_id FROM public.messages WHERE conversation_id=p_conversation_id AND role='assistant' AND content<>'__THINKING__' AND metadata->>'source_message_id'=source_id::text AND NOT coalesce(is_recalled,false) LIMIT 1;
 IF assistant_id IS NULL THEN
  handoff:=btrim(p_content) IN ('請轉真人客服','Please connect me to a human.');
  IF handoff THEN
   reply:=CASE WHEN btrim(p_content)='請轉真人客服' THEN '已記錄你的真人客服要求，正在等待客服跟進；尚未有客服接手。' ELSE 'Your human support request is recorded and pending. An agent has not yet taken over.' END;
   SELECT coalesce(array_agg(id),'{}'::uuid[]) INTO existing_ids FROM public.messages WHERE conversation_id=p_conversation_id AND role='assistant';
   outcome:=public.explicit_handoff_tx(p_conversation_id,reply,source_id);
   IF outcome->>'result' NOT IN ('success','already_handled','already_under_human_control') THEN RAISE EXCEPTION 'preview_handoff_unconfirmed'; END IF;
   SELECT id INTO assistant_id FROM public.messages WHERE conversation_id=p_conversation_id AND role='assistant' AND NOT(id=ANY(existing_ids)) AND content=reply LIMIT 1;
   IF assistant_id IS NOT NULL THEN UPDATE public.messages SET metadata=coalesce(metadata,'{}')||jsonb_build_object('source_message_id',source_id,'preview_contract','ordinary-widget-control-v2','response_route','ordinary_preview_handoff') WHERE id=assistant_id; END IF;
  ELSE
   reply:=CASE WHEN btrim(p_content)='你是誰？' THEN '我是網站的自動客服助手，並非真人。這是受控預覽回覆，沒有查詢知識庫；你可以要求真人客服。' ELSE 'I am this site''s automated support assistant, not a human. This controlled preview response uses no Knowledge Base; you can request a human.' END;
   outcome:=public.commit_ai_reply_tx(p_conversation_id,source_id,reply,jsonb_build_object('source_message_id',source_id,'preview_contract','ordinary-widget-control-v2','response_route','ordinary_preview_identity','kb_lookup',false));
   IF outcome->>'result' NOT IN ('success','idempotent','human_control','superseded_source','resolved') THEN RAISE EXCEPTION 'preview_identity_unconfirmed'; END IF;
   assistant_id:=nullif(outcome->>'message_id','')::uuid;
  END IF;
 END IF;
 DELETE FROM public.messages WHERE conversation_id=p_conversation_id AND content='__THINKING__' AND metadata->>'source_message_id'=source_id::text;
 RETURN tx||jsonb_build_object('preview_contract','ordinary-widget-control-v2','preview_revision','c3-preview-ce-zero-paid-v2','ai_reply_pending',false,'assistant_message_id',assistant_id,'control_state',CASE WHEN EXISTS(SELECT FROM public.conversations WHERE id=p_conversation_id AND (assigned_agent_id IS NOT NULL OR status IN ('pending','transferred','human_needed','human_control','escalation_risk','unresolved'))) THEN 'human_control' ELSE 'ai' END);
END $$;
REVOKE ALL ON FUNCTION public.widget_control_preview_message_tx(uuid,text,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.widget_control_preview_message_tx(uuid,text,text,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.c3_uat_learning_excluded(p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 SELECT public.widget_control_preview_excluded(p_conversation_id) OR EXISTS(SELECT 1 FROM public.c3_uat_conversation_scope WHERE conversation_id=p_conversation_id)
$function$
;
CREATE OR REPLACE FUNCTION public.ce_mark_evaluation_dirty(p_conversation_id uuid, p_activity_at timestamp with time zone DEFAULT now())
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ DECLARE v_company uuid;BEGIN IF public.widget_control_preview_excluded(p_conversation_id) THEN RETURN; END IF; IF p_conversation_id IS NULL THEN RETURN;END IF;IF NOT EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=p_conversation_id) THEN RETURN;END IF;IF EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=p_conversation_id AND COALESCE(c.metadata_source->>'source','')='widget_live_test' AND COALESCE((c.metadata_source->>'widget_live_test')::boolean,false)=true AND COALESCE((c.metadata_source->>'exclude_training')::boolean,false)=true) THEN RETURN;END IF;v_company:=public.ce_runtime_conversation_company(p_conversation_id);INSERT INTO public.ce_evaluation_state(conversation_id,company_id,state,revision,dirty_since,last_activity_at,updated_at) VALUES(p_conversation_id,v_company,'never_evaluated',1,now(),COALESCE(p_activity_at,now()),now()) ON CONFLICT(conversation_id) DO UPDATE SET company_id=EXCLUDED.company_id,revision=public.ce_evaluation_state.revision+1,state=CASE WHEN public.ce_evaluation_state.last_success_evaluation_id IS NULL THEN 'never_evaluated' ELSE 'dirty' END,dirty_since=COALESCE(public.ce_evaluation_state.dirty_since,now()),last_activity_at=GREATEST(COALESCE(public.ce_evaluation_state.last_activity_at,'-infinity'::timestamptz),COALESCE(EXCLUDED.last_activity_at,now())),queued_at=NULL,evaluating_started_at=NULL,last_error_code=NULL,updated_at=now();END;$function$
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
begin IF public.widget_control_preview_excluded(p_conversation_id) THEN RETURN jsonb_build_object('result','preview_excluded'); END IF;
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
 IF public.widget_control_preview_excluded(p_conversation_id) THEN RETURN public.widget_control_preview_message_tx(p_conversation_id,p_session_token,p_content,p_client_message_id); END IF;
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
DROP TRIGGER trg_zz_ce_realtime_assistant_dispatch ON public.messages;
CREATE TRIGGER trg_zz_ce_realtime_assistant_dispatch AFTER INSERT ON public.messages FOR EACH ROW WHEN (NOT public.widget_control_preview_excluded(new.conversation_id)) EXECUTE FUNCTION ce_realtime_assistant_message_trigger_v1();
COMMIT;
