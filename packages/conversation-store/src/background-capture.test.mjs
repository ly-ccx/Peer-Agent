import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationStore } from './index.mjs';

for (const running of [false, true]) {
  test(`store capture: running=${running}, persisted recovery freezes history`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'peer-capture-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = createConversationStore({ storeDir: dir });
    const { id } = store.createConversation({ title: 'source' });
    store.appendMessage(id, { id: 'u', role: 'user', content: 'question' });
    store.appendMessage(id, { id: 'a', role: 'assistant', content: 'answer' });
    if (running) store.patchStreamingMessage(id, 'a', { content: 'provisional' });
    const revision = store.getPersistedConversationHistory(id).contentRevision;
    const options = { expectedRevision: revision, capturedAt: '2026-09-06T10:00:00Z',
      runtimeState: { conversationId: id, contentRevision: revision, status: running ? 'running' : 'idle', activeMessageId: 'a' } };
    const capture = store.captureInheritedBackground(id, options);
    assert.equal(store.captureInheritedBackground(id, options).snapshotId, capture.snapshotId);
    assert.deepEqual(capture.snapshot.entries.map((e) => e.text), running ? ['question'] : ['question', 'answer']);
    store.clearStreamPatch(id);
    store.appendMessage(id, { id: 'later', role: 'user', content: 'later question' });
    const reopened = createConversationStore({ storeDir: dir });
    assert.deepEqual(reopened.readInheritedBackground(capture.snapshotId), capture.snapshot);
    assert.throws(() => store.captureInheritedBackground(id, options), { code: 'BACKGROUND_VERSION_CHANGED' });
    assert.equal(reopened.listConversations().length, 1, 'capture does not silently create a child session');
  });
}
