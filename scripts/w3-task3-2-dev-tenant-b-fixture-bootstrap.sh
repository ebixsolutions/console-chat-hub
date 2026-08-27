#!/bin/bash
set -Eeuo pipefail
DB="${SUPABASE_DB_URL:-}"
AUTH="${W3_DEV_FIXTURE_WRITE_AUTHORIZED:-}"
REPO="${W3_T3_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
stop(){ echo "STOP: $1" >&2; exit 2; }
[ "$AUTH" = YES ] || stop "explicit DEV fixture write authorization missing"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
source "$REPO/config/w3-task3-3-dev-identity.env"
psql "$DB" -v ON_ERROR_STOP=1 -v bc="$PR10_TENANT_B_COMPANY_UUID" -v bpid="$PR10_TENANT_B_PLATFORM_COMPANY_ID" -v bu="$PR10_TENANT_B_USER_UUID" -v ba="$PR10_TENANT_B_AGENT_PROFILE_UUID" -v bv="$PR10_TENANT_B_VISITOR_SESSION_UUID" -v bx="$PR10_TENANT_B_CONVERSATION_UUID" -v email="q854we@gmail.com" <<'SQL'
BEGIN;
SET LOCAL lock_timeout='10s';
DO $pre$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='company' AND column_name='platform_company_id' AND udt_name='int8') THEN RAISE EXCEPTION 'Tenant B fixture refused: Task 2.1 platform_company_id not active'; END IF;
 IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id=:'bu'::uuid AND email=:'email') THEN RAISE EXCEPTION 'Tenant B fixture refused: selected authenticated user missing/mismatch'; END IF;
 IF EXISTS (SELECT 1 FROM public.company WHERE id=:'bc'::uuid AND platform_company_id<>:'bpid'::bigint) OR EXISTS (SELECT 1 FROM public.company WHERE platform_company_id=:'bpid'::bigint AND id<>:'bc'::uuid) THEN RAISE EXCEPTION 'Tenant B fixture refused: company identity collision'; END IF;
END $pre$;
INSERT INTO public.company(id,platform_company_id,slug,display_name,external_workspace_id,external_tenant_id,is_active) VALUES(:'bc'::uuid,:'bpid'::bigint,'lovable-dev-tenant-2','Lovable DEV Tenant 2','lovable-dev-workspace-2','lovable-dev-tenant-2',true) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles(user_id,role) SELECT :'bu'::uuid,'admin'::public.app_role WHERE NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=:'bu'::uuid);
INSERT INTO public.agent_profile(id,user_id,display_name,email,role,status) SELECT :'ba'::uuid,:'bu'::uuid,'DEV Tenant 2 Security Fixture',:'email','admin','active' WHERE NOT EXISTS (SELECT 1 FROM public.agent_profile WHERE id=:'ba'::uuid OR user_id=:'bu'::uuid);
INSERT INTO public.company_membership(company_id,user_id,role,is_active) SELECT :'bc'::uuid,:'bu'::uuid,'admin'::public.app_role,true WHERE NOT EXISTS (SELECT 1 FROM public.company_membership WHERE company_id=:'bc'::uuid AND user_id=:'bu'::uuid);
INSERT INTO public.visitor_session(id,visitor_metadata) VALUES(:'bv'::uuid,'{"fixture":"w3-task3-2-tenant-b"}'::jsonb) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.conversations(id,visitor_session_id,company_id,status,metadata_source) VALUES(:'bx'::uuid,:'bv'::uuid,:'bc'::uuid,'open','{"fixture":"w3-task3-2-tenant-b"}'::jsonb) ON CONFLICT (id) DO NOTHING;
COMMIT;
SQL
echo "PASS W3 DEV Tenant B fixture bootstrap"
