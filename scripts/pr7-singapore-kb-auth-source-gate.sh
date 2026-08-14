#!/bin/bash
set -Eeuo pipefail
FILE="supabase/functions/_shared/kb-client.ts"
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

[ -s "$FILE" ] || { echo "FAIL kb-client missing"; exit 1; }

must_have "$FILE" 'Deno.env.get("KB_SINGAPORE_JWT_SECRET")' "JWT signing secret is server env only"
must_have "$FILE" 'ttlRaw >= 60 && ttlRaw <= 900' "JWT TTL bounded"
must_have "$FILE" 'async function mintSingaporeTenantJwt(' "backend JWT mint function exists"
must_have "$FILE" '{ alg: "HS256", typ: "JWT" }' "JWT algorithm fixed to HS256"
must_have "$FILE" 'sub: `ai-chatbot:${scope.aiCompanyId}`' "JWT subject binds AI company"
must_have "$FILE" 'tenant_id: scope.singaporeTenantId' "JWT tenant claim uses mapped Singapore tenant"
must_have "$FILE" 'role: "service"' "JWT service role explicit"
must_have "$FILE" 'iat: now' "JWT issued-at claim present"
must_have "$FILE" 'exp: now + cfg.jwtTtlSec' "JWT expiry claim present"
must_have "$FILE" '{ name: "HMAC", hash: "SHA-256" }' "JWT HMAC-SHA256 signing"
must_have "$FILE" 'const tokenTenant = claims.tenant_id ?? claims.sub;' "outbound token tenant checked"
must_have "$FILE" 'KB_AUTH_TENANT_MISMATCH' "tenant mismatch fails closed"
must_have "$FILE" 'KB_AUTH_TOKEN_EXPIRED' "expired token fails closed"
must_have "$FILE" 'Authorization: `Bearer ${auth.token}`' "RAG request uses backend bearer token"
must_have "$FILE" 'body: JSON.stringify({' "RAG request body explicit"
must_not_have "$FILE" 'KB_SINGAPORE_JWT_SECRET")!' "no non-null assertion that masks missing auth config"

if [ "$fail" -ne 0 ]; then
  echo "TASK 4.2 KB AUTH SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 4.2 KB AUTH SOURCE STATUS: PASS"
