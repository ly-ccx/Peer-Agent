import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, symlinkSync, openSync, closeSync, writeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createCoordinationJournalReader } from './coordination-journal-reader.mjs';
import { inspectCoordinationFork, recoverCoordinationForkBackup } from './coordination-fork-recovery.mjs';
import { createProjectAgentHost } from './runtime-host.mjs';
import { replyRecoveryAdmission } from './reply-recovery-admission.mjs';

async function world({ count = 2, unsealed = true } = {}) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-fork-regression-')), directory = path.join(rootDir, 'w');
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner' };
  const legacy = createWorkCoordinationStore(options);
  const work = { workId: 'existing', state: 'runnable', checkpointRef: legacy.checkpoint('existing', { job: { workId: 'existing' }, outcome: { rounds: [] } }), anchorInputIds: ['old-input'],
    budget: { tokens: 7, observations: { 'write-receipt': true }, attempts: { a: { pendingTools: [{ toolCallId: 'unknown-write' }] } } } };
  legacy.saveWork({ workId: 'done', state: 'delivered' });
  legacy.transfer([{ eventId: 'existing-event', sessionId: 'historical-child' }]);
  const before = legacy.read(); legacy.close();
  const current = createWorkCoordinationStore({ ...options, formatVersion: 2 }); await current.prepare();
  for (let n = 0; n < count; n++) current.saveWork({ ...work, note: 'v2-' + n });
  current.close();
  if (unsealed) rmSync(path.join(directory, 'coordination-v2/legacy-seal.json'));
  const file = path.join(directory, 'coordination.jsonl');
  for (let n = 0; n < 37; n++) appendFileSync(file, JSON.stringify({ ...(n === 0 ? { kind: 'handled', eventIds: ['existing-event'] } : { kind: 'work', work: { ...work, note: 'legacy-' + n } }), schemaVersion: 1,
    epoch: 'old-writer', revision: before.revision + n + 1 }) + '\n');
  return { rootDir, directory, options, file, plan: () => inspectCoordinationFork(directory),
    repair(plan, extra = {}) { return recoverCoordinationForkBackup({ directory, sourceFingerprint: plan.sourceFingerprint,
      reviewedPrefixSha256: plan.baselinePrefix.sha256, ...extra }); },
    store() { return createWorkCoordinationStore({ ...options, formatVersion: 2 }); },
    close() { rmSync(rootDir, { recursive: true, force: true }); } };
}
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');

test('real-history shape: 598 v2 events and 37 overlapping old records are independently inspected, without source changes', async () => {
  const w = await world({ count: 598 }); try {
    const before = sha(w.file), p = w.plan();
    assert.equal(p.currentRevision - p.baseRevision, 598); assert.equal(p.legacyRevision - p.baseRevision, 37);
    assert.equal(p.conflicts.length, 1); assert.equal(p.conflicts[0].id, 'existing'); assert.equal(p.unsealedBaseline, true);
    assert.equal(p.executionBlocked, true); assert.equal(sha(w.file), before);
    assert.equal(p.state.works.done.state, 'delivered');
    assert.equal(p.state.works.existing.budget.attempts.a.pendingTools[0].toolCallId, 'unknown-write');
  } finally { w.close(); }
});

test('reviewed offline repair retains source bytes, exact receipts and input ownership; old binary append fails at OS boundary', async () => {
  const w = await world(); try {
    const p = w.plan(), before = sha(w.file), oldFd = openSync(w.file, 'a');
    try {
      const result = w.repair(p); assert.equal(result.executionBlocked, true); assert.ok(statSync(w.file).isDirectory());
      assert.equal(sha(path.join(w.directory, result.archive, 'original/coordination.jsonl')), before);
      assert.throws(() => appendFileSync(w.file, 'old-write\n'), /EISDIR|EACCES|EPERM/);
      // An old fd can touch only the preserved old inode, never the new canonical baseline.
      writeSync(oldFd, '\n');
      const restored = w.store(); await restored.prepare();
      const state = restored.read(); assert.equal(state.lastRecovery.executionBlocked, true);
      assert.equal(state.works.done.state, 'delivered'); assert.deepEqual(state.works.existing.anchorInputIds, ['old-input']);
      assert.equal(state.works.existing.budget.tokens, 7);
      assert.equal(restored.observeUsage('existing', 'write-receipt', { totalTokens: 900 }), false);
      assert.equal(replyRecoveryAdmission(state.works.existing, {}).code, 'COORDINATION_RECONCILIATION_REQUIRED');
      restored.close();
    } finally { closeSync(oldFd); }
  } finally { w.close(); }
});

