#!/usr/bin/env python3
from __future__ import annotations
import argparse,datetime as dt,hashlib,json,os,subprocess,urllib.request,urllib.error
from pathlib import Path
CONTRACT='CE-T2-C20-EVIDENCE-CLOSURE-v1.0'; PKG='nexusai-3task-current-27'
CASE_IDS="""E-AUTH-01 E-AUTH-02 E-AUTH-03 E-AUTH-04 E-AUTH-05 E-HTTP-01 E-HTTP-02 E-HTTP-03 E-HTTP-04 E-HTTP-05 E-BODY-01 E-BODY-02 E-BODY-03 E-BODY-04 E-BODY-05 E-BODY-06 E-BODY-07 E-BODY-08 E-TENANT-01 E-TENANT-02 E-TENANT-03 E-TENANT-04 E-TENANT-05 E-TENANT-06 E-TENANT-07 E-GROUND-01 E-GROUND-02 E-GROUND-03 E-GROUND-04 E-GROUND-05 E-GROUND-06 E-GROUND-07 E-GROUND-08 E-LLM-01 E-LLM-02 E-LLM-03 E-LLM-04 E-LLM-05 E-LLM-06 E-LLM-07 E-LLM-08 E-LLM-09 E-LLM-10 E-RPC-01 E-RPC-02 E-RPC-03 E-RPC-04 E-RPC-05 E-RPC-06 E-RPC-07 E-RPC-08 E-RPC-09 E-RPC-10 E-RPC-11 E-RPC-12""".split()
EXPECTED={
'E-AUTH-01':(401, 'unauthorized'),
'E-AUTH-02':(401, 'unauthorized'),
'E-AUTH-03':(401, 'unauthorized'),
'E-AUTH-04':(401, 'unauthorized'),
'E-AUTH-05':(503, 'unavailable'),
'E-BODY-01':(400, 'invalid_request'),
'E-BODY-02':(400, 'invalid_request'),
'E-BODY-03':(400, 'invalid_request'),
'E-BODY-04':(400, 'invalid_request'),
'E-BODY-05':(400, 'invalid_request'),
'E-BODY-06':(400, 'invalid_request'),
'E-BODY-07':(400, 'invalid_request'),
'E-BODY-08':(413, 'payload_too_large'),
'E-GROUND-01':((502, 503), ('provider_failed', 'unavailable')),
'E-GROUND-02':(503, 'unavailable'),
'E-GROUND-03':(409, 'conflict'),
'E-GROUND-04':(503, 'unavailable'),
'E-GROUND-05':(403, 'forbidden'),
'E-GROUND-06':(400, 'invalid_request'),
'E-GROUND-07':(503, 'unavailable'),
'E-GROUND-08':(503, 'unavailable'),
'E-HTTP-01':(200, ''),
'E-HTTP-02':(403, ''),
'E-HTTP-03':(400, 'invalid_request'),
'E-HTTP-04':(503, 'unavailable'),
'E-HTTP-05':(403, 'forbidden'),
'E-LLM-01':(502, 'provider_failed'),
'E-LLM-02':(502, 'provider_failed'),
'E-LLM-03':(502, 'provider_failed'),
'E-LLM-04':(502, 'provider_failed'),
'E-LLM-05':(502, 'provider_failed'),
'E-LLM-06':(502, 'provider_failed'),
'E-LLM-07':(502, 'provider_failed'),
'E-LLM-08':(502, 'provider_failed'),
'E-LLM-09':(502, 'provider_failed'),
'E-LLM-10':(200, ''),
'E-RPC-01':(503, 'unavailable'),
'E-RPC-02':(409, 'conflict'),
'E-RPC-03':(409, 'conflict'),
'E-RPC-04':(502, 'provider_failed'),
'E-RPC-05':(502, 'provider_failed'),
'E-RPC-06':(409, 'conflict'),
'E-RPC-07':(409, 'conflict'),
'E-RPC-08':(200, ''),
'E-RPC-09':None,
'E-RPC-10':(409, 'conflict'),
'E-RPC-11':(409, 'conflict'),
'E-RPC-12':(409, 'conflict'),
'E-TENANT-01':(503, 'unavailable'),
'E-TENANT-02':(403, 'forbidden'),
'E-TENANT-03':(403, 'forbidden'),
'E-TENANT-04':(403, 'forbidden'),
'E-TENANT-05':(404, 'not_found'),
'E-TENANT-06':(403, 'forbidden'),
'E-TENANT-07':(400, 'invalid_request'),
}
assert set(EXPECTED)==set(CASE_IDS), f"EXPECTED coverage mismatch missing={set(CASE_IDS)-set(EXPECTED)} extra={set(EXPECTED)-set(CASE_IDS)}"
LEAK=('SQLSTATE','pg_catalog','SUPABASE_SERVICE','ANTHROPIC_API','sk-ant','stack trace','raw_llm','/home/','/var/')
def cmd(a):
 p=subprocess.run(a,text=True,capture_output=True)
 if p.returncode: raise RuntimeError(p.stderr[:500])
 return p.stdout
