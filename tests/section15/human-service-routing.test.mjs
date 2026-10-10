import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { classifyHumanServiceDiscussion, classifyHandoffIntent } from '../../supabase/functions/_shared/handoff-intent.ts';
import { planConversationService, renderServicePlanReply } from '../../supabase/functions/_shared/conversation-service-planner.ts';
import { isDirectViolentThreat } from '../../supabase/functions/_shared/e2-direct-threat.ts';

const source = readFileSync(new URL('../../supabase/functions/generate-reply/index.ts', import.meta.url), 'utf8');
const syntax = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
// Execute the actual source functions/preflight, replacing external persistence
// and activated-rule adapters only. These are source-runtime tests, not hosted
// receipts or native database acceptance.
function functionSource(name) {
  const declaration = syntax.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(syntax).replace(/^async /, '');
}
function compile(code, bindings) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(js, { Response, JSON, ...bindings });
}
const defaults = { language: 'zh-TW', memory: null, commerce: null,
  recall: { handled: false, reason: 'NOT_A_RECALL_QUERY', detail: 'CUSTOMER_STATEMENT_NOT_QUERY' } };
const controls = [
  ['如果遲啲需要真人跟進，可以點安排？', true],
  ['剛才嗰句『幫我轉真人客服』係引用舊對話，唔係而家要求。', false],
  ['假設客人話要轉真人，通常點處理？', true],
  ['等聽日再轉真人客服', false],
  ['如果一直未解決，再轉真人客服', false],
  ['請不要轉人工客服', false],
  ['我唔係而家要求轉真人客服', false],
  ['客人話「請轉真人客服」', false],
  ['你頭先話可以轉真人客服', false],
  ['「請轉真人客服」', false],
  ['可唔可以轉真人客服？', false],
  ['真人客服轉交流程係點？', true],
  ['如果以后需要人工客服，通常怎么安排？', true],
  ['假设客户要求转人工客服，通常怎么处理？', true],
  ['那句话是引用转人工客服，不是现在的要求。', false],
  ['不要转人工客服', false],
  ['If I need a human agent later, how does the process work?', true],
  ['Suppose a customer asks to transfer to a human agent, what happens?', true],
  ['The customer said: "Please transfer me to a human"', false],
  ['That quoted human agent request is not my request now.', false],
  ['Do not transfer me to a human', false],
  ['How does human support work?', true],
];
const evidence = ['真人客服係咪24小時？', '人工客服什么时候上班？', '真人客服有冇人當值？',
  'What are human support hours?', 'Is a human agent available now?', 'What is the human support SLA?',
  '人工客服服务时间是什么？', '真人客服收費幾多？'];
const business = ['如果之後要真人客服，CW-SUL70BA 價錢幾多？', '唔好轉真人客服，幫我查最新運費',
  'How much does CW-SUL70BA cost, and how does human support work?',
  '假设转人工客服，先查询产品库存', '唔好轉真人客服，總結我之前嘅要求',
  'What did the human agent say about my order?', '真人客服以後再講；它呢？',
  '真人客服流程係點；我要更改地址', '那個人工成本是多少？',
  '真人客服如何幫我預訂酒店？', 'How does a human agent help me reserve a hotel?',
  '真人客服流程係點同埋保險賠償點申請？'];
const immediate = ['請轉真人客服', '麻煩更正回收要求，簡單總結前文，並轉真人客服跟進。',
  'Please summarize my order; please connect me to a human agent', '请转人工客服',
  '剛才不是要轉真人。請轉真人客服', '唔好自動轉真人；我而家要真人客服'];

