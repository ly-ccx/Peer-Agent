/** Facts consumed by list previews/questions/cursors; never a conversation or execution result. */
export function projectBotSummaryHistory(history) {
  const messages = history?.messages || [];
  const latest = messages.findLast(message => message.kind === 'agent_reply' || !message.kind && message.role === 'assistant');
  return messages.map(message => {
    const row = { id: message.id,
      // Preserve the ordinary preview's whitespace boundary.
      content: isVisibleBotMessage(message) ? projectBotListMessage(message, 81).text : '' };
    for (const key of ['kind', 'type', 'messageKind', 'role', 'createdAt', 'at', 'answerTo', 'surfacing']) {
      if (message[key] !== undefined) row[key] = message[key];
    }
    if (Array.isArray(message.quoteRefs)) row.quoteRefs = [...message.quoteRefs];
    if (message.question) row.question = structuredClone(message.question);
    // Only the current question needs bounded readable context.
    if (message === latest && message.question && typeof message.content === 'string') row.questionContext = message.content.slice(-2000);
    if (message.meta?.surfacing !== undefined || message.meta?.unread !== undefined) {
      row.meta = {};
      if (message.meta.surfacing !== undefined) row.meta.surfacing = message.meta.surfacing;
      if (message.meta.unread !== undefined) row.meta.unread = message.meta.unread;
    }
    if (Array.isArray(message.attachments)) row.attachments = message.attachments.map(item => ({ name: item?.name }));
    return row;
  });
}

export function createBotSummaryHistory(conversationStore) {
  return typeof conversationStore.createHistoryProjection === 'function'
    ? conversationStore.createHistoryProjection(projectBotSummaryHistory, { immutableInput: true, immutableOutput: true, maxEntries: 512, maxBytes: 8 * 1024 * 1024 })
    : id => projectBotSummaryHistory(conversationStore.getPersistedConversationHistory?.(id));
}
import { isVisibleBotMessage, projectBotListMessage } from './bot-directory.mjs';

