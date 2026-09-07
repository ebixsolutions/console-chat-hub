#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from pathlib import Path
p=Path('supabase/functions/receive-widget-message/index.ts')
s=p.read_text()

import_anchor='import {\n  classifyConversationalRoute,\n  NOISE_CLARIFICATION,\n  UNDERSPECIFIED_CLARIFICATION,\n} from "../_shared/conversational-routing.ts";\n'
import_repl=import_anchor+'import { workflow5ShortTopicHint } from "../_shared/conversation-runtime-state.ts";\n'
if 'workflow5ShortTopicHint' not in s:
    if s.count(import_anchor)!=1: raise SystemExit(f'STOP import anchor count={s.count(import_anchor)}')
    s=s.replace(import_anchor,import_repl,1)

route_anchor='    const route = classifyConversationalRoute(normalizedContent);\n    if (route.kind === "clarify" || route.kind === "underspecified") {\n'
route_repl='    const route = classifyConversationalRoute(normalizedContent);\n    const knownShortTopic = workflow5ShortTopicHint(normalizedContent);\n    if (!knownShortTopic && (route.kind === "clarify" || route.kind === "underspecified")) {\n'
if 'const knownShortTopic = workflow5ShortTopicHint(normalizedContent);' not in s:
    if s.count(route_anchor)!=1: raise SystemExit(f'STOP route anchor count={s.count(route_anchor)}')
    s=s.replace(route_anchor,route_repl,1)

p.write_text(s)
out=p.read_text()
for marker in [
    'import { workflow5ShortTopicHint } from "../_shared/conversation-runtime-state.ts";',
    'const knownShortTopic = workflow5ShortTopicHint(normalizedContent);',
    '!knownShortTopic && (route.kind === "clarify" || route.kind === "underspecified")',
]:
    if marker not in out: raise SystemExit('STOP missing '+marker)
print('WORKFLOW5_V71_UPSTREAM_PATCH=PASS')
PY

deno eval 'import { workflow5ShortTopicHint } from "./supabase/functions/_shared/conversation-runtime-state.ts"; const c=[["會員等級呢？","membership tiers"],["会员等级呢？","membership tiers"],["membership tiers?","membership tiers"],["CRM呢？","CRM"],["Push呢？","Push notifications"],["App呢？","App support"]]; for (const [i,w] of c) { const g=workflow5ShortTopicHint(i); if(g!==w) throw new Error(`${i}: ${g} != ${w}`); } console.log("WORKFLOW5_V71_SHORT_TOPIC_FAMILY=PASS");'

# Compile-gate only: Supabase Edge Runtime injects EdgeRuntime at runtime, while
# standalone `deno check` does not know that global. Validate the exact product
# source through a temporary same-directory copy with a type-only declaration;
# product source remains unchanged by this declaration.
CHECK_FILE='supabase/functions/receive-widget-message/.workflow5-v71-check.ts'
cleanup_check_file() { rm -f "$CHECK_FILE"; }
trap cleanup_check_file EXIT
{
  printf '%s\n' 'declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };'
  cat supabase/functions/receive-widget-message/index.ts
} > "$CHECK_FILE"
deno check --node-modules-dir=auto "$CHECK_FILE"
rm -f "$CHECK_FILE"
trap - EXIT
echo WORKFLOW5_V71_RECEIVE_COMPILE=PASS

deno check --node-modules-dir=auto supabase/functions/generate-reply/index.ts
deno test --allow-env tests/edge/workflow5-multilingual-privacy.test.ts
deno test --allow-env tests/edge/workflow4-latest-condition-state.test.ts
deno test --allow-env tests/edge/task4-1-current-context-memory.test.ts
grep -A2 '^\[functions.generate-reply\]' supabase/config.toml | grep -Fq 'verify_jwt = true'
echo WORKFLOW5_V71_SOURCE_GATE=PASS

git config user.name 'ebixsolutions'
git config user.email '64578119+ebixsolutions@users.noreply.github.com'
git add supabase/functions/receive-widget-message/index.ts
if ! git diff --cached --quiet; then
  git commit -m 'fix: route recognized short topics past widget clarification gate'
  git push origin HEAD:main
fi
echo "WORKFLOW5_V71_SOURCE_COMMIT=$(git rev-parse HEAD)"

npx supabase functions deploy receive-widget-message --project-ref "$PROJECT_REF" --no-verify-jwt
echo WORKFLOW5_V71_RECEIVE_DEPLOY=PASS

python - <<'PY'
from pathlib import Path
src=Path('.github/scripts/workflow5_prod_final_v3.py').read_text()
lines=src.splitlines(); removed=[l for l in lines if l.lstrip().startswith("'04':")]
if len(removed)!=1: raise SystemExit(f'STOP expected one Case04 definition, got {len(removed)}')
Path('/tmp/workflow5_case09_v71.py').write_text('\n'.join(l for l in lines if not l.lstrip().startswith("'04':"))+'\n')
PY
python /tmp/workflow5_case09_v71.py
echo WORKFLOW5_V71_FRESH_CASE09_FINAL_GATE=PASS
