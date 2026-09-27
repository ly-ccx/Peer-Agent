import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryIndex } from './memory-index.mjs';

const ITEMS = [
  {
    id: 'mem-login',
    text: '登录页在 src/login.tsx',
    scope: 'project',
    workspaceId: 'ws-1',
    kind: 'fact',
  },
  {
    id: 'mem-pref',
    text: '只说结论',
    scope: 'user',
    kind: 'preference',
  },
];

function ids(hits) {
  return hits.map((hit) => hit.id).sort();
}

test('删掉索引后按同样的条目重建，检索结果一致', () => {
  const root = tempRoot();
  const file = path.join(root, 'memory-index.sqlite');
  const first = createMemoryIndex({ file });
  try {
    first.rebuild(ITEMS);
    const login = ids(first.search('登录页'));
    const brief = ids(first.search('结论'));
    assert.deepEqual(login, ['mem-login']);
    assert.deepEqual(brief, ['mem-pref']);
    assert.deepEqual(ids(first.search('login')), ['mem-login']);
    first.close();
    rmSync(root, { recursive: true, force: true });
    const rebuilt = createMemoryIndex({ file });
    try {
      rebuilt.rebuild(ITEMS);
      assert.deepEqual(ids(rebuilt.search('登录页')), login);
      assert.deepEqual(ids(rebuilt.search('结论')), brief);
      assert.deepEqual(ids(rebuilt.search('login')), ['mem-login']);
    } finally {
      rebuilt.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-10-index-'));
}
