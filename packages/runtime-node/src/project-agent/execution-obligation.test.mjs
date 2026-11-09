import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectWorkSession } from '@peer-agent/protocol';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { createExecutionScheduler } from './execution-scheduler.mjs';
import { classifyExecutionObligation, createExecutionObligationService } from './execution-obligation.mjs';

const epoch = 'syn-host-now:2026-11-07T09:40:00.000Z';
const oldEpoch = 'syn-host-old:2026-11-07T08:00:00.000Z';

function plan(id, directory, extra = {}) {
  return { planId: `plan-${id}`, conversationId: `child-${id}`, title: id, status: 'paused', targetWorkspacePath: directory,
    createdAt: '2026-11-07T08:00:00.000Z', runner: { status: 'running' },
    delegationOrigin: { sessionId: id, workspaceId: 'workspace', parentConversationId: 'parent', phase: 'paused',
      coordinationBinding: { executionEpoch: `epoch-${id}`, goalRevision: 1 },
      ...(extra.workId ? { workId: extra.workId } : {}),
      cancellation: { operationId: `cancel-${id}`, phase: 'awaiting_outcome', reason: 'cancelled', requestedAt: '2026-11-07T08:00:00.000Z' },
      executionControl: { kind: 'cancel', operationId: `cancel-${id}`, phase: 'reconciling', nextAction: 'execution_stop_unconfirmed',
        revision: 4, hostEpoch: oldEpoch, workspaceId: 'workspace', parentConversationId: 'parent', sessionId: id, planId: `plan-${id}`,
        authorityRef: `cancellation:cancel-${id}`, expectedExecution: { planId: `plan-${id}`, sessionId: id, executionEpoch: `epoch-${id}`, goalRevision: 1 },
        updatedAt: '2026-11-07T08:00:00.000Z' } } };
}

