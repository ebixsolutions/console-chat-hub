-- Task 2: SECURITY DEFINER RPC exposure + RBAC/RLS hardening
--
-- Security model:
--   * All public SECURITY DEFINER functions are denied to PUBLIC/anon/authenticated by default.
--   * service_role retains EXECUTE for trusted Edge/server runtime call chains.
--   * authenticated receives only the exact RLS helpers and canonical user-facing RPCs
--     whose bodies bind authorization to auth.uid()/company membership.
--   * Legacy/local/spoofable actor-id RPCs remain server-only.
--   * Migration helper search_path values are pinned.
--
-- Rollback (only if explicitly required): restore the prior broad execution model by
-- granting EXECUTE on the affected SECURITY DEFINER functions back to anon/authenticated/PUBLIC
-- and reset the four _ce_* function search_path settings. Do not run rollback casually;
-- the prior state intentionally allowed direct execution of privileged SECURITY DEFINER RPCs.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as fn
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.fn);
    execute format('grant execute on function %s to service_role', r.fn);
  end loop;
end $$;

grant execute on function public.is_company_member(uuid, uuid) to authenticated;
grant execute on function public.has_company_role(uuid, uuid, public.app_role) to authenticated;
grant execute on function public.has_role(uuid, public.app_role) to authenticated;
grant execute on function public.is_staff(uuid) to authenticated;
grant execute on function public.ce_company_read(uuid) to authenticated;
grant execute on function public.ce_company_elevated(uuid) to authenticated;
grant execute on function public.review_evaluation(uuid, uuid, text, text) to authenticated;
grant execute on function public.rpc_update_agent_profile(uuid, text, text) to authenticated;
grant execute on function public.rpc_update_channel_config(uuid, boolean, text[]) to authenticated;
grant execute on function public.rpc_update_feedback_config(uuid, boolean, integer, jsonb) to authenticated;
grant execute on function public.rpc_update_widget_config(uuid, text, text, text, text, text, text, boolean) to authenticated;

alter function public._ce_exists(text, text) set search_path = pg_catalog, public;
alter function public._ce_facl(text) set search_path = pg_catalog, public;
alter function public._ce_ledger(text, text, text, text, text, text, boolean) set search_path = pg_catalog, public;
alter function public._ce_rls(text) set search_path = pg_catalog, public;
