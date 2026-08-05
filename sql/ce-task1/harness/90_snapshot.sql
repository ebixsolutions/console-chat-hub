-- Catalog + ACL + RLS + flag snapshot used to prove exact pre-state restoration.
\pset tuples_only on
\pset format unaligned

SELECT 'COLUMN|'||c.relname||'|'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'
       ||a.attnotnull||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'-')
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='public' AND c.relkind IN ('r','v');

SELECT 'RELATION|'||c.relkind||'|'||c.relname||'|rls='||c.relrowsecurity
       ||'|acl='||coalesce(array_to_string(c.relacl::text[],','),'-')
       ||'|owner='||pg_get_userbyid(c.relowner)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','v','i');

SELECT 'POLICY|'||c.relname||'|'||p.polname||'|'||p.polpermissive||'|'||p.polcmd
       ||'|'||coalesce(pg_get_expr(p.polqual,p.polrelid),'-')
       ||'|'||coalesce(pg_get_expr(p.polwithcheck,p.polrelid),'-')
  FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public';

SELECT 'FUNCTION|'||p.oid::regprocedure::text||'|'||md5(pg_get_functiondef(p.oid))
       ||'|acl='||coalesce(array_to_string(p.proacl::text[],','),'-')
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';

SELECT 'TRIGGER|'||c.relname||'|'||t.tgname||'|'||md5(pg_get_triggerdef(t.oid))
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE NOT t.tgisinternal AND n.nspname='public';

SELECT 'INDEX|'||indexname||'|'||md5(indexdef) FROM pg_indexes WHERE schemaname='public';

SELECT 'VIEW|'||viewname||'|'||md5(definition) FROM pg_views WHERE schemaname='public';

SELECT 'FLAG|'||key||'|'||enabled FROM public.ce_feature_flags;

SELECT 'ROWCOUNT|conversations|'||count(*) FROM public.conversations;
SELECT 'ROWCOUNT|messages|'||count(*) FROM public.messages;
SELECT 'ROWCOUNT|channel_config|'||count(*) FROM public.channel_config;
SELECT 'ROWCOUNT|upstream_call_log|'||count(*) FROM public.upstream_call_log;
SELECT 'ROWCOUNT|user_roles|'||count(*) FROM public.user_roles;
