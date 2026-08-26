#!/bin/bash
set -Eeuo pipefail

SECRET="${KB_SINGAPORE_JWT_SECRET:-}"
MAP_JSON="${KB_SINGAPORE_TENANT_MAP_JSON:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
BASE_URL="${KB_RAG_BASE_URL:-https://py.ebixmall.com/py-knowledge-base}"
QUERY="${PR9_KB_SMOKE_QUERY:-${PR7_KB_SMOKE_QUERY:-}}"
TTL="${KB_SINGAPORE_JWT_TTL_SEC:-300}"

stop(){ echo "STOP: $1"; exit 2; }

[ -n "$SECRET" ] || stop "KB_SINGAPORE_JWT_SECRET missing"
[ ${#SECRET} -ge 32 ] || stop "KB_SINGAPORE_JWT_SECRET too short"
[ -n "$MAP_JSON" ] || stop "KB_SINGAPORE_TENANT_MAP_JSON missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$QUERY" ] || stop "PR9_KB_SMOKE_QUERY missing; use a known published/live document query"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

KB_SINGAPORE_JWT_SECRET="$SECRET" \
KB_SINGAPORE_TENANT_MAP_JSON="$MAP_JSON" \
PR7_CANONICAL_COMPANY_UUID="$COMPANY_UUID" \
KB_RAG_BASE_URL="$BASE_URL" \
PR9_KB_SMOKE_QUERY="$QUERY" \
KB_SINGAPORE_JWT_TTL_SEC="$TTL" \
python3 - <<'PY'
import base64, hashlib, hmac, json, os, ssl, time
import urllib.error, urllib.parse, urllib.request, uuid

def stop(msg):
    raise SystemExit("STOP: "+msg)

secret=os.environ["KB_SINGAPORE_JWT_SECRET"].encode()
company=str(uuid.UUID(os.environ["PR7_CANONICAL_COMPANY_UUID"].strip()))

try:
    mapping=json.loads(os.environ["KB_SINGAPORE_TENANT_MAP_JSON"])
except Exception:
    stop("Singapore tenant mapping invalid JSON")
if not isinstance(mapping,dict):
    stop("Singapore tenant mapping must be object")
tenant=mapping.get(company)
if not isinstance(tenant,str) or not tenant.strip():
    stop("canonical company has no Singapore tenant mapping")
tenant=tenant.strip()

try:
    ttl=int(os.environ.get("KB_SINGAPORE_JWT_TTL_SEC","300"))
except Exception:
    stop("JWT TTL invalid")
if ttl < 60 or ttl > 900:
    stop("JWT TTL outside 60..900")

base=os.environ.get("KB_RAG_BASE_URL","https://py.ebixmall.com/py-knowledge-base").rstrip("/")
parsed=urllib.parse.urlparse(base)
if parsed.scheme!="https" and parsed.hostname not in ("localhost","127.0.0.1"):
    stop("Singapore KB base URL must use https")

query=os.environ["PR9_KB_SMOKE_QUERY"].strip()[:500]
if not query:
    stop("smoke query empty")

def b64u(data:bytes)->str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

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

ctx=ssl.create_default_context()
req=urllib.request.Request(
    f"{base}/api/v1/rag/context-search",
    data=body,
    method="POST",
    headers={
        "Authorization":f"Bearer {token}",
        "Content-Type":"application/json",
        "User-Agent":"PR9-KB-Authenticated-Runtime/1.0",
    },
)
try:
    with urllib.request.urlopen(req,timeout=20,context=ctx) as resp:
        status=resp.status
        raw=resp.read()
except urllib.error.HTTPError as e:
    raise SystemExit(f"FAIL: Singapore KB context HTTP {e.code}")
except Exception as e:
    raise SystemExit(f"FAIL: Singapore KB context unreachable: {type(e).__name__}")

if status != 200:
    raise SystemExit(f"FAIL: Singapore KB context HTTP {status}")
try:
    data=json.loads(raw)
except Exception:
    raise SystemExit("FAIL: Singapore KB context invalid JSON")
if not isinstance(data,dict):
    raise SystemExit("FAIL: Singapore KB context response must be object")

if data.get("has_context") is not True:
    raise SystemExit("FAIL: smoke query did not return known live context")
if data.get("reason") != "ok":
    raise SystemExit("FAIL: has_context=true but reason!=ok")
if not isinstance(data.get("llm_context"),str) or not data["llm_context"].strip():
    raise SystemExit("FAIL: llm_context missing/empty")
if not isinstance(data.get("citations"),list) or not isinstance(data.get("documents"),list):
    raise SystemExit("FAIL: citations/documents schema invalid")

docs=data["documents"]
cites=data["citations"]
if len(docs)!=1:
    raise SystemExit("FAIL: expected exactly one selected document for known-context smoke")
selected=docs[0].get("document_id") if isinstance(docs[0],dict) else None
if not isinstance(selected,str) or not selected:
    raise SystemExit("FAIL: selected document_id missing")

cite_ids={
    c.get("document_id")
    for c in cites
    if isinstance(c,dict) and isinstance(c.get("document_id"),str)
}
if any(x != selected for x in cite_ids):
    raise SystemExit("FAIL: cross-document citation detected")

summary_count=sum(
    1 for c in cites
    if isinstance(c,dict) and c.get("chunk_type")=="rag_summary"
)
full_count=sum(
    1 for c in cites
    if isinstance(c,dict) and c.get("chunk_type")=="full_content"
)
if summary_count>1:
    raise SystemExit("FAIL: max_summary=1 violated")
if full_count>3:
    raise SystemExit("FAIL: max_full_chunks=3 violated")
if full_count < 1:
    raise SystemExit("FAIL: known-context smoke returned no full_content evidence")

# Same authenticated JWT must be able to read selected document metadata.
meta_req=urllib.request.Request(
    f"{base}/api/entities/KBDocument/{urllib.parse.quote(selected,safe='')}",
    method="GET",
    headers={
        "Authorization":f"Bearer {token}",
        "User-Agent":"PR9-KB-Authenticated-Runtime/1.0",
    },
)
try:
    with urllib.request.urlopen(meta_req,timeout=20,context=ctx) as resp:
        meta_status=resp.status
        meta_raw=resp.read()
except urllib.error.HTTPError as e:
    raise SystemExit(f"FAIL: Singapore KB metadata HTTP {e.code}")
except Exception as e:
    raise SystemExit(f"FAIL: Singapore KB metadata unreachable: {type(e).__name__}")

if meta_status != 200:
    raise SystemExit(f"FAIL: Singapore KB metadata HTTP {meta_status}")
try:
    meta=json.loads(meta_raw)
except Exception:
    raise SystemExit("FAIL: Singapore KB metadata invalid JSON")
if not isinstance(meta,dict):
    raise SystemExit("FAIL: Singapore KB metadata response must be object")
if str(meta.get("id","")) != selected:
    raise SystemExit("FAIL: selected document metadata id mismatch")
if meta.get("status") != "published":
    raise SystemExit("FAIL: selected document is not published")
if meta.get("production_status") != "production":
    raise SystemExit("FAIL: selected document is not production")
if meta.get("available_to_live_console") is not True:
    raise SystemExit("FAIL: selected document unavailable to live console")
if meta.get("is_outdated") is True:
    raise SystemExit("FAIL: selected document is outdated")

print("PASS Singapore KB authenticated context-search HTTP 200")
print("PASS Singapore KB known-context response")
print("PASS Singapore KB exact one-document contract")
print("PASS Singapore KB max 1 summary / max 3 full_content")
print("PASS Singapore KB at least one full_content evidence")
print("PASS Singapore KB same-JWT document metadata fetch")
print("PASS Singapore KB selected document published+production+live+current")
print("PASS Singapore KB tenant-scoped short-lived JWT runtime")
# Never print tenant, token, company, content, citations or document metadata.
PY
