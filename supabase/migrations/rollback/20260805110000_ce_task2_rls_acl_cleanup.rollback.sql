-- ============================================================
-- CE Task 2 — RLS/ACL Cleanup ROLLBACK
-- Provenance-driven: only restores what existed before migration.
-- Drift-protected: refuses to rollback if post-migration changes detected.
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $rb$
DECLARE
  v_prov record;
  v_current_exists boolean;
  v_current_def_hash text;
  v_current_acl text;
  v_applied_hash text;
  v_pol_row record;
  v_create_sql text;
  v_role_arr text[];
  v_role text;
  v_to_clause text;
BEGIN
  -- ============================================================
  -- 0. Guard: provenance ledger must exist
  -- ============================================================
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '_ce_t2_rls_cleanup_prov'
  ) THEN
    RAISE EXCEPTION '[CE-T2-CLEANUP-RB] Provenance table _ce_t2_rls_cleanup_prov not found — nothing to rollback';
  END IF;

  -- ============================================================
  -- 1. Drift detection for policies
  -- ============================================================
  FOR v_prov IN
    SELECT * FROM public._ce_t2_rls_cleanup_prov
    WHERE object_type = 'policy'
    ORDER BY id
  LOOP
    IF v_prov.existed_before AND v_prov.applied_state_hash = 'DROPPED' THEN
      -- We dropped this policy. Verify it's still absent (no one re-created it).
      v_current_exists := EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = ('public.' || split_part(v_prov.object_identity, '/', 1))::regclass
          AND p.polname = split_part(v_prov.object_identity, '/', 2)
      );
      IF v_current_exists THEN
        RAISE EXCEPTION '[CE-T2-CLEANUP-RB] DRIFT: policy % was re-created after migration dropped it', v_prov.object_identity;
      END IF;
    ELSIF NOT v_prov.existed_before THEN
      -- We didn't touch it. Verify it's still absent.
      v_current_exists := EXISTS (
        SELECT 1 FROM pg_policy p
        WHERE p.polrelid = ('public.' || split_part(v_prov.object_identity, '/', 1))::regclass
          AND p.polname = split_part(v_prov.object_identity, '/', 2)
      );
      IF v_current_exists THEN
        RAISE EXCEPTION '[CE-T2-CLEANUP-RB] DRIFT: policy % was created after migration (existed_before=false)', v_prov.object_identity;
      END IF;
    END IF;
  END LOOP;

  -- ============================================================
  -- 2. Drift detection for grant
  -- ============================================================
  FOR v_prov IN
    SELECT * FROM public._ce_t2_rls_cleanup_prov
    WHERE object_type = 'grant'
    ORDER BY id
  LOOP
    IF v_prov.applied_state_hash IS NOT NULL AND v_prov.applied_state_hash NOT IN ('UNCHANGED') THEN
      -- We modified the ACL. Check current ACL matches applied state.
      SELECT coalesce(c.relacl::text, 'NULL') INTO v_current_acl
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'ce_raw_provider_output';
      IF md5(v_current_acl) != v_prov.applied_state_hash THEN
        RAISE EXCEPTION '[CE-T2-CLEANUP-RB] DRIFT: ce_raw_provider_output ACL changed post-migration. Expected hash=%, current hash=%',
          v_prov.applied_state_hash, md5(v_current_acl);
      END IF;
    END IF;
  END LOOP;

  -- ============================================================
  -- 3. Restore policies (only those that existed before)
  -- ============================================================
  FOR v_prov IN
    SELECT * FROM public._ce_t2_rls_cleanup_prov
    WHERE object_type = 'policy'
    ORDER BY id
  LOOP
    IF v_prov.existed_before THEN
      -- Reconstruct CREATE POLICY from captured state
      v_create_sql := 'CREATE POLICY ' ||
        quote_ident(split_part(v_prov.object_identity, '/', 2)) ||
        ' ON public.' || quote_ident(split_part(v_prov.object_identity, '/', 1));

      -- AS PERMISSIVE/RESTRICTIVE
      IF v_prov.prior_permissive THEN
        v_create_sql := v_create_sql || ' AS PERMISSIVE';
      ELSE
        v_create_sql := v_create_sql || ' AS RESTRICTIVE';
      END IF;

      -- FOR command
      v_create_sql := v_create_sql || ' FOR ' || CASE v_prov.prior_cmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        WHEN '*' THEN 'ALL'
        ELSE 'ALL'
      END;

      -- TO roles
      IF v_prov.prior_roles IS NOT NULL AND v_prov.prior_roles != '' THEN
        v_role_arr := string_to_array(v_prov.prior_roles, ',');
        v_to_clause := '';
        FOREACH v_role IN ARRAY v_role_arr LOOP
          IF v_to_clause != '' THEN v_to_clause := v_to_clause || ', '; END IF;
          IF v_role = 'PUBLIC' THEN
            v_to_clause := v_to_clause || 'PUBLIC';
          ELSE
            v_to_clause := v_to_clause || quote_ident(v_role);
          END IF;
        END LOOP;
        v_create_sql := v_create_sql || ' TO ' || v_to_clause;
      END IF;

      -- USING
      IF v_prov.prior_qual IS NOT NULL THEN
        v_create_sql := v_create_sql || ' USING (' || v_prov.prior_qual || ')';
      END IF;

      -- WITH CHECK
      IF v_prov.prior_with_check IS NOT NULL THEN
        v_create_sql := v_create_sql || ' WITH CHECK (' || v_prov.prior_with_check || ')';
      END IF;

      EXECUTE v_create_sql;
      RAISE NOTICE '[CE-T2-CLEANUP-RB] Restored policy %', v_prov.object_identity;

    ELSE
      -- existed_before=false: do NOT create. Just confirm still absent.
      RAISE NOTICE '[CE-T2-CLEANUP-RB] Policy % was absent before migration — not creating', v_prov.object_identity;
    END IF;
  END LOOP;

  -- ============================================================
  -- 4. Restore grant (only if migration added it)
  -- ============================================================
  FOR v_prov IN
    SELECT * FROM public._ce_t2_rls_cleanup_prov
    WHERE object_type = 'grant'
    ORDER BY id
  LOOP
    IF NOT v_prov.existed_before THEN
      -- Migration added this grant: revoke it
      EXECUTE 'REVOKE SELECT ON public.ce_raw_provider_output FROM authenticated';
      RAISE NOTICE '[CE-T2-CLEANUP-RB] Revoked migration-added SELECT on ce_raw_provider_output';

      -- Verify authenticated no longer has SELECT
      IF EXISTS (
        SELECT 1 FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND table_name = 'ce_raw_provider_output'
          AND grantee = 'authenticated' AND privilege_type = 'SELECT'
      ) THEN
        RAISE EXCEPTION '[CE-T2-CLEANUP-RB] authenticated still has SELECT after REVOKE';
      END IF;
    ELSE
      -- Pre-existing grant: do not touch
      RAISE NOTICE '[CE-T2-CLEANUP-RB] SELECT was pre-existing — not revoking';
    END IF;
  END LOOP;

  -- ============================================================
  -- 5. Drop provenance ledger
  -- ============================================================
  DROP TABLE public._ce_t2_rls_cleanup_prov;

  RAISE NOTICE '[CE-T2-CLEANUP-RB] Rollback complete';
END $rb$;

COMMIT;
