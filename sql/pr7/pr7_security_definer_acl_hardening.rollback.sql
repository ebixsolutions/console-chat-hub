-- PR-7 SECURITY DEFINER ACL hardening rollback.
-- Restores the pre-hardening execution grants captured by the forward migration.
-- Explicit Director authorization required after production deployment.

BEGIN;

DO $restore$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.pr7_security_definer_acl_prov') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: ACL provenance table missing';
  END IF;

  REVOKE ALL ON FUNCTION public.ce_purge_expired_snapshots()
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.is_staff(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

  FOR r IN
    SELECT * FROM public.pr7_security_definer_acl_prov
    ORDER BY function_signature, grantee
  LOOP
    IF r.function_signature = 'public.ce_purge_expired_snapshots()' THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.ce_purge_expired_snapshots() TO %I',
        r.grantee
      );
    ELSIF r.function_signature = 'public.is_staff(uuid)' THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.is_staff(uuid) TO %I',
        r.grantee
      );
    END IF;
  END LOOP;
END
$restore$;

COMMIT;
