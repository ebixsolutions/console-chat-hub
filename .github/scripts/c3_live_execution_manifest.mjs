/** Prepare exact reviewable Function targets from the complete authoritative
 * repo and captured read-only baselines. This script NEVER deploys or sends. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {runtimeDependencyClosure} from './c3_module_graph.mjs';
const args=process.argv.slice(2),arg=k=>args[args.indexOf(k)+1];
const baselineDir=arg('--baseline-dir'),out=arg('--out');
if(!baselineDir||!out)throw Error('baseline-dir and out required');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const root=process.cwd(),targets=[];
for(const slug of ['generate-reply','widget-live-ai-test','kb-search-proxy']){
 const file=path.join(baselineDir,slug==='generate-reply'?'generate-reply-v219.json':slug+'-baseline.json');
 const baseline=JSON.parse(fs.readFileSync(file));
 if(baseline.slug!==slug||baseline.status!=='ACTIVE'||baseline.verify_jwt!==true)throw Error('baseline identity mismatch');
 const paths=runtimeDependencyClosure({root,entrypoints:[`supabase/functions/${slug}/index.ts`]});
 const mainName=baseline.files.find(f=>f.name.endsWith(`${slug}/index.ts`))?.name;
 if(!mainName)throw Error('baseline entrypoint absent');
 const prefix=mainName.slice(0,-(`${slug}/index.ts`).length);
 const files=paths.map(p=>({name:p.replace(/^supabase\/functions\//,prefix),content:fs.readFileSync(p,'utf8')}));
 const map=baseline.files.find(f=>f.name===`functions/${slug}/deno.json` || (baseline.import_map_path && baseline.import_map_path.endsWith("/"+f.name)));
 if(baseline.import_map&&!map)throw Error('baseline import map absent');if(map)files.push(map);
 const before=baseline.files.map(f=>({path:f.name,sha256:sha(f.content)})).sort((a,b)=>a.path.localeCompare(b.path));
 const after=files.map(f=>({path:f.name,sha256:sha(f.content)})).sort((a,b)=>a.path.localeCompare(b.path));
 const target={slug,verify_jwt:baseline.verify_jwt,entrypoint_path:mainName,import_map_path:map?map.name:undefined,files};
 const manifest={slug,baseline_version:baseline.version,baseline_ezbr_sha256:baseline.ezbr_sha256,baseline_file_sha256:sha(fs.readFileSync(file)),baseline:before,target:after,target_digest:sha(JSON.stringify(after)),changed:after.filter(f=>before.find(b=>b.path===f.path)?.sha256!==f.sha256),removed:before.filter(b=>!after.some(f=>f.path===b.path))};
 fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,slug+'-target.json'),JSON.stringify(target));fs.writeFileSync(path.join(out,slug+'-manifest.json'),JSON.stringify(manifest,null,2)+'\n');targets.push(manifest);
}
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
fs.writeFileSync(path.join(out,'execution-manifest.json'),JSON.stringify({head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),targets,deployment_authorized:false,hosted_executed:false},null,2)+'\n');
console.log(JSON.stringify(targets.map(t=>({slug:t.slug,baseline_files:t.baseline.length,target_files:t.target.length,changed:t.changed.length,removed:t.removed.length,target_digest:t.target_digest}))));
