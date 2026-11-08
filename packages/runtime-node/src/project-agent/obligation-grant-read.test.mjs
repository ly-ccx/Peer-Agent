import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExecutionObligationService, obligationDisplayTitle, readPersistedObligationGrants, selectPendingGrants } from './execution-obligation.mjs';
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

test('raising the ledger to format 11 does not reject an already fenced baseline', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-obligation-fence-'));
  const opt = { rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'host:1', formatVersion: 2, fenceLegacyWrites: true };
  const legacy = createWorkCoordinationStore({ ...opt, formatVersion: 1, fenceLegacyWrites: false });
  legacy.saveWork({ workId: 'goal', state: 'runnable' });
  legacy.close();
  const first = createWorkCoordinationStore(opt);
  await first.prepare();
  unlinkSync(path.join(root, 'w', 'coordination-fence.json'));
  first.writeObligation({ kind: 'obligation_grant', minimumExecutorVersion: 11, grant: {
    grantId: 'g1', status: 'pending', revision: 1, principal: { workspaceId: 'w' },
    items: [{ sessionId: 's', operationId: 'o', actions: ['retire_follow_up'], evidenceRevision: 'r' }],
  } });
  const sealPath = path.join(root, 'w', 'coordination-v2/legacy-seal.json');
  const seal = readFileSync(sealPath);
  first.close();
  const second = createWorkCoordinationStore(opt);
  await second.prepare();
  assert.equal(second.read().obligationGrants.g1.status, 'pending');
  assert.deepEqual(readFileSync(sealPath), seal);
  second.close();
  appendFileSync(path.join(root, 'w', 'coordination-v2/baseline.jsonl'), '\n');
  const third = createWorkCoordinationStore(opt);
  await assert.rejects(third.prepare(), error => {
    assert.equal(error.code, 'coordination_legacy_changed');
    assert.equal(error.legacy.seal, 'present');
    assert.equal(error.legacy.change, 'content');
    assert.equal(error.legacy.file, 'baseline');
    return true;
  });
  assert.deepEqual(readFileSync(sealPath), seal);
  third.close();
  rmSync(root, { recursive: true, force: true });
});

test('a missing writer is not reported as a missing grant', () => {
  const service = createExecutionObligationService({
    plans: () => [], readControl: () => null, scheduler: {}, canManage: () => true, storeFor: () => undefined,
    identity: () => ({}), writerEpochFor: () => 'epoch',
  });
  assert.throws(() => service.confirm({ actor: 'user_panel', workspaceId: 'w', grantId: 'g', parentConversationId: 'parent' }), /obligation_storage_unavailable/);
  assert.equal(obligationDisplayTitle({ sessionId: '07ed2604-1111-4111-8111-111111111111', title: '07ed2604-1111-4111-8111-111111111111' }, '').shortId, '07ed2604');
  assert.equal(obligationDisplayTitle({ sessionId: 's', title: 's' }, '旧记录甲').title, '旧记录甲');
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
