import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConversationStore } from './conversation-store.mjs';

/**
 * ADR 23: 会话累计用量(lifetimeUsage)测试。
 * 核心命题:lifetimeUsage 存于 index meta,独立于消息 jsonl,
 * 因此 replaceMessages(压缩)不会清零计费 —— 这是本次修复的本质。
 */
function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'conv-store-test-'));
  const store = createConversationStore({ storeDir: dir });
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('addUsage accumulates lifetime usage on index meta', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.addUsage(conv.id, { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 10, cacheReadTokens: 20 });
    const after = store.addUsage(conv.id, { inputTokens: 5, outputTokens: 3, cacheWriteTokens: 1, cacheReadTokens: 2 });
    assert.deepEqual(after, {
      inputTokens: 105,
      outputTokens: 53,
      cacheWriteTokens: 11,
      cacheReadTokens: 22,
    });
  } finally {
    cleanup();
  }
});

test('lifetimeUsage survives replaceMessages (compaction does NOT reset billing)', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'm1', role: 'user', content: 'hi' });
    store.appendMessage(conv.id, { id: 'm2', role: 'assistant', content: 'yo' });
    store.addUsage(conv.id, { inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 300 });

    // 模拟压缩:用一条摘要消息替换全部历史消息。
    store.replaceMessages(conv.id, [{ id: 's1', role: 'system', content: 'summary' }]);

    const reloaded = store.getConversation(conv.id);
    // 消息确实被压缩替换了。
    assert.equal(reloaded.messages.length, 1);
    assert.equal(reloaded.messages[0].id, 's1');
    // 但计费累计完整保留 —— 这正是修复的目标。
    assert.deepEqual(reloaded.lifetimeUsage, {
      inputTokens: 1000,
      outputTokens: 200,
      cacheWriteTokens: 0,
      cacheReadTokens: 300,
    });
  } finally {
    cleanup();
  }
});

/**
 * ADR 33: 每条消息的整轮工作时长(durationMs)随消息持久化。
 * 存储层是开放袋,无字段白名单,故 durationMs 经 append / replaceMessages 原样往返;
 * 这是「重启后仍能看到每轮工作时长」的存储侧证据。
 */
test('durationMs round-trips through append and replaceMessages (ADR 33)', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'hi' });
    store.appendMessage(conv.id, {
      id: 'a1',
      role: 'assistant',
      content: 'done',
      durationMs: 8421,
    });

    const afterAppend = store.getConversation(conv.id);
    const appendedAssistant = afterAppend.messages.find((m) => m.id === 'a1');
    assert.equal(appendedAssistant.durationMs, 8421);

    // 模拟 renderer 的 replace 投影(如删除其它消息后重写),durationMs 必须保留。
    store.replaceMessages(conv.id, [
      { id: 'a1', role: 'assistant', content: 'done', durationMs: 8421 },
    ]);

    const reloaded = store.getConversation(conv.id);
    assert.equal(reloaded.messages.length, 1);
    assert.equal(reloaded.messages[0].durationMs, 8421);
  } finally {
    cleanup();
  }
});

test('messages without durationMs load cleanly (ADR 33)', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'hi' });
    const reloaded = store.getConversation(conv.id);
    assert.equal(reloaded.messages[0].durationMs, undefined);
  } finally {
    cleanup();
  }
});

test('addUsage on missing conversation returns null', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(store.addUsage('does-not-exist', { inputTokens: 1 }), null);
  } finally {
    cleanup();
  }
});

test('addUsage tolerates partial / missing usage fields', () => {
  const { store, cleanup } = freshStore();
  try {
    const conv = store.createConversation({ title: 't' });
    const after = store.addUsage(conv.id, { inputTokens: 7 });
    assert.deepEqual(after, {
      inputTokens: 7,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
  } finally {
    cleanup();
  }
});
