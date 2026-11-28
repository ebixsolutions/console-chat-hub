"""Real captured transactions/triggers; local PostgreSQL only. External net boundary is an inert counted sink."""
import json,os,pathlib,subprocess,urllib.parse,concurrent.futures,hashlib,time,tempfile,atexit
root=pathlib.Path.cwd();folder=root/'tests/ordinary-preview-safety';url=os.environ['C3_PREVIEW_TEST_DB_URL'];u=urllib.parse.urlparse(url)
assert u.hostname in ('localhost','127.0.0.1') and u.path=='/c3_preview_safety'
# Start native PostgreSQL in the SAME execution namespace as its real client connections.
pgroot=os.environ.get('C3_LOCAL_PG_ROOT')
if pgroot:
 pg=pathlib.Path(pgroot);data=tempfile.mkdtemp(prefix='c3-preview-native-cluster-');env=dict(os.environ,LD_PRELOAD=str(pg.parent/'root-identity-shim.so'),LD_LIBRARY_PATH=str(pg/'usr/lib/x86_64-linux-gnu'))
 bin=pg/'usr/lib/postgresql/16/bin';subprocess.run([str(bin/'initdb'),'-D',data,'-U','postgres','-A','trust'],env=env,check=True,stdout=subprocess.DEVNULL)
 log=open(data+'/server.log','w');server=subprocess.Popen([str(bin/'postgres'),'-D',data,'-p',str(u.port),'-h','127.0.0.1','-c',"unix_socket_directories="],env=env,stdout=log,stderr=log)
 atexit.register(lambda: (server.terminate(),server.wait(timeout=15),log.close()))
 maintenance=urllib.parse.urlunparse(u._replace(path='/postgres'))
 for i in range(50):
  if subprocess.run(['psql',maintenance,'-qAtc','select 1'],capture_output=True).returncode==0:break
  time.sleep(.1)
 subprocess.run(['createdb','-h',u.hostname,'-p',str(u.port),'-U','postgres','c3_preview_safety'],check=True)
checks=[];commands=[]
def sql(text,fail=False):
 r=subprocess.run(['psql',url,'-X','-qAt','-v','ON_ERROR_STOP=1'],input=text,text=True,capture_output=True,timeout=60);commands.append({'exit_code':r.returncode,'stderr':r.stderr,'stdout':r.stdout})
 assert (r.returncode!=0 if fail else r.returncode==0),r.stderr
 return r.stdout.strip()
def check(name,ok):assert ok,name;checks.append({'assertion':name,'result':'PASS'})
def literal(s):return "'"+str(s).replace("'","''")+"'"
allcols=[]
for f in ['live-columns.json','live-extra-columns.json']:allcols+=json.loads((folder/f).read_text())
allcols=list({(x['table_name'],x['column_name']):x for x in allcols}.values())
sql("DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon')THEN CREATE ROLE anon;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated')THEN CREATE ROLE authenticated;END IF;IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role')THEN CREATE ROLE service_role BYPASSRLS;END IF;END$$;CREATE SCHEMA auth;CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;")
for table in sorted(set(x['table_name']for x in allcols)):
 cols=[]
 for c in [x for x in allcols if x['table_name']==table]:
  typ=c['udt_name'];typ={'_text':'text[]','jsonb':'jsonb','int8':'bigint','int4':'integer','bool':'boolean','timestamptz':'timestamptz'}.get(typ,typ);typ=typ if typ in ['uuid','text','jsonb','bigint','integer','boolean','timestamptz','text[]','numeric','float8'] else 'text'
  default={'id':' DEFAULT gen_random_uuid()','created_at':' DEFAULT now()','updated_at':' DEFAULT now()','is_recalled':' DEFAULT false','metadata':" DEFAULT '{}'::jsonb"}.get(c['column_name'],'')
  if c['column_name']=='id':default+=' PRIMARY KEY'
  if c['column_name']=='conversation_id' and table in ['ce_evaluation_state','conversation_memory_state','conversation_commerce_state','c3_uat_conversation_scope']:default+=' PRIMARY KEY'
  cols.append('"'+c['column_name']+'" '+typ+default)
 sql('CREATE TABLE public.'+table+'('+','.join(cols)+');')
