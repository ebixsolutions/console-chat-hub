import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const require=createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT??'.','package.json'));
const React=require('react');
const {create,act}=require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const f=globalThis.__summaryReadback={};
const fixtureClient=[
  'const f=globalThis.__summaryReadback;',
  'export const supabase={',
  'from:table=>{const filters={};const q={select(){return q},eq(k,v){filters[k]=v;f.scope.push([table,k,v]);return q},not(){return q},order(){return q},limit(){return q},maybeSingle(){f.reads.push({table,filters:{...filters}});return f.read(table,filters)}};return q},',
  'channel:name=>{const channel={name,on(event,filter,cb){channel.filter=filter;channel.change=cb;f.refresh=cb;return channel},subscribe(cb){channel.status=cb;return channel}};f.channels.push(channel);return channel},',
  'removeChannel(channel){f.removed.push(channel)},',
  'functions:{invoke(){f.aiCalls++;throw Error("Summary readback must not invoke AI")}}',
  '};',
].join('\n');
const out=await build({
  entryPoints:['src/components/console/TicketHandoffSummary.tsx'],bundle:true,write:false,
  platform:'node',format:'esm',jsx:'automatic',
  plugins:[{name:'read-boundary',setup(b){
    b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:require.resolve(a.path),external:true}));
    b.onResolve({filter:/^@\/integrations\/supabase\/client$/},()=>({path:'client',namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:fixtureClient}));
  }}],
});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'c3-summary-read-'));
const file=path.join(dir,'ui.mjs');
fs.writeFileSync(file,out.outputFiles[0].text);
const {TicketHandoffSummary}=await import(pathToFileURL(file));
fs.rmSync(dir,{recursive:true});
const envelope=JSON.parse(fs.readFileSync('tests/phase1/persisted-handoff.fixture.json'));
const id=envelope.structured_package.conversation_id;
const company=envelope.structured_package.company_id;
const otherId='d4000000-0000-4000-8000-000000000099';
const txt=x=>typeof x==='string'?x:Array.isArray(x)?x.map(txt).join(''):x?.children?.map(txt).join('')??'';

function event(goal,ticket=id){
  const value=structuredClone(envelope);
  value.structured_package.current_customer_goal=goal;
  value.structured_package.conversation_id=ticket;
  return {data:{ai_summary:value},error:null};
}
function reset(hidden=false){
  Object.assign(f,{scope:[],reads:[],channels:[],removed:[],aiCalls:0,goal:'Current goal'});
  f.read=async(table,filters)=>table==='conversations'
    ? {data:{id:filters.id,company_id:company},error:null}
    : event(f.goal,filters.conversation_id);
  const listeners=new Set();
  globalThis.document={hidden,visibilityState:hidden?'hidden':'visible',
    addEventListener(type,callback){if(type==='visibilitychange')listeners.add(callback)},
    removeEventListener(type,callback){if(type==='visibilitychange')listeners.delete(callback)},
  };
  f.listeners=listeners;
}
async function visibility(hidden){
  document.hidden=hidden;
  document.visibilityState=hidden?'hidden':'visible';
  await act(async()=>{for(const callback of f.listeners)callback()});
}
async function mount(t,ticket=id){
  let root;
  await act(async()=>{root=create(React.createElement(TicketHandoffSummary,{conversationId:ticket}))});
  t.after(async()=>{await act(async()=>root.unmount());assert.equal(f.aiCalls,0)});
  return root;
}

test('same-ticket Summary coalesces newer corrections and never publishes a superseded read',async t=>{
  reset();let old;let fresh;let calls=0;
  f.read=async(table,filters)=>table==='conversations'
    ? {data:{id:filters.id,company_id:company},error:null}
    : ++calls===1?new Promise(resolve=>old=resolve):new Promise(resolve=>fresh=resolve);
  const root=await mount(t);
  await act(async()=>{f.refresh();f.refresh();f.channels[0].status?.('SUBSCRIBED');for(const callback of f.listeners)callback()});
  assert.equal(calls,1,'one in-flight read despite a burst of invalidations');
  await act(async()=>old(event('Superseded old goal')));
  assert.equal(calls,2,'the burst produces only one queued fresh read');
  assert(!txt(root.toJSON()).includes('Superseded old goal'),'superseded response cannot render while the fresh read waits');
  await act(async()=>fresh(event('Latest corrected customer goal')));
  assert.match(txt(root.toJSON()),/Latest corrected customer goal/);
  assert(!txt(root.toJSON()).includes('Superseded old goal'));
  assert(f.scope.filter(([table])=>table==='handoff_event').every(([,key,value])=>key==='conversation_id'&&value===id));
});

test('same-ticket Summary handles thrown read as recoverable error, explicit retry remains read-only',async t=>{
  reset();f.read=async()=>{throw Error('transport unavailable')};
  const root=await mount(t);
  assert(root.root.findByProps({role:'alert'}));
  f.read=async(table,filters)=>table==='conversations'
    ? {data:{id:filters.id,company_id:company},error:null}:event('Current goal');
  await act(async()=>root.root.findByType('button').props.onClick());
  assert.match(txt(root.toJSON()),/Current goal/);
});

