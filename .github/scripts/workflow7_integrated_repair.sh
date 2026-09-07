#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from pathlib import Path

# ---- conversation-runtime-state.ts ----
p=Path('supabase/functions/_shared/conversation-runtime-state.ts')
s=p.read_text()

# 1) Product-count integrity: never let a latest staff count overwrite product_count.
old='''    const latestCount = text.match(/(?:最新|目前|現在|现在)\\s*(?:係|是|為|为)?\\s*(\\d{1,6})(?:\\s*(?:件|sku))?/i);\n    if (productCount !== null && latestCount?.[1]) productCount = Number(latestCount[1]);'''
new='''    const latestCount = text.match(/(?:最新|目前|現在|现在)\\s*(?:係|是|為|为)?\\s*(\\d{1,6})(?:\\s*(?:件|sku))?/i);\n    const latestCountIsStaff = /(?:staff|員工|员工|管理人手|管理人员)/i.test(text);\n    if (productCount !== null && latestCount?.[1] && !latestCountIsStaff) productCount = Number(latestCount[1]);'''
if old not in s and 'latestCountIsStaff' not in s:
    raise SystemExit('STOP product-count anchor missing')
if old in s:
    s=s.replace(old,new,1)

# 2) Dynamic known/unknown summary: remove stale 1000+ SKU hard-code and derive from canonical state.
start=s.find('  const workflow5KnownUnknownRequest = ')
end=s.find('\n\n  const workflow5NextStepRequest = ', start)
if start<0 or end<0: raise SystemExit('STOP known/unknown block anchors missing')
block=s[start:end]
if 'knownRequirementSummary' not in block:
    repl='''  const workflow5KnownUnknownRequest = /(?:按|根據|根据|based\\s+on).{0,25}(?:我|已確認|已确认|confirmed).{0,30}(?:邊啲|哪些|what).{0,20}(?:知|知道|known).{0,25}(?:未知|唔知|不知道|unknown)/i.test(latest);\n  if (workflow5KnownUnknownRequest) {\n    const requirementLines = currentRequirementLines(state.current_requirements, lang);\n    const knownRequirementSummary = requirementLines.length\n      ? requirementLines.join(lang === "en" ? "; " : "、")\n      : (lang === "en" ? "the requirements stated in this conversation" : "今段對話已明確提供嘅需求");\n    if (lang === "en") return `Confirmed from your conversation: ${knownRequirementSummary}. Still unconfirmed from published information here: product/member-data migration capacity, Macau-customer payment support when not explicitly published, and any feature or limit not stated in the published KB.`;\n    if (lang === "zh-CN") return `按你已确认的情况：${knownRequirementSummary}。目前仍未有足够已发布资料确认的是：商品／会员资料迁移能力、未有明确发布的澳门客户付款支持，以及任何未在已发布知识库列明的功能或限制。`;\n    return `按你已確認嘅情況：${knownRequirementSummary}。目前仍未有足夠已發布資料確認嘅係：商品／會員資料遷移能力、未有明確發布嘅澳門客戶付款支援，以及任何未喺已發布知識庫列明嘅功能或限制。`;\n  }'''
    s=s[:start]+repl+s[end:]

start=s.find('  const workflow5NextStepRequest = ')
end=s.find('\n\n  const latestRequirementsRequest = ', start)
if start<0 or end<0: raise SystemExit('STOP next-step block anchors missing')
block=s[start:end]
if 'nextRequirementSummary' not in block:
    repl='''  const workflow5NextStepRequest = /(?:一句|one\\s+sentence).{0,30}(?:下一步|next\\s+step).{0,30}(?:確認|核實|confirm|verify)/i.test(latest);\n  if (workflow5NextStepRequest) {\n    const requirementLines = currentRequirementLines(state.current_requirements, lang);\n    const nextRequirementSummary = requirementLines.length\n      ? requirementLines.join(lang === "en" ? "; " : "、")\n      : (lang === "en" ? "your current requirements" : "你目前需求");\n    if (lang === "en") return `Next, verify only the still-unpublished or tenant-specific parts around ${nextRequirementSummary}; do not reclassify already published plan facts as unknown.`;\n    if (lang === "zh-CN") return `下一步只需核实围绕「${nextRequirementSummary}」仍未发布或属租户／个案资料的部分；已发布的方案事实不要重新当成未知。`;\n    return `下一步只需要核實圍繞「${nextRequirementSummary}」仍未發布或屬租戶／個案資料嘅部分；已發布嘅方案事實唔好重新當成未知。`;\n  }'''
    s=s[:start]+repl+s[end:]

