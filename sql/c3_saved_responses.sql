-- CANDIDATE: requires Director approval of these exact bytes before Production DDL.
-- Scope: ALL eligible Production tenants, owner-only; not a C3-only database grant.
-- One atomic transaction. Capture the returned installation_receipt outside the DB.
-- The receipt must accompany a future rollback; never substitute a later receipt.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('c3.saved_response.schema.v2',0));
DO $preimage$
BEGIN
  IF to_regclass('public.saved_response') IS NOT NULL
    OR to_regclass('public.saved_response_pkey') IS NOT NULL
    OR to_regclass('public.saved_response_owner_idx') IS NOT NULL
    OR to_regprocedure('public.c3_saved_response_revision()') IS NOT NULL
    OR to_regtype('public.saved_response') IS NOT NULL
    OR to_regtype('public._saved_response') IS NOT NULL THEN
    RAISE EXCEPTION 'saved_response_preimage_not_absent';
  END IF;
END $preimage$;
CREATE TABLE public.saved_response (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.company(id),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 100),
  content text NOT NULL CHECK (length(btrim(content)) BETWEEN 1 AND 4000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_response_owner_idx ON public.saved_response(company_id,owner_id,title,id);
ALTER TABLE public.saved_response ENABLE ROW LEVEL SECURITY;
CREATE POLICY saved_response_owner_scope ON public.saved_response TO authenticated
USING (owner_id=auth.uid() AND EXISTS (
  SELECT 1 FROM public.company_membership m JOIN public.company c ON c.id=m.company_id
  WHERE m.user_id=auth.uid() AND m.company_id=saved_response.company_id
    AND m.is_active AND c.is_active AND m.role IN ('admin','supervisor','agent')
) AND (SELECT count(DISTINCT company_id) FROM public.company_membership WHERE user_id=auth.uid() AND is_active)=1)
WITH CHECK (owner_id=auth.uid() AND EXISTS (
  SELECT 1 FROM public.company_membership m JOIN public.company c ON c.id=m.company_id
  WHERE m.user_id=auth.uid() AND m.company_id=saved_response.company_id
    AND m.is_active AND c.is_active AND m.role IN ('admin','supervisor','agent')
) AND (SELECT count(DISTINCT company_id) FROM public.company_membership WHERE user_id=auth.uid() AND is_active)=1);
-- Supabase default ACL can grant ALL (including RLS-bypassing TRUNCATE).
-- Whitelist CRUD explicitly; preserve trusted owner/service-role defaults only.
REVOKE ALL ON public.saved_response FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.saved_response TO authenticated;
CREATE FUNCTION public.c3_saved_response_revision() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.id<>OLD.id OR NEW.company_id<>OLD.company_id OR NEW.owner_id<>OLD.owner_id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'saved_response_revision_conflict';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.c3_saved_response_revision() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER saved_response_revision BEFORE UPDATE ON public.saved_response FOR EACH ROW EXECUTE FUNCTION public.c3_saved_response_revision();
DO $receipt$
DECLARE v_table oid := 'public.saved_response'::regclass; v_hash text; v_receipt jsonb;
BEGIN

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

  v_receipt=jsonb_build_object('kind','c3.saved_response.installation.v2',
    'table_oid',v_table,'catalog_sha256',v_hash,'installation_xid',pg_current_xact_id()::text,
    'preimage','all_named_objects_absent');
  EXECUTE format('COMMENT ON TABLE public.saved_response IS %L',v_receipt::text);
END $receipt$;
SELECT obj_description('public.saved_response'::regclass,'pg_class')::jsonb AS installation_receipt;
COMMIT;
