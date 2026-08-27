import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoalApplicationService } from './goal-application-service.mjs';

function createHarness(overrides = {}) {
  const calls = [];
  const port = (name, result = name) => (...args) => {
    calls.push([name, ...args]);
    return result;
  };
  const service = createGoalApplicationService({
    listPlanDetails: port('list'),
    listPlanDetailsByConversation: port('list-conversation'),
    countAwaitingApprovalsByConversation: port('awaiting-counts'),
    getPlan: port('get'),
    createPlan: port('create'),
    revisePlan: port('revise'),
    recordApproval: port('approve', { planId: 'plan-1' }),
    setPlanStatus: port('set-status'),
    markRequestedUserInput: port('mark-requested-user-input'),
    recordManualConfirmation: port('manual-confirmation'),
    recordTaskEvidence: port('task-evidence'),
    deletePlan: port('delete'),
    retryHandoff: port('retry-handoff'),
    inspectSourceCheckout: port('inspect-source'),
    isolate: port('isolate'),
    openSite: port('open-site'),
    discardLine: port('discard-line'),
    exportEvidence: port('export-evidence'),
    startRunner: port('start-runner'),
    getRunnerState: port('runner-state'),
    pauseRunner: port('pause-runner'),
    resumeRunner: port('resume-runner'),
    clearRunner: port('clear-runner'),
    ...overrides,
  });
  return { calls, service };
}

test('list chooses the same all-plans or conversation projection', () => {
  const { calls, service } = createHarness();

  assert.equal(service.list(), 'list');
  assert.equal(service.list({ conversationId: null }), 'list-conversation');
  assert.deepEqual(calls, [
    ['list'],
    ['list-conversation', null],
  ]);
});

test('approval persists first and only starts the runner for approve', () => {
  const { calls, service } = createHarness();

  assert.deepEqual(service.approve({ planId: 'plan-1', approval: { decision: 'reject' } }), {
    planId: 'plan-1',
  });
  assert.deepEqual(service.approve({ planId: 'plan-1', approval: { decision: 'approve' } }), {
    planId: 'plan-1',
  });
  assert.deepEqual(calls, [
    ['approve', 'plan-1', { decision: 'reject' }],
    ['approve', 'plan-1', { decision: 'approve' }],
    ['start-runner', 'plan-1'],
  ]);
});

test('delete returns the refreshed plan detail list', () => {
  const calls = [];
  const { service } = createHarness({
    deletePlan(planId) {
      calls.push(['delete', planId]);
    },
    listPlanDetails() {
      calls.push(['list']);
      return [{ planId: 'remaining' }];
    },
  });

  assert.deepEqual(service.remove({ planId: 'plan-1' }), [{ planId: 'remaining' }]);
  assert.deepEqual(calls, [['delete', 'plan-1'], ['list']]);
});

test('goal plan and runner commands preserve payload mapping', () => {
  const { calls, service } = createHarness();

  assert.equal(service.awaitingCounts(), 'awaiting-counts');
  assert.equal(service.get({ planId: 'p' }), 'get');
  assert.equal(service.create({ draft: { title: 'T' } }), 'create');
  assert.equal(service.revise({ planId: 'p', patch: { title: 'N' }, reason: 'why', changedBy: 'user' }), 'revise');
  assert.equal(service.setStatus({ planId: 'p', status: 'paused' }), 'set-status');
  assert.equal(service.recordManualConfirmation({ planId: 'p', confirmation: { accepted: true } }), 'manual-confirmation');
  assert.equal(service.recordTaskEvidence({ planId: 'p', taskId: 't', change: { status: 'completed' } }), 'task-evidence');
  assert.equal(service.getRunnerState({ planId: 'p' }), 'runner-state');
  assert.equal(service.startRunner(undefined), 'start-runner');
  assert.equal(service.pauseRunner({ planId: 'p' }), 'pause-runner');
  assert.equal(service.resumeRunner(undefined), 'resume-runner');
  assert.equal(service.retryHandoff({ planId: 'p' }), 'retry-handoff');
  assert.equal(
    service.inspectSourceCheckout({ workspacePath: '/tmp/repo' }),
    'inspect-source',
  );
  assert.equal(service.isolate({ planId: 'p' }), 'isolate');
  assert.equal(service.openSite({ planId: 'p', mode: 'editor' }), 'open-site');
  assert.equal(service.discardLine({ planId: 'p', deleteBranch: true }), 'discard-line');
  assert.equal(service.exportEvidence({ planId: 'p' }), 'export-evidence');
  assert.equal(service.clearRunner({ planId: 'p' }), 'clear-runner');

  assert.deepEqual(calls, [
    ['awaiting-counts'],
    ['get', 'p'],
    ['create', { title: 'T' }],
    ['revise', 'p', { title: 'N' }, { reason: 'why', changedBy: 'user' }],
    ['set-status', 'p', 'paused'],
    ['manual-confirmation', 'p', { accepted: true }],
    ['task-evidence', 'p', 't', { status: 'completed' }],
    ['runner-state', 'p'],
    ['start-runner', undefined, undefined],
    ['pause-runner', 'p'],
    ['resume-runner', undefined, undefined],
    ['retry-handoff', 'p'],
    ['inspect-source', undefined, { workspacePath: '/tmp/repo' }],
    ['isolate', 'p'],
    ['open-site', 'p', { mode: 'editor' }],
    ['discard-line', 'p', { deleteBranch: true }],
    ['export-evidence', 'p'],
    ['clear-runner', 'p'],
  ]);
});
