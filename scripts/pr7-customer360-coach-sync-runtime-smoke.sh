#!/bin/bash
set -Eeuo pipefail

URL="${SUPABASE_URL:-}"
TOKEN="${C360_COACH_SYNC_INTERNAL_TOKEN:-}"
CONV="${PR7_C360_COACH_SMOKE_CONVERSATION_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ -n "$URL" ] || stop "SUPABASE_URL missing"
[ -n "$TOKEN" ] || stop "C360 Coach sync internal token missing"
[ -n "$CONV" ] || stop "PR7_C360_COACH_SMOKE_CONVERSATION_ID missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

SUPABASE_URL="$URL" \
C360_COACH_SYNC_INTERNAL_TOKEN="$TOKEN" \
PR7_C360_COACH_SMOKE_CONVERSATION_ID="$CONV" \
python3 - <<'PY'
import json, os, urllib.request, urllib.error

base=os.environ["SUPABASE_URL"].rstrip("/")
token=os.environ["C360_COACH_SYNC_INTERNAL_TOKEN"]
conv=os.environ["PR7_C360_COACH_SMOKE_CONVERSATION_ID"]

def call():
    req=urllib.request.Request(
        f"{base}/functions/v1/customer360-coach-sync",
        data=json.dumps({"conversation_id":conv}).encode(),
        method="POST",
        headers={
            "Content-Type":"application/json",
            "X-Internal-Service-Token":token,
            "User-Agent":"PR7-C360-Coach-Smoke/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req,timeout=20) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"FAIL: sync HTTP {e.code}")
    except Exception as e:
        raise SystemExit(f"FAIL: sync unreachable: {type(e).__name__}")

s1,d1=call()
if s1!=200 or d1.get("success") is not True:
    raise SystemExit("FAIL: first sync not successful")

s2,d2=call()
if s2!=200 or d2.get("success") is not True:
    raise SystemExit("FAIL: second sync not successful")
if d2.get("idempotent") is not True or d2.get("status")!="no_op":
    raise SystemExit("FAIL: exact replay did not become idempotent no-op")

signals=d2.get("coaching_signals")
if not isinstance(signals,dict):
    raise SystemExit("FAIL: coaching_signals missing")

for forbidden in [
    "name","email","phone","address","order_id","orders","payments",
    "payment_card","payment_token","raw_ip","raw_device_fingerprint",
    "auth_identifiers","password_hash","session_token"
]:
    if forbidden in signals:
        raise SystemExit(f"FAIL: forbidden Coach signal field present: {forbidden}")

print("PASS Customer360↔Coach first sync applied")
print("PASS exact replay is idempotent no-op")
print("PASS coaching signals sanitized")
# Never print customer_ref, hashes, token, context or signal values.
PY
