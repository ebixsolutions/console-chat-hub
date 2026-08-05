-- =====================================================================
-- ROLLBACK for 20260728093000_ce_task1 (single atomic transaction)
-- =====================================================================
BEGIN;
SET LOCAL client_min_messages = WARNING;

-- 0. Abort if no ledger
DO $$
BEGIN
  IF to_regclass('public.migration_object_ledger') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK ABORT: migration_object_ledger absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.migration_object_ledger WHERE migration_id='20260728093000_ce_task1') THEN
    RAISE EXCEPTION 'ROLLBACK ABORT: no ledger rows for this migration';
  END IF;
END $$;

-- 1. Fail-closed data check
DO $$
DECLARE v_force boolean := COALESCE(current_setting('nexusai.rollback_force', true), 'off') = 'on';
  v_n bigint := 0;
BEGIN
  IF to_regclass('public.company_membership') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.company_membership' INTO v_n;
  END IF;
  IF NOT v_force AND v_n > 0 THEN
    RAISE EXCEPTION 'ROLLBACK ABORT: % membership rows exist. Export and set nexusai.rollback_force=on', v_n;
  END IF;
END $$;

-- 2. Restore replaced policies from captured definition
DO $$
DECLARE r record; v_policy text; v_table text;
BEGIN
  FOR r IN SELECT object_ident, pre_definition FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='replaced' AND object_kind='policy' LOOP
    IF r.pre_definition IS NULL THEN
      RAISE EXCEPTION 'ROLLBACK ABORT: no pre_definition for replaced policy %', r.object_ident;
    END IF;
    v_policy := split_part(r.object_ident, ' ON ', 1);
    v_table := replace(split_part(r.object_ident, ' ON ', 2), 'public.', '');
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=v_table AND policyname=v_policy) THEN
      EXECUTE format('DROP POLICY %I ON public.%I', v_policy, v_table);
    END IF;
    EXECUTE r.pre_definition;
  END LOOP;
END $$;

-- 3. Restore replaced functions from captured definition + owner + ACL
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT object_ident, pre_definition, pre_owner, pre_acl FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='replaced' AND object_kind='function' LOOP
    IF r.pre_definition IS NOT NULL THEN
      EXECUTE r.pre_definition;
      IF r.pre_owner IS NOT NULL THEN
        EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.object_ident, r.pre_owner);
      END IF;
    END IF;
  END LOOP;
END $$;

-- 4. Restore revoked grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.migration_object_ledger WHERE migration_id='20260728093000_ce_task1'
    AND disposition='revoked' AND object_ident LIKE '%complete_evaluation%service_role') THEN
    IF to_regprocedure('public.complete_evaluation(uuid,jsonb)') IS NOT NULL THEN
      GRANT EXECUTE ON FUNCTION public.complete_evaluation(uuid, jsonb) TO service_role;
    END IF;
  END IF;
END $$;

-- 5. Drop created policies
DO $$
DECLARE r record; v_pol text; v_tbl text;
BEGIN
  FOR r IN SELECT object_ident FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='policy' LOOP
    v_pol := split_part(r.object_ident, ' ON ', 1);
    v_tbl := replace(split_part(r.object_ident, ' ON ', 2), 'public.', '');
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=v_tbl AND policyname=v_pol) THEN
      EXECUTE format('DROP POLICY %I ON public.%I', v_pol, v_tbl);
    END IF;
  END LOOP;
END $$;

-- 6. Drop created triggers
DO $$
DECLARE r record; v_trg text; v_tbl text;
BEGIN
  FOR r IN SELECT object_ident FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='trigger' LOOP
    v_trg := split_part(r.object_ident, ' ON ', 1);
    v_tbl := split_part(r.object_ident, ' ON ', 2);
    IF to_regclass(v_tbl) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', v_trg, v_tbl);
    END IF;
  END LOOP;
END $$;

-- 7. Drop created constraints
DO $$
DECLARE r record; v_con text; v_tbl text;
BEGIN
  FOR r IN SELECT object_ident FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='constraint' LOOP
    v_con := split_part(r.object_ident, ' ON ', 1);
    v_tbl := split_part(r.object_ident, ' ON ', 2);
    IF to_regclass(v_tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', v_tbl, v_con);
    END IF;
  END LOOP;
END $$;

-- 8. Drop created indexes
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT object_ident FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='index' LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.object_ident);
  END LOOP;
END $$;

