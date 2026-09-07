import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackgroundSnapshotStore } from './background-snapshot-store.mjs';
import { buildInheritedBackground } from './inherited-background.mjs';

for (const partial of [false, true]) {
  for (const reopen of [false, true]) {
    test(`snapshot disk persistence: partial=${partial} x reopen=${reopen}`, (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'peer-background-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const snapshot = buildInheritedBackground({ conversationId: 'p', contentRevision: 1,
        messages: [{ id: 'u', role: 'user', content: 'original', ...(partial ? { attachments: [{}] } : {}) }] },
      { expectedRevision: 1, capturedAt: '2026-09-06T10:00:00Z', runtimeState: { conversationId: 'p', contentRevision: 1, status: 'idle' } });
      let store = createBackgroundSnapshotStore(dir);
      const id = store.put(snapshot);
      assert.equal(store.put(snapshot), id);
      assert.deepEqual(readdirSync(dir), [`${id}.json`]);
      if (reopen) store = createBackgroundSnapshotStore(dir);
      assert.deepEqual(store.read(id), snapshot);
      snapshot.entries[0].text = 'changed';
      assert.equal(store.read(id).entries[0].text, 'original');
      assert.throws(() => store.put(snapshot), { code: 'BACKGROUND_SNAPSHOT_CORRUPT' });
      const copy = store.read(id);
      copy.entries[0].text = 'mutated read';
      assert.equal(store.read(id).entries[0].text, 'original');
      writeFileSync(join(dir, `${id}.json`), '{');
      assert.throws(() => store.read(id), { code: 'BACKGROUND_SNAPSHOT_CORRUPT' });
    });
  }
}

test('snapshot lookup rejects path traversal and reports missing data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-background-id-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createBackgroundSnapshotStore(dir);
  assert.throws(() => store.read('../index'), { code: 'BACKGROUND_SNAPSHOT_ID_INVALID' });
  assert.throws(() => store.read('a'.repeat(64)), { code: 'BACKGROUND_SNAPSHOT_MISSING' });
  assert.deepEqual(readdirSync(dir), []);
});
