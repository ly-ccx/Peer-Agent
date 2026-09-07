import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmChatService } from './llm-chat-service.mjs';

for (const marker of [null, 'interrupted-assistant']) {
  test(`selection runtime attestation: persisted marker=${marker}`, () => {
    const service = createLlmChatService({
      conversationStore: { getPersistedConversationHistory: (id) => id === 'source'
        ? { contentRevision: 7, excludedFromMessageId: marker, messages: [] } : null },
    });
    assert.deepEqual(service.getSelectionRuntimeState('source'), {
      conversationId: 'source', contentRevision: 7, status: marker ? 'unknown' : 'idle',
    });
    assert.deepEqual(service.getSelectionRuntimeState('missing'), {
      conversationId: 'missing', contentRevision: null, status: 'unknown',
    });
    assert.deepEqual(service.listActiveConversationIds(), []);
  });
}

test('selection runtime attestation does not hide corrupt history', () => {
  const service = createLlmChatService({ conversationStore: {
    getPersistedConversationHistory: () => { throw new Error('BACKGROUND_HISTORY_CORRUPT'); },
  } });
  assert.throws(() => service.getSelectionRuntimeState('source'), /BACKGROUND_HISTORY_CORRUPT/);
});
