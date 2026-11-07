import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectWorkSession } from '@peer-agent/protocol';
import { createSessionCancellation } from './session-cancellation.mjs';
import { createSessionControl } from './session-control.mjs';
import { createExecutionScheduler } from './execution-scheduler.mjs';
import { createExecutionResources } from './execution-resources.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { beginExecutionAttempt } from './session-facts.mjs';
import { controlDigest, executionIdentity } from './session-control-kernel.mjs';

function exitedPid() {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  const pid = child.pid;
  child.kill('SIGKILL');
  return new Promise((resolve, reject) => {
    child.once('exit', () => {
      try { process.kill(pid, 0); reject(new Error(`pid ${pid} still signalable`)); }
      catch (error) { error.code === 'ESRCH' ? resolve(pid) : reject(error); }
    });
  });
}
function livePid(t) {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return child.pid;
}
function world(t, { epoch = 'host-now', work = null, waitForIdle = async () => {} } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-dead-host-stop-'));
  const directory = path.join(root, 'workspace');
  mkdirSync(directory);
  const plans = new Map();
  let control = null;
  const starts = [];
  const aborts = [];
  const store = {
    writerEpoch: () => epoch,
    readSessionControl: () => control ? structuredClone(control) : undefined,
    writeSessionControl(operation) { control = structuredClone(operation); return operation; },
    read: () => ({ works: work ? { work } : {} }),
    readWork: () => work,
  };
  const releaseBudget = registerWorkBudget('workspace', store);
  const scheduler = createExecutionScheduler({ rootDir: path.join(root, 'runtime') });
  scheduler.configure({ ownsWorkspace: () => true, currentPlan: plan => plans.get(plan.planId) || plan });
  const goalPlanStore = {
    getPlan: id => structuredClone(plans.get(id)),
    revisePlan(id, patch) {
      const next = { ...plans.get(id), ...structuredClone(patch) };
      plans.set(id, next);
      if (patch.delegationOrigin?.executionControl) control = structuredClone(patch.delegationOrigin.executionControl);
      return structuredClone(next);
    },
    setPlanStatus(id, status) { plans.get(id).status = status; },
  };
  const goalRunner = { start(id) { starts.push(id); }, resume(id) { starts.push(id); }, pause() {}, waitForIdle };
  const sessionControl = createSessionControl({ goalPlanStore, goalRunner, executionScheduler: scheduler, canManageWorkspace: () => true,
    async abortStream() { aborts.push('abort'); }, readMessages: () => [] });
  function project(plan) {
    const origin = { ...plan.delegationOrigin, executionControl: store.readSessionControl() || plan.delegationOrigin.executionControl };
    return projectWorkSession({ planId: plan.planId, status: plan.status, title: plan.title || 'task', delegated: true,
      runnerStatus: plan.runner?.status, conversationId: plan.conversationId },
    { sessionId: origin.sessionId, workspaceId: origin.workspaceId, spawnedAt: '2026-11-07T00:00:00.000Z', origin, executionOwnership: 'unknown' });
  }
  const cancellation = createSessionCancellation({ findBySession: id => [...plans.values()].find(plan => plan.delegationOrigin.sessionId === id),
    goalPlanStore, goalRunner, executionScheduler: scheduler, canManageWorkspace: () => true, sessionControl,
    exclusive: task => task(), emit() {}, promote: async () => {}, project, readMessages: () => [], now: () => '2026-11-07T00:00:00.000Z' });
  t.after(() => { scheduler.close(); releaseBudget(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, plans, scheduler, sessionControl, cancellation, starts, aborts, project,
    get control() { return control; }, set control(value) { control = value; } };
}
function remember(env, plan, operation) {
  plan.delegationOrigin.executionControl = operation;
  env.plans.set(plan.planId, plan);
  env.control = operation;
}
function stoppingPlan(directory, extra = {}) {
  return { planId: 'plan', conversationId: 'child', title: 'merge', status: 'executing', targetWorkspacePath: directory,
    createdAt: '2026-11-01T00:00:00.000Z', runner: { status: 'running', ...(extra.lastError ? { lastError: extra.lastError } : {}) },
    delegationOrigin: { sessionId: 'session', workspaceId: 'workspace', parentConversationId: 'parent', phase: 'running',
      ...(extra.workId ? { workId: extra.workId } : {}), coordinationBinding: { executionEpoch: 'epoch', goalRevision: 1 },
      cancellation: { operationId: 'cancel-1', phase: 'stopping', reason: 'cancelled', requestedAt: '2026-11-07T00:00:00.000Z' } } };
}
function stoppingOperation(plan, { hostEpoch = 'old-host', hostPid = null, unproven = true } = {}) {
  const execution = executionIdentity(plan), authorityRef = 'cancellation:cancel-1';
  return { kind: 'cancel', operationId: 'cancel-1', authorityRef, reason: 'cancelled',
    requestDigest: controlDigest({ kind: 'cancel', operationId: 'cancel-1', authorityRef, execution }), revision: 2,
    workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'session', planId: 'plan', expectedExecution: execution,
    hostEpoch, ...(hostPid ? { hostPid } : {}), unproven, phase: 'draining', updatedAt: '2026-11-07T00:00:00.000Z' };
}
const sibling = directory => ({ planId: 'next', conversationId: 'next-child', status: 'paused', targetWorkspacePath: directory,
  delegationOrigin: { sessionId: 'next-session', workspaceId: 'workspace', phase: 'queued', coordinationBinding: { executionEpoch: 'next' } } });

test('a live execution on the recording host still stops only after the barrier is idle', async t => {
  let release = () => {};
  const env = world(t, { waitForIdle: async () => release() });
  const plan = stoppingPlan(env.directory);
  delete plan.delegationOrigin.cancellation;
  env.plans.set(plan.planId, plan);
  release = beginExecutionAttempt(plan.conversationId, 'run');
  t.after(release);
  const settled = await env.cancellation.cancel({ sessionId: 'session', reason: 'cancelled' });
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.statusLabel, '已取消');
  assert.equal(settled.followUp.inCurrentList, false);
  assert.equal(settled.followUp.reason, 'stop_confirmed');
  assert.equal(env.control.phase, 'settled');
  assert.equal(env.control.hostPid, process.pid);
  assert.deepEqual(env.control.stopReceipt.unknownCalls, []);
  assert.deepEqual(env.starts, []);
  const again = await env.cancellation.cancel({ sessionId: 'session' });
  assert.equal(again.status, 'cancelled');
  assert.equal(env.aborts.length, 1);
  await env.sessionControl.reconcile([env.plans.get(plan.planId)]);
  assert.equal(env.plans.get(plan.planId).status, 'cancelled');
  assert.deepEqual(env.starts, []);
});

test('a dead recorder with no live execution and no unknown calls settles on recovery and does not replay', async t => {
  const env = world(t);
  const pid = await exitedPid();
  const plan = stoppingPlan(env.directory);
  remember(env, plan, stoppingOperation(plan, { hostPid: pid }));
  env.scheduler.protectResources(plan, { operationId: 'cancel-1', state: 'draining' });
  const next = sibling(env.directory);
  assert.equal(env.scheduler.inspectResources(next).allowed, false);
  await assert.rejects(env.sessionControl.prepareResume(plan, 'again', async task => task()), /work_execution_stopped/);
  await env.cancellation.recover([env.plans.get(plan.planId)]);
  const visible = env.project(env.plans.get(plan.planId));
  assert.equal(visible.status, 'cancelled');
  assert.equal(visible.statusLabel, '已取消');
  assert.equal(visible.followUp.inCurrentList, false);
  assert.equal(env.plans.get(plan.planId).delegationOrigin.cancellation.phase, 'completed');
  assert.equal(env.scheduler.inspectResources(next).allowed, true);
  assert.deepEqual(env.starts, []);
  assert.equal(env.aborts.length, 1);
  const aborts = env.aborts.length;
  await env.cancellation.recover([env.plans.get(plan.planId)]);
  await env.sessionControl.reconcile([env.plans.get(plan.planId)]);
  assert.equal(env.aborts.length, aborts);
  assert.equal(env.plans.get(plan.planId).status, 'cancelled');
  assert.deepEqual(env.starts, []);
});

test('a legacy-host epoch can use its recorded pid after that process is gone', async t => {
  const env = world(t);
  const pid = await exitedPid();
  const plan = stoppingPlan(env.directory);
  remember(env, plan, stoppingOperation(plan, { hostEpoch: `legacy-host:${pid}` }));
  await env.cancellation.recover([plan]);
  assert.equal(env.plans.get(plan.planId).status, 'cancelled');
  assert.equal(env.project(env.plans.get(plan.planId)).followUp.inCurrentList, false);
  assert.deepEqual(env.starts, []);
});

test('a recorder that may still be alive is not cancelled and does not release its claim', async t => {
  const env = world(t);
  const plan = stoppingPlan(env.directory);
  remember(env, plan, stoppingOperation(plan, { hostPid: livePid(t) }));
  env.scheduler.protectResources(plan, { operationId: 'cancel-1', state: 'draining', evidenceCalls: ['maybe-live'] });
  await env.cancellation.recover([plan]);
  const visible = env.project(env.plans.get(plan.planId));
  assert.equal(visible.status, 'awaiting_outcome');
  assert.equal(visible.statusLabel, '执行结果待核实');
  assert.equal(visible.followUp.reason, 'stop_unconfirmed');
  assert.equal(visible.followUp.inCurrentList, true);
  assert.notEqual(env.plans.get(plan.planId).status, 'cancelled');
  assert.equal(env.control.stopReceipt, undefined);
  assert.equal(env.scheduler.resourceSnapshot().find(row => row.execution.planId === 'plan').state, 'draining');
  assert.equal(env.scheduler.inspectResources(sibling(env.directory)).allowed, false);
  await assert.rejects(env.sessionControl.prepareResume(env.plans.get(plan.planId), 'again', async task => task()), /work_execution_stopped/);
  const aborts = env.aborts.length;
  await env.cancellation.recover([env.plans.get(plan.planId)]);
  assert.equal(env.aborts.length, aborts);
  assert.equal(env.project(env.plans.get(plan.planId)).status, 'awaiting_outcome');
  assert.deepEqual(env.starts, []);
});

test('a provider 401 without a terminal runner status is not a stop proof', async t => {
  for (const lastError of ['HTTP 401 unauthorized', 'stop timed out']) {
    const env = world(t);
    const plan = stoppingPlan(env.directory, { lastError });
    delete plan.delegationOrigin.cancellation;
    env.plans.set(plan.planId, plan);
    const result = await env.cancellation.cancel({ sessionId: 'session', reason: 'cancelled' });
    assert.equal(result.error, 'execution_stop_unconfirmed');
    const visible = env.project(env.plans.get(plan.planId));
    assert.equal(visible.status, 'awaiting_outcome');
    assert.equal(visible.statusLabel, '执行结果待核实');
    assert.equal(visible.followUp.inCurrentList, true);
    assert.equal(env.plans.get(plan.planId).runner.status, 'running');
    assert.equal(env.plans.get(plan.planId).runner.lastError, lastError);
    assert.equal(env.control.stopReceipt, undefined);
    assert.notEqual(env.plans.get(plan.planId).status, 'cancelled');
    await env.cancellation.recover([env.plans.get(plan.planId)]);
    assert.equal(env.project(env.plans.get(plan.planId)).status, 'awaiting_outcome');
    assert.equal(env.aborts.length, 0);
    assert.deepEqual(env.starts, []);
  }
});

test('a dead recorder with an unknown external call or open handle stays awaiting outcome and keeps the claim', async t => {
  const pid = await exitedPid();
  const work = { budget: { uncertainDispatches: [{ toolCallId: 'remote-call', planId: 'plan' }] } };
  const env = world(t, { work });
  const plan = stoppingPlan(env.directory, { workId: 'work' });
  remember(env, plan, stoppingOperation(plan, { hostPid: pid }));
  env.scheduler.protectResources(plan, { operationId: 'cancel-1', state: 'draining', evidenceCalls: ['remote-call'] });
  const resources = createExecutionResources({ rootDir: path.join(env.root, 'runtime') });
  resources.markHandle(plan, { handleId: 'native', toolCallId: 'shell', state: 'active' });
  resources.close();
  await env.cancellation.recover([plan]);
  const visible = env.project(env.plans.get(plan.planId));
  assert.equal(visible.status, 'awaiting_outcome');
  assert.equal(visible.statusLabel, '执行结果待核实');
  assert.equal(visible.followUp.inCurrentList, true);
  assert.equal(visible.followUp.reason, 'stop_unconfirmed');
  assert.notEqual(env.plans.get(plan.planId).status, 'cancelled');
  const claim = env.scheduler.resourceSnapshot().find(row => row.execution.planId === 'plan');
  assert.equal(claim.state, 'reconciling');
  assert.equal(claim.handles.native.state, 'active');
  assert.ok(claim.evidenceCalls.includes('remote-call'));
  assert.ok(claim.evidenceCalls.includes('shell'));
  assert.equal(env.scheduler.inspectResources(sibling(env.directory)).allowed, false);
  await assert.rejects(env.sessionControl.prepareResume(env.plans.get(plan.planId), 'again', async task => task()), /work_execution_stopped/);
  const revision = claim.revision;
  const aborts = env.aborts.length;
  await env.cancellation.recover([env.plans.get(plan.planId)]);
  const again = env.scheduler.resourceSnapshot().find(row => row.execution.planId === 'plan');
  assert.equal(again.state, 'reconciling');
  assert.equal(again.handles.native.state, 'active');
  assert.equal(again.revision, revision);
  assert.equal(env.aborts.length, aborts);
  assert.equal(env.project(env.plans.get(plan.planId)).status, 'awaiting_outcome');
  assert.deepEqual(env.starts, []);
});

test('an rc38 stopping record without a pid converges without being forged cancelled', async t => {
  const epoch = '6f0c2a8e-1b4d-4e6a-9c11-0a1b2c3d4e5f:2026-11-07T08:00:00.000Z';
  for (const unknown of [false, true]) {
    const work = unknown ? { budget: { uncertainDispatches: [{ toolCallId: 'remote-call', planId: 'plan' }] } } : null;
    const env = world(t, { epoch: 'new-host:2026-11-07T09:40:00.000Z', work });
    const plan = stoppingPlan(env.directory, unknown ? { workId: 'work' } : {});
    const operation = stoppingOperation(plan, { hostEpoch: epoch });
    delete operation.hostPid;
    remember(env, plan, operation);
    env.scheduler.protectResources(plan, { operationId: 'cancel-1', state: 'draining', ...(unknown ? { evidenceCalls: ['remote-call'] } : {}) });
    assert.equal(Object.hasOwn(env.control, 'hostPid'), false);
    await env.cancellation.recover([env.plans.get(plan.planId)]);
    await env.sessionControl.reconcile([env.plans.get(plan.planId)]);
    const visible = env.project(env.plans.get(plan.planId));
    assert.equal(visible.status, 'awaiting_outcome', unknown ? 'unknown call' : 'no recorded call');
    assert.equal(visible.statusLabel, '执行结果待核实');
    assert.equal(visible.followUp.inCurrentList, true);
    assert.equal(visible.followUp.reason, 'stop_unconfirmed');
    assert.notEqual(env.plans.get(plan.planId).status, 'cancelled');
    assert.equal(env.plans.get(plan.planId).delegationOrigin.cancellation.phase, 'awaiting_outcome');
    assert.equal(Object.hasOwn(env.control, 'hostPid'), false);
    assert.equal(env.control.stopReceipt, undefined);
    assert.equal(env.control.nextAction, 'execution_stop_unconfirmed');
    const claim = env.scheduler.resourceSnapshot().find(row => row.execution.planId === 'plan');
    assert.equal(claim.state, 'draining');
    assert.equal(env.scheduler.inspectResources(sibling(env.directory)).allowed, false);
    await assert.rejects(env.sessionControl.prepareResume(env.plans.get(plan.planId), 'again', async task => task()), /work_execution_stopped/);
    const aborts = env.aborts.length;
    const revision = claim.revision;
    await env.cancellation.recover([env.plans.get(plan.planId)]);
    await env.cancellation.cancel({ sessionId: 'session', reason: 'cancelled' });
    await env.sessionControl.reconcile([env.plans.get(plan.planId)]);
    assert.equal(env.aborts.length, aborts);
    assert.equal(env.scheduler.resourceSnapshot().find(row => row.execution.planId === 'plan').revision, revision);
    assert.equal(env.project(env.plans.get(plan.planId)).status, 'awaiting_outcome');
    assert.equal(env.project(env.plans.get(plan.planId)).followUp.inCurrentList, true);
    assert.deepEqual(env.starts, []);
  }
});

test('an already terminal cancellation does not return to stopping or start again', async t => {
  const env = world(t);
  const plan = stoppingPlan(env.directory);
  plan.status = 'cancelled';
  plan.runner = { status: 'cancelled' };
  plan.delegationOrigin.phase = 'paused';
  plan.delegationOrigin.cancellation = { operationId: 'cancel-1', phase: 'completed', reason: 'cancelled',
    requestedAt: '2026-11-01T00:00:00.000Z', completedAt: '2026-11-07T00:00:00.000Z', cleanupPending: false };
  env.plans.set(plan.planId, plan);
  await env.cancellation.recover([plan]);
  await env.sessionControl.reconcile([env.plans.get(plan.planId)]);
  assert.equal(env.plans.get(plan.planId).status, 'cancelled');
  assert.equal(env.plans.get(plan.planId).delegationOrigin.cancellation.phase, 'completed');
  assert.equal(env.project(env.plans.get(plan.planId)).statusLabel, '已取消');
  assert.equal(env.project(env.plans.get(plan.planId)).followUp.inCurrentList, false);
  assert.deepEqual(env.starts, []);
  assert.equal(env.aborts.length, 0);
});
