import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, renameSync, symlinkSync, appendFileSync, statSync, utimesSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { hashLegacyFile, sealCoordinationBackup } from './coordination-legacy-integrity.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-portable-'));
  const dir = path.join(root, 'original'), backup = path.join(root, 'copy');
  const file = path.join(dir, 'coordination.jsonl'), seal = d => path.join(d, 'coordination-v2', 'legacy-seal.json');
  const stores = [];
  const store = (workspaceId, extra = {}) => { const s = createWorkCoordinationStore({ rootDir: root, workspaceId, holdsLease: () => true, leaseEpoch: () => 'test', ...extra }); stores.push(s); return s; };
  const legacy = store('original'); legacy.saveWork({ workId: 'g', state: 'cancelled', title: 'original',
    budget: { tokens: 7, observations: { once: true }, attempts: { a: { pendingTools: [{ toolCallId: 'unknown' }] } } } }); legacy.close();
  return { root, dir, backup, file, seal, store, async activate() { const s = store('original', { formatVersion: 2 }); await s.prepare(); s.saveWork({ ...s.readWork('g'), note: 'v2 event' }); const expected = s.read(); s.close(); return expected; },
    copy() { cpSync(dir, backup, { recursive: true }); }, close() { stores.forEach(s => s.close()); rmSync(root, { recursive: true, force: true }); } };
}
function canonical(directory) {
  const out = {};
  function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.read-models') continue;
    const file = path.join(dir, e.name); if (e.isDirectory()) walk(file); else out[path.relative(directory, file)] = readFileSync(file).toString('hex');
  } } walk(directory); return out;
}

for (const withIndex of [true, false]) test(`sealed active directory restores with copied index=${withIndex} and no canonical rewrites`, async () => {
  const f = fixture(); try {
    const expected = await f.activate(), before = canonical(f.dir); f.copy();
    if (!withIndex) rmSync(path.join(f.backup, '.read-models'), { recursive: true });
    const restored = f.store('copy'); await restored.prepare(); assert.deepEqual(restored.read(), expected);
    assert.equal(restored.observeUsage('g', 'once', { totalTokens: 100 }), false);
    assert.equal(restored.readWork('g').budget.attempts.a.pendingTools[0].toolCallId, 'unknown');
    assert.deepEqual(canonical(f.backup), before); assert.deepEqual(canonical(f.dir), before);
    restored.close(); rmSync(path.join(f.backup, '.read-models'), { recursive: true });
    const rebuilt = f.store('copy'); await rebuilt.prepare(); assert.deepEqual(rebuilt.read(), expected);
  } finally { f.close(); }
});

test('same bytes with a new inode require prepare, then synchronous hot reads perform no journal I/O', async () => {
  const f = fixture(); try {
    const expected = await f.activate(); let reads = 0;
    const s = f.store('original', { onJournalRead: n => { reads += n; } });
    writeFileSync(f.file + '.replacement', readFileSync(f.file)); renameSync(f.file + '.replacement', f.file);
    assert.throws(() => s.read(), /coordination_legacy_changed/); await s.prepare(); assert.deepEqual(s.read(), expected);
    const hashed = reads; assert.ok(hashed >= statSync(f.file).size);
    for (let i = 0; i < 20; i++) s.readWork('g'); assert.equal(reads, hashed);
    await s.prepare(); assert.equal(reads, hashed, 'repeat prepare reuses its validated physical identity');
  } finally { f.close(); }
});

test('same-length edits with restored mtime fail; original manifest/head and evidence remain intact', async () => {
  const f = fixture(); try {
    await f.activate(); f.copy(); const before = canonical(f.backup), file = path.join(f.backup, 'coordination.jsonl'), st = statSync(file);
    writeFileSync(file, readFileSync(file, 'utf8').replace('original', 'modified')); utimesSync(file, st.atime, st.mtime);
    await assert.rejects(f.store('copy').prepare(), /coordination_legacy_changed/);
    const after = canonical(f.backup); delete before['coordination.jsonl']; delete after['coordination.jsonl']; assert.deepEqual(after, before);
  } finally { f.close(); }
});

for (const mode of ['missing', 'invalid', 'generation']) test(`a copied baseline with ${mode} proof fails closed`, async () => {
  const f = fixture(); try {
    await f.activate(); f.copy();
    if (mode === 'missing') rmSync(f.seal(f.backup));
    else if (mode === 'invalid') writeFileSync(f.seal(f.backup), '{');
    else { const proof = JSON.parse(readFileSync(f.seal(f.backup))); proof.generation = 'other'; writeFileSync(f.seal(f.backup), JSON.stringify(proof)); }
    await assert.rejects(f.store('copy').prepare(), /coordination_legacy_(changed|seal_invalid)/);
  } finally { f.close(); }
});

