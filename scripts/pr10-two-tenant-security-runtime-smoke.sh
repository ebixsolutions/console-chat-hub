#!/bin/bash
set -Eeuo pipefail
stop(){ echo "STOP: $1" >&2; exit 2; }
pass(){ echo "PASS $1"; }

DB="${SUPABASE_DB_URL:-}"
AC="${PR10_TENANT_A_COMPANY_UUID:-}"; BC="${PR10_TENANT_B_COMPANY_UUID:-}"
AU="${PR10_TENANT_A_USER_UUID:-}"; BU="${PR10_TENANT_B_USER_UUID:-}"
AQ="${PR10_KB_TENANT_A_QUERY:-}"; BQ="${PR10_KB_TENANT_B_QUERY:-}"
AD="${PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID:-}"; BD="${PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID:-}"
MAP="${KB_SINGAPORE_TENANT_MAP_JSON:-}"
KEYS="${KB_SINGAPORE_TENANT_API_KEYS_JSON:-}"
BASE="${KB_SINGAPORE_BASE_URL:-${KB_RAG_BASE_URL:-https://py.ebixmall.com/py-knowledge-base}}"

[ "${PR10_TWO_TENANT_FIXTURES_APPROVED:-}" = YES ] || stop "fixture approval missing"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
for x in "$AC" "$BC" "$AU" "$BU"; do [[ "$x" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "UUID fixture invalid"; done
[ "$AC" != "$BC" ] && [ "$AU" != "$BU" ] || stop "tenant fixtures must differ"
[ -n "$AQ" ] && [ -n "$BQ" ] && [ -n "$AD" ] && [ -n "$BD" ] || stop "KB positive-control fixtures missing"
[ "$AD" != "$BD" ] || stop "known tenant documents must differ"
[ -n "$MAP" ] && [ -n "$KEYS" ] || stop "Singapore KB mapping/API-key config missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

FIX="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v ac="$AC" -v bc="$BC" -v au="$AU" -v bu="$BU" <<'SQL'
SELECT
 EXISTS(SELECT 1 FROM public.company WHERE id=:'ac'::uuid AND is_active),
 EXISTS(SELECT 1 FROM public.company WHERE id=:'bc'::uuid AND is_active),
 EXISTS(SELECT 1 FROM public.company_membership WHERE company_id=:'ac'::uuid AND user_id=:'au'::uuid AND is_active),
 EXISTS(SELECT 1 FROM public.company_membership WHERE company_id=:'bc'::uuid AND user_id=:'bu'::uuid AND is_active),
 EXISTS(SELECT 1 FROM public.conversations WHERE company_id=:'ac'::uuid),
 EXISTS(SELECT 1 FROM public.conversations WHERE company_id=:'bc'::uuid);
SQL
)"
[ "$FIX" = "t|t|t|t|t|t" ] || stop "real two-tenant fixtures incomplete"
pass "real two-tenant fixtures"

MATRIX="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v ac="$AC" -v bc="$BC" -v au="$AU" -v bu="$BU" <<'SQL'
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub',:'au',true);
SELECT set_config('request.jwt.claims',json_build_object('sub',:'au','role','authenticated')::text,true);
CREATE TEMP TABLE xa AS SELECT
 (SELECT count(*) FROM public.conversations WHERE company_id=:'ac'::uuid) own,
 (SELECT count(*) FROM public.conversations WHERE company_id=:'bc'::uuid) foreign_conv,
 (SELECT count(*) FROM public.conversation_evaluation WHERE company_id=:'bc'::uuid) foreign_eval;
SELECT set_config('request.jwt.claim.sub',:'bu',true);
SELECT set_config('request.jwt.claims',json_build_object('sub',:'bu','role','authenticated')::text,true);
CREATE TEMP TABLE xb AS SELECT
 (SELECT count(*) FROM public.conversations WHERE company_id=:'bc'::uuid) own,
 (SELECT count(*) FROM public.conversations WHERE company_id=:'ac'::uuid) foreign_conv,
 (SELECT count(*) FROM public.conversation_evaluation WHERE company_id=:'ac'::uuid) foreign_eval;
SELECT xa.own,xa.foreign_conv,xa.foreign_eval,xb.own,xb.foreign_conv,xb.foreign_eval FROM xa,xb;
ROLLBACK;
SQL
)"
ROW="$(printf '%s\n' "$MATRIX" | awk -F'|' 'NF==6{x=$0} END{print x}')"
IFS='|' read -r AO AF AE BO BF BE <<<"$ROW"
[ "${AO:-0}" -gt 0 ] && [ "$AF" = 0 ] && [ "$AE" = 0 ] || stop "Tenant A RLS isolation failed"
[ "${BO:-0}" -gt 0 ] && [ "$BF" = 0 ] && [ "$BE" = 0 ] || stop "Tenant B RLS isolation failed"
pass "authenticated DB RLS bidirectional isolation"

