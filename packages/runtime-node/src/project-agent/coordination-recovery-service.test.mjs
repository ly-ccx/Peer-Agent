import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCoordinationRecoveryService } from './coordination-recovery-service.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { createReplyDelivery } from './reply-delivery.mjs';
import { createProjectAgentRunner } from './runner.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { readRecoveredCoordination, inspectCoordinationFork, recoverCoordinationForkBackup } from './coordination-fork-recovery.mjs';

const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
async function fixture(t, ports = {}) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-user-recovery-')), directory = path.join(rootDir, 'w');
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let epoch = 'owner', owned = true, restarts = 0, stops = 0;
  const options = { rootDir, workspaceId: 'w', holdsLease: () => owned, leaseEpoch: () => epoch };
  const legacy = createWorkCoordinationStore(options);
  const make = id => {
    const native = legacy.checkpoint(`${id}:attempt`, { provider: 'test', messages: [{ role: 'tool', content: 'already finished' }] });
    return { workId: id, workspaceId: 'w', parentConversationId: 'parent', state: 'runnable', anchorInputIds: [id], sessionIds: [],
      checkpointRef: legacy.checkpoint(id, { job: { workId: id, kind: 'user', userInputs: [{ inputId: id, text: 'original' }] },
        outcome: { yielded: true, rounds: [{ toolCalls: [{ toolCallId: 'finished', result: { ok: true } }] }] } }), nativeCheckpointRef: native,
      budget: { tokens: 7, toolCalls: 1, observations: { receipt: true }, attempts: { attempt: { role: 'project_agent', checkpointRef: native, pendingTools: [] } } } };
  };
  const conflicting = make('conflict'), safe = make('safe');
  legacy.saveWork({ workId: 'done', state: 'delivered', anchorInputIds: ['finished-input'] });
  legacy.saveWork(conflicting); legacy.saveWork(safe);
  const revision = legacy.read().revision; legacy.close();
  const current = createWorkCoordinationStore({ ...options, formatVersion: 2 }); await current.prepare();
  current.saveWork({ ...conflicting, note: 'current' }); current.saveWork({ ...safe, note: 'current' }); current.close();
  rmSync(path.join(directory, 'coordination-v2/legacy-seal.json'));
  appendFileSync(path.join(directory, 'coordination.jsonl'), JSON.stringify({ schemaVersion: 1, epoch: 'legacy-owner', revision: revision + 1,
    kind: 'work', work: { ...conflicting, anchorInputIds: ['legacy-input'], note: 'legacy' } }) + '\n');
  const queue = path.join(directory, 'input-queue.jsonl'); writeFileSync(queue, 'received-input-must-survive\n');
  const service = createCoordinationRecoveryService({ rootDir, holdsLease: () => owned, leaseEpoch: () => epoch,
    sessionInventory: () => [{ sessionId: 'orphan-child', title: 'Historical child', terminal: false }], sessionSafe: () => false,
    quiesce: async () => { stops++; }, restart: async () => { restarts++; }, cancelSessions: async () => {}, ...ports });
  return { service, options, directory, queue, source: sha(path.join(directory, 'coordination.jsonl')),
    loseLease() { epoch = 'replacement'; owned = false; }, get restarts() { return restarts; }, get stops() { return stops; },
    inspect: () => service.execute({ workspaceId: 'w', action: 'inspect' }),
    restore: planToken => service.execute({ workspaceId: 'w', action: 'restore', planToken }),
    snapshot() { const intent = JSON.parse(readFileSync(path.join(directory, 'coordination-recovery.json'))); return readRecoveredCoordination(directory, intent.generation); } };
}

