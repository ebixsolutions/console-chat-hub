-- C3-A773-CONSOLIDATED-REPAIR-AUTH-20261006-v1; conditional guarded scope.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.c3_uat_feedback_config') IS NOT NULL THEN RAISE EXCEPTION 'Compare existing objects; do not replace'; END IF;
 IF to_regclass('public.c3_uat_channel_scope') IS NULL THEN RAISE EXCEPTION 'B12 registry required'; END IF;
 IF md5(pg_get_functiondef('public.claim_feedback_delivery_tx()'::regprocedure)) IS DISTINCT FROM nullif(current_setting('c3.expected_claim_md5',true),'') THEN RAISE EXCEPTION 'Missing/current normal claim baseline drift'; END IF;
END $$;
CREATE TABLE public.c3_uat_feedback_config (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 company_id uuid NOT NULL UNIQUE REFERENCES public.company(id),
 channel_id uuid NOT NULL UNIQUE REFERENCES public.c3_uat_channel_scope(channel_id),
 name text NOT NULL DEFAULT 'C3 isolated feedback',
 is_active boolean NOT NULL DEFAULT false,
 delay_minutes integer NOT NULL DEFAULT 1440 CHECK(delay_minutes BETWEEN 1440 AND 43200),
 trigger_event text NOT NULL DEFAULT 'conversation_resolved' CHECK(trigger_event='conversation_resolved'),
 config jsonb NOT NULL DEFAULT '{"channels_enabled":["website_widget"],"rating_type":"stars_1_5"}'::jsonb,
 CHECK(coalesce(config->'channels_enabled'='["website_widget"]'::jsonb AND config->>'rating_type' IN ('stars_1_5','csat','nps','thumbs','ces','survey'),false))
);
ALTER TABLE public.c3_uat_feedback_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.c3_uat_feedback_config FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.feedback_request ADD COLUMN c3_uat_config_id uuid REFERENCES public.c3_uat_feedback_config(id);
CREATE UNIQUE INDEX c3_uat_feedback_dedupe ON public.feedback_request(conversation_id,c3_uat_config_id) WHERE c3_uat_config_id IS NOT NULL;
CREATE FUNCTION public.c3_uat_feedback_company(p_roles text[]) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_company uuid; n integer;
BEGIN
 SELECT count(DISTINCT cm.company_id),min(cm.company_id::text)::uuid INTO n,v_company FROM public.company_membership cm JOIN public.company co ON co.id=cm.company_id JOIN public.agent_profile ap ON ap.user_id=cm.user_id WHERE cm.user_id=auth.uid() AND cm.is_active AND co.is_active AND ap.status='active' ;
 IF NOT EXISTS(SELECT 1 FROM public.company_membership cm WHERE cm.company_id=v_company AND cm.user_id=auth.uid() AND cm.is_active AND cm.role::text=ANY(p_roles)) THEN RAISE EXCEPTION 'Trusted role required' USING ERRCODE='42501'; END IF;
 IF n<>1 THEN RAISE EXCEPTION 'Trusted active single tenant required' USING ERRCODE='42501'; END IF;
 RETURN v_company;
END $$;
CREATE FUNCTION public.c3_uat_feedback_config_context() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_company uuid; cfg jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.company_membership cm JOIN public.c3_uat_channel_scope s ON s.company_id=cm.company_id WHERE cm.user_id=auth.uid() AND cm.is_active) THEN RETURN jsonb_build_object('isolated',false); END IF;
 v_company:=public.c3_uat_feedback_company(ARRAY['admin','supervisor','qa']);
 IF NOT EXISTS(SELECT 1 FROM public.c3_uat_channel_scope WHERE company_id=v_company) THEN RETURN jsonb_build_object('isolated',false); END IF;
 SELECT to_jsonb(c) INTO cfg FROM public.c3_uat_feedback_config c WHERE company_id=v_company;
 RETURN jsonb_build_object('isolated',true,'config',cfg);
