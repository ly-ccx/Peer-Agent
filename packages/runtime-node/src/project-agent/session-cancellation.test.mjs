import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCancellation } from './session-cancellation.mjs';

test('an empty unknown set is settled instead of being skipped as a stable refusal', async () => {
  const plan = {
    planId: 'plan-empty', conversationId: 'conversation', status: 'paused', runner: { status: 'paused' },
    delegationOrigin: {
      sessionId: 'session-empty', workspaceId: 'workspace', parentConversationId: 'parent', phase: 'paused',
      cancellation: { operationId: 'cancel-empty', phase: 'awaiting_outcome', evidenceCalls: [], reason: 'cancelled', requestedAt: '2026-11-09T00:00:00.000Z' },
    },
  };
  const drained = [];
  const goalPlanStore = {
    getPlan: () => plan,
    revisePlan: (_id, patch) => { Object.assign(plan, patch); if (patch.delegationOrigin) plan.delegationOrigin = patch.delegationOrigin; },
    setPlanStatus: (_id, status) => { plan.status = status; },
  };
  const sessionControl = {
    refusalStable: () => true,
    clearable: () => true,
    begin: () => ({ operationId: 'cancel-empty' }),
    drain: async () => {
      drained.push('drain');
      return { receiptId: 'stop-empty', operationId: 'cancel-empty', execution: { planId: plan.planId, sessionId: 'session-empty', executionEpoch: 'epoch-empty' },
        admissionClosed: true, runnerIdle: true, schedulerIdle: true, resourceClaims: [], unknownCalls: [], scope: 'managed_execution', completedAt: '2026-11-09T00:00:01.000Z' };
    },
    settle: () => ({ phase: 'settled', outcome: 'applied' }),
    retireTakeover: () => {},
    read: () => ({ operationId: 'cancel-empty', phase: 'reconciling' }),
  };
  const cancellations = createSessionCancellation({
    findBySession: () => plan,
    goalPlanStore, sessionControl,
    goalRunner: {}, executionScheduler: { cancelPlan: () => {} }, canManageWorkspace: () => true,
    exclusive: run => run(), project: () => ({ status: plan.status, actionRight: 'terminal', nextAction: 'none', followUp: { inCurrentList: plan.status !== 'cancelled' } }),
    emit: () => {}, promote: async () => {}, readMessages: () => [], now: () => '2026-11-09T00:00:02.000Z',
  });

  await cancellations.recover([plan]);
  assert.deepEqual(drained, ['drain'], 'an empty unknown set must reach the barrier even when the refusal digest is stable');
  assert.equal(plan.status, 'cancelled');
  assert.equal(plan.delegationOrigin.cancellation.phase, 'completed');
});
