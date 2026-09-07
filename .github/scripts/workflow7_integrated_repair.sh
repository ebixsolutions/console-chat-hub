#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
from pathlib import Path

# Authoritative main already contains the generic retrieval subject/facet repair
# and long-context state integrity repair. Close the remaining transform boundary
# so a new factual facet can never be mistaken for a transform of stale evidence.
p=Path('supabase/functions/_shared/prior-grounded-transform.ts')
s=p.read_text()

anchor='export function resolvePriorGroundedTransform(\n'
if 'function requestsNewFactualFacet' not in s:
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
    if anchor not in s: raise SystemExit('STOP transform function anchor missing')
    s=s.replace(anchor,helper+anchor,1)

old='''  const operation = semantic.operation as TransformOperation;\n  const operations = detectRequestedTransformOperations(latest, operation);'''
new='''  const operation = semantic.operation as TransformOperation;\n  if (requestsNewFactualFacet(latest, semantic.prior_grounded_answer.content)) return null;\n  if (requestsConversationSecuritySummary(latest, semantic.prior_grounded_answer.content)) return null;\n  const operations = detectRequestedTransformOperations(latest, operation);'''
if old in s:
    s=s.replace(old,new,1)
elif 'requestsNewFactualFacet(latest, semantic.prior_grounded_answer.content)' not in s:
    raise SystemExit('STOP transform operation anchor missing')

p.write_text(s)
for marker in ['requestsNewFactualFacet','requestsConversationSecuritySummary','requestsNewFactualFacet(latest, semantic.prior_grounded_answer.content)']:
    if marker not in p.read_text(): raise SystemExit('STOP missing '+marker)
print('INTEGRATED_REPAIR_SOURCE_PATCH=PASS')
PY

# Machine assertions against authoritative source.
deno eval --allow-env '
import { deriveCurrentRequirementSnapshot, buildCanonicalRetrievalQuery, workflow5ShortTopicHint, resolveConversationMemoryResponse } from "./supabase/functions/_shared/conversation-runtime-state.ts";
import { resolvePriorGroundedTransform } from "./supabase/functions/_shared/prior-grounded-transform.ts";

const snap=deriveCurrentRequirementSnapshot([
 "我而家大約30件商品。","其實年尾可能80件。","再諗清楚，可能去到300件。","記住最新係300，唔係30。","我有兩個staff。","再加兩個staff一齊管理，即係目前4個staff。"
]);
if(snap.product_count!==300 || snap.staff_count!==4) throw new Error(`STATE_INTEGRITY ${JSON.stringify(snap)}`);

const q=buildCanonicalRetrievalQuery("staff limit幾多？",[
 {role:"visitor",content:"staff limit幾多？"},
 {role:"assistant",content:"Growth 方案的 SKU 限制是 500 個。"},
 {role:"visitor",content:"正常問題：Growth SKU limit幾多？"}
] as any);
if(!/Growth/i.test(q.query) || !/staff/i.test(q.query) || q.mode!=="contextual") throw new Error(`FOLLOWUP_SUBJECT ${q.query}`);

const q2=buildCanonicalRetrievalQuery("係 yearly 定 monthly ga？",[
 {role:"visitor",content:"係 yearly 定 monthly ga？"},
 {role:"assistant",content:"Smoke Test Growth plan 每月 HKD 788，每年 HKD 7,880。"},
 {role:"visitor",content:"hi 想問 Smoke Test Growth plan 點計？"}
] as any);
if(!/Growth/i.test(q2.query) || !/billing cadence|price|monthly|yearly/i.test(q2.query)) throw new Error(`FOLLOWUP_PRICE ${q2.query}`);

if(workflow5ShortTopicHint("CRM同會員等級呢？")!="CRM and membership tiers") throw new Error("COMBINED_TOPIC_NOT_COMPLETE");

const grounded=[
 {role:"assistant",content:"Smoke Test Growth 方案包含網頁和品牌應用程式，並提供每月 50 次 AI SEO 生成。",metadata:{citation_lineage:{selected_document_id:"doc-growth",evidence_chunk_ids:["chunk-growth"]},source_message_id:"m0",citations:[{label:"Smoke Test Growth",source_type:"Product",relevance:"medium",document_id:"doc-growth",chunk_id:"chunk-growth",chunk_type:"full_content"}]}},
 {role:"visitor",content:"先正常講一個Smoke Test Growth有根據嘅平台功能。"}
];
if(resolvePriorGroundedTransform("再簡單講Growth每月價錢。",grounded as any)!==null) throw new Error("NEW_FACTUAL_FACET_STALE_TRANSFORM");