test('user inspection is read-only and the explicit restore preserves sources, receipts and both input owners', async t => {
  const f = await fixture(t), before = await f.inspect();
  assert.equal(before.ok, true); assert.equal(f.stops, 0); assert.equal(f.restarts, 0);
  assert.equal(sha(path.join(f.directory, 'coordination.jsonl')), f.source);
  assert.equal(before.view.works.find(row => row.workId === 'safe').disposition, 'resume');
  assert.equal(before.view.works.find(row => row.workId === 'conflict').disposition, 'held');
  const result = await f.restore(before.view.planToken); assert.equal(result.ok, true); assert.equal(result.view.canContinue, true);
  const state = f.snapshot(); assert.equal(state.works.done.state, 'delivered'); assert.equal(state.works.safe.state, 'runnable');
  assert.equal(state.works.conflict.state, 'blocked_system'); assert.equal(state.works.safe.budget.tokens, 7);
  assert.deepEqual(state.works.safe.budget.observations, { receipt: true });
  assert.ok(state.lastRecovery.quarantinedSessionIds.includes('orphan-child'));
  assert.ok(state.lastRecovery.quarantinedInputIds.includes('legacy-input'));
  assert.equal(readFileSync(f.queue, 'utf8'), 'received-input-must-survive\n');
  assert.equal(statSync(path.join(f.directory, 'coordination.jsonl')).isDirectory(), true);
  const manifest = JSON.parse(readFileSync(path.join(f.directory, 'coordination-v2/manifest.json'))); assert.equal(manifest.minimumWriterVersion, 4);
  const intent = JSON.parse(readFileSync(path.join(f.directory, 'coordination-recovery.json')));
  const archive = path.join(f.directory, intent.archive);
  assert.equal(sha(path.join(archive, 'original/coordination.jsonl')), f.source);
  const inputs = readdirSync(archive).find(name => name.startsWith('received-inputs-'));
  const backup = JSON.parse(readFileSync(path.join(archive, inputs))); assert.ok(backup.files['input-queue.jsonl']);
  assert.ok(Object.keys(backup.files).some(name => name.includes(state.works.safe.nativeCheckpointRef)));
  const coordinator = createRunnerCoordination({ store: { read: () => state }, workspaceId: 'w', conversationId: 'parent' });
  assert.equal(coordinator.ownsInput('legacy-input'), true); assert.equal(coordinator.ownsInput('finished-input'), true);
});

test('stale plans and a replaced lease refuse mutation without restarting execution', async t => {
  const f = await fixture(t), before = await f.inspect();
  assert.equal((await f.restore('0'.repeat(64))).code, 'coordination_resume_plan_changed');
  assert.equal(sha(path.join(f.directory, 'coordination.jsonl')), f.source);
  assert.equal(f.restarts, 0);
  f.loseLease(); const occupied = await f.restore(before.view.planToken);
  assert.equal(occupied.view.phase, 'occupied'); assert.equal(f.restarts, 0);
});

test('a previously interrupted publication can be inspected and resumed through the same user flow', async t => {
  const f = await fixture(t), plan = inspectCoordinationFork(f.directory);
  assert.throws(() => recoverCoordinationForkBackup({ directory: f.directory, sourceFingerprint: plan.sourceFingerprint,
    reviewedPrefixSha256: plan.baselinePrefix.sha256, onStep: step => { if (step === 'v2-archived') throw new Error('power-loss'); } }), /power-loss/);
  const before = await f.inspect(); assert.equal(before.ok, true);
  assert.equal((await f.restore(before.view.planToken)).ok, true);
  assert.equal(f.snapshot().lastRecovery.executionBlocked, false);
});

test('a failed structured stop leaves held work and evidence intact; retaining later never releases delivery', async t => {
  let refuse = true;
  const f = await fixture(t, { cancelSessions: async () => { if (refuse) throw new Error('coordination_recovery_stop_failed'); } });
  const before = await f.inspect(); await f.restore(before.view.planToken);
  let view = (await f.inspect()).view;
  const stop = () => f.service.execute({ workspaceId: 'w', action: 'retain', planToken: view.planToken, sessionId: 'orphan-child' });
  assert.equal((await stop()).ok, false);
  assert.equal(f.snapshot().works.conflict.state, 'blocked_system');
  refuse = false; view = (await f.inspect()).view; assert.equal((await stop()).ok, true);
  view = (await f.inspect()).view;
  const result = await f.service.execute({ workspaceId: 'w', action: 'retain', planToken: view.planToken, workId: 'conflict' });
  assert.equal(result.ok, true); assert.equal(f.snapshot().works.conflict.state, 'cancelled');
  assert.ok(f.snapshot().lastRecovery.quarantinedInputIds.includes('legacy-input'));
  let calls = 0; const state = f.snapshot();
  const delivery = createReplyDelivery({ store: { read: () => state, assertOwner() {}, append() { calls++; } }, readMessages: () => [], appendMessage() { calls++; }, accept() { calls++; } });
  assert.deepEqual(await delivery.deliver({ id: 'old-result', meta: { workId: 'conflict' } }), { held: true });
  assert.equal(calls, 0);
});

