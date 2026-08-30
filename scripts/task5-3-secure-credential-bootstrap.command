#!/bin/bash
set -euo pipefail
PROJECT_REF="nrfxhqabwblzxoushgnm"
TMP="$(mktemp -t task53-secrets.XXXXXX)"
chmod 600 "$TMP"
trap 'rm -f "$TMP"' EXIT

python3 - "$TMP" <<'PY'
import json, os, sys
from pathlib import Path
out=Path(sys.argv[1])
candidates=[
 Path.home()/"Documents/GitHub/console-chat-hub/.env",
 Path.home()/"Documents/GitHub/console-chat-hub/.env.local",
 Path.home()/"Documents/GitHub/console-chat-hub 2/.env",
 Path.home()/"Documents/GitHub/console-chat-hub 2/.env.local",
]

def env_value(name):
    if os.environ.get(name): return os.environ[name]
    for p in candidates:
        if not p.is_file(): continue
        for line in p.read_text(errors='ignore').splitlines():
            if line.startswith(name+'='):
                v=line.split('=',1)[1].strip()
                if len(v)>=2 and v[0]==v[-1] and v[0] in "\"'": v=v[1:-1]
                return v.replace('\\n','\n')
    return None

google=env_value('GOOGLE_SERVICE_ACCOUNT_JSON')
if not google:
    for p in [Path.home()/"Documents/GitHub/console-chat-hub/google-credentials.json",Path.home()/"Documents/GitHub/console-chat-hub 2/google-credentials.json"]:
        if p.is_file(): google=p.read_text(); break
kb=env_value('KB_SINGAPORE_TENANT_API_KEYS_JSON')
missing=[]
if google:
    g=json.loads(google); assert g.get('type')=='service_account'; assert g.get('project_id')=='vertex-ai-api-491406'; assert g.get('private_key') and g.get('client_email')
else: missing.append('GOOGLE_SERVICE_ACCOUNT_JSON')
if kb:
    k=json.loads(kb); assert isinstance(k,dict) and {'34','5'} <= set(k); assert all(isinstance(k[x],str) and len(k[x].strip())>=16 for x in ('34','5'))
else: missing.append('KB_SINGAPORE_TENANT_API_KEYS_JSON')
if missing:
    print('STOP: secure credential source not found locally: '+', '.join(missing))
    raise SystemExit(3)
with out.open('w') as f:
    f.write('GOOGLE_SERVICE_ACCOUNT_JSON='+json.dumps(google)+'\n')
    f.write('KB_SINGAPORE_TENANT_API_KEYS_JSON='+json.dumps(kb)+'\n')
print('PASS: required credentials found and validated locally; values were not displayed')
PY

npx --yes supabase@latest projects list >/dev/null
npx --yes supabase@latest secrets set --project-ref "$PROJECT_REF" --env-file "$TMP"
npx --yes supabase@latest secrets list --project-ref "$PROJECT_REF" --output json | python3 -c 'import json,sys; n={str(x.get("name") or "") for x in json.load(sys.stdin)}; req={"GOOGLE_SERVICE_ACCOUNT_JSON","KB_SINGAPORE_TENANT_API_KEYS_JSON"}; assert req<=n; print("PASS: target secret names installed; values not displayed")'

if command -v gh >/dev/null 2>&1; then
  gh workflow run task5-3-final-gate.yml --repo ebixsolutions/console-chat-hub --ref main
  echo 'PASS: Task 5.3 final gate dispatched'
else
  echo 'PASS: credentials installed. GitHub CLI unavailable, so final gate was not auto-dispatched.'
fi