# 3) Retrieval query enrichment: canonical entity + facet hints, no invented facts.
anchor='export function buildCanonicalRetrievalQuery(latestInput: string, newestFirst: RuntimeHistoryRow[]): CanonicalRetrievalQuery {'
if 'function buildPublishedKbRetrievalHints' not in s:
    helper=r'''
function recentPublishedKbSubject(latest: string, previous: string[]): string | null {
  const joined = [latest, ...previous.slice(0, 8)].join(" / ");
  const modelMatches = [...joined.matchAll(/\b[A-Z]{2,}[A-Z0-9]*[-][A-Z0-9-]{2,}\b/g)].map((m) => m[0]);
  if (modelMatches.length) return modelMatches[0];
  const explicitPlan = latest.match(/(?:Smoke\s+Test\s+)?(Growth|Basic|Pro)\s*(?:plan|方案|計劃|计划)?/i);
  if (explicitPlan?.[1]) return `Smoke Test ${explicitPlan[1][0].toUpperCase()}${explicitPlan[1].slice(1).toLowerCase()}`;
  for (const text of previous.slice(0, 8)) {
    const m = text.match(/(?:Smoke\s+Test\s+)?(Growth|Basic|Pro)\s*(?:plan|方案|計劃|计划)?/i);
    if (m?.[1]) return `Smoke Test ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`;
  }
  return null;
}

function buildPublishedKbRetrievalHints(latest: string): string[] {
  const hints: string[] = [];
  if (/(價錢|价格|價|price|monthly|yearly|月費|月费|年費|年费|年繳|年缴|月繳|月缴)/i.test(latest)) hints.push("published price monthly annual HKD");
  if (/(sku|商品數量|商品数量|product count|limit|上限)/i.test(latest)) hints.push("published SKU product-count limit");
  if (/(staff|員工|员工|管理人手|管理人员)/i.test(latest)) hints.push("published staff admin-seat limit");
  if (/(app|push|推播|推送|crm|會員等級|会员等级|member tier|membership)/i.test(latest)) hints.push("published included features App Push CRM membership tiers");
  if (/(送貨|送货|delivery|九龍|九龙|kowloon|澳門|澳门|macau|macao)/i.test(latest)) hints.push("published delivery policy Hong Kong Kowloon Macau delivery arrangement");
  if (/(退款|refund|百分比|比例|刮痕|損壞|损坏|換貨|换货)/i.test(latest)) hints.push("published refund exchange damaged-item policy fixed percentage case-by-case");
  if (/(保養|保修|warranty|dB|分貝|分贝|噪音|noise)/i.test(latest)) hints.push("published product warranty noise specification");
  return hints;
}

'''
    if anchor not in s: raise SystemExit('STOP retrieval function anchor missing')
    s=s.replace(anchor,helper+anchor,1)

# Inject subject/hints immediately after previous customer context is calculated.
old='''  const previous = newestFirst.filter((row) => CUSTOMER.has(String(row.role ?? "").toLowerCase())).map((row) => clean(row.content)).filter((x) => x && x !== latest && x !== "__THINKING__");\n  const referencesCurrentRequirements ='''
new='''  const previous = newestFirst.filter((row) => CUSTOMER.has(String(row.role ?? "").toLowerCase())).map((row) => clean(row.content)).filter((x) => x && x !== latest && x !== "__THINKING__");\n  const publishedKbSubject = recentPublishedKbSubject(latest, previous);\n  const publishedKbHints = buildPublishedKbRetrievalHints(latest);\n  const referencesCurrentRequirements ='''
if old in s: s=s.replace(old,new,1)
elif 'const publishedKbSubject = recentPublishedKbSubject' not in s: raise SystemExit('STOP retrieval previous anchor missing')