KB_SINGAPORE_TENANT_MAP_JSON="$MAP" \
KB_SINGAPORE_TENANT_API_KEYS_JSON="$KEYS" \
PR10_TENANT_A_COMPANY_UUID="$AC" PR10_TENANT_B_COMPANY_UUID="$BC" \
PR10_KB_TENANT_A_QUERY="$AQ" PR10_KB_TENANT_B_QUERY="$BQ" \
PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID="$AD" PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID="$BD" \
KB_SINGAPORE_BASE_URL="$BASE" python3 - <<'PY'
import os,json,uuid,ssl,urllib.request,urllib.error

def stop(s): raise SystemExit("STOP: "+s)
try:
    mapping=json.loads(os.environ["KB_SINGAPORE_TENANT_MAP_JSON"])
    keys=json.loads(os.environ["KB_SINGAPORE_TENANT_API_KEYS_JSON"])
except Exception:
    stop("Singapore mapping/API-key JSON invalid")
if not isinstance(mapping,dict) or not isinstance(keys,dict):
    stop("Singapore mapping/API-key JSON must be objects")

companies=[
    str(uuid.UUID(os.environ["PR10_TENANT_A_COMPANY_UUID"])),
    str(uuid.UUID(os.environ["PR10_TENANT_B_COMPANY_UUID"])),
]
mapped=[mapping.get(companies[0]),mapping.get(companies[1])]
mapped=[str(x).strip() if x is not None else "" for x in mapped]
if not all(x.isdigit() and int(x)>0 for x in mapped):
    stop("Singapore mapped company_id must be positive integers")
if mapped[0]==mapped[1]:
    stop("distinct Singapore company mappings required")

api_keys=[keys.get(mapped[0]),keys.get(mapped[1])]
if not all(isinstance(k,str) and len(k.strip())>=16 for k in api_keys):
    stop("tenant-bound Singapore API key missing")
api_keys=[k.strip() for k in api_keys]

qs=[os.environ["PR10_KB_TENANT_A_QUERY"],os.environ["PR10_KB_TENANT_B_QUERY"]]
expected=[os.environ["PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID"],os.environ["PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID"]]
base=os.environ["KB_SINGAPORE_BASE_URL"].rstrip("/")
ctx=ssl.create_default_context()

def search(key,company_id,q):
    body=json.dumps({
        "query":q,
        "company_id":int(company_id),
        "candidate_top_k":12,
        "max_documents":1,
        "max_summary_chunks":1,
        "max_full_content_chunks":3,
        "score_threshold":0.05,
    }).encode()
    req=urllib.request.Request(
        base+"/api/v1/rag/context-search",
        data=body,method="POST",
        headers={
            "x-api-key":key,
            "Content-Type":"application/json",
            "User-Agent":"W3-T3.2-TwoTenant/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req,timeout=20,context=ctx) as r:
            data=json.loads(r.read())
    except urllib.error.HTTPError as e:
        stop(f"Singapore KB HTTP {e.code}")
    except Exception as e:
        stop(f"Singapore KB unreachable: {type(e).__name__}")
    if not isinstance(data,dict) or data.get("success") is not True:
        stop("Singapore KB response invalid")
    if not isinstance(data.get("context_found"),bool):
        stop("Singapore KB context_found invalid")
    docs=data.get("selected_documents")
    if not isinstance(docs,list) or len(docs)>1:
        stop("Singapore KB selected_documents invalid")
    ids=set()
    for d in docs:
        if isinstance(d,dict) and isinstance(d.get("document_id"),str):
            ids.add(d["document_id"])
    return ids

a_own=search(api_keys[0],mapped[0],qs[0])
b_own=search(api_keys[1],mapped[1],qs[1])
if expected[0] not in a_own: stop("Tenant A positive control failed")
if expected[1] not in b_own: stop("Tenant B positive control failed")
if expected[1] in search(api_keys[0],mapped[0],qs[1]): stop("Tenant A leaked Tenant B document")
if expected[0] in search(api_keys[1],mapped[1],qs[0]): stop("Tenant B leaked Tenant A document")
print("PASS Singapore KB Tenant A positive control")
print("PASS Singapore KB Tenant B positive control")
print("PASS Singapore KB A->B denial")
print("PASS Singapore KB B->A denial")
PY

pass "Singapore KB x-api-key/company_id bidirectional isolation"
echo "W3 TASK 3.2 TWO-TENANT SECURITY RUNTIME STATUS: PASS"
