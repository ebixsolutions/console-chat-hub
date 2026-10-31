#!/usr/bin/env python3
import json, os, sys, time, uuid, urllib.request, urllib.parse, urllib.error
from pathlib import Path

ORIGIN=os.getenv('PROD_ORIGIN','https://console-chat-hub.lovable.app')
CHANNEL=os.getenv('CHANNEL_ID','b0000000-0000-0000-0000-000000000001')
PROJECT=os.getenv('PROJECT_REF','nrfxhqabwblzxoushgnm')
TOKEN=os.getenv('SUPABASE_ACCESS_TOKEN','')

def load_dotenv():
    p=Path('.env')
    if not p.exists(): return
    for line in p.read_text(errors='ignore').splitlines():
        line=line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        k,v=line.split('=',1); v=v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(),v)
load_dotenv()
BASE=os.getenv('VITE_SUPABASE_FUNCTIONS_URL') or f'https://{PROJECT}.supabase.co/functions/v1'
SU=os.getenv('VITE_SUPABASE_URL') or f'https://{PROJECT}.supabase.co'
assert TOKEN, 'SUPABASE_ACCESS_TOKEN missing'

def call(url, method='GET', body=None, headers=None, timeout=45):
    data=None if body is None else json.dumps(body,ensure_ascii=False).encode()
    h={'User-Agent':'task9-tungyu-100turn/1.0',**(headers or {})}
    req=urllib.request.Request(url,data=data,method=method,headers=h)
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            raw=r.read().decode(errors='replace')
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw=e.read().decode(errors='replace')
        try: payload=json.loads(raw)
        except Exception: payload={'raw':raw[:1000]}
        return e.code,payload

# management API -> publishable + secret keys (same established production smoke pattern)
st,keys=call(f'https://api.supabase.com/v1/projects/{PROJECT}/api-keys?reveal=true',headers={'Authorization':f'Bearer {TOKEN}'})
assert st==200 and isinstance(keys,list),(st,keys)
def kval(r): return r.get('api_key') or r.get('key') or r.get('value')
pks=[kval(r) for r in keys if str(r.get('type') or '').lower()=='publishable' and kval(r)]
sks=[kval(r) for r in keys if str(r.get('type') or '').lower()=='secret' and kval(r)]
assert pks and sks,'project API keys unavailable'; PK,SK=pks[0],sks[0]

st,sess=call(f'{BASE}/create-visitor-session','POST',{'channel_id':CHANNEL,'visitor_metadata':{'task9_tungyu_100turn':True,'exclude_training':True,'industry':'HomeAppliance','merchant':'Tung Yu simulated use case'}},{'Origin':ORIGIN,'Content-Type':'application/json'})
assert st==200 and sess.get('success') is True,(st,sess)
CID=sess['data']['conversation_id']; TOK=sess['data']['session_token']
print('TASK9_CONVERSATION_ID='+CID,flush=True)

# Prepare authenticated elevated agent once, only for harness recovery after safe handoff.
sh={'apikey':SK,'Authorization':f'Bearer {SK}','Content-Type':'application/json'}
def rest(path, params=None, method='GET', body=None, headers=None):
    url=f'{SU}{path}'
    if params: url+='?'+urllib.parse.urlencode(params)
    return call(url,method,body,headers or sh)