END $$;
CREATE FUNCTION public.c3_uat_save_feedback_config(p_patch jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_company uuid; v_channel uuid; cfg jsonb;
BEGIN
 v_company:=public.c3_uat_feedback_company(ARRAY['admin','supervisor']);
 SELECT channel_id INTO v_channel FROM public.c3_uat_channel_scope WHERE company_id=v_company;
 IF v_channel IS NULL THEN RAISE EXCEPTION 'Isolated registry required'; END IF;
 IF (p_patch ? 'company_id' AND p_patch->>'company_id' IS DISTINCT FROM v_company::text)
    OR (p_patch ? 'channel_id' AND p_patch->>'channel_id' IS DISTINCT FROM v_channel::text) THEN
   RAISE EXCEPTION 'Config scope spoof denied' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.c3_uat_feedback_config(company_id,channel_id,is_active,delay_minutes,config)
 VALUES(v_company,v_channel,coalesce((p_patch->>'is_active')::boolean,false),coalesce((p_patch->>'delay_minutes')::integer,1440),coalesce(p_patch->'config','{"channels_enabled":["website_widget"],"rating_type":"stars_1_5"}'::jsonb))
 ON CONFLICT(company_id) DO UPDATE SET is_active=coalesce((p_patch->>'is_active')::boolean,c3_uat_feedback_config.is_active),delay_minutes=coalesce((p_patch->>'delay_minutes')::integer,c3_uat_feedback_config.delay_minutes),config=coalesce(p_patch->'config',c3_uat_feedback_config.config);
 SELECT to_jsonb(c) INTO cfg FROM public.c3_uat_feedback_config c WHERE company_id=v_company;
 IF NOT (cfg->>'is_active')::boolean THEN
   UPDATE public.feedback_request fr SET status='skipped',updated_at=now()
   WHERE fr.c3_uat_config_id=(cfg->>'id')::uuid AND fr.status='pending'
     AND fr.delivery_status IN ('pending','token_generated');
 END IF;
 RETURN jsonb_build_object('isolated',true,'config',cfg);
END $$;
CREATE FUNCTION public.c3_uat_feedback_request_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.c3_uat_feedback_config%rowtype;
BEGIN
 PERFORM 1 FROM public.conversations WHERE id=NEW.conversation_id FOR UPDATE;
 IF TG_OP='UPDATE' AND public.c3_uat_learning_excluded(OLD.conversation_id)
    AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
   RAISE EXCEPTION 'Synthetic conversation reassignment denied' USING ERRCODE='42501';
 END IF;
 IF NOT public.c3_uat_learning_excluded(NEW.conversation_id) THEN
  IF NEW.c3_uat_config_id IS NOT NULL THEN RAISE EXCEPTION 'Scope spoof denied'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND (
   NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR
   NEW.visitor_session_id IS DISTINCT FROM OLD.visitor_session_id OR
   NEW.c3_uat_config_id IS DISTINCT FROM OLD.c3_uat_config_id OR
   NEW.channel IS DISTINCT FROM OLD.channel OR NEW.recipient_email IS NOT NULL OR
   NEW.config_version_id IS NOT NULL OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
 ) THEN RAISE EXCEPTION 'Synthetic delivery scope mutation denied' USING ERRCODE='42501'; END IF;
 SELECT f.* INTO cfg FROM public.c3_uat_feedback_config f JOIN public.c3_uat_conversation_scope s ON s.company_id=f.company_id AND s.channel_id=f.channel_id WHERE s.conversation_id=NEW.conversation_id;
 IF NOT FOUND THEN
   IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Synthetic config missing'; END IF;
   RETURN NULL;
 END IF;
 IF NOT cfg.is_active AND TG_OP='INSERT' THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.conversations c JOIN public.visitor_session vs ON vs.id=c.visitor_session_id WHERE c.id=NEW.conversation_id AND c.company_id=cfg.company_id AND c.channel_config_id=cfg.channel_id AND vs.channel_config_id=cfg.channel_id AND NEW.visitor_session_id=vs.id) THEN RAISE EXCEPTION 'Synthetic session/channel scope mismatch'; END IF;
 IF TG_OP='UPDATE' THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.feedback_request WHERE conversation_id=NEW.conversation_id AND c3_uat_config_id=cfg.id) THEN RETURN NULL; END IF;
 NEW.c3_uat_config_id:=cfg.id; NEW.config_version_id:=NULL; NEW.channel:='website_widget'; NEW.rating_type:=cfg.config->>'rating_type'; NEW.recipient_email:=NULL; NEW.scheduled_at:=now()+make_interval(mins=>cfg.delay_minutes);
 RETURN NEW;
