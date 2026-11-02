import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelegationDispatchRecovery } from './delegation-dispatch-recovery.mjs';

function fixture() {
  let owned = true, writes = 0;
  let work = { workId: 'work', workspaceId: 'workspace', parentConversationId: 'parent', sessionIds: ['child'], revision: 1,
    state: 'waiting_children', budget: { modelRequests: 2, toolCalls: 3, tokens: 40, costUsd: 1,
      attempts: { old: { role: 'project_agent', checkpointRef: 'native', pendingTools: [{ toolCallId: 'spawn', capabilityId: 'spawn_session' }] } } } };
  const active = new Set();
  const record = { evidenceRef: 'tool-result://spawn', toolCallId: 'spawn', toolName: 'spawn_session',
    capabilityId: 'local.delegation.spawn_session', conversationId: 'parent', streamId: 'turn' };
  const result = { ok: true, phase: 'completed', workId: 'work', sessionId: 'child', goalRevision: 1,
    operationId: 'operation', evidenceRefs: ['tool-result://spawn'] };
  const message = { id: 'turn', kind: 'agent_turn', meta: { workId: 'work' }, rounds: [{ toolCalls: [{ name: 'spawn_session', result }] }] };
  const transition = { phase: 'completed', action: 'parallel', workId: 'work', replacementSessionId: 'child',
    expectedGoalRevision: 1, executionEpoch: 'execution' };
  const origin = { turnId: 'turn' };
  let records = [record], messages = [message];
  const store = { readSnapshot: () => ({ works: { work } }), readWork: () => structuredClone(work),
    readLifecycleFacts: () => ({ transitions: { operation: transition } }), dispatchOrigin: () => origin,
    assertOwner() { if (!owned) throw Error('lease_lost'); },
    saveWork(next) { this.assertOwner(); writes++; work = { ...structuredClone(next), revision: work.revision + 1 }; } };
  const options = { store, readMessages: () => messages, findEvidenceRecords: () => records, activeAttempts: () => active,
    now: () => '2026-11-02T00:00:00.000Z' };
  return { options, result, message, transition, origin, record, active,
    get work() { return work; }, get writes() { return writes; },
    setRecords(value) { records = value; }, setMessages(value) { messages = value; }, loseLease() { owned = false; } };
}

test('a registered completed spawn settles its exact stale dispatch and retires the inactive attempt', () => {
  const f = fixture(), recovery = createDelegationDispatchRecovery(f.options);
  recovery.reconcileAll();
  assert.deepEqual(f.work.budget.attempts, {});
  assert.deepEqual(f.work.budget.uncertainDispatches, []);
  assert.equal(f.work.budget.settledDispatches[0].executionEpoch, 'execution');
  assert.equal(f.work.budget.settledDispatches[0].evidenceRef, 'tool-result://spawn');
  assert.equal(f.work.budget.unknownUsage, true);
  assert.equal(f.work.budget.unknownCost, true);
  assert.deepEqual([f.work.budget.modelRequests, f.work.budget.toolCalls, f.work.budget.tokens, f.work.budget.costUsd], [2, 3, 40, 1]);
  assert.equal(f.work.state, 'waiting_children');
  assert.deepEqual(f.work.sessionIds, ['child']);
  recovery.reconcileAll();
  assert.equal(f.writes, 1, 'recovery never replays spawn or rewrites its receipt');
});

