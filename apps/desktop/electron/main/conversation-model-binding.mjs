function normalizeModelProviderId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolve the provider binding for a conversation-owned runtime turn.
 * An explicit call-site selection wins; managed/background callers may omit it
 * and inherit the authoritative binding persisted on the conversation instead.
 */
export function resolveConversationModelProviderId({
  modelProviderId = null,
  conversationId = null,
  conversationStore = null,
  loadedConversation = undefined,
} = {}) {
  const explicitModelProviderId = normalizeModelProviderId(modelProviderId);
  if (explicitModelProviderId) return explicitModelProviderId;

  const normalizedConversationId = typeof conversationId === 'string'
    ? conversationId.trim()
    : '';
  if (!normalizedConversationId) return null;
  if (
    loadedConversation === undefined
    && typeof conversationStore?.getConversation !== 'function'
  ) {
    return null;
  }

  const conversation = loadedConversation !== undefined
    ? loadedConversation
    : conversationStore.getConversation(normalizedConversationId);
  return normalizeModelProviderId(conversation?.modelProviderId);
}
