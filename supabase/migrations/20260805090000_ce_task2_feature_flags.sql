BEGIN;
SET LOCAL lock_timeout = '10s';

DO $all$
DECLARE
  v_exists boolean; v_owner text; v_acl text[]; v_rls boolean;
  v_pol_exists boolean; v_poldef text;
  v_key text;
  v_keys text[] := ARRAY['ce_grounding_fail_closed_enabled','ce_replay_bundle_enabled','ce_console_ui_enabled'];
BEGIN
  -- True no-op: if ledger exists with rows, skip everything (#1)
  IF to_regclass('public._ce_t2f_prov_8a3c') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public._ce_t2f_prov_8a3c) THEN
      RAISE NOTICE 'CE_T2F_ALREADY_APPLIED';
      RETURN;
    END IF;
  END IF;

  IF to_regclass('public._ce_t2f_prov_8a3c') IS NULL THEN
    CREATE TABLE public._ce_t2f_prov_8a3c (
      obj_kind text NOT NULL, obj_ident text NOT NULL, created boolean NOT NULL,
      prior_def text, prior_owner text, prior_acl text[], prior_rls boolean, prior_value jsonb,
      PRIMARY KEY (obj_kind, obj_ident));
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='ce_feature_flags' AND c.relkind='r') INTO v_exists;
  IF v_exists THEN
    SELECT pg_get_userbyid(c.relowner), c.relacl::text[], c.relrowsecurity
      INTO v_owner, v_acl, v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='ce_feature_flags';
    INSERT INTO public._ce_t2f_prov_8a3c VALUES ('table','public.ce_feature_flags',false,NULL,v_owner,v_acl,v_rls,NULL);
  ELSE
    INSERT INTO public._ce_t2f_prov_8a3c VALUES ('table','public.ce_feature_flags',true,NULL,NULL,NULL,NULL,NULL);
  END IF;

  CREATE TABLE IF NOT EXISTS public.ce_feature_flags (
    key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE public.ce_feature_flags ENABLE ROW LEVEL SECURITY;

  SELECT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.ce_feature_flags'::regclass AND polname='ce_flags_read') INTO v_pol_exists;
  IF v_pol_exists THEN
    SELECT format('CREATE POLICY ce_flags_read ON public.ce_feature_flags AS %s FOR %s TO %s USING (%s)%s',
             CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
             CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
             COALESCE((SELECT string_agg(CASE WHEN u=0 THEN 'PUBLIC' ELSE format('%I',(SELECT rolname FROM pg_roles WHERE oid=u)) END, ', ')
                        FROM unnest(polroles) u), 'PUBLIC'),
             COALESCE(pg_get_expr(polqual,polrelid),'true'),
             CASE WHEN polwithcheck IS NOT NULL THEN ' WITH CHECK ('||pg_get_expr(polwithcheck,polrelid)||')' ELSE '' END)
      INTO v_poldef FROM pg_policy WHERE polrelid='public.ce_feature_flags'::regclass AND polname='ce_flags_read';
    INSERT INTO public._ce_t2f_prov_8a3c VALUES ('policy','ce_flags_read',false,v_poldef,NULL,NULL,NULL,NULL);
  ELSE
    INSERT INTO public._ce_t2f_prov_8a3c VALUES ('policy','ce_flags_read',true,NULL,NULL,NULL,NULL,NULL);
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS ce_flags_read ON public.ce_feature_flags';
  EXECUTE 'CREATE POLICY ce_flags_read ON public.ce_feature_flags FOR SELECT TO authenticated USING (true)';
  EXECUTE 'GRANT SELECT ON public.ce_feature_flags TO authenticated';
  EXECUTE 'GRANT ALL ON public.ce_feature_flags TO service_role';

  FOREACH v_key IN ARRAY v_keys LOOP
    IF EXISTS (SELECT 1 FROM public.ce_feature_flags WHERE key=v_key) THEN
      INSERT INTO public._ce_t2f_prov_8a3c
        VALUES ('key',v_key,false,NULL,NULL,NULL,NULL,
                (SELECT jsonb_build_object('enabled',enabled,'updated_at',updated_at) FROM public.ce_feature_flags WHERE key=v_key));
    ELSE
      INSERT INTO public.ce_feature_flags (key,enabled) VALUES (v_key,false);
      INSERT INTO public._ce_t2f_prov_8a3c VALUES ('key',v_key,true,NULL,NULL,NULL,NULL,NULL);
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM public.ce_feature_flags WHERE key=ANY(v_keys)) < 3 THEN
    RAISE EXCEPTION 'CE_T2F_ASSERT: keys'; END IF;
END $all$;

COMMIT;