test('an admitted re-check never copies sources again and the entry follows pending holds', async t => {
  const f = await fixture(t), first = await f.inspect();
  assert.equal(f.service.needsAttention('w'), false);
  await f.restore(first.view.planToken);
  const intent = JSON.parse(readFileSync(path.join(f.directory, 'coordination-recovery.json')));
  const copies = () => readdirSync(path.join(f.directory, intent.archive)).filter(name => name.startsWith('received-inputs-')).length;
  assert.equal(copies(), 1); assert.equal(f.service.needsAttention('w'), true);
  const again = await f.restore((await f.inspect()).view.planToken);
  assert.equal(again.ok, true); assert.equal(again.view.canContinue, true);
  assert.equal(copies(), 1, 'a re-check never copies received inputs again');
  assert.equal(f.snapshot().works.conflict.state, 'blocked_system');
  assert.equal(f.service.needsAttention('w'), true);
});

test('one batch retires every held work and child task under one stop and restart, then the entry settles', async t => {
  const cancelled = [];
  const f = await fixture(t, { cancelSessions: async (_id, ids) => { cancelled.push(...ids); } });
  await f.restore((await f.inspect()).view.planToken);
  const view = (await f.inspect()).view, stops = f.stops, restarts = f.restarts;
  assert.deepEqual(view.works.map(row => [row.workId, row.disposition]), [['conflict', 'held']]);
  assert.deepEqual(view.sessions.map(row => row.sessionId), ['orphan-child']);
  assert.equal((await f.service.execute({ workspaceId: 'w', action: 'retain_all', planToken: view.planToken, workId: 'conflict' })).code, 'INVALID_INPUT');
  const result = await f.service.execute({ workspaceId: 'w', action: 'retain_all', planToken: view.planToken });
  assert.equal(result.ok, true); assert.deepEqual(cancelled, ['orphan-child']);
  assert.equal(f.stops - stops, 1); assert.equal(f.restarts - restarts, 1);
  const state = f.snapshot();
  assert.equal(state.works.conflict.state, 'cancelled'); assert.equal(state.works.safe.state, 'runnable');
  assert.ok(state.lastRecovery.retainedSessionIds.includes('orphan-child'));
  assert.ok(state.lastRecovery.quarantinedInputIds.includes('legacy-input'));
  assert.deepEqual([result.view.works.length, result.view.sessions.length], [0, 0]);
  assert.equal(f.service.needsAttention('w'), false);
});

test('a failed batch keeps every hold and the entry visible until a later step succeeds', async t => {
  let refuse = true;
  const f = await fixture(t, { cancelSessions: async () => { if (refuse) throw new Error('coordination_recovery_stop_failed'); } });
  await f.restore((await f.inspect()).view.planToken);
  let view = (await f.inspect()).view;
  assert.equal((await f.service.execute({ workspaceId: 'w', action: 'retain_all', planToken: view.planToken })).code, 'coordination_recovery_stop_failed');
  assert.equal(f.snapshot().works.conflict.state, 'blocked_system');
  assert.equal(f.snapshot().lastRecovery.retainedSessionIds?.includes('orphan-child') ?? false, false);
  view = (await f.inspect()).view;
  assert.equal(f.service.needsAttention('w'), true, 'an inspection cannot clear a failed step while holds remain');
  refuse = false;
  assert.equal((await f.service.execute({ workspaceId: 'w', action: 'retain_all', planToken: view.planToken })).ok, true);
  assert.equal(f.service.needsAttention('w'), false);
});

