import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import { createConversationStore } from './index.mjs';

/**
 * 流式 sidecar 契约（性能修复的行为锚点）：
 * - patchStreamingMessage 只写 sidecar 小文件，不 bump contentRevision、不广播 change。
 * - getConversation 读取时按 messageId 合并 sidecar（崩溃恢复语义）。
 * - updateMessageById（终态全量落盘）自动清理 sidecar。
 */
describe('conversation-store streaming sidecar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-stream-sidecar-'));
  const store = createConversationStore({ storeDir: dir });
  after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function seedConversation() {
    const conv = store.createConversation({ title: 's', mode: 'chat' });
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'question' });
    store.appendMessage(conv.id, { id: 'a1', role: 'assistant', content: '' });
    return conv;
  }

  it('merges sidecar patch into getConversation without touching the jsonl', () => {
    const conv = seedConversation();
    const ok = store.patchStreamingMessage(conv.id, 'a1', { content: 'partial text', segments: [{ type: 'text', content: 'partial text' }] });
    assert.equal(ok, true);
    assert.ok(existsSync(join(dir, `${conv.id}.stream.json`)));

    const loaded = store.getConversation(conv.id);
    const assistant = loaded.messages.find((m) => m.id === 'a1');
    assert.equal(assistant.content, 'partial text');
    assert.equal(assistant.segments.length, 1);
  });

  it('does not emit store change events for streaming patches', () => {
    const conv = seedConversation();
    let notified = 0;
    const unsubscribe = store.subscribeChanges(() => { notified += 1; });
    store.patchStreamingMessage(conv.id, 'a1', { content: 'x' });
    store.patchStreamingMessage(conv.id, 'a1', { content: 'xy' });
    unsubscribe?.();
    assert.equal(notified, 0);
  });

  it('final updateMessageById clears the sidecar and wins over stale patches', () => {
    const conv = seedConversation();
    store.patchStreamingMessage(conv.id, 'a1', { content: 'stale partial' });
    store.updateMessageById(conv.id, 'a1', { content: 'final answer' });
    assert.ok(!existsSync(join(dir, `${conv.id}.stream.json`)));
    const loaded = store.getConversation(conv.id);
    assert.equal(loaded.messages.find((m) => m.id === 'a1').content, 'final answer');
  });

  it('ignores sidecar whose messageId no longer exists', () => {
    const conv = seedConversation();
    store.patchStreamingMessage(conv.id, 'missing-id', { content: 'orphan' });
    const loaded = store.getConversation(conv.id);
    assert.equal(loaded.messages.find((m) => m.id === 'a1').content, '');
  });

  it('rejects patches without a messageId', () => {
    const conv = seedConversation();
    assert.equal(store.patchStreamingMessage(conv.id, '', { content: 'x' }), false);
    assert.equal(store.patchStreamingMessage(conv.id, null, { content: 'x' }), false);
  });

  it('clearStreamPatch is idempotent', () => {
    const conv = seedConversation();
    store.patchStreamingMessage(conv.id, 'a1', { content: 'x' });
    store.clearStreamPatch(conv.id);
    store.clearStreamPatch(conv.id);
    assert.ok(!existsSync(join(dir, `${conv.id}.stream.json`)));
  });
});
