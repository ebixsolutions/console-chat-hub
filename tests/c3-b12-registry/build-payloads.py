"""Reproduce exact complete CE target/rollback from verified historical blobs and candidate source."""
from pathlib import Path
import json,hashlib,subprocess,sys
R=Path(__file__).resolve().parents[2];out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
for row in json.loads((Path(__file__).with_name('deployment-source-manifest.json')).read_text()):
 slug=row['slug'];before=[];target=[]
 for f in row['sources']:
  b=subprocess.check_output(['git','cat-file','blob',f['before_or_dependency_git_blob']],cwd=R) if f['before_or_dependency_git_blob'] else b''
  if f['existing_before']:before.append(dict(name=f['name'],content=b.decode()))
  source=R/'supabase'/f['name'] if f['name'].startswith('functions/') else R/'supabase/functions'/f['name']
  b=source.read_bytes() if f['target_from_source'] else b
  assert hashlib.sha256(b).hexdigest()==f['sha256'],f['name']
  target.append(dict(name=f['name'],content=b.decode()))
 for phase,files in [('target',target),('rollback',before)]:
  # Historical export order matters for the exact rollback JSON serialization.
  if phase=='rollback':files.sort(key=lambda x:row['before_order'].index(x['name']))
  payload=dict(project_id='nrfxhqabwblzxoushgnm',name=slug,verify_jwt=row['verify_jwt'],entrypoint_path=row['entrypoint_path'],import_map_path=row['import_map_path'],files=files)
  text=json.dumps(payload,ensure_ascii=False,indent=2)+'\n';assert hashlib.sha256(text.encode()).hexdigest()==row[phase+'_payload_sha256']
  (out/(slug+'-'+phase+'-payload.json')).write_text(text)
  for f in files:p=out/(slug+'-'+phase)/f['name'];p.parent.mkdir(parents=True,exist_ok=True);p.write_text(f['content'])
print('C3_B12_EXACT_COMPLETE_PAYLOADS|PASS|target_and_rollback_SHA256|before_dependencies_preserved|no_deployment')
