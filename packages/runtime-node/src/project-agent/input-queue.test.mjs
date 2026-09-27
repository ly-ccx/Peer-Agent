import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createInputQueue, inputMessageId } from './input-queue.mjs';

function tempRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'b2-06-queue-'));
}

function input(id, text, extra = {}) {
  return {
    inputId: id,
    workspaceId: 'ws-1',
    surface: 'desktop',
    text,
    createdAt: '2026-09-27T00:00:00.000Z',
    anchorRefs: ['anchor-1'],
    ...extra,
  };
}

function harness(root, { holdsLease = () => true } = {}) {
  const messages = [];
  const committed = [];
  let writes = 0;
  const queue = createInputQueue({
    rootDir: root,
    holdsLease,
    resolveConversationId: (workspaceId) => (workspaceId === 'ws-1' ? 'conv-agent' : ''),
    hasMessage: (_conversationId, messageId) => messages.some((message) => message.id === messageId),
    appendMessage(_conversationId, message) {
      writes += 1;
      messages.push(message);
    },
    onCommitted(event) {
      committed.push({
        inputIds: event.inputs.map((item) => item.inputId),
        cursor: queue.cursor(event.workspaceId),
      });
    },
  });
  return { queue, messages, committed, writes: () => writes };
}

test('同一 inputId 再次提交返回第一次的结果', () => {
  const root = tempRoot();
  try {
    const { queue } = harness(root);
    const id = randomUUID();
    const first = queue.submitInput(input(id, '第一句'));
    const second = queue.submitInput(input(id, '改写', { createdAt: '2026-09-27T02:00:00.000Z', surface: 'tui' }));
    assert.equal(second.text, '第一句');
    assert.equal(second.surface, 'desktop');
    assert.equal(second.createdAt, first.createdAt);
    assert.deepEqual(second.anchorRefs, ['anchor-1']);
    const lines = readFileSync(path.join(root, 'ws-1', 'input-queue.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);

    const reopened = createInputQueue({ rootDir: root });
    assert.equal(reopened.submitInput(input(id, '再改')).text, '第一句');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('宿主按提交顺序写入对话，并在推进游标之后通知', () => {
  const root = tempRoot();
  try {
    const { queue, messages, committed } = harness(root);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) queue.submitInput(input(id, `第${index + 1}句`));
    const result = queue.consume('ws-1');
    assert.deepEqual(messages.map((message) => message.content), ['第1句', '第2句', '第3句']);
    assert.deepEqual(messages.map((message) => message.id), ids.map((id) => inputMessageId(id)));
    assert.equal(messages[0].role, 'user');
    assert.deepEqual(result.consumed.map((item) => item.inputId), ids);
    assert.equal(queue.cursor('ws-1'), ids[2]);
    assert.deepEqual(committed, [{ inputIds: ids, cursor: ids[2] }]);
    queue.consume('ws-1');
    assert.equal(messages.length, 3);
    assert.equal(committed.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('对话已写入但游标未推进时，重放不产生第二条消息', () => {
  const root = tempRoot();
  try {
    const box = harness(root);
    const first = randomUUID();
    const second = randomUUID();
    box.queue.submitInput(input(first, '已经落盘'));
    box.queue.submitInput(input(second, '还没写'));
    box.messages.push({ id: inputMessageId(first), role: 'user', content: '已经落盘' });
    const recovered = box.queue.consume('ws-1');
    assert.equal(box.writes(), 1);
    assert.equal(recovered.consumed[0].duplicateMessage, true);
    assert.equal(recovered.consumed[1].duplicateMessage, false);
    assert.deepEqual(box.messages.map((message) => message.content), ['已经落盘', '还没写']);
    assert.equal(box.queue.cursor('ws-1'), second);

    box.queue.consume('ws-1');
    assert.equal(box.writes(), 1);
    assert.equal(box.messages.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('非宿主不消费输入', () => {
  const root = tempRoot();
  try {
    const { queue, messages } = harness(root, { holdsLease: () => false });
    queue.submitInput(input(randomUUID(), '留给宿主'));
    const result = queue.consume('ws-1');
    assert.equal(result.skipped, 'not-host');
    assert.equal(messages.length, 0);
    assert.equal(queue.cursor('ws-1'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
