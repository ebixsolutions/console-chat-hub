#!/bin/bash
set -Eeuo pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${W2_T2_1_PRODUCTION_AUTHORIZED:-}"
RUN_ID="${W2_T2_1_RUN_ID:-}"
COMPANY_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID:-}"
PLATFORM_COMPANY_ID="${W2_T2_1_CANONICAL_PLATFORM_COMPANY_ID:-}"
COMPANY_SLUG="${W2_T2_1_CANONICAL_COMPANY_SLUG:-}"
COMPANY_NAME="${W2_T2_1_CANONICAL_COMPANY_NAME:-}"
EXT_WORKSPACE="${W2_T2_1_EXTERNAL_WORKSPACE_ID:-}"
EXT_TENANT="${W2_T2_1_EXTERNAL_TENANT_ID:-}"
KB_MAP_JSON="${KB_SINGAPORE_TENANT_MAP_JSON:-}"

stop(){ echo "STOP: $1" >&2; exit 2; }
[ "$AUTH" = "YES" ] || stop "explicit production authorization missing"
[ -n "$RUN_ID" ] || stop "W2_T2_1_RUN_ID missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$COMPANY_UUID" ] || stop "canonical company UUID missing"
[ -n "$PLATFORM_COMPANY_ID" ] || stop "canonical platform company id missing"
[ -n "$COMPANY_SLUG" ] || stop "canonical company slug missing"
[ -n "$COMPANY_NAME" ] || stop "canonical company name missing"
[ -n "$EXT_WORKSPACE" ] || stop "external workspace id missing"
[ -n "$EXT_TENANT" ] || stop "external tenant id missing"
[[ "$PLATFORM_COMPANY_ID" =~ ^[1-9][0-9]*$ ]] || stop "canonical platform company id must be positive integer"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

# When Singapore mapping is supplied, it must resolve this canonical UUID to the
# exact same integer company id. No shadow tenant identity may be introduced.
if [ -n "$KB_MAP_JSON" ]; then
  KB_SINGAPORE_TENANT_MAP_JSON="$KB_MAP_JSON" \
  W2_T2_1_CANONICAL_COMPANY_UUID="$COMPANY_UUID" \
  W2_T2_1_CANONICAL_PLATFORM_COMPANY_ID="$PLATFORM_COMPANY_ID" \
  python3 - <<'PY'
import json,os,uuid
u=str(uuid.UUID(os.environ['W2_T2_1_CANONICAL_COMPANY_UUID']))
pid=str(int(os.environ['W2_T2_1_CANONICAL_PLATFORM_COMPANY_ID']))
try: m=json.loads(os.environ['KB_SINGAPORE_TENANT_MAP_JSON'])
except Exception: raise SystemExit('STOP: KB_SINGAPORE_TENANT_MAP_JSON invalid')
if not isinstance(m,dict): raise SystemExit('STOP: KB_SINGAPORE_TENANT_MAP_JSON must be object')
v=m.get(u)
if v is None: raise SystemExit('STOP: canonical company missing Singapore mapping')
if str(v).strip()!=pid: raise SystemExit('STOP: Singapore mapping does not match canonical platform company id')
print('PASS Singapore mapping matches canonical platform company id')
PY
fi

# Schema foundation first; transactional and idempotent for an empty/current foundation.
psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$(cd "$(dirname "$0")/.." && pwd)/sql/pr7/pr7_company_dual_identity.sql"

EXISTING="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq \
  -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" -v platform_company_id="$PLATFORM_COMPANY_ID" <<'SQL'
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_company_identity_bootstrap_run
    WHERE run_id=:'run_id'::uuid AND company_uuid=:'company_uuid'::uuid
      AND platform_company_id=:'platform_company_id'::bigint
      AND completed_at IS NOT NULL AND rolled_back_at IS NULL
  ) THEN 'exact'
  WHEN EXISTS (SELECT 1 FROM public.pr7_company_identity_bootstrap_run WHERE run_id=:'run_id'::uuid)
    THEN 'conflict'
  ELSE 'missing'
END;
SQL
)"
if [ "$EXISTING" = "exact" ]; then
  echo "PASS canonical SU Platform company identity already activated (idempotent no-op)"
  exit 0
fi
[ "$EXISTING" != "conflict" ] || stop "run_id conflict or rolled-back run reuse"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" \
  -v platform_company_id="$PLATFORM_COMPANY_ID" \
  -v company_slug="$COMPANY_SLUG" -v company_name="$COMPANY_NAME" \
  -v ext_workspace="$EXT_WORKSPACE" -v ext_tenant="$EXT_TENANT" <<'SQL'
BEGIN;
SET LOCAL lock_timeout='10s';

DO $activate$
DECLARE
  rid uuid := :'run_id'::uuid;
  cuid uuid := :'company_uuid'::uuid;
  pid bigint := :'platform_company_id'::bigint;
  n int;
  exact boolean;
BEGIN
  IF pid <= 0 THEN RAISE EXCEPTION 'platform company id must be > 0'; END IF;
  IF EXISTS (SELECT 1 FROM public.pr7_company_identity_bootstrap_run WHERE run_id=rid) THEN
    RAISE EXCEPTION 'run id already exists';
  END IF;

  SELECT count(*) INTO n FROM public.company;
  SELECT EXISTS (
    SELECT 1 FROM public.company
    WHERE id=cuid AND platform_company_id=pid AND slug=:'company_slug'
      AND display_name=:'company_name' AND external_workspace_id=:'ext_workspace'
      AND external_tenant_id=:'ext_tenant' AND is_active=true
  ) INTO exact;

  IF n=0 THEN
    INSERT INTO public.company(
      id,platform_company_id,slug,display_name,external_workspace_id,external_tenant_id,is_active
    ) VALUES(cuid,pid,:'company_slug',:'company_name',:'ext_workspace',:'ext_tenant',true);
    INSERT INTO public.pr7_company_identity_bootstrap_run(
      run_id,company_uuid,platform_company_id,created_company,completed_at
    ) VALUES(rid,cuid,pid,true,now());
    RETURN;
  END IF;

  IF n<>1 OR NOT exact THEN
    RAISE EXCEPTION 'canonical activation refused: existing company identity differs';
  END IF;

  IF EXISTS (SELECT 1 FROM public.company WHERE id=cuid AND platform_company_id<>pid)
     OR EXISTS (SELECT 1 FROM public.company WHERE platform_company_id=pid AND id<>cuid) THEN
    RAISE EXCEPTION 'canonical UUID/integer identity collision';
  END IF;

  INSERT INTO public.pr7_company_identity_bootstrap_run(
    run_id,company_uuid,platform_company_id,created_company,completed_at
  ) VALUES(rid,cuid,pid,false,now());
END
$activate$;

COMMIT;
SQL

echo "PASS canonical SU Platform company UUID + integer identity activation complete"
