-- SAME AI-ABC-C3 / Task3C / original database. SOURCE ONLY.
-- Do not delete users, Company, Member, Channel, Vault keys or customer data.
-- Fail closed if a provisioning record exists; data rollback must be separately
-- authorized and use exact post-image / no-ticket / no-secret guard.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='30s';
DO $check$
BEGIN
  IF to_regclass('public.company_kb_tenant_binding') IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.company_kb_tenant_binding b
    WHERE b.audit_history @> '[{"event":"dev_kb_bootstrap"}]'::jsonb
  ) THEN RAISE EXCEPTION 'KB_DEV_BOOTSTRAP_ROLLBACK_HAS_REAL_TENANT_SAFE_STOP'; END IF;
END $check$;
DROP FUNCTION IF EXISTS public.kb_binding_dev_bootstrap_v1(uuid,uuid,text,text,text,uuid);
COMMIT;