for (const [question, process] of controls) test(`control/process source-runtime: ${question}`, async () => {
  const discussion = classifyHumanServiceDiscussion(question);
  assert.equal(discussion.kind, 'control_or_process');
  assert.equal(discussion.handoff.explicit_request, false);
  assert.equal(discussion.process_question, process);
  const plan = planConversationService({ ...defaults, question });
  assert.equal(plan.action, 'handoff_context_acknowledgement');
  assert.equal(plan.knowledge_state, 'not_needed');
  assert.equal(plan.kb_query, null);
  assert.deepEqual(plan.missing_slots, []);
  assert.equal(plan.handoff_requested, false);
  const reply = renderServicePlanReply(plan, null);
  assert.ok(reply);
  assert.doesNotMatch(reply, /型號|型号|missing requirements|authority conflict/i);
  if (process) assert.match(reply, /同一對話|同一对话|this conversation/);
  if (question.includes('引用') || question.includes('quoted')) assert.match(reply, /引用|reference/);
  const calls = [];
  const persist = compile(`async ${functionSource('persistHumanServiceDiscussion')}\npersistHumanServiceDiscussion`, {
    classifyHumanServiceDiscussion, planConversationService, renderServicePlanReply, corsHeaders: {},
    commitAiReplyWithControlGate: async (...args) => { calls.push(args); return { ok: true, idempotent: false }; },
    cleanupThinking: async () => {},
  });
  const result = await (await persist({}, 'ticket', 'source', question, 'zh-TW')).json();
  assert.equal(result.response_route, 'human_service_control_or_process');
  assert.equal(result.handoff_required, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1, 3), ['ticket', 'source']);
  assert.equal(calls[0][4].commerce_state_persistence_classification, 'NO_SEMANTIC_CHANGE');
});
for (const question of evidence) test(`merchant evidence retained: ${question}`, () => {
  assert.equal(classifyHumanServiceDiscussion(question).kind, 'merchant_evidence');
  const plan = planConversationService({ ...defaults, question });
  assert.equal(plan.action, 'published_kb_lookup');
  assert.equal(plan.knowledge_state, 'lookup_required');
  assert.equal(JSON.parse(plan.kb_query).question, question.normalize('NFKC'));
  assert.equal(renderServicePlanReply(plan, null), null);
});
for (const question of business) test(`mixed/unknown business semantic path retained: ${question}`, () => {
  assert.equal(classifyHumanServiceDiscussion(question).kind, 'business_or_mixed');
});
for (const question of immediate) test(`canonical immediate R1 retained: ${question}`, () => {
  assert.equal(classifyHumanServiceDiscussion(question).kind, 'immediate');
  assert.equal(classifyHandoffIntent(question).explicit_request, true);
});
for (const question of ['CW-SUL70BA 最新價錢？', '總結之前要求', '它呢？', 'Can you repeat my requirements?'])
  test(`non-service turn retained: ${question}`, () => assert.equal(classifyHumanServiceDiscussion(question).kind, 'none'));

