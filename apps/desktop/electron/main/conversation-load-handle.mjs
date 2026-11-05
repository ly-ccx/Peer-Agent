/**
 * One full conversation load shared across a single send's prep.
 *
 * handleChatSend opens the handle and llm-chat-service.sendMessage reuses it,
 * so classic send does not call getConversation again before the provider request.
 * This is not a session service: the handle dies with the send that created it.
 */
export function createConversationLoadHandle(store, conversationId) {
  const id = typeof conversationId === 'string' ? conversationId : '';
  let state = { status: 'empty' };
  return Object.freeze({
    kind: 'conversation-load-handle',
    conversationId: id || null,
    load() {
      if (state.status === 'ready') return state.value;
      if (state.status === 'error') throw state.error;
      if (!id || typeof store?.getConversation !== 'function') {
        state = { status: 'ready', value: null };
        return null;
      }
      try {
        const value = store.getConversation(id);
        state = { status: 'ready', value };
        return value;
      } catch (error) {
        state = { status: 'error', error };
        throw error;
      }
    },
  });
}

export function isConversationLoadHandle(value) {
  return Boolean(value)
    && value.kind === 'conversation-load-handle'
    && typeof value.load === 'function';
}
