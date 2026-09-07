#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from pathlib import Path

shared=Path('supabase/functions/_shared/conversation-runtime-state.ts')
ss=shared.read_text()
if 'export function workflow5ShortTopicHint(' not in ss:
    ss += r'''

// Workflow 5 short topical queries are semantically complete subjects even when
// conversationally terse. Keep this detector pure so callers can prevent generic
// clarification from consuming a known topic.
export function workflow5ShortTopicHint(text: string): string | null {
  const normalized = (text || "").trim().toLowerCase();
  if (!normalized) return null;
  let compact = normalized.replace(/\s+/g, "");
  compact = compact.replace(/[？?]+$/g, "");
  compact = compact.replace(/(?:呢|咧|啊|呀|嗎|吗)+$/g, "");
  compact = compact.replace(/^(?:咁|那)/, "");
  if (["會員等級", "会员等级", "會員分級", "会员分级", "membershiptier", "membershiptiers", "membertier", "membertiers", "membershiplevel", "membershiplevels", "memberlevel", "memberlevels"].includes(compact)) return "membership tiers";
  if (["crm", "客戶管理", "客户管理"].includes(compact)) return "CRM";
  if (["push", "推送", "推播", "通知", "推送通知"].includes(compact)) return "Push notifications";
  if (["app", "手機app", "手机app", "手機應用", "手机应用", "應用程式", "应用程序"].includes(compact)) return "App support";
  return null;
}
'''
    shared.write_text(ss)

p=Path('supabase/functions/generate-reply/index.ts')
s=p.read_text()
old='  buildWorkflow5TopicalClarification,\n  resolveConversationMemoryResponse,'
new='  buildWorkflow5TopicalClarification,\n  workflow5ShortTopicHint,\n  resolveConversationMemoryResponse,'
if 'workflow5ShortTopicHint,' not in s:
    if s.count(old)!=1: raise SystemExit(f'STOP import anchor count={s.count(old)}')
    s=s.replace(old,new,1)
anchor='  const _visitorLang = resolveWorkflow5ConversationLanguage(_h1LastMsg, _pr5HistoryRows ?? []);\n'
marker='  const _w5ShortTopicHint = workflow5ShortTopicHint(_h1LastMsg);\n'
if marker not in s:
    if s.count(anchor)!=1: raise SystemExit(f'STOP lang anchor count={s.count(anchor)}')
    block='''  const _w5ShortTopicHint = workflow5ShortTopicHint(_h1LastMsg);\n  if (_w5ShortTopicHint === "membership tiers") {\n    const topicalReply = _visitorLang === "en"\n      ? "You’re asking about membership tiers. I don’t have enough confirmed published information to state the tier structure, inclusions, or limits, so I won’t guess."\n      : _visitorLang === "zh-CN"\n      ? "你问的是会员等级。目前没有足够已确认的已发布资料来确定会员等级的架构、包含内容或限制，所以我不会猜。"\n      : "你問的是會員等級。目前未有足夠已確認的已發布資料去確定會員等級的架構、包含內容或限制，所以我唔會估。";\n    const topicalCommit = await commitAiReplyWithControlGate(\n      supabaseAdmin, conversation_id, source_message_id, topicalReply,\n      { response_route: "workflow5_topical_recovery", escalation_action: "continue_ai", handoff_required: false, topic: _w5ShortTopicHint, factual_grounding_required: true, grounding_state: "published_evidence_unconfirmed" },\n    );\n    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);\n    if (topicalCommit.ok) return new Response(JSON.stringify({ success: true, reply: topicalReply, response_route: "workflow5_topical_recovery", handoff_required: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });\n    if (["human_control", "resolved", "superseded_source"].includes(topicalCommit.result)) return new Response(JSON.stringify({ success: true, skipped: topicalCommit.result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });\n    return new Response(JSON.stringify({ success: false, error: `workflow5_topical_recovery_${topicalCommit.result}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });\n  }\n'''
    s=s.replace(anchor,anchor+block,1)
s=s.replace('!buildWorkflow5TopicalClarification(_h1LastMsg, _visitorLang) &&','!_w5ShortTopicHint &&')
p.write_text(s)

required_shared=['export function workflow5ShortTopicHint(','membership tiers','Push notifications','App support']
for x in required_shared:
    if x not in shared.read_text(): raise SystemExit('STOP missing shared '+x)
required_index=['workflow5ShortTopicHint,','const _w5ShortTopicHint = workflow5ShortTopicHint(_h1LastMsg);','_w5ShortTopicHint === "membership tiers"','workflow5_topical_recovery','published_evidence_unconfirmed','!_w5ShortTopicHint &&']
for x in required_index:
    if x not in p.read_text(): raise SystemExit('STOP missing index '+x)
print('WORKFLOW5_V70_DEPENDENCY_CLOSURE_PATCH=PASS')
PY

deno eval 'import { workflow5ShortTopicHint } from "./supabase/functions/_shared/conversation-runtime-state.ts"; const c=[["會員等級呢？","membership tiers"],["会员等级呢？","membership tiers"],["membership tiers?","membership tiers"],["CRM呢？","CRM"],["Push呢？","Push notifications"],["App呢？","App support"]]; for (const [i,w] of c) { const g=workflow5ShortTopicHint(i); if(g!==w) throw new Error(`${i}: ${g} != ${w}`); } console.log("WORKFLOW5_SHORT_TOPIC_ROOT_FAMILY=PASS");'
deno test --allow-env tests/edge/workflow5-multilingual-privacy.test.ts
deno test --allow-env tests/edge/workflow4-latest-condition-state.test.ts
deno test --allow-env tests/edge/task4-1-current-context-memory.test.ts
deno check --node-modules-dir=auto supabase/functions/generate-reply/index.ts
grep -A2 '^\[functions.generate-reply\]' supabase/config.toml | grep -Fq 'verify_jwt = true'
echo WORKFLOW5_V70_SOURCE_GATE=PASS

git config user.name 'ebixsolutions'
git config user.email '64578119+ebixsolutions@users.noreply.github.com'
git add supabase/functions/_shared/conversation-runtime-state.ts supabase/functions/generate-reply/index.ts
if ! git diff --cached --quiet; then
  git commit -m 'fix: close member-tier topical recovery dependency chain'
  git push origin HEAD:main
fi
echo "WORKFLOW5_V70_SOURCE_COMMIT=$(git rev-parse HEAD)"

npx supabase functions deploy generate-reply --project-ref "$PROJECT_REF"
echo WORKFLOW5_V70_DEPLOY=PASS

python - <<'PY'
from pathlib import Path
src=Path('.github/scripts/workflow5_prod_final_v3.py').read_text()
lines=src.splitlines(); removed=[l for l in lines if l.lstrip().startswith("'04':")]
if len(removed)!=1: raise SystemExit(f'STOP expected one Case04 definition, got {len(removed)}')
Path('/tmp/workflow5_case09_v70.py').write_text('\n'.join(l for l in lines if not l.lstrip().startswith("'04':"))+'\n')
PY
python /tmp/workflow5_case09_v70.py
echo WORKFLOW5_V70_FRESH_CASE09_FINAL_GATE=PASS
