#!/bin/bash
set -Eeuo pipefail

SUPABASE_URL="${SUPABASE_URL:-}"
TOKEN="${CUSTOMER360_INTERNAL_TOKEN:-}"
CONV="${PR7_C360_SMOKE_CONVERSATION_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ -n "$SUPABASE_URL" ] || stop "SUPABASE_URL missing"
[ -n "$TOKEN" ] || stop "Customer360 internal token missing"
[ -n "$CONV" ] || stop "PR7_C360_SMOKE_CONVERSATION_ID missing"
[[ "$CONV" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "smoke conversation id invalid"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

SUPABASE_URL="$SUPABASE_URL" CUSTOMER360_INTERNAL_TOKEN="$TOKEN" \
PR7_C360_SMOKE_CONVERSATION_ID="$CONV" python3 - <<'PY'
import json, os, urllib.request, urllib.error

base=os.environ["SUPABASE_URL"].rstrip("/")
token=os.environ["CUSTOMER360_INTERNAL_TOKEN"]
conv=os.environ["PR7_C360_SMOKE_CONVERSATION_ID"]
url=f"{base}/functions/v1/customer360-adapter"

body=json.dumps({
  "conversation_id":conv,
  "fields_requested":[
    "masked_summary","tier","predicted_csat","churn_risk",
    "escalation_score","p1_provider_version"
  ]
}).encode()

req=urllib.request.Request(
  url,data=body,method="POST",
  headers={
    "Content-Type":"application/json",
    "X-Internal-Service-Token":token,
    "User-Agent":"PR7-C360-Smoke/1.0",
  }
)
try:
  with urllib.request.urlopen(req,timeout=15) as resp:
    status=resp.status
    raw=resp.read(256001)
except urllib.error.HTTPError as e:
  raise SystemExit(f"FAIL: Customer360 adapter HTTP {e.code}")
except Exception as e:
  raise SystemExit(f"FAIL: Customer360 adapter unreachable: {type(e).__name__}")

if status != 200:
  raise SystemExit(f"FAIL: Customer360 adapter HTTP {status}")
if len(raw)>256000:
  raise SystemExit("FAIL: Customer360 adapter response too large")

try:
  data=json.loads(raw)
except Exception:
  raise SystemExit("FAIL: Customer360 adapter invalid JSON")

if not isinstance(data,dict) or data.get("success") is not True:
  code=(data.get("error") or {}).get("error_code") if isinstance(data,dict) else None
  raise SystemExit(f"FAIL: Customer360 adapter degraded: {code or 'unknown'}")

ctx=data.get("customer_context")
ref=data.get("customer_ref")
if not isinstance(ctx,dict):
  raise SystemExit("FAIL: Customer360 customer_context missing")
if not isinstance(ref,str) or not ref:
  raise SystemExit("FAIL: Customer360 opaque customer_ref missing")

for forbidden in [
  "name","email","phone","address","payment_card","payment_token",
  "raw_ip","raw_device_fingerprint","auth_identifiers","password_hash",
  "session_token","orders","payments"
]:
  if forbidden in ctx:
    raise SystemExit(f"FAIL: forbidden Customer360 field returned: {forbidden}")

print("PASS Customer360 internal adapter HTTP 200")
print("PASS Customer360 real upstream context returned")
print("PASS Customer360 opaque customer identity present")
print("PASS Customer360 never-return fields absent")
# Never print customer ref, context, identity, token, or upstream content.
PY