-- 9. Drop created tables (children first, company last)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT object_ident FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='table'
      AND object_ident NOT IN ('public.company','public.company_membership','public.company_backfill_contract','public.migration_object_ledger')
    ORDER BY object_ident LOOP
    EXECUTE format('DROP TABLE IF EXISTS %s CASCADE', r.object_ident);
  END LOOP;
END $$;

-- 10. Drop created columns (must precede parent table drops)
DO $$
DECLARE r record; v_tbl text; v_col text;
BEGIN
  FOR r IN SELECT object_ident FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='column' LOOP
    v_tbl := 'public.' || split_part(r.object_ident, '.', 2);
    v_col := split_part(r.object_ident, '.', 3);
    IF to_regclass(v_tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s DROP COLUMN IF EXISTS %I CASCADE', v_tbl, v_col);
    END IF;
  END LOOP;
END $$;

-- 11. Drop company tables in FK order
DO $$
DECLARE v_tbl text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['public.company_backfill_contract','public.company_membership','public.company'] LOOP
    IF EXISTS (SELECT 1 FROM public.migration_object_ledger
      WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='table' AND object_ident=v_tbl) THEN
      EXECUTE format('DROP TABLE IF EXISTS %s CASCADE', v_tbl);
    END IF;
  END LOOP;
END $$;

-- 12. Drop created functions (except helpers used by this script)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT object_ident FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='function'
      AND object_ident NOT LIKE 'public._ce_%' LOOP
    IF to_regprocedure(r.object_ident) IS NOT NULL THEN
      EXECUTE format('DROP FUNCTION IF EXISTS %s', r.object_ident);
    END IF;
  END LOOP;
END $$;

-- 13. Restore RLS pre-state
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT object_ident, pre_rls_enabled FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='created' AND object_kind='rls' LOOP
    IF to_regclass(r.object_ident) IS NOT NULL THEN
      IF COALESCE(r.pre_rls_enabled, false) THEN NULL;
      ELSE EXECUTE format('ALTER TABLE %s DISABLE ROW LEVEL SECURITY', r.object_ident); END IF;
    END IF;
  END LOOP;
END $$;

-- 14. Read-back (inline catalog checks, no nested functions)
DO $$
DECLARE r record; v_bad text := ''; v_found boolean; xa text; xb text;
BEGIN
  FOR r IN SELECT object_kind, object_ident FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND disposition='pre_existing'
      AND object_kind IN ('table','column','function','policy') LOOP
    v_found := false;
    CASE r.object_kind
      WHEN 'table' THEN v_found := to_regclass(r.object_ident) IS NOT NULL;
      WHEN 'column' THEN
        xa := split_part(r.object_ident,'.',2); xb := split_part(r.object_ident,'.',3);
        v_found := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=xa AND column_name=xb);
      WHEN 'function' THEN v_found := to_regprocedure(r.object_ident) IS NOT NULL;
      WHEN 'policy' THEN
        xa := split_part(r.object_ident,' ON ',1); xb := replace(split_part(r.object_ident,' ON ',2),'public.','');
        v_found := EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=xb AND policyname=xa);
      ELSE v_found := true;
    END CASE;
    IF NOT v_found THEN v_bad := v_bad || r.object_kind || ' ' || r.object_ident || '; '; END IF;
  END LOOP;
  IF length(v_bad) > 0 THEN RAISE EXCEPTION 'ROLLBACK ASSERT: pre-existing objects destroyed -> %', v_bad; END IF;
  RAISE NOTICE 'CE Task 1 rollback read-back complete';
END $$;

-- 15. Clean up
DO $$
DECLARE v_owns boolean;
BEGIN
  SELECT disposition='created' INTO v_owns FROM public.migration_object_ledger
    WHERE migration_id='20260728093000_ce_task1' AND object_kind='table' AND object_ident='public.migration_object_ledger';
  DELETE FROM public.migration_object_ledger WHERE migration_id='20260728093000_ce_task1';
  DROP FUNCTION IF EXISTS public._ce_rls(text);
  DROP FUNCTION IF EXISTS public._ce_facl(text);
  DROP FUNCTION IF EXISTS public._ce_exists(text,text);
  DROP FUNCTION IF EXISTS public._ce_ledger(text,text,text,text,text,text,boolean);
  IF COALESCE(v_owns, false) AND NOT EXISTS (SELECT 1 FROM public.migration_object_ledger) THEN
    DROP TABLE public.migration_object_ledger;
  END IF;
END $$;

COMMIT;
