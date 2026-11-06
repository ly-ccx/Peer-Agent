import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSessionControl } from './session-control.mjs';
import { createExecutionScheduler } from './execution-scheduler.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { beginExecutionAttempt } from './session-facts.mjs';

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'queued-dispatch-settlement-'));
  const directory = path.join(root, 'project'); mkdirSync(directory);
  let plan = { planId: 'plan', conversationId: 'child-conversation', status: 'paused', targetWorkspacePath: directory,
    delegationOrigin: { workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'child', workId: 'work', phase: 'queued',
      coordinationBinding: { executionEpoch: 'execution', goalRevision: 1 } } };
  const scheduler = createExecutionScheduler({ rootDir: path.join(root, 'runtime') }); scheduler.prepareResources();
  scheduler.configure({ ownsWorkspace: () => true, currentPlan: () => plan, isWorkspaceReady: () => true });
  scheduler.protectResources(plan, { state: 'reconciling', evidenceCalls: ['spawn'] });
  const store = createWorkCoordinationStore({ rootDir: path.join(root, 'runtime'), workspaceId: 'workspace', formatVersion: 2, fenceLegacyWrites: true,
    holdsLease: () => true, leaseEpoch: () => 'new-host' });
  await store.prepare();
  store.saveWork({ workId: 'work', workspaceId: 'workspace', parentConversationId: 'parent', state: 'waiting_children', stopScope: 'reply',
    budget: { attempts: {}, settledDispatches: [{ toolCallId: 'spawn', attemptId: 'old', turnId: 'turn', evidenceRef: 'tool-result://spawn',
      operationId: 'spawn-operation', sessionId: 'child', executionEpoch: 'execution', goalRevision: 1 }] } });
  const release = registerWorkBudget('workspace', store);
  const events = [];
  const plans = { getPlan: () => structuredClone(plan), revisePlan(_id, patch) { plan = { ...plan, ...structuredClone(patch) }; } };
  const control = createSessionControl({ goalPlanStore: plans, executionScheduler: scheduler, canManageWorkspace: () => true,
    goalRunner: { async waitForIdle() { events.push('runner-idle'); } },
    async abortStream() { events.push('abort'); } });
  t.after(() => { release(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, scheduler, control, plans, events, directory, get plan() { return plan; } };
}

test('a queued self-hold is settled through a durable stop barrier and its original task is admitted once', async t => {
  const f = await fixture(t);
  assert.equal(f.scheduler.inspectResources(f.plan).allowed, false);
  await f.control.reconcile([f.plan]);
  const receipt = f.store.readSessionControl('child');
  assert.equal(receipt.phase, 'settled');
  assert.equal(receipt.stopReceipt.runnerIdle, true);
  assert.equal(receipt.stopReceipt.schedulerIdle, true);
  assert.deepEqual(receipt.stopReceipt.unknownCalls, []);
  assert.equal(f.plan.delegationOrigin.phase, 'queued');
  assert.equal(f.plan.runner, undefined, 'settlement did not manufacture a worker execution');
  assert.equal(f.scheduler.inspectResources(f.plan).allowed, true);
  const revision = f.scheduler.resourceRevision();
  await f.control.reconcile([f.plan]);
  assert.equal(f.scheduler.resourceRevision(), revision);
  assert.deepEqual(f.events, ['abort', 'runner-idle']);
  assert.equal(f.scheduler.reserveResources(f.plan).allowed, true);
  assert.equal(f.scheduler.activateResources(f.plan), true);
});

for (const reason of ['different-execution', 'different-goal', 'runner-exists', 'unmatched-unknown', 'live-execution', 'root-cancelled']) {
  test(`${reason} keeps queued resource protection intact`, async t => {
    const f = await fixture(t);
    if (reason === 'different-execution') f.plans.revisePlan('plan', { delegationOrigin: { ...f.plan.delegationOrigin,
      coordinationBinding: { executionEpoch: 'other', goalRevision: 1 } } });
    if (reason === 'different-goal') f.plans.revisePlan('plan', { delegationOrigin: { ...f.plan.delegationOrigin,
      coordinationBinding: { executionEpoch: 'execution', goalRevision: 2 } } });
    if (reason === 'runner-exists') f.plans.revisePlan('plan', { runner: { status: 'paused' } });
    if (reason === 'unmatched-unknown') f.scheduler.protectResources(f.plan, { state: 'reconciling', evidenceCalls: ['actual-write'] });
    if (reason === 'root-cancelled') f.store.saveWork({ ...f.store.readWork('work'), state: 'cancelled', stopScope: 'work' });
    const end = reason === 'live-execution' ? beginExecutionAttempt(f.plan.conversationId, 'actual') : () => {};
    try { await f.control.reconcile([f.plan]); } finally { end(); }
    assert.equal(f.store.readSessionControl('child'), undefined);
    assert.equal(f.scheduler.resourceSnapshot().length, 1);
    assert.equal(f.scheduler.resourceSnapshot()[0].state, 'reconciling');
  });
}

test('a foreign unresolved resource remains protected after the queued task self-hold settles', async t => {
  const f = await fixture(t), foreign = { ...f.plan, planId: 'foreign', conversationId: 'foreign-conversation',
    delegationOrigin: { ...f.plan.delegationOrigin, sessionId: 'foreign', workId: 'foreign',
      coordinationBinding: { executionEpoch: 'foreign-execution', goalRevision: 1 } } };
  f.scheduler.protectResources(foreign, { state: 'reconciling', evidenceCalls: ['unknown-shell'] });
  await f.control.reconcile([f.plan]);
  assert.equal(f.store.readSessionControl('child').phase, 'settled');
  const protectedRows = f.scheduler.resourceSnapshot();
  assert.equal(protectedRows.length, 1);
  assert.equal(protectedRows[0].execution.planId, 'foreign');
  assert.deepEqual(protectedRows[0].evidenceCalls, ['unknown-shell']);
  assert.equal(f.scheduler.inspectResources(f.plan).allowed, false);
});
