import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));
const React=require('react'); const {create,act}=require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const f=globalThis.__currentRoleTest={};
const compiled=await build({entryPoints:['src/hooks/useCurrentRole.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'role-transport-only',setup(b){
 b.onResolve({filter:/^react$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/config.service|useAuth/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path.includes('config.service')?'export const authService={getCurrentUserRole:()=>globalThis.__currentRoleTest.lookup()};':'export const useAuth=()=>globalThis.__currentRoleTest.auth;'}));
}}]});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-current-role-'));const file=path.join(dir,'role.mjs');fs.writeFileSync(file,compiled.outputFiles[0].text);
const {useCurrentRole}=await import(pathToFileURL(file));
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
function Harness(){const value=useCurrentRole();f.current=value;f.renders.push(value);return React.createElement('output',null,JSON.stringify(value));}
function reset(){Object.assign(f,{auth:{user:null,loading:true},renders:[],calls:[],lookup:()=>new Promise((resolve,reject)=>f.calls.push({resolve,reject}))});}
async function mount(t){let root;await act(async()=>{root=create(React.createElement(Harness));});t.after(async()=>act(async()=>root.unmount()));return root;}
async function actor(root,id){f.auth={user:id?{id}:null,loading:false};await act(async()=>root.update(React.createElement(Harness)));}
test('session hydration must not freeze an initial null role',async t=>{reset();const r=await mount(t);assert.equal(f.calls.length,0);await actor(r,'admin-A');assert.equal(f.calls.length,1);await act(async()=>f.calls[0].resolve('admin'));assert.equal(f.current.role,'admin');assert.equal(f.current.loading,false);});
test('actor change invalidates old role before lookup and ignores stale completion',async t=>{reset();f.auth={user:{id:'admin-A'},loading:false};const r=await mount(t);await actor(r,'agent-B');assert.equal(f.calls.length,2);assert.equal(f.current.role,null);await act(async()=>f.calls[0].resolve('admin'));assert.equal(f.current.role,null);await act(async()=>f.calls[1].resolve('agent'));assert.equal(f.current.role,'agent');const start=f.renders.length;await actor(r,null);assert.equal(f.current.role,null);assert.equal(f.current.loading,false);assert(f.renders.slice(start).every(x=>x.role===null));});
test('same-role admin switch exposes distinct actor key to remount owned channels',async t=>{reset();f.auth={user:{id:'A'},loading:false};const r=await mount(t);await act(async()=>f.calls[0].resolve('admin'));assert.equal(f.current.actorId,'A');await actor(r,'B');assert.equal(f.current.role,null);assert.equal(f.current.actorId,'B');await act(async()=>f.calls[1].resolve('admin'));assert.equal(f.current.role,'admin');});
test('lookup rejection fails closed and explicit retry recovers without write',async t=>{reset();f.auth={user:{id:'A'},loading:false};await mount(t);await act(async()=>f.calls[0].reject(Error('secret must not leak')));assert.equal(f.current.role,null);assert.equal(f.current.loading,false);assert.equal(f.current.error,'role_lookup_failed');await act(async()=>f.current.retry());assert.equal(f.calls.length,2);await act(async()=>f.calls[1].resolve('admin'));assert.equal(f.current.error,null);assert.equal(f.current.role,'admin');});
test('no-role and agent remain unprivileged; rerender alone does not requery',async t=>{reset();f.auth={user:{id:'no-role'},loading:false};const r=await mount(t);await act(async()=>f.calls[0].resolve(null));assert.equal(f.current.role,null);await act(async()=>r.update(React.createElement(Harness)));assert.equal(f.calls.length,1);await actor(r,'agent');await act(async()=>f.calls[1].resolve('agent'));assert.equal(f.current.role,'agent');});

test('logout then same identity must revalidate instead of restoring cached authority',async t=>{reset();f.auth={user:{id:'A'},loading:false};const r=await mount(t);await act(async()=>f.calls[0].resolve('admin'));await actor(r,null);await actor(r,'A');assert.equal(f.current.role,null);assert.equal(f.current.loading,true);assert.equal(f.calls.length,2);await act(async()=>f.calls[1].resolve(null));assert.equal(f.current.role,null);});
