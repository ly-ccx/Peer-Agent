import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { admitCoordinationDecision, executionBindingCurrent } from './coordination-kernel.mjs';
const host = { workspaceId: 'w', parentConversationId: 'parent', holdsLease: true, currentInputIds: ['a', 'b', 'correction'], eventIds: ['event'], materialRefs: ['image:a'], now: '2026-10-10T00:00:00Z' };
const command = (id, workId, inputId, action = 'parallel', expectedRevision = 0) => ({ operationId: id, workId, sourceInputIds: [inputId], sourceEventIds: [], action, expectedRevision, reason: 'user goal' });
function world() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-coordination-'));
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner' };
  return { store: createWorkCoordinationStore(options), reopen: () => createWorkCoordinationStore(options), close: () => rmSync(rootDir, { recursive: true, force: true }) };
}
test('each input retains a durable decision; revising A does not revise or pause B', () => {
  const w = world(); try {
    assert.equal(w.store.decide(command('one', 'A', 'a'), host).ok, true);
    assert.equal(w.store.decide(command('two', 'B', 'b'), host).ok, true);
    w.store.bindSession('A', 1, 'sa');
    const correction = { ...command('three', 'A', 'correction', 'replace', 1), sessionId: 'sa' };
    assert.equal(w.store.decide(correction, host).ok, true);
    const state = w.reopen().read();
    assert.equal(state.mandates.A.goalRevision, 2); assert.equal(state.mandates.B.goalRevision, 1);
    assert.deepEqual(state.inputBindings, { a: ['one'], b: ['two'], correction: ['three'] });
    assert.equal(state.transitions.three.phase, 'recorded');
    assert.equal(w.store.decide(correction, host).replayed, true);
    assert.equal(w.store.decide({ ...correction, reason: 'different' }, host).error, 'operation_identity_conflict');
    assert.equal(w.store.decide({ ...correction, operationId: 'stale' }, host).error, 'goal_revision_conflict');
  } finally { w.close(); }
});
test('host scope, canonical input and active mandate are required; model cannot sign authority', () => {
  const state = { events: { event: { event: { sessionId: 'sa' } } } };
  const decision = command('one', 'A', 'a');
  assert.equal(admitCoordinationDecision(state, { ...decision, executionEpoch: 'forged' }, host).error, 'untrusted_coordination_authority');
  assert.equal(admitCoordinationDecision(state, { ...decision, sourceInputIds: ['file-instruction'] }, host).error, 'source_not_admitted');
  assert.equal(admitCoordinationDecision(state, { ...decision, sourceInputIds: [], sourceEventIds: ['event'] }, host).error, 'mandate_inactive');
  const w = world(); try {
    w.store.decide(decision, host); w.store.bindSession('A', 1, 'sa');
    const next = { ...command('two', 'A', 'correction', 'cancel', 1), sessionId: 'sa' };
    assert.equal(w.store.decide(next, { ...host, scopedSessionIds: ['sb'] }).error, 'out_of_scope');
    assert.equal(w.store.decide(next, { ...host, parentConversationId: 'other' }).error, 'out_of_scope');
    w.store.decide(next, host);
    assert.equal(w.store.decide({ ...next, operationId: 'wake', expectedRevision: 2, sourceInputIds: [], sourceEventIds: ['event'] }, host).error, 'event_out_of_scope');
  } finally { w.close(); }
});
test('transition replay has ordered phases and rejects stale execution; legacy records do not acquire authority', () => {
  const w = world(); try {
    w.store.saveWork({ workId: 'legacy', state: 'runnable' });
    assert.equal(w.store.read().mandates, undefined);
    w.store.decide(command('one', 'A', 'a'), host);
    const state = w.store.read(), transition = state.transitions.one;
    const binding = { workId: 'A', goalRevision: 1, executionEpoch: transition.executionEpoch };
    assert.equal(executionBindingCurrent(state.mandates.A, transition, binding), true);
    w.store.advanceTransition('one', 'recorded', { phase: 'ready' });
    assert.throws(() => w.store.advanceTransition('one', 'recorded', { phase: 'started' }), /transition_phase_conflict/);
    assert.throws(() => w.store.advanceTransition('one', 'ready', { phase: 'recorded' }), /invalid_transition_phase/);
    w.store.decide(command('two', 'A', 'correction', 'revise', 1), host);
    assert.equal(executionBindingCurrent(w.store.read().mandates.A, transition, binding), false);
    assert.equal(w.reopen().read().transitions.one.phase, 'ready');
  } finally { w.close(); }
});
