-- PR-7 Agent Management tenant isolation rollback.
-- SOURCE ONLY.
-- Restores production caller compatibility by dropping only the new additive
-- tenant-safe RPCs. Existing legacy safe_* functions are untouched.

BEGIN;

DROP FUNCTION IF EXISTS public.tenant_safe_reactivate_agent(
  uuid,uuid,uuid,public.app_role
);
DROP FUNCTION IF EXISTS public.tenant_safe_deactivate_agent(
  uuid,uuid,uuid
);
DROP FUNCTION IF EXISTS public.tenant_safe_change_role(
  uuid,uuid,uuid,public.app_role
);
DROP FUNCTION IF EXISTS public.tenant_safe_add_agent(
  uuid,uuid,uuid,public.app_role,text
);
DROP FUNCTION IF EXISTS public.tenant_find_auth_user_by_email(
  uuid,uuid,text
);

COMMIT;
