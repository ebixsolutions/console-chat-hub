#!/bin/bash
set -Eeuo pipefail
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
S=scripts/pr10-two-tenant-security-runtime-smoke.sh
F=scripts/pr7-production-final-gate.sh
K=supabase/functions/_shared/kb-client.ts
C=supabase/functions/conversation-evaluate/index.ts
for f in "$S" "$F" "$K" "$C"; do [ -s "$f" ] || exit 1; done
has "$S" 'PR10_TWO_TENANT_FIXTURES_APPROVED' "real fixture approval required"
has "$S" 'SET LOCAL ROLE authenticated' "DB matrix executes as authenticated"
has "$S" 'request.jwt.claim.sub' "auth uid is driven by JWT sub"
has "$S" 'foreign_conv' "foreign conversation denial asserted"
has "$S" 'foreign_eval' "foreign CE denial asserted"
has "$S" 'positive control failed' "KB positive controls mandatory"
has "$S" 'leaked Tenant B document' "A to B KB denial asserted"
has "$S" 'leaked Tenant A document' "B to A KB denial asserted"
has "$K" 'KB_AUTH_TENANT_MISMATCH' "KB tenant mismatch fail-closed retained"
has "$K" 'KB_CROSS_DOCUMENT_MISMATCH' "KB cross-document fail-closed retained"
has "$C" 'tenant_identity_conflict' "CE tenant identity conflict guard retained"
has "$C" 'not_a_member' "CE membership denial retained"
has "$F" 'pr10-two-tenant-security-runtime-smoke.sh' "production final gate executes PR10 runtime"
[ "$fail" -eq 0 ] || { echo "TASK 10.1 TWO-TENANT SECURITY SOURCE STATUS: FAIL"; exit 1; }
echo "TASK 10.1 TWO-TENANT SECURITY SOURCE STATUS: PASS"
