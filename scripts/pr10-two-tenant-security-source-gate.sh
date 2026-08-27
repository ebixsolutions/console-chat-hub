#!/bin/bash
set -Eeuo pipefail
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
has(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
not_has(){ grep -Fq "$2" "$1" && bad "$3" || pass "$3"; }

S=scripts/pr10-two-tenant-security-runtime-smoke.sh
K=supabase/functions/_shared/kb-client.ts
A=supabase/functions/_shared/kb-auth.ts
C=supabase/functions/conversation-evaluate/index.ts
for f in "$S" "$K" "$A" "$C"; do [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }; done

has "$S" 'PR10_TWO_TENANT_FIXTURES_APPROVED' "real fixture approval required"
has "$S" 'SET LOCAL ROLE authenticated' "DB matrix executes as authenticated"
has "$S" 'foreign_conv' "foreign conversation denial asserted"
has "$S" 'foreign_eval' "foreign CE denial asserted"
has "$S" '"x-api-key":key' "Singapore current x-api-key contract"
has "$S" '"company_id":int(company_id)' "Singapore current integer company_id contract"
has "$S" '"selected_documents"' "Singapore current response contract"
has "$S" '"max_summary_chunks":1' "Singapore current summary bound"
has "$S" '"max_full_content_chunks":3' "Singapore current evidence bound"
not_has "$S" 'Authorization":"Bearer' "obsolete Singapore Bearer runtime removed"
not_has "$S" '"max_summary":1' "obsolete max_summary field removed"
not_has "$S" '"max_full_chunks":3' "obsolete max_full_chunks field removed"
not_has "$S" '"documents"' "obsolete documents response field removed"

has "$K" 'company_id: companyId' "runtime RAG sends server-derived company_id"
has "$K" 'max_documents: 1' "runtime limits one selected document"
has "$K" 'max_summary_chunks: 1' "runtime summary bound retained"
has "$K" 'max_full_content_chunks: 3' "runtime full-content bound retained"
has "$A" '"x-api-key": credential.value' "shared auth x-api-key retained"
has "$C" 'tenant_identity_conflict' "CE tenant identity conflict guard retained"
has "$C" 'not_a_member' "CE membership denial retained"

[ "$fail" -eq 0 ] || { echo "W3 TASK 3.2 TWO-TENANT SECURITY SOURCE STATUS: FAIL"; exit 1; }
echo "W3 TASK 3.2 TWO-TENANT SECURITY SOURCE STATUS: PASS"
