import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

function importTs(file) {
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
  const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${file}: ${errors.map((d) => String(d.messageText)).join('; ')}`);
  const tmp = path.join(os.tmpdir(), `t62-${process.pid}-${Date.now()}-${Math.random()}.mjs`);
  fs.writeFileSync(tmp, compiled.outputText);
  return import(pathToFileURL(tmp).href).finally(() => { try { fs.unlinkSync(tmp); } catch {} });
}

const signals = await importTs('supabase/functions/_shared/runtime-signal-lifecycle.ts');
let s = signals.classifyCurrentTurnEmotion('你哋真係太離譜，我好嬲。');
assert.equal(s.anger_flag, true);
assert.ok(s.sentiment_score < -0.7);

s = signals.buildRealtimeR3SentimentSignals('This is unacceptable and I am angry.', {
  sentiment_score: -0.3,
  sentiment_trend: [0.2, -0.1, -0.3],
  evaluation_id: 'eval-1',
  provider_version: 'ce-history',
});
assert.equal(s.anger_flag, true);
assert.deepEqual(s.sentiment_trend, [0.2, -0.1, -0.3, -0.85]);
assert.equal(s.evaluation_id, 'eval-1');

s = signals.buildRealtimeR3SentimentSignals('Thanks, I understand now.', {
  sentiment_score: -0.7,
  sentiment_trend: [-0.4, -0.7],
  evaluation_id: 'eval-2',
  provider_version: 'ce-history',
});
assert.equal(s.sentiment_recovered_same_turn, true);
assert.ok(s.sentiment_score > 0);

assert.equal(signals.buildRealtimeR3SentimentSignals('那包括哪些種類？', { sentiment_score: -0.8, sentiment_trend: [-0.8] }), undefined, 'neutral current turn must not inherit stale anger/negative score');

const gen = fs.readFileSync('supabase/functions/generate-reply/index.ts', 'utf8');
const worker = fs.readFileSync('supabase/functions/ce-evaluation-worker/index.ts', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260901062000_task6_2_realtime_ce_dispatch.sql', 'utf8');
const intelligence = fs.readFileSync('supabase/functions/_shared/conversation-intelligence.ts', 'utf8');

assert.match(gen, /buildRealtimeR3SentimentSignals/);
assert.match(gen, /const _pr5HistoricalR3Sentiment = await loadAuthoritativeR3SentimentSignals/);
assert.match(gen, /const _pr5R3Sentiment = buildRealtimeR3SentimentSignals/);
assert.match(gen, /ce-emotion-history-v1\.0/);
assert.doesNotMatch(gen, /freshness\.state !== "up_to_date"/);
assert.match(gen, /buildCustomerAdvisoryContext\(\{[\s\S]*anger_flag: _pr5R3Sentiment\?\.anger_flag/);
assert.match(gen, /predicted_csat: _pr5P1Signals\?\.predicted_csat/);

const humanGuardIndex = gen.indexOf('if (isHumanControlState(conversation.status, conversation.assigned_agent_id ?? null))');
const sourceLoadIndex = gen.indexOf('const sourceResult = await loadSourceVisitorMessage', humanGuardIndex);
assert.ok(humanGuardIndex >= 0 && sourceLoadIndex > humanGuardIndex, 'human control must gate before generation inputs');
assert.match(intelligence, /assignedAgentId.*return true/s);
assert.match(intelligence, /pending.*transferred.*human_needed.*human_control/s);

assert.match(worker, /body\.source === "realtime"/);
assert.match(worker, /ce_claim_specific_job_v1/);
assert.match(worker, /processEvaluationJob\(admin, job as AutomationJob\)/);
assert.match(migration, /v_interactive := v_job\.source in \('manual','ce_dwell','resolved','verified_correction'\)/);
assert.match(migration, /not coalesce\(v_cfg\.enabled,false\) and not v_interactive/);
assert.match(migration, /ce_dispatch_realtime_evaluation_v1/);
assert.match(migration, /'source','realtime','job_id',v_job_id/);
assert.match(migration, /trg_zz_ce_realtime_assistant_dispatch/);
assert.match(migration, /new\.role='assistant'/);
assert.match(migration, /revoke all on function public\.ce_claim_specific_job_v1\(uuid,text\) from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.ce_claim_specific_job_v1\(uuid,text\) to service_role/);

console.log('TASK6_2_RUNTIME_LIFECYCLE_TESTS=PASS');
