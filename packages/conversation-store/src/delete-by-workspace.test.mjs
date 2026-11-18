import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('native execution protects single and workspace deletion until all facts are settled', () => {
  const workspace = '/tmp/native-delete-guard';
  const sibling = store.createConversation({ title: 'Sibling', workspacePath: workspace });
  const target = store.createConversation({ title: 'Native', workspacePath: workspace });
  store.appendMessage(target.id, { id: 'native-message', role: 'user', content: 'Keep the original facts' });
  const index = join(dir, 'index.jsonl');
  const body = join(dir, `${target.id}.jsonl`);
  const bodyBefore = readFileSync(body);
  const rows = readFileSync(index, 'utf8').trim().split('\n').map(JSON.parse);
  const row = rows.find(({ id }) => id === target.id);
  const fixtures = JSON.parse(readFileSync(new URL('../../protocol/contracts/native-cli/conversation-execution.json', import.meta.url), 'utf8'));
  const setExecution = (name, conversationId = target.id) => {
    const run = structuredClone(fixtures.cases.find((entry) => entry.name === name).input);
    run.identity.conversationId = conversationId;
    row.runtimeExecution = run;
    writeFileSync(index, rows.map(JSON.stringify).join('\n') + '\n');
    return readFileSync(index);
  };
  for (const [name, expected] of [
    ['active', 'conversation_execution_busy'],
    ['unknown-keeps-owner', 'conversation_execution_busy'],
    ['ended-handle', 'conversation_execution_busy'],
    ['future-schema', 'conversation_execution_invalid'],
    ['stopped', 'conversation_execution_invalid'],
  ]) {
    const indexBefore = setExecution(name, name === 'stopped' ? sibling.id : target.id);
    assert.throws(() => store.deleteConversation(target.id), { message: expected });
    assert.throws(() => store.deleteConversationsByWorkspace(workspace), { message: expected });
    if (name !== 'ended-handle') {
      assert.throws(() => store.assertExecutionAvailable(target.id), { message: expected });
      assert.throws(() => store.updateMode(target.id, 'plan'), { message: expected });
      assert.throws(() => store.updateModelEffort(target.id, { effort: 'high' }), { message: expected });
      assert.throws(() => store.appendMessage(target.id, { role: 'user', content: 'Concurrent input' }), { message: expected });
      assert.throws(() => store.patchStreamingMessage(target.id, 'native-message', { content: 'Foreign patch' }), { message: expected });
    }
    assert.deepEqual(readFileSync(index), indexBefore);
    assert.deepEqual(readFileSync(body), bodyBefore);
    assert.equal(store.getConversation(sibling.id).id, sibling.id);
  }
  setExecution('stopped');
  assert.doesNotThrow(() => store.assertExecutionAvailable(target.id));
  const patch = join(dir, `${target.id}.stream.json`);
  writeFileSync(patch, '{}');
  assert.throws(() => store.deleteConversation(target.id), { message: 'conversation_execution_busy' });
  assert.throws(() => store.deleteConversationsByWorkspace(workspace), { message: 'conversation_execution_busy' });
  rmSync(patch);
  assert.deepEqual(store.deleteConversationsByWorkspace(workspace).map(({ id }) => id).sort(), [sibling.id, target.id].sort());
  assert.equal(store.getConversation(target.id), null);
});
