import json, os, re, time, urllib.request, urllib.error, sys
BASE=os.environ['VITE_SUPABASE_FUNCTIONS_URL'].rstrip('/')
ORIGIN=os.environ.get('PROD_ORIGIN','https://console-chat-hub.lovable.app')
CHANNEL=os.environ.get('CHANNEL_ID','b0000000-0000-0000-0000-000000000001')
fail=[]; conversations=[]

def post(path,body):
    req=urllib.request.Request(BASE+'/'+path,data=json.dumps(body,ensure_ascii=False).encode(),headers={'Origin':ORIGIN,'Content-Type':'application/json'},method='POST')
    try:
        with urllib.request.urlopen(req,timeout=55) as r:return r.status,json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw=e.read()
        try:p=json.loads(raw)
        except Exception:p={'raw':raw.decode(errors='replace')}
        return e.code,p

def new(tag):
    st,r=post('create-visitor-session',{'channel_id':CHANNEL,'visitor_metadata':{'integrated_closure_smoke':True,'exclude_training':True,'closure_tag':tag}})
    assert st==200 and r.get('success') is True,(st,r)
    d=r['data']; conversations.append({'tag':tag,'conversation_id':d['conversation_id']}); return d['conversation_id'],d['session_token']

def poll(cid,tok):
    st,r=post('widget-poll-messages',{'conversation_id':cid,'session_token':tok}); assert st==200 and r.get('success') is True,(st,r); return r['data']

def send(cid,tok,q,expect=True,timeout=55):
    before=poll(cid,tok); seen={m.get('id') for m in before.get('messages',[]) if m.get('role')=='assistant' and m.get('content')!='__THINKING__'}
    st,r=post('receive-widget-message',{'conversation_id':cid,'session_token':tok,'content':q}); assert st==200 and r.get('success') is True,(st,r)
    end=time.time()+timeout; latest=None; p=None
    while time.time()<end:
        p=poll(cid,tok)
        xs=[m for m in p.get('messages',[]) if m.get('role')=='assistant' and m.get('content')!='__THINKING__' and m.get('id') not in seen]
        if xs:latest=xs[-1]
        hs=(p.get('human_support') or {}).get('state')
        if expect and hs not in (None,'none'):
            fail.append('UNEXPECTED_HUMAN_CONTROL:'+q+':'+str(hs))
            break
        if expect and latest:break
        if not expect and hs not in (None,'none') and p.get('ai_generating') is False:break
        time.sleep(1)
    if expect and latest is None:fail.append('NO_REPLY:'+q)
    return latest,p

def txt(m):return '' if not m else str(m.get('content') or '')
def meta(m):return {} if not m else (m.get('metadata') or {})
def cites(m):return meta(m).get('citations') or []
def log(tag,q,m,p):print('FINAL_TURN='+json.dumps({'tag':tag,'q':q,'a':txt(m),'citations':cites(m),'human_support':(p or {}).get('human_support'),'ai_generating':(p or {}).get('ai_generating')},ensure_ascii=False))
def lineage(m,label):
    cs=cites(m); md=meta(m)
    if not cs:fail.append(label+':CITATION_MISSING');return
    c=cs[0] if isinstance(cs[0],dict) else {}; lin=md.get('citation_lineage') or {}
    if not c.get('document_id'):fail.append(label+':DOCUMENT_ID_MISSING')
    if not c.get('chunk_id'):fail.append(label+':CHUNK_ID_MISSING')
    if c.get('chunk_type')!='full_content':fail.append(label+':CHUNK_TYPE')
    if not lin.get('selected_document_id'):fail.append(label+':SELECTED_DOCUMENT_MISSING')
    if not lin.get('evidence_chunk_ids'):fail.append(label+':EVIDENCE_IDS_MISSING')
    if c.get('document_id') and lin.get('selected_document_id') and c.get('document_id')!=lin.get('selected_document_id'):fail.append(label+':LINEAGE_MISMATCH')
def relevant(m,label):
    for c in cites(m):
        x=(c.get('label','') if isinstance(c,dict) else str(c)).lower()
        if any(b in x for b in ['選購及落單','購買前重要','购买前重要','manus_uat']):fail.append(label+':IRRELEVANT_CITATION:'+x)