test('a failed step returns its re-check, so the next step starts from current facts instead of the failed token', async t => {
  const ended = new Set();
  let refuse = true;
  const f = await fixture(t, {
    sessionInventory: () => ['orphan-child', 'stuck-child'].map(sessionId => ({ sessionId, title: sessionId, terminal: ended.has(sessionId) })),
    cancelSessions: async (_, ids) => {
      for (const sessionId of ids) {
        if (sessionId === 'stuck-child' && refuse) throw new Error('coordination_recovery_stop_failed');
        ended.add(sessionId);
      }
    } });
  await f.restore((await f.inspect()).view.planToken);
  const before = (await f.inspect()).view, restarts = f.restarts;
  assert.deepEqual(before.sessions.map(row => row.sessionId), ['orphan-child', 'stuck-child']);
  const failed = await f.service.execute({ workspaceId: 'w', action: 'retain_all', planToken: before.planToken });
  assert.equal(failed.code, 'coordination_recovery_stop_failed');
  assert.equal(failed.view.phase, 'failed');
  assert.deepEqual(failed.view.sessions.map(row => row.sessionId), ['stuck-child'], 'the child stopped before the failure is no longer listed');
  assert.notEqual(failed.view.planToken, before.planToken);
  assert.equal(f.restarts, restarts, 'a failed step leaves the host paused');
  assert.equal(f.service.needsAttention('w'), true);
  refuse = false;
  const stale = await f.service.execute({ workspaceId: 'w', action: 'retain_all', planToken: before.planToken });
  assert.equal(stale.code, 'coordination_resume_plan_changed', 'the failed token stays refused');
  assert.equal(stale.view.planToken, failed.view.planToken, 'a paused host re-checks to the same plan');
  const retried = await f.service.execute({ workspaceId: 'w', action: 'retain_all', planToken: failed.view.planToken });
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.view.sessions, []);
  assert.equal(retried.view.works.filter(row => row.disposition === 'held').length, 0);
  assert.equal(f.snapshot().lastRecovery.retainedSessionIds.includes('stuck-child'), true);
  assert.equal(f.restarts, restarts + 1);
  assert.equal(f.service.needsAttention('w'), false);
});

test('inspection of a torn recovery tail is read-only; explicit re-entry preserves isolation and archives damage', async t => {
  const f = await fixture(t), first = await f.inspect(); await f.restore(first.view.planToken);
  const segments = path.join(f.directory, 'coordination-v2/segments');
  const file = path.join(segments, readdirSync(segments).sort().at(-1));
  appendFileSync(file, '{"unfinished":'); const damaged = sha(file);
  const checked = await f.inspect(); assert.equal(checked.ok, true);
  assert.equal(sha(file), damaged, 'inspection cannot truncate or repair a journal');
  assert.equal((await f.restore(checked.view.planToken)).ok, true);
  const state = f.snapshot(); assert.equal(state.works.conflict.state, 'blocked_system');
  assert.ok(state.lastRecovery.quarantinedInputIds.includes('legacy-input'));
  assert.ok(state.lastRecovery.quarantinedSessionIds.includes('orphan-child'));
  assert.ok(readdirSync(segments).some(name => name.includes('.damaged-')));
});

test('continuation uses the original native results and work, while every historical input remains deduplicated', async t => {
  const f = await fixture(t), inspected = await f.inspect(); await f.restore(inspected.view.planToken);
  const store = createWorkCoordinationStore({ ...f.options, formatVersion: 2 }); await store.prepare();
  const messages = [], calls = [];
  const runner = createProjectAgentRunner({ workspaceId: 'w', conversationId: 'parent', coordinationStore: store,
    inbox: createProjectInbox({ rootDir: path.dirname(f.directory) }), resolveRoster: () => [],
    readMessages: () => messages, appendMessage: (_id, row) => messages.push(row), resolveModel: () => ({ modelProviderId: 'test' }),
    executeTurn: async input => {
      calls.push(input.turnProfile.workId);
      assert.equal(input.turnProfile.providerCheckpoint.messages[0].content, 'already finished');
      return { text: 'Completed from preserved results.' };
    } });
  try {
    await runner.enqueueUserInputs([{ inputId: 'legacy-input', text: 'must not replay' }, { inputId: 'finished-input', text: 'must not replay' }]);
    await runner.kick(); await runner.kick();
    assert.deepEqual(calls, ['safe']);
    assert.equal(store.read().works.safe.state, 'delivered');
    assert.equal(store.read().works.conflict.state, 'blocked_system');
    assert.equal(messages.filter(row => row.kind === 'agent_reply').length, 1);
    assert.equal(store.read().works.safe.budget.tokens, 7);
  } finally { runner.dispose(); store.close(); }
});
