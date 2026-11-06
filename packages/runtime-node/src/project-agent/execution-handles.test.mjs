import test from 'node:test';
import assert from 'node:assert/strict';
import { observeExecutionHandles, trackExecutionHandle, executionHandlesLive, stopExecutionHandles } from './execution-handles.mjs';
import { executionOwnershipOf } from './session-facts.mjs';

test('a returned background tool does not turn its still-running process into an ended task', async () => {
  const conversationId = 'native-background', events = [];
  const release = observeExecutionHandles(conversationId, event => events.push(event.state));
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  trackExecutionHandle({ conversationId, handleId: 'real-handle', toolCallId: 'real-call', completion,
    stop() { finish({ status: 'cancelled', completedAt: '2026-11-01T00:00:00.000Z' }); } });
  assert.equal(executionOwnershipOf({ conversationId, runner: { status: 'completed' } }), 'live');
  await stopExecutionHandles(conversationId);
  assert.equal(executionHandlesLive(conversationId), false);
  assert.deepEqual(events, ['active', 'ended']);
  release();
});

test('an unknown handle requires an actual provider query, never a timeout or missing token', async () => {
  const conversationId = 'native-query', events = [];
  const release = observeExecutionHandles(conversationId, event => events.push(event.state));
  let reject;
  const completion = new Promise((_resolve, fail) => { reject = fail; });
  trackExecutionHandle({ conversationId, handleId: 'handle', toolCallId: 'call', completion, stop() {},
    query: () => ({ taskId: 'handle', status: 'completed', completedAt: '2026-11-01T00:00:00.000Z' }) });
  reject(new Error('completion_delivery_lost'));
  await stopExecutionHandles(conversationId);
  assert.equal(executionHandlesLive(conversationId), false);
  assert.deepEqual(events, ['active', 'unknown', 'ended']);
  release();
});
