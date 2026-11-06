import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';

test('a repeatedly updated background wake cannot outrank the original timestamp of a newer user continuation, including after restart', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-input-priority-'));
  const options = { rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner', formatVersion: 2 };
  let store = createWorkCoordinationStore(options); await store.prepare();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const save = (id, inputs) => {
    const checkpointRef = store.checkpoint(id, { job: { workId: id, kind: inputs.length ? 'user' : 'wake', userInputs: inputs, events: [] }, outcome: { yielded: true, rounds: [] } });
    store.saveWork({ workId: id, workspaceId: 'w', parentConversationId: 'p', state: 'runnable', stopScope: 'reply',
      anchorInputIds: [id], sessionIds: [], pendingEventIds: [], consumedEventIds: [], checkpointRef });
  };
  save('old', []);
  save('new', [{ inputId: 'new', createdAt: '2026-11-06T08:01:51Z' }]);
  const coordinator = () => createRunnerCoordination({ store, workspaceId: 'w', conversationId: 'p', inbox: {}, readMessages: () => [], resolveRoster: () => [] });
  for (let n = 0; n < 3; n++) {
    store.saveWork({ ...store.readWork('old'), attemptId: `background-${n}` });
    assert.equal(coordinator().recoverUserJob().workId, 'new');
    store.close(); store = createWorkCoordinationStore(options); await store.prepare();
  }
  store.saveWork({ ...store.readWork('new'), state: 'delivered' });
  assert.equal(coordinator().recoverUserJob().workId, 'old', 'historical responsibility remains eligible after the current input');
});

test('an accepted correction shares the original intake arrival without outranking a later independent input', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-correction-priority-'));
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner', formatVersion: 2 });
  await store.prepare(); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [id, createdAt] of [['goal', '2026-11-06T08:00:00Z'], ['correction', '2026-11-06T08:05:00Z'], ['later', '2026-11-06T08:06:00Z']]) {
    const checkpointRef = store.checkpoint(id, { job: { workId: id, kind: 'user', userInputs: [{ inputId: id, createdAt }], events: [] }, outcome: { yielded: true, rounds: [] } });
    store.saveWork({ workId: id, parentConversationId: 'p', state: 'runnable', anchorInputIds: [id], checkpointRef,
      ...(id === 'goal' ? { intentCoordination: { lifecycle: 'active', decision: { sourceInputIds: ['correction'], disposition: { kind: 'continue' } } } } : {}) });
  }
  const coordinator = createRunnerCoordination({ store, workspaceId: 'w', conversationId: 'p', inbox: {}, readMessages: () => [], resolveRoster: () => [] });
  assert.equal(coordinator.recoverUserJob().workId, 'later');
  store.saveWork({ workId: 'later', state: 'delivered' });
  assert.equal(coordinator.recoverUserJob().workId, 'goal', 'explicit accepted assignment precedes its unassessed intake carrier');
});
