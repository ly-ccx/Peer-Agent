import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationStore } from './index.mjs';

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
