import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { protectCoordinationWriter } from './coordination-writer-fence.mjs';
async function fixture() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-writer-fence-'));
  const options = { rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner' };
  const legacy = createWorkCoordinationStore(options); legacy.saveWork({ workId: 'done', state: 'delivered' }); legacy.close();
  const v2 = createWorkCoordinationStore({ ...options, formatVersion: 2 }); await v2.prepare(); v2.close();
  return { rootDir, options, directory: path.join(rootDir, 'w'), close: () => rmSync(rootDir, { recursive: true, force: true }) };
}
test('production owned prepare fences healthy history before admitting execution and preserves terminal receipts', async () => {
  const f = await fixture(); try {
    const old = readFileSync(path.join(f.directory, 'coordination.jsonl'));
    const store = createWorkCoordinationStore({ ...f.options, formatVersion: 2, fenceLegacyWrites: true }); await store.prepare();
    assert.equal(store.readWork('done').state, 'delivered');
    assert.deepEqual(readFileSync(path.join(f.directory, 'coordination-v2/baseline.jsonl')), old);
    assert.ok(statSync(path.join(f.directory, 'coordination.jsonl')).isDirectory());
    assert.throws(() => appendFileSync(path.join(f.directory, 'coordination.jsonl'), 'old\n'), /EISDIR|EPERM|EACCES/);
    store.saveWork({ workId: 'new', state: 'runnable' }); assert.equal(store.readWork('new').state, 'runnable');
    await store.prepare(); store.close();
  } finally { f.close(); }
});
for (const point of ['prepared', 'baseline-copied', 'legacy-archived', 'writer-fenced', 'head-published', 'published']) test(`healthy fence resumes after ${point} without executing tasks`, async () => {
  const f = await fixture(); try {
    await assert.rejects(protectCoordinationWriter({ directory: f.directory, assertOwner() {}, onStep(step) { if (step === point) throw new Error('power-loss'); } }), /power-loss/);
    const store = createWorkCoordinationStore({ ...f.options, formatVersion: 2, fenceLegacyWrites: true }); await store.prepare();
    assert.equal(store.readWork('done').state, 'delivered'); store.close();
  } finally { f.close(); }
});
test('new empty projects get a real path barrier without inventing legacy task history', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-empty-fence-')); try {
    const store = createWorkCoordinationStore({ rootDir, workspaceId: 'empty', holdsLease: () => true, leaseEpoch: () => 'owner', formatVersion: 2, fenceLegacyWrites: true });
    await store.prepare(); assert.equal(store.read().revision, 0); assert.deepEqual(store.read().works, {}); store.close();
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