test('foreign persisted Summary never becomes another ticket readback',async t=>{
  reset();const foreign=event('Foreign goal');
  foreign.data.ai_summary.structured_package.company_id='foreign';
  const normal=f.read;
  f.read=(table,filters)=>table==='conversations'?normal(table,filters):Promise.resolve(foreign);
  const root=await mount(t);
  assert(root.root.findByProps({role:'alert'}));
  assert(!txt(root.toJSON()).includes('Foreign goal'));
});

test('Summary catch-up keeps a denied conversation read closed before reading handoff rows',async t=>{
  reset();
  f.read=async table=>{
    assert.equal(table,'conversations','no handoff read without the authorized company scope');
    return {data:null,error:{message:'forbidden'}};
  };
  const root=await mount(t);
  await act(async()=>f.channels[0].status?.('SUBSCRIBED'));
  await visibility(true);
  await visibility(false);
  assert(root.root.findByProps({role:'alert'}));
  assert(f.reads.every(read=>read.table==='conversations'&&read.filters.id===id));
});

test('Summary catches the initial snapshot-to-subscribe gap on SUBSCRIBED',async t=>{
  reset();f.goal='Before initial subscription';
  const root=await mount(t);
  assert.match(txt(root.toJSON()),/Before initial subscription/);
  f.goal='Saved during initial subscription gap';
  await act(async()=>f.channels[0].status?.('SUBSCRIBED'));
  assert.match(txt(root.toJSON()),/Saved during initial subscription gap/);
  assert.equal(f.reads.length,4,'one initial scoped read and one ready catch-up');
});

test('Summary catches a missed handoff event after disconnect and resubscribe',async t=>{
  reset();const root=await mount(t);const channel=f.channels[0];
  await act(async()=>channel.status?.('SUBSCRIBED'));
  const before=f.reads.length;
  await act(async()=>channel.status?.('CHANNEL_ERROR'));
  f.goal='Saved while the summary stream was disconnected';
  assert.equal(f.reads.length,before,'disconnect itself does not poll');
  await act(async()=>channel.status?.('SUBSCRIBED'));
  assert.match(txt(root.toJSON()),/Saved while the summary stream was disconnected/);
  assert.equal(f.reads.length,before+2);
});

test('Summary catches missed events when the tab becomes visible',async t=>{
  reset();const root=await mount(t);
  await visibility(true);
  f.goal='Saved while the tab was hidden';
  const before=f.reads.length;
  await visibility(false);
  assert.match(txt(root.toJSON()),/Saved while the tab was hidden/);
  assert.equal(f.reads.length,before+2);
});

test('Summary does not read while hidden or schedule idle polling',async t=>{
  reset(true);
  const originalInterval=globalThis.setInterval;
  const timers=[];
  globalThis.setInterval=callback=>{timers.push(callback);return timers.length};
  t.after(()=>{globalThis.setInterval=originalInterval});
  const root=await mount(t);const channel=f.channels[0];
  await act(async()=>{channel.change();channel.status?.('SUBSCRIBED')});
  assert.equal(f.reads.length,0,'hidden initial load and events do not query');
  f.goal='Current visible goal';
  await visibility(false);
  assert.match(txt(root.toJSON()),/Current visible goal/);
  const before=f.reads.length;
  await act(async()=>{for(const callback of timers)callback();await new Promise(resolve=>setImmediate(resolve))});
  assert.equal(timers.length,0,'no recurring database timer is installed');
  assert.equal(f.reads.length,before,'idle time does not reread history');
});

test('Summary ticket switch isolates old reads, events, and subscription callbacks',async t=>{
  reset();const root=await mount(t);const oldChannel=f.channels[0];
  let releaseOld;const normal=f.read;
  f.read=(table,filters)=>table==='handoff_event'&&filters.conversation_id===id
    ? new Promise(resolve=>releaseOld=resolve):normal(table,filters);
  await act(async()=>oldChannel.change());
  f.goal='Other ticket current goal';
  await act(async()=>root.update(React.createElement(TicketHandoffSummary,{conversationId:otherId})));
  assert.match(txt(root.toJSON()),/Other ticket current goal/);
  const before=f.reads.length;
  await act(async()=>{oldChannel.change();oldChannel.status?.('SUBSCRIBED');releaseOld(event('Stale old-ticket goal'))});
  assert.equal(f.reads.length,before,'torn-down callbacks cannot start old-ticket reads');
  assert.match(txt(root.toJSON()),/Other ticket current goal/);
  assert(!txt(root.toJSON()).includes('Stale old-ticket goal'));
  assert(f.removed.includes(oldChannel));
  assert.equal(f.listeners.size,1,'only the current ticket owns a visibility listener');
});
