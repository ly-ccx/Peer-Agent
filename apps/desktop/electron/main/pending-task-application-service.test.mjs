import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingTaskApplicationService } from './pending-task-application-service.mjs';

function createHarness({ consumed = null, peeked = null, workspaceRoot = '/work/current' } = {}) {
  const calls = [];
  const service = createPendingTaskApplicationService({
    workspaceRoot,
    writePendingTask: (task) => {
      calls.push(['write', task]);
      return { ok: true };
    },
    consumePendingTask: () => {
      calls.push(['consume']);
      return consumed;
    },
    peekPendingTask: () => {
      calls.push(['peek']);
      return peeked;
    },
    clearPendingTask: () => calls.push(['clear']),
    reportWorkspaceMismatch: (recordWorkspace, currentWorkspace) =>
      calls.push(['mismatch', recordWorkspace, currentWorkspace]),
  });
  return { calls, service };
}

test('pending task write anchors the current workspace and preserves the store result', () => {
  const { calls, service } = createHarness();
  const result = service.write({ sessionId: 'c1', task: 'continue', workspace: '/spoofed' });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [[
    'write',
    { sessionId: 'c1', task: 'continue', workspace: '/work/current' },
  ]]);
});

test('pending task consume and peek preserve matching or unscoped records', () => {
  const consumed = { sessionId: 'c1', workspace: '/work/current' };
  const peeked = { sessionId: 'c2' };
  const { calls, service } = createHarness({ consumed, peeked });

  assert.equal(service.consume(), consumed);
  assert.equal(service.peek(), peeked);
  assert.deepEqual(calls, [['consume'], ['peek']]);
});

test('pending task workspace mismatch is reported, cleared, and hidden', () => {
  const record = { sessionId: 'c1', workspace: '/work/other' };
  const { calls, service } = createHarness({ consumed: record });

  assert.equal(service.consume(), null);
  assert.deepEqual(calls, [
    ['consume'],
    ['mismatch', '/work/other', '/work/current'],
    ['clear'],
  ]);
});

test('pending task clear remains an idempotent true-returning command', () => {
  const { calls, service } = createHarness();

  assert.equal(service.clear(), true);
  assert.deepEqual(calls, [['clear']]);
});
