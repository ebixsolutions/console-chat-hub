"""Actual captured Production functions + guarded replacement, disposable native PostgreSQL only."""
import argparse, concurrent.futures, hashlib, json, pathlib, subprocess, urllib.parse

p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--out',required=True);a=p.parse_args()
u=urllib.parse.urlparse(a.database)
assert u.hostname in ('127.0.0.1','localhost') and u.path=='/c3_uat_isolated_native', 'Isolated native database required'
base=pathlib.Path.cwd();out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
t=base/'tests/section15';commands=[];checks=[]
maintenance=urllib.parse.urlunparse(u._replace(path='/postgres'))
db=urllib.parse.urlunparse(u._replace(path='/c3_section15_r1_native'))
def run(sql,fail=False,database=None):
 r=subprocess.run(['psql',database or db,'-X','-qAt','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,timeout=40)
 commands.append(dict(sql=sql,exit_code=r.returncode,stdout=r.stdout,stderr=r.stderr))
 assert (r.returncode!=0 if fail else r.returncode==0),r.stderr
 return r.stdout.strip()
def literal(v):return "'"+json.dumps(v,ensure_ascii=False).replace("'","''")+"'::jsonb"
def string(v):return "'"+str(v).replace("'","''")+"'"
def check(name,condition):
 assert condition,name
 checks.append(dict(assertion=name,result='PASS'))
fixture=json.loads((t/'early-r1-runtime.fixture.json').read_text());receipt=fixture['receipt'];mem=fixture['memory']
co,conv=receipt['company'],receipt['id'];source=receipt['handoffs'][0]['source']
other='fc150000-0000-4000-8000-000000000001';foreign='fc150000-0000-4000-8000-000000000002'
actor='fc150000-0000-4000-8000-000000000003';outsider='fc150000-0000-4000-8000-000000000004'
fn=json.loads((t/'early-r1-before-functions.json').read_text())
security=json.loads((t/'early-r1-before-security.json').read_text())
catalog=json.loads((t/'early-r1-before-catalog.json').read_text())
deps=json.loads((t/'early-r1-company-dependencies.json').read_text())
def catalog_read():return json.loads(run((t/'early-r1-catalog-query.sql').read_text()))
def invoke():return json.loads(run(f"SET ROLE service_role;SELECT public.explicit_handoff_tx('{conv}','Bounded native handoff','{source}');"))
def envelope():return json.loads(run(f"SELECT ai_summary FROM public.handoff_event WHERE conversation_id='{conv}';"))
def pristine():
 run(f"DELETE FROM public.handoff_event;DELETE FROM public.messages WHERE role='assistant' AND metadata IS NULL;UPDATE public.conversations SET status='open',assigned_agent_id=NULL WHERE id='{conv}';")
def save(name,value):(out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
try:
 run('CREATE DATABASE c3_section15_r1_native;',database=maintenance)
 check('native_postgresql_17',int(run('SHOW server_version_num;'))>=170000)
 run("""DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
 CREATE TABLE public.company(id uuid PRIMARY KEY,is_active boolean DEFAULT true);
 CREATE TYPE public.app_role AS ENUM ('admin','supervisor','agent','qa');
 CREATE TABLE public.company_membership(company_id uuid,user_id uuid,is_active boolean,role public.app_role DEFAULT 'admin');
 CREATE TABLE public.conversations(id uuid PRIMARY KEY,company_id uuid,status text,assigned_agent_id uuid,updated_at timestamptz DEFAULT now());
 CREATE TABLE public.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,role text,content text,status text,is_recalled boolean DEFAULT false,metadata jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE public.conversation_commerce_state(conversation_id uuid PRIMARY KEY,company_id uuid,revision bigint,source_message_id uuid,state jsonb,state_hash text);
 CREATE TABLE public.conversation_memory_state(conversation_id uuid PRIMARY KEY,company_id uuid,revision bigint,source_message_id uuid,commerce_state_revision bigint,memory jsonb,markdown_projection text,memory_hash text);
 CREATE TABLE public.handoff_event(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,source_message_id uuid,handoff_type text,branch_tag text,escalation_rule text,safe_reply_content text,handoff_reason text,created_at timestamptz,ai_summary text);
 CREATE TABLE public.conversation_evaluation(id uuid,conversation_id uuid,freshness text,created_at timestamptz);
 """
 )
 run(security['membership_function']+';')
 run(deps['helper']['definition']+';')
 run('GRANT ALL ON public.company,public.company_membership TO postgres,anon,authenticated,service_role;ALTER TABLE public.company ENABLE ROW LEVEL SECURITY;ALTER TABLE public.company_membership ENABLE ROW LEVEL SECURITY;')
 run('CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;')
 run((t/'early-r1-commit-reply-before.sql').read_text())
 for f in fn:
  run(f['definition']+';')
  signature=f['proname']+('' if f['proname']!='explicit_handoff_tx' else '(uuid,text,uuid)')
  if not signature.endswith(')'):signature+='()'
  run('REVOKE ALL ON FUNCTION public.'+signature+' FROM PUBLIC,anon,authenticated,service_role;')
  if f['proname']=='explicit_handoff_tx':run('GRANT EXECUTE ON FUNCTION public.'+signature+' TO service_role;')
 run((t/'early-r1-hf3-before.sql').read_text())
 for tr in catalog['triggers']:run(tr['definition']+';')
 for table in catalog['tables']:
  name=table['table'];run('ALTER TABLE public.'+name+' ENABLE ROW LEVEL SECURITY;')
  if name in ('conversation_commerce_state','conversation_memory_state'):
   run('GRANT ALL ON public.'+name+' TO postgres;GRANT SELECT ON public.'+name+' TO authenticated,service_role;')
  elif name=='conversations':
   run('GRANT ALL ON public.'+name+' TO postgres;GRANT SELECT,INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN ON public.'+name+' TO anon,authenticated;GRANT ALL ON public.'+name+' TO service_role;')
  else:run('GRANT ALL ON public.'+name+' TO postgres,anon,authenticated,service_role;')
 for policy in security['policies']+deps['policies']:
  roles=policy['roles'].strip('{}');cmd=policy['command'];sql='CREATE POLICY '+policy['name']+' ON public.'+policy['table']+' AS '+policy['permissive']+' FOR '+cmd+' TO '+roles
  if policy['using']:sql+=' USING ('+policy['using']+')'
  if policy['check']:sql+=' WITH CHECK ('+policy['check']+')'
  run(sql+';')
 before=catalog_read();check('exact_captured_before_catalog',before==json.loads((t/'early-r1-before-invariants.json').read_text()))
 run(f"INSERT INTO public.company VALUES('{co}',true),('{other}',true);INSERT INTO public.company_membership(company_id,user_id,is_active) VALUES('{co}','{actor}',true);INSERT INTO public.conversations VALUES('{conv}','{co}','open',NULL,now()),('{foreign}','{other}','open',NULL,now());")
 for m in receipt['messages']:
  if m['role']=='assistant' and m['metadata'] is None:continue
  run(f"INSERT INTO public.messages(id,conversation_id,role,content,metadata,created_at) VALUES({string(m['id'])},{string(conv)},{string(m['role'])},{string(m['content'])},{literal(m['metadata']) if m['metadata'] is not None else 'NULL'},{string(m['created_at'])});")
 run(f"INSERT INTO public.conversation_memory_state VALUES('{conv}','{co}',{mem['revision']},'{mem['source_message_id']}',NULL,{literal(mem['memory'])},{string(mem['markdown_projection'])},{string(mem['memory_hash'])});")
 before_state=run(f"SELECT row_to_json(m) FROM public.conversation_memory_state m;")
 check('original_live_failure_reproduced',invoke()['result']=='success' and 'handoff_context' not in envelope()['structured_package'])
 save('original-failure-summary.json',envelope());pristine()
 forward=(base/'sql/c3_section15_early_r1_summary_forward_proposed.sql').read_text();rollback=(base/'sql/c3_section15_early_r1_summary_rollback_proposed.sql').read_text()
 run(forward);after=catalog_read();check('exact_after_catalog_and_only_one_function_changed',after==json.loads((t/'early-r1-after-invariants.json').read_text()))
 run(forward,fail=True);check('repeat_forward_denies_wrong_before_state',catalog_read()==after)
 check('compound_r1_transaction',invoke()['result']=='success');e=envelope();package=e['structured_package'];context=package['handoff_context'];save('actual-native-summary.json',e)
 check('same_ticket_source_tenant',package['conversation_id']==conv and package['company_id']==co and package['generated_from_source_message_id']==source)
 check('latest_correction_raw_not_falsely_committed',package['current_customer_goal']==context['current_request']['content'] and '回收' in package['current_customer_goal'] and not context['current_request']['interpretation_committed'] and package['latest_corrections']==[])
 check('original_memory_revision_source_unchanged',run('SELECT row_to_json(m) FROM public.conversation_memory_state m;')==before_state and context['memory_snapshot']['revision']==10 and context['memory_snapshot']['source_message_id']==mem['source_message_id'])
 check('all_prior_turns_retained',len(context['prior_turns'])==14)
 hist=context['grounded_answer_history'];check('grounded_kb_history_with_lineage',len(hist)==2 and all(x['company_id']==co and x['tenant_id']=='34' and x['kb_fact_proof']['document_id']=='cac65f77a60f43a8bbade929c48e0ef4' and x['kb_fact_proof']['chunk_id']=='21fd757daf0d45dd8726b05a22c5ce32' and x['kb_fact_proof']['value']==5680 and x['applicability']=='historical_answer_not_current_authority' and not x['reusable_as_current'] for x in hist))
 check('history_not_current_authority',package['current_authoritative_kb_facts']==[] and package['active_entities']==[] and package['confirmed_facts']==[])
 check('idempotent_retry_one_handoff',invoke()['result']=='already_handled' and run('SELECT count(*) FROM public.handoff_event;')=='1')
 suppressed=json.loads(run(f"SELECT public.commit_ai_reply_tx('{conv}','{source}','must be suppressed',NULL);"))
 check('human_control_actually_suppresses_ai_write',suppressed['result']=='human_control' and run("SELECT count(*) FROM public.messages WHERE content='must be suppressed';")=='0')
 for role in ('anon','authenticated'):
  run(f"SET ROLE {role};SELECT public.explicit_handoff_tx('{conv}','forbidden','{source}');",fail=True)
  run(f"SET ROLE {role};SELECT public.c3_enrich_handoff_from_memory_tg();",fail=True)
 check('rpc_and_trigger_acl_deny_public_roles',True)
 run(f"INSERT INTO public.handoff_event(conversation_id,source_message_id,handoff_type,escalation_rule) VALUES('{foreign}',NULL,'agent_to_agent',NULL);")
 staff=run(f"SET ROLE authenticated;SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='{actor}';SELECT count(*) FROM public.handoff_event;")
 unknown=run(f"SET ROLE authenticated;SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='{outsider}';SELECT count(*) FROM public.handoff_event;")
 check('actual_rls_same_company_only',staff=='1' and unknown=='0');pristine()
 # Invalid source/tenant/revision must abort the complete transaction, including reply/status.
 mutations=[("company_id",string(other)),('revision','11'),('source_message_id',string('fc150000-0000-4000-8000-000000000099'))]
 original={'company_id':string(co),'revision':'10','source_message_id':string(mem['source_message_id'])}
 for column,value in mutations:
  run(f"UPDATE public.conversation_memory_state SET {column}={value};")
  run(f"SET ROLE service_role;SELECT public.explicit_handoff_tx('{conv}','must rollback','{source}');",fail=True)
  check('atomic_fail_closed_'+column,run('SELECT count(*) FROM public.handoff_event;')=='0' and run(f"SELECT status FROM public.conversations WHERE id='{conv}';")=='open' and run("SELECT count(*) FROM public.messages WHERE content='must rollback';")=='0')
  run(f"UPDATE public.conversation_memory_state SET {column}={original[column]};")
 bad=json.loads(json.dumps(mem['memory']));bad['current_customer_facts']=[dict(key='payment',value='paid',authority='current_kb',source_message_id=mem['source_message_id'])]
 run('UPDATE public.conversation_memory_state SET memory='+literal(bad)+';')
 run(f"SET ROLE service_role;SELECT public.explicit_handoff_tx('{conv}','unverified paid','{source}');",fail=True)
 check('customer_statement_never_merchant_authority',run('SELECT count(*) FROM public.handoff_event;')=='0')
 run('UPDATE public.conversation_memory_state SET memory='+literal(mem['memory'])+';')
 # An original customer-fact source cannot be invented or imported from another ticket.
 bad=json.loads(json.dumps(mem['memory']));bad['current_customer_facts']=[dict(key='request',value='cancel',authority='customer',source_message_id=foreign)]
 run('UPDATE public.conversation_memory_state SET memory='+literal(bad)+';')
 run(f"SELECT public.explicit_handoff_tx('{conv}','foreign original fact','{source}');",fail=True)
 check('original_customer_fact_source_mismatch_atomic_denial',run('SELECT count(*) FROM public.handoff_event;')=='0')
 run('UPDATE public.conversation_memory_state SET memory='+literal(mem['memory'])+';')
 # No snapshot is valid for a first standalone explicit request; raw source remains exact.
 run('DELETE FROM public.conversation_memory_state;')
 invoke();q=envelope()['structured_package']['handoff_context'];check('no_memory_early_r1_raw_same_ticket',q['memory_snapshot'] is None and q['current_request']['source_message_id']==source and not q['current_request']['interpretation_committed']);pristine()
 run(f"INSERT INTO public.conversation_memory_state VALUES('{conv}','{co}',10,'{mem['source_message_id']}',NULL,{literal(mem['memory'])},{string(mem['markdown_projection'])},{string(mem['memory_hash'])});")
 # A legitimately committed same-source snapshot is not confused with prior context.
 same=json.loads(json.dumps(mem['memory']));same['source_message_id']=source;same['current_goal']='Current recycling objective';same['current_customer_facts']=[]
 run(f"UPDATE public.conversation_memory_state SET source_message_id='{source}',memory={literal(same)};")
 invoke();q=envelope()['structured_package'];check('same_source_committed_context_preserved',q['handoff_context']['current_request']['interpretation_committed'] and q['current_customer_goal']==same['current_goal']);pristine()
 run(f"UPDATE public.conversation_memory_state SET source_message_id='{mem['source_message_id']}',memory={literal(mem['memory'])};")
 # Bad historical KB provenance is omitted from verified history, not promoted.
 run("UPDATE public.messages SET metadata=jsonb_set(metadata,'{kb_fact_proof,tenant_id}','\"foreign\"'::jsonb) WHERE role='assistant';")
 invoke();check('foreign_kb_tenant_denied',envelope()['structured_package']['handoff_context']['grounded_answer_history']==[]);pristine()
 for m in receipt['messages']:
  if m['role']=='assistant' and m['metadata'] is not None:run(f"UPDATE public.messages SET metadata={literal(m['metadata'])} WHERE id='{m['id']}';")
 # True two-connection retry, using the unchanged actual R1 row lock/idempotency.
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:invoke(),range(2)))
 check('two_connection_exactly_once_atomicity',sorted(x['result'] for x in results)==['already_handled','success'] and run('SELECT count(*) FROM public.handoff_event;')=='1');pristine()
 # Existing higher-priority same-source handoffs cannot be overwritten by R1.
 for rule in ('E2','E1'):
  run(f"INSERT INTO public.handoff_event(conversation_id,source_message_id,handoff_type,branch_tag,escalation_rule,handoff_reason,created_at) VALUES('{conv}','{source}','ai_to_agent','ESC_{rule}_REQUIRED','{rule}','native priority',now());")
  check('existing_'+rule+'_over_r1',invoke()['existing_branch']=='ESC_'+rule+'_REQUIRED' and run('SELECT count(*) FROM public.handoff_event;')=='1');pristine()
 # Current correction/cancellation is represented raw; historical typed facts retain source and meaning.
 committed={'current_intent':'Earlier purchase','entities':[],'quotes':[],'unresolved_items':[],
   'conversion':{'payment_status':'paid','order_status':'confirmed'}}
 run(f"INSERT INTO public.conversation_commerce_state VALUES('{conv}','{co}',7,'{mem['source_message_id']}',{literal(committed)},'native-canonical-commerce-hash');")
 bound=json.loads(json.dumps(mem['memory']));bound['commerce_state_revision']=7
 run('UPDATE public.conversation_memory_state SET commerce_state_revision=7,memory='+literal(bound)+';')
 invoke();q=envelope()['structured_package'];check('last_committed_payment_authority_retained_not_latest_claim',q['transaction_state']['payment']=='paid' and q['handoff_context']['commerce_snapshot']['revision']==7 and q['handoff_context']['commerce_snapshot']['source_message_id']==mem['source_message_id'] and q['current_customer_goal'].find('回收')>=0);pristine()
 run('UPDATE public.conversation_memory_state SET commerce_state_revision=6;')
 run(f"SELECT public.explicit_handoff_tx('{conv}','revision mismatch','{source}');",fail=True)
 check('commerce_memory_revision_mismatch_atomic_denial',run('SELECT count(*) FROM public.handoff_event;')=='0');
 run('DELETE FROM public.conversation_commerce_state;UPDATE public.conversation_memory_state SET commerce_state_revision=NULL,memory='+literal(mem['memory'])+';')
 rich=json.loads(json.dumps(mem['memory']));rich['current_customer_facts']=[dict(key=k,value=v,authority='customer',source_message_id=mem['source_message_id']) for k,v in [('count',0),('app',False),('availability',None)]]
 run('UPDATE public.conversation_memory_state SET memory='+literal(rich)+';')
 run(f"UPDATE public.messages SET content='Cancel the earlier purchase; I need recycling collection, not a new unit. Please transfer to a human.' WHERE id='{source}';")
 invoke();c=envelope()['structured_package']['handoff_context'];check('cancellation_and_zero_false_null_prior_facts',c['current_request']['content'].startswith('Cancel') and c['memory_snapshot']['memory']['current_customer_facts']==rich['current_customer_facts'] and not c['current_request']['interpretation_committed']);save('typed-cancellation-summary.json',envelope());pristine()
 # Forward and exact rollback affect no canonical state or persisted test evidence.
 state=run('SELECT row_to_json(m) FROM public.conversation_memory_state m;');run(rollback)
 check('full_catalog_rollback_parity',catalog_read()==before and run('SELECT row_to_json(m) FROM public.conversation_memory_state m;')==state)
 run(rollback,fail=True);check('rollback_rejects_not_after_state',catalog_read()==before)
 run(forward)
 run("ALTER FUNCTION public.c3_enrich_handoff_from_memory_tg() SET work_mem='5MB';")
 run(rollback,fail=True);check('intervening_owner_change_guard',run("SELECT proconfig::text FROM pg_proc WHERE oid='public.c3_enrich_handoff_from_memory_tg()'::regprocedure;").find('work_mem=5MB')>=0)
 run("ALTER FUNCTION public.c3_enrich_handoff_from_memory_tg() RESET work_mem;")
 check('canonical_after_restored_after_intervening_change_test',catalog_read()==after)
 save('after-functions.json',json.loads(run("SELECT jsonb_agg(jsonb_build_object('name',p.proname,'definition',pg_get_functiondef(p.oid)) ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('c2_populate_handoff_package_tg','c3_enrich_handoff_from_memory_tg','explicit_handoff_tx');")))
 for name in ('actual-native-summary.json','typed-cancellation-summary.json'):
  result=subprocess.run(['node','--experimental-strip-types','tests/section15/early-r1-consumer-native.mjs',str(out/name)],text=True,capture_output=True,timeout=30)
  commands.append(dict(command='actual persisted Summary consumer '+name,exit_code=result.returncode,stdout=result.stdout,stderr=result.stderr))
  check('actual_persisted_consumer_'+name,result.returncode==0)
 print('C3_SECTION15_EARLY_R1_NATIVE|'+json.dumps(dict(status='PASS',tests=len(checks),assertions=checks,production_writes=0,isolated_native=True)))
finally:
 save('early-r1-native-commands.json',commands);save('early-r1-native-assertions.json',checks)
 run('DROP DATABASE IF EXISTS c3_section15_r1_native;',database=maintenance)
