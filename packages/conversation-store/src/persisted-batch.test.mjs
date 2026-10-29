import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationStore } from './index.mjs';

test('persisted batch reads one index and preserves single-read streaming boundaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-persisted-batch-'));
  const originalRead = fs.readFileSync;
  try {
    const store = createConversationStore({ storeDir: dir });
    const a = store.createConversation({ title: 'a' }), b = store.createConversation({ title: 'b' });
    store.appendMessage(a.id, { id: 'u', role: 'user', content: 'question' });
    store.appendMessage(a.id, { id: 'active', role: 'assistant', content: '' });
    store.patchStreamingMessage(a.id, 'active', { content: 'not committed' });
    store.appendMessage(b.id, { id: 'b', role: 'user', content: 'other' });
    let reads = 0;
    fs.readFileSync = (file, ...args) => { if (String(file) === path.join(dir, 'index.jsonl')) reads++; return originalRead(file, ...args); };
    syncBuiltinESMExports();
    const batch = store.getPersistedConversationHistories([a.id, b.id, a.id, 'missing']);
    assert.equal(reads, 1, 'one current index read for the complete batch');
    assert.deepEqual(store.getPersistedConversationHistories([]), new Map());
    assert.equal(reads, 1, 'empty batch has no index read');
    fs.readFileSync = originalRead; syncBuiltinESMExports();
    assert.equal(batch.size, 3);
    assert.deepEqual(batch.get(a.id), store.getPersistedConversationHistory(a.id));
    assert.deepEqual(batch.get(b.id), store.getPersistedConversationHistory(b.id));
    assert.equal(batch.get('missing'), null);
    assert.deepEqual(batch.get(a.id).messages.map(row => row.id), ['u']);
    assert.equal(batch.get(a.id).excludedFromMessageId, 'active');
    assert.equal(batch.get(a.id).requiresRuntimeCheck, true);
    store.updateMessageById(a.id, 'active', { content: 'final' });
    const otherProcess = createConversationStore({ storeDir: dir });
    otherProcess.appendMessage(b.id, { id: 'external', role: 'assistant', content: 'external commit' });
    const refreshed = store.getPersistedConversationHistories([a.id, b.id]);
    assert.deepEqual(refreshed.get(a.id).messages.map(row => row.id), ['u', 'active']);
    assert.deepEqual(refreshed.get(b.id).messages.map(row => row.id), ['b', 'external']);
    assert.ok(refreshed.get(a.id).contentRevision > batch.get(a.id).contentRevision);
  } finally {
    fs.readFileSync = originalRead; syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
