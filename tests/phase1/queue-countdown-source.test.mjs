import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Focused source unit tests. These are neither browser UAT nor UX scores.
const source = readFileSync('public/widget/chat.js', 'utf8');
const functions = source.slice(source.indexOf('  function parseQueueEstimate('), source.indexOf('  function saveSession('));
const context = vm.createContext({ Number, Date, String, Math, performance: { now: () => 1000 },
  panel: null, state: { conversationId: 'fixture' }, document: { hidden: false },
  pollActive: true, setTimeout: () => 1, clearTimeout: () => {}, queueEstimate: null, queueEstimateTimer: null });
vm.runInContext(functions, context);
const snapshot = () => ({ state: 'waiting', estimated_wait_minutes: 2, estimate_basis: 'a'.repeat(32),
  estimate_generated_at: '2026-10-06T01:00:00Z', estimate_deadline: '2026-10-06T01:02:00Z', server_now: '2026-10-06T01:01:00Z' });

test('server deadline is anchored to monotonic time, not client wall clock', () => {
  assert.equal(context.parseQueueEstimate(snapshot(), 1000).target, 61000);
});
test('old ETA-only response cannot invent a countdown', () => {
  assert.equal(context.parseQueueEstimate({ state: 'waiting', estimated_wait_minutes: 2 }, 1000), null);
});
test('assigned and absent queue do not produce a countdown', () => {
  for (const state of ['assigned', 'none']) assert.equal(context.parseQueueEstimate({ ...snapshot(), state }, 1000), null);
});
test('unknown ETA cannot reuse stale forecast fields', () => {
  assert.equal(context.parseQueueEstimate({ ...snapshot(), estimated_wait_minutes: null }, 1000), null);
});
test('malformed, timezone-free and reversed timestamps are rejected', () => {
  for (const value of ['invalid', '2026-10-06T01:02:00', '2026-10-06T00:59:00Z'])
    assert.equal(context.parseQueueEstimate({ ...snapshot(), estimate_deadline: value }, 1000), null);
});
test('future generation and invalid estimate basis are rejected', () => {
  assert.equal(context.parseQueueEstimate({ ...snapshot(), estimate_generated_at: '2026-10-06T01:01:30Z' }, 1000), null);
  assert.equal(context.parseQueueEstimate({ ...snapshot(), estimate_basis: 'unverified' }, 1000), null);
});
test('elapsed forecast stops at zero and does not promise assignment', () => {
  const timer = { textContent: '' };
  context.panel = { querySelector: () => timer };
  context.queueEstimate = { conversationId: 'fixture', target: 0 };
  context.renderQueueEstimate();
  assert.match(timer.textContent, /still in the queue/);
  assert.equal(context.queueEstimateTimer, null);
});
test('hidden page renders elapsed time without scheduling a background timer', () => {
  const timer = { textContent: '' };
  context.panel = { querySelector: () => timer };
  context.queueEstimate = { conversationId: 'fixture', target: 61000 };
  context.document.hidden = true;
  context.renderQueueEstimate();
  assert.match(timer.textContent, /1:00/);
  assert.equal(context.queueEstimateTimer, null);
  context.document.hidden = false;
});
test('previous conversation cannot render its countdown into a new session', () => {
  const timer = { textContent: '' };
  context.panel = { querySelector: () => timer };
  context.queueEstimate = { conversationId: 'previous', target: 61000 };
  context.renderQueueEstimate();
  assert.equal(timer.textContent, '');
});
test('poll payload preserves all server forecast fields', () => {
  const api = readFileSync('supabase/functions/widget-poll-messages/index.ts', 'utf8');
  for (const field of ['estimate_generated_at', 'estimate_deadline', 'estimate_basis', 'server_now'])
    assert.ok(api.includes(`${field}: queueSnapshot.${field} ?? null`));
});
