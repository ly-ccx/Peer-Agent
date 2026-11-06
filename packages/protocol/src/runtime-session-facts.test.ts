import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkSession } from './delegation.ts';
import { runtimeSessionFacts, runtimeSessionOwnership, hasPendingRuntimeSessions } from './runtime-session-facts.ts';

test('the public work-session projection carries the producer execution enum to pending-obligation consumers', () => {
  const projected = projectWorkSession({ planId: 'plan', title: 'Task', status: 'completed', delegated: true, accepted: true }, {
    workspaceId: 'workspace', sessionId: 'session', accepted: true, executionOwnership: 'live',
    origin: { anchorMessageId: 'input', inputId: 'input', surface: 'desktop', memorySnapshotId: 'memory', modelSelection: {} } as never,
  });
  assert.equal(projected.executionOwnership, 'live');
  assert.equal(hasPendingRuntimeSessions([projected]), true);
  assert.equal(runtimeSessionFacts(projected).handling, 'host');
});

test('a false object-shaped active flag cannot stand in for the three-state ownership contract', () => {
  const invalid = runtimeSessionFacts({ sessionId: 'session', status: 'accepted', executionOwnership: { active: false },
    followUp: { owner: 'none', reason: 'settled' } });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.executionOwnership, 'unknown');
  assert.equal(invalid.handling, 'host');
  assert.equal(invalid.pendingManaged, true);
});

test('uncertain stop settlement remains visible responsibility without becoming model repair', () => {
  const row = { sessionId: 'old', status: 'cancelled', executionOwnership: 'unknown',
    followUp: { owner: 'bot', inCurrentList: true, reason: 'stop_unconfirmed' } };
  assert.deepEqual(runtimeSessionOwnership([row]).repairSessionIds, []);
  assert.deepEqual(runtimeSessionOwnership([row]).hostSessionIds, ['old']);
  assert.equal(hasPendingRuntimeSessions([row]), true);
});

test('confirmed withdrawal preserves unknown history without reopening managed responsibility', () => {
  const row = { sessionId: 'old', status: 'cancelled', executionOwnership: 'unknown',
    followUp: { owner: 'none', inCurrentList: false, reason: 'user_withdrawn' } };
  assert.equal(runtimeSessionFacts(row).handling, 'none');
  assert.equal(hasPendingRuntimeSessions([row]), false);
  assert.equal(hasPendingRuntimeSessions([{ ...row, executionOwnership: 'live' }]), true);
});

test('technical repair, human requests and advancing execution retain distinct handlers', () => {
  assert.equal(runtimeSessionFacts({ sessionId: 'failed', status: 'failed', executionOwnership: 'ended' }).handling, 'model');
  assert.equal(runtimeSessionFacts({ sessionId: 'human', status: 'waiting_user' }).handling, 'user');
  assert.equal(runtimeSessionFacts({ sessionId: 'running', status: 'running', executionOwnership: 'live' }).handling, 'host');
  assert.equal(runtimeSessionFacts({ sessionId: 'accepted', status: 'accepted' }).handling, 'none');
});

test('missing identities and invalid public enums remain host obligations', () => {
  for (const row of [{ status: 'accepted' }, { sessionId: 'bad', status: 'done' },
    { sessionId: 'bad', status: 'accepted', followUp: { owner: 'none', reason: 'invented' } },
    { sessionId: 'bad', status: 'accepted', resultConfirmationRequired: 'true' }]) {
    assert.equal(runtimeSessionFacts(row).valid, false);
    assert.equal(hasPendingRuntimeSessions([row]), true);
  }
  assert.equal(hasPendingRuntimeSessions([], ['missing']), true);
});

test('host-owned local persistence failure remains a current Bot obligation rather than model verification repair', () => {
  const session = projectWorkSession({ planId: 'p', title: 'Task', status: 'failed', runnerStatus: 'failed',
    blockedReason: 'conversation_persistence_failed', delegated: true }, {
    workspaceId: 'w', sessionId: 's', executionOwnership: 'ended',
    origin: { anchorMessageId: 'input', inputId: 'input', surface: 'desktop', memorySnapshotId: 'memory', modelSelection: {} } as never,
  });
  assert.equal(session.followUp?.owner, 'bot');
  assert.equal(session.followUp?.reason, 'local_persistence_failed');
  assert.deepEqual(runtimeSessionOwnership([session]).repairSessionIds, []);
  assert.deepEqual(runtimeSessionOwnership([session]).hostSessionIds, ['s']);
  assert.equal(hasPendingRuntimeSessions([session]), true);
});