test('pre-seal RC25 backup is certified against read-only source without source or marker writes', async () => {
  const f = fixture(); try {
    const expected = await f.activate(); rmSync(f.seal(f.dir));
    // A live source lease is deliberately retained, never acquired or modified by the maintenance seam.
    writeFileSync(path.join(f.dir, 'host.lease'), '{"hostId":"running"}');
    f.copy(); rmSync(path.join(f.backup, 'host.lease')); const original = canonical(f.dir), before = canonical(f.backup);
    await assert.rejects(f.store('copy').prepare(), /coordination_legacy_changed/);
    await sealCoordinationBackup({ sourceDirectory: f.dir, backupDirectory: f.backup });
    assert.deepEqual(canonical(f.dir), original);
    const after = canonical(f.backup); delete after['coordination-v2/legacy-seal.json']; assert.deepEqual(after, before);
    const restored = f.store('copy'); await restored.prepare(); assert.deepEqual(restored.read(), expected);
    await assert.rejects(sealCoordinationBackup({ sourceDirectory: f.dir + '-unavailable', backupDirectory: f.backup }), /ENOENT/);
  } finally { f.close(); }
});

test('backup sealing rejects aliases, active targets and symlink path escapes', async () => {
  const f = fixture(); try {
    await f.activate(); f.copy();
    await assert.rejects(sealCoordinationBackup({ sourceDirectory: f.dir, backupDirectory: f.dir }), /coordination_backup_path_invalid/);
    const alias = path.join(f.root, 'alias'); symlinkSync(f.dir, alias);
    await assert.rejects(sealCoordinationBackup({ sourceDirectory: f.dir, backupDirectory: alias }), /coordination_backup_path_invalid/);
    writeFileSync(path.join(f.backup, 'host.lease'), '{}');
    await assert.rejects(sealCoordinationBackup({ sourceDirectory: f.dir, backupDirectory: f.backup }), /coordination_backup_active/);
    rmSync(path.join(f.backup, 'host.lease')); rmSync(f.seal(f.backup)); symlinkSync(f.seal(f.dir), f.seal(f.backup));
    await assert.rejects(sealCoordinationBackup({ sourceDirectory: f.dir, backupDirectory: f.backup }), /coordination_backup_path_invalid/);
  } finally { f.close(); }
});

test('stable hash yields to the event loop, bounds chunks and rejects a mid-read mutation', async () => {
  const f = fixture(); try {
    writeFileSync(f.file, Buffer.alloc(8 * 1024 * 1024, 65)); let ticks = 0, max = 0;
    const timer = setInterval(() => ticks++, 1);
    try { await hashLegacyFile(f.file, n => { max = Math.max(max, n); }); }
    finally { clearInterval(timer); }
    assert.ok(ticks > 0); assert.ok(max <= 256 * 1024);
    let changed = false;
    await assert.rejects(hashLegacyFile(f.file, () => { if (!changed) { changed = true; appendFileSync(f.file, 'x'); } }), /coordination_read_changed/);
  } finally { f.close(); }
});

test('lease loss during proof generation publishes no seal', async () => {
  const f = fixture(); try {
    await f.activate(); rmSync(f.seal(f.dir)); let owns = true;
    const s = f.store('original', { holdsLease: () => owns, onJournalRead: () => { owns = false; } });
    await assert.rejects(s.prepare(), /coordination_lease_lost/);
    assert.throws(() => readFileSync(f.seal(f.dir)), /ENOENT/);
  } finally { f.close(); }
});

test('a portable baseline proof cannot replace a missing v2 segment or a changed proof', async () => {
  const f = fixture(); try {
    await f.activate(); f.copy(); const s = f.store('copy'); await s.prepare();
    const proof = JSON.parse(readFileSync(f.seal(f.backup))); proof.sha256 = '0'.repeat(64);
    writeFileSync(f.seal(f.backup), JSON.stringify(proof));
    assert.throws(() => s.read(), /coordination_legacy_changed/);
    await assert.rejects(s.prepare(), /coordination_legacy_changed/); s.close();
    writeFileSync(f.seal(f.backup), readFileSync(f.seal(f.dir)));
    rmSync(path.join(f.backup, '.read-models'), { recursive: true });
    rmSync(path.join(f.backup, 'coordination-v2', 'segments', '000000000001.jsonl'));
    await assert.rejects(f.store('copy').prepare(), /coordination_journal_missing/);
  } finally { f.close(); }
});
