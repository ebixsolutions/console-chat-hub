"""Captured production function + proposed F14 SQL, disposable local PostgreSQL only."""
import argparse, subprocess, pathlib, urllib.parse, json
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--out',required=True);a=p.parse_args()
u=urllib.parse.urlparse(a.database)
assert u.hostname in ('localhost','127.0.0.1') and u.path=='/c3_uat_isolated_native','Disposable local CI database required'
base=pathlib.Path.cwd();out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True);commands=[]
def run(sql,db=None,fail=False):
 r=subprocess.run(['psql',db or a.database,'-X','-qAt','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,timeout=30)
 commands.append({'sql':sql,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr})
 assert (r.returncode!=0 if fail else r.returncode==0),r.stderr
 return r.stdout.strip()
def literal(v):return "'"+json.dumps(v).replace("'","''")+"'::jsonb"
def uid(n):return 'fc140000-0000-4000-8000-'+str(n).zfill(12)
co,conv,source,oldsource=[uid(n) for n in range(1,5)]
maintenance=urllib.parse.urlunparse(u._replace(path='/postgres'))
try:
 run('CREATE DATABASE c3_f13_f14_native;',maintenance)
 a.database=urllib.parse.urlunparse(u._replace(path='/c3_f13_f14_native'))
 run('CREATE TABLE conversations(id uuid PRIMARY KEY,company_id uuid);CREATE TABLE messages(id uuid PRIMARY KEY,conversation_id uuid,role text);CREATE TABLE conversation_commerce_state(conversation_id uuid,company_id uuid,revision bigint);CREATE TABLE conversation_memory_state(conversation_id uuid,company_id uuid,revision bigint,source_message_id uuid,commerce_state_revision bigint,memory jsonb,markdown_projection text);CREATE TABLE handoffs(id bigserial,conversation_id uuid,handoff_type text,ai_summary text,handoff_reason text);')
 run((base/'tests/c3-f13-f14/captured-handoff-functions.sql').read_text())
 assert run("SELECT md5(pg_get_functiondef('c3_enrich_handoff_from_memory_tg()'::regprocedure))")=='a44aa47ee66fd7ec5b79b4c8731816c2'
 run((base/'sql/c3_f13_f14_handoff_projection_proposed.sql').read_text())
 run('CREATE TRIGGER projection BEFORE INSERT ON handoffs FOR EACH ROW EXECUTE FUNCTION c3_enrich_handoff_from_memory_tg();')
 facts=[dict(key=k,value=v,authority='customer',source_message_id=oldsource) for k,v in [('product_count',275),('staff_count',3),('current_market','hong_kong'),('app_interest',False),('deposit',0),('availability',None)]]
 memory=dict(conversation_id=conv,company_id=co,source_message_id=source,memory_revision=6,commerce_state_revision=3,current_goal='Latest customer requirements',current_customer_facts=facts,latest_corrections=['count corrected'],open_questions=[],pending_actions=[],question_lifecycle=[],customer_preferences=[],historical_facts=[],cancelled_or_superseded=[dict(key='product_count',value=240)])
 run(f"INSERT INTO conversations VALUES('{conv}','{co}');INSERT INTO messages VALUES('{source}','{conv}','visitor'),('{oldsource}','{conv}','visitor');INSERT INTO conversation_commerce_state VALUES('{conv}','{co}',3);INSERT INTO conversation_memory_state VALUES('{conv}','{co}',6,'{source}',3,{literal(memory)},'projection');")
 package=dict(schema_version='c2-handoff-1.0.0',conversation_id=conv,company_id=co,generated_from_source_message_id=source,commerce_state_revision=3,current_customer_goal='stale 240',confirmed_facts=[],open_questions=['obsolete product question'],pending_actions=[],transaction_state=dict(payment='none'),recommended_next_human_action='Review latest customer request')
 def insert(p):
  e=dict(schema_version='c2-handoff-1.0.0',structured_package=p,summary_markdown='stale 240')
  return json.loads(run(f"INSERT INTO handoffs(conversation_id,handoff_type,ai_summary,handoff_reason) VALUES('{conv}','ai_to_agent',{literal(e)}::text,'customer requested human') RETURNING ai_summary;"))
 e=insert(package);actual=e['structured_package'];assert actual['current_customer_facts']==facts and actual['open_questions']==[]
 assert actual['current_customer_goal']=='Latest customer requirements' and 'stale 240' not in e['summary_markdown']
 assert 'false' in e['summary_markdown'] and 'null' in e['summary_markdown'] and len(actual['confirmed_facts'])==6
 assert all(f['verification']=='customer_provided_not_merchant_verified' for f in actual['confirmed_facts'])
 for patch in [dict(company_id=uid(99)),dict(generated_from_source_message_id=uid(99)),dict(commerce_state_revision=2)]:
  assert 'current_customer_facts' not in insert({**package,**patch})['structured_package'],'mismatched snapshot enriched'
 bad=json.loads(json.dumps(memory));bad['current_customer_facts'][0]['source_message_id']=uid(99)
 run(f'UPDATE conversation_memory_state SET memory={literal(bad)};')
 assert 'current_customer_facts' not in insert(package)['structured_package'],'foreign provenance accepted'
 run(f'UPDATE conversation_memory_state SET memory={literal(memory)};')
 run((base/'sql/c3_f13_f14_handoff_projection_rollback_proposed.sql').read_text())
 assert run("SELECT md5(pg_get_functiondef('c3_enrich_handoff_from_memory_tg()'::regprocedure))")=='a44aa47ee66fd7ec5b79b4c8731816c2'
 run((base/'sql/c3_f13_f14_handoff_projection_proposed.sql').read_text())
 body=(base/'sql/c3_f13_f14_handoff_projection_proposed.sql').read_text().split('CREATE OR REPLACE FUNCTION',1)[1].rsplit('COMMIT;',1)[0]
 run('CREATE OR REPLACE FUNCTION'+body.replace('  RETURN NEW;\nEND;','  RETURN NEW; -- later owner modification\nEND;'))
 run((base/'sql/c3_f13_f14_handoff_projection_rollback_proposed.sql').read_text(),fail=True)
 assert run("SELECT md5(pg_get_functiondef('c2_populate_handoff_package_tg()'::regprocedure))")=='dd75815a825051d7c42d7f9480b6fc0b'
 print('C3_F13_F14_NATIVE|PASS|same_snapshot|typed_facts|tenant|source|revision|rollback|later_change_guard|C2_unchanged')
finally:
 (out/'f13-f14-native.json').write_text(json.dumps(commands,indent=2))
 run('DROP DATABASE IF EXISTS c3_f13_f14_native;',maintenance)
