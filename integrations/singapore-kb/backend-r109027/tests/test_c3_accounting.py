"""Actual FastAPI + SQLAlchemy + native PostgreSQL + accepted RPC; mock providers only."""
import os,json,time,uuid,hashlib,concurrent.futures,threading,sys
from pathlib import Path
import pytest,psycopg,requests
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.main import app
from app.core.database import get_db
from app.core import c3_accounting as c3,llm
from app.core.shared_attempt_guard import SharedAttemptGuard,AccountingDenied,signed
from app.models import Base,Company,KBDocument,KBVectorChunk
URL=os.environ['C3_ACCOUNTING_TEST_DB_URL']; assert '127.0.0.1' in URL
RUN='a0a8c36e-42b5-4d9f-bbee-095ddc731520'; SECRET='local-mock-only'
engine=create_engine(os.environ['DATABASE_URL'])
Sessions=sessionmaker(bind=engine)

def sql(query,args=()):
 with psycopg.connect(URL,autocommit=True) as conn:
  return conn.execute(query,args).fetchall() if query.lower().startswith('select') else conn.execute(query,args)

def callback(self,body,headers):
 assert signed(self.raw_scope+'\n'+body,SECRET)==headers['x-c3-accounting-body-signature']
 data=json.loads(body);scope=json.loads(self.raw_scope)
 assert scope['company']==c3.COMPANY and scope['tenant']=='34' and scope['service']=='kb'
 with psycopg.connect(URL) as conn:
  conn.execute('set local role service_role')
  ident=scope['operation']+':'+data['identity']
  if data['action']=='reserve':
   result=conn.execute('select public.c3_reserve_model_attempt(%s,null,%s,%s,%s,%s,%s,%s)',(c3.COMPANY,ident,scope['operation'],'kb:'+data['provider'],'kb_downstream',data['request_sha256'],RUN)).fetchone()[0]
  else:
   result=conn.execute('select public.c3_finalize_model_attempt(%s,%s,%s,%s,%s)',(c3.COMPANY,RUN,ident,data['state'],data['http_status'])).fetchone()[0]
  conn.commit();return result

@pytest.fixture(autouse=True)
def isolated(monkeypatch):
 sql('delete from c3_model_accounting.attempt');sql("update c3_model_accounting.run set reserved=0,ceiling=3520,state='active' where id=%s",(RUN,))
 monkeypatch.setattr(SharedAttemptGuard,'_http',callback)
 monkeypatch.setattr(llm,'_vertex_access_token',lambda:'mock-token')
 monkeypatch.setattr(llm,'_report_vertex_usage',lambda *a:None)
 monkeypatch.setattr(llm.settings,'vertex_sa_json','mock-non-secret')
 monkeypatch.setattr(llm.settings,'require_production_embedding',True)
 monkeypatch.setattr(llm.time,'sleep',lambda _:None)
 yield

def headers(payload,**patch):
 raw=json.dumps(payload,separators=(',',':'),ensure_ascii=False)
 scope={'company':c3.COMPANY,'tenant':'34','operation':'kb:'+str(uuid.uuid4()),'expires':int(time.time())+60,'nonce':str(uuid.uuid4()),'service':'kb','request_sha256':hashlib.sha256(raw.encode()).hexdigest()}
 scope.update(patch);s=json.dumps(scope,separators=(',',':'))
 return raw,{'Content-Type':'application/json','X-API-Key':SECRET,'x-ai-company-id':c3.COMPANY,'x-c3-accounting-scope':s,'x-c3-accounting-signature':signed(s,SECRET),'x-c3-accounting-mode':'shared_atomic_attempts'}

def provider(url,**kw):
 # Verify committed reservation exists BEFORE actual mock provider dispatch.
 assert sql("select count(*) from c3_model_accounting.attempt where state='reserved'")[0][0]>0
 assert kw['allow_redirects'] is False
 r=requests.Response();r.status_code=200
 r._content=json.dumps({'predictions':[{'embeddings':{'values':[1.0]+[0.0]*767}}], 'choices':[{'message':{'content':'mock reply'}}], 'candidates':[{'content':{'parts':[{'text':'mock reply'}]}}]}).encode();return r

@pytest.fixture(scope='session',autouse=True)
def schema():
 Base.metadata.create_all(engine)
 with Sessions() as db:
  db.add(Company(id=34,api_key=SECRET));db.add(Company(id=35,api_key='other-local-key'))
  db.add(KBDocument(id='published',name='Current Policy',company_id=34,status='published',active_version_id='v2',available_to_live_console=True,production_vector_status='indexed',raw_content='Grounded policy'))
  for id,company,version in [('current',34,'v2'),('stale',34,'v1'),('foreign',35,'v2')]:
   db.add(KBVectorChunk(id=id,document_id='published',company_id=company,version_id=version,chunk_text='Grounded policy',chunk_type='full_content',chunk_index=0,embedding_status='completed',embedding_vector=[1.0]+[0.0]*767,status='active',environment='production'))
  db.commit()
 def dep():
  with Sessions() as db:yield db
 app.dependency_overrides[get_db]=dep
 yield
 app.dependency_overrides.clear()

