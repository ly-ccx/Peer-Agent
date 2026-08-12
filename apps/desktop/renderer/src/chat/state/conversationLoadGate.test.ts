import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  conversationLoadEffectShouldDependOnProviders,
  shouldHardBeginConversationLoad,
  shouldPersistEffortCorrection,
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
      true,
    );
    assert.equal(
      shouldHardBeginConversationLoad({ loadStatus: 'ready', messageCount: 12 }),
      false,
    );
  });

  it('never couples the main conversation load effect to providers', () => {
    assert.equal(conversationLoadEffectShouldDependOnProviders(), false);
  });

  it('does not persist a temporary effort correction while an existing conversation restores', () => {
    assert.equal(
      shouldPersistEffortCorrection({ conversationId: 'existing-chat', loadStatus: 'idle' }),
      false,
    );
    assert.equal(
      shouldPersistEffortCorrection({ conversationId: 'existing-chat', loadStatus: 'loading' }),
      false,
    );
    assert.equal(
      shouldPersistEffortCorrection({ conversationId: 'existing-chat', loadStatus: 'ready' }),
      true,
    );
    assert.equal(
      shouldPersistEffortCorrection({ conversationId: null, loadStatus: 'idle' }),
      true,
    );
  });
});
