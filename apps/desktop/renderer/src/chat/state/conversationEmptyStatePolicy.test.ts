import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  conversationHomeGreeting,
  resolveDayPeriod,
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

  it('resolves stable local-time greetings at period boundaries', () => {
    assert.equal(resolveDayPeriod(0), 'morning');
    assert.equal(resolveDayPeriod(11), 'morning');
    assert.equal(resolveDayPeriod(12), 'afternoon');
    assert.equal(resolveDayPeriod(17), 'afternoon');
    assert.equal(resolveDayPeriod(18), 'evening');
    assert.equal(resolveDayPeriod(23), 'evening');
    assert.equal(conversationHomeGreeting(9, true), '早上好，接下来想做点什么？');
    assert.equal(conversationHomeGreeting(14, true), '下午好，今天想推进什么？');
    assert.equal(conversationHomeGreeting(20, false), 'Good evening. What would you like to do next?');
    assert.equal(
      conversationHomeGreeting(9, true, 'peer_agent'),
      '早上好，接下来在 peer_agent 想做点什么？',
    );
    assert.equal(
      conversationHomeGreeting(20, false, 'peer-knowledge'),
      'Good evening. What would you like to do in peer-knowledge?',
    );
  });
});
