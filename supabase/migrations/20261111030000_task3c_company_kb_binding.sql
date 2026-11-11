-- AI-ABC-C3 / same Task3C / PR #12. SOURCE ONLY; NOT a Production deployment authorization.
-- One Company -> Singapore KB tenant mapping table. Never store plaintext API keys.
BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '90s';
DO $pre$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='supabase_vault')
    OR to_regclass('vault.secrets') IS NULL THEN
    RAISE EXCEPTION 'KB_BINDING_VAULT_UNAVAILABLE';
  END IF;
  IF to_regclass('public.company_kb_tenant_binding') IS NOT NULL THEN
    RAISE EXCEPTION 'KB_BINDING_TABLE_ALREADY_EXISTS_INSPECT_FIRST';
  END IF;
END $pre$;

CREATE TABLE public.company_kb_tenant_binding (
  company_id uuid PRIMARY KEY REFERENCES public.company(id) ON DELETE RESTRICT,
  kb_tenant_id text NOT NULL CHECK (kb_tenant_id ~ '^[1-9][0-9]{0,15}$'),
  kb_company_id text NULL CHECK (kb_company_id IS NULL OR (length(kb_company_id) BETWEEN 1 AND 80 AND kb_company_id !~ '[[:cntrl:]]')),
  api_key_secret_ref uuid NULL,
  is_active boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by uuid NOT NULL REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  audit_history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(audit_history) = 'array'),
  CONSTRAINT kb_binding_active_requires_key CHECK (NOT is_active OR api_key_secret_ref IS NOT NULL)
);
ALTER TABLE public.company_kb_tenant_binding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.company_kb_tenant_binding FROM PUBLIC, anon, authenticated;
GRANT SELECT (company_id,kb_tenant_id,kb_company_id,is_active,revision,updated_by,updated_at)
  ON public.company_kb_tenant_binding TO authenticated;
