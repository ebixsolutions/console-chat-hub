import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyHandoffIntent, isExplicitHandoffRequest } from '../../supabase/functions/_shared/handoff-intent.ts';

// Pure canonical runtime classifier — no mocks, model calls, cookies or DB writes.
const positives = [
  '請轉真人客服',
  '轉真人客服幫我跟進',
  '麻煩簡單總結一下，並轉真人客服跟進',
  '更正：我想問維修安排。請記住呢個更正，簡單總結前文，並轉真人客服幫我跟進。',
  '幫我更正租車地點，同時搵真人客服接手',
  '我想轉真人客服',
  '交畀真人客服處理',
  '麻煩轉人工客服幫我處理',
  'please transfer me to a human',
  'Summarize my booking; please connect me to a human agent',
  'Transfer this conversation to a human agent',
];
const negatives = [
  '唔好轉真人，幫我再講清楚',
  '不要轉真人客服',
  '如果一直未解決，再轉真人客服',
  '假設你唔識答，請轉真人客服',
  '等聽日再轉真人客服',
  '客人話「請轉真人客服」',
  '客人話，請轉真人客服',
  '「請轉真人客服」',
  '真人客服係咪24小時？',
  '你頭先話可以轉真人客服',
  '可唔可以轉真人客服？',
  'If this fails, transfer to a human agent',
  'Do not transfer me to a human',
  'The customer said: "Please transfer me to a human"',
  '"Please transfer me to a human"',
];
for (const sentence of positives) test(`explicit R1: ${sentence}`, () => {
  const result=classifyHandoffIntent(sentence);
  assert.equal(result.explicit_request,true,JSON.stringify(result));
  assert.equal(isExplicitHandoffRequest(sentence),true);
});
for (const sentence of negatives) test(`do not escalate: ${sentence}`, () => {
  const result=classifyHandoffIntent(sentence);
  assert.equal(result.explicit_request,false,JSON.stringify(result));
  assert.equal(isExplicitHandoffRequest(sentence),false);
});

test('orchestration early R1 must follow E2 and precede semantic LLM, through B2/RPC', () => {
  const source=readFileSync(fileURLToPath(new URL('../../supabase/functions/generate-reply/index.ts',import.meta.url)),'utf8');
  const handler=source.slice(source.indexOf('async function orchestrationGenerateReply('));
  const e2=handler.indexOf('const _criticalE2ThreatSignal');
  const early=handler.indexOf('const _preSemanticR1DeferredForE1');
  const r1=handler.indexOf('const earlyR1 = await persistExplicitR1IfRequested(');
  const semantic=handler.indexOf('await interpretCommerceSemantics(');
  assert.ok(e2>=0 && early>e2 && r1>early && semantic>r1);
  const p=source.slice(source.indexOf('async function persistExplicitR1IfRequested('));
  assert.ok(p.indexOf('await executeB2RpcPersistence(')>0);
  assert.ok(p.indexOf('supabaseAdmin.rpc("explicit_handoff_tx"')>0);
  assert.match(handler.slice(early,r1),/isE1LiveActivationEnabled\(Deno\.env\)/);
});
