#!/bin/bash
set -Eeuo pipefail

SECRET="${KB_SINGAPORE_JWT_SECRET:-}"
MAP_JSON="${KB_SINGAPORE_TENANT_MAP_JSON:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
BASE_URL="${KB_RAG_BASE_URL:-https://py.ebixmall.com/py-knowledge-base}"
QUERY="${PR7_KB_SMOKE_QUERY:-customer service policy}"
TTL="${KB_SINGAPORE_JWT_TTL_SEC:-300}"

stop(){ echo "STOP: $1"; exit 2; }
[ -n "$SECRET" ] || stop "KB_SINGAPORE_JWT_SECRET missing"
[ -n "$MAP_JSON" ] || stop "KB_SINGAPORE_TENANT_MAP_JSON missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$QUERY" ] || stop "PR7_KB_SMOKE_QUERY empty"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

KB_SINGAPORE_JWT_SECRET="$SECRET" \
KB_SINGAPORE_TENANT_MAP_JSON="$MAP_JSON" \
PR7_CANONICAL_COMPANY_UUID="$COMPANY_UUID" \
KB_RAG_BASE_URL="$BASE_URL" \
PR7_KB_SMOKE_QUERY="$QUERY" \
KB_SINGAPORE_JWT_TTL_SEC="$TTL" \
python3 - <<'PY'
import base64, hashlib, hmac, json, os, ssl, time, urllib.error, urllib.request, uuid

secret=os.environ["KB_SINGAPORE_JWT_SECRET"].encode()
company=str(uuid.UUID(os.environ["PR7_CANONICAL_COMPANY_UUID"].strip()))
mapping=json.loads(os.environ["KB_SINGAPORE_TENANT_MAP_JSON"])
tenant=mapping.get(company)
if not isinstance(tenant,str) or not tenant.strip():
    raise SystemExit("STOP: canonical company has no Singapore tenant mapping")
tenant=tenant.strip()

ttl=int(os.environ.get("KB_SINGAPORE_JWT_TTL_SEC","300"))
if ttl < 60 or ttl > 900:
    raise SystemExit("STOP: JWT TTL outside 60..900")

base=os.environ.get("KB_RAG_BASE_URL","https://py.ebixmall.com/py-knowledge-base").rstrip("/")
if not base.startswith("https://") and not (
    base.startswith("http://localhost") or base.startswith("http://127.0.0.1")
):
    raise SystemExit("STOP: Singapore KB base URL must use https")

query=os.environ["PR7_KB_SMOKE_QUERY"].strip()[:500]
if not query:
    raise SystemExit("STOP: smoke query empty")

def b64u(b:bytes)->str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

now=int(time.time())
header=b64u(json.dumps({"alg":"HS256","typ":"JWT"},separators=(",",":")).encode())
claims={
    "sub":f"ai-chatbot:{company}",
    "tenant_id":tenant,
    "role":"service",
    "iat":now,
    "exp":now+ttl,
}
payload=b64u(json.dumps(claims,separators=(",",":")).encode())
signing=f"{header}.{payload}".encode()
sig=b64u(hmac.new(secret,signing,hashlib.sha256).digest())
token=f"{header}.{payload}.{sig}"

body=json.dumps({
    "query":query,
    "top_k":12,
    "score_threshold":0.05,
    "max_documents":1,
    "max_summary":1,
    "max_full_chunks":3,
}).encode()

req=urllib.request.Request(
    f"{base}/api/v1/rag/context-search",
    data=body,
    method="POST",
    headers={
        "Authorization":f"Bearer {token}",
        "Content-Type":"application/json",
        "User-Agent":"PR7-KB-Runtime-Smoke/1.0",
    },
)

try:
    with urllib.request.urlopen(req,timeout=20,context=ssl.create_default_context()) as resp:
        status=resp.status
        raw=resp.read()
except urllib.error.HTTPError as e:
    # Do not print response body; it may contain implementation details.
    raise SystemExit(f"FAIL: Singapore KB HTTP {e.code}")
except Exception as e:
    raise SystemExit(f"FAIL: Singapore KB unreachable: {type(e).__name__}")

if status != 200:
    raise SystemExit(f"FAIL: Singapore KB HTTP {status}")

try:
    data=json.loads(raw)
except Exception:
    raise SystemExit("FAIL: Singapore KB returned invalid JSON")

if not isinstance(data,dict):
    raise SystemExit("FAIL: Singapore KB response must be object")
if not isinstance(data.get("has_context"),bool):
    raise SystemExit("FAIL: Singapore KB has_context missing/invalid")
if not isinstance(data.get("reason"),str):
    raise SystemExit("FAIL: Singapore KB reason missing/invalid")
if not isinstance(data.get("citations"),list):
    raise SystemExit("FAIL: Singapore KB citations missing/invalid")
if not isinstance(data.get("documents"),list):
    raise SystemExit("FAIL: Singapore KB documents missing/invalid")

docs=data["documents"]
cites=data["citations"]
if len(docs) > 1:
    raise SystemExit("FAIL: Singapore KB violated max_documents=1")

doc_ids={d.get("document_id") for d in docs if isinstance(d,dict) and isinstance(d.get("document_id"),str)}
cite_doc_ids={
    c.get("document_id")
    for c in cites
    if isinstance(c,dict) and isinstance(c.get("document_id"),str)
}
all_ids={x for x in (doc_ids|cite_doc_ids) if x}
if len(all_ids)>1:
    raise SystemExit("FAIL: Singapore KB returned cross-document citations")

summary_count=sum(
    1 for c in cites
    if isinstance(c,dict) and c.get("chunk_type")=="rag_summary"
)
full_count=sum(
    1 for c in cites
    if isinstance(c,dict) and c.get("chunk_type")=="full_content"
)
if summary_count>1:
    raise SystemExit("FAIL: Singapore KB violated max_summary=1")
if full_count>3:
    raise SystemExit("FAIL: Singapore KB violated max_full_chunks=3")

if data["has_context"]:
    if data["reason"]!="ok":
        raise SystemExit("FAIL: has_context=true but reason is not ok")
    if not isinstance(data.get("llm_context"),str):
        raise SystemExit("FAIL: has_context=true but llm_context missing/invalid")

print("PASS Singapore KB authenticated runtime HTTP 200")
print("PASS Singapore KB response schema")
print("PASS Singapore KB one-document contract")
print("PASS Singapore KB summary/full-content limits")
print("PASS Singapore KB tenant-scoped JWT accepted")
# Never print tenant id, token, response content, citations, or documents.
PY
