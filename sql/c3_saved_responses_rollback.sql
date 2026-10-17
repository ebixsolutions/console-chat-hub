-- CANDIDATE: requires Director approval of these exact bytes before Production DDL.
-- In the SAME session/request, first set c3.saved_responses.expected_installation
-- to the externally retained ORIGINAL installation_receipt JSON (set_config).
-- Empty + unchanged original installation: exact preimage restored, no CASCADE.
-- With data: authenticated CRUD revoked, data retained, PARTIAL_RESTORE only.
-- Missing receipt, catalog drift or successor: fail closed, atomic, no mutation.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('c3.saved_response.schema.v2',0));
-- Acquire the lock in a separate statement so the subsequent check sees committed
-- writers that held the table before this request. No RLS-filtered emptiness test.
LOCK TABLE public.saved_response IN ACCESS EXCLUSIVE MODE;
DO $restore$
DECLARE v_table oid := 'public.saved_response'::regclass; v_hash text;
  v_expected jsonb; v_actual jsonb; v_has_data boolean; v_comment_xid text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'saved_response_rollback_requires_read_committed';
  END IF;
  IF current_setting('c3.saved_responses.expected_installation',true) IS NULL
    OR current_setting('c3.saved_responses.expected_installation',true)='' THEN
    RAISE EXCEPTION 'saved_response_original_receipt_required';
  END IF;
  -- Serialize routine catalog changes with validation and removal of our function.
  PERFORM 1 FROM pg_proc WHERE oid=to_regprocedure('public.c3_saved_response_revision()') FOR UPDATE;
  v_expected=current_setting('c3.saved_responses.expected_installation')::jsonb;
  v_actual=obj_description(v_table,'pg_class')::jsonb;
  SELECT xmin::text INTO v_comment_xid FROM pg_description
    WHERE classoid='pg_class'::regclass AND objoid=v_table AND objsubid=0;
  IF v_actual IS DISTINCT FROM v_expected
    OR v_expected->>'kind' IS DISTINCT FROM 'c3.saved_response.installation.v2'
    OR v_expected->>'preimage' IS DISTINCT FROM 'all_named_objects_absent'
    OR (v_expected->>'table_oid')::oid IS DISTINCT FROM v_table
    OR v_expected->>'installation_xid' IS DISTINCT FROM v_comment_xid THEN
    RAISE EXCEPTION 'saved_response_receipt_or_successor_mismatch';
  END IF;

  WITH rels AS (
    SELECT v_table AS oid UNION SELECT indexrelid FROM pg_index WHERE indrelid=v_table
  ), constraints AS (SELECT oid FROM pg_constraint WHERE conrelid=v_table),
  objects AS (
    SELECT 'class' AS kind, c.oid::text AS key,
      (to_jsonb(c)-ARRAY['relpages','reltuples','relallvisible','relfrozenxid','relminmxid']) || jsonb_build_object('xmin',c.xmin::text) AS value
      FROM pg_class c WHERE c.oid IN (SELECT oid FROM rels)
    UNION ALL SELECT 'attribute',a.attnum::text,to_jsonb(a)||jsonb_build_object('xmin',a.xmin::text)
      FROM pg_attribute a WHERE a.attrelid=v_table AND a.attnum>0
    UNION ALL SELECT 'default',d.oid::text,to_jsonb(d)||jsonb_build_object('xmin',d.xmin::text)
      FROM pg_attrdef d WHERE d.adrelid=v_table
    UNION ALL SELECT 'constraint',c.oid::text,to_jsonb(c)||jsonb_build_object('xmin',c.xmin::text)
      FROM pg_constraint c WHERE c.conrelid=v_table
    UNION ALL SELECT 'index',i.indexrelid::text,to_jsonb(i)||jsonb_build_object('xmin',i.xmin::text)
      FROM pg_index i WHERE i.indrelid=v_table
    UNION ALL SELECT 'policy',p.oid::text,to_jsonb(p)||jsonb_build_object('xmin',p.xmin::text)
      FROM pg_policy p WHERE p.polrelid=v_table
    UNION ALL SELECT 'trigger',t.oid::text,to_jsonb(t)||jsonb_build_object('xmin',t.xmin::text)
      FROM pg_trigger t WHERE t.tgrelid=v_table OR t.tgconstraint IN (SELECT oid FROM constraints)
    UNION ALL SELECT 'function',f.oid::text,to_jsonb(f)||jsonb_build_object('xmin',f.xmin::text)
      FROM pg_proc f WHERE f.oid='public.c3_saved_response_revision()'::regprocedure
    UNION ALL SELECT 'type',t.oid::text,to_jsonb(t)||jsonb_build_object('xmin',t.xmin::text)
      FROM pg_type t WHERE t.typrelid=v_table OR t.oid=(SELECT typarray FROM pg_type WHERE typrelid=v_table)
    UNION ALL SELECT 'description',d.classoid::text||':'||d.objoid::text||':'||d.objsubid::text,
      to_jsonb(d)||jsonb_build_object('xmin',d.xmin::text)
      FROM pg_description d WHERE (d.classoid='pg_class'::regclass AND d.objoid IN (SELECT oid FROM rels)
        AND NOT(d.objoid=v_table AND d.objsubid=0))
        OR (d.classoid='pg_proc'::regclass AND d.objoid='public.c3_saved_response_revision()'::regprocedure)
  ) SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(kind,key,value) ORDER BY kind,key)::text,'UTF8')),'hex')
      INTO v_hash FROM objects;

  IF v_hash IS DISTINCT FROM v_expected->>'catalog_sha256' THEN
    RAISE EXCEPTION 'saved_response_catalog_drift';
  END IF;
  -- Only the original table owner/superuser, with RLS bypass, may prove emptiness.
  IF NOT EXISTS(SELECT FROM pg_class c JOIN pg_roles r ON r.rolname=current_user
    WHERE c.oid=v_table AND (r.rolsuper OR (c.relowner=r.oid AND NOT c.relforcerowsecurity))) THEN
    RAISE EXCEPTION 'saved_response_unfiltered_owner_required';
  END IF;
  SELECT EXISTS(SELECT FROM public.saved_response) INTO v_has_data;
  IF v_has_data THEN
    REVOKE SELECT,INSERT,UPDATE,DELETE ON public.saved_response FROM authenticated;
    IF has_table_privilege('authenticated','public.saved_response','SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'saved_response_inherited_privileges_prevent_pause';
    END IF;
    RAISE NOTICE 'PARTIAL_RESTORE: feature paused; all saved data and schema retained';
  ELSE
    DROP TABLE public.saved_response RESTRICT;
    DROP FUNCTION public.c3_saved_response_revision() RESTRICT;
    IF to_regclass('public.saved_response') IS NOT NULL
      OR to_regclass('public.saved_response_pkey') IS NOT NULL
      OR to_regclass('public.saved_response_owner_idx') IS NOT NULL
      OR to_regprocedure('public.c3_saved_response_revision()') IS NOT NULL
      OR to_regtype('public.saved_response') IS NOT NULL
      OR to_regtype('public._saved_response') IS NOT NULL THEN
      RAISE EXCEPTION 'saved_response_preimage_restore_failed';
    END IF;
    RAISE NOTICE 'EXACT_PREIMAGE_RESTORED: original empty installation removed';
  END IF;
END $restore$;
COMMIT;
