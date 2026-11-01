import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionControl } from './session-control.mjs';
import { executionIdentity } from './session-control-kernel.mjs';

function fixture(overrides = {}) {
  const events = [];
  let plan = { planId: 'plan', conversationId: 'child', createdAt: 'created', status: 'cancelled',
    delegationOrigin: { sessionId: 'session', workspaceId: 'workspace', parentConversationId: 'parent', phase: 'paused',
      cancellation: { operationId: 'old-cancel', phase: 'completed', completedAt: '2026-11-01T00:00:00.000Z',
        withdrawal: { workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'session', planId: 'plan', anchorMessageId: 'input', inputId: 'input' } },
      takeover: { phase: 'stopping', operationId: 'old-takeover' } } };
  const goalPlanStore = { getPlan: () => structuredClone(plan),
    revisePlan(_id, patch) { plan = { ...plan, ...structuredClone(patch) }; return this.getPlan(); },
    setPlanStatus(_id, status) { plan.status = status; } };
  const control = createSessionControl({ goalPlanStore, canManageWorkspace: () => true,
    goalRunner: { pause() { events.push('fence'); }, async waitForIdle() { events.push('runner-idle'); } },
    executionScheduler: { cancelPlan() {}, async waitForPlanIdle() { events.push('scheduler-idle'); },
      protectResources() { events.push('protect'); }, settleResources(_plan, receipt) { assert.equal(receipt.runnerIdle, true); events.push('settle-resources'); } },
    readMessages: () => [{ id: 'input', inputId: 'input', role: 'user', kind: 'user_input' }],
    async abortStream() { events.push('abort'); }, ...overrides });
  return { control, goalPlanStore, events };
}

test('legacy cancelled plus stopping takeover re-enters the barrier and explicitly retires takeover', async () => {
  const { control, goalPlanStore, events } = fixture();
  await control.reconcile([goalPlanStore.getPlan()]);
  const plan = goalPlanStore.getPlan();
  assert.equal(plan.status, 'cancelled');
  assert.equal(plan.delegationOrigin.takeover.phase, 'superseded');
  assert.equal(plan.delegationOrigin.executionControl.phase, 'settled');
  assert.deepEqual(events, ['fence', 'protect', 'abort', 'runner-idle', 'scheduler-idle', 'settle-resources']);
  await control.reconcile([plan]);
  assert.equal(events.length, 6, 'recovery is idempotent and never re-executes the worker');
});

test('a delayed drain of a superseded takeover cannot settle or resume the new operation', async () => {
  const { control, goalPlanStore } = fixture();
  let plan = goalPlanStore.getPlan();
  plan.delegationOrigin.cancellation = undefined;
  plan.runner = { status: 'completed' };
  goalPlanStore.revisePlan('plan', plan);
  const takeover = control.begin(plan, { kind: 'takeover', operationId: 'takeover', authorityRef: 'decision' });
  const cancel = control.begin(goalPlanStore.getPlan(), { kind: 'cancel', operationId: 'cancel', authorityRef: 'input' });
  await assert.rejects(control.drain(goalPlanStore.getPlan(), takeover), /superseded/);
  const receipt = await control.drain(goalPlanStore.getPlan(), cancel);
  control.settle(goalPlanStore.getPlan(), cancel, receipt);
  assert.equal(goalPlanStore.getPlan().delegationOrigin.executionControl.operationId, 'cancel');
  assert.deepEqual(receipt.execution, executionIdentity(plan));
});

test('persisted running with no current-process ownership is not a stop proof', async () => {
  const { control, goalPlanStore } = fixture();
  const plan = goalPlanStore.getPlan(); plan.status = 'executing';
  plan.delegationOrigin.phase = 'running'; plan.delegationOrigin.cancellation = undefined;
  goalPlanStore.revisePlan('plan', plan);
  const operation = control.begin(plan, { kind: 'cancel', operationId: 'cancel', authorityRef: 'input' });
  await assert.rejects(control.drain(goalPlanStore.getPlan(), operation), /execution_stop_unconfirmed/);
  assert.notEqual(goalPlanStore.getPlan().delegationOrigin.executionControl.phase, 'settled');
});

test('legacy completion strings without a canonical source do not manufacture a stop receipt', async () => {
  const { control, goalPlanStore } = fixture({ readMessages: () => [] });
  await control.reconcile([goalPlanStore.getPlan()]);
  const operation = goalPlanStore.getPlan().delegationOrigin.executionControl;
  assert.equal(operation.phase, 'reconciling');
  assert.equal(operation.nextAction, 'execution_stop_unconfirmed');
  assert.equal(operation.stopReceipt, undefined);
});

test('a blocked stop has a deadline and unchanged recovery facts do not repeat signals', async () => {
  let signals = 0;
  const { control, goalPlanStore } = fixture({ stopTimeoutMs: 5, abortStream() { signals++; return new Promise(() => {}); } });
  await control.reconcile([goalPlanStore.getPlan()]);
  assert.equal(goalPlanStore.getPlan().delegationOrigin.executionControl.phase, 'reconciling');
  await control.reconcile([goalPlanStore.getPlan()]);
  assert.equal(signals, 1);
});
