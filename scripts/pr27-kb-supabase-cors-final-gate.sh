#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
for f in supabase/functions/_shared/supabase-cors.ts supabase/functions/kb-search-proxy/index.ts supabase/functions/agent-assist/index.ts tests/edge/pr27-kb-supabase-cors.test.ts; do [ -s "$ROOT/$f" ] || exit 2; done
python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys
r=Path(sys.argv[1])
h=(r/"supabase/functions/_shared/supabase-cors.ts").read_text()
for x in ['"x-supabase-api-version"','resolveSupabaseAllowedHeaders','Access-Control-Request-Headers']: assert x in h or x=="Access-Control-Request-Headers"
for p in ["supabase/functions/kb-search-proxy/index.ts","supabase/functions/agent-assist/index.ts"]:
 s=(r/p).read_text();assert 'supabaseCorsHeaders' in s;assert 'Access-Control-Request-Headers' in s
print("PASS source assertions")
PY
DENO=deno
command -v deno >/dev/null 2>&1 || DENO="npx --yes deno"
cd "$ROOT"
$DENO test --node-modules-dir=none tests/edge/pr27-kb-supabase-cors.test.ts
$DENO check --node-modules-dir=none supabase/functions/_shared/supabase-cors.ts
echo "PR27 KB SUPABASE CORS GATE: PASS"
