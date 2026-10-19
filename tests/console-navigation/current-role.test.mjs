import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
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
// Execute the actual canonical role service; only Auth/DB transport is adapted.
const sf=globalThis.__roleServiceTest={};
const serviceBuild=await build({entryPoints:['src/lib/api/config.service.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'role-service-transports',setup(b){
 b.onLoad({filter:/config\.service\.ts$/},a=>process.env.C3_CONFIG_SOURCE_REF?{contents:execFileSync('git',['show',process.env.C3_CONFIG_SOURCE_REF+':src/lib/api/config.service.ts'],{encoding:'utf8'}),loader:'ts'}:undefined);
 b.onResolve({filter:/^(@tanstack\/react-start|@\/integrations\/supabase\/(client|auth-middleware))$/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path.endsWith('/client')?'export const supabase={auth:{getSession:async()=>globalThis.__roleServiceTest.session,getUser:async()=>({data:{user:{email:"frankien.ng@gmail.com"}},error:null})},from:t=>globalThis.__roleServiceTest.from(t)};':a.path.includes('auth-middleware')?'export const requireSupabaseAuth={};':'export function createServerFn(){return {middleware(){return this},inputValidator(){return this},handler(){return ()=>{throw Error("server writes forbidden")}}}}'}));
}}]});
const serviceFile=path.join(dir,'service.mjs');fs.writeFileSync(serviceFile,serviceBuild.outputFiles[0].text);const {authService}=await import(pathToFileURL(serviceFile));
function serviceReset(){sf.session={data:{session:{user:{id:'actor'}}},error:null};sf.rows=[{company_id:'company',role:'admin',is_active:true}];sf.company={id:'company',is_active:true};sf.fail=null;sf.reads=[];globalThis.window={location:{hostname:'localhost'}};sf.from=table=>{sf.reads.push(table);let activeOnly=false;const q={select(){return q},eq(k,v){if(k==='is_active')activeOnly=v;return q},maybeSingle:async()=>({data:sf.company,error:sf.fail==='company'?{message:'private transport error'}:null}),then:resolve=>Promise.resolve({data:activeOnly?sf.rows.filter(x=>x.is_active):sf.rows,error:sf.fail==='membership'?{message:'private transport error'}:null}).then(resolve)};return q;};}

test('session hydration must not freeze an initial null role',async t=>{reset();const r=await mount(t);assert.equal(f.calls.length,0);await actor(r,'admin-A');assert.equal(f.calls.length,1);await act(async()=>f.calls[0].resolve('admin'));assert.equal(f.current.role,'admin');assert.equal(f.current.loading,false);});
test('actor change invalidates old role before lookup and ignores stale completion',async t=>{reset();f.auth={user:{id:'admin-A'},loading:false};const r=await mount(t);await actor(r,'agent-B');assert.equal(f.calls.length,2);assert.equal(f.current.role,null);await act(async()=>f.calls[0].resolve('admin'));assert.equal(f.current.role,null);await act(async()=>f.calls[1].resolve('agent'));assert.equal(f.current.role,'agent');const start=f.renders.length;await actor(r,null);assert.equal(f.current.role,null);assert.equal(f.current.loading,false);assert(f.renders.slice(start).every(x=>x.role===null));});
test('same-role admin switch exposes distinct actor key to remount owned channels',async t=>{reset();f.auth={user:{id:'A'},loading:false};const r=await mount(t);await act(async()=>f.calls[0].resolve('admin'));assert.equal(f.current.actorId,'A');await actor(r,'B');assert.equal(f.current.role,null);assert.equal(f.current.actorId,'B');await act(async()=>f.calls[1].resolve('admin'));assert.equal(f.current.role,'admin');});
test('lookup rejection fails closed and explicit retry recovers without write',async t=>{reset();f.auth={user:{id:'A'},loading:false};await mount(t);await act(async()=>f.calls[0].reject(Error('secret must not leak')));assert.equal(f.current.role,null);assert.equal(f.current.loading,false);assert.equal(f.current.error,'role_lookup_failed');await act(async()=>f.current.retry());assert.equal(f.calls.length,2);await act(async()=>f.calls[1].resolve('admin'));assert.equal(f.current.error,null);assert.equal(f.current.role,'admin');});
test('no-role and agent remain unprivileged; rerender alone does not requery',async t=>{reset();f.auth={user:{id:'no-role'},loading:false};const r=await mount(t);await act(async()=>f.calls[0].resolve(null));assert.equal(f.current.role,null);await act(async()=>r.update(React.createElement(Harness)));assert.equal(f.calls.length,1);await actor(r,'agent');await act(async()=>f.calls[1].resolve('agent'));assert.equal(f.current.role,'agent');});

test('logout then same identity must revalidate instead of restoring cached authority',async t=>{reset();f.auth={user:{id:'A'},loading:false};const r=await mount(t);await act(async()=>f.calls[0].resolve('admin'));await actor(r,null);await actor(r,'A');assert.equal(f.current.role,null);assert.equal(f.current.loading,true);assert.equal(f.calls.length,2);await act(async()=>f.calls[1].resolve(null));assert.equal(f.current.role,null);});

test('real role service keeps canonical admin/agent and no-role distinct',async()=>{serviceReset();assert.equal(await authService.getCurrentUserRole(),'admin');sf.rows[0].role='agent';assert.equal(await authService.getCurrentUserRole(),'agent');sf.rows[0].role='unknown';assert.equal(await authService.getCurrentUserRole(),null);});
test('real role service does not convert lookup failure into permission denial or preview admin',async()=>{for(const failure of ['membership','company']){serviceReset();sf.fail=failure;await assert.rejects(authService.getCurrentUserRole(),/lookup_failed/);}serviceReset();sf.session.error={message:'private session error'};await assert.rejects(authService.getCurrentUserRole(),/session_lookup_failed/);});
test('canonical inactive or ambiguous identity cannot fall back to preview email bridge',async()=>{serviceReset();sf.rows[0].is_active=false;assert.equal(await authService.getCurrentUserRole(),null);serviceReset();sf.rows.push({company_id:'foreign',role:'admin',is_active:true});assert.equal(await authService.getCurrentUserRole(),null);serviceReset();sf.company.is_active=false;assert.deepEqual(await authService.getCurrentUserRoles(),[]);});
