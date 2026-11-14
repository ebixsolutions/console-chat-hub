"""Materialize comparison fixtures only, from captured live authority and existing Git blobs."""
import json,hashlib,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[2];out=pathlib.Path(sys.argv[1]);manifest=json.loads((root/'tests/uat-runtime/live-baseline-blobs.json').read_text())
for slug,row in manifest.items():
 for f in row['files']:
  data=subprocess.check_output(['git','cat-file','blob',f['blob']],cwd=root)
  assert hashlib.sha256(data).hexdigest()==f['sha256'],(slug,f['name'])
  p=out/slug/f['name'];p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
print(json.dumps({'result':'PASS','scope':'Captured live comparison fixtures, no deployed second backend','files':sum(len(r['files']) for r in manifest.values())}))
