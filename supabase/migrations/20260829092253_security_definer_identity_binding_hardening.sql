-- Task 2 follow-up: bind authenticated helper lookups to the caller identity.
-- This migration was immediately followed by 20260829092355, which tightens the
-- direct-postgres exception so authenticated simulations cannot inherit it.

create or replace function public.is_company_member(p_company_id uuid, p_user_id uuid)
returns boolean
language sql
stable security definer
set search_path to ''
as $function$
  select (
    session_user in ('postgres','service_role')
    or auth.role() = 'service_role'
    or p_user_id = auth.uid()
  ) and exists (
    select 1 from public.company_membership cm
    where cm.company_id = p_company_id and cm.user_id = p_user_id and cm.is_active
  );
$function$;

create or replace function public.has_company_role(p_company_id uuid, p_user_id uuid, p_role public.app_role)
returns boolean
language sql
stable security definer
set search_path to ''
as $function$
  select (
    session_user in ('postgres','service_role')
    or auth.role() = 'service_role'
    or p_user_id = auth.uid()
  ) and exists (
    select 1 from public.company_membership cm
    where cm.company_id = p_company_id and cm.user_id = p_user_id and cm.role = p_role and cm.is_active
  );
$function$;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select (
    session_user in ('postgres','service_role')
    or auth.role() = 'service_role'
    or _user_id = auth.uid()
  ) and exists (
    select 1 from public.user_roles where user_id = _user_id and role = _role
  );
$function$;

create or replace function public.is_staff(_user_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select (
    session_user in ('postgres','service_role')
    or auth.role() = 'service_role'
    or _user_id = auth.uid()
  ) and exists (
    select 1 from public.user_roles where user_id = _user_id and role in ('admin','supervisor','agent','qa')
  );
$function$;

revoke execute on function public.is_company_member(uuid,uuid) from public, anon;
revoke execute on function public.has_company_role(uuid,uuid,public.app_role) from public, anon;
revoke execute on function public.has_role(uuid,public.app_role) from public, anon;
revoke execute on function public.is_staff(uuid) from public, anon;
grant execute on function public.is_company_member(uuid,uuid) to authenticated, service_role;
grant execute on function public.has_company_role(uuid,uuid,public.app_role) to authenticated, service_role;
grant execute on function public.has_role(uuid,public.app_role) to authenticated, service_role;
grant execute on function public.is_staff(uuid) to authenticated, service_role;
