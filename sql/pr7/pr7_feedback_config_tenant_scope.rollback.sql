-- PR-7 tenant-scoped feedback config rollback.
-- Restores the exact pre-change policy definitions captured by the forward SQL.

BEGIN;

DO $drop$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'feedback_automation_config'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.feedback_automation_config',
      p.policyname
    );
  END LOOP;
END
$drop$;

DO $restore$
DECLARE p record;
DECLARE role_sql text;
DECLARE stmt text;
BEGIN
  FOR p IN
    SELECT policyname, permissive, roles, cmd, qual, with_check
    FROM public.pr7_feedback_config_policy_prov
    ORDER BY policyname
  LOOP
    SELECT string_agg(quote_ident(r), ', ')
      INTO role_sql
    FROM unnest(p.roles) AS r;

    stmt := format(
      'CREATE POLICY %I ON public.feedback_automation_config AS %s FOR %s TO %s',
      p.policyname,
      CASE WHEN lower(p.permissive) = 'restrictive' THEN 'RESTRICTIVE' ELSE 'PERMISSIVE' END,
      p.cmd,
      COALESCE(role_sql, 'PUBLIC')
    );

    IF p.qual IS NOT NULL THEN
      stmt := stmt || ' USING (' || p.qual || ')';
    END IF;
    IF p.with_check IS NOT NULL THEN
      stmt := stmt || ' WITH CHECK (' || p.with_check || ')';
    END IF;

    EXECUTE stmt;
  END LOOP;
END
$restore$;

DROP INDEX IF EXISTS public.uq_feedback_automation_config_company;
ALTER TABLE public.feedback_automation_config
  DROP COLUMN IF EXISTS company_id;

DROP TABLE IF EXISTS public.pr7_feedback_config_policy_prov;

COMMIT;
