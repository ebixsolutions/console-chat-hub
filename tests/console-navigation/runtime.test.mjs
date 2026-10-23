import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT ?? '.', 'package.json'));
const React = require('react');
const { create, act } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-console-'));
const entries = [
  ['crm', 'src/components/console/CRMPanel.tsx'],
  ['agent', 'src/components/console/AgentToolPanel.tsx'],
  ['ce', 'src/routes/_authenticated/console.conversation-evaluation.index.tsx'],
  ['detail', 'src/components/console/VisitorAnalyticsDetail.tsx'],
  ['analytics', 'src/routes/_authenticated/console.visitor-analytics.tsx'],
];
const components = {};
const fixtureModule = 'const f=globalThis.__c3Console;';
for (const [name, entry] of entries) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic',
    plugins: [{ name: 'isolated-transport-and-session', setup(b) {
      b.onResolve({ filter: /^react(?:\/.*)?$/ }, a => ({ path: require.resolve(a.path), external: true }));
      b.onResolve({ filter: /^(lucide-react|sonner|@tanstack\/react-router)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
      b.onResolve({ filter: /^@\/(integrations\/supabase\/client|hooks\/useEffectiveRole|hooks\/useCurrentRole|lib\/i18n\/consoleLang|lib\/api\/ce.functions|lib\/customer360\/useCustomerContext|components\/console\/ce\/CeDetailPanel)$/ }, a => ({ path: a.path, namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => {
        if (a.path === 'lucide-react') return { contents: 'export const Search=()=>null,Users=()=>null,AlertCircle=()=>null,Loader2=()=>null,MessageSquare=()=>null,Star=()=>null,BarChart3=()=>null;' };
        if (a.path === 'sonner') return { contents: 'export const toast={error(){},info(){},success(){}};' };
        if (a.path === '@tanstack/react-router') return { contents: 'export const createFileRoute=()=>x=>x;' };
        if (a.path.includes('/supabase/client')) return { contents: fixtureModule + 'export const supabase={functions:{invoke:(...a)=>f.invoke(...a)},from:()=>({select:()=>({in:async()=>({data:f.states,error:null})})})};' };
        if (a.path.includes('useCurrentRole')) return { contents: fixtureModule + 'export const useCurrentRole=()=>({role:f.role,loading:false});' };
        if (a.path.includes('useEffectiveRole')) return { contents: 'export const useConsoleLang=()=>"en";' };
        if (a.path.includes('i18n/consoleLang')) return { contents: 'export const useConsoleLang=()=>({t:x=>x?.en??"",lang:"en"});export const COPY={ce:{errors:{unknown:{en:"Error"}}}};' };
        if (a.path.includes('ce.functions')) return { contents: fixtureModule + 'export const listConversationsForCeFn=async()=>({ok:true,data:{rows:f.rows,counts:{total:f.rows.length,evaluated:0,not_evaluated:f.rows.length,needs_review:0}}});' };
        if (a.path.includes('useCustomerContext')) return { contents: 'export const useCustomerContext=()=>({status:"idle"});' };
        return { contents: 'export const CeDetailPanel=()=>null;' };
      });
      b.onLoad({ filter: /console\.conversation-evaluation\.index\.tsx$/ }, a => ({ contents: fs.readFileSync(a.path,'utf8')+'\nexport {ReviewConsole};', loader:'tsx' }));
    } }],
  });
  const file = path.join(temporary, name+'.mjs'); fs.writeFileSync(file,result.outputFiles[0].text);
  // The imported boundaries retain this object; each test replaces its fields.
  globalThis.__c3Console ??= {};
  components[name] = await import(pathToFileURL(file));
}
const fixture = globalThis.__c3Console;
const idA='11111111-1111-4111-8111-111111111111',idB='22222222-2222-4222-8222-222222222222';
let calls=[];let timers=[];
function response(data,status=200) { const r=new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','sb-request-id':'correlation-fixture'}});return {data:status===200?data:null,error:status===200?null:{context:r},response:r}; }
function reset() {
  calls=[];timers=[];Object.assign(fixture,{role:'admin',rows:[{conversation_id:idA,evaluation_available:true,evaluation_id:null,overall_score:null,severity:null,review_status:null,channel_name:null,created_at:'2026-10-14',visitor_message_count:1,assistant_message_count:1}],states:[{conversation_id:idA,state:'dirty',revision:1}],
    invoke:async(name,options)=>{calls.push({name,body:options.body});return response({success:true,results:[],status:'queued'});} });
  globalThis.window={setTimeout:fn=>{timers.push(fn);return fn;},clearTimeout:fn=>{timers=timers.filter(x=>x!==fn);}};
}
function text(node) { return typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):node?.children?.map(text).join('')??''; }
function button(root,label) { return root.root.findAllByType('button').find(n=>text(n.toJSON?.()??{children:n.children})===label || n.props['aria-label']===label); }
async function mount(C,props={}) { let root;await act(async()=>{root=create(React.createElement(C,props));});return root; }
async function click(root,label) {const b=button(root,label);assert.ok(b,'button '+label);await act(async()=>{b.props.onClick();});}
const crmProps={conv:{id:idA},visitorLabel:'Synthetic visitor',onResolve(){},boundedContext:'Customer asks about delivery',contextRevisionKey:'r1',draftText:'',currentRole:'admin',onInsertDraft(){}};
const agentProps={conversationId:idA,convStatus:'pending',draftText:'',selectedMessage:null,onUseDraft(){},onClearSelection(){},autoLoadHandoffContext:true};

test('CRM mount, context updates and tab selection send zero model/KB calls; explicit contextual search still works',async()=>{
  reset();const root=await mount(components.crm.CRMPanel,crmProps);assert.equal(calls.length,0);
  await act(async()=>root.update(React.createElement(components.crm.CRMPanel,{...crmProps,boundedContext:'Changed request about returns',contextRevisionKey:'r2'})));
  await click(root,'Knowledge');assert.equal(calls.length,0);
  await click(root,'Search conversation knowledge');assert.equal(calls.length,1);assert.equal(calls[0].name,'kb-search-proxy');assert.equal(calls[0].body.query_mode,'auto_context');
  await act(async()=>root.unmount());
});
test('CRM Agent cannot dispatch KB by visiting its tab',async()=>{reset();const root=await mount(components.crm.CRMPanel,{...crmProps,currentRole:'agent'});await click(root,'Knowledge');assert.equal(calls.length,0);assert.equal(button(root,'Search conversation knowledge'),undefined);await act(async()=>root.unmount());});
test('CRM retains document/chunk lineage while rejecting below-threshold knowledge',async()=>{
 reset();fixture.invoke=async()=>response({success:true,results:[{display_label:'Published service',content:'Authorized service evidence',score:0.9,source_type:'knowledge',document_id:idA,chunk_id:idB,chunk_type:'full_content'},{display_label:'Weak unrelated source',content:'Must remain hidden',score:0.74,document_id:idB,chunk_id:idA,chunk_type:'full_content'}]});
 const root=await mount(components.crm.CRMPanel,crmProps);await click(root,'Knowledge');await click(root,'Search conversation knowledge');
 const cards=root.root.findAll(n=>n.props['data-document-id']===idA);assert.equal(cards.length,1);assert.equal(cards[0].props['data-chunk-id'],idB);assert(text(root.toJSON()).includes('Authorized service evidence'));assert(!text(root.toJSON()).includes('Must remain hidden'));await act(async()=>root.unmount());
});
for(const [body,status,label] of [[{error:'forbidden_tenant_role'},403,'Requires Admin or Supervisor role'],[{error:'kb_tenant_unresolved'},503,'Knowledge access is not configured'],[{error:'kb_api_error',failure:{code:'KB_TOOL_FAILURE',stage:'decode'}},502,'Knowledge response could not be verified'],[{error:'kb_api_error',detail:'KB_HTTP_503',failure:{stage:'provider_http'}},502,'Knowledge service could not complete'],[{success:true,results:[]},200,'No relevant knowledge found']])test('CRM actual HTTP/error body renders correct Knowledge state: '+label,async()=>{
 reset();fixture.invoke=async(name,options)=>{calls.push({name,body:options.body});return response(body,status);};
 const root=await mount(components.crm.CRMPanel,crmProps);await click(root,'Knowledge');await click(root,'Search conversation knowledge');
 const rendered=text(root.toJSON());assert(rendered.includes(label),rendered);assert.equal(calls.length,1);assert(!rendered.includes('KB_TOOL_FAILURE'));assert(!rendered.includes('UAT_REMOTE_BOUND_UNVERIFIED'));await act(async()=>root.unmount());
});
test('Agent handoff context requires explicit AI action and invalidates slow response after ticket switch',async()=>{
  reset();let finish;fixture.invoke=(name,options)=>{calls.push({name,body:options.body});return new Promise(resolve=>finish=resolve);};
  const root=await mount(components.agent.AgentToolPanel,agentProps);assert.equal(calls.length,0);
  await click(root,'Prepare handoff context with AI');assert.equal(calls.length,1);assert.equal(calls[0].body.tool_type,'handoff_context');
  await act(async()=>root.update(React.createElement(components.agent.AgentToolPanel,{...agentProps,conversationId:idB})));
  await act(async()=>finish(response({success:true,warm_handoff_package:{customer_goal:'OLD-TICKET-SECRET'}})));
  assert.equal(calls.length,1);assert.ok(!text(root.toJSON()).includes('OLD-TICKET-SECRET'));await act(async()=>root.unmount());
});
test('CE browse mounts and selects first dirty row without dispatch; explicit opt-in retains single guarded dwell',async()=>{
  reset();const root=await mount(components.ce.ReviewConsole,{canRun:true,canReview:true});assert.equal(timers.length,0);assert.equal(calls.length,0);
  const toggle=root.root.findAllByType('input').find(n=>n.props.type==='checkbox');assert.equal(toggle.props.checked,false);
  await act(async()=>toggle.props.onChange({target:{checked:true}}));assert.equal(timers.length,1);
  const fire=timers[0];await act(async()=>fire());assert.equal(calls.length,1);assert.equal(calls[0].body.source,'ce_dwell');
  await act(async()=>fire());assert.equal(calls.length,1);await act(async()=>root.unmount());
});
test('CE role without execution permission cannot opt in or dispatch',async()=>{reset();const root=await mount(components.ce.ReviewConsole,{canRun:false,canReview:false});assert.equal(root.root.findAllByType('input').find(n=>n.props.type==='checkbox').props.disabled,true);assert.equal(timers.length,0);assert.equal(calls.length,0);await act(async()=>root.unmount());});
test('CE opt-out, selection changes and unmount cancel pending dwell without model calls',async()=>{
  reset();const idC='33333333-3333-4333-8333-333333333333';fixture.rows=[{...fixture.rows[0],conversation_id:idC},{...fixture.rows[0],conversation_id:idB}];fixture.states=[{conversation_id:idC,state:'dirty',revision:2},{conversation_id:idB,state:'dirty',revision:2}];
  const root=await mount(components.ce.ReviewConsole,{canRun:true,canReview:true});const toggle=()=>root.root.findAllByType('input').find(n=>n.props.type==='checkbox');
  await act(async()=>toggle().props.onChange({target:{checked:true}}));assert.equal(timers.length,1);
  await act(async()=>toggle().props.onChange({target:{checked:false}}));assert.equal(timers.length,0);
  await act(async()=>toggle().props.onChange({target:{checked:true}}));
  await act(async()=>root.root.findAllByType('tr').find(n=>n.props.onClick&&text({children:n.children}).includes('22222222')).props.onClick());
  assert.equal(toggle().props.checked,false);assert.equal(timers.length,0);assert.equal(calls.length,0);
  await act(async()=>toggle().props.onChange({target:{checked:true}}));assert.equal(timers.length,1);await act(async()=>root.unmount());assert.equal(timers.length,0);
});
test('Analytics route denies Agent before any request and permits Supervisor summary without automatic detail',async()=>{
  reset();fixture.role='agent';let root=await mount(components.analytics.Route.component);assert.equal(calls.length,0);assert.ok(text(root.toJSON()).includes('Permission Denied'));await act(async()=>root.unmount());
  fixture.role='supervisor';fixture.invoke=async(name,options)=>{calls.push({name,body:options.body});return response({success:true,summary:{total_sessions:1,total_conversations:1,total_messages:2,feedback_count:0,average_rating:null,recent_sessions:[]}});};
  root=await mount(components.analytics.Route.component);assert.deepEqual(calls,[{name:'visitor-analytics',body:{mode:'summary'}}]);assert.ok(text(root.toJSON()).includes('Session detail reconciliation'));await act(async()=>root.unmount());
});
test('Analytics detail validates UUID, sends original authenticated API shape only on action, shows actual HTTP receipt and exact totals',async()=>{
  reset();fixture.invoke=async(name,options)=>{calls.push({name,body:options.body});return response({success:true,visitor:{conversations:[{status:'open',created_at:null,message_count:4,has_feedback:false,rating:null}]}});};
  const root=await mount(components.detail.VisitorAnalyticsDetail);assert.equal(calls.length,0);
  await act(async()=>root.root.findByType('input').props.onChange({target:{value:'bad'}}));await click(root,'Read session details');assert.equal(calls.length,0);
  await act(async()=>root.root.findByType('input').props.onChange({target:{value:idA}}));await click(root,'Read session details');
  assert.deepEqual(calls,[{name:'visitor-analytics',body:{visitor_session_id:idA}}]);assert.ok(text(root.toJSON()).includes('HTTP 200'));assert.ok(text(root.toJSON()).includes('Messages: 4'));await act(async()=>root.unmount());
});
test('Analytics detail preserves 403/404/500 error codes, clears data and permits a clean retry',async()=>{
  for(const [status,error]of [[403,'forbidden'],[404,'not_found'],[500,'analytics_query_failed']]){
    reset();fixture.invoke=async()=>response({error},status);const root=await mount(components.detail.VisitorAnalyticsDetail);
    await act(async()=>root.root.findByType('input').props.onChange({target:{value:idA}}));await click(root,'Read session details');assert.ok(text(root.toJSON()).includes('HTTP '+status));assert.ok(text(root.toJSON()).includes(error));assert.equal(root.root.findAllByType('table').length,0);
    fixture.invoke=async()=>response({success:true,visitor:{conversations:[]}});await click(root,'Read session details');assert.ok(text(root.toJSON()).includes('Conversations: 0'));await act(async()=>root.unmount());
  }
});
test('Analytics detail ignores old-session responses after input change',async()=>{
  reset();let finish;fixture.invoke=()=>new Promise(resolve=>finish=resolve);const root=await mount(components.detail.VisitorAnalyticsDetail);
  await act(async()=>root.root.findByType('input').props.onChange({target:{value:idA}}));await click(root,'Read session details');
  await act(async()=>root.root.findByType('input').props.onChange({target:{value:idB}}));await act(async()=>finish(response({success:true,visitor:{conversations:[{status:'OLD',message_count:999}]}})));
  assert.ok(!text(root.toJSON()).includes('999'));await act(async()=>root.unmount());
});
test('Analytics detail does not turn malformed successful HTTP data into complete counts',async()=>{
  reset();fixture.invoke=async()=>response({success:true,visitor:{conversations:[{status:'open',message_count:'unknown',has_feedback:false,rating:null}]}});
  const root=await mount(components.detail.VisitorAnalyticsDetail);await act(async()=>root.root.findByType('input').props.onChange({target:{value:idA}}));await click(root,'Read session details');
  assert.ok(text(root.toJSON()).includes('invalid_response'));assert.equal(root.root.findAllByType('table').length,0);await act(async()=>root.unmount());
});
test.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
