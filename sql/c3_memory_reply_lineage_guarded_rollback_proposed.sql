-- NOT AUTHORIZED FOR PRODUCTION. Fail-closed removal of UNUSED additive objects.
-- First restore the previous callers, prove no active invocation, and capture
-- exact new RPC/table fingerprint. Used receipts/current Memory are NEVER deleted
-- or rewritten; retain additive objects in that case and review forward repair.
BEGIN;
LOCK TABLE public.c3_memory_reply_lifecycle_receipt IN ACCESS EXCLUSIVE MODE;
DO $$ DECLARE actual text; BEGIN
 IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Approved owner execution required'; END IF;
 IF md5(pg_get_functiondef('public.c3_finalize_memory_reply_tx(uuid,uuid,uuid,uuid,bigint,text,jsonb,text)'::regprocedure))
    IS DISTINCT FROM nullif(current_setting('c3.expected_reply_rpc_md5',true),'') THEN
   RAISE EXCEPTION 'Reply RPC drift; retain objects';
 END IF;
 SELECT md5(jsonb_build_object(
   'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,
   'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
   'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
   'policies',(SELECT jsonb_agg(pg_get_expr(p.polqual,p.polrelid) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=c.oid),
   'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
 )::text) INTO actual FROM pg_class c WHERE c.oid='public.c3_memory_reply_lifecycle_receipt'::regclass;
 IF actual IS DISTINCT FROM nullif(current_setting('c3.expected_reply_table_fingerprint',true),'') THEN
   RAISE EXCEPTION 'Reply table/ACL/trigger drift; retain objects';
 END IF;
 IF EXISTS(SELECT 1 FROM public.c3_memory_reply_lifecycle_receipt) THEN
   RAISE EXCEPTION 'Used lifecycle receipts must be retained';
 END IF;
END $$;
DROP FUNCTION public.c3_finalize_memory_reply_tx(uuid,uuid,uuid,uuid,bigint,text,jsonb,text);
DROP TABLE public.c3_memory_reply_lifecycle_receipt;
-- No CASCADE, no original RPC/trigger alteration, no Memory data rollback.
COMMIT;