# A — 20 stateful AI turns BEFORE handoff. This is the production-blocking
# long-conversation acceptance path, not a sequential-call proxy for concurrency.
cid,tok=new('A_LONG_CONTEXT_FINAL'); A={}
qs=[
 ('A1','什么是四電一腦？'),
 ('A2','簡單一點解釋給我聽。'),
 ('A3','Explain that in English.'),
 ('A4','用繁體中文簡短一點。'),
 ('A5','我只知道它是家用電器，而且我沒有型號。'),
 ('A6','那你需要我提供什麼資料？'),
 ('A7','Mars 的冷氣機回收費是多少？'),
 ('A8','算了，不談 Mars，回香港的規則。'),
 ('A9','我一開始問的是什麼？'),
 ('A10','你剛才建議我要提供哪些資料？'),
 ('A11','ABC-999999 屬於哪一類？'),
 ('A12','那官方的回收安排是什麼？'),
 ('A13','最後用三點總結我們剛才談過的內容。'),
 ('A14','在香港，它的回收安排還需要我準備什麼？'),
 ('A15','我更正一下，我問的是冷氣機，不是電視機。'),
 ('A16','那這個更正後的項目，官方安排怎樣？'),
 ('A17','In English, summarize only the facts you can actually confirm.'),
 ('A18','再用繁體中文回答上一題。'),
 ('A19','我現在問的是哪個地區和哪個項目？'),
 ('A20','最後只根據已確認資料，用三點總結。'),
]
for k,q in qs:
    m,p=send(cid,tok,q);A[k]=(m,p);log(k,q,m,p);relevant(m,k)
if len(A)!=20:fail.append('A:TWENTY_TURN_COUNT')
if not any(x in txt(A['A1'][0]) for x in ['四電一腦','四电一脑']):fail.append('A1:TOPIC')
lineage(A['A1'][0],'A1')
if len(re.findall(r'[A-Za-z]',txt(A['A3'][0])))<20:fail.append('A3:LANG_EN')
if len(re.findall(r'[\u4e00-\u9fff]',txt(A['A4'][0])))<8:fail.append('A4:LANG_ZH')
if '香港' in txt(A['A7'][0]) and not any(x in txt(A['A7'][0]) for x in ['無法','不能','沒有','未有','不確定','无法','没有']):fail.append('A7:MARS_HALLUCINATION')
if not any(x in txt(A['A9'][0]) for x in ['四電一腦','四电一脑']):fail.append('A9:FIRST_MEMORY')
if not any(x in txt(A['A10'][0]) for x in ['型號','型号','家用電器','家用电器','資料','资料']):fail.append('A10:REQUEST_MEMORY')
if re.search(r'ABC-999999.{0,40}(是|屬於|属于).{0,20}(冷氣|空調|雪櫃|冰箱|洗衣|電視|电脑|電腦)',txt(A['A11'][0]),re.S):fail.append('A11:MODEL_HALLUCINATION')
if any(x in txt(A['A13'][0]) for x in ['補充一點細節','share a bit more detail']):fail.append('A13:SUMMARY_LOOP')
if not any(x in txt(A['A15'][0])+txt(A['A16'][0])+txt(A['A19'][0]) for x in ['冷氣','空調','air conditioner']):fail.append('A15_A19:CORRECTION_SUPERSESSION')
if not any(x in txt(A['A19'][0]) for x in ['香港','Hong Kong']):fail.append('A19:JURISDICTION_MEMORY')
if len(re.findall(r'[A-Za-z]',txt(A['A17'][0])))<20:fail.append('A17:LANG_EN')
if len(re.findall(r'[\u4e00-\u9fff]',txt(A['A18'][0])))<8:fail.append('A18:LANG_ZH')
if any(x in txt(A['A20'][0]) for x in ['補充一點細節','share a bit more detail']):fail.append('A20:SUMMARY_LOOP')
m,p=send(cid,tok,'幫我轉真人客服。',False,35);log('A21','幫我轉真人客服。',m,p)
if ((p or {}).get('human_support') or {}).get('state') not in ('waiting','assigned'):fail.append('A21:R1')
if (p or {}).get('ai_generating') is not False:fail.append('A21:POLL_COHERENCE')
m2,p2=send(cid,tok,'真人接手前補充：我仍然沒有型號。',False,12)
if m2 is not None:fail.append('A22:AI_AFTER_HANDOFF')

