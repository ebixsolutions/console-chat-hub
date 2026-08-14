-- PR-7 core RLS tenant isolation rollback.
-- Restores the exact pre-change policies captured in pr7_core_rls_policy_prov.
-- Requires the provenance table produced by the forward migration.
-- Explicit Director authorization required after production deployment.

BEGIN;

DO $drop$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN (
        'agent_profile',
        'channel_config',
        'widget_config',
        'conversations',
        'messages',
        'conversation_assignment',
        'conversation_status_log',
        'handoff_event',
        'feedback_request'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      p.policyname,
      p.tablename
    );
  END LOOP;
END
$drop$;

DO $restore$
DECLARE p record;
DECLARE v_sql text;
BEGIN
  IF to_regclass('public.pr7_core_rls_policy_prov') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: provenance table missing';
  END IF;

  FOR p IN
    SELECT *
    FROM public.pr7_core_rls_policy_prov
    ORDER BY tablename, policyname
  LOOP
    v_sql := format(
      'CREATE POLICY %I ON public.%I AS %s FOR %s TO %s',
      p.policyname,
      p.tablename,
      p.permissive,
      p.cmd,
      array_to_string(
        ARRAY(
          SELECT quote_ident(x)
          FROM unnest(p.roles) AS x
        ),
        ','
      )
    );

    IF p.qual IS NOT NULL THEN
      v_sql := v_sql || ' USING (' || p.qual || ')';
    END IF;

    IF p.with_check IS NOT NULL THEN
      v_sql := v_sql || ' WITH CHECK (' || p.with_check || ')';
    END IF;

    EXECUTE v_sql;
  END LOOP;
END
$restore$;

DROP FUNCTION IF EXISTS public.pr7_same_active_company_user(uuid,uuid);

COMMIT;
