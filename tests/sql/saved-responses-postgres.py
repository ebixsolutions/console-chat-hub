#!/usr/bin/env python3
"""Local PostgreSQL only: original A10 persistence, real roles/RLS, CAS and guarded schema restoration."""
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
def auth(q,user=a,ok=True):return sql(f"BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='{user}';SET LOCAL request.jwt.claim.role='authenticated';"+q+'COMMIT;',ok)
def check(name,condition):assert condition,name;checks.append(name)
installer=(root/'sql/c3_saved_responses.sql').read_text()
rollback=(root/'sql/c3_saved_responses_rollback.sql').read_text()
def install():
 sql(installer)
 return sql("SELECT obj_description('public.saved_response'::regclass,'pg_class');").stdout.strip()
def restore(receipt,ok=True,body=None):
 return sql("SELECT set_config('c3.saved_responses.expected_installation',"+"'"+receipt.replace("'","''")+"',false);"+(body or rollback),ok)
def absent():
 return sql("SELECT to_regclass('public.saved_response') IS NULL AND to_regclass('public.saved_response_owner_idx') IS NULL AND to_regclass('public.saved_response_pkey') IS NULL AND to_regprocedure('public.c3_saved_response_revision()') IS NULL AND to_regtype('public.saved_response') IS NULL AND to_regtype('public._saved_response') IS NULL;").stdout.strip()=='t'
def cleanup():
 # LOCAL fixture teardown only. Production rollback never uses CASCADE or deletes data.
 sql('DROP TABLE public.saved_response CASCADE;DROP FUNCTION public.c3_saved_response_revision();')
if not external:
 p=run([str(bin/'initdb'),'-D',str(temp/'db'),'-L',str(bin.parents[3]/'share/postgresql/16'),'-A','trust','-U','postgres','--no-locale']);assert p.returncode==0,p.stderr
 p=run([str(bin/'pg_ctl'),'-D',str(temp/'db'),'-l',str(temp/'server.log'),'-o',f"-F -h 127.0.0.1 -p {port} -c unix_socket_directories=''",'-w','start']);assert p.returncode==0,p.stderr
