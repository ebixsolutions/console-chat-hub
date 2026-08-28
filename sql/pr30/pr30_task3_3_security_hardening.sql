-- Task 3.3 activation hardening discovered during production security scan.
-- Closes same-class RLS exposure without reopening deferred/frozen scopes.

BEGIN;

-- Tenant-scope customer-derived tables by canonical conversation.company_id.
DROP POLICY IF EXISTS ai_reply_draft_read ON public.ai_reply_draft;
CREATE POLICY ai_reply_draft_read
ON public.ai_reply_draft
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.company_membership cm
      ON cm.company_id = c.company_id
     AND cm.user_id = auth.uid()
     AND cm.is_active = true
    JOIN public.company co
      ON co.id = cm.company_id
     AND co.is_active = true
    WHERE c.id = ai_reply_draft.conversation_id
  )
);

DROP POLICY IF EXISTS handoff_event_read ON public.handoff_event;
CREATE POLICY handoff_event_read
ON public.handoff_event
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    JOIN public.company_membership cm
      ON cm.company_id = c.company_id
     AND cm.user_id = auth.uid()
     AND cm.is_active = true
    JOIN public.company co
      ON co.id = cm.company_id
     AND co.is_active = true
    WHERE c.id = handoff_event.conversation_id
  )
);

-- Internal migration/provenance tables are never browser-readable/writable.
DO $secure_internal$
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
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I TO service_role', t);
    END IF;
  END LOOP;
END
$secure_internal$;

-- Machine assertions.
DO $assert$
DECLARE
  leaked integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='ai_reply_draft'
      AND policyname='ai_reply_draft_read'
      AND qual='true'
  ) THEN
    RAISE EXCEPTION 'ASSERT: ai_reply_draft policy remains globally readable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public'
      AND tablename='handoff_event'
      AND policyname='handoff_event_read'
      AND qual='true'
  ) THEN
    RAISE EXCEPTION 'ASSERT: handoff_event policy remains globally readable';
  END IF;

  SELECT count(*) INTO leaked
  FROM information_schema.role_table_grants g
  JOIN pg_class c ON c.relname = g.table_name
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = g.table_schema
  WHERE g.table_schema='public'
    AND g.grantee IN ('anon','authenticated')
    AND c.relkind='r'
    AND c.relrowsecurity = false;

  IF leaked <> 0 THEN
    RAISE EXCEPTION 'ASSERT: public base tables without RLS still granted to anon/authenticated: %', leaked;
  END IF;
END
$assert$;

COMMIT;
