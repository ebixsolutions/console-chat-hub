-- Task 3: close Security Advisor RLS-enabled/no-policy findings for server-only tables.
--
-- These tables are not intended for direct anon/authenticated REST access.
-- service_role retains access and bypasses RLS for trusted server/Edge call chains.
-- The explicit restrictive deny policy both documents intent and prevents accidental
-- future exposure if table grants are broadened.
--
-- Rollback: drop task3_server_only_deny from the listed tables and restore any
-- anon/authenticated table grants only if product architecture explicitly requires
-- direct client access.

do $$
declare
  t text;
begin
  foreach t in array array[
    '_ce_t2_rls_cleanup_prov','_ce_t2f_prov_8a3c','_ce_t2r_prov_7b2d',
    'ce_automation_runtime','ce_evaluation_job','company_backfill_contract',
    'message_attachment_private','migration_object_ledger',
    'pr7_channel_ownership_row','pr7_channel_ownership_run',
    'pr7_company_identity_bootstrap_run','pr7_conversation_lineage_row',
    'pr7_conversation_lineage_run','pr7_membership_bootstrap_row',
    'pr7_membership_bootstrap_run'
  ] loop
    execute format('revoke all privileges on table public.%I from anon, authenticated', t);
    execute format('drop policy if exists task3_server_only_deny on public.%I', t);
    execute format(
      'create policy task3_server_only_deny on public.%I as restrictive for all to public using (false) with check (false)',
      t
    );
  end loop;
end $$;
