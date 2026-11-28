-- PROPOSAL ONLY. Stop new five-argument caller traffic first; restore captured
-- current Edge baseline with original JWT/import-map, not an arbitrary version.
-- Never delete business receipts/messages to achieve exact rollback.
BEGIN;
DO $guard$
BEGIN
 IF md5(pg_get_functiondef('public.agent_send_reply_tx(uuid,uuid,text,text)'::regprocedure)) <> '2491450055223f90ff932b0faf64c560' THEN RAISE EXCEPTION 'Baseline drift; do not roll back another change'; END IF;
 IF nullif(current_setting('c3.f06_expected_definition_md5',true),'') IS NULL OR
    md5(pg_get_functiondef('public.agent_send_reply_tx(uuid,uuid,text,text,uuid)'::regprocedure)) IS DISTINCT FROM current_setting('c3.f06_expected_definition_md5',true)
 THEN RAISE EXCEPTION 'Missing or mismatched captured five-argument definition hash'; END IF;
 IF nullif(current_setting('c3.f06_expected_acl_md5',true),'') IS NULL OR (SELECT md5(proacl::text) FROM pg_proc WHERE oid='public.agent_send_reply_tx(uuid,uuid,text,text,uuid)'::regprocedure) IS DISTINCT FROM current_setting('c3.f06_expected_acl_md5',true) THEN RAISE EXCEPTION 'Missing or mismatched captured RPC ACL'; END IF;
 IF nullif(current_setting('c3.f06_expected_table_fingerprint',true),'') IS NULL OR md5(jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum) FROM pg_attribute WHERE attrelid='public.c3_agent_reply_request'::regclass AND attnum>0 AND NOT attisdropped),'constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid='public.c3_agent_reply_request'::regclass),'rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.c3_agent_reply_request'::regclass),'acl',(SELECT relacl::text FROM pg_class WHERE oid='public.c3_agent_reply_request'::regclass))::text) IS DISTINCT FROM current_setting('c3.f06_expected_table_fingerprint',true) THEN RAISE EXCEPTION 'Missing or mismatched captured table schema/RLS/ACL'; END IF;
 IF EXISTS (SELECT 1 FROM public.c3_agent_reply_request) THEN RAISE EXCEPTION 'Receipts exist; retain additive objects, obtain reviewed data retention decision'; END IF;
 -- Before executing, compare five-argument definition/ACL and table definition
 -- against this release's captured post-apply hashes; missing approval = stop.
END $guard$;
DROP FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text,uuid);
DROP TABLE public.c3_agent_reply_request;
COMMIT;
