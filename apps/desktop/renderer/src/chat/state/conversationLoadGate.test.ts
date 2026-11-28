import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  conversationLoadEffectShouldDependOnProviders,
  shouldHardBeginConversationLoad,
  canPersistRestoredConversationMetadata,
} from './conversationLoadGate.ts';

describe('conversation load gate', () => {
  it('hard-begins load only when there is no ready visible transcript', () => {
    assert.equal(
      shouldHardBeginConversationLoad({ loadStatus: 'idle', messageCount: 0 }),
      true,
    );
    assert.equal(
      shouldHardBeginConversationLoad({ loadStatus: 'loading', messageCount: 0 }),
      true,
    );
    assert.equal(
      shouldHardBeginConversationLoad({ loadStatus: 'ready', messageCount: 0 }),
      false,
    );
    assert.equal(
      shouldHardBeginConversationLoad({ loadStatus: 'ready', messageCount: 12 }),
      false,
    );
  });

  it('never couples the main conversation load effect to providers', () => {
    assert.equal(conversationLoadEffectShouldDependOnProviders(), false);
  });

  const idleChat = {
    conversationId: 'existing-chat',
    loadStatus: 'ready',
    streamStatus: 'confirmed',
    canEdit: true,
    isBusy: false,
  } as const;

  it('defers model and effort correction until both transcript and execution state are known', () => {
    assert.equal(canPersistRestoredConversationMetadata({ ...idleChat, loadStatus: 'idle' }), false);
    assert.equal(canPersistRestoredConversationMetadata({ ...idleChat, loadStatus: 'loading' }), false);
    assert.equal(canPersistRestoredConversationMetadata({ ...idleChat, streamStatus: 'unknown' }), false);
    assert.equal(canPersistRestoredConversationMetadata(idleChat), true);
    assert.equal(canPersistRestoredConversationMetadata({ ...idleChat, conversationId: null, loadStatus: 'idle' }), true);
  });

  it('defers correction while executing and resumes it only for an editable conversation', () => {
    assert.equal(canPersistRestoredConversationMetadata({ ...idleChat, isBusy: true }), false);
    assert.equal(canPersistRestoredConversationMetadata(idleChat), true);
    // Delegated task scene has no composer, both while streaming and while idle.
    assert.equal(canPersistRestoredConversationMetadata({ ...idleChat, canEdit: false, isBusy: true }), false);
    assert.equal(canPersistRestoredConversationMetadata({ ...idleChat, canEdit: false }), false);
  });
});