END $$;
CREATE TRIGGER c3_uat_feedback_request_guard BEFORE INSERT OR UPDATE ON public.feedback_request FOR EACH ROW EXECUTE FUNCTION public.c3_uat_feedback_request_guard();
CREATE FUNCTION public.c3_uat_schedule_feedback(p_conversation_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_company uuid; v public.conversations%rowtype; request_id uuid;
BEGIN
 IF NOT public.c3_uat_learning_excluded(p_conversation_id) THEN RETURN jsonb_build_object('isolated',false); END IF;
 v_company:=public.c3_uat_feedback_company(ARRAY['admin','supervisor','agent','qa']);
 SELECT * INTO v FROM public.conversations WHERE id=p_conversation_id AND company_id=v_company FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Conversation outside trusted tenant' USING ERRCODE='42501'; END IF;
 IF NOT public.c3_uat_learning_excluded(v.id) THEN RETURN jsonb_build_object('isolated',false); END IF;
 IF v.status<>'resolved' THEN RETURN jsonb_build_object('isolated',true,'created','[]'::jsonb,'skipped_reason','not_resolved'); END IF;
 INSERT INTO public.feedback_request(conversation_id,visitor_session_id,status,delivery_status,channel,scheduled_at) VALUES(v.id,v.visitor_session_id,'pending','pending','website_widget',now()) RETURNING id INTO request_id;
 RETURN jsonb_build_object('isolated',true,'created',CASE WHEN request_id IS NULL THEN '[]'::jsonb ELSE '["website_widget"]'::jsonb END,'skipped_reason',CASE WHEN request_id IS NULL THEN 'disabled_or_already_scheduled' ELSE NULL END);
END $$;
CREATE FUNCTION public.c3_uat_claim_feedback_delivery(p_company_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.c3_uat_channel_scope WHERE company_id=p_company_id) THEN RAISE EXCEPTION 'Unregistered company'; END IF;
 SELECT fr.id,fr.conversation_id,c.company_id,fr.channel,fr.rating_type INTO v FROM public.feedback_request fr JOIN public.conversations c ON c.id=fr.conversation_id JOIN public.c3_uat_conversation_scope s ON s.conversation_id=c.id AND s.company_id=c.company_id JOIN public.c3_uat_feedback_config cfg ON cfg.id=fr.c3_uat_config_id AND cfg.company_id=s.company_id AND cfg.channel_id=s.channel_id
 JOIN public.visitor_session vs ON vs.id=fr.visitor_session_id AND vs.id=c.visitor_session_id AND vs.channel_config_id=cfg.channel_id
 WHERE cfg.is_active AND c.channel_config_id=cfg.channel_id AND s.company_id=p_company_id AND fr.status='pending' AND fr.channel='website_widget' AND fr.recipient_email IS NULL AND coalesce(fr.scheduled_at,fr.created_at)<=now() AND (fr.delivery_status='pending' OR (fr.delivery_status='token_generated' AND fr.response_token_hash IS NULL AND fr.updated_at<now()-interval '5 minutes')) ORDER BY fr.scheduled_at,fr.id FOR UPDATE OF fr SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('result','none'); END IF;
 UPDATE public.feedback_request SET delivery_status='token_generated',delivery_error_type=NULL,updated_at=now() WHERE id=v.id;
 RETURN jsonb_build_object('result','claimed','feedback_request_id',v.id,'conversation_id',v.conversation_id,'company_id',v.company_id,'channel',v.channel,'rating_type',v.rating_type);
END $$;
REVOKE ALL ON FUNCTION public.c3_uat_feedback_company(text[]),public.c3_uat_feedback_config_context(),public.c3_uat_save_feedback_config(jsonb),public.c3_uat_feedback_request_guard(),public.c3_uat_schedule_feedback(uuid),public.c3_uat_claim_feedback_delivery(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.c3_uat_feedback_config_context(),public.c3_uat_save_feedback_config(jsonb),public.c3_uat_schedule_feedback(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.c3_uat_claim_feedback_delivery(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.claim_feedback_delivery_tx()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v record; v_now timestamptz := now();
BEGIN
  SELECT fr.id,fr.conversation_id,c.company_id,fr.channel,fr.rating_type
  INTO v
  FROM public.feedback_request fr
  JOIN public.conversations c ON c.id=fr.conversation_id
  WHERE NOT public.c3_uat_learning_excluded(c.id)
    AND fr.status='pending'
    AND COALESCE(fr.scheduled_at,fr.created_at) <= v_now
    AND (
      fr.delivery_status='pending' OR
      (fr.delivery_status='token_generated' AND fr.response_token_hash IS NULL
       AND fr.updated_at < v_now - interval '5 minutes')
    )
  ORDER BY COALESCE(fr.scheduled_at,fr.created_at),fr.created_at,fr.id
  FOR UPDATE OF fr SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN RETURN jsonb_build_object('result','none'); END IF;

  UPDATE public.feedback_request
  SET delivery_status='token_generated',delivery_error_type=NULL,updated_at=v_now
  WHERE id=v.id;

  RETURN jsonb_build_object(
    'result','claimed','feedback_request_id',v.id,'conversation_id',v.conversation_id,
    'company_id',v.company_id,'channel',v.channel,'rating_type',v.rating_type
  );
END
$function$;
CREATE FUNCTION public.c3_uat_isolation_fingerprint() RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT md5(jsonb_build_object('tables',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relrowsecurity,c.relacl::text,(SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped),(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid=c.oid)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('c3_uat_channel_scope','c3_uat_conversation_scope','c3_uat_feedback_config')),'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'c3_uat_%' AND p.proname<>'c3_uat_isolation_fingerprint'),'feedback_column',(SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull,attacl::text)) FROM pg_attribute WHERE attrelid='public.feedback_request'::regclass AND attname='c3_uat_config_id' AND NOT attisdropped),'feedback_constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.feedback_request'::regclass AND conname LIKE '%c3_uat%'),'feedback_index',(SELECT pg_get_indexdef(to_regclass('public.c3_uat_feedback_dedupe'))),'legacy_acls',(SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proacl::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.oid IN ('public.claim_feedback_delivery_tx()'::regprocedure,'public.hf3_refresh_learning_case_tx(uuid)'::regprocedure)),'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgname LIKE '%c3_uat%'))::text)
$$;
REVOKE ALL ON FUNCTION public.c3_uat_isolation_fingerprint() FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