test('three rc38-shaped records leave the current lists only after a host card confirmation', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-'));
  const directory = path.join(root, 'workspace');
  mkdirSync(directory);
  const plans = new Map(['a', 'b', 'c'].map(id => {
    const row = plan(id, directory, id === 'b' ? { workId: 'work' } : {});
    return [row.planId, row];
  }));
  const store = createWorkCoordinationStore({ rootDir: path.join(root, 'runtime'), workspaceId: 'workspace', holdsLease: () => true, leaseEpoch: () => epoch, formatVersion: 2, fenceLegacyWrites: true });
  await store.prepare();
  store.saveWork({ workId: 'work', workspaceId: 'workspace', parentConversationId: 'parent', state: 'waiting_children', budget: { uncertainDispatches: [{ toolCallId: 'syn-call-b', planId: 'plan-b' }] } });
  const release = registerWorkBudget('workspace', store);
  const scheduler = createExecutionScheduler({ rootDir: path.join(root, 'runtime') });
  scheduler.configure({ ownsWorkspace: () => true, currentPlan: item => plans.get(item.planId) || item });
  for (const id of ['a', 'b', 'c']) {
    const claimState = id === 'b' ? 'reconciling' : 'draining';
    scheduler.protectResources(plans.get(`plan-${id}`), { operationId: `cancel-${id}`, state: claimState, ...(id === 'b' ? { evidenceCalls: ['syn-call-b'] } : {}) });
  }
  const resources = scheduler;
  const mark = resources.resourceSnapshot?.() || [];
  const handlePlan = plans.get('plan-c');
  const { createExecutionResources } = await import('./execution-resources.mjs');
  const ledger = createExecutionResources({ rootDir: path.join(root, 'runtime') });
  ledger.markHandle(handlePlan, { handleId: 'syn-handle-c', toolCallId: 'syn-call-c', state: 'active' });
  ledger.close();
  const service = createExecutionObligationService({
    plans: () => [...plans.values()],
    readControl: item => item.delegationOrigin.executionControl,
    scheduler, canManage: () => true, storeFor: () => store,
    identity: () => ({ bootId: null, pid: 1, pidStart: null, lookup: () => null }),
    writerEpochFor: () => epoch, now: () => '2026-11-07T10:00:00.000Z',
  });
  t.after(() => { scheduler.close(); release(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const inspected = service.inspect({ workspaceId: 'workspace', parentConversationId: 'parent', sessionIds: ['a', 'b', 'c'], role: 'project_agent' });
  assert.equal(inspected.ok, true);
  for (const item of inspected.items) {
    assert.equal(item.classes.includes('legacy_recorder_unproven'), true, item.sessionId);
    assert.equal(item.planStatus, 'paused');
    assert.equal(item.liveness, 'recorder_unproven');
    assert.equal(Object.hasOwn(item, 'recorder'), false);
    assert.deepEqual(item.allowedActions, item.sessionId === 'c'
      ? ['retire_follow_up', 'acknowledge_unknown']
      : ['retire_follow_up', 'acknowledge_unknown', 'close_claim']);
  }
  assert.equal(inspected.items.find(item => item.sessionId === 'b').outcome.unknownCallIds.includes('syn-call-b'), true);
  assert.equal(inspected.items.find(item => item.sessionId === 'c').outcome.openHandleIds.includes('syn-handle-c'), true);
  assert.equal(inspected.items.find(item => item.sessionId === 'a').gaps.includes('dispatch_registration_absent'), true);
  const copied = inspected.items.map(item => ({ obligationId: item.obligationId, sessionId: item.sessionId, operationId: item.operationId, evidenceRevision: item.evidenceRevision, actions: [...item.allowedActions] }));
  const retireOnly = item => item.allowedActions.filter(action => action !== 'close_claim');
  plans.get('plan-a').delegationOrigin.executionControl.revision += 1;
  const stale = service.requestAuthorization({ workspaceId: 'workspace', parentConversationId: 'parent', role: 'project_agent', items: copied.filter(item => item.sessionId === 'a') });
  assert.equal(stale.error, 'evidence_stale');
  assert.equal(stale.nextTool, 'inspect_execution_obligation');
  assert.equal(stale.stale[0].reason, 'evidence_revision');
  plans.get('plan-a').delegationOrigin.executionControl.revision -= 1;
  const fresh = service.inspect({ workspaceId: 'workspace', parentConversationId: 'parent', sessionIds: ['a', 'b', 'c'], role: 'project_agent' });
  const denied = service.resolve({ workspaceId: 'workspace', parentConversationId: 'parent', role: 'project_agent', grantId: 'missing', items: [], idempotencyKey: '1234567890123456' });
  assert.equal(denied.error, 'grant_not_found');
  const requested = service.requestAuthorization({ workspaceId: 'workspace', parentConversationId: 'parent', role: 'project_agent',
    items: fresh.items.map(item => ({ obligationId: item.obligationId, sessionId: item.sessionId, operationId: item.operationId, evidenceRevision: item.evidenceRevision, actions: retireOnly(item) })) });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.status, 'pending');
  assert.equal(requested.idempotencyKey, `panel-${requested.grantId}`);
  const pending = service.resolve({ workspaceId: 'workspace', parentConversationId: 'parent', role: 'project_agent', grantId: requested.grantId,
    idempotencyKey: requested.idempotencyKey, items: requested.items.map(item => ({ sessionId: item.sessionId, operationId: item.operationId, actions: item.actions })) });
  assert.equal(pending.error, 'grant_pending');
  const foreign = service.confirm({ actor: 'main_bot', workspaceId: 'workspace', grantId: requested.grantId });
  assert.equal(foreign.error, 'authorization_required');
  const confirmed = service.confirm({ actor: 'user_panel', workspaceId: 'workspace', parentConversationId: 'parent', grantId: requested.grantId });
  assert.equal(confirmed.ok, true);
  const resolved = service.resolve({ workspaceId: 'workspace', parentConversationId: 'parent', actor: 'user_panel', grantId: requested.grantId,
    idempotencyKey: requested.idempotencyKey, items: confirmed.grant.items.map(item => ({ sessionId: item.sessionId, operationId: item.operationId, actions: item.actions })) });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.items.every(item => item.result === 'applied'), true, JSON.stringify(resolved.items));
  for (const id of ['a', 'b', 'c']) {
    const row = plans.get(`plan-${id}`);
    assert.notEqual(row.status, 'cancelled');
    const session = projectWorkSession({ planId: row.planId, status: row.status, title: id, delegated: true, runnerStatus: 'running' }, {
      sessionId: id, workspaceId: 'workspace', spawnedAt: '2026-11-07T08:00:00.000Z', origin: row.delegationOrigin,
      obligationDisposition: service.dispositionFor('workspace', id), executionOwnership: 'unknown',
    });
    assert.equal(session.statusLabel === '已取消', false);
    assert.equal(session.followUp.reason, 'obligation_indexed');
    assert.equal(session.followUp.inCurrentList, false);
  }
  const claims = scheduler.resourceSnapshot();
  assert.equal(claims.some(claim => claim.state === 'released'), false);
  assert.equal(claims.find(claim => claim.execution.planId === 'plan-b').state, 'reconciling');
  assert.equal(scheduler.inspectResources(plans.get('plan-a')).allowed, false);
  const again = service.resolve({ workspaceId: 'workspace', parentConversationId: 'parent', actor: 'user_panel', grantId: requested.grantId,
    idempotencyKey: requested.idempotencyKey, items: confirmed.grant.items.map(item => ({ sessionId: item.sessionId, operationId: item.operationId, actions: item.actions })) });
  assert.equal(again.replayed, true);
  assert.equal(store.read().obligationDispositions[resolved.items[0].obligationId].phase, 'indexed');
  assert.equal(mark.length >= 0, true);
});

