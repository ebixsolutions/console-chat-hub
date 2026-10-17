\set ON_ERROR_STOP on
-- Disposable local Docker Auth CI only. Never applied to production.
BEGIN;
CREATE TABLE public.c3_uat_channel_scope (
 channel_id uuid PRIMARY KEY REFERENCES public.channel_config(id),
 company_id uuid NOT NULL UNIQUE REFERENCES public.company(id),
 run_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
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
ALTER TABLE public.c3_uat_channel_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.c3_uat_feedback_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.c3_uat_channel_scope, public.c3_uat_feedback_config FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.c3_uat_feedback_company(text[]),public.c3_uat_feedback_config_context() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.c3_uat_feedback_config_context() TO authenticated;
COMMIT;
NOTIFY pgrst, 'reload schema';
