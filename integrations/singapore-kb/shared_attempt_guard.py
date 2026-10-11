"""Server-side protocol adapter; reuse the KB's existing tenant credential.
All model provider dispatches (including embeddings, retries, fallbacks and evaluation)
must call invoke() once per actual attempt, with a stable logical identity. Retrieval
HTTP handling itself never reserves a model attempt. No receipt means no dispatch.
This module does not claim the unavailable Singapore application has installed it.
"""
import hashlib,hmac,json,time,urllib.request,urllib.error
from pathlib import Path
PROTOCOL='c3-shared-attempt-v1'
class AccountingDenied(RuntimeError):pass

def signed(text,secret):return hmac.new(secret.encode(),text.encode(),hashlib.sha256).hexdigest()
def validate_scope(raw,signature,secret):
 if not hmac.compare_digest(signed(raw,secret),signature):raise AccountingDenied('signature')
 scope=json.loads(raw)
 if scope.get('company')!='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec' or not isinstance(scope.get('expires'),int) or not time.time()-1<scope['expires']<=time.time()+65:
  raise AccountingDenied('scope')
 return scope

def contract(raw,signature,secret,mode='shared_atomic_attempts'):
 scope=validate_scope(raw,signature,secret)
 if mode not in ('retrieval_only','shared_atomic_attempts'):raise AccountingDenied('mode')
 body=json.dumps({**scope,'protocol':PROTOCOL,'mode':mode,'runtime_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},separators=(',',':'))
 return body,signed(body,secret)

class SharedAttemptGuard:
 def __init__(self,raw_scope,signature,secret,callback_url,mode='shared_atomic_attempts',transport=None):
  self.scope=validate_scope(raw_scope,signature,secret);self.raw_scope=raw_scope;self.signature=signature
  self.secret=secret;self.mode=mode;self.url=callback_url;self.transport=transport or self._http
  if callback_url!='https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1/model-attempt-accounting':
   raise AccountingDenied('callback authority')
 def _http(self,body,headers):
  req=urllib.request.Request(self.url,body.encode(),headers,method='POST')
  try:
   with urllib.request.urlopen(req,timeout=10) as response:return json.load(response)
  except Exception as e:raise AccountingDenied('accounting unavailable') from e
 def _action(self,data):
  body=json.dumps(data,separators=(',',':'))
  headers={'Content-Type':'application/json','x-c3-accounting-scope':self.raw_scope,'x-c3-accounting-signature':self.signature,
   'x-c3-accounting-body-signature':signed(self.raw_scope+'\n'+body,self.secret)}
  try:return self.transport(body,headers)
  except Exception as e:raise AccountingDenied('accounting unavailable') from e
 def invoke(self,provider,identity,request,dispatch):
  if self.mode!='shared_atomic_attempts':raise AccountingDenied('retrieval-only forbids model invocation')
  key=hashlib.sha256(identity.encode()).hexdigest()
  receipt=self._action({'action':'reserve','identity':key,'provider':provider,'request_sha256':hashlib.sha256(request.encode()).hexdigest()})
  if receipt.get('scoped') is not True or receipt.get('dispatch') is not True or receipt.get('run_id')!='a0a8c36e-42b5-4d9f-bbee-095ddc731520' or receipt.get('state')!='reserved':
   raise AccountingDenied('reservation denied/replay')
  try:response=dispatch()
  except BaseException:
   # Conservatively retain this slot. A failed finalization cannot release or authorize a fallback.
   result=self._action({'action':'finalize','identity':key,'state':'unknown','http_status':0})
   if result.get('state')!='unknown':raise AccountingDenied('unknown finalization failed')
   raise
  status=getattr(response,'status',getattr(response,'status_code',200))
  result=self._action({'action':'finalize','identity':key,'state':'response','http_status':status})
  if result.get('state')!='response':raise AccountingDenied('finalization failed')
  return response