test('a dead recorder with a missing dispatch registration can be retired and a receipted one cannot', () => {
  const identity = { bootId: 'boot-now', pid: 7, pidStart: 'linux:7', lookup: () => null };
  const recorder = { bootId: 'boot-now', pid: 4242, pidStart: 'linux:100', hostId: 'host-old', acquiredAt: '2026-11-07T08:00:00.000Z' };
  const plan = { planId: 'plan-dead', status: 'paused', runner: { status: 'running' }, delegationOrigin: { sessionId: 'dead' } };
  const dead = classifyExecutionObligation({
    plan, identity, writerEpoch: epoch,
    control: { phase: 'reconciling', nextAction: 'execution_stop_unconfirmed', revision: 4, hostEpoch: oldEpoch, operationId: 'cancel-dead', recorder },
  });
  assert.equal(dead.classes.includes('recorder_dead_clear'), false);
  assert.equal(dead.classes.includes('recorder_dead_with_unknown'), true);
  assert.equal(dead.classes.includes('cross_host_unproven'), true);
  assert.equal(dead.classes.includes('external_effect_unknown'), true);
  assert.equal(dead.gaps.includes('host_epoch_mismatch'), true);
  assert.equal(dead.gaps.includes('ownership_unknown'), true);
  assert.equal(dead.gaps.includes('dispatch_registration_absent'), true);
  assert.deepEqual(dead.missingFields, []);
  assert.deepEqual(dead.allowed, ['retire_follow_up', 'acknowledge_unknown']);
  const clear = classifyExecutionObligation({
    plan: { ...plan, planId: 'plan-clear' }, identity, writerEpoch: epoch,
    control: { phase: 'reconciling', nextAction: 'execution_stop_unconfirmed', revision: 4, hostEpoch: epoch, operationId: 'cancel-clear', stopReceipt: { operationId: 'cancel-clear' }, recorder },
  });
  assert.equal(clear.classes.includes('recorder_dead_clear'), true);
  assert.equal(clear.classes.includes('external_effect_unknown'), false);
  assert.deepEqual(clear.allowed, []);
});

