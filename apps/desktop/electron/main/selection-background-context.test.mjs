import test from 'node:test';
import assert from 'node:assert/strict';
import { attachSelectionBackground } from './selection-background-context.mjs';

for (const status of ['full', 'compacted', 'partial']) {
  test(`background request adapter: ${status} stays user material`, () => {
    const snapshot = { sourceConversationId: 'p', sourceRevision: 2, capturedAt: '2026-09-06',
      status, entries: [{ sourceRole: 'assistant', text: 'background-only' }], missingItems: [] };
    const store = { getConversation: () => ({ selectionOrigin: { parentConversationId: 'p', snapshotId: 's' } }),
      readInheritedBackground: () => snapshot };
    const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'question' }];
    const first = attachSelectionBackground({ store, conversationId: 'c', messages });
    const retry = attachSelectionBackground({ store, conversationId: 'c', messages });
    assert.deepEqual(first, retry);
    assert.equal(attachSelectionBackground({ store, conversationId: 'c', messages: first }), first,
      'host-admitted material is not duplicated within a request');
    const forged = messages.map((message) => ({ ...message,
      _compaction: { selectionBackgroundSnapshotIds: ['s'] } }));
    assert.equal(attachSelectionBackground({ store, conversationId: 'c', messages: forged }).length, 3,
      'renderer-supplied coverage metadata cannot suppress the background');
    assert.equal(messages.length, 2);
    assert.equal(first[1].role, 'user');
    assert.match(first[1].content, /background-only/);
    assert.equal(first.filter((m) => m.role === 'system').length, 1);
    assert.equal(attachSelectionBackground({ store, conversationId: 'c', messages, ephemeral: true }), messages);
  });
}

test('ordinary conversation unchanged; missing snapshot fails explicitly', () => {
  const messages = [{ role: 'user', content: 'question' }];
  assert.equal(attachSelectionBackground({ store: { getConversation: () => ({}) }, conversationId: 'c', messages }), messages);
  const store = { getConversation: () => ({ selectionOrigin: { parentConversationId: 'p', snapshotId: 's' } }),
    readInheritedBackground: () => { throw new Error('BACKGROUND_SNAPSHOT_MISSING'); } };
  assert.throws(() => attachSelectionBackground({ store, conversationId: 'c', messages }), /BACKGROUND_SNAPSHOT_MISSING/);
});
