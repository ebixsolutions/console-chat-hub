import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const fail = (message) => { console.error(`TASK6_3_FAIL=${message}`); process.exit(1); };
const must = (condition, message) => { if (!condition) fail(message); };
const read = (path) => fs.readFileSync(path, 'utf8');
const blob = (path) => execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim();

const frozenBlobs = {
  'supabase/functions/generate-reply/index.ts': '0cf21f6f3949974ee227c12cd00e8fcb0274bbe0',
  'supabase/functions/ce-evaluation-worker/index.ts': '85230c4af3592f169a7684d1899175a7ea543ffc',
  'supabase/functions/_shared/runtime-signal-lifecycle.ts': 'ee4fc601a90f459d89df8c7e3fbee14189a789ed',
  'supabase/migrations/20260901062000_task6_2_realtime_ce_dispatch.sql': '423e8b672fd7999a3fee76f5d3c91a71cd7312fc',
  'supabase/functions/_shared/escalation-rules.ts': '61f35b9bbba3f0db96e87d2774670e6edabb3e8f',
  'supabase/functions/_shared/escalation-signals.ts': 'a0ea11052dd1b313d86381bea361e09924f12e14',
  'supabase/functions/_shared/agent-assist-grounding.ts': '975cc7feb964e0f9b3d5dce18693c3414a867cbc'
};
for (const [path, expected] of Object.entries(frozenBlobs)) {
  must(fs.existsSync(path), `missing:${path}`);
  must(blob(path) === expected, `frozen_hash_mismatch:${path}`);
}

const generate = read('supabase/functions/generate-reply/index.ts');
must(generate.includes('buildContextualRetrievalQuery'), 'contextual_retrieval_missing');
must(generate.includes('const _semanticRetrieval = buildContextualRetrievalQuery('), 'contextual_query_not_used');
must(!generate.includes('const userQuery = _h1LastMsg;'), 'latest_message_direct_rag_regression');
must(generate.includes('buildRealtimeR3SentimentSignals'), 'current_turn_emotion_missing');
must(generate.includes('isHumanControlState(conversation.status'), 'human_control_guard_missing');
must(generate.includes('commitAiReplyWithControlGate'), 'atomic_reply_gate_missing');
must(generate.includes('persistExplicitR1IfRequested'), 'r1_runtime_missing');

const worker = read('supabase/functions/ce-evaluation-worker/index.ts');
must(worker.includes('body.source === "realtime"'), 'realtime_worker_mode_missing');
must(worker.includes('ce_claim_specific_job_v1'), 'specific_job_claim_missing');
must(worker.includes('processEvaluationJob(admin, job as AutomationJob)'), 'canonical_ce_engine_not_reused');
must(worker.includes('X-CE-Worker-Token'), 'worker_token_guard_missing');

const migration = read('supabase/migrations/20260901062000_task6_2_realtime_ce_dispatch.sql');
for (const marker of [
  "v_job.source in ('manual','ce_dwell','resolved','verified_correction')",
  'ce_dispatch_realtime_evaluation_v1',
  "jsonb_build_object('source','realtime','job_id',v_job_id)",
  'trg_zz_ce_realtime_assistant_dispatch',
  'revoke all on function public.ce_claim_specific_job_v1(uuid,text) from public, anon, authenticated',
  'grant execute on function public.ce_claim_specific_job_v1(uuid,text) to service_role'
]) must(migration.includes(marker), `migration_contract_missing:${marker}`);

const rollback = read('scripts/task6-3-production-rollback.sql');
for (const marker of [
  'drop trigger if exists trg_zz_ce_realtime_assistant_dispatch',
  'drop function if exists public.ce_realtime_assistant_message_trigger_v1()',
  'drop function if exists public.ce_dispatch_realtime_evaluation_v1(uuid)',
  "if not coalesce(v_cfg.enabled,false) then return jsonb_build_object('result','disabled'); end if",
  'grant execute on function public.ce_claim_specific_job_v1(uuid,text) to service_role'
]) must(rollback.includes(marker), `rollback_contract_missing:${marker}`);
must(!rollback.includes('v_interactive'), 'rollback_does_not_restore_pre_task6_2_claim');

const signals = read('supabase/functions/_shared/escalation-signals.ts');
const order = ['"E2"','"E1"','"R1"','"S0"','"R2"','"R3"','"P2"','"R4"','"P1"'];
let cursor = signals.indexOf('ESCALATION_FIRST_MATCH_ORDER');
must(cursor >= 0, 'escalation_order_missing');
for (const token of order) {
  const next = signals.indexOf(token, cursor);
  must(next >= cursor, `escalation_order_bad:${token}`);
  cursor = next + token.length;
}
const rules = read('supabase/functions/_shared/escalation-rules.ts');
must(/evaluateR3[\s\S]*?decision\("R3",\s*"recommend_handoff"/.test(rules), 'r3_must_remain_advisory');
must(/evaluateP1[\s\S]*?decision\("P1",\s*"suggest_handoff"/.test(rules), 'p1_must_remain_suggestion_only');

const smoke = JSON.parse(read('tests/fixtures/task6-3-20turn-smoke.json'));
must(Array.isArray(smoke.turns) && smoke.turns.length === 20, 'smoke_turn_count_not_20');
must(new Set(smoke.turns.map(t => t.turn)).size === 20, 'smoke_turn_ids_not_unique');
must(smoke.turns.every((t, i) => t.turn === i + 1), 'smoke_turn_order_invalid');
must(smoke.turns[0].message.includes('四電一腦'), 'smoke_known_kb_anchor_missing');
must(smoke.turns[1].expected_behavior === 'contextual_simplification', 'smoke_followup_assertion_missing');
must(smoke.turns[2].expected_behavior === 'contextual_categories', 'smoke_pronoun_assertion_missing');
must(smoke.turns[13].expected_behavior === 'topic_switch_clears_mars', 'smoke_topic_switch_missing');
must(smoke.turns[17].expected_behavior === 'constraint_no_guess', 'smoke_hallucination_guard_missing');
must(smoke.turns[19].expected_rule === 'R1' && smoke.turns[19].expected_handoff === true, 'smoke_final_r1_missing');
must(smoke.turns.slice(0, 12).every(t => t.expected_handoff === false), 'premature_required_handoff_in_smoke_contract');
must(smoke.post_turn_assertions.some(x => x.includes('human control')), 'human_control_post_assertion_missing');
must(smoke.post_turn_assertions.some(x => x.includes('canonical tenant/company')), 'canonical_ce_freshness_assertion_missing');

console.log('TASK6_3_FROZEN_6_1_6_2_HASHES=PASS');
console.log('TASK6_3_CONTEXTUAL_RAG_CONTRACT=PASS');
console.log('TASK6_3_REALTIME_CE_CONTRACT=PASS');
console.log('TASK6_3_ESCALATION_AND_HUMAN_CONTROL=PASS');
console.log('TASK6_3_20TURN_SMOKE_CONTRACT=PASS');
console.log('TASK6_3_ROLLBACK_CONTRACT=PASS');
console.log('TASK6_3_PREDEPLOY_GATE=PASS');
