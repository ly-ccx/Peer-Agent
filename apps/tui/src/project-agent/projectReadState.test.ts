import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectReadState } from './projectReadState.ts';

test('a rejected or thrown collection read preserves only the current scoped snapshot', () => {
  const state = createProjectReadState();
  assert.deepEqual(state.read('memory', () => ['known']), { rows: ['known'], error: false });
  assert.deepEqual(state.read('memory', () => { throw Error('offline'); }), { rows: ['known'], error: true });
  assert.deepEqual(state.read('objectives', () => ({ ok: false })), { rows: [], error: true });
  assert.deepEqual(state.read('objectives', () => ({ ok: true, items: [] })), { rows: [], error: false });
  assert.deepEqual(createProjectReadState().read('memory', () => { throw Error('other workspace'); }), { rows: [], error: true });
});