const mem=resolveConversationMemoryResponse("請列出「最新」需求，唔好列舊條件。",[
 {role:"visitor",content:"再加兩個staff一齊管理，即係目前4個staff。"},
 {role:"visitor",content:"會員等級都會用。"},
 {role:"visitor",content:"亦想用CRM。"},
 {role:"visitor",content:"我想要Push。"},
 {role:"visitor",content:"App而家又有興趣。"},
 {role:"visitor",content:"但目前主要市場仍然香港。"},
 {role:"visitor",content:"之後可能做台灣。"},
 {role:"visitor",content:"記住最新係300，唔係30。"},
 {role:"visitor",content:"再諗清楚，可能去到300件。"}
] as any) || "";
if(!/300/.test(mem) || !/4 位 staff|4.*staff/i.test(mem) || /商品數量：約 4 件/.test(mem)) throw new Error(`MEMORY_STATE ${mem}`);
console.log("INTEGRATED_REPAIR_MACHINE_ASSERTIONS=PASS");
'

# Compile + frozen regression. No source write/deploy before these are green.
deno check --node-modules-dir=auto supabase/functions/generate-reply/index.ts
deno test --allow-env tests/edge/workflow5-multilingual-privacy.test.ts
deno test --allow-env tests/edge/workflow4-latest-condition-state.test.ts
deno test --allow-env tests/edge/task4-1-current-context-memory.test.ts
echo INTEGRATED_REPAIR_REGRESSION=PASS

# Commit exact changed product source only.
git config user.name 'ebixsolutions'
git config user.email '64578119+ebixsolutions@users.noreply.github.com'
git add supabase/functions/_shared/prior-grounded-transform.ts
if ! git diff --cached --quiet; then
  git commit -m 'fix: close follow-up factual transform boundary'
  git push origin HEAD:main
fi
echo "INTEGRATED_REPAIR_SOURCE_COMMIT=$(git rev-parse HEAD)"

# Deploy only the function that imports the changed shared runtime.
npx supabase functions deploy generate-reply --project-ref "$PROJECT_REF"
echo INTEGRATED_REPAIR_DEPLOY=PASS

# Fresh production smoke focused on all three repaired dimensions.
cat >/tmp/integrated_repair_prod.py <<'PY2'
import json,time,uuid,re,urllib.request,urllib.error,os
BASE=os.environ['BASE']; ORIGIN=os.environ['PROD_ORIGIN']; CH=os.environ['CHANNEL_ID']
turns=[
 'hi 想問 Smoke Test Growth plan 點計？',
 '係 yearly 定 monthly ga？',
 '直接講已發布價錢。',
 'Growth SKU limit係幾多？',
 'staff limit呢？',
 'CRM同會員等級呢？',
 '再簡單講Growth每月價錢。',
 '我而家大約30件商品。',
 '再諗清楚，可能去到300件。',
 '記住最新係300，唔係30。',
 '我有兩個staff。',
 '再加兩個staff一齊管理，即係目前4個staff。',
 '請列出「最新」需求，唔好列舊條件。',
 '基於最新需求，Growth係咪至少喺SKU/staff/App/Push/CRM/會員等級呢幾項符合？'
]
fail=[]
def call(path,body):
 req=urllib.request.Request(BASE+path,data=json.dumps(body,ensure_ascii=False).encode(),method='POST',headers={'Origin':ORIGIN,'Content-Type':'application/json','User-Agent':'ebixpro-integrated-repair/1.0','idempotency-key':str(uuid.uuid4())})
 try:
  with urllib.request.urlopen(req,timeout=45) as r:
   raw=r.read().decode(); return r.status,json.loads(raw) if raw else {}
 except urllib.error.HTTPError as e:
  raw=e.read().decode('utf-8','replace')
  try:p=json.loads(raw)
  except:p={'raw':raw[:800]}
  return e.code,p
def ck(c,code,detail=None):
 if not c: fail.append({'code':code,'detail':detail})
