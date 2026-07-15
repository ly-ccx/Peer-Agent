import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkbenchTab, normalizeWorkbenchTabMap } from './workbenchTabState.ts';

test('migrates legacy workbench capability ids', () => {
  assert.equal(normalizeWorkbenchTab('goal'), 'plan');
  assert.equal(normalizeWorkbenchTab('terminal'), 'plan');
  assert.equal(normalizeWorkbenchTab('diff'), 'documents');
});

test('normalizes a persisted tab map and drops invalid values', () => {
  assert.deepEqual(normalizeWorkbenchTabMap({
    a: 'diff',
    b: 'browser',
    c: 'unknown',
    d: null,
  }), {
    a: 'documents',
    b: 'browser',
  });
});
