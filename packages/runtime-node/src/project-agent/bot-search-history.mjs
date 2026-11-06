import { isVisibleBotMessage } from './bot-directory.mjs';

/** Public searchable bodies only. Never an execution checkpoint or authority read. */
export function projectBotSearchHistory(history) {
  return (history?.messages || []).filter(isVisibleBotMessage).map(message => ({
    id: message.id, kind: message.kind, type: message.type, messageKind: message.messageKind, role: message.role,
    content: typeof message.content === 'string' ? message.content : typeof message.text === 'string' ? message.text : '',
    createdAt: message.createdAt,
  }));
}

/** Source versions invalidate individual conversations; both count and bytes are bounded. */
export function createBotSearchHistory(conversationStore) {
  return typeof conversationStore.createHistoryProjection === 'function'
    ? conversationStore.createHistoryProjection(projectBotSearchHistory, {
      immutableInput: true, immutableOutput: true, maxEntries: 512, maxBytes: 8 * 1024 * 1024,
    })
    : id => projectBotSearchHistory(conversationStore.getPersistedConversationHistory?.(id));
}
