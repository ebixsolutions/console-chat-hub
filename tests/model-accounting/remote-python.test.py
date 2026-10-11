import sys,json,time,unittest,importlib.util
from pathlib import Path
p=Path(__file__).resolve().parents[2]/'integrations/singapore-kb/shared_attempt_guard.py'
spec=importlib.util.spec_from_file_location('guard',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class TestRemote(unittest.TestCase):
 def setUp(self):
  self.secret='nonproduction-mock-existing-tenant-key';self.raw=json.dumps({'company':'4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec','tenant':'mock','operation':'kb:mock','expires':int(time.time())+60,'nonce':'nonce'},separators=(',',':'))
  self.sig=m.signed(self.raw,self.secret);self.entries={};self.calls=0
 def transport(self,raw,headers):
  self.assertEqual(headers['x-c3-accounting-body-signature'],m.signed(self.raw+'\n'+raw,self.secret));b=json.loads(raw);i=b['identity']
  if b['action']=='reserve':
   if i in self.entries:return {'scoped':True,'dispatch':False}
   if len(self.entries)>=2:raise m.AccountingDenied('cap')
   self.entries[i]='reserved';return {'scoped':True,'dispatch':True,'run_id':'a0a8c36e-42b5-4d9f-bbee-095ddc731520','state':'reserved'}
  self.entries[i]=b['state'];return {'state':b['state']}
 def guard(self,mode='shared_atomic_attempts',transport=None):
  return m.SharedAttemptGuard(self.raw,self.sig,self.secret,'https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1/model-attempt-accounting',mode,transport or self.transport)
 def model(self):self.calls+=1;return 'response'
 def test_retry_fallback_cap_replay(self):
  g=self.guard();g.invoke('embedding','embed:1','q',self.model)
  with self.assertRaises(m.AccountingDenied):g.invoke('embedding','embed:1','q',self.model)
  g.invoke('fallback','embed:2','q',self.model)
  with self.assertRaises(m.AccountingDenied):g.invoke('evaluation','eval:1','q',self.model)
  self.assertEqual(self.calls,2);self.assertEqual(len(self.entries),2)
 def test_unknown_no_release(self):
  def crash():raise TimeoutError()
  with self.assertRaises(TimeoutError):self.guard().invoke('embedding','1','q',crash)
  self.assertEqual(list(self.entries.values()),['unknown'])
 def test_retrieval_only_no_model_attempt(self):
  body,sig=m.contract(self.raw,self.sig,self.secret,'retrieval_only');self.assertTrue(m.signed(body,self.secret)==sig)
  with self.assertRaises(m.AccountingDenied):self.guard('retrieval_only').invoke('embedding','1','q',self.model)
  self.assertEqual(self.calls,0);self.assertEqual(len(self.entries),0)
 def test_unavailable_zero_dispatch(self):
  def unavailable(*a):raise OSError()
  with self.assertRaises(m.AccountingDenied):self.guard(transport=unavailable).invoke('embedding','1','q',self.model)
  self.assertEqual(self.calls,0)
 def test_tamper_denied(self):
  with self.assertRaises(m.AccountingDenied):m.validate_scope(self.raw+' ',self.sig,self.secret)
 def test_finalization_unavailable_blocks_chain(self):
  def fail_finish(raw,headers):
   if json.loads(raw)['action']=='finalize':raise OSError()
   return self.transport(raw,headers)
  with self.assertRaises(m.AccountingDenied):self.guard(transport=fail_finish).invoke('embedding','1','q',self.model)
  self.assertEqual(self.calls,1);self.assertEqual(list(self.entries.values()),['reserved'])
if __name__=='__main__':unittest.main()
