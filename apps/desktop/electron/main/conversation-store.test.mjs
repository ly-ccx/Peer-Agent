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
