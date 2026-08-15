#!/bin/bash
set -Eeuo pipefail
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
MAP_JSON="${KB_SINGAPORE_TENANT_MAP_JSON:-}"
A_COMPANY="${PR10_TENANT_A_COMPANY_UUID:-}"
B_COMPANY="${PR10_TENANT_B_COMPANY_UUID:-}"
stop(){ echo "STOP: $1"; exit 2; }
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$MAP_JSON" ] || stop "KB_SINGAPORE_TENANT_MAP_JSON missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"
PR7_CANONICAL_COMPANY_UUID="$COMPANY_UUID" KB_SINGAPORE_TENANT_MAP_JSON="$MAP_JSON" PR10_TENANT_A_COMPANY_UUID="$A_COMPANY" PR10_TENANT_B_COMPANY_UUID="$B_COMPANY" python3 - <<'PY'
import json,os,uuid
def stop(m): raise SystemExit("STOP: "+m)
try: canonical=str(uuid.UUID(os.environ["PR7_CANONICAL_COMPANY_UUID"].strip()))
except: stop("canonical company UUID invalid")
try: data=json.loads(os.environ["KB_SINGAPORE_TENANT_MAP_JSON"])
except Exception as e: stop(f"KB_SINGAPORE_TENANT_MAP_JSON invalid JSON: {e}")
if not isinstance(data,dict) or not data: stop("tenant mapping must be non-empty object")
normalized={}; reverse={}
for k,v in data.items():
    try: nk=str(uuid.UUID(str(k).strip()))
    except: stop("tenant mapping key must be UUID")
    if str(k).strip().lower()!=nk: stop("tenant mapping UUID key must use canonical lowercase form")
    if not isinstance(v,str) or not v.strip(): stop("Singapore tenant id must be non-empty string")
    tenant=v.strip()
    if tenant.lower()==nk.lower(): stop("Singapore tenant id must not equal AI company UUID")
    if tenant in reverse and reverse[tenant]!=nk: stop("Singapore tenant id collision across AI companies")
    normalized[nk]=tenant; reverse[tenant]=nk
if canonical not in normalized: stop("canonical company UUID has no Singapore tenant mapping")
a=os.environ.get("PR10_TENANT_A_COMPANY_UUID","").strip()
b=os.environ.get("PR10_TENANT_B_COMPANY_UUID","").strip()
if bool(a)!=bool(b): stop("two-tenant mapping fixtures must be supplied together")
if a and b:
    try: a=str(uuid.UUID(a)); b=str(uuid.UUID(b))
    except: stop("two-tenant company mapping fixture UUID invalid")
    if a==b or a not in normalized or b not in normalized or normalized[a]==normalized[b]:
        stop("two-tenant Singapore mappings missing or not distinct")
print("PASS Singapore KB tenant mapping JSON")
print("PASS canonical AI company mapping present")
print("PASS Singapore tenant values collision-free")
if a and b: print("PASS two-tenant Singapore mappings present and distinct")
PY
