#!/bin/bash
set -Eeuo pipefail

SECRET="${KB_SINGAPORE_JWT_SECRET:-}"
TTL_RAW="${KB_SINGAPORE_JWT_TTL_SEC:-300}"
STATIC_DEFAULT="${KB_RAG_TOKEN:-}"
STATIC_TENANTS="${KB_RAG_TENANT_TOKENS_JSON:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ -n "$SECRET" ] || stop "KB_SINGAPORE_JWT_SECRET missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

KB_SINGAPORE_JWT_SECRET="$SECRET" \
KB_SINGAPORE_JWT_TTL_SEC="$TTL_RAW" \
KB_RAG_TOKEN="$STATIC_DEFAULT" \
KB_RAG_TENANT_TOKENS_JSON="$STATIC_TENANTS" \
python3 - <<'PY'
import json, os, sys

secret=os.environ["KB_SINGAPORE_JWT_SECRET"]
ttl_raw=os.environ.get("KB_SINGAPORE_JWT_TTL_SEC","300").strip()
default=os.environ.get("KB_RAG_TOKEN","").strip()
tenant_tokens=os.environ.get("KB_RAG_TENANT_TOKENS_JSON","").strip()

# Require >= 32 UTF-8 bytes for HMAC-SHA256 production secret.
if len(secret.encode("utf-8")) < 32:
    raise SystemExit("STOP: KB_SINGAPORE_JWT_SECRET must be at least 32 bytes")

try:
    ttl=int(ttl_raw)
except Exception:
    raise SystemExit("STOP: KB_SINGAPORE_JWT_TTL_SEC must be an integer")

if ttl < 60 or ttl > 900:
    raise SystemExit("STOP: KB_SINGAPORE_JWT_TTL_SEC must be within 60..900 seconds")

# Product-ready production auth has one authority: short-lived backend JWT.
# Compatibility static bearer envs may remain supported in source, but they are
# forbidden as active production configuration to remove ambiguous auth paths.
if default:
    raise SystemExit("STOP: KB_RAG_TOKEN static bearer fallback must be unset for production READY")
if tenant_tokens:
    try:
        parsed=json.loads(tenant_tokens)
    except Exception:
        raise SystemExit("STOP: KB_RAG_TENANT_TOKENS_JSON invalid JSON")
    if parsed not in ({}, None):
        raise SystemExit("STOP: KB_RAG_TENANT_TOKENS_JSON static tenant tokens must be unset/empty for production READY")

print("PASS Singapore KB backend JWT secret present")
print("PASS JWT secret length >= 32 bytes")
print("PASS JWT TTL within 60..900 seconds")
print("PASS static bearer fallbacks disabled for production")
PY
