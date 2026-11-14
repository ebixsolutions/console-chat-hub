-- AI-ABC-C3 / SAME Task3C. Source rollback only; Production execution needs exact Director authorization.
-- Reverses schema ONLY if no customer mapping/secret has ever been stored.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='30s';
DO $check$ BEGIN
  IF to_regclass('public.company_kb_tenant_binding') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.company_kb_tenant_binding) THEN
      RAISE EXCEPTION 'KB_BINDING_ROLLBACK_HAS_MAPPINGS_SAFE_STOP';
    END IF;
  END IF;
END $check$;
DROP FUNCTION IF EXISTS public.kb_binding_invite_grant_v1(uuid,uuid,uuid,public.app_role);
DROP FUNCTION IF EXISTS public.kb_binding_secret_v1(uuid,text);
DROP FUNCTION IF EXISTS public.kb_binding_write_v1(uuid,uuid,text,text,boolean,bigint,text);
DROP TABLE IF EXISTS public.company_kb_tenant_binding;
-- Never delete Vault secrets from rollback; any old secret requires explicit owner audit.
COMMIT;