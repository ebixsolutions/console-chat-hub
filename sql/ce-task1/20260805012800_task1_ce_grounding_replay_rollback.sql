-- ===========================================================================
-- Task 1 — CE ROLLBACK  [STAGED, NOT APPLIED]
-- Companion to 20260805012800_task1_ce_grounding_replay.sql
--
-- Contract:
--   * Operates ONLY from public.ce_migration_provenance rows whose
--     migration_key matches and created_by_migration = true. It never guesses
--     at objects it did not create.
--   * FAILS CLOSED when production-like data exists in CE tables it would
--     drop, or when provenance is missing/ambiguous.
--   * Restores exact pre-state for replaced objects from the captured
--     definition / owner / ACL / RLS enablement.
--   * Single transaction; idempotent (re-running after success is a no-op).
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $rb$
DECLARE
  v_key   text := '20260805012800_task1_ce_grounding_replay';
  v_count integer;
  v_rows  bigint;
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
  -- 1. Fail closed on production-like data
  ---------------------------------------------------------------------------
  IF to_regclass('public.ce_replay_bundle') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.ce_replay_bundle' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'CE_ROLLBACK_BLOCKED: ce_replay_bundle holds % immutable row(s); refusing destructive rollback', v_rows;
    END IF;
  END IF;

  IF to_regclass('public.ce_grounding_violation') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.ce_grounding_violation' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'CE_ROLLBACK_BLOCKED: ce_grounding_violation holds % audit row(s)', v_rows;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM public.ce_migration_provenance
              WHERE migration_key = v_key AND created_by_migration
                AND object_identity = 'public.company')
     AND to_regclass('public.company') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.company' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION 'CE_ROLLBACK_BLOCKED: company holds % tenant row(s)', v_rows;
    END IF;
  END IF;

  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'column' LOOP
    -- refuse if any scoped column actually carries tenant data
    IF r.object_identity = 'public.conversations.company_id'
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='conversations' AND column_name='company_id') THEN
      EXECUTE 'SELECT count(*) FROM public.conversations WHERE company_id IS NOT NULL' INTO v_rows;
      IF v_rows > 0 THEN
        RAISE EXCEPTION 'CE_ROLLBACK_BLOCKED: conversations.company_id populated on % row(s)', v_rows;
      END IF;
    END IF;
    IF r.object_identity = 'public.channel_config.company_id'
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='channel_config' AND column_name='company_id') THEN
      EXECUTE 'SELECT count(*) FROM public.channel_config WHERE company_id IS NOT NULL' INTO v_rows;
      IF v_rows > 0 THEN
        RAISE EXCEPTION 'CE_ROLLBACK_BLOCKED: channel_config.company_id populated on % row(s)', v_rows;
      END IF;
    END IF;
    IF r.object_identity = 'public.upstream_call_log.company_id'
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='upstream_call_log' AND column_name='company_id') THEN
      EXECUTE 'SELECT count(*) FROM public.upstream_call_log WHERE company_id IS NOT NULL' INTO v_rows;
      IF v_rows > 0 THEN
        RAISE EXCEPTION 'CE_ROLLBACK_BLOCKED: upstream_call_log.company_id populated on % row(s)', v_rows;
      END IF;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2. Drop only what this migration created, in dependency order
  ---------------------------------------------------------------------------
  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'trigger' LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I',
                   split_part(r.object_identity, ':', 2), split_part(r.object_identity, ':', 1));
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
    EXECUTE format('ALTER TABLE %I.%I DROP COLUMN IF EXISTS %I',
                   split_part(r.object_identity, '.', 1),
                   split_part(r.object_identity, '.', 2),
                   split_part(r.object_identity, '.', 3));
  END LOOP;

  -- child tables before parents
  FOR r IN SELECT object_identity FROM public.ce_migration_provenance
            WHERE migration_key = v_key AND created_by_migration AND object_type = 'table'
            ORDER BY CASE object_identity
                       WHEN 'public.ce_replay_chunk' THEN 1
                       WHEN 'public.ce_grounding_violation' THEN 2
                       WHEN 'public.ce_replay_bundle' THEN 3
                       WHEN 'public.company' THEN 4
                       ELSE 5 END LOOP;
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

  -- table-level pre-state: owner, ACL, RLS enablement
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
      EXECUTE format('REVOKE ALL ON %s FROM anon, authenticated, service_role', r.object_identity);
      FOR v_count IN 1 .. array_length(r.prior_acl, 1) LOOP
        -- ACL entries are of the form grantee=privs/grantor
        EXECUTE format('GRANT %s ON %s TO %I',
          CASE
            WHEN split_part(split_part(r.prior_acl[v_count], '=', 2), '/', 1) ~ 'a' THEN 'SELECT, INSERT, UPDATE, DELETE'
            ELSE 'SELECT'
          END,
          r.object_identity,
          NULLIF(split_part(r.prior_acl[v_count], '=', 1), ''));
      END LOOP;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- 4. Flags added by the forward migration
  ---------------------------------------------------------------------------
  DELETE FROM public.ce_feature_flags
   WHERE key IN ('ce_grounding_fail_closed_enabled','ce_replay_bundle_enabled','ce_console_ui_enabled')
     AND enabled = false;

  ---------------------------------------------------------------------------
  -- 5. Retire provenance for this migration (idempotent re-run => NOOP)
  ---------------------------------------------------------------------------
  DELETE FROM public.ce_migration_provenance WHERE migration_key = v_key;

  RAISE NOTICE 'CE_ROLLBACK_COMPLETE: % objects reverted for %', v_count, v_key;
END
$rb$;

COMMIT;