CREATE POLICY kb_binding_admin_same_company_read ON public.company_kb_tenant_binding
FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.company_membership cm
    JOIN public.company co ON co.id = cm.company_id AND co.is_active
    JOIN public.user_roles ur ON ur.user_id = cm.user_id AND ur.role = 'admin'::public.app_role
    WHERE cm.user_id = (SELECT auth.uid())
      AND cm.company_id = company_kb_tenant_binding.company_id
      AND cm.is_active AND cm.role = 'admin'::public.app_role
  )
);
-- No direct INSERT/UPDATE/DELETE grant or policy for browser roles.
-- A separate server-authorized action invokes this RPC using service_role only.
CREATE FUNCTION public.kb_binding_write_v1(
  p_actor uuid,
  p_company uuid,
  p_tenant text,
  p_kb_company text,
  p_active boolean,
  p_expected_revision bigint,
  p_new_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_old public.company_kb_tenant_binding%ROWTYPE;
  v_key uuid;
  v_revision bigint;
  v_event jsonb;
  v_history jsonb;
BEGIN
  IF p_actor IS NULL OR p_company IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
     OR p_tenant IS NULL OR p_tenant !~ '^[1-9][0-9]{0,15}$'
     OR (p_kb_company IS NOT NULL AND (length(p_kb_company) NOT BETWEEN 1 AND 80 OR p_kb_company ~ '[[:cntrl:]]')) THEN
    RAISE EXCEPTION 'KB_BINDING_INVALID_INPUT';
  END IF;
  -- Actor derives from verified Supabase Auth on the server. Never from the UI payload.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership cm
    JOIN public.company co ON co.id = cm.company_id AND co.is_active
    JOIN public.user_roles ur ON ur.user_id = cm.user_id AND ur.role = 'admin'::public.app_role
    WHERE cm.user_id = p_actor AND cm.company_id = p_company
      AND cm.is_active AND cm.role = 'admin'::public.app_role
  ) OR NOT EXISTS (
    SELECT 1 FROM public.channel_config ch
    WHERE ch.company_id = p_company AND ch.is_active AND ch.channel_type = 'web_widget'
  ) THEN RAISE EXCEPTION 'KB_BINDING_FORBIDDEN_OR_NO_ACTIVE_CHANNEL'; END IF;
  IF p_new_key IS NOT NULL AND
     (length(p_new_key) < 16 OR length(p_new_key) > 4096 OR p_new_key ~ '[[:cntrl:]]'
      OR p_new_key <> btrim(p_new_key)) THEN
    RAISE EXCEPTION 'KB_BINDING_INVALID_KEY_FORMAT';
  END IF;
  SELECT * INTO v_old FROM public.company_kb_tenant_binding
    WHERE company_id = p_company FOR UPDATE;
  IF FOUND THEN
    IF v_old.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'KB_BINDING_REVISION_CONFLICT';
    END IF;
    v_key := v_old.api_key_secret_ref;
    IF p_new_key IS NOT NULL THEN
      IF v_key IS NULL THEN
        v_key := vault.create_secret(p_new_key, 'chatbot_kb_' || p_company::text,
          'Tenant-bound Singapore KB API key (never returned to browser)');
      ELSE
        PERFORM vault.update_secret(v_key, p_new_key, NULL, NULL, NULL);
      END IF;
    END IF;
    IF p_active AND v_key IS NULL THEN RAISE EXCEPTION 'KB_BINDING_KEY_REQUIRED'; END IF;
    v_event := jsonb_build_object('revision',v_old.revision,'at',now(),
      'actor',p_actor,'tenant_before',v_old.kb_tenant_id,'active_before',v_old.is_active,
      'key_rotated',(p_new_key IS NOT NULL));
    SELECT COALESCE(jsonb_agg(item ORDER BY ord DESC),'[]'::jsonb) INTO v_history
    FROM (
      SELECT item,ord FROM jsonb_array_elements(v_old.audit_history || jsonb_build_array(v_event))
        WITH ORDINALITY AS t(item,ord) ORDER BY ord DESC LIMIT 20
    ) last20;
    UPDATE public.company_kb_tenant_binding SET kb_tenant_id=p_tenant,
      kb_company_id=p_kb_company,is_active=p_active,api_key_secret_ref=v_key,
      revision=revision+1,updated_by=p_actor,updated_at=now(),audit_history=v_history
    WHERE company_id=p_company AND revision=p_expected_revision
    RETURNING revision INTO v_revision;
    IF v_revision IS NULL THEN RAISE EXCEPTION 'KB_BINDING_REVISION_CONFLICT'; END IF;
  ELSE
    IF p_expected_revision <> 0 THEN RAISE EXCEPTION 'KB_BINDING_REVISION_CONFLICT'; END IF;
    IF p_new_key IS NOT NULL THEN
      v_key := vault.create_secret(p_new_key, 'chatbot_kb_' || p_company::text,
        'Tenant-bound Singapore KB API key (never returned to browser)');
    END IF;
    IF p_active AND v_key IS NULL THEN RAISE EXCEPTION 'KB_BINDING_KEY_REQUIRED'; END IF;
    INSERT INTO public.company_kb_tenant_binding
      (company_id,kb_tenant_id,kb_company_id,is_active,api_key_secret_ref,revision,updated_by)
    VALUES (p_company,p_tenant,p_kb_company,p_active,v_key,1,p_actor);
    v_revision := 1;
  END IF;
  RETURN jsonb_build_object('company_id',p_company,'kb_tenant_id',p_tenant,
    'kb_company_id',p_kb_company,'is_active',p_active,'revision',v_revision,
    'has_key',(v_key IS NOT NULL));
END $fn$;
REVOKE ALL ON FUNCTION public.kb_binding_write_v1(uuid,uuid,text,text,boolean,bigint,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_binding_write_v1(uuid,uuid,text,text,boolean,bigint,text)
  TO service_role;

-- The one privileged RAG credential accessor; exact Company+Tenant binding must match.
-- No browser role can execute it, and it never returns a key to the binding UI.
CREATE FUNCTION public.kb_binding_secret_v1(p_company uuid,p_tenant text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_secret text;
BEGIN
  SELECT ds.decrypted_secret INTO v_secret
  FROM public.company_kb_tenant_binding b
  JOIN public.company co ON co.id=b.company_id AND co.is_active
  JOIN vault.decrypted_secrets ds ON ds.id=b.api_key_secret_ref
  WHERE b.company_id=p_company AND b.kb_tenant_id=p_tenant AND b.is_active
    AND b.api_key_secret_ref IS NOT NULL;
  IF v_secret IS NULL OR length(v_secret) < 16 THEN
    RAISE EXCEPTION 'KB_BINDING_CREDENTIAL_UNAVAILABLE';
  END IF;
  RETURN v_secret;
END $fn$;
REVOKE ALL ON FUNCTION public.kb_binding_secret_v1(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kb_binding_secret_v1(uuid,text) TO service_role;
COMMIT;