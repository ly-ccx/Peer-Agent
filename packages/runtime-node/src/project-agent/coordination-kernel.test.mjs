import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { reduceCoordination } from './work-coordination.mjs';
import { admitCoordinationDecision, executionBindingCurrent } from './coordination-kernel.mjs';
const host = { workspaceId: 'w', parentConversationId: 'parent', holdsLease: true, currentInputIds: ['a', 'b', 'correction'], eventIds: ['event'], materialRefs: ['image:a'], now: '2026-10-10T00:00:00Z' };
const command = (id, workId, inputId, action = 'parallel', expectedRevision = 0) => ({ operationId: id, workId, sourceInputIds: [inputId], sourceEventIds: [], action, expectedRevision, reason: 'user goal' });
function world() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-coordination-'));
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner' };
  return { store: createWorkCoordinationStore(options), reopen: () => createWorkCoordinationStore(options), close: () => rmSync(rootDir, { recursive: true, force: true }) };
}

test('current cancellation may settle a cancelled mandate without reactivating it or permitting replacement', () => {
 const w=world();try{
  w.store.decide(command('one','A','a'),host);w.store.bindSession('A',1,'sa');
  const before=w.store.read(),state={...before,mandates:{...before.mandates,A:{...before.mandates.A,lifecycle:'cancelled'}}};
  const cancel={...command('cancel','A','correction','cancel',1),sessionId:'sa'};
  const result=admitCoordinationDecision(state,cancel,host);
  assert.equal(result.ok,true);assert.equal(result.entry.mandate.lifecycle,'cancelled');
  assert.equal(result.entry.mandate.executionBindings.sa,undefined);
  assert.equal(admitCoordinationDecision(state,{...cancel,action:'replace'},host).error,'mandate_inactive');
  assert.equal(admitCoordinationDecision(state,{...cancel,sourceInputIds:[],sourceEventIds:['event']},host).error,'mandate_inactive');
 }finally{w.close();}
});
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

test('transition patches do not retain caller-owned handoff objects', () => {
  const before = { revision: 1, events: {}, works: {}, deliveries: {}, transitions: { one: { phase: 'recorded' } } };
  const patch = { phase: 'ready', handoff: { result: 'original' } };
  const next = reduceCoordination(before, { kind: 'coordination_transition', revision: 2, operationId: 'one', expectedPhase: 'recorded', patch });
  patch.handoff.result = 'mutated';
  assert.equal(next.transitions.one.handoff.result, 'original');
  assert.equal(before.transitions.one.phase, 'recorded');
});

test('resume retains the task revision, fences the old executor and requires a new execution receipt', () => {
  const w = world(); try {
    w.store.decide(command('spawn', 'A', 'a'), host);
    const original = w.store.read().transitions.spawn;
    w.store.bindSession('A', 1, 'sa', { workId: 'A', goalRevision: 1, executionEpoch: original.executionEpoch });
    const resumed = w.store.decide({ ...command('resume', 'A', 'a', 'resume', 1), sessionId: 'sa' }, host);
    assert.equal(resumed.ok, true);
    const state = w.store.read();
    assert.equal(state.mandates.A.goalRevision, 1);
    assert.equal(state.transitions.resume.minimumExecutorVersion, 2);
    assert.equal(executionBindingCurrent(state.mandates.A, original, { workId: 'A', goalRevision: 1, executionEpoch: original.executionEpoch, sessionId: 'sa' }), false);
    assert.equal(state.transitions.resume.executionEffect, undefined);
  } finally { w.close(); }
});
