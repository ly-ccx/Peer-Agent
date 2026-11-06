import test from 'node:test';
import assert from 'node:assert/strict';
import { fencedResumeStop, takeoverStopReceipt } from './takeover-stop-recovery.mjs';

function fixture() {
  const execution = { planId: 'plan', sessionId: 'session', executionEpoch: 'old-epoch', goalRevision: 1 };
  const scope = { workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'session', planId: 'plan' };
  const stopped = { ...scope, kind: 'takeover', operationId: 'takeover', authorityRef: 'coordination:takeover',
    phase: 'settled', outcome: 'applied', expectedExecution: execution,
    stopReceipt: { operationId: 'takeover', receiptId: 'stop:takeover', execution, scope: 'managed_execution',
      unknownCalls: [], admissionClosed: true, runnerIdle: true, schedulerIdle: true, completedAt: '2026-11-03T02:03:00Z' } };
  const resumed = { ...scope, kind: 'resume', operationId: 'resume:input', authorityRef: 'input', phase: 'settled', outcome: 'applied',
    expectedExecution: execution, priorStopReceiptId: 'stop:takeover', updatedAt: '2026-11-03T02:04:00Z' };
  const plan = { planId: 'plan', status: 'paused', runner: { status: 'paused', turnCount: 0, toolCallCount: 0 },
    delegationOrigin: { ...scope, workId: 'work', phase: 'queued', executionGeneration: resumed.operationId,
      lastResumeAnchorMessageId: 'input', coordinationBinding: { workId: 'work', ...execution },
      takeover: { operationId: 'takeover', phase: 'stopping', binding: { workId: 'work', executionEpoch: 'proposed-epoch', goalRevision: 1 } } } };
  const state = { works: { work: { workId: 'work', workspaceId: 'workspace', parentConversationId: 'parent', state: 'blocked_system', stopScope: 'reply' } },
    mandates: { work: { workspaceId: 'workspace', parentConversationId: 'parent', lifecycle: 'active', goalRevision: 1,
      sessionIds: ['session'], revokedSessionIds: ['session'], executionBindings: {} } },
    transitions: { takeover: { operationId: 'takeover', workId: 'work', oldSessionId: 'session', expectedGoalRevision: 1,
      executionEpoch: 'proposed-epoch', action: 'resume', phase: 'awaiting_outcome', sourceInputIds: ['input'] } },
    sessionControls: { takeover: stopped, 'resume:input': resumed }, sessionControlHeads: { session: { operationId: resumed.operationId } } };
  const messages = [{ id: 'input', role: 'user', kind: 'user_input' }];
  const facts = { live: false, handles: false, unknownCalls: [], claims: [{ state: 'draining', evidenceCalls: [] }] };
  return { plan, state, messages, facts, stopped, resumed };
}

test('a never-admitted resume is proved by original stop, canonical source, revoked binding and current generation together', () => {
  const f = fixture(), proof = fencedResumeStop(f.plan, f.state, f.messages, f.facts);
  assert.equal(proof.kind, 'pause');
  assert.equal(proof.authorityRef, 'coordination-recovery:takeover');
  assert.equal(proof.execution.generation, 'resume:input');
  assert.deepEqual(fencedResumeStop(f.plan, f.state, f.messages, f.facts), proof);
  const control = { ...proof, phase: 'settled', outcome: 'applied', expectedExecution: proof.execution,
    workspaceId: 'workspace', parentConversationId: 'parent',
    stopReceipt: { ...f.stopped.stopReceipt, operationId: proof.operationId, execution: proof.execution, receiptId: 'fresh-stop' } };
  assert.equal(takeoverStopReceipt(f.plan, control, 'takeover').receiptId, 'fresh-stop');
  assert.equal(takeoverStopReceipt(f.plan, { ...control, authorityRef: 'coordination-recovery:other' }, 'takeover'), null);
  assert.equal(takeoverStopReceipt(f.plan, { ...control, expectedExecution: f.stopped.expectedExecution }, 'takeover'), null);
  f.state.transitions.older = { operationId: 'older', oldSessionId: 'session', phase: 'completed' };
  assert.deepEqual(fencedResumeStop(f.plan, f.state, f.messages, f.facts), proof, 'object enumeration order cannot supersede current host custody');
});

const mutations = {
  'missing canonical anchor': f => { f.messages = []; },
  'foreign source': f => { f.resumed.parentConversationId = 'other'; },
  'stale goal': f => { f.state.mandates.work.goalRevision = 2; },
  'a different proposal identity': f => { f.state.transitions.takeover.operationId = 'other'; },
  'a different proposal target': f => { f.state.transitions.takeover.oldSessionId = 'other'; },
  'a rebound execution': f => { f.state.mandates.work.executionBindings.session = { executionEpoch: 'new' }; },
  'a later proposal': f => { f.state.transitions.newer = { operationId: 'newer', oldSessionId: 'session' }; },
  'a later control': f => { f.state.sessionControlHeads.session.operationId = 'newer'; },
  'a different prior receipt': f => { f.resumed.priorStopReceiptId = 'other'; },
  'unknown prior effects': f => { f.stopped.stopReceipt.unknownCalls = ['shell']; },
  'unknown current effects': f => { f.facts.unknownCalls = ['shell']; },
  'live execution': f => { f.facts.live = true; },
  'unsettled handle': f => { f.facts.handles = true; },
  'active resource claim': f => { f.facts.claims[0].state = 'active'; },
  'resource side effect': f => { f.facts.claims[0].evidenceCalls = ['shell']; },
  'prior worker turn': f => { f.plan.runner.turnCount = 1; },
  'prior worker action': f => { f.plan.runTrace = { events: [{ type: 'action_started' }] }; },
  'user pause': f => { f.plan.delegationOrigin.phase = 'paused'; },
  'work withdrawal': f => { Object.assign(f.state.works.work, { state: 'cancelled', stopScope: 'work' }); },
  'explicit budget': f => { f.state.works.work.state = 'budget_limited'; },
  'already admitted proposal': f => { f.state.transitions.takeover.executionEffect = 'applied'; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`${name} cannot establish fenced-resume recovery`, () => {
  const f = fixture(); mutate(f);
  assert.equal(fencedResumeStop(f.plan, f.state, f.messages, f.facts), null);
});
