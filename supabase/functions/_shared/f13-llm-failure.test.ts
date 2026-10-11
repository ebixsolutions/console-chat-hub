import {withMockAccounting} from "../../../tests/model-accounting/provider-fixture.ts";
/** Fully intercepted provider calls. No network, production credential or model quota. */
import {callModel} from './llm-router.ts';
const assert=(v:unknown,m:string)=>{if(!v)throw Error(m)};
Deno.test('F13 invalid-output classes retain diagnostic cause and HTTP status, never accept truncated JSON',async()=>{
 const names=['LLM_PROVIDER','LLM_MODEL_EVALUATION','ANTHROPIC_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SECRET_KEY'];
 const saved=names.map(n=>Deno.env.get(n));const original=globalThis.fetch;
 try {
  Deno.env.set('LLM_PROVIDER','anthropic');Deno.env.set('LLM_MODEL_EVALUATION','isolated-test-model');Deno.env.set('ANTHROPIC_API_KEY','isolated-fake-key');Deno.env.set('SUPABASE_URL','http://accounting.mock');Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','mock-service-key');Deno.env.set('SUPABASE_SECRET_KEY','mock-service-key');
  const cases=[{body:'{',status:200,code:'LLM_INVALID_OUTPUT',reason:'response_json'},
   {body:'null',status:200,code:'LLM_INVALID_OUTPUT',reason:'response_schema'},
   {body:JSON.stringify({content:[]}),status:200,code:'LLM_INVALID_OUTPUT',reason:'empty'},
   {body:JSON.stringify({content:[{type:'text',text:'{"valid":"looking"}'}],stop_reason:'max_tokens',usage:{output_tokens:1800}}),status:200,code:'LLM_INVALID_OUTPUT',reason:'truncated'},
   {body:'{}',status:400,code:'LLM_NON_2XX',reason:undefined}];
  for (const c of cases) {
   let count=0;globalThis.fetch=withMockAccounting(async()=>{count++;return new Response(c.body,{status:c.status})});
   const r=await callModel({purpose:'evaluation',system:'JSON only',user:'customer supplied requirements',maxTokens:1800,operationId:'isolated-f13',companyId:'isolated-company',conversationId:'isolated-conversation',tag:'isolated-f13',responseFormat:'json'});
   assert(!r.ok && r.code===c.code && r.status===c.status && r.invalid_output_reason===c.reason,JSON.stringify(r));
   assert(count===1,'invalid output was retried or a live request escaped interception');
  }
  const controller=new AbortController();controller.abort();globalThis.fetch=async()=>{throw Error('aborted request attempted network')};
  const r=await callModel({purpose:'evaluation',system:'JSON only',user:'customer requirements',maxTokens:1800,operationId:'isolated-timeout',companyId:'isolated-company',conversationId:'isolated-conversation',tag:'isolated-f13',signal:controller.signal});
  assert(!r.ok && r.code==='LLM_TIMEOUT','timeout reclassified as invalid output');
 } finally {globalThis.fetch=original;names.forEach((n,i)=>saved[i]===undefined?Deno.env.delete(n):Deno.env.set(n,saved[i]!));}
});
