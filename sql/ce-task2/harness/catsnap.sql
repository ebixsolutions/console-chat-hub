SELECT md5(string_agg(sub, E'\n' ORDER BY sub)) FROM (
  SELECT 'fn:' || p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || pg_get_userbyid(p.proowner) || ':' || COALESCE(array_to_string(p.proacl, ','), 'NULL') AS sub
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f'
  UNION ALL
  SELECT 'vw:' || c.relname || ':' || md5(pg_get_viewdef(c.oid, true)) || ':' || pg_get_userbyid(c.relowner) || ':' || COALESCE(array_to_string(c.relacl, ','), 'NULL')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v'
  UNION ALL
  SELECT 'tbl:' || c.relname || ':' || pg_get_userbyid(c.relowner) || ':' || c.relrowsecurity || ':' || COALESCE(array_to_string(c.relacl, ','), 'NULL')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname IN ('ce_feature_flags', '_ce_t2f_prov_8a3c', '_ce_t2r_prov_7b2d')
  UNION ALL
  SELECT 'key:' || key || ':' || enabled || ':' || updated_at FROM public.ce_feature_flags
  UNION ALL
  SELECT 'rprov:' || obj_kind || ':' || obj_ident || ':' || created FROM public._ce_t2r_prov_7b2d
  UNION ALL
  SELECT 'fprov:' || obj_kind || ':' || obj_ident || ':' || created FROM public._ce_t2f_prov_8a3c
  UNION ALL
  SELECT 'pol:' || polname || ':' || polpermissive::text || ':' || polcmd::text || ':' || COALESCE(array_to_string(polroles::text[], ','), '') || ':' || COALESCE(pg_get_expr(polqual, polrelid), '') || ':' || COALESCE(pg_get_expr(polwithcheck, polrelid), '')
    FROM pg_policy WHERE polrelid = 'public.ce_feature_flags'::regclass
) x;