const preflight = source.slice(source.indexOf('  const _criticalE2ExpectedTenantId ='), source.indexOf('  const _naturalCustomerIntent ='));
async function runPreflight(question, { compliance = false, commitResult = { ok: true, idempotent: false } } = {}) {
  const calls = [];
  const bindings = { question, sourceMessageId: 'source', classifyHumanServiceDiscussion, classifyHandoffIntent,
    isDirectViolentThreat, E2_LOCAL_THREAT_CLASSIFIER_VERSION: 'e2-local-threat-v1.0',
    planConversationService, renderServicePlanReply, corsHeaders: {}, Deno: { env: {} },
    isE2LiveActivationEnabled: () => true, isE1LiveActivationEnabled: () => true,
    resolveAuthoritativeComplianceReview: () => compliance, isGreetingOrTrivial: () => false,
    evaluateAndPersistRequiredRulesLive: async (_, ctx) => {
      calls.push(['rules', ctx]);
      if (ctx.threat_flag?.value || ctx.compliance_jurisdiction_requires_human_review) return new Response(JSON.stringify({ rule: 'E2' }));
      if (ctx.verified_local_risk_classification && ctx.topic_risk_level === 'high') return new Response(JSON.stringify({ rule: 'E1' }));
      return null;
    },
    persistExplicitR1IfRequested: async (_, ticket, sourceId) => {
      calls.push(['R1', ticket, sourceId]); return new Response(JSON.stringify({ rule: 'R1' }));
    },
    commitAiReplyWithControlGate: async (...args) => { calls.push(['B2', ...args]); return commitResult; },
    cleanupThinking: async () => {},
  };
  const run = compile(`${functionSource('classifyAuthoritativeThreat')}\n${functionSource('classifyLocalTopicRisk')}\nasync ${functionSource('persistHumanServiceDiscussion')}\n(async () => {
    const _h1LastMsg=question, _explicitHandoffRequested=classifyHandoffIntent(question).explicit_request;
    const conversation={company_id:'tenant',status:'open',assigned_agent_id:null}, supabaseAdmin={};
    const conversation_id='ticket', source_message_id=sourceMessageId, _h1SourceMessageId=sourceMessageId;
    const _visitorLang='zh-TW', _pr5History={}, flags={ENABLE_KB:true};
    ${preflight}
    return new Response(JSON.stringify({continuation:'semantic_KB_memory'}));
  })()`, bindings);
  return { result: await (await run).json(), calls };
}
test('actual preflight executes service response before semantic/recall/C1', async () => {
  for (const [question] of controls.slice(0, 3)) {
    const { result, calls } = await runPreflight(question);
    assert.equal(result.response_route, 'human_service_control_or_process');
    assert.equal(calls.filter(c => c[0] === 'B2').length, 1);
    assert.ok(calls.every(c => c[0] !== 'R1'));
  }
});
test('actual preflight retains factual and mixed continuation', async () => {
  for (const question of [...business, ...evidence]) {
    const { result, calls } = await runPreflight(question);
    assert.equal(result.continuation, 'semantic_KB_memory');
    assert.equal(calls.filter(c => c[0] === 'B2').length, 0);
  }
});
test('pure service control overrides unrelated prior canonical recall without changing memory', () => {
  const memory = { current_goal: '舊產品目的', current_topic: '冷氣', customer_preferences: [], active_constraints: [] };
  const before = JSON.stringify(memory);
  const plan = planConversationService({ ...defaults, memory, question: controls[1][0],
    recall: { handled: true, reason: 'CANONICAL_MEMORY', detail: 'prior requirements', reply: 'unrelated requirements' } });
  assert.equal(plan.action, 'handoff_context_acknowledgement');
  assert.doesNotMatch(renderServicePlanReply(plan, 'unrelated requirements'), /unrelated requirements/);
  assert.equal(JSON.stringify(memory), before);
});
test('genuinely qualifying threat E2 precedes explicit R1 in actual preflight', async () => {
  const { result, calls } = await runPreflight('我要殺死你。請轉真人客服');
  assert.equal(result.rule, 'E2'); assert.equal(calls[0][1].threat_flag.value, true);
  assert.ok(calls.every(c => c[0] !== 'R1' && c[0] !== 'B2'));
});
test('genuinely qualifying refund E1 precedes explicit R1 in actual preflight', async () => {
  const { result, calls } = await runPreflight('我要退款。請轉真人客服');
  assert.equal(result.rule, 'E1');
  assert.equal(calls[0][1].verified_local_risk_classification, true);
  assert.equal(calls[0][1].rag_match_state, 'not_checked');
  assert.ok(calls.every(c => c[0] !== 'R1' && c[0] !== 'B2'));
});
test('authoritative compliance E2 precedes a pure process response', async () => {
  const { result } = await runPreflight(controls[0][0], { compliance: true });
  assert.equal(result.rule, 'E2');
});
test('ordinary explicit R1 retains existing handoff adapter', async () => {
  const { result } = await runPreflight(immediate[0]); assert.equal(result.rule, 'R1');
});
for (const result of ['human_control', 'resolved', 'superseded_source', 'source_already_replied',
  'tenant_mismatch', 'invalid_b2_revision_proof', 'stale_authorized_revision', 'invalid_source_message', 'b2_block'])
  test(`actual response adapter preserves guarded persistence refusal: ${result}`, async () => {
    const { result: response, calls } = await runPreflight(controls[0][0], { commitResult: { ok: false, result } });
    assert.ok(response.skipped === result || response.error === `human_service_commit_${result}`);
    assert.equal(response.reply, undefined);
    assert.equal(calls.filter(c => c[0] === 'B2').length, 1);
  });