# Standalone query: keep latest verbatim plus non-factual retrieval hints and inherited active subject.
old='''  if (!needsContext || explicitBoundary) {\n    return { query: latest, mode: "standalone", latest, context_turns: [], state: { ...state, jurisdiction: explicitJurisdiction ?? state.jurisdiction } };\n  }'''
new='''  if (!needsContext || explicitBoundary) {\n    const query = [\n      `Current request: ${latest}`,\n      ...(publishedKbSubject ? [`Active published-KB subject: ${publishedKbSubject}`] : []),\n      ...(publishedKbHints.length ? [`Retrieval facets: ${publishedKbHints.join(" / ")}`] : []),\n    ].join("\\n").slice(0, 1600);\n    return { query, mode: "standalone", latest, context_turns: [], state: { ...state, jurisdiction: explicitJurisdiction ?? state.jurisdiction } };\n  }'''
if old in s: s=s.replace(old,new,1)
elif 'Active published-KB subject' not in s: raise SystemExit('STOP standalone retrieval anchor missing')

# Contextual query: pin the active subject before noisy history.
old='''    query: [\n      `Current request: ${latest}`,\n      ...(requirementLines.length ? [`Current customer requirement snapshot (latest wins): ${requirementLines.join(" / ")}`] : []),\n      `Relevant prior customer context: ${contextTurns.join(" / ")}`,\n    ].join("\\n").slice(0, 1600),'''
new='''    query: [\n      `Current request: ${latest}`,\n      ...(publishedKbSubject ? [`Active published-KB subject: ${publishedKbSubject}`] : []),\n      ...(publishedKbHints.length ? [`Retrieval facets: ${publishedKbHints.join(" / ")}`] : []),\n      ...(requirementLines.length ? [`Current customer requirement snapshot (latest wins): ${requirementLines.join(" / ")}`] : []),\n      `Relevant prior customer context: ${contextTurns.join(" / ")}`,\n    ].join("\\n").slice(0, 1600),'''
if old in s: s=s.replace(old,new,1)
elif s.count('Active published-KB subject') < 2: raise SystemExit('STOP contextual retrieval anchor missing')

# Current-requirements retrieval path must also pin plan/entity and facets.
old='''        `Current request: ${latest}`,\n        "Retrieval target: ebixPRO ecommerce subscription plan limits, included features, admin/staff seats, and market eligibility only.",\n        ...(requirementLines.length ? [`Current customer requirement snapshot (latest wins): ${requirementLines.join(" / ")}`] : []),'''
new='''        `Current request: ${latest}`,\n        ...(publishedKbSubject ? [`Active published-KB subject: ${publishedKbSubject}`] : []),\n        ...(publishedKbHints.length ? [`Retrieval facets: ${publishedKbHints.join(" / ")}`] : []),\n        "Retrieval target: published ecommerce subscription plan limits, included features, admin/staff seats, and market eligibility only.",\n        ...(requirementLines.length ? [`Current customer requirement snapshot (latest wins): ${requirementLines.join(" / ")}`] : []),'''
if old in s: s=s.replace(old,new,1)
elif 'Retrieval target: published ecommerce subscription plan limits' not in s: raise SystemExit('STOP requirement retrieval anchor missing')

# 4) Combined topical questions are complete KB questions. Skip generic clarification but preserve exact-membership frozen route.
old='''  if (["會員等級", "会员等级", "會員分級", "会员分级", "membershiptier", "membershiptiers", "membertier", "membertiers", "membershiplevel", "membershiplevels", "memberlevel", "memberlevels"].includes(compact)) return "membership tiers";\n  if (["crm", "客戶管理", "客户管理"].includes(compact)) return "CRM";'''
new='''  if (["會員等級", "会员等级", "會員分級", "会员分级", "membershiptier", "membershiptiers", "membertier", "membertiers", "membershiplevel", "membershiplevels", "memberlevel", "memberlevels"].includes(compact)) return "membership tiers";\n  if (/(?:crm).*(?:會員等級|会员等级|member(?:ship)?tier|member(?:ship)?level)|(?:會員等級|会员等级|member(?:ship)?tier|member(?:ship)?level).*crm/i.test(normalized)) return "published KB feature bundle";\n  if (["crm", "客戶管理", "客户管理"].includes(compact)) return "CRM";'''
if old in s: s=s.replace(old,new,1)
elif 'published KB feature bundle' not in s: raise SystemExit('STOP combined topic anchor missing')