PATH='/api/v1/rag/context-search'

def test_native_handshake_rag_citations_replay(monkeypatch):
 monkeypatch.setattr(requests,'post',provider)
 raw,h=headers({'query':'policy','company_id':34,'score_threshold':0.05})
 client=TestClient(app);r=client.get(PATH+'/model-accounting-contract',headers=h)
 assert r.status_code==200 and signed(r.text,SECRET)==r.headers['x-c3-accounting-signature']
 assert r.json()['runtime_sha256']==c3.runtime_hash() and r.json()['mode']=='shared_atomic_attempts'
 r=client.post(PATH,content=raw,headers=h)
 assert r.status_code==200 and r.json()['context_found'] and r.json()['citations']
 assert 'stale' not in r.text and 'foreign' not in r.text and 'current' in r.text
 assert sql('select reserved from c3_model_accounting.run where id=%s',(RUN,))[0][0]==1
 assert client.post(PATH,content=raw,headers=h).status_code==403

@pytest.mark.parametrize('patch',[{'company':'wrong'},{'tenant':'35'},{'expires':0},{'service':'coach_sync'},{'nonce':'bad'},{'operation':'bad'},{'request_sha256':'0'*64}])
def test_scope_denials(patch,monkeypatch):
 monkeypatch.setattr(requests,'post',lambda *a,**k:pytest.fail('unauthorized model'))
 raw,h=headers({'query':'policy'},**patch)
 assert TestClient(app).post(PATH,content=raw,headers=h).status_code==403
 assert sql('select reserved from c3_model_accounting.run where id=%s',(RUN,))[0][0]==0

@pytest.mark.parametrize('change',['signature','credential','missing','mode','body'])
def test_auth_integrity_denials(change,monkeypatch):
 monkeypatch.setattr(requests,'post',lambda *a,**k:pytest.fail('unauthorized model'))
 raw,h=headers({'query':'policy'})
 if change=='signature':h['x-c3-accounting-signature']='0'*64
 if change=='credential':h['X-API-Key']='wrong'
 if change=='missing':h.pop('x-c3-accounting-scope')
 if change=='mode':h['x-c3-accounting-mode']='retrieval_only'
 if change=='body':raw+=' '
 assert TestClient(app).post(PATH,content=raw,headers=h).status_code in [401,403]


def test_genuine_concurrent_fastapi_at_limit(monkeypatch):
 monkeypatch.setattr(requests,'post',provider)
 sql('update c3_model_accounting.run set ceiling=7 where id=%s',(RUN,))
 n=16;b=threading.Barrier(n)
 def call(i):
  raw,h=headers({'query':'policy'});b.wait(timeout=20)
  return TestClient(app).post(PATH,content=raw,headers=h).status_code
 with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:codes=list(pool.map(call,range(n)))
 assert codes.count(200)==7 and codes.count(403)==9
 assert sql('select reserved from c3_model_accounting.run where id=%s',(RUN,))[0][0]==7
 raw,h=headers({'query':'policy'});assert TestClient(app).post(PATH,content=raw,headers=h).status_code==403

@pytest.mark.parametrize('kind',['vertex','openai','deepseek','embedding'])
def test_all_adapters_sequential_distinct_attempts(kind,monkeypatch):
 monkeypatch.setattr(requests,'post',provider)
 raw,h=headers({'query':'policy'});scope=h['x-c3-accounting-scope']
 token=c3._current.set({'guard':SharedAttemptGuard(scope,h['x-c3-accounting-signature'],SECRET,c3.CALLBACK),'ordinal':0})
 try:
  for i in range(3):
   if kind=='embedding':llm.generate_embedding('policy')
   else:llm.invoke_llm('policy',provider=kind,model='mock')
 finally:c3._current.reset(token)
 assert sql('select count(distinct identity) from c3_model_accounting.attempt')[0][0]==3


def test_retry_timeout_unknown_no_refund(monkeypatch):
 calls=[]
 def fail_then(url,**kw):
  calls.append(url)
  if len(calls)==1:raise requests.Timeout('timeout')
  return provider(url,**kw)
 monkeypatch.setattr(requests,'post',fail_then)
 raw,h=headers({'query':'policy'});token=c3._current.set({'guard':SharedAttemptGuard(h['x-c3-accounting-scope'],h['x-c3-accounting-signature'],SECRET,c3.CALLBACK),'ordinal':0})
 try:assert llm.invoke_llm('policy',provider='openai',model='mock')=='mock reply'
 finally:c3._current.reset(token)
 assert len(calls)==2 and sql("select count(*) from c3_model_accounting.attempt where state='unknown'")[0][0]==1
 assert sql('select reserved from c3_model_accounting.run where id=%s',(RUN,))[0][0]==2


