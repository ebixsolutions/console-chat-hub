import test from 'node:test';
import process from 'node:process';
import {readFile} from 'node:fs/promises';
// Pure source regressions that use Deno.test but do not depend on remote Deno APIs.
// Node's TypeScript stripping allows executing them locally without network.
globalThis.Deno = { readTextFile(path){return readFile(path,'utf8');}, test(name, fn){
  if(typeof name==='object') return test(name.name,name.fn);
  return test(name,fn);
}};
for(const file of process.argv.slice(2)) await import(new URL('../../'+file,import.meta.url));
