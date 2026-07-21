import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearCompletedUnreadId,
  nextCompletedUnreadIds,
  sameStringSet,
  shouldShowCompletedUnreadDot,
} from './completedUnreadState.ts';

describe('completedUnreadState', () => {
  it('marks a conversation completed-unread when it leaves running and is not active', () => {
    const next = nextCompletedUnreadIds({
      previousRunningIds: new Set(['a', 'b']),
      nextRunningIds: new Set(['b']),
      activeConversationId: 'b',
      completedUnreadIds: new Set(),
    });
    assert.deepEqual([...next].sort(), ['a']);
  });

  it('does not mark completed-unread when the finishing conversation is active', () => {
    const next = nextCompletedUnreadIds({
      previousRunningIds: new Set(['a']),
      nextRunningIds: new Set(),
      activeConversationId: 'a',
      completedUnreadIds: new Set(),
    });
    assert.equal(next.size, 0);
  });

  it('clears an existing mark when the conversation becomes active during a running change', () => {
    const next = nextCompletedUnreadIds({
      previousRunningIds: new Set(['b']),
      nextRunningIds: new Set(['b']),
      activeConversationId: 'a',
      completedUnreadIds: new Set(['a', 'c']),
    });
    assert.deepEqual([...next].sort(), ['c']);
  });

  it('clearCompletedUnreadId removes only the selected conversation', () => {
    const next = clearCompletedUnreadId(new Set(['a', 'b']), 'a');
    assert.deepEqual([...next].sort(), ['b']);
    const unchanged = clearCompletedUnreadId(new Set(['a']), null);
    assert.deepEqual([...unchanged], ['a']);
  });

  it('shouldShowCompletedUnreadDot yields to running and compaction indicators', () => {
    const ids = new Set(['a']);
    assert.equal(
      shouldShowCompletedUnreadDot({
        conversationId: 'a',
        isRunning: false,
        isCompactionVisible: false,
        completedUnreadIds: ids,
      }),
      true,
    );
    assert.equal(
      shouldShowCompletedUnreadDot({
        conversationId: 'a',
        isRunning: true,
        isCompactionVisible: false,
        completedUnreadIds: ids,
      }),
      false,
    );
    assert.equal(
      shouldShowCompletedUnreadDot({
        conversationId: 'a',
        isRunning: false,
        isCompactionVisible: true,
        completedUnreadIds: ids,
      }),
      false,
    );
  });

  it('sameStringSet compares set membership', () => {
    assert.equal(sameStringSet(new Set(['a']), new Set(['a'])), true);
    assert.equal(sameStringSet(new Set(['a']), new Set(['b'])), false);
  });
});