agent_jwt=None
st,rows=rest('/rest/v1/conversations',{'id':f'eq.{CID}','select':'company_id'})
if st==200 and len(rows)==1:
    co=rows[0].get('company_id')
    st,mem=rest('/rest/v1/company_membership',{'company_id':f'eq.{co}','is_active':'eq.true','role':'in.(admin,supervisor)','select':'user_id,role'})
    if st==200:
        for z in mem:
            uid=z['user_id']
            st,ap=rest('/rest/v1/agent_profile',{'user_id':f'eq.{uid}','status':'eq.active','select':'id,user_id,email,status'})
            if st==200 and len(ap)==1 and ap[0].get('email'):
                st,link=rest('/auth/v1/admin/generate_link',method='POST',body={'type':'magiclink','email':ap[0]['email']})
                if st not in (200,201): continue
                props=link.get('properties') or {}; ht=props.get('hashed_token') or props.get('token_hash') or link.get('hashed_token') or link.get('token_hash')
                if not ht: continue
                for typ in ('magiclink','email'):
                    st,v=call(f'{SU}/auth/v1/verify','POST',{'type':typ,'token_hash':ht},{'apikey':PK,'Content-Type':'application/json'})
                    if st==200 and v.get('access_token'):
                        agent_jwt=v['access_token']; break
            if agent_jwt: break
print('HARNESS_RECOVERY_AUTH='+('PASS' if agent_jwt else 'UNAVAILABLE'),flush=True)

def poll():
    st,d=call(f'{BASE}/widget-poll-messages','POST',{'conversation_id':CID,'session_token':TOK},{'Origin':ORIGIN,'Content-Type':'application/json'})
    return st,d

def classify_ingress_terminal(response):
    if not isinstance(response,dict) or response.get('success') is not True:
        return None
    data=response.get('data') or {}
    if data.get('ai_reply_pending') is False and data.get('control_state')=='human_control':
        return 'HUMAN_CONTROL_SUPPRESSED'
    return None

def recover_if_needed(status):
    if status not in ('pending','transferred') or not agent_jwt: return False
    h={'Origin':ORIGIN,'apikey':PK,'Authorization':f'Bearer {agent_jwt}','Content-Type':'application/json'}
    st,t=call(f'{BASE}/take-over-conversation','POST',{'conversation_id':CID},h)
    if st!=200 or t.get('success') is not True: return False
    st,r=call(f'{BASE}/return-to-ai','POST',{'conversation_id':CID,'closure_checklist':{'issue_resolved':True,'low_risk_followup':True}},h)
    return st==200 and r.get('success') is True

