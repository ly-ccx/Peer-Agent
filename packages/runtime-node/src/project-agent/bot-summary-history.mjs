/** Facts consumed by list previews/questions/cursors; never a conversation or execution result. */
export function projectBotSummaryHistory(history) {
  const messages = history?.messages || [];
  const latest = messages.findLast(message => message.kind === 'agent_reply' || !message.kind && message.role === 'assistant');
  return messages.map(message => ({
    id: message.id, kind: message.kind, type: message.type, messageKind: message.messageKind, role: message.role,
    // One extra character preserves a space at the 80-character boundary when
    // the list applies its ordinary trim/clip again.
    content: isVisibleBotMessage(message) ? projectBotListMessage(message, 81).text : '',
    createdAt: message.createdAt, at: message.at, answerTo: message.answerTo,
    quoteRefs: Array.isArray(message.quoteRefs) ? [...message.quoteRefs] : undefined,
    question: message.question ? structuredClone(message.question) : undefined,
    // Only the current decision needs readable context. Old process/history bodies stay out of this hot projection.
    ...(message === latest && message.question && typeof message.content === 'string'
      ? { questionContext: message.content.slice(-2000) } : {}),
    surfacing: message.surfacing, meta: { surfacing: message.meta?.surfacing, unread: message.meta?.unread },
    attachments: Array.isArray(message.attachments) ? message.attachments.map(item => ({ name: item?.name })) : undefined,
  }));
}

export function createBotSummaryHistory(conversationStore) {
  return typeof conversationStore.createHistoryProjection === 'function'
    ? conversationStore.createHistoryProjection(projectBotSummaryHistory, { immutableInput: true, maxEntries: 512, maxBytes: 8 * 1024 * 1024 })
    : id => projectBotSummaryHistory(conversationStore.getPersistedConversationHistory?.(id));
}
import { isVisibleBotMessage, projectBotListMessage } from './bot-directory.mjs';

