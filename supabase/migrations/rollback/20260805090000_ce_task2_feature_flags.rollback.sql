BEGIN;
SET LOCAL lock_timeout = '10s';

DO $rb$
DECLARE
  r record; v_created_tbl boolean;
  v_grantee text; v_privs text; i int;
  v_pre_owner text; v_pre_acl text[]; v_pre_rls boolean;
  v_cur_acl text[]; v_ace text;
  v_cur_poldef text;
BEGIN
  IF to_regclass('public._ce_t2f_prov_8a3c') IS NULL THEN RAISE NOTICE 'CE_T2F_RB_NOOP'; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public._ce_t2f_prov_8a3c) THEN RAISE NOTICE 'CE_T2F_RB_NOOP'; RETURN; END IF;

  v_created_tbl := COALESCE((SELECT created FROM public._ce_t2f_prov_8a3c WHERE obj_kind='table'),false);

  FOR r IN SELECT obj_ident, prior_value FROM public._ce_t2f_prov_8a3c WHERE obj_kind='key' AND NOT created AND prior_value IS NOT NULL LOOP
    UPDATE public.ce_feature_flags SET enabled=(r.prior_value->>'enabled')::boolean,
      updated_at=(r.prior_value->>'updated_at')::timestamptz WHERE key=r.obj_ident;
  END LOOP;
  DELETE FROM public.ce_feature_flags WHERE key IN (SELECT obj_ident FROM public._ce_t2f_prov_8a3c WHERE obj_kind='key' AND created);

  IF v_created_tbl AND EXISTS (SELECT 1 FROM public.ce_feature_flags) THEN
    RAISE EXCEPTION 'CE_T2F_RB_BLOCKED: external data'; END IF;

  FOR r IN SELECT * FROM public._ce_t2f_prov_8a3c WHERE obj_kind='policy' LOOP
    DROP POLICY IF EXISTS ce_flags_read ON public.ce_feature_flags;
    IF NOT r.created AND r.prior_def IS NOT NULL THEN
      EXECUTE r.prior_def;
      SELECT format('CREATE POLICY ce_flags_read ON public.ce_feature_flags AS %s FOR %s TO %s USING (%s)%s',
               CASE WHEN polpermissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
               CASE polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' ELSE 'ALL' END,
               COALESCE((SELECT string_agg(CASE WHEN u=0 THEN 'PUBLIC' ELSE format('%I',(SELECT rolname FROM pg_roles WHERE oid=u)) END, ', ')
                          FROM unnest(polroles) u), 'PUBLIC'),
               COALESCE(pg_get_expr(polqual,polrelid),'true'),
               CASE WHEN polwithcheck IS NOT NULL THEN ' WITH CHECK ('||pg_get_expr(polwithcheck,polrelid)||')' ELSE '' END)
        INTO v_cur_poldef FROM pg_policy WHERE polrelid='public.ce_feature_flags'::regclass AND polname='ce_flags_read';
      IF v_cur_poldef IS DISTINCT FROM r.prior_def THEN
        RAISE EXCEPTION 'CE_T2F_RB_ASSERT: policy def'; END IF;
    END IF;
  END LOOP;

  IF v_created_tbl THEN
    DROP TABLE public.ce_feature_flags CASCADE;
    IF to_regclass('public.ce_feature_flags') IS NOT NULL THEN RAISE EXCEPTION 'CE_T2F_RB_ASSERT: tbl'; END IF;
  ELSE
    SELECT prior_owner, prior_acl, prior_rls INTO v_pre_owner, v_pre_acl, v_pre_rls
      FROM public._ce_t2f_prov_8a3c WHERE obj_kind='table';
    IF v_pre_rls IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.ce_feature_flags %s ROW LEVEL SECURITY',
                     CASE WHEN v_pre_rls THEN 'ENABLE' ELSE 'DISABLE' END); END IF;
    SELECT relacl::text[] INTO v_cur_acl FROM pg_class WHERE oid='public.ce_feature_flags'::regclass;
    IF v_cur_acl IS NOT NULL THEN
      FOREACH v_ace IN ARRAY v_cur_acl LOOP
        v_grantee := split_part(v_ace,'=',1);
        IF v_grantee='' THEN REVOKE ALL ON public.ce_feature_flags FROM PUBLIC;
        ELSE EXECUTE format('REVOKE ALL ON public.ce_feature_flags FROM %I',v_grantee); END IF;
      END LOOP;
    END IF;
    IF v_pre_acl IS NOT NULL THEN
      FOR i IN 1..array_length(v_pre_acl,1) LOOP
        v_grantee := split_part(v_pre_acl[i],'=',1); v_privs := split_part(split_part(v_pre_acl[i],'=',2),'/',1);
        IF v_privs~'r' THEN IF v_grantee='' THEN EXECUTE 'GRANT SELECT ON public.ce_feature_flags TO PUBLIC'; ELSE EXECUTE format('GRANT SELECT ON public.ce_feature_flags TO %I',v_grantee); END IF; IF v_privs~'r\*' THEN IF v_grantee='' THEN EXECUTE 'GRANT SELECT ON public.ce_feature_flags TO PUBLIC WITH GRANT OPTION'; ELSE EXECUTE format('GRANT SELECT ON public.ce_feature_flags TO %I WITH GRANT OPTION',v_grantee); END IF; END IF; END IF;
        IF v_privs~'a' THEN IF v_grantee='' THEN EXECUTE 'GRANT INSERT ON public.ce_feature_flags TO PUBLIC'; ELSE EXECUTE format('GRANT INSERT ON public.ce_feature_flags TO %I',v_grantee); END IF; IF v_privs~'a\*' THEN IF v_grantee='' THEN EXECUTE 'GRANT INSERT ON public.ce_feature_flags TO PUBLIC WITH GRANT OPTION'; ELSE EXECUTE format('GRANT INSERT ON public.ce_feature_flags TO %I WITH GRANT OPTION',v_grantee); END IF; END IF; END IF;
        IF v_privs~'w' THEN IF v_grantee='' THEN EXECUTE 'GRANT UPDATE ON public.ce_feature_flags TO PUBLIC'; ELSE EXECUTE format('GRANT UPDATE ON public.ce_feature_flags TO %I',v_grantee); END IF; IF v_privs~'w\*' THEN IF v_grantee='' THEN EXECUTE 'GRANT UPDATE ON public.ce_feature_flags TO PUBLIC WITH GRANT OPTION'; ELSE EXECUTE format('GRANT UPDATE ON public.ce_feature_flags TO %I WITH GRANT OPTION',v_grantee); END IF; END IF; END IF;
        IF v_privs~'d' THEN IF v_grantee='' THEN EXECUTE 'GRANT DELETE ON public.ce_feature_flags TO PUBLIC'; ELSE EXECUTE format('GRANT DELETE ON public.ce_feature_flags TO %I',v_grantee); END IF; IF v_privs~'d\*' THEN IF v_grantee='' THEN EXECUTE 'GRANT DELETE ON public.ce_feature_flags TO PUBLIC WITH GRANT OPTION'; ELSE EXECUTE format('GRANT DELETE ON public.ce_feature_flags TO %I WITH GRANT OPTION',v_grantee); END IF; END IF; END IF;
        IF v_privs~'D' THEN IF v_grantee='' THEN EXECUTE 'GRANT TRUNCATE ON public.ce_feature_flags TO PUBLIC'; ELSE EXECUTE format('GRANT TRUNCATE ON public.ce_feature_flags TO %I',v_grantee); END IF; IF v_privs~'D\*' THEN IF v_grantee='' THEN EXECUTE 'GRANT TRUNCATE ON public.ce_feature_flags TO PUBLIC WITH GRANT OPTION'; ELSE EXECUTE format('GRANT TRUNCATE ON public.ce_feature_flags TO %I WITH GRANT OPTION',v_grantee); END IF; END IF; END IF;
        IF v_privs~'x' THEN IF v_grantee='' THEN EXECUTE 'GRANT REFERENCES ON public.ce_feature_flags TO PUBLIC'; ELSE EXECUTE format('GRANT REFERENCES ON public.ce_feature_flags TO %I',v_grantee); END IF; IF v_privs~'x\*' THEN IF v_grantee='' THEN EXECUTE 'GRANT REFERENCES ON public.ce_feature_flags TO PUBLIC WITH GRANT OPTION'; ELSE EXECUTE format('GRANT REFERENCES ON public.ce_feature_flags TO %I WITH GRANT OPTION',v_grantee); END IF; END IF; END IF;
        IF v_privs~'t' THEN IF v_grantee='' THEN EXECUTE 'GRANT TRIGGER ON public.ce_feature_flags TO PUBLIC'; ELSE EXECUTE format('GRANT TRIGGER ON public.ce_feature_flags TO %I',v_grantee); END IF; IF v_privs~'t\*' THEN IF v_grantee='' THEN EXECUTE 'GRANT TRIGGER ON public.ce_feature_flags TO PUBLIC WITH GRANT OPTION'; ELSE EXECUTE format('GRANT TRIGGER ON public.ce_feature_flags TO %I WITH GRANT OPTION',v_grantee); END IF; END IF; END IF;
      END LOOP;
    END IF;
    IF v_pre_owner IS NOT NULL THEN EXECUTE format('ALTER TABLE public.ce_feature_flags OWNER TO %I',v_pre_owner); END IF;
    -- Grantor-agnostic ACL comparison (#6)
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.ce_feature_flags'::regclass) IS DISTINCT FROM v_pre_owner THEN
      RAISE EXCEPTION 'CE_T2F_RB_ASSERT: owner'; END IF;
    IF (SELECT relrowsecurity FROM pg_class WHERE oid='public.ce_feature_flags'::regclass) IS DISTINCT FROM v_pre_rls THEN
      RAISE EXCEPTION 'CE_T2F_RB_ASSERT: RLS'; END IF;
    IF (SELECT array_agg(split_part(a,'/',1) ORDER BY split_part(a,'/',1))
          FROM unnest(COALESCE((SELECT relacl::text[] FROM pg_class WHERE oid='public.ce_feature_flags'::regclass),'{}')) a)
       IS DISTINCT FROM
       (SELECT array_agg(split_part(a,'/',1) ORDER BY split_part(a,'/',1))
          FROM unnest(COALESCE(v_pre_acl,'{}')) a) THEN
      RAISE EXCEPTION 'CE_T2F_RB_ASSERT: ACL'; END IF;
  END IF;

  DELETE FROM public._ce_t2f_prov_8a3c;
END $rb$;

DO $cleanup$ BEGIN
  IF to_regclass('public._ce_t2f_prov_8a3c') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public._ce_t2f_prov_8a3c) THEN DROP TABLE public._ce_t2f_prov_8a3c; END IF;
  END IF;
END $cleanup$;

COMMIT;
