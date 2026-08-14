-- PR-7 SECURITY DEFINER ACL hardening.
-- SOURCE ONLY. Do not deploy without explicit Director authorization.
--
-- Scope:
-- 1) ce_purge_expired_snapshots(): maintenance delete must be service_role only.
-- 2) is_staff(uuid): anon must not probe arbitrary user staff status.

BEGIN;

DO $deps$
BEGIN
  IF to_regprocedure('public.ce_purge_expired_snapshots()') IS NULL THEN
    RAISE EXCEPTION 'PR7_DEPENDENCY_MISSING: ce_purge_expired_snapshots()';
  END IF;
  IF to_regprocedure('public.is_staff(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PR7_DEPENDENCY_MISSING: is_staff(uuid)';
  END IF;
END
$deps$;

CREATE TABLE IF NOT EXISTS public.pr7_security_definer_acl_prov (
  function_signature text NOT NULL,
  grantee text NOT NULL,
  privilege_type text NOT NULL,
  PRIMARY KEY(function_signature, grantee, privilege_type)
);

TRUNCATE public.pr7_security_definer_acl_prov;

INSERT INTO public.pr7_security_definer_acl_prov(
  function_signature, grantee, privilege_type
)
SELECT
  routine_schema || '.' || routine_name || '(' ||
    CASE
      WHEN specific_name LIKE 'ce_purge_expired_snapshots_%' THEN ''
      ELSE 'uuid'
    END || ')',
  grantee,
  privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema='public'
  AND routine_name IN ('ce_purge_expired_snapshots','is_staff')
  AND privilege_type='EXECUTE';

-- Maintenance purge is internal only.
REVOKE ALL ON FUNCTION public.ce_purge_expired_snapshots()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ce_purge_expired_snapshots()
  TO service_role;

-- is_staff is still used by legacy authenticated RLS until PR7 RLS migrations
-- are deployed, so keep authenticated + service_role but remove anonymous probing.
REVOKE ALL ON FUNCTION public.is_staff(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff(uuid)
  TO authenticated, service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.ce_purge_expired_snapshots()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated can still purge CE snapshots';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.ce_purge_expired_snapshots()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: anon can purge CE snapshots';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.ce_purge_expired_snapshots()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role purge execute missing';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.is_staff(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: anon can still probe is_staff';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.is_staff(uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated legacy is_staff dependency broken';
  END IF;
END
$assert$;

COMMIT;