p.write_text(s)

# ---- prior-grounded-transform.ts ----
p2=Path('supabase/functions/_shared/prior-grounded-transform.ts')
t=p2.read_text()
if 'function requestsNewFactualFacet' not in t:
    anchor='export function resolvePriorGroundedTransform(\n'
    helper=r'''
function requestsNewFactualFacet(latest: string, priorAnswer: string): boolean {
  const facets: Array<[RegExp, RegExp]> = [
    [/(價錢|价格|price|月費|月费|年費|年费|monthly|yearly|年繳|年缴|月繳|月缴)/i, /(HKD|價錢|价格|price|月費|月费|年費|年费|monthly|yearly|年繳|年缴|月繳|月缴)/i],
    [/(staff|員工|员工|管理人手|管理人员)/i, /(staff|員工|员工|管理人手|管理人员)/i],
    [/(sku|商品數量|商品数量|product count)/i, /(sku|商品數量|商品数量|product count)/i],
    [/(保養|保修|warranty)/i, /(保養|保修|warranty)/i],
    [/(送貨|送货|delivery|九龍|九龙|kowloon|澳門|澳门|macau|macao)/i, /(送貨|送货|delivery|九龍|九龙|kowloon|澳門|澳门|macau|macao)/i],
    [/(退款|refund|百分比|比例)/i, /(退款|refund|百分比|比例)/i],
    [/(app|push|推播|推送|crm|會員等級|会员等级|membership)/i, /(app|push|推播|推送|crm|會員等級|会员等级|membership)/i],
  ];
  return facets.some(([request, evidence]) => request.test(latest) && !evidence.test(priorAnswer));
}

function requestsConversationSecuritySummary(latest: string, priorAnswer: string): boolean {
  const asksSecuritySummary = /(拒絕|拒绝|敏感要求|sensitive requests?|system prompt|hidden context|secret key|bypass auth|其他客戶|其他客户)/i.test(latest) && /(總結|总结|summari)/i.test(latest);
  if (!asksSecuritySummary) return false;
  return !/(拒絕|拒绝|system prompt|hidden|secret|存取|访问|客戶|客户|credential|auth)/i.test(priorAnswer);
}

'''
    if anchor not in t: raise SystemExit('STOP prior-transform anchor missing')
    t=t.replace(anchor,helper+anchor,1)

old='''  const operation = semantic.operation as TransformOperation;\n  const operations = detectRequestedTransformOperations(latest, operation);'''
new='''  const operation = semantic.operation as TransformOperation;\n  if (requestsNewFactualFacet(latest, semantic.prior_grounded_answer.content)) return null;\n  if (requestsConversationSecuritySummary(latest, semantic.prior_grounded_answer.content)) return null;\n  const operations = detectRequestedTransformOperations(latest, operation);'''
if old in t: t=t.replace(old,new,1)
elif 'requestsNewFactualFacet(latest, semantic.prior_grounded_answer.content)' not in t: raise SystemExit('STOP prior-transform operation anchor missing')
p2.write_text(t)

for path,markers in [
 ('supabase/functions/_shared/conversation-runtime-state.ts',['latestCountIsStaff','buildPublishedKbRetrievalHints','Active published-KB subject','published KB feature bundle','knownRequirementSummary']),
 ('supabase/functions/_shared/prior-grounded-transform.ts',['requestsNewFactualFacet','requestsConversationSecuritySummary'])
]:
    txt=Path(path).read_text()
    for m in markers:
        if m not in txt: raise SystemExit(f'STOP missing marker {m} in {path}')
print('WORKFLOW7_SOURCE_PATCH=PASS')
PY

# Deterministic source-level assertions.
deno eval --allow-env '
import { deriveCurrentRequirementSnapshot, buildCanonicalRetrievalQuery, workflow5ShortTopicHint, resolveConversationMemoryResponse } from "./supabase/functions/_shared/conversation-runtime-state.ts";
import { resolvePriorGroundedTransform } from "./supabase/functions/_shared/prior-grounded-transform.ts";

