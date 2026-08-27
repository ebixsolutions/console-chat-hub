#!/bin/bash
set -Eeuo pipefail
DB="${SUPABASE_DB_URL:-}"; REPO="${W3_T3_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
[ "${W3_DEV_FIXTURE_WRITE_AUTHORIZED:-}" = YES ] || { echo "STOP: explicit DEV fixture write authorization missing" >&2; exit 2; }
source "$REPO/config/w3-task3-3-dev-identity.env"
psql "$DB" -v ON_ERROR_STOP=1 -v bc="$PR10_TENANT_B_COMPANY_UUID" -v bu="$PR10_TENANT_B_USER_UUID" -v ba="$PR10_TENANT_B_AGENT_PROFILE_UUID" -v bv="$PR10_TENANT_B_VISITOR_SESSION_UUID" -v bx="$PR10_TENANT_B_CONVERSATION_UUID" <<'SQL'
BEGIN;
DELETE FROM public.conversations WHERE id=:'bx'::uuid AND company_id=:'bc'::uuid;
DELETE FROM public.visitor_session WHERE id=:'bv'::uuid;
DELETE FROM public.company_membership WHERE company_id=:'bc'::uuid AND user_id=:'bu'::uuid;
DELETE FROM public.agent_profile WHERE id=:'ba'::uuid AND user_id=:'bu'::uuid;
DELETE FROM public.user_roles WHERE user_id=:'bu'::uuid AND role='admin'::public.app_role;
DELETE FROM public.company WHERE id=:'bc'::uuid AND platform_company_id=5;
COMMIT;
SQL
echo "PASS W3 DEV Tenant B fixture rollback"
