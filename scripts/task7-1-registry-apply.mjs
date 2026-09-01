import fs from 'node:fs';
const p='config/ai-chatbot-invariants.json';
const registry={
  version:'2026-09-01-task7.1',
  invariants:[
    {id:'INV-CONV-STATE-01',description:'All conversation-bound RAG and assist surfaces consume one canonical runtime-state projection with first-turn, current topic, corrections, constraints, jurisdiction and prior recommendations.',production_callers:['supabase/functions/generate-reply/index.ts','supabase/functions/agent-assist/index.ts','supabase/functions/kb-search-proxy/index.ts'],test:'node tests/task7-1-canonical-runtime.test.mjs'},
    {id:'INV-KB-APPLICABILITY-01',description:'Grounded factual output requires same-tenant explicit-published one-document evidence that is compatible with explicit jurisdiction and model/entity constraints.',production_callers:['supabase/functions/generate-reply/index.ts','supabase/functions/agent-assist/index.ts','supabase/functions/_shared/ce-grounding.ts'],test:'node tests/task7-1-canonical-runtime.test.mjs'},
    {id:'INV-KB-CANONICAL-CONSUMER-01',description:'Customer-facing generation and suggestions select evidence only through canonical-grounding; search discovery may return ranked candidates but cannot claim a factual grounded answer.',production_callers:['supabase/functions/generate-reply/index.ts','supabase/functions/agent-assist/index.ts','supabase/functions/_shared/ce-grounding.ts','supabase/functions/kb-search-proxy/index.ts'],test:'node tests/task7-1-canonical-runtime.test.mjs'}
  ],
  exemptions:[
    {path:'supabase/functions/kb-search-proxy/index.ts',invariant:'INV-KB-CANONICAL-CONSUMER-01',reason:'Discovery UI intentionally returns multiple ranked documents; it must use canonical conversation state but is not authorized to synthesize a customer-facing factual answer.'},
    {path:'supabase/functions/generated/task4-1-generate-reply.bundle.ts',invariant:'all',reason:'Frozen generated artifact, not an authoritative runtime entrypoint.'}
  ]
};
fs.writeFileSync(p,JSON.stringify(registry,null,2)+'\n');
console.log('TASK7_1_REGISTRY=PASS');
