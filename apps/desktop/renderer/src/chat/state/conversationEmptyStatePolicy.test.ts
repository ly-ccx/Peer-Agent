import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  shouldShowConversationEmptyHome,
  shouldShowConversationLoadingPlaceholder,
} from './conversationEmptyStatePolicy.ts';

describe('conversation empty-state gate', () => {
  it('shows empty home only when load is ready and messages are empty', () => {
    assert.equal(
      shouldShowConversationEmptyHome({ loadStatus: 'ready', messageCount: 0 }),
      true,
    );
    assert.equal(
      shouldShowConversationEmptyHome({ loadStatus: 'loading', messageCount: 0 }),
      false,
    );
    assert.equal(
      shouldShowConversationEmptyHome({ loadStatus: 'idle', messageCount: 0 }),
      false,
    );
    assert.equal(
      shouldShowConversationEmptyHome({ loadStatus: 'ready', messageCount: 3 }),
      false,
    );
  });

  it('shows loading placeholder while switching conversations before messages arrive', () => {
    assert.equal(
      shouldShowConversationLoadingPlaceholder({ loadStatus: 'loading', messageCount: 0 }),
      true,
    );
    assert.equal(
      shouldShowConversationLoadingPlaceholder({ loadStatus: 'idle', messageCount: 0 }),
      true,
    );
    assert.equal(
      shouldShowConversationLoadingPlaceholder({ loadStatus: 'ready', messageCount: 0 }),
      false,
    );
    assert.equal(
      shouldShowConversationLoadingPlaceholder({ loadStatus: 'loading', messageCount: 2 }),
      false,
    );
  });
});
