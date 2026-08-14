#!/bin/bash
set -Eeuo pipefail

COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
MAP_JSON="${KB_SINGAPORE_TENANT_MAP_JSON:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$MAP_JSON" ] || stop "KB_SINGAPORE_TENANT_MAP_JSON missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

PR7_CANONICAL_COMPANY_UUID="$COMPANY_UUID" \
KB_SINGAPORE_TENANT_MAP_JSON="$MAP_JSON" \
python3 - <<'PY'
import json, os, re, sys, uuid

company = os.environ["PR7_CANONICAL_COMPANY_UUID"].strip()
raw = os.environ["KB_SINGAPORE_TENANT_MAP_JSON"]

try:
    canonical = str(uuid.UUID(company))
except Exception:
    raise SystemExit("STOP: canonical company UUID invalid")

try:
    data = json.loads(raw)
except Exception as e:
    raise SystemExit(f"STOP: KB_SINGAPORE_TENANT_MAP_JSON invalid JSON: {e}")

if not isinstance(data, dict):
    raise SystemExit("STOP: tenant mapping must be a JSON object")
if not data:
    raise SystemExit("STOP: tenant mapping is empty")

normalized = {}
for k, v in data.items():
    if not isinstance(k, str) or not k.strip():
        raise SystemExit("STOP: tenant mapping key must be non-empty string UUID")
    try:
        nk = str(uuid.UUID(k.strip()))
    except Exception:
        raise SystemExit(f"STOP: tenant mapping key is not UUID: {k!r}")
    if nk != k.strip().lower():
        # Canonical spelling avoids two textual aliases for the same UUID.
        raise SystemExit(f"STOP: tenant mapping UUID key must use canonical lowercase form: {k!r}")
    if not isinstance(v, str) or not v.strip():
        raise SystemExit(f"STOP: Singapore tenant id must be non-empty string for {k}")
    tenant = v.strip()
    if len(tenant) > 200 or any(ord(c) < 32 for c in tenant):
        raise SystemExit(f"STOP: Singapore tenant id invalid for {k}")
    if tenant.lower() == nk.lower():
        raise SystemExit("STOP: Singapore tenant id must not be the AI Chatbot company UUID")
    if nk in normalized and normalized[nk] != tenant:
        raise SystemExit("STOP: duplicate canonical company mapping conflict")
    normalized[nk] = tenant

if canonical not in normalized:
    raise SystemExit("STOP: canonical company UUID has no Singapore tenant mapping")

# Current single-company production closure requires exactly one mapping. This
# prevents an unrelated tenant from being silently activated by the same secret.
if len(normalized) != 1:
    raise SystemExit(
        f"STOP: expected exactly one Singapore tenant mapping for current single-company production, got {len(normalized)}"
    )

print("PASS Singapore KB tenant mapping JSON")
print(f"PASS canonical AI company mapped: {canonical}")
print("PASS exactly one production tenant mapping")
# Never print the Singapore tenant id or the original JSON.
PY
