import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beginConversationCompaction } from './automaticCompaction.ts';
import { conversationStore } from './conversationStore.ts';

describe('beginConversationCompaction', () => {
  it('projects a background compaction only into the conversation that owns it', () => {
    conversationStore.reset('A');
    conversationStore.reset('B');

    beginConversationCompaction(
      'A',
      'compact-A',
      10,
    );

    assert.deepEqual(conversationStore.getSnapshot('A').compactionState, {
      phase: 'running',
      percent: null,
      streamId: 'compact-A',
      startedAt: 10,
    });
    assert.deepEqual(conversationStore.getSnapshot('B').compactionState, { phase: 'idle' });
  });
});
