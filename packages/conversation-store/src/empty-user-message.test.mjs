import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import { createConversationStore } from './index.mjs';

describe('conversation-store empty user message guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-empty-user-'));
  const store = createConversationStore({ storeDir: dir });
  after(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('refuses to append empty user messages without attachments', () => {
    const conv = store.createConversation({ title: 't', mode: 'chat' });
    const before = store.getConversation(conv.id);
    const result = store.appendMessage(conv.id, { id: 'u-empty', role: 'user', content: '' });
    const after = store.getConversation(conv.id);
    assert.equal((before?.messages || []).length, (after?.messages || []).length);
    assert.ok(!(after?.messages || []).some((m) => m.id === 'u-empty'));
    assert.ok(result);
  });

  it('strips empty user messages on replaceMessages', () => {
    const conv = store.createConversation({ title: 't2', mode: 'chat' });
    store.appendMessage(conv.id, { id: 'u1', role: 'user', content: 'hello' });
    store.appendMessage(conv.id, { id: 'a1', role: 'assistant', content: 'hi' });
    store.replaceMessages(conv.id, [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'empty', role: 'user', content: '' },
      { id: 'a1', role: 'assistant', content: 'hi' },
    ]);
    const after = store.getConversation(conv.id);
    assert.equal(after.messages.length, 2);
    assert.ok(!after.messages.some((m) => m.id === 'empty'));
  });

  it('keeps image-only user messages', () => {
    const conv = store.createConversation({ title: 't3', mode: 'chat' });
    store.appendMessage(conv.id, {
      id: 'img',
      role: 'user',
      content: '',
      attachments: [{ name: 'a.png', kind: 'image' }],
    });
    const after = store.getConversation(conv.id);
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0].id, 'img');
  });
});