def sql(q): return cmd(['psql',os.environ['DATABASE_URL'],'-Atq','-v','ON_ERROR_STOP=1','-c',q])
def request(method,body,token=None,origin='https://console-chat-hub.lovable.app'):
 url=os.environ['SUPABASE_URL'].rstrip('/')+'/functions/v1/conversation-evaluate'; data=None if body is None else body.encode(); h={'apikey':os.environ['SUPABASE_ANON_KEY'],'Content-Type':'application/json'}
 if origin is not None: h['Origin']=origin
 if token: h['Authorization']='Bearer '+token
 req=urllib.request.Request(url,data=data,headers=h,method=method)
 try:
  with urllib.request.urlopen(req,timeout=20) as r:return r.status,r.read().decode('utf-8','replace')
 except urllib.error.HTTPError as e:return e.code,e.read().decode('utf-8','replace')
def setup(case):
 out=sql("select public.ce_test_prepare_case('%s')"%case)
 if not out.strip(): raise AssertionError('setup read-back empty')
def action(case):
 f=json.loads(sql("select public.ce_test_case_request('%s')::text"%case)); return request(f['method'],f.get('body'),f.get('token'),f.get('origin','https://console-chat-hub.lovable.app'))
def assert_case(case,status,raw):
 expected=EXPECTED[case]
 for s in LEAK:
  if s.lower() in raw.lower(): raise AssertionError('leak '+s)
 d=json.loads(raw or '{}') if raw else {}
 if expected is not None:
  es,ec=expected
  allowed_status=es if isinstance(es,tuple) else (es,)
  allowed_error=ec if isinstance(ec,tuple) else (ec,)
  if status not in allowed_status: raise AssertionError(f'status {status} not in {allowed_status}')
  if any(allowed_error) and d.get('error') not in allowed_error: raise AssertionError(f"error {d.get('error')} not in {allowed_error}")
 v=json.loads(sql("select public.ce_test_assert_case('%s')::text"%case))
 if v.get('pass') is not True: raise AssertionError(str(v))
def cleanup(case):
 sql("select public.ce_test_cleanup_case('%s')"%case)
 if int(sql("select public.ce_test_fixture_leaks('%s')"%case) or 0)!=0: raise AssertionError('cleanup leak')
def main():
 a=argparse.ArgumentParser(); a.add_argument('--result',required=True); o=a.parse_args(); passed=[]; failed=[]
 for c in CASE_IDS:
  try: setup(c); st,raw=action(c); assert_case(c,st,raw); passed.append(c)
  except Exception as e: failed.append({'case_id':c,'error':str(e)})
  finally:
   try: cleanup(c)
   except Exception as e: failed.append({'case_id':c,'error':'cleanup: '+str(e)})
 m=json.load(open('validation/execution-metadata.json')); files=['supabase/functions/conversation-evaluate/index.ts','supabase/functions/_shared/ce-contract.ts','supabase/functions/_shared/ce-grounding.ts','supabase/functions/_shared/llm-router.ts','tests/stubs/llm-stub-server.ts',__file__]; h={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files if Path(p).is_file()}
 r={'contract_id':CONTRACT,'package_version':PKG,'task_run_id':m['task_run_id'],'generated_at':dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),'environment':{'supabase_url':os.environ['SUPABASE_URL']},'command':'python3 tests/edge/ce-edge-contract-runtime.py --result '+o.result,'exit_code':0 if not failed else 1,'pass':len(passed),'fail':len(failed),'skip':0,'blocked':0,'declared_case_ids':CASE_IDS,'executed_case_ids':CASE_IDS,'asserted_case_ids':passed,'failures':failed,'tested_source_hashes':h,'status':'PASS' if not failed else 'FAIL'}
 json.dump(r,open(o.result,'w'),indent=2); print(f'Edge contract: PASS={len(passed)} FAIL={len(failed)}'); return 0 if not failed else 1
if __name__=='__main__': raise SystemExit(main())