def generic(s): return bool(re.search(r'再補充.*細節|再补充.*细节|share a bit more detail|產品、服務或具體情況|产品、服务或具体情况',s or '',re.I))
st,p=call('/create-visitor-session',{'channel_id':CH,'visitor_metadata':{'production_stress_smoke':True,'case_id':'integrated-repair-published-kb-context-state','exclude_training':True,'started_by':'director','fresh_post_deploy':True}})
ck(st==200 and p.get('success') is True,'CREATE',p)
if st!=200 or p.get('success') is not True:
 print(json.dumps({'verdict':'FAIL','failures':fail},ensure_ascii=False)); raise SystemExit(1)
conv=p['data']['conversation_id']; token=p['data']['session_token']; out={}; routes={}
def poll():
 s,x=call('/widget-poll-messages',{'conversation_id':conv,'session_token':token})
 if s!=200 or x.get('success') is not True: raise RuntimeError((s,x))
 return x['data']
for i,text in enumerate(turns,1):
 before=len([m for m in poll().get('messages',[]) if m.get('role')=='assistant' and m.get('content')!='__THINKING__'])
 s,x=call('/receive-widget-message',{'conversation_id':conv,'session_token':token,'content':text})
 ck(s<300 and x.get('success') is True,f'SEND_T{i}',{'http':s,'body':x})
 got=None; d=None
 for _ in range(35):
  time.sleep(2); d=poll(); aa=[m for m in d.get('messages',[]) if m.get('role')=='assistant' and m.get('content')!='__THINKING__']
  if d.get('conversation_status')=='pending': break
  if len(aa)>before: got=aa[-1]; break
 ck(d is not None and d.get('conversation_status')!='pending',f'HANDOFF_T{i}',None if d is None else d.get('conversation_status'))
 ck(got is not None,f'NO_REPLY_T{i}')
 if got:
  out[i]=str(got.get('content') or ''); routes[i]=(got.get('metadata') or {}).get('response_route')
  print(json.dumps({'turn':i,'route':routes[i],'output':out[i]},ensure_ascii=False),flush=True)
 if d is not None and d.get('conversation_status')=='pending': break

# Published-KB/follow-up assertions
for t in [2,3,4,5,6,7,14]:
 if t in out: ck(not generic(out[t]),f'GENERIC_T{t}',out[t])
ck(2 in out and bool(re.search(r'788|7,?880|monthly|yearly|每月|每年|月|年',out[2],re.I)),'T2_BILLING',out.get(2))
ck(3 in out and bool(re.search(r'788|7,?880|HKD|價|价',out[3],re.I)),'T3_PRICE',out.get(3))
ck(4 in out and re.search(r'500',out[4]),'T4_SKU',out.get(4))
ck(5 in out and re.search(r'5',out[5]),'T5_STAFF',out.get(5))
ck(6 in out and bool(re.search(r'CRM|會員|会员|member',out[6],re.I)),'T6_FEATURES',out.get(6))
ck(7 in out and bool(re.search(r'788|HKD|每月|monthly',out[7],re.I)),'T7_PRICE_FACET',out.get(7))
ck(7 in out and not re.search(r'50\s*次.*AI SEO|品牌應用程式|品牌应用程序',out[7],re.I),'T7_STALE_TRANSFORM',out.get(7))
# Long-context state assertions
ck(13 in out and re.search(r'300',out[13]),'T13_PRODUCT_300',out.get(13))
ck(13 in out and re.search(r'4\s*位\s*staff|4\s*staff',out[13],re.I),'T13_STAFF_4',out.get(13))
ck(13 in out and not re.search(r'商品數量[:：]?\s*約?\s*4\s*件|商品数量[:：]?\s*约?\s*4\s*件',out[13]),'T13_NO_PRODUCT_4',out.get(13))
ck(14 in out and bool(re.search(r'Growth|SKU|staff|App|Push|CRM|會員|会员',out[14],re.I)),'T14_REQUIREMENT_MATCH',out.get(14))

d=poll(); ck(d.get('conversation_status')=='open','STATUS',d.get('conversation_status')); ck(d.get('assigned_agent_id') is None,'ASSIGNED',d.get('assigned_agent_id'))
print('INTEGRATED_REPAIR_PRODUCTION='+json.dumps({'verdict':'PASS' if not fail else 'FAIL','conversation_id':conv,'failures':fail,'routes':routes,'outputs':out},ensure_ascii=False),flush=True)
if fail: raise SystemExit(1)
PY2
python /tmp/integrated_repair_prod.py
echo INTEGRATED_REPAIR_PRODUCTION=PASS
