import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationStore } from './index.mjs';
import { readStoredWorkHistory } from './persisted-history.mjs';

test('scoped history reads share a budget across the index, canonical file and stream marker', t => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-work-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir });
  const workspaceId = 'bot-a', sessionId = 'session-a', anchorMessageId = 'anchor-a';
  const parent = store.createConversation({ role: 'project_agent', workspaceId });
  store.appendMessage(parent.id, { id: anchorMessageId, role: 'user', content: 'question' });
  const child = store.createChildConversation({ parentConversationId: parent.id, role: 'work_session', workspaceId, anchorMessageId,
    delegation: { sessionId, anchorMessageId, inputId: 'input-a' }, backgroundMessageIds: [anchorMessageId],
    runtimeState: { conversationId: parent.id, contentRevision: store.getPersistedConversationHistory(parent.id).contentRevision, status: 'idle' },
    capturedAt: '2026-11-03T00:00:00Z' });
  store.appendMessage(child.id, { id: 'u1', role: 'user', content: 'canonical' });
  store.appendMessage(child.id, { id: 'a1', role: 'assistant', content: 'persisted text' });
  store.patchStreamingMessage(child.id, 'a1', { content: 'provisional text' });
  const scope = { workspaceId, parentConversationId: parent.id, conversationId: child.id, sessionId };
  const expectedBytes = ['index.jsonl', `${child.id}.jsonl`, `${child.id}.stream.json`].reduce((sum, file) => sum + statSync(join(dir, file)).size + 1, 0);
  const exact = { remainingBytes: expectedBytes };
  const history = readStoredWorkHistory(dir, scope, exact);
  assert.deepEqual(history.messages.map(message => message.id), ['u1']);
  assert.equal(exact.remainingBytes, 0);
  assert.throws(() => readStoredWorkHistory(dir, scope, exact), { code: 'BACKGROUND_HISTORY_LIMIT' });
  assert.throws(() => readStoredWorkHistory(dir, scope, { remainingBytes: expectedBytes - 1 }), { code: 'BACKGROUND_HISTORY_LIMIT' });
  assert.deepEqual(readStoredWorkHistory(dir, scope), history);
});

for (const streaming of [false, true]) {
  for (const reopened of [false, true]) {
    test(`persisted history: streaming=${streaming}, reopened=${reopened}`, (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'peer-history-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      let store = createConversationStore({ storeDir: dir });
      const { id } = store.createConversation({ title: 'source' });
      store.appendMessage(id, { id: 'u1', role: 'user', content: 'question' });
      store.appendMessage(id, { id: 'a1', role: 'assistant', content: 'persisted text' });
      if (streaming) store.patchStreamingMessage(id, 'a1', { content: 'provisional text' });
      if (reopened) store = createConversationStore({ storeDir: dir });
      const history = store.getPersistedConversationHistory(id);
      assert.equal(history.requiresRuntimeCheck, true);
      assert.equal(history.excludedFromMessageId, streaming ? 'a1' : null);
      assert.deepEqual(history.messages.map((m) => m.id), streaming ? ['u1'] : ['u1', 'a1']);
      assert.equal(store.getConversation(id).messages[1].content, streaming ? 'provisional text' : 'persisted text');
      history.messages[0].content = 'mutated';
      assert.equal(store.getPersistedConversationHistory(id).messages[0].content, 'question');
      assert.equal(store.getPersistedConversationHistory('missing'), null);
    });
  }
}