def test_callback_unavailable_no_fallback(monkeypatch):
 monkeypatch.setattr(SharedAttemptGuard,'_http',lambda *a: (_ for _ in ()).throw(OSError('offline')))
 monkeypatch.setattr(requests,'post',lambda *a,**k:pytest.fail('unmetered dispatch'))
 raw,h=headers({'query':'policy'});assert TestClient(app).post(PATH,content=raw,headers=h).status_code==403


def test_crash_reserved_and_finalize_outage(monkeypatch):
 raw,h=headers({'query':'policy'});g=SharedAttemptGuard(h['x-c3-accounting-scope'],h['x-c3-accounting-signature'],SECRET,c3.CALLBACK)
 with pytest.raises(SystemExit):g.invoke('mock','crash','request',lambda: (_ for _ in ()).throw(SystemExit()))
 assert sql("select count(*) from c3_model_accounting.attempt where state='unknown'")[0][0]==1
 with pytest.raises(AccountingDenied):g.invoke('mock','crash','request',lambda:pytest.fail('replay'))
 original=g.transport
 def outage(body,headers):
  if json.loads(body)['action']=='finalize':raise OSError('finalize offline')
  return original(body,headers)
 g.transport=outage
 with pytest.raises(AccountingDenied):g.invoke('mock','outage','request',lambda: object())
 assert sql("select count(*) from c3_model_accounting.attempt where state='reserved'")[0][0]==1


def test_actual_router_fallback_and_denial(monkeypatch):
 from app.models import PlatformLLMProviderConfig
 with Sessions() as db:
  db.add(PlatformLLMProviderConfig(id='mock-first',provider_name='mock vertex',provider_type='vertex',is_active=True,fast_model='mock'))
  db.add(PlatformLLMProviderConfig(id='mock-next',provider_name='mock openai',provider_type='openai',is_active=True,fast_model='mock'))
  db.commit()
 calls=[]
 def dispatch(url,**kw):
  calls.append(url)
  if ':generateContent' in url:raise RuntimeError('provider unavailable')
  return provider(url,**kw)
 monkeypatch.setattr(requests,'post',dispatch)
 raw,h=headers({'query':'policy'});token=c3._current.set({'guard':SharedAttemptGuard(h['x-c3-accounting-scope'],h['x-c3-accounting-signature'],SECRET,c3.CALLBACK),'ordinal':0})
 try:
  with Sessions() as db:assert llm.invoke_llm('policy',db=db)=='mock reply'
 finally:c3._current.reset(token)
 assert len(calls)==2 and sql('select reserved from c3_model_accounting.run where id=%s',(RUN,))[0][0]==2
 sql('update c3_model_accounting.run set ceiling=2 where id=%s',(RUN,))
 token=c3._current.set({'guard':SharedAttemptGuard(h['x-c3-accounting-scope'],h['x-c3-accounting-signature'],SECRET,c3.CALLBACK),'ordinal':2})
 try:
  with Sessions() as db:
   with pytest.raises(AccountingDenied):llm.invoke_llm('policy',db=db)
 finally:c3._current.reset(token)
 assert len(calls)==2


def test_concurrent_identical_business_request(monkeypatch):
 monkeypatch.setattr(requests,'post',provider)
 raw,h=headers({'query':'policy'});n=12;b=threading.Barrier(n)
 def call(_):
  b.wait(timeout=20);return TestClient(app).post(PATH,content=raw,headers=h).status_code
 with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:codes=list(pool.map(call,range(n)))
 assert codes.count(200)==1 and codes.count(403)==11
 assert sql('select reserved from c3_model_accounting.run where id=%s',(RUN,))[0][0]==1


def test_actual_provider_process_crash(monkeypatch):
 import subprocess
 raw,h=headers({'query':'policy'})
 code="""
import json,os,sys,requests
sys.path.insert(0,'tests')
from test_c3_accounting import callback
from app.core.shared_attempt_guard import SharedAttemptGuard
from app.core import c3_accounting as c3,llm
SharedAttemptGuard._http=callback
h=json.loads(sys.argv[1]);g=SharedAttemptGuard(h['x-c3-accounting-scope'],h['x-c3-accounting-signature'],'local-mock-only',c3.CALLBACK)
c3._current.set({'guard':g,'ordinal':0})
llm._vertex_access_token=lambda:'mock'
requests.post=lambda *a,**k:os._exit(23)
llm.generate_embedding('policy')
"""
 result=subprocess.run([sys.executable,'-c',code,json.dumps(h)],capture_output=True)
 assert result.returncode==23
 assert sql("select count(*) from c3_model_accounting.attempt where state='reserved'")[0][0]==1
 assert TestClient(app).post(PATH,content=raw,headers=h).status_code==403
