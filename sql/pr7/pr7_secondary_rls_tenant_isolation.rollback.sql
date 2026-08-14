-- PR-7 secondary RLS tenant isolation rollback.
-- Restores exact pre-change policies captured by the forward migration.

BEGIN;

DO $drop$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN (
        'ai_reply_draft',
        'audit_log',
        'final_prompt_trace',
        'rag_trace',
        'upstream_call_log',
        'user_roles',
        'visitor_session',
        'widget_session_event'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END
$drop$;

DO $restore$
DECLARE p record;
DECLARE v_sql text;
BEGIN
  IF to_regclass('public.pr7_secondary_rls_policy_prov') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED: provenance table missing';
  END IF;

  FOR p IN
    SELECT * FROM public.pr7_secondary_rls_policy_prov
    ORDER BY tablename, policyname
  LOOP
    v_sql := format(
      'CREATE POLICY %I ON public.%I AS %s FOR %s TO %s',
      p.policyname,
      p.tablename,
      p.permissive,
      p.cmd,
      array_to_string(
        ARRAY(SELECT quote_ident(x) FROM unnest(p.roles) AS x),
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

COMMIT;
