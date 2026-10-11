import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectTicketSummary} from '../../src/components/console/handoff-summary.ts';
const envelope=JSON.parse(readFileSync(process.argv[2],'utf8'));
const p=envelope.structured_package,c=p.handoff_context;
const summary=projectTicketSummary(envelope,p.conversation_id,p.company_id);
assert.ok(summary?.length);
assert.ok(summary[0].lines.includes(p.current_customer_goal));
assert.ok(summary.some(s=>s.title==='最新要求的處理狀態' && s.lines.some(l=>l.includes('尚未套用'))));
assert.ok(!summary.some(s=>s.title==='已核實產品資料'));
if(c.grounded_answer_history.length){
 const historical=summary.find(s=>s.title.startsWith('先前有 KB 依據'));
 assert.ok(historical?.lines.some(s=>s.includes('5,680')));
 assert.ok(summary.some(s=>s.title.startsWith('先前對話原文') && s.lines.length===c.prior_turns.length));
}
const facts=c.memory_snapshot?.memory.current_customer_facts;
if(facts?.length){
 const prior=summary.find(s=>s.title.startsWith('先前已提交的客人資料'));
 assert.ok(prior?.lines.some(l=>l.includes('count：0')));
 assert.ok(prior.lines.some(l=>l.includes('app：否')));
 assert.ok(prior.lines.some(l=>l.includes('availability：未確認')));
 assert.ok(!summary.some(s=>s.title==='客人提供的資料'));
}
assert.equal(projectTicketSummary(envelope,p.conversation_id,'wrong-company'),null);
const bad=structuredClone(envelope);bad.structured_package.handoff_context.current_request.source_message_id='wrong-source';
assert.equal(projectTicketSummary(bad,p.conversation_id,p.company_id),null);
console.log('C3_SECTION15_PERSISTED_CONSUMER|PASS|same_ticket|latest_request|prior_history|typed_facts|no_authority_promotion|tenant_source_denial');