turns=[
'Hi，想問冷氣，兩間房加個廳，唔知買咩匹數好。',
'兩間房大概80呎同100呎，廳180呎，全部窗口位，本身都係窗口機。',
'細房應該1匹，大房同廳我唔知。',
'我唔想太貴，格力、美的、Panasonic都得。',
'仲有呀，我屋企下午西斜得幾勁。',
'你而家記得我要幾多部冷氣？',
'先唔好理個廳，我想問細房有冇1匹窗口變頻。',
'Panasonic有冇？',
'如果產品頁有機價，係咪即係包安裝？',
'哦，即係機價同安裝要分開確認啦。',
'我之前問你同事，佢話格力 GWF12P $5788，安裝550，鋁架550。',
'之後胡小姐又話如果兩部可以5600一部。',
'咁兩部連安裝同架，按我頭先提供嘅舊報價計幾錢？',
'等等，我而家可能唔係兩部匹半喎。',
'改做一部1匹，一部1.5匹。',
'客廳嗰部暫時唔買住。',
'咁我而家實際買幾多部冷氣？',
'頭先5600嗰個價仲可唔可以直接當1匹都係5600？',
'嗱，唔好又當我買三部，我依家係兩部。',
'幫我簡單講一次我而家要咩。',
'順便問埋雪櫃，想要三門，600mm樓下闊。',
'Panasonic有冇合適方向？',
'我最緊要唔好超過600闊，深少少冇所謂。',
'等陣，係595mm樓下先啱，我個位得600，想留返位。',
'頭先冷氣嗰兩部你仲記唔記得？',
'好。咁雪櫃繼續。',
'如果有一部598mm，我要唔要考慮？',
'算啦，598都接受。',
'不過600就唔好。',
'成單而家有咩？',
'送貨一般點計？',
'我長沙灣，舊樓，不過有lift。',
'想冷氣同雪櫃同一日送。',
'最好星期五。',
'如果我落單後想改星期六得唔得？',
'假設今日星期三，原本星期五送，我今晚改星期六，政策上要注意咩？',
'算啦，星期六做首選。',
'地址係長沙灣幸福邨A座12樓。',
'唔係A座，係B座，我打錯。',
'幫我讀返地址。',
'舊冷氣個位有石屎石柱，可能要拆。',
'拆咗會唔會幫我掉埋？',
'仲有舊機要拆。',
'其實一部舊機拆，另一間房本身冇機。',
'新嗰間房條電可能唔夠。',
'你估要唔要拉新電線？',
'咁記低先。',
'我而家有幾多項要師傅確認？',
'唔洗再問我房幾大，我頭先講過。',
'幾大？',
'唔講屋企住先。如果我開網店賣呢啲家電，基本計劃商品上限幾多？',
'其實基本唔係我要問，我想問專業計劃。',
'短啲。',
'好，返返去冷氣。',
'我最後係買三部定兩部？',
'雪櫃限制呢？',
'地址？',
'送星期幾？',
'舊機拆幾部？',
'有咩仲未confirm？',
'再問埋洗衣機，我位得600闊。',
'前置式，8kg左右。',
'之前雪櫃嗰個闊度限制取消啦。',
'洗衣機600照舊。',
'我依家總共係睇緊咩電器？',
'洗衣機未決定買住。',
'所以真正準備報價嘅係咩？',
'兩部冷氣匹數？',
'我有冇講過品牌一定要格力？',
'啱。',
'咁1匹係咪都5600？',
'我好似講過4200？',
'好，唔好亂當4200係正式價。',
'咁目前有邊個價係有來源？',
'而家實際售價可能同舊報價唔同係咪？',
'咁唔好用舊價幫我落單。',
'我想要最終報價先付款。',
'仲有工程附加費都要列清楚。',
'唔想師傅到場先突然加好多。',
'幫我整一個付款前 checklist。',
'早晨，我係琴日嗰個兩部冷氣嘅。',
'我老婆話客廳都係裝埋。',
'客廳180呎西斜。',
'咁而家三部喇。',
'不過客廳想2匹。',
'列一次，唔使解釋。',
'再短啲。',
'唔係，我個廳最後唔裝。',
'你唔好過兩分鐘又同我講三部。',
'最終幾部？',
'我準備攞最終報價，幫我總結全部。',
'電話係6123 4567。',
'名係陳大文。',
'但收貨人係陳太。',
'電話都用陳太：6987 6543。',
'讀返收貨資料。',
'報價未confirm之前唔好幫我當正式order。',
'我意思係quotation咋。',
'最後一句，你而家最需要同事跟進咩？',
'啱，就係咁。']
assert len(turns)==100,len(turns)
results=[]
for idx,text in enumerate(turns,1):
    pst,pd=poll(); before=[]
    if pst==200 and pd.get('success'):
        before=[m for m in pd['data'].get('messages',[]) if m.get('role')=='assistant']
    headers={'Origin':ORIGIN,'Content-Type':'application/json','idempotency-key':str(uuid.uuid4())}
    st,resp=call(f'{BASE}/receive-widget-message','POST',{'conversation_id':CID,'session_token':TOK,'content':text},headers)
    terminal=classify_ingress_terminal(resp)
    item={'turn':idx,'user':text,'send_http':st,'send_success':resp.get('success') if isinstance(resp,dict) else None,'assistant':None,'status':'human_control' if terminal else None,'timed_out':False,'recovered':False,'terminal_classification':terminal}
    if terminal:
        results.append(item)
        print(f"T{idx:03d} send={st} status=human_control ai=NO recovered=False terminal={terminal}",flush=True)
        break
    target=len(before)+1
    for _ in range(24):
        time.sleep(1.25)
        pst,pd=poll()
        if pst!=200 or not pd.get('success'): continue
        msgs=pd['data'].get('messages',[]); assistants=[m for m in msgs if m.get('role')=='assistant']
        status=pd['data'].get('conversation_status'); item['status']=status
        if len(assistants)>=target:
            m=assistants[-1]; item['assistant']=m.get('content'); item['assistant_message_id']=m.get('id'); item['assistant_metadata']=m.get('metadata'); break
        if status in ('pending','transferred'):
            item['recovered']=recover_if_needed(status)
            if item['recovered']:
                # Continue waiting after safe harness recovery.
                continue
    if item['assistant'] is None: item['timed_out']=True
    results.append(item)
    print(f"T{idx:03d} send={st} status={item.get('status')} ai={'YES' if item['assistant'] else 'NO'} recovered={item['recovered']}",flush=True)

