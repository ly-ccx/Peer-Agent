import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorkbenchTab, normalizeWorkbenchTabMap } from './workbenchTabState.ts';

test('migrates legacy workbench capability ids', () => {
  assert.equal(normalizeWorkbenchTab('goal'), 'plan');
  assert.equal(normalizeWorkbenchTab('terminal'), 'plan');
  assert.equal(normalizeWorkbenchTab('diff'), 'documents');
  assert.equal(normalizeWorkbenchTab('background'), 'plan');
  assert.equal(normalizeWorkbenchTab('shell'), 'plan');
  assert.equal(normalizeWorkbenchTab('threads'), 'plan');
  // 任务监控栏已归 ChatSurface；旧 Workbench 值回退到 plan，不能恢复空白 tab。
  assert.equal(normalizeWorkbenchTab('context'), 'plan');
  assert.equal(normalizeWorkbenchTab('monitor'), 'plan');
});

test('normalizes a persisted tab map and drops invalid values', () => {
  assert.deepEqual(normalizeWorkbenchTabMap({
    a: 'diff',
    b: 'browser',
    c: 'unknown',
    d: null,
    e: 'threads',
  }), {
    a: 'documents',
    b: 'browser',
    e: 'plan',
  });
});
