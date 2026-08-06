BEGIN;
SET LOCAL lock_timeout = '10s';
DO $rb$
DECLARE
  r record; v_grantee text; v_privs text; i int; v_ace text; v_cur_acl text[];
BEGIN
  IF to_regclass('public._ce_t2r_prov_7b2d') IS NULL THEN RAISE NOTICE 'CE_T2R_RB_NOOP'; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public._ce_t2r_prov_7b2d) THEN RAISE NOTICE 'CE_T2R_RB_NOOP'; RETURN; END IF;
  FOR r IN SELECT obj_ident FROM public._ce_t2r_prov_7b2d WHERE created AND obj_kind='view' LOOP
    EXECUTE format('DROP VIEW IF EXISTS %s', r.obj_ident);
    IF to_regclass(r.obj_ident) IS NOT NULL THEN RAISE EXCEPTION 'CE_T2R_RB: view % !dropped', r.obj_ident; END IF;
  END LOOP;
  FOR r IN SELECT obj_ident FROM public._ce_t2r_prov_7b2d WHERE created AND obj_kind='function' LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.obj_ident);
  END LOOP;
  -- RESTORE replaced functions
  FOR r IN SELECT * FROM public._ce_t2r_prov_7b2d WHERE NOT created AND obj_kind='function' AND prior_def IS NOT NULL LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.obj_ident);
    EXECUTE r.prior_def;
    IF r.prior_owner IS NOT NULL THEN EXECUTE format('ALTER FUNCTION %s OWNER TO %I', r.obj_ident, r.prior_owner); END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.obj_ident);
    SELECT proacl::text[] INTO v_cur_acl FROM pg_proc WHERE oid=r.obj_ident::regprocedure;
    IF v_cur_acl IS NOT NULL THEN
      FOREACH v_ace IN ARRAY v_cur_acl LOOP
        v_grantee := split_part(v_ace,'=',1);
        IF v_grantee='' THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',r.obj_ident);
        ELSE EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',r.obj_ident,v_grantee); END IF;
      END LOOP;
    END IF;
    IF r.prior_acl IS NOT NULL THEN
      FOR i IN 1..array_length(r.prior_acl,1) LOOP
        v_grantee:=split_part(r.prior_acl[i],'=',1); v_privs:=split_part(split_part(r.prior_acl[i],'=',2),'/',1);
        IF v_privs~'X' THEN
          IF v_grantee='' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC',r.obj_ident);
          ELSE EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',r.obj_ident,v_grantee); END IF;
          IF v_privs~'X\*' THEN
            IF v_grantee='' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC WITH GRANT OPTION',r.obj_ident);
            ELSE EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I WITH GRANT OPTION',r.obj_ident,v_grantee); END IF;
          END IF;
        END IF;
      END LOOP;
    END IF;
    IF md5(pg_get_functiondef(r.obj_ident::regprocedure))<>md5(r.prior_def) THEN RAISE EXCEPTION 'CE_T2R_RB: % def',r.obj_ident; END IF;
    IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=r.obj_ident::regprocedure) IS DISTINCT FROM r.prior_owner THEN RAISE EXCEPTION 'CE_T2R_RB: % own',r.obj_ident; END IF;
    IF (SELECT array_agg(split_part(a,'/',1) ORDER BY split_part(a,'/',1)) FROM unnest(COALESCE((SELECT proacl::text[] FROM pg_proc WHERE oid=r.obj_ident::regprocedure),'{}')) a)
       IS DISTINCT FROM (SELECT array_agg(split_part(a,'/',1) ORDER BY split_part(a,'/',1)) FROM unnest(COALESCE(r.prior_acl,'{}')) a) THEN
      RAISE EXCEPTION 'CE_T2R_RB: % ACL',r.obj_ident; END IF;
  END LOOP;
  -- RESTORE replaced views (full ACL with grant options #5)
  FOR r IN SELECT * FROM public._ce_t2r_prov_7b2d WHERE NOT created AND obj_kind='view' AND prior_def IS NOT NULL LOOP
    EXECUTE format('DROP VIEW IF EXISTS %s', r.obj_ident);
    EXECUTE r.prior_def;
    IF r.prior_owner IS NOT NULL THEN EXECUTE format('ALTER VIEW %s OWNER TO %I', r.obj_ident, r.prior_owner); END IF;
    SELECT relacl::text[] INTO v_cur_acl FROM pg_class WHERE oid=r.obj_ident::regclass;
    IF v_cur_acl IS NOT NULL THEN
      FOREACH v_ace IN ARRAY v_cur_acl LOOP
        v_grantee:=split_part(v_ace,'=',1);
        IF v_grantee='' THEN EXECUTE format('REVOKE ALL ON %s FROM PUBLIC',r.obj_ident);
        ELSE EXECUTE format('REVOKE ALL ON %s FROM %I',r.obj_ident,v_grantee); END IF;
      END LOOP;
    END IF;
    IF r.prior_acl IS NOT NULL THEN
      FOR i IN 1..array_length(r.prior_acl,1) LOOP
        v_grantee:=split_part(r.prior_acl[i],'=',1); v_privs:=split_part(split_part(r.prior_acl[i],'=',2),'/',1);
        IF v_privs~'r' THEN IF v_grantee='' THEN EXECUTE format('GRANT SELECT ON %s TO PUBLIC',r.obj_ident); ELSE EXECUTE format('GRANT SELECT ON %s TO %I',r.obj_ident,v_grantee); END IF;
          IF v_privs~'r\*' THEN IF v_grantee='' THEN EXECUTE format('GRANT SELECT ON %s TO PUBLIC WITH GRANT OPTION',r.obj_ident); ELSE EXECUTE format('GRANT SELECT ON %s TO %I WITH GRANT OPTION',r.obj_ident,v_grantee); END IF; END IF; END IF;
        IF v_privs~'a' THEN IF v_grantee='' THEN EXECUTE format('GRANT INSERT ON %s TO PUBLIC',r.obj_ident); ELSE EXECUTE format('GRANT INSERT ON %s TO %I',r.obj_ident,v_grantee); END IF;
          IF v_privs~'a\*' THEN IF v_grantee='' THEN EXECUTE format('GRANT INSERT ON %s TO PUBLIC WITH GRANT OPTION',r.obj_ident); ELSE EXECUTE format('GRANT INSERT ON %s TO %I WITH GRANT OPTION',r.obj_ident,v_grantee); END IF; END IF; END IF;
        IF v_privs~'w' THEN IF v_grantee='' THEN EXECUTE format('GRANT UPDATE ON %s TO PUBLIC',r.obj_ident); ELSE EXECUTE format('GRANT UPDATE ON %s TO %I',r.obj_ident,v_grantee); END IF;
          IF v_privs~'w\*' THEN IF v_grantee='' THEN EXECUTE format('GRANT UPDATE ON %s TO PUBLIC WITH GRANT OPTION',r.obj_ident); ELSE EXECUTE format('GRANT UPDATE ON %s TO %I WITH GRANT OPTION',r.obj_ident,v_grantee); END IF; END IF; END IF;
        IF v_privs~'d' THEN IF v_grantee='' THEN EXECUTE format('GRANT DELETE ON %s TO PUBLIC',r.obj_ident); ELSE EXECUTE format('GRANT DELETE ON %s TO %I',r.obj_ident,v_grantee); END IF;
          IF v_privs~'d\*' THEN IF v_grantee='' THEN EXECUTE format('GRANT DELETE ON %s TO PUBLIC WITH GRANT OPTION',r.obj_ident); ELSE EXECUTE format('GRANT DELETE ON %s TO %I WITH GRANT OPTION',r.obj_ident,v_grantee); END IF; END IF; END IF;
        IF v_privs~'D' THEN IF v_grantee='' THEN EXECUTE format('GRANT TRUNCATE ON %s TO PUBLIC',r.obj_ident); ELSE EXECUTE format('GRANT TRUNCATE ON %s TO %I',r.obj_ident,v_grantee); END IF;
          IF v_privs~'D\*' THEN IF v_grantee='' THEN EXECUTE format('GRANT TRUNCATE ON %s TO PUBLIC WITH GRANT OPTION',r.obj_ident); ELSE EXECUTE format('GRANT TRUNCATE ON %s TO %I WITH GRANT OPTION',r.obj_ident,v_grantee); END IF; END IF; END IF;
        IF v_privs~'x' THEN IF v_grantee='' THEN EXECUTE format('GRANT REFERENCES ON %s TO PUBLIC',r.obj_ident); ELSE EXECUTE format('GRANT REFERENCES ON %s TO %I',r.obj_ident,v_grantee); END IF;
          IF v_privs~'x\*' THEN IF v_grantee='' THEN EXECUTE format('GRANT REFERENCES ON %s TO PUBLIC WITH GRANT OPTION',r.obj_ident); ELSE EXECUTE format('GRANT REFERENCES ON %s TO %I WITH GRANT OPTION',r.obj_ident,v_grantee); END IF; END IF; END IF;
        IF v_privs~'t' THEN IF v_grantee='' THEN EXECUTE format('GRANT TRIGGER ON %s TO PUBLIC',r.obj_ident); ELSE EXECUTE format('GRANT TRIGGER ON %s TO %I',r.obj_ident,v_grantee); END IF;
          IF v_privs~'t\*' THEN IF v_grantee='' THEN EXECUTE format('GRANT TRIGGER ON %s TO PUBLIC WITH GRANT OPTION',r.obj_ident); ELSE EXECUTE format('GRANT TRIGGER ON %s TO %I WITH GRANT OPTION',r.obj_ident,v_grantee); END IF; END IF; END IF;
      END LOOP;
    END IF;
    IF to_regclass(r.obj_ident) IS NULL THEN RAISE EXCEPTION 'CE_T2R_RB: view % gone',r.obj_ident; END IF;
    IF md5('CREATE OR REPLACE VIEW '||r.obj_ident||' AS '||pg_get_viewdef(r.obj_ident::regclass,true))<>md5(r.prior_def) THEN RAISE EXCEPTION 'CE_T2R_RB: view % def',r.obj_ident; END IF;
    IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=r.obj_ident::regclass) IS DISTINCT FROM r.prior_owner THEN RAISE EXCEPTION 'CE_T2R_RB: view % own',r.obj_ident; END IF;
    IF (SELECT array_agg(split_part(a,'/',1) ORDER BY split_part(a,'/',1)) FROM unnest(COALESCE((SELECT relacl::text[] FROM pg_class WHERE oid=r.obj_ident::regclass),'{}')) a)
       IS DISTINCT FROM (SELECT array_agg(split_part(a,'/',1) ORDER BY split_part(a,'/',1)) FROM unnest(COALESCE(r.prior_acl,'{}')) a) THEN
      RAISE EXCEPTION 'CE_T2R_RB: view % ACL',r.obj_ident; END IF;
  END LOOP;
  DELETE FROM public._ce_t2r_prov_7b2d;
  RAISE NOTICE 'CE_T2R_RB_COMPLETE';
END $rb$;
DO $cleanup$ BEGIN
  IF to_regclass('public._ce_t2r_prov_7b2d') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public._ce_t2r_prov_7b2d) THEN DROP TABLE public._ce_t2r_prov_7b2d; END IF;
  END IF;
END $cleanup$;
COMMIT;
