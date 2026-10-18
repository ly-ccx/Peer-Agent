/** Acceptance needs exact anchors and formal citations, never tool/thinking bodies. */
export function createSessionParentFacts(conversationStore) {
  const project = history => (history?.messages || []).map(message => ({
    id: message.id, kind: message.kind, content: typeof message.content === 'string' ? message.content : '',
    sources: Array.isArray(message.sources) ? [...message.sources] : undefined,
    meta: { sources: Array.isArray(message.meta?.sources) ? [...message.meta.sources] : undefined },
  }));
  return typeof conversationStore.createHistoryProjection === 'function'
    ? conversationStore.createHistoryProjection(project)
    : id => project(conversationStore.getPersistedConversationHistory?.(id));
}
