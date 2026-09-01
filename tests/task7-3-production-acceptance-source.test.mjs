import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=(p)=>fs.readFileSync(p,'utf8');
const gen=read('supabase/functions/generate-reply/index.ts');
const assist=read('supabase/functions/agent-assist/index.ts');
const proxy=read('supabase/functions/kb-search-proxy/index.ts');
const shadow=read('supabase/functions/_shared/escalation-shadow.ts');
const signals=read('supabase/functions/_shared/escalation-signals.ts');
const migration=read('supabase/migrations/20260901073000_task7_2_ce_human_control_state_closure.sql');
const invariants=JSON.parse(read('config/ai-chatbot-invariants.json'));

assert.equal(invariants.version,'2026-09-01-task7.1');
for(const token of ['buildCanonicalRetrievalQuery','buildCanonicalContinuityBlock','selectCanonicalGrounding']) assert.match(gen,new RegExp(token));
assert.doesNotMatch(gen,/buildContextualRetrievalQuery/);
assert.doesNotMatch(gen,/selectGroundedDocument/);
assert.match(assist,/buildCanonicalAssistRetrievalQuery/);
assert.match(assist,/selectCanonicalGrounding/);
assert.match(proxy,/buildCanonicalRetrievalQuery/);
assert.match(proxy,/MAX_CONTEXT_MESSAGES = 200/);
assert.match(shadow,/resolveSentimentProvenance/);
assert.match(shadow,/current-turn-emotion-v1\.0/);
assert.match(shadow,/ADVISORY_RULE_DECISION_DOWNGRADED/);
assert.match(signals.replace(/\s+/g,' '),/ESCALATION_FIRST_MATCH_ORDER = \[ "E2", "E1", "R1", "S0", "R2", "R3", "P2", "R4", "P1", \] as const/);
for(const fn of ['return_to_ai_tx','takeover_conversation_tx','assign_conversation_tx','kb_fallback_handoff_tx']){
 const start=migration.indexOf(`function public.${fn}`); assert.ok(start>=0,`${fn} missing`);
 const next=migration.indexOf('create or replace function public.',start+30);
 const body=migration.slice(start,next<0?migration.length:next).toLowerCase();
 assert.match(body,/status in \('resolved','closed'\)/,`${fn} closed terminal guard missing`);
}
for(const token of ['v_revision_current','v_methodology_current','v_snapshot_current','superseded_revision','superseded_methodology','superseded_snapshot']) assert.ok(migration.includes(token),`CE freshness token missing: ${token}`);
assert.match(migration,/new\.assigned_agent_id is not null/);
assert.match(migration,/status=v_new_status/);
console.log('TASK7_3_SOURCE_ACCEPTANCE=PASS');
