#!/bin/bash
set -Eeuo pipefail
M="scripts/pr7-singapore-kb-tenant-mapping-gate.sh"
C="scripts/pr7-production-runtime-config-gate.sh"
T="scripts/pr10-two-tenant-security-runtime-smoke.sh"
F="scripts/pr7-production-final-gate.sh"
fail=0
pass(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }
for f in "$M" "$C" "$T" "$F"; do [ -s "$f" ] || { echo "FAIL missing/empty $f"; exit 1; }; done
not_has "$M" 'expected exactly one Singapore tenant mapping' "legacy exactly-one mapping restriction removed"
not_has "$C" 'must contain exactly one current production mapping' "runtime exactly-one mapping restriction removed"
has "$M" 'canonical AI company mapping present' "canonical mapping mandatory"
has "$M" 'Singapore tenant values collision-free' "mapping collision guard"
has "$M" 'two-tenant Singapore mappings present and distinct' "two-tenant mapping support"
has "$C" 'canonical company missing from Singapore mapping' "runtime canonical mapping required"
has "$C" 'two-tenant Singapore mappings missing or not distinct' "runtime two-tenant mapping compatibility"
has "$T" 'distinct Singapore mappings required' "PR10 distinct-tenant requirement retained"
has "$T" 'ts[0].strip()==ts[1].strip()' "PR10 rejects same Singapore tenant for A/B"
has "$T" 'Tenant A positive control failed' "PR10 Tenant A positive control retained"
has "$T" 'Tenant B positive control failed' "PR10 Tenant B positive control retained"
has "$T" 'Tenant A JWT leaked Tenant B document' "PR10 A-to-B leakage denial retained"
has "$T" 'Tenant B JWT leaked Tenant A document' "PR10 B-to-A leakage denial retained"
has "$F" 'pr10-two-tenant-security-runtime-smoke.sh' "production final gate still executes PR10"
[ "$fail" -eq 0 ] || { echo "TASK 12.1 SINGAPORE KB PRODUCTION MAPPING COMPATIBILITY STATUS: FAIL"; exit 1; }
echo "TASK 12.1 SINGAPORE KB PRODUCTION MAPPING COMPATIBILITY STATUS: PASS"
