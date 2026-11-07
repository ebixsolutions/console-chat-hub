import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));
const React=require('react');const {create,act}=require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const f=globalThis.__legacyWidgetEntry={navigations:[],calls:[]};
const result=await build({entryPoints:['src/components/console/WidgetLiveAiTest.tsx'],bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'router-transport-only',setup(b){
 b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
 b.onResolve({filter:/^(lucide-react|@tanstack\/react-router|@\/)/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>{
  if(a.path==='@tanstack/react-router')return {contents:'export const Navigate=p=>{globalThis.__legacyWidgetEntry.navigations.push(p);return null;};'};
  if(a.path==='lucide-react')return {contents:'export const AlertCircle=()=>null,Bot=()=>null,Database=()=>null,Loader2=()=>null,Send=()=>null,ShieldCheck=()=>null;'};
  if(a.path.includes('/supabase/client'))return {contents:'export const supabase={functions:{invoke:async(...a)=>{globalThis.__legacyWidgetEntry.calls.push(a);throw Error("No legacy dispatch permitted");}}};'};
  return {contents:'import React from "react";export const Button=p=>React.createElement("button",p,p.children),Textarea=p=>React.createElement("textarea",p);'};
 });
 b.onLoad({filter:/WidgetLiveAiTest\.tsx$/},()=>process.env.C3_LEGACY_WIDGET_SOURCE_REF?{contents:execFileSync('git',['show',process.env.C3_LEGACY_WIDGET_SOURCE_REF+':src/components/console/WidgetLiveAiTest.tsx'],{encoding:'utf8'}),loader:'tsx'}:undefined);
}}]});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-legacy-widget-'));const file=path.join(dir,'entry.mjs');fs.writeFileSync(file,result.outputFiles[0].text);const {WidgetLiveAiTest}=await import(pathToFileURL(file));test.after(()=>fs.rmSync(dir,{recursive:true}));
test('legacy Widget entry uses the original guarded Preview instead of a second incompatible dispatch UI',async()=>{
 let r;await act(async()=>{r=create(React.createElement(WidgetLiveAiTest));});
 assert(f.navigations.length>0,'old alias must reach the original guarded Widget Preview');
 for(const n of f.navigations){assert.equal(n.to,'/console/widget-preview');assert.equal(n.replace,true);}
 assert.equal(f.calls.length,0);assert.equal(r.toJSON(),null);
 await act(async()=>r.unmount());
});
