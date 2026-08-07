-- ============================================================
-- CE Task 2 — RLS/ACL Cleanup Migration
-- Provenance-based: captures exact pre-state before any modification.
-- Idempotent: safe no-op on rerun.
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '10s';

DO $mig$
DECLARE
  v_target_policies text[][] := ARRAY[
    ARRAY['evaluation_training_outbox', 'base_outbox_staff'],
    ARRAY['conversation_evaluation_attempt', 'base_attempt_staff'],
    ARRAY['conversation_evaluation', 'base_eval_staff'],
    ARRAY['conversation_evaluation_detail', 'base_detail_staff']
  ];
  v_tbl text; v_pol text;
  v_polrow record;
  v_roles_text text;
  v_def_hash text;
  v_grant_existed boolean;
  v_acl_snap text;
  v_owner text;
  v_rls boolean;
BEGIN
  -- ============================================================
  -- 0. Rerun guard: if provenance ledger already exists, no-op
  -- ============================================================
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '_ce_t2_rls_cleanup_prov'
  ) THEN
    RAISE NOTICE '[CE-T2-CLEANUP] Already applied — safe no-op';
    RETURN;
  END IF;

  -- ============================================================
  -- 1. Create provenance ledger
  -- ============================================================
  CREATE TABLE public._ce_t2_rls_cleanup_prov (
    id serial PRIMARY KEY,
    object_type text NOT NULL,
    object_identity text NOT NULL,
    existed_before boolean NOT NULL,
    prior_definition text,
    prior_permissive boolean,
    prior_cmd text,
    prior_roles text,
    prior_qual text,
    prior_with_check text,
    prior_def_hash text,
    prior_owner text,
    prior_acl text,
    prior_rls boolean,
    applied_state_hash text,
    recorded_at timestamptz NOT NULL DEFAULT now()
  );

  -- ============================================================
  -- 2. Capture + conditionally drop baseline policies
  -- ============================================================
  FOR i IN 1..array_length(v_target_policies, 1) LOOP
    v_tbl := v_target_policies[i][1];
    v_pol := v_target_policies[i][2];

    SELECT p.polpermissive, p.polcmd,
      COALESCE((SELECT string_agg(
        CASE WHEN rid = 0 THEN 'PUBLIC' ELSE r.rolname END, ','
        ORDER BY CASE WHEN rid = 0 THEN 'PUBLIC' ELSE r.rolname END)
        FROM unnest(p.polroles) AS rid LEFT JOIN pg_roles r ON r.oid = rid
      ), 'PUBLIC') AS roles_text,
      pg_get_expr(p.polqual, p.polrelid) AS qual_text,
      pg_get_expr(p.polwithcheck, p.polrelid) AS withcheck_text
    INTO v_polrow
    FROM pg_policy p
    WHERE p.polrelid = ('public.' || v_tbl)::regclass
      AND p.polname = v_pol;

    IF FOUND THEN
      -- Policy exists: capture full state
      v_def_hash := md5(
        coalesce(v_polrow.polpermissive::text, '') || '|' ||
        coalesce(v_polrow.polcmd::text, '') || '|' ||
        coalesce(v_polrow.roles_text, '') || '|' ||
        coalesce(v_polrow.qual_text, '') || '|' ||
        coalesce(v_polrow.withcheck_text, '')
      );

      INSERT INTO public._ce_t2_rls_cleanup_prov (
        object_type, object_identity, existed_before,
        prior_permissive, prior_cmd, prior_roles, prior_qual, prior_with_check,
        prior_def_hash
      ) VALUES (
        'policy', v_tbl || '/' || v_pol, true,
        v_polrow.polpermissive, v_polrow.polcmd::text, v_polrow.roles_text,
        v_polrow.qual_text, v_polrow.withcheck_text,
        v_def_hash
      );

      -- Drop the conflicting policy
      EXECUTE format('DROP POLICY %I ON public.%I', v_pol, v_tbl);
      RAISE NOTICE '[CE-T2-CLEANUP] Dropped existing policy % on %', v_pol, v_tbl;

      -- Record applied state hash (policy absent)
      UPDATE public._ce_t2_rls_cleanup_prov
        SET applied_state_hash = 'DROPPED'
        WHERE object_type = 'policy' AND object_identity = v_tbl || '/' || v_pol;
    ELSE
      -- Policy does not exist: record as not-existing, do nothing
      INSERT INTO public._ce_t2_rls_cleanup_prov (
        object_type, object_identity, existed_before
      ) VALUES ('policy', v_tbl || '/' || v_pol, false);
      RAISE NOTICE '[CE-T2-CLEANUP] Policy % on % does not exist — skipped', v_pol, v_tbl;
    END IF;
  END LOOP;

  -- ============================================================
  -- 3. Capture + conditionally grant ce_raw_provider_output SELECT
  -- ============================================================
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'ce_raw_provider_output'
  ) THEN
    -- Capture table owner
    SELECT pg_get_userbyid(c.relowner) INTO v_owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'ce_raw_provider_output';

    -- Capture canonical ACL
    SELECT coalesce(c.relacl::text, 'NULL') INTO v_acl_snap
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'ce_raw_provider_output';

    -- Capture RLS state
    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'ce_raw_provider_output';

    -- Check if authenticated already has SELECT
    v_grant_existed := EXISTS (
      SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'ce_raw_provider_output'
        AND grantee = 'authenticated' AND privilege_type = 'SELECT'
    );

    INSERT INTO public._ce_t2_rls_cleanup_prov (
      object_type, object_identity, existed_before,
      prior_owner, prior_acl, prior_rls,
      prior_definition
    ) VALUES (
      'grant', 'ce_raw_provider_output/authenticated/SELECT', v_grant_existed,
      v_owner, v_acl_snap, v_rls,
      CASE WHEN v_grant_existed THEN 'pre_existing' ELSE 'absent' END
    );

    IF NOT v_grant_existed THEN
      EXECUTE 'GRANT SELECT ON public.ce_raw_provider_output TO authenticated';
      RAISE NOTICE '[CE-T2-CLEANUP] Granted SELECT on ce_raw_provider_output to authenticated';

      -- Record applied state
      UPDATE public._ce_t2_rls_cleanup_prov
        SET applied_state_hash = md5((
          SELECT coalesce(c.relacl::text, 'NULL')
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'ce_raw_provider_output'
        ))
        WHERE object_type = 'grant'
          AND object_identity = 'ce_raw_provider_output/authenticated/SELECT';
    ELSE
      RAISE NOTICE '[CE-T2-CLEANUP] SELECT on ce_raw_provider_output already granted — skipped';
      UPDATE public._ce_t2_rls_cleanup_prov
        SET applied_state_hash = 'UNCHANGED'
        WHERE object_type = 'grant'
          AND object_identity = 'ce_raw_provider_output/authenticated/SELECT';
    END IF;
  END IF;

  RAISE NOTICE '[CE-T2-CLEANUP] Migration complete';
END $mig$;

COMMIT;
