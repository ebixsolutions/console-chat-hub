#!/bin/bash
set -Eeuo pipefail
TARGET="${W3_T3_3_RUNTIME_INPUT_FILE:-$HOME/.config/ebixpro/ai-chatbot/w3-task3-3-runtime.env}"
mkdir -p "$(dirname "$TARGET")"; umask 077; set -a

read_s(){ local l="$1" v="$2" x; read -r -s -p "$l: " x; echo; [ -n "$x" ]||exit 2; printf -v "$v" '%s' "$x"; }
read_p(){ local l="$1" v="$2" x; read -r -p "$l: " x; [ -n "$x" ]||exit 2; printf -v "$v" '%s' "$x"; }
read_yes(){
  local l="$1" v="$2" x
  read -r -p "$l (type YES): " x
  [ "$x" = "YES" ] || { echo "STOP: confirmation must be YES" >&2; exit 2; }
  printf -v "$v" '%s' "$x"
}

read_s SUPABASE_DB_URL SUPABASE_DB_URL
read_s "Tenant A bearer token" PR10_TENANT_A_BEARER_TOKEN
read_s "Tenant B bearer token" PR10_TENANT_B_BEARER_TOKEN
read_p "Tenant A KB query" PR10_KB_TENANT_A_QUERY
read_p "Tenant B KB query" PR10_KB_TENANT_B_QUERY
read_p "Tenant A expected document_id" PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID
read_p "Tenant B expected document_id" PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID
read_s KB_SINGAPORE_TENANT_MAP_JSON KB_SINGAPORE_TENANT_MAP_JSON
read_s KB_SINGAPORE_TENANT_API_KEYS_JSON KB_SINGAPORE_TENANT_API_KEYS_JSON
read_s TRAINING_OUTBOX_INTERNAL_TOKEN TRAINING_OUTBOX_INTERNAL_TOKEN
read_p SU_COACHAI_EVALUATION_ENDPOINT SU_COACHAI_EVALUATION_ENDPOINT
read_p SU_COACHAI_AUTH_HEADER SU_COACHAI_AUTH_HEADER
read_s SU_COACHAI_AUTH_VALUE SU_COACHAI_AUTH_VALUE
read_s SU_COACHAI_RESULT_TOKEN SU_COACHAI_RESULT_TOKEN
read_s TRAINING_KB_SYNC_INTERNAL_TOKEN TRAINING_KB_SYNC_INTERNAL_TOKEN

# This is an operational attestation, not a secret.
# It must only be entered after the linked Lovable-managed Supabase Edge
# deployment has actually been completed/confirmed.
read_yes "Lovable-native Supabase Edge deployment confirmed" W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED

python3 - "$TARGET" <<'PY'
import os,shlex,sys
names=[
"SUPABASE_DB_URL",
"PR10_TENANT_A_BEARER_TOKEN",
"PR10_TENANT_B_BEARER_TOKEN",
"PR10_KB_TENANT_A_QUERY",
"PR10_KB_TENANT_B_QUERY",
"PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID",
"PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID",
"KB_SINGAPORE_TENANT_MAP_JSON",
"KB_SINGAPORE_TENANT_API_KEYS_JSON",
"TRAINING_OUTBOX_INTERNAL_TOKEN",
"SU_COACHAI_EVALUATION_ENDPOINT",
"SU_COACHAI_AUTH_HEADER",
"SU_COACHAI_AUTH_VALUE",
"SU_COACHAI_RESULT_TOKEN",
"TRAINING_KB_SYNC_INTERNAL_TOKEN",
"W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED",
]
p=sys.argv[1]
with open(p,"w") as f:
    f.write("# Local runtime inputs. NEVER commit this file.\n")
    for n in names:
        f.write("export "+n+"="+shlex.quote(os.environ[n])+"\n")
os.chmod(p,0o600)
print("PASS runtime input file written with mode 600")
PY
