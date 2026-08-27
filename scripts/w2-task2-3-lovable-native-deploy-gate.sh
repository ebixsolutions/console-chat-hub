#!/bin/bash
set -Eeuo pipefail
CONFIRMED="${W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED:-}"
PROJECT_REF="${W2_T2_3_PROJECT_REF:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
stop(){ echo "STOP: $1" >&2; exit 2; }
[ "$PROJECT_REF" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ "$CONFIRMED" = "YES" ] || stop "Lovable-native Supabase Edge deployment not confirmed"
echo "PASS Lovable-native Supabase Edge deployment handoff confirmed"
