import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createConversationStore } from './index.mjs';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'peer-delete-by-workspace-'));
  store = createConversationStore({ storeDir: dir });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('deleting all conversations of a workspace leaves it empty in listConversationsByWorkspace', () => {
  const wsA = '/tmp/workspace-a';
  const wsB = '/tmp/workspace-b';
  const a1 = store.createConversation({ title: 'A1', workspacePath: wsA });
  const a2 = store.createConversation({ title: 'A2', workspacePath: wsA });
  const b1 = store.createConversation({ title: 'B1', workspacePath: wsB });
  const none = store.createConversation({ title: 'NoWorkspace', workspacePath: null });

  assert.equal(store.listConversationsByWorkspace(wsA).length, 2);

  const removed = store.deleteConversationsByWorkspace(wsA);

  assert.deepEqual(
    removed.map((meta) => meta.id).sort(),
    [a1.id, a2.id].sort(),
  );
  // 目标工作区清空
  assert.deepEqual(store.listConversationsByWorkspace(wsA), []);
  // 其它工作区与无工作区会话不受影响
  assert.deepEqual(
    store.listConversationsByWorkspace(wsB).map((meta) => meta.id),
    [b1.id],
  );
  assert.equal(store.listConversations({ status: 'active' }).length, 2);
  assert.ok(store.listConversations({ status: 'active' }).some((meta) => meta.id === none.id));
  // 删除后 getConversation 不可再取回
  assert.equal(store.getConversation(a1.id), null);
  assert.equal(store.getConversation(a2.id), null);
  // 幂等：再删一次返回空
  assert.deepEqual(store.deleteConversationsByWorkspace(wsA), []);
});

test('deleting by workspace also removes automation-origin conversations of that workspace', () => {
  const originWorkspace = '/tmp/origin-knowledge';
  const otherOrigin = '/tmp/origin-other';
  const executionDir = '/tmp/automation-worktrees/run-1';

  const originConv = store.createConversation({
    title: 'Automation: Daily review',
    workspacePath: executionDir,
    automationOrigin: {
      kind: 'automation_run',
      automationId: 'automation-1',
      runId: 'run-1',
      automationName: 'Daily review',
      originWorkspacePath: originWorkspace,
    },
  });
  const otherConv = store.createConversation({
    title: 'Automation: Other',
    workspacePath: executionDir,
    automationOrigin: {
      kind: 'automation_run',
      automationId: 'automation-2',
      runId: 'run-2',
      automationName: 'Other',
      originWorkspacePath: otherOrigin,
    },
  });
  const plainConv = store.createConversation({
    title: 'Plain execution',
    workspacePath: executionDir,
  });

  const removed = store.deleteConversationsByWorkspace(originWorkspace);

  // 只有 origin 归属该工作区的会话被删
  assert.deepEqual(removed.map((meta) => meta.id), [originConv.id]);
  assert.equal(store.getConversation(originConv.id), null);
  // 同执行目录下其它会话保留
  assert.equal(store.getConversation(otherConv.id)?.id, otherConv.id);
  assert.equal(store.getConversation(plainConv.id)?.id, plainConv.id);
});

test('deleting with null workspace path is a no-op that removes nothing', () => {
  const conv = store.createConversation({ title: 'NoWorkspace', workspacePath: null });
  assert.deepEqual(store.deleteConversationsByWorkspace(null), []);
  assert.deepEqual(store.deleteConversationsByWorkspace(undefined), []);
  assert.equal(store.listConversations({ status: 'active' }).length, 1);
  assert.equal(store.getConversation(conv.id)?.id, conv.id);
});