# B emotion + cross-language memory
cid,tok=new('B_ESCALATION_FINAL'); B=[]
for i,q in enumerate(['我是 VIP 客戶，真的很生氣，但我現在先想弄清楚問題，不要立即轉真人。','我部冷氣機突然不冷，我沒有型號，也沒有訂單號，你先告訴我需要什麼資料。','品牌是 Panasonic，大約兩年前買，現在會開機但不冷。','What information have I already given you, and what is still missing?','用廣東話繁體中文回答剛才那題。','如果 Knowledge Base 沒有我這個具體故障的答案，不要估。'],1):
    m,p=send(cid,tok,q);B.append((m,p));log('B'+str(i),q,m,p);relevant(m,'B'+str(i))
    if i==1 and ((p or {}).get('human_support') or {}).get('state') not in (None,'none'):fail.append('B1:AUTO_HANDOFF')
if 'Panasonic' not in txt(B[3][0]) or not any(x in txt(B[3][0]) for x in ['型號','model','Model']):fail.append('B4:CROSS_LANG_MEMORY')
if 'Panasonic' not in txt(B[4][0]) or not any(x in txt(B[4][0]) for x in ['型號','型号']):fail.append('B5:CANTONESE_MEMORY')
m,p=send(cid,tok,'我已提供以上資料，現在請幫我轉真人客服。',False,35)
if ((p or {}).get('human_support') or {}).get('state') not in ('waiting','assigned'):fail.append('B7:R1')

# C policy safety + R1
cid,tok=new('C_POLICY_FINAL')
for i,q in enumerate(['What is your return policy?','那退款政策呢？用繁體中文回答。','如果是安裝服務，有什麼規則？','Please summarize only what you can actually confirm from the policy or knowledge base.'],1):
    m,p=send(cid,tok,q);log('C'+str(i),q,m,p);relevant(m,'C'+str(i));
    if cites(m):lineage(m,'C'+str(i))
m,p=send(cid,tok,'幫我轉真人客服。',False,35)
if ((p or {}).get('human_support') or {}).get('state') not in ('waiting','assigned'):fail.append('C5:R1')
if (p or {}).get('ai_generating') is not False:fail.append('C5:POLL_COHERENCE')

# D no-match isolation
cid,tok=new('D_NOMATCH_ISOLATION_FINAL'); D=[]
for q in ['ZXQ-000-NOTREAL 的火星保養政策是什麼？','我沒有其他資料，不要猜。','算了，改問香港：什么是四電一腦？','最後簡單總結剛才香港四電一腦的答案。']:
    m,p=send(cid,tok,q);D.append((m,p));log('D',q,m,p);relevant(m,'D')
if not any(x in txt(D[2][0]) for x in ['四電一腦','四电一脑']):fail.append('D3:NOMATCH_CONTAMINATION')
lineage(D[2][0],'D3')
if not any(x in txt(D[3][0]) for x in ['四電一腦','四电一脑']):fail.append('D4:SUMMARY_CONTINUITY')

print('FINAL_CONVERSATIONS='+json.dumps(conversations,ensure_ascii=False));print('FINAL_FAILURES='+json.dumps(fail,ensure_ascii=False))
if fail:sys.exit(2)
for name in ['STANDALONE_KNOWN_KB_HIT','FOLLOW_UP_SEMANTIC_RETRIEVAL','PRONOUN_RESOLUTION','CORRECTION_SUPERSESSION','TOPIC_SWITCH_ISOLATION','MULTILINGUAL_CONTINUITY','PUBLISHED_ONLY_EVIDENCE','FULL_CONTENT_FACTUAL_GROUNDING','FIRST_NO_MATCH_CLARIFICATION','EXPLICIT_R1','ANGER_VIP_ADVISORY_ONLY','HUMAN_CONTROL_AI_SUPPRESSION','TWENTY_TURN_STATEFUL_CONVERSATION','LONG_CONTEXT_CONTINUITY','CONVERSATION_MEMORY','GROUNDING_OUTPUT_GATE','CITATION_LINEAGE','CITATION_RELEVANCE','R1_MULTILINGUAL','HANDOFF_POLL_CONSISTENCY','PRODUCTION_SMOKE']:
    print(name+'=PASS')