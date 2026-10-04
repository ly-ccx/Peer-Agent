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
    assert.equal(messages[0].kind, 'user_input');
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

test('历史引用只在提供时写入，缺省或非法时不出现', () => {
  const root = tempRoot();
  try {
    const { queue, messages } = harness(root);
    const plain = randomUUID();
    const linked = randomUUID();
    queue.submitInput(input(plain, '普通'));
    queue.submitInput(input(linked, '继续：旧对话', {
      historyRef: 'conv-old',
      historySnapshotId: 'snap-1',
      historyConfirmed: true,
    }));
    queue.consume('ws-1');
    assert.equal(messages[0].historyRef, undefined);
    assert.equal(messages[0].historySnapshotId, undefined);
    assert.equal(messages[0].historyConfirmed, undefined);
    assert.equal(messages[1].historyRef, 'conv-old');
    assert.equal(messages[1].historySnapshotId, 'snap-1');
    assert.equal(messages[1].historyConfirmed, true);
    const noisy = queue.submitInput(input(randomUUID(), '坏引用', { historyRef: 'has\nnewline' }));
    assert.equal(noisy.historyRef, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('截图缩略图随输入进入对话消息', () => {
  const root = tempRoot();
  try {
    const { queue, messages } = harness(root);
    const saved = queue.submitInput(input(randomUUID(), 'Appshot — TextEdit', {
      attachmentRefs: ['local-appshot-artifact://abc-123'],
      attachments: [{
        kind: 'image',
        name: 'Appshot — TextEdit',
        dataUrl: 'data:image/png;base64,AA==',
        artifactRef: 'local-appshot-artifact://abc-123',
      }],
    }));
    assert.equal(saved.attachments[0].dataUrl, 'data:image/png;base64,AA==');
    queue.consume('ws-1');
    assert.equal(messages[0].attachments[0].dataUrl, 'data:image/png;base64,AA==');
    assert.equal(messages[0].attachments[0].kind, 'image');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivered input remains executable after restart until a real reply or explicit completion', () => {
  const root = tempRoot(); const box = harness(root);
  try {
    box.queue.submitInput({ workspaceId: 'ws-1', inputId: 'first', surface: 'desktop', text: 'first' });
    box.queue.submitInput({ workspaceId: 'ws-1', inputId: 'second', surface: 'desktop', text: 'second' });
    box.queue.consume('ws-1');
    assert.deepEqual(box.queue.pendingExecution('ws-1').map(input => input.inputId), ['first', 'second']);
    box.queue.completeExecution('ws-1', ['second']);
    assert.deepEqual(box.queue.pendingExecution('ws-1').map(input => input.inputId), ['first']);
    assert.deepEqual(box.queue.pendingExecution('ws-1', { repliedTo: ['input-first'] }), []);
    assert.equal(box.queue.cursor('ws-1'), 'second');
    box.queue.submitInput({ workspaceId: 'ws-1', inputId: 'third', surface: 'desktop', text: 'third' });
    box.queue.consume('ws-1');
    assert.deepEqual(box.queue.pendingExecution('ws-1').map(input => input.inputId), ['third']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('user uploads survive attachment-only submit, durable reopen and idempotent retry', () => {
  const root = tempRoot();
  try {
    const { queue } = harness(root);
    const uploads = [
      { id: 'doc', name: 'brief.md', kind: 'text', mimeType: 'text/markdown', size: 7, sourceKind: 'user_upload', text: '事实材料' },
      { id: 'img', name: 'shot.png', kind: 'image', mimeType: 'image/png', size: 1, sourceKind: 'user_upload', dataUrl: 'data:image/png;base64,AA==' },
      { id: 'pdf', name: 'brief.pdf', kind: 'unsupported', mimeType: 'application/pdf', size: 20, sourceKind: 'user_upload', text: 'must not admit', filePath: '/not-authorized' },
    ];
    const request = input(randomUUID(), '', { attachments: uploads });
    const saved = queue.submitInput(request);
    assert.equal(saved.text, '');
    assert.equal(saved.attachments.length, 3);
    assert.equal(saved.attachments[2].text, undefined);
    assert.equal(saved.attachments[2].filePath, undefined);
    const reopened = harness(root);
    const replay = reopened.queue.submitInput({ ...request, text: 'do not replace' });
    assert.deepEqual(replay, saved);
    reopened.queue.consume('ws-1');
    assert.deepEqual(reopened.messages[0].attachments, saved.attachments);
    assert.equal(reopened.messages[0].content, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('explicit upload validation rejects oversized content and cannot trust declared size', () => {
  const root = tempRoot();
  try {
    const { queue } = harness(root);
    const base = { id: 'a', name: 'brief.md', sourceKind: 'user_upload', kind: 'text', mimeType: 'text/plain', size: 0, text: 'ok' };
    const submit = attachments => queue.submitInput(input(randomUUID(), 'read', { attachments }));
    assert.throws(() => submit([{ ...base, text: '字'.repeat(180_000) }]), /512 KiB/);
    assert.throws(() => submit(Array.from({ length: 9 }, () => base)), /8 attachments/);
    assert.throws(() => submit([{ ...base, kind: 'image', mimeType: 'image/png', dataUrl: 'https://untrusted/image.png' }]), /image data/);
    assert.throws(() => submit([{ ...base, kind: 'image', mimeType: 'image/png', dataUrl: `data:image/png;base64,${Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64')}` }]), /8 MiB/);
    const large = submit([{ ...base, kind: 'image', mimeType: 'image/png', size: 600_000,
      dataUrl: `data:image/png;base64,${Buffer.alloc(600_000).toString('base64')}`, filePath: '/not-authorized' }]);
    assert.equal(large.attachments[0].dataUrl.length > 512 * 1024, true);
    assert.equal(large.attachments[0].filePath, undefined);
    assert.throws(() => queue.submitInput(input(randomUUID(), '', {})), /text or attachments/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
