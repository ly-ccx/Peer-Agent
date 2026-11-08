import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExecutionObligationService, readPersistedObligationGrants, selectPendingGrants } from './execution-obligation.mjs';
import { createExecutionScheduler } from './execution-scheduler.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';

const epoch = 'syn-host-now:2026-11-08T04:00:00.000Z';
const oldEpoch = 'syn-host-old:2026-11-07T08:00:00.000Z';

function plan(id) {
  return { planId: `plan-${id}`, title: id, status: 'paused', runner: { status: 'running' },
    delegationOrigin: { sessionId: id, workspaceId: 'workspace', parentConversationId: 'parent', phase: 'paused',
      executionControl: { kind: 'cancel', operationId: `cancel-${id}`, phase: 'reconciling', nextAction: 'execution_stop_unconfirmed',
        revision: 4, hostEpoch: oldEpoch, sessionId: id, planId: `plan-${id}` } } };
}

test('a pending grant survives a normal close and a format-11 rebuild', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-restart-'));
  const runtime = path.join(root, 'runtime');
  const plans = new Map(['a'].map(id => { const row = plan(id); return [row.planId, row]; }));
  const open = async () => {
    const store = createWorkCoordinationStore({ rootDir: runtime, workspaceId: 'workspace', holdsLease: () => true, leaseEpoch: () => epoch, formatVersion: 2, fenceLegacyWrites: true });
    await store.prepare();
    return store;
  };
  const first = await open();
  const scheduler = createExecutionScheduler({ rootDir: runtime });
  const service = createExecutionObligationService({
    plans: () => [...plans.values()], readControl: item => item.delegationOrigin.executionControl,
    scheduler, canManage: () => true, storeFor: () => first,
    identity: () => ({ bootId: null, pid: 1, pidStart: null, lookup: () => null }),
    writerEpochFor: () => epoch, now: () => '2026-11-08T05:00:00.000Z',
  });
  const inspected = service.inspect({ workspaceId: 'workspace', parentConversationId: 'parent', sessionIds: ['a'], role: 'project_agent' });
  const requested = service.requestAuthorization({ workspaceId: 'workspace', parentConversationId: 'parent', role: 'project_agent',
    items: inspected.items.map(item => ({ obligationId: item.obligationId, sessionId: item.sessionId, operationId: item.operationId, evidenceRevision: item.evidenceRevision, actions: [...item.allowedActions] })) });
  assert.equal(requested.ok, true, JSON.stringify(requested));
  first.close();
  const second = await open();
  const persisted = readPersistedObligationGrants({ rootDir: runtime, workspaceId: 'workspace' });
  assert.equal(persisted.ok, true, JSON.stringify(persisted));
  assert.equal(persisted.grants.length, 1);
  second.close();
  rmSync(path.join(runtime, 'workspace', '.read-models'), { recursive: true, force: true });
  const rebuilt = await open();
  const again = readPersistedObligationGrants({ rootDir: runtime, workspaceId: 'workspace' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.grants[0]?.grantId, requested.grantId);
  rebuilt.close();
  scheduler.close();
  rmSync(root, { recursive: true, force: true });
});

test('legacy grants stay visible only for the owning bot', () => {
  const grants = [
    { grantId: 'legacy', status: 'pending', principal: {}, items: [{ sessionId: 'a' }] },
    { grantId: 'foreign', status: 'pending', principal: { parentConversationId: 'other-bot' }, items: [{ sessionId: 'b' }] },
    { grantId: 'mine', status: 'pending', principal: { parentConversationId: 'parent' }, items: [{ sessionId: 'c' }] },
  ];
  const selected = selectPendingGrants(grants, {
    parentConversationId: 'parent',
    ownsSession: grant => grant.grantId === 'legacy',
  });
  assert.deepEqual(selected.grants.map(grant => grant.grantId), ['legacy', 'mine']);
  assert.deepEqual(selected.decisions.map(item => item.reason), ['legacy_session_owner', 'parent_mismatch', 'parent_match']);
});

test('a missing coordination index is an error, not an empty grant list', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-missing-'));
  const directory = path.join(root, 'workspace');
  mkdirSync(path.join(directory, 'coordination-v2'), { recursive: true });
  const result = readPersistedObligationGrants({ rootDir: root, workspaceId: 'workspace' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'obligation_store_unreadable');
  rmSync(root, { recursive: true, force: true });
});
