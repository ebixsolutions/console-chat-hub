-- Same Task3C / PR #12. Authorized B fallback for the existing UAT KB50 Company.
-- No new table, backend, Edge Function, Auth user, Company, Channel or KB key.
-- This temporary entry point is withdrawn at release. Original RPC stays private.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='60s';
DO $pre$
BEGIN
  IF to_regprocedure('public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'KB_BINDING_SELF_ALREADY_EXISTS_REVIEW';
  END IF;
  IF to_regprocedure('public.kb_binding_write_v1(uuid,uuid,text,text,boolean,bigint,text)') IS NULL
     OR md5(pg_get_functiondef('public.kb_binding_write_v1(uuid,uuid,text,text,boolean,bigint,text)'::regprocedure)) <> '9a3ef696f9316d6aa6883122e17c4530'
     OR has_function_privilege('authenticated','public.kb_binding_write_v1(uuid,uuid,text,text,boolean,bigint,text)','EXECUTE')
  THEN RAISE EXCEPTION 'KB_BINDING_SELF_INNER_PREIMAGE_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.company WHERE id='bdb07806-be44-499c-bfcb-b08afac2d213' AND is_active)
  THEN RAISE EXCEPTION 'KB_BINDING_SELF_UAT_COMPANY_UNAVAILABLE'; END IF;
END $pre$;
CREATE FUNCTION public.kb_binding_write_self_v1(
  p_company uuid, p_tenant text, p_kb_company text, p_active boolean,
  p_expected_revision bigint, p_new_key text DEFAULT NULL, p_probe boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR (auth.jwt()->>'role') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'KB_BINDING_SELF_AUTH_REQUIRED' USING ERRCODE='42501';
  END IF;
  -- Exact development Company scope approved in this Task3C continuation.
  -- No email/actor allowlist: additional legitimate Admins of this Company work.
  -- Never expose the original caller-supplied p_actor RPC to authenticated.
  IF p_company IS DISTINCT FROM 'bdb07806-be44-499c-bfcb-b08afac2d213'::uuid
     OR p_tenant IS DISTINCT FROM '50' OR p_probe IS NULL
     OR p_active IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'KB_BINDING_SELF_SCOPE_DENIED' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership cm
    JOIN public.company co ON co.id=cm.company_id AND co.is_active
    JOIN public.user_roles ur ON ur.user_id=cm.user_id AND ur.role='admin'::public.app_role
    WHERE cm.user_id=v_actor AND cm.company_id=p_company AND cm.is_active AND cm.role='admin'::public.app_role
  ) OR NOT EXISTS (
    SELECT 1 FROM public.channel_config ch WHERE ch.company_id=p_company
    AND ch.id='99b7e832-0da8-4a44-8738-2e5fe9cb9685'::uuid
    AND ch.is_active AND ch.channel_type='web_widget'
  ) THEN RAISE EXCEPTION 'KB_BINDING_SELF_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF p_probe THEN
    IF p_new_key IS NOT NULL OR p_kb_company IS NOT NULL OR p_active OR p_expected_revision <> 0
    THEN RAISE EXCEPTION 'KB_BINDING_SELF_INVALID_PROBE' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('contract','kb-binding-self-v1','eligible',true,
      'company_id',p_company,'actor_id',v_actor,'saved',false);
  END IF;
  -- Serialize initial insert as well as update. Existing inner CAS is unchanged.
  PERFORM pg_advisory_xact_lock(hashtextextended('kb_binding_self:'||p_company::text,0));
  v_result := public.kb_binding_write_v1(v_actor,p_company,p_tenant,p_kb_company,
    p_active,p_expected_revision,p_new_key);
  IF v_result->>'company_id' IS DISTINCT FROM p_company::text
     OR v_result->>'kb_tenant_id' IS DISTINCT FROM p_tenant
     OR (v_result->>'is_active')::boolean IS DISTINCT FROM p_active
     OR (v_result->>'revision')::bigint IS DISTINCT FROM p_expected_revision+1
     OR (p_active AND (v_result->>'has_key')::boolean IS DISTINCT FROM true)
  THEN RAISE EXCEPTION 'KB_BINDING_SELF_POSTIMAGE_MISMATCH'; END IF;
  RETURN v_result;
END $fn$;
REVOKE ALL ON FUNCTION public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean)
 FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean)
 TO authenticated;
COMMENT ON FUNCTION public.kb_binding_write_self_v1(uuid,text,text,boolean,bigint,text,boolean)
 IS 'Task3C temporary UAT KB50 self-service write: JWT auth.uid, same-Company Admin, active Channel, original Vault/CAS. Probe is eligibility, never Save PASS. Revoke/drop at release.';
COMMIT;
