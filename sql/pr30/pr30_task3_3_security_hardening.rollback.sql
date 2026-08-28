-- Task 3.3 security hardening rollback.
-- WARNING: this restores the exact pre-hardening access model and therefore
-- re-opens the exposure closed by pr30_task3_3_security_hardening.sql.
-- Use only for controlled emergency rollback with production-owner approval.

BEGIN;

DROP POLICY IF EXISTS ai_reply_draft_read ON public.ai_reply_draft;
CREATE POLICY ai_reply_draft_read
ON public.ai_reply_draft
FOR SELECT
TO authenticated
USING (true);

DROP POLICY IF EXISTS handoff_event_read ON public.handoff_event;
CREATE POLICY handoff_event_read
ON public.handoff_event
FOR SELECT
TO authenticated
USING (true);

DO $restore_internal$
DECLARE
  t text;
  tables text[] := ARRAY[
    '_ce_t2_rls_cleanup_prov',
    '_ce_t2f_prov_8a3c',
    '_ce_t2r_prov_7b2d',
    'migration_object_ledger',
    'pr7_channel_ownership_row',
    'pr7_channel_ownership_run',
    'pr7_company_identity_bootstrap_run',
    'pr7_conversation_lineage_row',
    'pr7_conversation_lineage_run',
    'pr7_membership_bootstrap_row',
    'pr7_membership_bootstrap_run'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
      EXECUTE format('GRANT ALL ON TABLE public.%I TO anon, authenticated', t);
    END IF;
  END LOOP;
END
$restore_internal$;

COMMIT;
