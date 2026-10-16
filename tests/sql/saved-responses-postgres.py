#!/usr/bin/env python3
"""Local PostgreSQL only: original A10 persistence, real roles/RLS, CAS and pause rollback."""
import os, pathlib, subprocess, tempfile, socket, json, concurrent.futures, threading
from urllib.parse import urlparse
root=pathlib.Path(__file__).resolve().parents[2]
bin=pathlib.Path(os.environ.get('C3_PG_BIN','')); temp=pathlib.Path(tempfile.mkdtemp(prefix='c3-saved-pg-'))
external=os.environ.get('C3_SAVED_TEST_DB_URL')
if external:
 u=urlparse(external);assert u.hostname in ('127.0.0.1','localhost') and u.path=='/c3savedresponses'
if os.environ.get('C3_PG_PRELOAD'):os.environ['LD_PRELOAD']=os.environ['C3_PG_PRELOAD']
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
checks=[]
def run(args):return subprocess.run(args,capture_output=True,text=True)
def sql(text,ok=True):
 p=run([str(bin/'psql')]+([external] if external else ['-h','127.0.0.1','-p',str(port),'-U','postgres','-d','postgres'])+['-X','-qAt','-v','ON_ERROR_STOP=1','-c',text])
 if ok and p.returncode:raise AssertionError(p.stderr)
 return p
a='00000000-0000-4000-8000-000000000001';b='00000000-0000-4000-8000-000000000002';c='00000000-0000-4000-8000-000000000003';other='00000000-0000-4000-8000-000000000004';row='00000000-0000-4000-8000-000000000005'
def auth(q,user=a,ok=True):return sql(f"BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='{user}';"+q+'COMMIT;',ok)
def check(name,condition):assert condition,name;checks.append(name)
if not external:
 p=run([str(bin/'initdb'),'-D',str(temp/'db'),'-L',str(bin.parents[3]/'share/postgresql/16'),'-A','trust','-U','postgres','--no-locale']);assert p.returncode==0,p.stderr
 p=run([str(bin/'pg_ctl'),'-D',str(temp/'db'),'-l',str(temp/'server.log'),'-o',f"-F -h 127.0.0.1 -p {port} -c unix_socket_directories=''",'-w','start']);assert p.returncode==0,p.stderr
try:
 sql(f"DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;END IF;END$$;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;GRANT USAGE ON SCHEMA auth TO authenticated;CREATE TABLE company(id uuid PRIMARY KEY,is_active boolean);CREATE TABLE company_membership(user_id uuid,company_id uuid,role text,is_active boolean);GRANT SELECT ON company,company_membership TO authenticated;INSERT INTO auth.users VALUES('{a}'),('{b}');INSERT INTO company VALUES('{c}',true),('{other}',true);INSERT INTO company_membership VALUES('{a}','{c}','agent',true),('{b}','{other}','admin',true);")
 sql((root/'sql/c3_saved_responses.sql').read_text())
 auth(f"INSERT INTO saved_response(id,company_id,owner_id,title,content) VALUES('{row}','{c}','{a}','Greeting','Hello {{{{customer_name}}}}');")
 check('A10 agent creates and reads own tenant response',auth('SELECT count(*) FROM saved_response;').stdout.strip()=='1')
 check('A10 actual foreign authenticated user sees no rows',auth('SELECT count(*) FROM saved_response;',b).stdout.strip()=='0')
 check('A10 foreign owner INSERT rejected by real RLS',auth(f"INSERT INTO saved_response(company_id,owner_id,title,content) VALUES('{other}','{a}','bad','bad');",ok=False).returncode!=0)
 check('A10 owner reassignment forbidden',auth(f"UPDATE saved_response SET owner_id='{b}',revision=2 WHERE id='{row}';",ok=False).returncode!=0)
 check('A10 revision must increment exactly once',auth(f"UPDATE saved_response SET content='bad',revision=9 WHERE id='{row}';",ok=False).returncode!=0)
 gate=threading.Barrier(2)
 def compete(i):
  gate.wait();return auth(f"UPDATE saved_response SET content='edit{i}',revision=2 WHERE id='{row}' AND revision=1 RETURNING id;").stdout.strip()
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(compete,[1,2]))
 check('A10 two real DB connections CAS grants one stale-revision edit',sum(row in r for r in results)==1)
 check('A10 persisted latest revision readback',auth(f"SELECT revision FROM saved_response WHERE id='{row}';").stdout.strip()=='2')
 sql(f"UPDATE company_membership SET is_active=false WHERE user_id='{a}';")
 check('A10 inactive membership loses read access',auth('SELECT count(*) FROM saved_response;').stdout.strip()=='0')
 sql(f"UPDATE company_membership SET is_active=true WHERE user_id='{a}';INSERT INTO company_membership VALUES('{a}','{other}','agent',true);")
 check('A10 ambiguous multi-tenant user refused by RLS',auth('SELECT count(*) FROM saved_response;').stdout.strip()=='0')
 sql(f"DELETE FROM company_membership WHERE user_id='{a}' AND company_id='{other}';UPDATE company SET is_active=false WHERE id='{c}';")
 check('A10 inactive company loses read access',auth('SELECT count(*) FROM saved_response;').stdout.strip()=='0')
 sql(f"UPDATE company SET is_active=true WHERE id='{c}';")
 check('A10 anon cannot read saved content',sql('SET ROLE anon;SELECT * FROM saved_response;',False).returncode!=0)
 auth(f"DELETE FROM saved_response WHERE id='{row}' AND revision=1;")
 check('A10 stale delete keeps current response',auth('SELECT count(*) FROM saved_response;').stdout.strip()=='1')
 auth(f"DELETE FROM saved_response WHERE id='{row}' AND revision=2;")
 check('A10 exact revision delete persists',auth('SELECT count(*) FROM saved_response;').stdout.strip()=='0')
 auth(f"INSERT INTO saved_response(company_id,owner_id,title,content) VALUES('{c}','{a}','Retain','Retain on rollback');")
 sql((root/'sql/c3_saved_responses_rollback.sql').read_text())
 check('A10 rollback denies authenticated feature reads',auth('SELECT * FROM saved_response;',ok=False).returncode!=0)
 check('A10 rollback retains saved content and revision',sql('SELECT content,revision FROM saved_response;').stdout.strip()=='Retain on rollback|1')
 print(json.dumps({'scope':'LOCAL POSTGRESQL ONLY; no Hosted credit','postgres':sql('SHOW server_version;').stdout.strip(),'assertions':checks,'count':len(checks),'result':'PASS'}))
finally:
 if not external:run([str(bin/'pg_ctl'),'-D',str(temp/'db'),'-m','immediate','-w','stop'])
