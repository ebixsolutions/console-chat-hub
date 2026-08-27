#!/bin/bash
set -Eeuo pipefail
stop(){ echo "STOP: $1"; exit 2; }
pass(){ echo "PASS $1"; }

DB="${SUPABASE_DB_URL:-}"
AC="${PR10_TENANT_A_COMPANY_UUID:-}"; BC="${PR10_TENANT_B_COMPANY_UUID:-}"
AU="${PR10_TENANT_A_USER_UUID:-}"; BU="${PR10_TENANT_B_USER_UUID:-}"
AQ="${PR10_KB_TENANT_A_QUERY:-}"; BQ="${PR10_KB_TENANT_B_QUERY:-}"
AD="${PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID:-}"; BD="${PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID:-}"
MAP="${KB_SINGAPORE_TENANT_MAP_JSON:-}"; SECRET="${KB_SINGAPORE_JWT_SECRET:-}"
BASE="${KB_RAG_BASE_URL:-https://py.ebixmall.com/py-knowledge-base}"
TTL="${KB_SINGAPORE_JWT_TTL_SEC:-300}"

[ "${PR10_TWO_TENANT_FIXTURES_APPROVED:-}" = YES ] || stop "fixture approval missing"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
for x in "$AC" "$BC" "$AU" "$BU"; do [[ "$x" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "UUID fixture invalid"; done
[ "$AC" != "$BC" ] && [ "$AU" != "$BU" ] || stop "tenant fixtures must differ"
[ -n "$AQ" ] && [ -n "$BQ" ] && [ -n "$AD" ] && [ -n "$BD" ] || stop "KB positive-control fixtures missing"
[ "$AD" != "$BD" ] || stop "known tenant documents must differ"
[ -n "$MAP" ] && [ ${#SECRET} -ge 32 ] || stop "Singapore KB auth config missing"
command -v psql >/dev/null || stop "psql missing"
command -v python3 >/dev/null || stop "python3 missing"

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

KB_SINGAPORE_TENANT_MAP_JSON="$MAP" KB_SINGAPORE_JWT_SECRET="$SECRET" \
PR10_TENANT_A_COMPANY_UUID="$AC" PR10_TENANT_B_COMPANY_UUID="$BC" \
PR10_KB_TENANT_A_QUERY="$AQ" PR10_KB_TENANT_B_QUERY="$BQ" \
PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID="$AD" PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID="$BD" \
KB_RAG_BASE_URL="$BASE" KB_SINGAPORE_JWT_TTL_SEC="$TTL" python3 - <<'PY'
import os,json,uuid,time,base64,hmac,hashlib,ssl,urllib.request,urllib.error
def stop(s): raise SystemExit("STOP: "+s)
m=json.loads(os.environ["KB_SINGAPORE_TENANT_MAP_JSON"]); sec=os.environ["KB_SINGAPORE_JWT_SECRET"].encode()
cs=[str(uuid.UUID(os.environ["PR10_TENANT_A_COMPANY_UUID"])),str(uuid.UUID(os.environ["PR10_TENANT_B_COMPANY_UUID"]))]
ts=[m.get(cs[0]),m.get(cs[1])]
if not all(isinstance(x,str) and x.strip() for x in ts) or ts[0].strip()==ts[1].strip(): stop("distinct Singapore mappings required")
ts=[x.strip() for x in ts]
qs=[os.environ["PR10_KB_TENANT_A_QUERY"],os.environ["PR10_KB_TENANT_B_QUERY"]]
ds=[os.environ["PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID"],os.environ["PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID"]]
base=os.environ["KB_RAG_BASE_URL"].rstrip("/"); ttl=int(os.environ["KB_SINGAPORE_JWT_TTL_SEC"])
if ttl<60 or ttl>900: stop("JWT TTL outside 60..900")
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def tok(c,t):
 n=int(time.time()); h=b64(b'{"alg":"HS256","typ":"JWT"}')
 p=b64(json.dumps({"sub":f"ai-chatbot:{c}","tenant_id":t,"role":"service","iat":n,"exp":n+ttl},separators=(",",":")).encode())
 return f"{h}.{p}.{b64(hmac.new(sec,f'{h}.{p}'.encode(),hashlib.sha256).digest())}"
ctx=ssl.create_default_context()
def search(token,q):
 body=json.dumps({"query":q,"top_k":12,"score_threshold":0.05,"max_documents":1,"max_summary":1,"max_full_chunks":3}).encode()
 req=urllib.request.Request(base+"/api/v1/rag/context-search",data=body,method="POST",
   headers={"Authorization":"Bearer "+token,"Content-Type":"application/json"})
 try:
  with urllib.request.urlopen(req,timeout=20,context=ctx) as r: d=json.loads(r.read())
 except urllib.error.HTTPError as e: stop(f"Singapore KB HTTP {e.code}")
 ids=set()
 for k in ("documents","citations"):
  for x in d.get(k,[]):
   if isinstance(x,dict) and isinstance(x.get("document_id"),str): ids.add(x["document_id"])
 return ids
ta,tb=tok(cs[0],ts[0]),tok(cs[1],ts[1])
if ds[0] not in search(ta,qs[0]): stop("Tenant A positive control failed")
if ds[1] not in search(tb,qs[1]): stop("Tenant B positive control failed")
if ds[1] in search(ta,qs[1]): stop("Tenant A JWT leaked Tenant B document")
if ds[0] in search(tb,qs[0]): stop("Tenant B JWT leaked Tenant A document")
print("PASS Singapore KB Tenant A positive control")
print("PASS Singapore KB Tenant B positive control")
print("PASS Singapore KB A->B denial")
print("PASS Singapore KB B->A denial")
PY

pass "Singapore KB bidirectional isolation"
echo "TASK 10.1 TWO-TENANT SECURITY RUNTIME STATUS: PASS"
