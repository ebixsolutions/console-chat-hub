-- SAME AI-ABC-C3 / Task3C / one authoritative Supabase project.
-- SOURCE ONLY. No live SQL/DDL/Production deployment without separately authorized exact scope.
-- Dev/UAT original Preview ONLY: atomic *new* Company + first Admin + private Widget + KB Vault binding.
-- Existing tenant staff must use original kb_binding_invite_grant_v1; no extra Company for same KB.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='60s';
DO $pre$
BEGIN
  IF to_regprocedure('public.kb_binding_dev_bootstrap_v1(uuid,uuid,text,text,text,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_ALREADY_EXISTS_REVIEW_FIRST';
  END IF;
  IF to_regclass('public.company_kb_tenant_binding') IS NULL
     OR to_regclass('vault.secrets') IS NULL THEN
    RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_EXISTING_DEPENDENCY_REQUIRED';
  END IF;
END $pre$;
CREATE FUNCTION public.kb_binding_dev_bootstrap_v1(
  p_actor uuid,
  p_target uuid,
  p_tenant text,
  p_display_name text,
  p_new_key text,
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_company uuid := gen_random_uuid();
  v_channel uuid := gen_random_uuid();
  v_widget uuid := gen_random_uuid();
  v_platform_id bigint;
  v_ref uuid;
  v_prior record;
BEGIN
  IF p_actor IS NULL OR p_target IS NULL OR p_request_id IS NULL
     OR p_actor=p_target OR p_tenant !~ '^[1-9][0-9]{0,15}$'
     OR length(btrim(coalesce(p_display_name,''))) NOT BETWEEN 3 AND 80
     OR p_display_name ~ '[[:cntrl:]]'
     OR length(coalesce(p_new_key,'')) NOT BETWEEN 16 AND 4096
     OR p_new_key <> btrim(p_new_key) OR p_new_key ~ '[[:cntrl:]]'
  THEN RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_INVALID_INPUT'; END IF;
  -- Exact legitimate original development Owner + sole original Company.
  -- No arbitrary Company Admin can create cross-tenant grants.
  IF p_actor <> '3bdf936e-b543-41d8-9fff-fa020a85f3f6'::uuid OR NOT EXISTS (
    SELECT 1 FROM public.company_membership cm
    JOIN public.user_roles ur ON ur.user_id=cm.user_id AND ur.role='admin'::public.app_role
    JOIN public.company co ON co.id=cm.company_id AND co.is_active
    JOIN public.channel_config ch ON ch.company_id=co.id AND ch.is_active AND ch.channel_type='web_widget'
    WHERE cm.user_id=p_actor AND cm.company_id='3d6e17b5-ec79-4f75-aa7f-eaa824ff8493'::uuid
      AND cm.is_active AND cm.role='admin'::public.app_role
  ) THEN RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_ACTOR_DENIED'; END IF;
  -- Serialize all bootstrap identities/tenant checks and generated synthetic IDs.
  PERFORM pg_advisory_xact_lock(5026111150);
  SELECT b.company_id,b.kb_tenant_id,b.is_active,ch.id AS channel_id,
         cm.user_id AS target_user, co.is_active AS company_active
  INTO v_prior
  FROM public.company_kb_tenant_binding b
  JOIN public.company co ON co.id=b.company_id
  JOIN public.company_membership cm ON cm.company_id=b.company_id
    AND cm.user_id=p_target AND cm.is_active AND cm.role='admin'::public.app_role
  JOIN public.channel_config ch ON ch.company_id=b.company_id AND ch.is_active
    AND ch.channel_type='web_widget'
  WHERE b.audit_history @> jsonb_build_array(jsonb_build_object(
      'event','dev_kb_bootstrap','request_id',p_request_id::text))
  LIMIT 1;
  IF FOUND THEN
    IF v_prior.kb_tenant_id<>p_tenant OR v_prior.target_user<>p_target
       OR v_prior.is_active IS DISTINCT FROM true OR v_prior.company_active IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_REQUEST_REUSE_CONFLICT'; END IF;
    RETURN jsonb_build_object('company_id',v_prior.company_id,'channel_id',v_prior.channel_id,
      'user_id',v_prior.target_user,'kb_tenant_id',v_prior.kb_tenant_id,
      'has_key',true,'is_active',true,'revision',1,'idempotent_replay',true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id=p_target AND u.email_confirmed_at IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.company_membership cm WHERE cm.user_id=p_target
  ) OR EXISTS (
    SELECT 1 FROM public.user_roles ur WHERE ur.user_id=p_target
  ) THEN RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_TARGET_ALREADY_SCOPED_OR_INVALID'; END IF;
  -- Distinct KB tenant may not be silently re-used by another Company.
  IF EXISTS (SELECT 1 FROM public.company_kb_tenant_binding b WHERE b.kb_tenant_id=p_tenant)
  THEN RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_TENANT_ALREADY_BOUND'; END IF;
  v_platform_id := (SELECT COALESCE(MAX(platform_company_id),0)+1 FROM public.company);
  IF v_platform_id<1 OR EXISTS (
    SELECT 1 FROM public.company co WHERE co.platform_company_id=v_platform_id
  ) THEN RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_SYNTHETIC_PLATFORM_ID_CONFLICT'; END IF;
  INSERT INTO public.company(id,slug,display_name,external_workspace_id,
    external_tenant_id,platform_company_id,is_active)
  VALUES(v_company,
    'c3-kb-'||replace(v_company::text,'-',''),
    btrim(p_display_name),
    'c3-dev-uat-'||v_company::text,
    'c3-dev-kb-'||p_tenant||'-'||v_company::text,
    v_platform_id,true);
  INSERT INTO public.user_roles(user_id,role)
  VALUES(p_target,'admin'::public.app_role);
  INSERT INTO public.company_membership(company_id,user_id,role,is_active)
  VALUES(v_company,p_target,'admin'::public.app_role,true);
  INSERT INTO public.widget_config(id,name,header_title,is_active)
  VALUES(v_widget,'C3 KB '||p_tenant||' Dev Widget',
    'Development KB '||p_tenant,true);
  INSERT INTO public.channel_config(id,name,channel_type,widget_config_id,company_id,
    is_active,allowed_origins)
  VALUES(v_channel,'C3 KB '||p_tenant||' Private Widget','web_widget',
    v_widget,v_company,true,
    ARRAY['https://id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app',
          'https://4dbf593e-577e-4af4-a553-460441c34473.lovableproject.com']::text[]);
  v_ref := vault.create_secret(p_new_key,
    'chatbot_kb_'||v_company::text||'_'||substr(gen_random_uuid()::text,1,12),
    'C3 tenant-bound development KB key; write-only; not returned');
  INSERT INTO public.company_kb_tenant_binding
    (company_id,kb_tenant_id,kb_company_id,is_active,api_key_secret_ref,
     revision,updated_by,audit_history)
  VALUES(v_company,p_tenant,NULL,true,v_ref,1,p_actor,
     jsonb_build_array(jsonb_build_object('event','dev_kb_bootstrap',
       'request_id',p_request_id::text,'actor',p_actor,'target_user',p_target,
       'at',now(),'synthetic_platform_id',true)));
  IF NOT EXISTS (SELECT 1 FROM public.company_kb_tenant_binding b
    JOIN public.company_membership cm ON cm.company_id=b.company_id
      AND cm.user_id=p_target AND cm.is_active AND cm.role='admin'::public.app_role
    JOIN public.channel_config ch ON ch.company_id=b.company_id AND ch.id=v_channel
      AND ch.is_active AND ch.channel_type='web_widget'
    WHERE b.company_id=v_company AND b.kb_tenant_id=p_tenant AND b.is_active
      AND b.api_key_secret_ref=v_ref AND b.revision=1
  ) THEN RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_ATOMIC_READBACK_FAILED'; END IF;
  RETURN jsonb_build_object('company_id',v_company,'channel_id',v_channel,
    'user_id',p_target,'kb_tenant_id',p_tenant,'has_key',true,
    'is_active',true,'revision',1,'idempotent_replay',false);
END $fn$;
REVOKE ALL ON FUNCTION public.kb_binding_dev_bootstrap_v1(uuid,uuid,text,text,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_binding_dev_bootstrap_v1(uuid,uuid,text,text,text,uuid)
  TO service_role;
COMMIT;
