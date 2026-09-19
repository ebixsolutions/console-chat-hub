-- Nonproduction-only closure for advisor findings exposed by bootstrapping a
-- blank project from historical repository artifacts. This only tightens
-- access; it does not alter product data or production migrations.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    '_ce_t2_rls_cleanup_prov','_ce_t2f_prov_8a3c','_ce_t2r_prov_7b2d',
    'migration_object_ledger','pr7_channel_ownership_row','pr7_channel_ownership_run',
    'pr7_company_identity_bootstrap_run','pr7_conversation_lineage_row',
    'pr7_conversation_lineage_run','pr7_membership_bootstrap_row',
    'pr7_membership_bootstrap_run'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS c3_nonproduction_probe_deny ON public.c3_nonproduction_http_probe;
CREATE POLICY c3_nonproduction_probe_deny ON public.c3_nonproduction_http_probe
AS RESTRICTIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false);

REVOKE EXECUTE ON FUNCTION public.pr6_enqueue_canonical_evaluation()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_conversation_resolution_tx(uuid,uuid,uuid,uuid,text,text)
  FROM PUBLIC, anon;

ALTER FUNCTION public.initiate_evaluation(uuid,text,text,text,text,text,text,text)
  SET search_path TO '';
ALTER FUNCTION public.initiate_evaluation(uuid,text,text,text,text,text,text,uuid,text)
  SET search_path TO '';
ALTER FUNCTION public.complete_evaluation(uuid,jsonb)
  SET search_path TO '';
