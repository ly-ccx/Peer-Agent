import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalRunner } from '../goal-runner.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { isLocalPersistenceFailure, prepareLocalPersistenceRetry } from './session-repair.mjs';

for (const mode of ['throw', 'result']) test(`a local persistence ${mode} never re-enters cognition through network retry heuristics`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'peer-local-failure-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createGoalPlanStore({ storeDir: root });
  const plan = store.createPlan({ conversationId: 'fixture', tasks: [{ taskId: 't', title: 'work', status: 'pending' }] });
  store.recordApproval(plan.planId, { decision: 'approve' });
  let calls = 0;
  const reason = 'conversation_persistence_failed: CONVERSATION_COMMIT_TIMEOUT';
  const runner = createGoalRunner({ goalPlanStore: store, logger: { warn() {} }, maxRecoverableInterruptionRetries: 2,
    chatRuntime: { async runGoalTurn() {
      calls++;
      if (mode === 'throw') throw Object.assign(Error(reason), { retryable: true });
      return { terminalStatus: 'error', failureReason: reason, interrupted: true, recoverable: true };
    } } });
  await runner.start(plan.planId, { awaitIdle: true });
  assert.equal(calls, 1, 'local persistence must not consume another provider attempt');
  assert.equal(store.getPlan(plan.planId).runner.lastError, reason);
  assert.equal(store.getPlan(plan.planId).runner.recoverableInterruptionCount || 0, 0);
});

test('only matching host-local failure leaves are prepared; result, nonlocal failures and history remain intact', () => {
  for (const value of ['text conversation_persistence_failed', 'conversation_persistence_failed_other', null, { error: 'conversation_persistence_failed' }])
    assert.equal(isLocalPersistenceFailure(value), false);
  const reason = 'conversation_persistence_failed: CONVERSATION_MESSAGE_MISSING';
  const plan = { planId: 'p', runner: { lastError: reason }, tasks: [
    { taskId: 'done', status: 'completed', result: 'keep', evidenceRefs: ['e'] },
    { taskId: 'local', status: 'failed', failureReason: reason, result: reason, evidenceRefs: ['old'] },
    { taskId: 'semantic', status: 'failed', failureReason: 'assertion failed', result: 'not safe to reset' },
  ] };
  const before = structuredClone(plan); let patched, events = [];
  const store = { appendRunEvent: (_id, event) => events.push(event), revisePlan: (_id, patch) => { patched = patch; } };
  assert.deepEqual(prepareLocalPersistenceRetry(plan, store, 'op'), ['local']);
  assert.deepEqual(plan, before);
  assert.deepEqual(patched.tasks[0], before.tasks[0]); assert.deepEqual(patched.tasks[2], before.tasks[2]);
  assert.deepEqual(patched.tasks[1], { ...before.tasks[1], status: 'pending' });
  assert.equal(events[0].payload.previousError, reason);
  const preparedPlan = { ...plan, tasks: patched.tasks, runTrace: { events } };
  assert.deepEqual(prepareLocalPersistenceRetry(preparedPlan, store, 'op'), ['local'], 'crash after prepare retains execute intent');
  assert.equal(events.length, 1, 'same operation does not append another preparation');
  assert.deepEqual(prepareLocalPersistenceRetry({ ...plan, runner: { lastError: 'assertion failed' } }, store, 'other'), []);
});
