import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateIdentity, candidateIdentityPlugin } from '../../vite.candidate-identity.mjs';

test('both profiles identify source binding without claiming runtime verification', () => {
  for (const [profile, ref] of [[true, 'nbtowfuvvfqpxqydyoby'], [false, 'nrfxhqabwblzxoushgnm']]) {
    const identity = candidateIdentity(profile);
    assert.equal(identity.sourceBackendRef, ref);
    assert.equal(identity.backendRuntimeVerified, false);
    assert.match(identity.head, /^[0-9a-f]{40}$/);
    assert.match(identity.tree, /^[0-9a-f]{40}$/);
    assert.match(identity.sourceSha256, /^[0-9a-f]{64}$/);
    assert.equal(identity.sourceSha256, candidateIdentity(profile).sourceSha256);
    assert.ok(!/publishable|secret|password|token/i.test(JSON.stringify(identity)));
  }
});
test('Widget asset and common build receipt carry exactly the same identity', () => {
  const identity = candidateIdentity(true), files = [];
  candidateIdentityPlugin(identity).generateBundle.call({ emitFile: file => files.push(file) });
  assert.deepEqual(JSON.parse(files.find(file => file.fileName === 'c3-candidate.json').source), identity);
  const widget = files.find(file => file.fileName === 'widget/chat.js').source;
  assert.ok(widget.startsWith('/* C3 candidate ' + JSON.stringify(identity) + ' */\n'));
});
