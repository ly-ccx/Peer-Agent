import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeWorkbenchOpenMap,
  resolveWorkbenchOpen,
  updateWorkbenchOpen,
  workbenchOpenKey,
} from './workbenchOpenState.ts';

test('keeps workbench expansion independent for each conversation', () => {
  let state = normalizeWorkbenchOpenMap(null);
  state = updateWorkbenchOpen(state, 'conversation-a', true);
  state = updateWorkbenchOpen(state, 'conversation-b', false);

  assert.equal(resolveWorkbenchOpen(state, 'conversation-a'), true);
  assert.equal(resolveWorkbenchOpen(state, 'conversation-b'), false);
  assert.equal(resolveWorkbenchOpen(state, 'conversation-c'), false);
});

test('uses the legacy global value only as the default for unmigrated conversations', () => {
  const state = updateWorkbenchOpen({}, 'conversation-a', false);
  assert.equal(resolveWorkbenchOpen(state, 'conversation-a', true), false);
  assert.equal(resolveWorkbenchOpen(state, 'conversation-b', true), true);
  assert.equal(workbenchOpenKey(null), '__none');
});

test('normalization drops non-boolean persisted values', () => {
  assert.deepEqual(normalizeWorkbenchOpenMap({ a: true, b: 'false', c: 0 }), { a: true });
});
