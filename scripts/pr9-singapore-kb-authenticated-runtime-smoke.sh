#!/bin/bash
set -Eeuo pipefail

MAP_JSON="${KB_SINGAPORE_TENANT_MAP_JSON:-}"
KEYS_JSON="${KB_SINGAPORE_TENANT_API_KEYS_JSON:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
BASE_URL="${KB_SINGAPORE_BASE_URL:-${KB_RAG_BASE_URL:-https://py.ebixmall.com/py-knowledge-base}}"
QUERY="${PR9_KB_SMOKE_QUERY:-${PR7_KB_SMOKE_QUERY:-}}"

stop(){ echo "STOP: $1"; exit 2; }
[ -n "$MAP_JSON" ] || stop "KB_SINGAPORE_TENANT_MAP_JSON missing"
[ -n "$KEYS_JSON" ] || stop "KB_SINGAPORE_TENANT_API_KEYS_JSON missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$QUERY" ] || stop "PR9_KB_SMOKE_QUERY missing; use a known published/live document query"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

KB_SINGAPORE_TENANT_MAP_JSON="$MAP_JSON" \
KB_SINGAPORE_TENANT_API_KEYS_JSON="$KEYS_JSON" \
PR7_CANONICAL_COMPANY_UUID="$COMPANY_UUID" \
KB_SINGAPORE_BASE_URL="$BASE_URL" \
PR9_KB_SMOKE_QUERY="$QUERY" \
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

tenant=mapping.get(company) if isinstance(mapping,dict) else None
if not isinstance(tenant,str) or not tenant.strip():
    stop("canonical company has no Singapore mapping")
tenant=tenant.strip()
if not tenant.isdigit() or int(tenant)<=0:
    stop("Singapore mapped company_id must be positive integer")
api_key=keys.get(tenant) if isinstance(keys,dict) else None
if not isinstance(api_key,str) or len(api_key.strip())<16:
    stop("tenant-bound Singapore API key missing/invalid")
api_key=api_key.strip()

base=os.environ["KB_SINGAPORE_BASE_URL"].rstrip("/")
query=os.environ["PR9_KB_SMOKE_QUERY"].strip()[:500]
ctx=ssl.create_default_context()

body=json.dumps({
    "query":query,
    "company_id":int(tenant),
    "candidate_top_k":12,
    "max_documents":1,
    "max_summary_chunks":1,
    "max_full_content_chunks":3,
    "score_threshold":0.05,
}).encode()
req=urllib.request.Request(
    f"{base}/api/v1/rag/context-search",
    data=body,
    method="POST",
    headers={"x-api-key":api_key,"Content-Type":"application/json","User-Agent":"W1-T1.3-KB-KnownContext/1.0"},
)
try:
    with urllib.request.urlopen(req,timeout=20,context=ctx) as resp:
        raw=resp.read()
        status=resp.status
except urllib.error.HTTPError as e:
    fail(f"context HTTP {e.code}")
except Exception as e:
    fail(f"context unreachable: {type(e).__name__}")
if status != 200: fail(f"context HTTP {status}")
try: data=json.loads(raw)
except Exception: fail("context invalid JSON")
if not isinstance(data,dict) or data.get("success") is not True:
    fail("context response invalid")
if data.get("context_found") is not True:
    fail("known-context query returned context_found!=true")
docs=data.get("selected_documents")
if not isinstance(docs,list) or len(docs)!=1 or not isinstance(docs[0],dict):
    fail("known-context must select exactly one document")
doc=docs[0]
selected=doc.get("document_id")
if not isinstance(selected,str) or not selected: fail("document_id missing")
evidence=doc.get("evidence")
if not isinstance(evidence,list): fail("evidence missing")
full=[e for e in evidence if isinstance(e,dict) and e.get("chunk_type")=="full_content"]
summ=[e for e in evidence if isinstance(e,dict) and e.get("chunk_type")=="rag_summary"]
if len(full)<1: fail("known-context returned no full_content evidence")
if len(full)>3: fail("max_full_content_chunks=3 violated")
if len(summ)>1: fail("max_summary_chunks=1 violated")

meta_req=urllib.request.Request(
    f"{base}/api/entities/KBDocument/{urllib.parse.quote(selected,safe='')}",
    method="GET",
    headers={"x-api-key":api_key,"User-Agent":"W1-T1.3-KB-KnownContext/1.0"},
)
try:
    with urllib.request.urlopen(meta_req,timeout=20,context=ctx) as resp:
        meta_status=resp.status
        meta_raw=resp.read()
except urllib.error.HTTPError as e:
    fail(f"metadata HTTP {e.code}")
except Exception as e:
    fail(f"metadata unreachable: {type(e).__name__}")
if meta_status != 200: fail(f"metadata HTTP {meta_status}")
try: meta=json.loads(meta_raw)
except Exception: fail("metadata invalid JSON")
if not isinstance(meta,dict): fail("metadata response invalid")
if str(meta.get("id","")) != selected: fail("metadata id mismatch")
if meta.get("status") != "published": fail("selected document not published")
if meta.get("available_to_live_console") is not True: fail("selected document not live-console available")
if meta.get("is_outdated") is True: fail("selected document outdated")

print("PASS Singapore KB known-context current contract")
print("PASS exactly one selected document")
print("PASS full_content authoritative evidence present")
print("PASS selected document published/live/current")
# Never print secret/company/tenant/content/citations.
PY
