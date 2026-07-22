import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canAutoDispatchQueuedMessage,
  dispatchQueuedMessage,
} from './messageQueueDispatch.ts';

const idleReadyConversation = {
  loadStatus: 'ready' as const,
  isStreaming: false,
  isCompactionActive: false,
  hasProvider: true,
  hasConversation: true,
  hasResumeTask: false,
  queueLength: 1,
};

describe('messageQueueDispatch', () => {
  it('dispatches only after an idle conversation is fully activated', () => {
    assert.equal(canAutoDispatchQueuedMessage(idleReadyConversation), true);
  });

  it('keeps queued messages while a switched conversation is loading and reattaching', () => {
    assert.equal(canAutoDispatchQueuedMessage({
      ...idleReadyConversation,
      loadStatus: 'loading',
    }), false);
  });

  it('keeps queued messages when reattach confirms the conversation is still running', () => {
    assert.equal(canAutoDispatchQueuedMessage({
      ...idleReadyConversation,
      isStreaming: true,
    }), false);
  });

  it('does not compete with compaction or a resume task', () => {
    assert.equal(canAutoDispatchQueuedMessage({
      ...idleReadyConversation,
      isCompactionActive: true,
    }), false);
    assert.equal(canAutoDispatchQueuedMessage({
      ...idleReadyConversation,
      hasResumeTask: true,
    }), false);
  });

  it('removes a queued message only after the send path accepts it', async () => {
    const message = { id: 'q1', text: 'keep me', attachments: [], effort: 'default' as const };
    const removed: string[] = [];

    const rejected = await dispatchQueuedMessage({
      message,
      submit: async () => false,
      remove: (id) => removed.push(id),
    });
    assert.equal(rejected, false);
    assert.deepEqual(removed, []);

    const accepted = await dispatchQueuedMessage({
      message,
      submit: async () => true,
      remove: (id) => removed.push(id),
    });
    assert.equal(accepted, true);
    assert.deepEqual(removed, ['q1']);
  });
});