sql("CREATE UNIQUE INDEX ON public.visitor_session(session_token);CREATE UNIQUE INDEX ON public.ce_evaluation_job(job_key);CREATE UNIQUE INDEX ON public.messages(conversation_id,(metadata->>'client_message_id')) WHERE role='visitor' AND metadata ? 'client_message_id';GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;CREATE SCHEMA vault;CREATE TABLE vault.decrypted_secrets(id uuid,decrypted_secret text);CREATE SCHEMA net;CREATE TABLE public.dispatch_probe(kind text,conversation_id uuid);CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)RETURNS bigint LANGUAGE plpgsql AS $$BEGIN INSERT INTO public.dispatch_probe VALUES('CE_WORKER',null);RETURN 1;END$$;")
sql("CREATE TABLE public.ce_evaluation_methodology(status text,evaluation_fingerprint text);INSERT INTO public.ce_evaluation_methodology VALUES('current','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');CREATE UNIQUE INDEX ON public.human_support_queue(conversation_id);")
defs={}
for f in ['live-functions.json','live-dependencies.json','live-additional.json','live-extra-helpers.json','live-callees.json']:
 for r in json.loads((folder/f).read_text()):defs[r['signature']]=r['definition']
triggers=[]
for f in ['live-triggers.json','live-extra-triggers.json','live-queue-triggers.json']:
 for r in json.loads((folder/f).read_text()):
  if r['table_name']in ['messages','conversations','handoff_event','conversation_assignment']:triggers.append(r);defs[r.get('proname','trg_check_assignment_side')+'()']=r['function_definition']
# SQL functions need referenced functions installed first; PL/pgSQL preserves real captured bodies.
remaining=dict(defs)
for attempt in range(6):
 for sig,definition in list(remaining.items()):
  try:sql(definition+';');del remaining[sig]
  except AssertionError:pass
 if not remaining:break
assert not remaining,list(remaining)
for r in triggers:sql(r['definition']+';')
# Match captured privileges: original persistence functions are service-only, never public SQL backdoors.
for row in json.loads((folder/'live-acl.json').read_text()):
 sql('REVOKE ALL ON FUNCTION public.'+row['signature']+' FROM PUBLIC,anon,authenticated,service_role;'+('GRANT EXECUTE ON FUNCTION public.'+row['signature']+' TO service_role;'if 'service_role='in row['acl']else''))
# Install, reverse the unused migration, verify exact preimages, then install again.
sql((root/'sql/c3_ordinary_preview_safety.sql').read_text())
sql((root/'sql/c3_ordinary_preview_safety_rollback.sql').read_text())
for sig in ['c3_uat_learning_excluded(uuid)','ce_mark_evaluation_dirty(uuid,timestamp with time zone)','ce_dispatch_realtime_evaluation_v1(uuid)','receive_widget_message_tx(uuid,text,text,text)']:
 body=defs[sig].split('AS $function$')[1].split('$function$')[0]
 check('unused SQL rollback exact original body '+sig,sql("SELECT md5(prosrc)FROM pg_proc WHERE oid='public."+sig+"'::regprocedure")==hashlib.md5(body.encode()).hexdigest())
sql((root/'sql/c3_ordinary_preview_safety.sql').read_text())
# Native-only observational instrumentation: the real function body is retained.
sql('CREATE TABLE public.trigger_probe(kind text,conversation_id uuid);')
real=defs['ce_realtime_assistant_message_trigger_v1()'];observed=real.replace('\nbegin',"\nbegin INSERT INTO public.trigger_probe VALUES('CE_REALTIME',NEW.conversation_id);",1);sql(observed+';')
check('captured receive/commit/handoff and all message/conversation/handoff triggers installed',len(triggers)>=12)
print(json.dumps({'status':'SCHEMA_READY','assertions':checks,'captured_triggers':len(triggers)}))
pathlib.Path('/tmp/c3-preview-native-schema-proof.json').write_text(json.dumps({'checks':checks,'commands':commands},ensure_ascii=False,indent=2)+'\n')

exec((folder/'cases.py').read_text())