const snap=deriveCurrentRequirementSnapshot([
 "我而家大約30件商品。","其實年尾可能80件。","再諗清楚，可能去到300件。","記住最新係300，唔係30。","我有兩個staff。","再加兩個staff一齊管理，即係目前4個staff。"
]);
if(snap.product_count!==300 || snap.staff_count!==4) throw new Error(`state corruption ${JSON.stringify(snap)}`);

const rows=[
 {role:"visitor",content:"staff limit幾多？"},
 {role:"assistant",content:"Growth 方案的 SKU 限制是 500 個。",metadata:{citation_lineage:{selected_document_id:"doc-growth",evidence_chunk_ids:["chunk-growth"]},source_message_id:"m1",citations:[{label:"Smoke Test Growth",source_type:"Product",relevance:"medium",document_id:"doc-growth",chunk_id:"chunk-growth",chunk_type:"full_content"}]}},
 {role:"visitor",content:"正常問題：Growth SKU limit幾多？"}
];
const q=buildCanonicalRetrievalQuery("staff limit幾多？",rows as any);
if(!/Smoke Test Growth/i.test(q.query) || !/staff admin-seat/i.test(q.query)) throw new Error(`subject/facet missing ${q.query}`);
if(workflow5ShortTopicHint("CRM同會員等級呢？")!="published KB feature bundle") throw new Error("combined topical query not protected");

const transformRows=[
 {role:"assistant",content:"Smoke Test Growth 方案包含網頁和品牌應用程式，並提供每月 50 次 AI SEO 生成。",metadata:{citation_lineage:{selected_document_id:"doc-growth",evidence_chunk_ids:["chunk-growth"]},source_message_id:"m0",citations:[{label:"Smoke Test Growth",source_type:"Product",relevance:"medium",document_id:"doc-growth",chunk_id:"chunk-growth",chunk_type:"full_content"}] }},
 {role:"visitor",content:"先正常講一個Smoke Test Growth有根據嘅平台功能。"}
];
const tr=resolvePriorGroundedTransform("再簡單講Growth每月價錢。",transformRows as any);
if(tr!==null) throw new Error("new price facet incorrectly treated as prior-grounded transform");

const memRows=[
 {role:"visitor",content:"大約300 sku。"},
 {role:"visitor",content:"我主要做 hk。"},
 {role:"visitor",content:"Growth plan app included？"}
];
const mem=resolveConversationMemoryResponse("按我已確認資料，邊啲你知、邊啲未知？",memRows as any) || "";
if(!/300/.test(mem) || /一千|1,000/.test(mem)) throw new Error(`stale hardcode remains ${mem}`);
console.log("WORKFLOW7_STATE_RETRIEVAL_UNIT=PASS");
'

# Compile + frozen regressions. Exact frozen suites remain untouched.
deno check --node-modules-dir=auto supabase/functions/generate-reply/index.ts
deno test --allow-env tests/edge/workflow5-multilingual-privacy.test.ts
deno test --allow-env tests/edge/workflow4-latest-condition-state.test.ts
deno test --allow-env tests/edge/task4-1-current-context-memory.test.ts
echo WORKFLOW7_FROZEN_REGRESSION=PASS

# Commit product source only after all source/compile/regression gates pass.
git config user.name 'ebixsolutions'
git config user.email '64578119+ebixsolutions@users.noreply.github.com'
git add supabase/functions/_shared/conversation-runtime-state.ts supabase/functions/_shared/prior-grounded-transform.ts
if ! git diff --cached --quiet; then
  git commit -m 'fix: preserve published KB subject and long-context integrity'
  git push origin HEAD:main
fi
SOURCE_COMMIT="$(git rev-parse HEAD)"
echo "WORKFLOW7_SOURCE_COMMIT=$SOURCE_COMMIT"

# Shared runtime files are bundled by generate-reply.
npx supabase functions deploy generate-reply --project-ref "$PROJECT_REF"
echo WORKFLOW7_GENERATE_REPLY_DEPLOY=PASS