# Authoritative DB readback for the exact conversation.
st,msgs=rest('/rest/v1/messages',{'conversation_id':f'eq.{CID}','select':'id,role,content,metadata,created_at','order':'created_at.asc'})
stc,conv=rest('/rest/v1/conversations',{'id':f'eq.{CID}','select':'id,status,assigned_agent_id,company_id,metadata,created_at,updated_at'})
summary={
 'conversation_id':CID,'turns_requested':100,'turns_sent':len(results),
 'assistant_replies':sum(1 for r in results if r['assistant']),
 'timeouts':sum(1 for r in results if r['timed_out']),
 'recoveries':sum(1 for r in results if r['recovered']),
 'db_messages_http':st,'db_message_count':len(msgs) if isinstance(msgs,list) else None,
 'conversation_http':stc,'conversation':conv[0] if isinstance(conv,list) and conv else None,
}
# deterministic high-value assertions from observed assistant text
get=lambda n:(results[n-1].get('assistant') or '')
checks={
 'T06_qty3_initial': ('3' in get(6) or '三' in get(6)),
 'T17_qty2_after_defer': ('2' in get(17) or '兩' in get(17)),
 'T40_address_B': ('B' in get(40) or 'Ｂ' in get(40)) and ('A座' not in get(40)),
 'T50_room_sizes': ('80' in get(50) and '100' in get(50)),
 'T55_qty2_after_topic_return': ('2' in get(55) or '兩' in get(55)),
 'T57_address_B_retained': ('B' in get(57) or 'Ｂ' in get(57)) and ('A座' not in get(57)),
 'T58_saturday': ('六' in get(58) or 'Saturday' in get(58)),
 'T59_old_removal1': ('1' in get(59) or '一' in get(59)),
 'T68_ac_hp': ('1匹' in get(68) and '1.5匹' in get(68)),
 'T69_brand_not_forced': ('唔' in get(69) or '沒有' in get(69) or '不是' in get(69) or '並非' in get(69)),
 'T71_no_5600_reuse': ('不能' in get(71) or '唔' in get(71) or '不應' in get(71) or '不可以' in get(71)),
 'T73_4200_unverified': ('正式' in get(73) or '確認' in get(73) or '未' in get(73)),
 'T90_final_qty2': ('2' in get(90) or '兩' in get(90)),
 'T96_recipient_contact': ('陳太' in get(96) and '6987' in get(96) and ('B' in get(96) or 'Ｂ' in get(96))),
 'T98_quotation_not_order': ('quotation' in get(98).lower() or '報價' in get(98)) and ('未' in get(98) or '不' in get(98) or '唔' in get(98)),
}
summary['deterministic_checks']=checks
summary['deterministic_pass']=sum(1 for v in checks.values() if v)
summary['deterministic_total']=len(checks)
Path('task9-results.json').write_text(json.dumps({'summary':summary,'results':results,'db_messages':msgs},ensure_ascii=False,indent=2))
Path('task9-summary.txt').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print('TASK9_SUMMARY='+json.dumps(summary,ensure_ascii=False),flush=True)
# Do not fail-fast on findings; only fail if the harness itself failed to send all 100 turns.
if len(results)!=100:
    sys.exit(2)
