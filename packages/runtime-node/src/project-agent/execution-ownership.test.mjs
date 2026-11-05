import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionExecutionCurrent } from './execution-ownership.mjs';
import { registerWorkBudget } from './work-budget.mjs';

test('queued admission reads authoritative lifecycle facts without copying unrelated work history', () => {
  const binding = { workId: 'work', sessionId: 'session', executionEpoch: 'epoch', goalRevision: 1 };
  const state = { mandates: { work: { workId: 'work', lifecycle: 'active', executionBindings: { session: binding } } },
    transitions: { op: { executionEpoch: 'epoch', expectedGoalRevision: 1, phase: 'ready' } } };
  const release = registerWorkBudget('workspace', { readLifecycleFacts: () => state,
    read() { throw new Error('full work history must not be loaded for queue admission'); } });
  const plan = { delegationOrigin: { workspaceId: 'workspace', phase: 'queued', coordinationBinding: binding } };
  try {
    assert.equal(sessionExecutionCurrent(plan), true);
    state.transitions.op.phase = 'awaiting_outcome';
    assert.equal(sessionExecutionCurrent(plan), false);
    state.transitions.op.phase = 'ready'; delete state.mandates.work.executionBindings.session;
    assert.equal(sessionExecutionCurrent(plan), false, 'an idle-looking task cannot replace its revoked binding');
  } finally { release(); }
});