for (const [name, change] of Object.entries({
  'live attempt': f => f.active.add('old'),
  'missing index': f => f.setRecords([]),
  'ambiguous index': f => f.setRecords([f.record, f.record]),
  'foreign conversation': f => { f.record.conversationId = 'foreign'; },
  'foreign turn': f => { f.record.streamId = 'foreign'; },
  'wrong capability': f => { f.record.capabilityId = 'local.file.write'; },
  'missing dispatch origin': f => { delete f.origin.turnId; },
  'narration': f => { f.message.kind = 'agent_reply'; },
  'truncated preview': f => { f.result.kind = 'truncated_tool_result_preview'; delete f.result.ok; },
  'unknown result': f => { f.result.ok = false; f.result.error = 'cancelled_outcome_unknown'; },
  'foreign work': f => { f.result.workId = 'foreign'; },
  'different result ref': f => { f.result.evidenceRefs = ['tool-result://other']; },
  'unfinished transition': f => { f.transition.phase = 'started'; },
  'different target': f => { f.transition.replacementSessionId = 'other'; },
  'different goal version': f => { f.transition.expectedGoalRevision = 2; },
  'lost ownership': f => f.loseLease(),
})) test(`${name} cannot settle a dispatch or authorize a resource release`, () => {
  const f = fixture(); change(f);
  createDelegationDispatchRecovery(f.options).reconcileAll();
  assert.equal(f.writes, 0);
  assert.equal(f.work.budget.attempts.old.pendingTools.length, 1);
});

test('a settled spawn cannot erase another unknown call from its attempt', () => {
  const f = fixture();
  f.work.budget.attempts.old.pendingTools.push({ toolCallId: 'unknown-write', capabilityId: 'local.file.write' });
  createDelegationDispatchRecovery(f.options).reconcileAll();
  assert.deepEqual(f.work.budget.attempts.old.pendingTools, [{ toolCallId: 'unknown-write', capabilityId: 'local.file.write' }]);
  assert.equal(f.work.budget.settledDispatches.length, 1);
});

test('the historical uncertain-dispatch form is paired by attempt and tool identity', () => {
  const f = fixture();
  f.work.budget.uncertainDispatches = [{ ...f.work.budget.attempts.old.pendingTools[0], attemptId: 'old', role: 'project_agent' }];
  f.work.budget.attempts = {};
  createDelegationDispatchRecovery(f.options).reconcileAll();
  assert.deepEqual(f.work.budget.uncertainDispatches, []);
  assert.equal(f.work.budget.settledDispatches[0].toolCallId, 'spawn');
});

test('a retired parent attempt still reconciles its leftover claim using the indexed canonical result', () => {
  const f = fixture(); f.work.budget.attempts = {};
  const claim = { claimId: 'claim', revision: 2, workspaceId: 'workspace', evidenceCalls: ['spawn'],
    execution: { sessionId: 'child', executionEpoch: 'execution', goalRevision: 1 } };
  const recovery = createDelegationDispatchRecovery({ ...f.options, readResourceClaims: () => [claim] });
  recovery.reconcileAll();
  assert.equal(f.work.budget.settledDispatches[0].turnId, 'turn');
  assert.equal(f.work.budget.settledDispatches[0].attemptId, undefined);
  assert.equal(f.work.budget.settledDispatches[0].executionEpoch, 'execution');
  recovery.reconcileAll();
  assert.equal(f.writes, 1, 'the completed claim proof does not churn the work revision');
});

test('a claim from another execution cannot borrow a completed spawn receipt', () => {
  const f = fixture(); f.work.budget.attempts = {};
  const recovery = createDelegationDispatchRecovery({ ...f.options, readResourceClaims: () => [{ claimId: 'claim', revision: 2,
    workspaceId: 'workspace', evidenceCalls: ['spawn'], execution: { sessionId: 'child', executionEpoch: 'other', goalRevision: 1 } }] });
  recovery.reconcileAll();
  assert.equal(f.writes, 0);
});

test('a revision change during receipt retrieval is retried against the new work, never overwritten', () => {
  const f = fixture(); let reads = 0;
  createDelegationDispatchRecovery({ ...f.options, findEvidenceRecords() {
    if (++reads === 2) { f.work.revision++; f.work.newFact = 'retained'; }
    return [f.record];
  } }).reconcileAll();
  assert.equal(f.writes, 0);
  assert.equal(f.work.newFact, 'retained');
});
