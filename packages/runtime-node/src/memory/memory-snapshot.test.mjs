import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSnapshot, readSnapshots } from './memory-snapshot.mjs';
import { createMemoryStore } from './memory-store.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-10-snap-'));
}

function stated(store, extra = {}) {
  return store.rememberStated({
    workspaceId: 'ws-1',
    kind: 'fact',
    text: '登录页在 src/login.tsx',
    anchorMessageId: 'm-user',
    messages: [{ id: 'm-user', role: 'user', kind: 'user_input', content: '记住' }],
    ...extra,
  });
}

test('快照只记录当时的 active 条目，之后的变更不改这份快照', () => {
  const root = tempRoot();
  try {
    const store = createMemoryStore({ rootDir: root });
    const fact = stated(store);
    const preference = store.rememberStated({
      kind: 'preference',
      text: '只说结论',
      anchorMessageId: 'm-user',
      messages: [{ id: 'm-user', role: 'user', kind: 'user_input', content: '记住' }],
    });
    const forgotten = stated(store, { text: '这条会先忘掉' });
    store.forget({ id: forgotten.item.id, reason: '先忘掉', workspaceId: 'ws-1' });
    stated(store, { workspaceId: 'ws-2', text: '另一个项目的事实' });

    const options = { rootDir: root, store };
    const first = createSnapshot('ws-1', options);
    assert.equal(first.ok, true);
    assert.deepEqual(first.itemIds, [fact.item.id, preference.item.id].sort());
    const raw = readFileSync(path.join(root, 'projects', 'ws-1', 'memory', 'snapshots.jsonl'), 'utf8');

    const later = stated(store, { text: '快照之后才记住的' });
    store.forget({ id: fact.item.id, reason: '快照之后忘掉', workspaceId: 'ws-1' });
    store.reviseStated({ id: preference.item.id, text: '快照之后改成的偏好' });
    assert.equal(
      readFileSync(path.join(root, 'projects', 'ws-1', 'memory', 'snapshots.jsonl'), 'utf8').startsWith(raw.trim()),
      true,
    );
    const frozen = readSnapshots('ws-1', options)[0];
    assert.deepEqual(frozen.itemIds, first.itemIds);
    assert.deepEqual(frozen.items.map((item) => item.text).sort(), ['只说结论', '登录页在 src/login.tsx']);
    assert.equal(frozen.items.every((item) => item.status === 'active'), true);
    assert.equal(frozen.items.some((item) => item.text === '快照之后改成的偏好'), false);

    const second = createSnapshot('ws-1', options);
    assert.equal(second.itemIds.includes(later.item.id), true);
    assert.deepEqual(readSnapshots('ws-1', options)[0].itemIds, first.itemIds);
    assert.equal(readSnapshots('ws-1', options)[0].snapshotId, first.snapshotId);

    const escaped = createSnapshot('../outside', options);
    assert.equal(escaped.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
