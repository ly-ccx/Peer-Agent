import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileFacts } from './reconcileFacts.ts';

test('unchanged rows retain identity while changes and ordering remain observable', () => {
  const first = { id: 'a', gate: { state: 'pending', refs: ['one'] } };
  const second = { id: 'b', gate: { state: 'done', refs: [] } };
  const old = [first, second];
  assert.equal(reconcileFacts(old, structuredClone(old), row => row.id), old);
  const next = reconcileFacts(old, [structuredClone(second), { ...first, gate: { state: 'approved', refs: ['one'] } }], row => row.id);
  assert.equal(next[0], second); assert.notEqual(next[1], first);
  assert.equal(next[1]?.gate.state, 'approved');
  assert.equal(reconcileFacts(old, [], row => row.id).length, 0);
});
