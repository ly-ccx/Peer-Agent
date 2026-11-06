/**
 * One full conversation load shared across a single send's prep.
 *
 * handleChatSend opens the handle and llm-chat-service.sendMessage reuses it,
 * so classic send does not call getConversation again before the provider request.
 * This is not a session service: the handle dies with the send that created it.
 * A small recent-load cache lets open-session projection reuse that snapshot
 * when the content revision is still current.
 */
const recentFullLoads = new Map();
const RECENT_FULL_LOAD_LIMIT = 2;

function rememberFullLoad(id, value) {
  if (!id || !value || typeof value !== 'object') return;
  recentFullLoads.delete(id);
  recentFullLoads.set(id, value);
  while (recentFullLoads.size > RECENT_FULL_LOAD_LIMIT) {
    const oldest = recentFullLoads.keys().next().value;
    recentFullLoads.delete(oldest);
  }
}

export function peekConversationLoad(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) return null;
  return recentFullLoads.get(conversationId) ?? null;
}

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
        rememberFullLoad(id, value);
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