try:
 sql(f"DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;END IF;END$$;CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;GRANT USAGE ON SCHEMA auth TO authenticated;CREATE TABLE company(id uuid PRIMARY KEY,is_active boolean);CREATE TYPE app_role AS ENUM('admin','supervisor','agent','viewer');CREATE TABLE company_membership(user_id uuid,company_id uuid,role app_role,is_active boolean);GRANT SELECT ON company,company_membership TO authenticated;INSERT INTO auth.users VALUES('{a}'),('{b}');INSERT INTO company VALUES('{c}',true),('{other}',true);INSERT INTO company_membership VALUES('{a}','{c}','agent',true),('{b}','{other}','admin',true);")
 # Exact parent helper definitions from the Production read-only catalog, 2026-10-17.
 sql("""CREATE OR REPLACE FUNCTION public.is_company_member(p_company_id uuid, p_user_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  select ((session_user = 'postgres' and auth.uid() is null and auth.role() is null)
    or auth.role() = 'service_role' or p_user_id = auth.uid()) and exists (
    select 1 from public.company_membership cm where cm.company_id = p_company_id
      and cm.user_id = p_user_id and cm.is_active);
 $function$;
 CREATE OR REPLACE FUNCTION public.has_company_role(p_company_id uuid, p_user_id uuid, p_role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  select ((session_user = 'postgres' and auth.uid() is null and auth.role() is null)
    or auth.role() = 'service_role' or p_user_id = auth.uid()) and exists (
    select 1 from public.company_membership cm where cm.company_id = p_company_id
      and cm.user_id = p_user_id and cm.role = p_role and cm.is_active);
 $function$;
 ALTER TABLE company ENABLE ROW LEVEL SECURITY;ALTER TABLE company_membership ENABLE ROW LEVEL SECURITY;
 CREATE POLICY company_nw ON company TO authenticated USING(false) WITH CHECK(false);
 CREATE POLICY company_sel ON company FOR SELECT TO authenticated USING(is_company_member(id,auth.uid()));
 CREATE POLICY cm_nw ON company_membership TO authenticated USING(false) WITH CHECK(false);
 CREATE POLICY cm_sel ON company_membership FOR SELECT TO authenticated USING(user_id=auth.uid() OR has_company_role(company_id,auth.uid(),'admin'::app_role));""")
 parent_preimage=sql("SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM company c;SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY user_id,company_id)::text) FROM company_membership m;SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname)::text) FROM pg_policies p WHERE tablename IN ('company','company_membership');").stdout
 check('A10 actual authenticated role is non-superuser non-bypass RLS',sql("SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='authenticated';").stdout.strip()=='t')
 check('A10 both parent tables enforce their captured Production RLS policies',auth('SELECT count(*) FROM company;SELECT count(*) FROM company_membership;').stdout.strip()=='1\n1')
 # Fail part-way through the actual candidate DDL: no partial catalog survives.
 failed=sql(installer.replace('CREATE INDEX saved_response_owner_idx','SELECT 1/0;CREATE INDEX saved_response_owner_idx'),False)
 check('A10 installation failure rolls back table and dependencies atomically',failed.returncode!=0 and absent())
 receipt=install()
 auth(f"INSERT INTO saved_response(id,company_id,owner_id,title,content) VALUES('{row}','{c}','{a}','Greeting','Hello {{{{customer_name}}}}');")
 check('A10 agent creates and reads own tenant response',auth('SELECT count(*) FROM saved_response;').stdout.strip()=='1')
 check('A10 actual foreign authenticated user sees no rows',auth('SELECT count(*) FROM saved_response;',b).stdout.strip()=='0')
 check('A10 foreign owner INSERT rejected by real RLS',auth(f"INSERT INTO saved_response(company_id,owner_id,title,content) VALUES('{other}','{a}','bad','bad');",ok=False).returncode!=0)
 check('A10 owner reassignment forbidden',auth(f"UPDATE saved_response SET owner_id='{b}',revision=2 WHERE id='{row}';",ok=False).returncode!=0)
 check('A10 revision must increment exactly once',auth(f"UPDATE saved_response SET content='bad',revision=9 WHERE id='{row}';",ok=False).returncode!=0)
 # Same-tenant colleagues remain isolated by owner, even with a legal membership.
 sql(f"INSERT INTO company_membership VALUES('{b}','{c}','agent',true);DELETE FROM company_membership WHERE user_id='{b}' AND company_id='{other}';")
 check('A10 same tenant different owner cannot see saved response',auth('SELECT count(*) FROM saved_response;',b).stdout.strip()=='0')
 check('A10 same tenant different owner cannot update response',auth(f"UPDATE saved_response SET revision=2,content='bad' WHERE id='{row}' RETURNING id;",b).stdout.strip()=='')
 sql(f"DELETE FROM company_membership WHERE user_id='{b}';INSERT INTO company_membership VALUES('{b}','{other}','admin',true);")
 auth(f"INSERT INTO saved_response(company_id,owner_id,title,content) VALUES('{other}','{b}','Other tenant','Independent owner');",b)
 check('A10 qualifying second tenant has own CRUD, not C3-only',auth('SELECT content FROM saved_response;',b).stdout.strip()=='Independent owner')
 check('A10 second tenant response stays invisible to first owner',auth('SELECT count(*) FROM saved_response;').stdout.strip()=='1')
 auth('DELETE FROM saved_response;',b)
 sql(f"UPDATE company_membership SET role='viewer' WHERE user_id='{a}';")
 check('A10 non-staff membership cannot create saved response',auth(f"INSERT INTO saved_response(company_id,owner_id,title,content) VALUES('{c}','{a}','bad','bad');",ok=False).returncode!=0)
 sql(f"UPDATE company_membership SET role='agent' WHERE user_id='{a}';")
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
 paused=restore(receipt)
 check('A10 retained data is explicitly PARTIAL RESTORE', 'PARTIAL_RESTORE' in paused.stderr and 'EXACT_PREIMAGE' not in paused.stderr)
 check('A10 rollback denies authenticated feature reads',auth('SELECT * FROM saved_response;',ok=False).returncode!=0)
 check('A10 rollback retains saved content and revision',sql('SELECT content,revision FROM saved_response;').stdout.strip()=='Retain on rollback|1')
 # All following removals/reset operations are isolated fixture cleanup, never Production.
 cleanup()
 receipt=install()
 missing=sql(rollback,False)
 check('A10 missing original installation receipt refuses without mutation',missing.returncode!=0 and not absent())
 fault=restore(receipt,False,rollback.replace('DROP FUNCTION public.c3_saved_response_revision() RESTRICT;', 'SELECT 1/0;DROP FUNCTION public.c3_saved_response_revision() RESTRICT;'))
 check('A10 failure after table drop restores whole schema atomically',fault.returncode!=0 and sql("SELECT to_regprocedure('public.c3_saved_response_revision()') IS NOT NULL AND to_regclass('public.saved_response') IS NOT NULL;").stdout.strip()=='t')
 restored=restore(receipt)
 check('A10 empty unchanged original installation exactly restores absent schema',absent() and 'EXACT_PREIMAGE_RESTORED' in restored.stderr)
 old=receipt;receipt=install()
 refused=restore(old,False)
 check('A10 successor reinstall refuses original stale installation receipt',refused.returncode!=0 and not absent())
 restore(receipt)
 for label,drift in [
  ('column', 'ALTER TABLE saved_response ADD COLUMN successor text'),
  ('policy', 'DROP POLICY saved_response_owner_scope ON saved_response'),
  ('index', 'DROP INDEX saved_response_owner_idx'),
  ('function', "ALTER FUNCTION c3_saved_response_revision() RENAME TO c3_saved_response_revision_old"),
  ('owner', 'ALTER TABLE saved_response OWNER TO authenticated'),
  ('ACL', 'GRANT SELECT ON saved_response TO anon'),
  ('comment', "COMMENT ON TABLE saved_response IS 'successor'")
 ]:
  receipt=install();sql(drift)
  check('A10 '+label+' drift refuses destructive rollback',restore(receipt,False).returncode!=0 and not absent())
  sql('ALTER TABLE saved_response OWNER TO postgres;')
  if label=='function':sql('ALTER FUNCTION c3_saved_response_revision_old() RENAME TO c3_saved_response_revision;')
  cleanup()
 receipt=install();sql('CREATE VIEW successor_view AS SELECT * FROM saved_response;')
 check('A10 successor dependency prevents drop without CASCADE',restore(receipt,False).returncode!=0 and not absent())
 sql('DROP VIEW successor_view;');restore(receipt)
 receipt=install()
 # Catalog ABA: reverting the SQL definition still changed object ownership history.
 sql('GRANT SELECT ON saved_response TO anon;REVOKE SELECT ON saved_response FROM anon;')
 check('A10 reverted catalog changes still refuse exact rollback',restore(receipt,False).returncode!=0 and not absent())
 cleanup();receipt=install()
 # Writer owns the lock first. Rollback must wait, then see the committed row.
 writer_sql=f"BEGIN;INSERT INTO saved_response(company_id,owner_id,title,content) VALUES('{c}','{a}','Concurrent','Writer retained');"
 command=[str(bin/'psql')]+([external] if external else ['-h','127.0.0.1','-p',str(port),'-U','postgres','-d','postgres'])+['-X','-qAt','-v','ON_ERROR_STOP=1']
 writer=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 writer.stdin.write(writer_sql+"SELECT 'ready';\n");writer.stdin.flush()
 assert writer.stdout.readline().strip()=='ready'
 with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
  pending=pool.submit(restore,receipt)
  # Verify rollback is actually waiting on a PostgreSQL lock, not a timing assumption.
  import time
  waiting=False
  for attempt in range(100):
   if sql("SELECT EXISTS(SELECT FROM pg_locks WHERE relation='public.saved_response'::regclass AND NOT granted);").stdout.strip()=='t':waiting=True;break
   time.sleep(.01)
  check('A10 rollback waits for concurrent real writer lock',waiting)
  writer.stdin.write('COMMIT;\n');writer.stdin.close();writer.wait(timeout=10)
  concurrent_restore=pending.result(timeout=10)
 check('A10 concurrent committed writer retained with PARTIAL RESTORE', 'PARTIAL_RESTORE' in concurrent_restore.stderr and sql('SELECT content FROM saved_response;').stdout.strip()=='Writer retained')
 cleanup()
 parent_after=sql("SELECT md5(jsonb_agg(to_jsonb(c) ORDER BY id)::text) FROM company c;SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY user_id,company_id)::text) FROM company_membership m;SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname)::text) FROM pg_policies p WHERE tablename IN ('company','company_membership');").stdout
 check('A10 parent data and RLS policies preserved across install rollback and faults',parent_after==parent_preimage)
 print(json.dumps({'scope':'LOCAL POSTGRESQL ONLY; no Hosted credit','postgres':sql('SHOW server_version;').stdout.strip(),'assertions':checks,'count':len(checks),'result':'PASS'}))
finally:
 if not external:run([str(bin/'pg_ctl'),'-D',str(temp/'db'),'-m','immediate','-w','stop'])