test('a user-confirmed close_claim releases the directory and retains the unknown call', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-close-'));
  const directory = path.join(root, 'workspace');
  mkdirSync(directory);
  const row = plan('x', directory, { workId: 'work-x' });
  const plans = new Map([[row.planId, row]]);
  const store = createWorkCoordinationStore({ rootDir: path.join(root, 'runtime'), workspaceId: 'workspace', holdsLease: () => true, leaseEpoch: () => epoch, formatVersion: 2, fenceLegacyWrites: true });
  await store.prepare();
  store.saveWork({ workId: 'work-x', workspaceId: 'workspace', parentConversationId: 'parent', state: 'waiting_children',
    budget: { uncertainDispatches: [{ toolCallId: 'call-x', planId: 'plan-x' }] } });
  const release = registerWorkBudget('workspace', store);
  const scheduler = createExecutionScheduler({ rootDir: path.join(root, 'runtime') });
  scheduler.configure({ ownsWorkspace: () => true, currentPlan: item => plans.get(item.planId) || item });
  scheduler.protectResources(row, { operationId: 'cancel-x', state: 'reconciling', evidenceCalls: ['call-x'] });
  const service = createExecutionObligationService({
    plans: () => [...plans.values()], readControl: item => item.delegationOrigin.executionControl,
    scheduler, canManage: () => true, storeFor: () => store,
    identity: () => ({ bootId: null, pid: 1, pidStart: null, lookup: () => null }),
    writerEpochFor: () => epoch, now: () => '2026-11-09T00:00:00.000Z',
    recordClosure: (target, closure) => { target.delegationOrigin.executionClaimClosure = closure; },
  });
  t.after(() => { scheduler.close(); release(); store.close(); rmSync(root, { recursive: true, force: true }); });

  const inspected = service.inspect({ workspaceId: 'workspace', parentConversationId: 'parent', sessionIds: ['x'], role: 'project_agent' });
  assert.equal(inspected.ok, true, JSON.stringify(inspected));
  const item = inspected.items[0];
  assert.equal(item.closeClaimAvailable, true);
  assert.equal(item.allowedActions.includes('close_claim'), true);

  const withoutAck = service.requestAuthorization({ workspaceId: 'workspace', parentConversationId: 'parent', role: 'project_agent',
    items: [{ obligationId: item.obligationId, sessionId: 'x', operationId: item.operationId, evidenceRevision: item.evidenceRevision, actions: ['close_claim'] }] });
  assert.equal(withoutAck.error, 'unknown_not_acknowledged');

  const requested = service.requestAuthorization({ workspaceId: 'workspace', parentConversationId: 'parent', role: 'project_agent',
    items: [{ obligationId: item.obligationId, sessionId: 'x', operationId: item.operationId, evidenceRevision: item.evidenceRevision, actions: ['acknowledge_unknown', 'close_claim'] }] });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  assert.equal(requested.consequences.resourceWillRemain, false);
  const confirmed = service.confirm({ actor: 'user_panel', workspaceId: 'workspace', parentConversationId: 'parent', grantId: requested.grantId });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const resolved = service.resolve({ workspaceId: 'workspace', parentConversationId: 'parent', actor: 'user_panel', grantId: requested.grantId,
    idempotencyKey: requested.idempotencyKey,
    items: confirmed.grant.items.map(entry => ({ sessionId: entry.sessionId, operationId: entry.operationId, actions: entry.actions })) });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  const applied = resolved.items[0];
  assert.equal(applied.result, 'applied', JSON.stringify(applied));
  assert.equal(applied.closure.unknownCalls[0], 'call-x');
  assert.equal(applied.claim.state, 'released');
  assert.equal(scheduler.resourceSnapshot().length, 0);
  assert.equal(scheduler.retainedUnknowns(row).length, 1);
  assert.equal(service.dispositionFor('workspace', 'x'), 'indexed');
  assert.equal(row.delegationOrigin.executionClaimClosure.closureId, applied.closure.closureId);
});
