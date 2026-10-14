import test from 'node:test';
import assert from 'node:assert/strict';
import { readInboxConversations, readInboxPreviews } from '../src/lib/api/inbox-read.ts';

test('all scoped tickets remain searchable beyond the old 50-row and API 1000-row boundaries', async () => {
  const rows = Array.from({ length: 1305 }, (_, i) => ({ id: `ticket-${i}`, status: i === 1304 ? 'human_control' : 'open' }));
  const result = await readInboxConversations(async (from, to) => ({ data: rows.slice(from, to + 1), count: rows.length, error: null }));
  assert.equal(result.error, null);
  assert.deepEqual(result.data, rows);
  assert.equal(result.data.filter(row => row.status === 'human_control')[0].id, 'ticket-1304');
});

test('a later page error cannot publish a successful partial inbox', async () => {
  const rows = Array.from({ length: 505 }, (_, i) => ({ id: String(i) }));
  const result = await readInboxConversations(async (from, to) => from === 200
    ? { data: null, count: null, error: { message: 'read failed' } }
    : { data: rows.slice(from, to + 1), count: rows.length, error: null });
  assert.equal(result.data, null);
  assert.equal(result.error.message, 'read failed');
});

test('concurrent row movement, changed count and unexpectedly capped responses are rejected', async () => {
  const rows = Array.from({ length: 505 }, (_, i) => ({ id: String(i) }));
  for (const variant of ['duplicate', 'count-change', 'truncated']) {
    const result = await readInboxConversations(async (from, to) => ({
      data: variant === 'truncated' ? rows.slice(from, from + 50) : rows.slice(variant === 'duplicate' && from === 200 ? 0 : from, to + 1),
      count: variant === 'count-change' && from > 0 ? 506 : 505,
      error: null,
    }));
    assert.equal(result.data, null, variant);
    assert.ok(result.error, variant);
  }
});

test('a long busy conversation cannot hide another ticket preview; recalled and empty previews remain distinct', async () => {
  const messages = [
    ...Array.from({ length: 600 }, (_, i) => ({ conversation_id: 'busy', content: `message ${i}`, is_recalled: i === 0 })),
    { conversation_id: 'older', content: 'real older message', is_recalled: false },
  ];
  const result = await readInboxPreviews(['busy', 'older', 'empty'], async (_ids, from, to) => ({ data: messages.slice(from, to + 1), error: null }));
  assert.equal(result.error, null);
  assert.deepEqual(result.data, { busy: '[訊息已撤回]', older: 'real older message' });
});

test('preview batches stay scoped and failed reads never become no-messages results', async () => {
  const ids = Array.from({ length: 105 }, (_, i) => `ticket-${i}`);
  const batches = [];
  const result = await readInboxPreviews(ids, async batch => {
    batches.push(batch);
    return { data: batch.map(conversation_id => ({ conversation_id, content: 'message', is_recalled: false })), error: null };
  });
  assert.equal(Object.keys(result.data).length, 105);
  assert.deepEqual(batches.map(batch => batch.length), [50, 50, 5]);
  const foreign = await readInboxPreviews(['own'], async () => ({ data: [{ conversation_id: 'foreign', content: 'private', is_recalled: false }], error: null }));
  assert.equal(foreign.data, null);
  const failed = await readInboxPreviews(['own'], async () => ({ data: null, error: { message: 'unavailable' } }));
  assert.equal(failed.data, null);
});
