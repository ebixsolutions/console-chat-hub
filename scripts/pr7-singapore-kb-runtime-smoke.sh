#!/bin/bash
set -Eeuo pipefail

MAP_JSON="${KB_SINGAPORE_TENANT_MAP_JSON:-}"
KEYS_JSON="${KB_SINGAPORE_TENANT_API_KEYS_JSON:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
BASE_URL="${KB_SINGAPORE_BASE_URL:-${KB_RAG_BASE_URL:-https://py.ebixmall.com/py-knowledge-base}}"
QUERY="${PR7_KB_SMOKE_QUERY:-customer service policy}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }

[ -n "$MAP_JSON" ] || stop "KB_SINGAPORE_TENANT_MAP_JSON missing"
[ -n "$KEYS_JSON" ] || stop "KB_SINGAPORE_TENANT_API_KEYS_JSON missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$QUERY" ] || stop "PR7_KB_SMOKE_QUERY empty"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

KB_SINGAPORE_TENANT_MAP_JSON="$MAP_JSON" \
KB_SINGAPORE_TENANT_API_KEYS_JSON="$KEYS_JSON" \
PR7_CANONICAL_COMPANY_UUID="$COMPANY_UUID" \
KB_SINGAPORE_BASE_URL="$BASE_URL" \
PR7_KB_SMOKE_QUERY="$QUERY" \
python3 - <<'PY'
import json, os, ssl, urllib.error, urllib.parse, urllib.request, uuid

def stop(s): raise SystemExit("STOP: "+s)
def fail(s): raise SystemExit("FAIL: "+s)

company=str(uuid.UUID(os.environ["PR7_CANONICAL_COMPANY_UUID"].strip()))
try:
    mapping=json.loads(os.environ["KB_SINGAPORE_TENANT_MAP_JSON"])
    keys=json.loads(os.environ["KB_SINGAPORE_TENANT_API_KEYS_JSON"])
except Exception:
    stop("Singapore mapping/key JSON invalid")
if not isinstance(mapping,dict) or not isinstance(keys,dict):
    stop("Singapore mapping/key JSON must be object")

tenant=mapping.get(company)
if not isinstance(tenant,str) or not tenant.strip():
    stop("canonical company has no Singapore mapping")
tenant=tenant.strip()
if not tenant.isdigit() or int(tenant) <= 0:
    stop("Singapore mapped company_id must be positive integer")
api_key=keys.get(tenant)
if not isinstance(api_key,str) or len(api_key.strip()) < 16:
    stop("tenant-bound Singapore API key missing/invalid")
api_key=api_key.strip()

base=os.environ["KB_SINGAPORE_BASE_URL"].rstrip("/")
parsed=urllib.parse.urlparse(base)
if parsed.scheme!="https" and parsed.hostname not in ("localhost","127.0.0.1"):
    stop("Singapore KB base URL must use https")
query=os.environ["PR7_KB_SMOKE_QUERY"].strip()[:500]

body=json.dumps({
    "query":query,
    "company_id":int(tenant),
    "candidate_top_k":10,
    "max_documents":1,
    "max_summary_chunks":1,
    "max_full_content_chunks":3,
    "score_threshold":0.05,
}).encode()

req=urllib.request.Request(
    f"{base}/api/v1/rag/context-search",
    data=body,
    method="POST",
    headers={
        "x-api-key":api_key,
        "Content-Type":"application/json",
        "User-Agent":"W1-T1.3-KB-Schema-Smoke/1.0",
    },
)
try:
    with urllib.request.urlopen(req, timeout=20, context=ssl.create_default_context()) as resp:
        status=resp.status
        raw=resp.read()
except urllib.error.HTTPError as e:
    fail(f"Singapore KB HTTP {e.code}")
except Exception as e:
    fail(f"Singapore KB unreachable: {type(e).__name__}")

if status != 200: fail(f"Singapore KB HTTP {status}")
try: data=json.loads(raw)
except Exception: fail("Singapore KB invalid JSON")
if not isinstance(data,dict): fail("response must be object")
if data.get("success") is not True: fail("success!=true")
if not isinstance(data.get("context_found"),bool): fail("context_found invalid")
if not isinstance(data.get("selected_documents"),list): fail("selected_documents invalid")
if not isinstance(data.get("citations"),list): fail("citations invalid")
if not isinstance(data.get("meta"),dict): fail("meta invalid")
if len(data["selected_documents"]) > 1: fail("max_documents=1 violated")

if data["context_found"]:
    if len(data["selected_documents"]) != 1:
        fail("context_found=true requires exactly one selected document")
    doc=data["selected_documents"][0]
    if not isinstance(doc,dict) or not isinstance(doc.get("evidence"),list):
        fail("selected document evidence invalid")
    full=sum(1 for e in doc["evidence"] if isinstance(e,dict) and e.get("chunk_type")=="full_content")
    summary=sum(1 for e in doc["evidence"] if isinstance(e,dict) and e.get("chunk_type")=="rag_summary")
    if full>3: fail("max_full_content_chunks=3 violated")
    if summary>1: fail("max_summary_chunks=1 violated")

print("PASS Singapore KB current x-api-key request contract")
print("PASS Singapore KB current response schema")
print("PASS Singapore KB one-document aggregation bound")
# Never print secret/company/tenant/content/citations.
PY
