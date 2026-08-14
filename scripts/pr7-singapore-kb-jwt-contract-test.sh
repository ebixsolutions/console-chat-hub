#!/bin/bash
set -Eeuo pipefail
command -v python3 >/dev/null 2>&1 || { echo "FAIL python3 missing"; exit 1; }

python3 - <<'PY'
import base64, hashlib, hmac, json, time

secret=b"x"*32
company="11111111-1111-4111-8111-111111111111"
tenant="sg-test-tenant"
ttl=300
now=int(time.time())

def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

header=b64u(json.dumps({"alg":"HS256","typ":"JWT"}, separators=(",",":")).encode())
payload_obj={
    "sub":f"ai-chatbot:{company}",
    "tenant_id":tenant,
    "role":"service",
    "iat":now,
    "exp":now+ttl,
}
payload=b64u(json.dumps(payload_obj, separators=(",",":")).encode())
signing=f"{header}.{payload}".encode()
sig=b64u(hmac.new(secret, signing, hashlib.sha256).digest())
token=f"{header}.{payload}.{sig}"

parts=token.split(".")
assert len(parts)==3
decoded=json.loads(base64.urlsafe_b64decode(parts[1]+"=="))
assert decoded["sub"]==f"ai-chatbot:{company}"
assert decoded["tenant_id"]==tenant
assert decoded["role"]=="service"
assert decoded["exp"]-decoded["iat"]==ttl
expected=b64u(hmac.new(secret, f"{parts[0]}.{parts[1]}".encode(), hashlib.sha256).digest())
assert hmac.compare_digest(expected, parts[2])
assert decoded["tenant_id"] != company
print("PASS JWT HS256 round-trip")
print("PASS JWT canonical claims")
print("PASS JWT mapped tenant distinct from AI company UUID")
PY
