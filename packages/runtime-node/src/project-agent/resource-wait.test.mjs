import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecutionScheduler } from './execution-scheduler.mjs';
import { executionIdentity } from './session-control-kernel.mjs';
import { createResourceWaitPort, requireResourceWaitPort, resourceWaitScope, readResourceWaitFacts } from './resource-wait.ts';
import { reconcileResourceWait } from './resource-wait-recovery.mjs';
import { createProjectAgentHost } from './runtime-host.mjs';

const AT = '2026-11-03T00:00:00.000Z';
function fixture(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-resource-wait-'));
  let scheduler = createExecutionScheduler({ rootDir, now: () => AT }), owned = true, broken = false;
  const plan = (id, phase = 'queued') => ({ planId: id, title: id, status: phase === 'running' ? 'executing' : 'paused', createdAt: AT,
    targetWorkspacePath: rootDir, delegationOrigin: { sessionId: id, workspaceId: 'w', parentConversationId: 'p', workId: 'work', phase, readOnly: false } });
  const owner = plan('owner', 'running'), target = plan('target'), plans = [owner, target];
  scheduler.reconcile(plans);
  const port = createResourceWaitPort({ readPlan: id => plans.find(row => row.delegationOrigin.sessionId === id),
    inspectPlan: row => { if (broken) throw new Error('resource_database_unavailable'); return scheduler.inspect(row, plans); },
    executionOf: executionIdentity, readClaims: () => scheduler.resourceSnapshot(), ownsWorkspace: () => owned });
  const scope = { workspaceId: 'w', parentConversationId: 'p', workId: 'work', sessionIds: ['target'] };
  const release = () => {
    owner.status = 'cancelled'; owner.delegationOrigin.phase = 'cancelled';
    scheduler.settleResources(owner, { receiptId: 'stop-receipt', operationId: 'stop-owner', execution: executionIdentity(owner),
      admissionClosed: true, runnerIdle: true, schedulerIdle: true, resourceClaims: scheduler.resourceClaimsFor(owner),
      unknownCalls: [], scope: 'managed_execution', completedAt: AT });
    scheduler.reconcile(plans);
  };
  t.after(() => { scheduler.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { rootDir, port, scope, owner, target, plans, release, scheduler: () => scheduler,
    loseLease: () => { owned = false; }, breakSource: () => { broken = true; }, restoreSource: () => { broken = false; },
    restore: () => { scheduler.close(); scheduler = createExecutionScheduler({ rootDir, now: () => AT }); scheduler.reconcile(plans); } };
}

test('the real scheduler/ledger produces a scoped wait; an idle status cannot release it without a stop receipt', t => {
  const f = fixture(t), [fact] = f.port.read(f.scope);
  assert.equal(fact.reason, 'write_slot');
  assert.equal(fact.wait.kind, 'resource');
  assert.equal(f.port.inspect(f.scope, fact.wait).state, 'waiting');
  assert.equal(f.port.inspect({ ...f.scope, workId: 'foreign' }, fact.wait).state, 'stale');
  assert.equal(f.port.inspect({ ...f.scope, parentConversationId: 'foreign' }, fact.wait).state, 'stale');
  f.owner.status = 'cancelled'; f.owner.delegationOrigin.phase = 'cancelled';
  assert.equal(f.port.inspect(f.scope, fact.wait).state, 'waiting', 'a persisted status is not a settlement receipt');
  f.release();
  assert.equal(f.port.inspect(f.scope, fact.wait).state, 'ready');
  assert.equal(f.scheduler().hasResourceClaim(f.target), false, 'observing ready grants no resource ownership');
});

test('execution changes, lease loss and source failures retain explicit blockers', t => {
  const f = fixture(t), [fact] = f.port.read(f.scope);
  f.target.delegationOrigin.executionGeneration = 'next';
  assert.equal(f.port.inspect(f.scope, fact.wait).state, 'stale');
  delete f.target.delegationOrigin.executionGeneration;
  f.breakSource();
  assert.deepEqual(f.port.inspect(f.scope, fact.wait), { state: 'unavailable', reason: 'resource_database_unavailable' });
  assert.equal(readResourceWaitFacts(f.port, f.scope).resourceWaitError, 'resource_database_unavailable');
  f.loseLease();
  assert.equal(f.port.inspect(f.scope, fact.wait).reason, 'lease_unavailable');
});

test('unrelated resource changes do not revise a wait, and cold reconstruction keeps the same identity', t => {
  const f = fixture(t), [fact] = f.port.read(f.scope);
  const otherRoot = mkdtempSync(path.join(os.tmpdir(), 'peer-unrelated-resource-')); t.after(() => rmSync(otherRoot, { recursive: true, force: true }));
  const unrelated = { ...f.owner, planId: 'unrelated', targetWorkspacePath: otherRoot,
    delegationOrigin: { ...f.owner.delegationOrigin, sessionId: 'unrelated', workspaceId: 'other' } };
  const revision = f.scheduler().resourceRevision();
  f.scheduler().reconcile([...f.plans, unrelated]);
  assert.ok(f.scheduler().resourceRevision() > revision);
  assert.deepEqual(f.port.read(f.scope)[0], fact);
  f.restore();
  assert.deepEqual(f.port.read(f.scope)[0], fact);
});

test('a new relevant blocker keeps the old wait parked and a source outage retains its registered reference', t => {
  const f = fixture(t), [fact] = f.port.read(f.scope); f.release();
  const second = { ...f.owner, planId: 'second-owner', status: 'executing',
    delegationOrigin: { ...f.owner.delegationOrigin, sessionId: 'second-owner', phase: 'running' } };
  f.plans.push(second); f.scheduler().reconcile(f.plans);
  const current = f.port.inspect(f.scope, fact.wait);
  assert.equal(current.state, 'waiting'); assert.notEqual(current.current.wait.revision, fact.wait.revision);
  let work = { workId: 'work', workspaceId: 'w', parentConversationId: 'p', state: 'waiting_children', end: 'awaiting_children',
    sessionIds: ['target'], waitFor: [fact.wait], repeats: 1 };
  const store = { saveWork: next => { work = next; }, transfer: () => assert.fail('waiting is not a model wake') };
  const reconcile = () => reconcileResourceWait({ work, state: {}, sessions: [{ sessionId: 'target', status: 'queued' }], port: f.port, store, now: () => AT });
  reconcile(); assert.equal(work.state, 'waiting_children');
  f.breakSource(); reconcile(); assert.equal(work.state, 'blocked_system'); assert.deepEqual(work.waitFor, [fact.wait]);
  assert.equal(readResourceWaitFacts(f.port, f.scope, work.waitFor).resourceWaitError, 'resource_database_unavailable');
  f.restoreSource(); reconcile(); assert.equal(work.state, 'waiting_children'); assert.equal(work.repeats, 1);
});

test('host wait reconciliation is idempotent, retains progress and transfers one durable factual event after settlement', t => {
  const f = fixture(t), [fact] = f.port.read(f.scope);
  let work = { workId: 'work', workspaceId: 'w', parentConversationId: 'p', state: 'waiting_children', end: 'awaiting_children',
    sessionIds: ['target'], waitFor: [fact.wait], fingerprint: 'same', repeats: 2, attemptId: 'attempt' };
  const state = { mandates: { work: { sessionIds: ['target'] } } }, events = new Map();
  const store = { saveWork: next => { work = next; }, transfer: rows => rows.forEach(event => events.set(event.eventId, event)) };
  const reconcile = () => reconcileResourceWait({ work, state, sessions: [{ sessionId: 'target', status: 'queued' }], port: f.port, store, now: () => AT });
  for (let i = 0; i < 5; i++) reconcile();
  assert.equal(events.size, 0); assert.equal(work.state, 'waiting_children'); assert.equal(work.repeats, 2);
  f.release(); f.restore(); reconcile();
  assert.equal(work.state, 'runnable'); assert.equal(work.fingerprint, 'same'); assert.equal(work.repeats, 2);
  reconcile(); assert.equal(events.size, 1);
  const [event] = events.values();
  assert.equal(event.payload.reason, 'resource_available'); assert.ok(event.eventId.length < 200);
  assert.deepEqual(work.pendingEventIds, [event.eventId]);
});

test('ready never overrides user stop, a human gate, uncertain dispatch or a separate failure', t => {
  const f = fixture(t), [fact] = f.port.read(f.scope); f.release();
  const base = { workId: 'work', workspaceId: 'w', parentConversationId: 'p', state: 'waiting_children',
    end: 'awaiting_children', sessionIds: ['target'], waitFor: [fact.wait] };
  for (const patch of [{ state: 'cancelled', stopScope: 'work' }, { pendingControl: { kind: 'cancel' } },
    { budget: { uncertainDispatches: [{ toolCallId: 'unknown' }] } }, { state: 'blocked_system', end: 'fatal' }]) {
    let writes = 0;
    reconcileResourceWait({ work: { ...base, ...patch }, state: {}, sessions: [], port: f.port,
      store: { saveWork: () => { writes++; }, transfer: () => { writes++; } }, now: () => AT });
    assert.equal(writes, 0);
  }
  let writes = 0;
  reconcileResourceWait({ work: base, state: {}, sessions: [{ sessionId: 'target', status: 'waiting_user' }], port: f.port,
    store: { saveWork: () => { writes++; }, transfer: () => { writes++; } }, now: () => AT });
  assert.equal(writes, 0);
});

test('missing physical-resource wiring fails at assembly, and revoked sessions leave the wait scope', () => {
  assert.throws(() => requireResourceWaitPort(null), /ResourceWaitPort is required/);
  assert.throws(() => createProjectAgentHost({ executeTurn() {}, readResourceClaims: () => [] }), /ResourceWaitPort is required/);
  assert.deepEqual(resourceWaitScope({ workId: 'work', workspaceId: 'w', parentConversationId: 'p' },
    { mandates: { work: { sessionIds: ['current', 'revoked'], revokedSessionIds: ['revoked'] } } }).sessionIds, ['current']);
});
