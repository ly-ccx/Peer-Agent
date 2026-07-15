import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  beginConversationCompaction,
  scheduleAutomaticCompaction,
} from './automaticCompaction.ts';
import { conversationStore } from './conversationStore.ts';

describe('scheduleAutomaticCompaction', () => {
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

  it('keeps the task bound to the conversation that triggered it after the active conversation changes', async () => {
    conversationStore.reset('A');
    conversationStore.reset('B');
    const deferred: Array<() => void> = [];
    const compacted: string[] = [];
    let activeConversationId = 'A';

    scheduleAutomaticCompaction(
      activeConversationId,
      async (conversationId) => {
        compacted.push(conversationId);
      },
      (callback) => deferred.push(callback),
    );

    activeConversationId = 'B';
    deferred.shift()?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(activeConversationId, 'B');
    assert.deepEqual(compacted, ['A']);
    assert.equal(conversationStore.getSnapshot('A').autoCompacting, false);
    assert.equal(conversationStore.getSnapshot('B').autoCompacting, false);
  });

  it('deduplicates only within the triggering conversation', () => {
    conversationStore.reset('A');
    conversationStore.reset('B');
    const deferred: Array<() => void> = [];
    const run = async () => undefined;

    scheduleAutomaticCompaction('A', run, (callback) => deferred.push(callback));
    scheduleAutomaticCompaction('A', run, (callback) => deferred.push(callback));
    scheduleAutomaticCompaction('B', run, (callback) => deferred.push(callback));

    assert.equal(deferred.length, 2);
    assert.equal(conversationStore.getSnapshot('A').autoCompacting, true);
    assert.equal(conversationStore.getSnapshot('B').autoCompacting, true);
  });
});
