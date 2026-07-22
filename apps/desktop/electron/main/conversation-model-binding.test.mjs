import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveConversationModelProviderId } from './conversation-model-binding.mjs';

test('explicit provider binding takes precedence over the conversation binding', () => {
  const conversationStore = {
    getConversation: () => ({ modelProviderId: 'conversation-provider' }),
  };

  assert.equal(resolveConversationModelProviderId({
    modelProviderId: ' explicit-provider ',
    conversationId: 'conversation-1',
    conversationStore,
  }), 'explicit-provider');
});

test('managed turns inherit the provider binding persisted on the conversation', () => {
  const conversationStore = {
    getConversation: (conversationId) => conversationId === 'conversation-1'
      ? { modelProviderId: ' conversation-provider ' }
      : null,
  };

  assert.equal(resolveConversationModelProviderId({
    conversationId: ' conversation-1 ',
    conversationStore,
  }), 'conversation-provider');
});

test('missing or blank bindings resolve to the global-default sentinel', () => {
  const conversationStore = {
    getConversation: () => ({ modelProviderId: '   ' }),
  };

  assert.equal(resolveConversationModelProviderId({ conversationStore }), null);
  assert.equal(resolveConversationModelProviderId({
    conversationId: 'missing-binding',
    conversationStore,
  }), null);
});
