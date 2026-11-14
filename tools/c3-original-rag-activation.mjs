import {build} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const out=process.argv[2];if(!out)throw Error('Usage: node tools/c3-original-rag-activation.mjs OUTPUT_DIRECTORY');
const bundle=await build({stdin:{contents:"export {FRANKIE_KB_SCOPE,ORIGINAL_RAG_ACTIVATION,ragApiPolicy} from './supabase/functions/_shared/preview-kb-query-embedding.ts'",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {FRANKIE_KB_SCOPE:s,ORIGINAL_RAG_ACTIVATION:a,ragApiPolicy}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const {preview_version,inbox_version,...policy}=a;if(!ragApiPolicy(policy))throw Error('Actual consumer policy mismatch');
const binding={actor_id:s.actor,company_id:s.company,channel_id:s.channel,tenant_id:s.tenant,endpoint:s.endpoint,provider:'singapore-kb',purpose:'kb_embedding',...policy};
const values={ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION:{version:preview_version,bindings:[binding]},AUTHENTICATED_INBOX_KB_AUTHORIZATION:{version:inbox_version,bindings:[{...binding,operations:['knowledge','policy'],allow_assist:true}]}};
mkdirSync(resolve(out),{recursive:true});const receipts=[];
for(const [name,value]of Object.entries(values)){const text=JSON.stringify(value);writeFileSync(resolve(out,name+'.json'),text);receipts.push({name,version:value.version,sha256:createHash('sha256').update(text).digest('hex'),bytes:Buffer.byteLength(text),scope:s,contains_credentials:false});}
writeFileSync(resolve(out,'Authorization-Value-Hashes.json'),JSON.stringify(receipts,null,2)+'\n');
console.log(JSON.stringify({status:'GENERATED_NOT_INSTALLED',source:'actual consumer constants and policy parser',settings:receipts}));