for (const point of ['prepared', 'v2-archived', 'legacy-archived', 'writer-fenced', 'published']) test(`repair re-entry after interruption at ${point} never executes or changes archived history`, async () => {
  const w = await world(); try {
    const plan = w.plan(); assert.throws(() => w.repair(plan, { onStep: step => { if (step === point) throw new Error('simulated-power-loss'); } }), /simulated-power-loss/);
    const result = w.repair(plan); assert.equal(result.ok, true);
    assert.equal(w.repair(plan).reused, true);
    const restored = w.store(); await restored.prepare(); assert.equal(restored.read().works.done.state, 'delivered'); restored.close();
  } finally { w.close(); }
});

test('active lease, changed review digest and changing source are rejected; no implicit repair', async () => {
  const w = await world(); try {
    const p = w.plan(); writeFileSync(path.join(w.directory, 'host.lease'), '{}');
    assert.throws(() => w.repair(p), /coordination_repair_active/); rmSync(path.join(w.directory, 'host.lease'));
    assert.throws(() => w.repair(p, { reviewedPrefixSha256: '0'.repeat(64) }), /coordination_repair_plan_changed/);
    assert.throws(() => w.repair(p, { onStep: step => { if (step === 'prepared') appendFileSync(w.file, '\n'); } }), /coordination_read_changed/);
    assert.ok(statSync(w.file).isFile());
  } finally { w.close(); }
});

test('missing v2 segments and sealed-prefix edits fail closed', async () => {
  for (const mode of ['missing', 'prefix']) {
    const w = await world({ unsealed: false }); try {
      if (mode === 'missing') rmSync(path.join(w.directory, 'coordination-v2/segments/000000000001.jsonl'));
      else writeFileSync(w.file, readFileSync(w.file, 'utf8').replace('delivered', 'cancelled'));
      assert.throws(w.plan, /coordination_(journal_missing|legacy_changed)/);
    } finally { w.close(); }
  }
});

test('archive symlinks and canonical segment symlinks are rejected', async () => {
  const w = await world(); try {
    const p = w.plan(); symlinkSync(os.tmpdir(), path.join(w.directory, '.coordination-recovery'));
    assert.throws(() => w.repair(p), /coordination_repair_path_invalid/);
    rmSync(path.join(w.directory, '.coordination-recovery'));
    const segment = path.join(w.directory, 'coordination-v2/segments/000000000001.jsonl');
    rmSync(segment); symlinkSync(w.file, segment); assert.throws(w.plan, /coordination_repair_path_invalid/);
  } finally { w.close(); }
});

test('new legacy adapter refuses cached writes after a v2 version fence appears', async () => {
  const w = await world(); try {
    const reader = createCoordinationJournalReader({ file: w.file });
    assert.throws(() => reader.commitEntry({ kind: 'work', work: { workId: 'bad' } }, () => assert.fail('must not persist')), /coordination_writer_upgrade_required/);
  } finally { w.close(); }
});

test('a changed staged baseline is never reported as repaired', async () => {
  const w = await world(); try {
    const plan = w.plan();
    assert.throws(() => w.repair(plan, { onStep: step => {
      if (step !== 'prepared') return;
      const intent = JSON.parse(readFileSync(path.join(w.directory, 'coordination-recovery.json')));
      appendFileSync(path.join(w.directory, intent.archive, intent.candidateName, 'baseline.jsonl'), '\n');
    } }), /coordination_read_changed/);
    assert.equal(JSON.parse(readFileSync(path.join(w.directory, 'coordination-recovery.json'))).status, 'prepared');
  } finally { w.close(); }
});


test('repaired historical conflicts block startup before input consumption, child activation or model execution', async () => {
  const w = await world(); let host; try {
    const plan = w.plan(); w.repair(plan);
    const calls = { model: 0, consumed: 0, activated: 0, queue: 0, tasks: 0, messages: 0 };
    host = createProjectAgentHost({ rootDir: w.rootDir, holdsLease: () => true, readLeaseEpoch: () => 'isolated-recovery-owner',
      listWorkspaceIds: () => ['w'], resolveConversationId: () => 'existing-conversation',
      executeTurn: async () => { calls.model++; }, appendMessage: () => { calls.messages++; },
      inputQueue: { consume: () => { calls.consumed++; return { consumed: [] }; } },
      activateSessions: () => { calls.activated++; }, restoreQueue: () => { calls.queue++; }, recoverTasks: () => { calls.tasks++; } });
    const result = await host.sync(['w']);
    assert.equal(result.outcomes[0].error, 'coordination_reconciliation_required');
    assert.equal(host.recovery.status('w').phase, 'inputs'); assert.equal(host.isReady('w'), false);
    assert.deepEqual(calls, { model: 0, consumed: 0, activated: 0, queue: 0, tasks: 0, messages: 0 });
  } finally { host?.dispose(); w.close(); }
});
