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
} = {}) {
  const explicitModelProviderId = normalizeModelProviderId(modelProviderId);
  if (explicitModelProviderId) return explicitModelProviderId;

  const normalizedConversationId = typeof conversationId === 'string'
    ? conversationId.trim()
    : '';
  if (!normalizedConversationId || typeof conversationStore?.getConversation !== 'function') {
    return null;
  }

  return normalizeModelProviderId(
    conversationStore.getConversation(normalizedConversationId)?.modelProviderId,
  );
}
