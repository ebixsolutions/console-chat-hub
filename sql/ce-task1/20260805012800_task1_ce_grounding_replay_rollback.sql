-- ===========================================================================
-- Task 1 — CE ROLLBACK
-- Companion to 20260805012800_task1_ce_grounding_replay.sql
--
-- Contract:
--   * Operates ONLY from public.ce_migration_provenance rows whose
--     migration_key matches and created_by_migration = true. It never guesses
--     at objects it did not create, and never drops pre-existing objects.
--   * FAILS CLOSED when production-like data exists in CE tables it would
--     drop, or when provenance is missing/ambiguous.
--   * Restores exact pre-state for objects that were REPLACED, from the
--     captured definition / owner / ACL / RLS enablement.
--   * Single transaction; idempotent (re-running after success is a no-op).
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $rb$
DECLARE
  v_key   text := '20260805012800_task1_ce_grounding_replay';
  v_count integer;
  v_rows  bigint;
  v_priv  text;
  i       integer;
  r       record;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. Fail closed: provenance must exist
  ---------------------------------------------------------------------------
  IF to_regclass('public.ce_migration_provenance') IS NULL THEN
    RAISE NOTICE 'CE_ROLLBACK_NOOP: no provenance ledger; nothing to roll back';
    RETURN;
  END IF;

  SELECT count(*) INTO v_count FROM public.ce_migration_provenance
   WHERE migration_key = v_key AND created_by_migration;
  IF v_count = 0 THEN
    RAISE NOTICE 'CE_ROLLBACK_NOOP: no created-object provenance for %', v_key;
    RETURN;
  END IF;

  ---------------------------------------------------------------------------
  -- 0a. Drop the triggers THIS migration created before touching seeded rows,
  --     so scope-consistency enforcement cannot block its own reversion.
  ---------------------------------------------------------------------------
  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'trigger' LOOP
    IF to_regclass('public.' || split_part(r.object_identity, ':', 1)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
                   split_part(r.object_identity, ':', 2), split_part(r.object_identity, ':', 1));
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1. Fail closed on production-like data in objects this migration created
  ---------------------------------------------------------------------------

  FOR r IN
    SELECT object_identity FROM public.ce_migration_provenance
     WHERE migration_key = v_key AND created_by_migration AND object_type = 'table'
  LOOP
    IF to_regclass(r.object_identity) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %s', r.object_identity) INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'CE_ROLLBACK_BLOCKED: % holds % row(s); refusing destructive rollback',
        r.object_identity, v_rows;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 1b. Revert exactly the rows this migration seeded (and nothing else).
  --     Anything else in these tables is user data and makes the rollback
  --     fail closed in step 1 below.
  ---------------------------------------------------------------------------
  FOR r IN
    SELECT split_part(object_identity, ':', 1) AS obj,
           split_part(object_identity, ':', 2) AS seed
      FROM public.ce_migration_provenance
     WHERE migration_key = v_key AND created_by_migration AND object_type = 'seed'
  LOOP
    IF r.obj = 'public.company_member' AND to_regclass(r.obj) IS NOT NULL THEN
      DELETE FROM public.company_member WHERE company_id = r.seed::uuid;
    ELSIF r.obj = 'public.company' AND to_regclass(r.obj) IS NOT NULL THEN
      IF to_regclass('public.upstream_call_log') IS NOT NULL
         AND EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='upstream_call_log'
                        AND column_name='company_id') THEN
        UPDATE public.upstream_call_log SET company_id = NULL WHERE company_id = r.seed::uuid;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='conversations'
                    AND column_name='company_id') THEN
        UPDATE public.conversations SET company_id = NULL WHERE company_id = r.seed::uuid;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='channel_config'
                    AND column_name='company_id') THEN
        UPDATE public.channel_config SET company_id = NULL WHERE company_id = r.seed::uuid;
      END IF;
      DELETE FROM public.company_member WHERE company_id = r.seed::uuid;
      DELETE FROM public.company WHERE id = r.seed::uuid;
    END IF;
  END LOOP;

  -- scoped columns added to PRE-EXISTING tables must carry no tenant data
  FOR r IN
    SELECT object_identity,
           split_part(object_identity,'.',1) AS sch,
           split_part(object_identity,'.',2) AS tbl,
           split_part(object_identity,'.',3) AS col
      FROM public.ce_migration_provenance
     WHERE migration_key = v_key AND created_by_migration AND object_type = 'column'
  LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = r.sch AND table_name = r.tbl
                      AND column_name = r.col) THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I IS NOT NULL', r.sch, r.tbl, r.col)
      INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'CE_ROLLBACK_BLOCKED: % populated on % row(s)', r.object_identity, v_rows;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2. Drop only what this migration created, in dependency order
  ---------------------------------------------------------------------------
  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'policy' LOOP
    IF to_regclass(split_part(r.object_identity, ':', 1)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS %I ON %s',
                   split_part(r.object_identity, ':', 2),
                   split_part(r.object_identity, ':', 1));
  END LOOP;


  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'view' LOOP
    EXECUTE format('DROP VIEW IF EXISTS %s', r.object_identity);
  END LOOP;

  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'index' LOOP
    EXECUTE format('DROP INDEX IF EXISTS %s', r.object_identity);
  END LOOP;

  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'column' LOOP
    EXECUTE format('ALTER TABLE IF EXISTS %I.%I DROP COLUMN IF EXISTS %I',
                   split_part(r.object_identity, '.', 1),
                   split_part(r.object_identity, '.', 2),
                   split_part(r.object_identity, '.', 3));
  END LOOP;

  -- child tables before parents
  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'table'
            ORDER BY CASE object_identity
                       WHEN 'public.ce_replay_chunk'        THEN 1
                       WHEN 'public.ce_grounding_violation' THEN 2
                       WHEN 'public.ce_replay_bundle'       THEN 3
                       WHEN 'public.ce_evaluation_review'   THEN 4
                       WHEN 'public.ce_training_result'     THEN 5
                       WHEN 'public.company_member'         THEN 6
                       WHEN 'public.company'                THEN 7
                       ELSE 8 END
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %s', r.object_identity);
  END LOOP;

  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'function' LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.object_identity);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 3. Restore exact pre-state for objects that were REPLACED
  ---------------------------------------------------------------------------
  FOR r IN SELECT object_identity, prior_definition, prior_owner
             FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND NOT created_by_migration
              AND object_type = 'function' AND prior_definition IS NOT NULL LOOP
    EXECUTE r.prior_definition;
    IF r.prior_owner IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.object_identity, r.prior_owner);
    END IF;
  END LOOP;

  FOR r IN SELECT prior_definition FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND NOT created_by_migration
              AND object_type = 'trigger' AND prior_definition IS NOT NULL LOOP
    EXECUTE r.prior_definition;
  END LOOP;

  -- table-level pre-state: owner, RLS enablement, ACL
  FOR r IN SELECT object_identity, prior_owner, prior_acl, prior_rls_enabled
             FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND NOT created_by_migration AND object_type = 'table' LOOP
    IF to_regclass(r.object_identity) IS NULL THEN CONTINUE; END IF;
    IF r.prior_owner IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s OWNER TO %I', r.object_identity, r.prior_owner);
    END IF;
    IF r.prior_rls_enabled IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s %s ROW LEVEL SECURITY', r.object_identity,
                     CASE WHEN r.prior_rls_enabled THEN 'ENABLE' ELSE 'DISABLE' END);
    END IF;
    IF r.prior_acl IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', r.object_identity);
      FOR i IN 1 .. array_length(r.prior_acl, 1) LOOP
        -- ACL entries look like  grantee=arwdDxt/grantor
        v_priv := split_part(split_part(r.prior_acl[i], '=', 2), '/', 1);
        IF split_part(r.prior_acl[i], '=', 1) = '' THEN CONTINUE; END IF;
        EXECUTE format('GRANT %s ON %s TO %I',
          array_to_string(ARRAY[
            CASE WHEN v_priv ~ 'r' THEN 'SELECT' END,
            CASE WHEN v_priv ~ 'a' THEN 'INSERT' END,
            CASE WHEN v_priv ~ 'w' THEN 'UPDATE' END,
            CASE WHEN v_priv ~ 'd' THEN 'DELETE' END,
            CASE WHEN v_priv ~ 'D' THEN 'TRUNCATE' END,
            CASE WHEN v_priv ~ 'x' THEN 'REFERENCES' END,
            CASE WHEN v_priv ~ 't' THEN 'TRIGGER' END
          ]::text[], ', '),
          r.object_identity, split_part(r.prior_acl[i], '=', 1));
      END LOOP;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4. Remove the flags this migration inserted (only while still disabled)
  ---------------------------------------------------------------------------
  IF to_regclass('public.ce_feature_flags') IS NOT NULL THEN
    DELETE FROM public.ce_feature_flags
     WHERE key IN ('ce_grounding_fail_closed_enabled','ce_replay_bundle_enabled','ce_console_ui_enabled')
       AND enabled = false;
  END IF;

  ---------------------------------------------------------------------------
  -- 5. Retire provenance for this migration (idempotent re-run => NOOP)
  ---------------------------------------------------------------------------
  DELETE FROM public.ce_migration_provenance WHERE migration_key = v_key;

  RAISE NOTICE 'CE_ROLLBACK_COMPLETE: % objects reverted for %', v_count, v_key;
END
$rb$;

-- The ledger itself was created by this migration; drop it only when no other
-- migration still depends on it (exact pre-state restoration).
DO $rb2$
DECLARE v_left bigint;
BEGIN
  -- nested IF: a single IF would plan the subquery even when the table is gone
  IF to_regclass('public.ce_migration_provenance') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.ce_migration_provenance' INTO v_left;
    IF v_left = 0 THEN
      DROP TABLE public.ce_migration_provenance;
    END IF;
  END IF;
END
$rb2$;


COMMIT;
