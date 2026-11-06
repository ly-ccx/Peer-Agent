/** Facts consumed by list previews/questions/cursors; never a conversation or execution result. */
import { isVisibleBotMessage, projectBotListMessage } from './bot-directory.mjs';

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

/** One list row from a materialized preview. Does not read a transcript. */
export function summaryMessagesFromPreview(preview) {
  if (!preview || preview.availability === 'rebuilding' || preview.availability === 'damaged') return [];
  if (!preview.messageId && !preview.excerpt) return [];
  const row = {
    id: preview.messageId || 'preview',
    role: preview.role === 'user' ? 'user' : 'assistant',
    kind: preview.kind || (preview.role === 'user' ? 'user_input' : 'agent_reply'),
    content: typeof preview.excerpt === 'string' ? preview.excerpt : '',
    createdAt: preview.at || preview.updatedAt || '',
  };
  if (preview.question && typeof preview.question === 'object') row.question = preview.question;
  if (Array.isArray(preview.attachmentNames) && preview.attachmentNames.length) {
    row.attachments = preview.attachmentNames.map(name => ({ name }));
  }
  if (preview.countUnread === false || preview.surfacing) {
    row.meta = {};
    if (preview.surfacing) row.meta.surfacing = preview.surfacing;
    if (preview.countUnread === false) row.meta.unread = false;
  }
  if (preview.surfacing) row.surfacing = preview.surfacing;
  return [row];
}

function cloneSummary(value) {
  return value == null ? value : structuredClone(value);
}

/**
 * List hot path. Reads the materialized preview. A cache miss reads a tail
 * window only — never the full persisted history.
 */
export function createBotSummaryHistory(conversationStore) {
  const entries = new Map();
  const maxEntries = 512;
  return (id) => {
    const preview = typeof conversationStore.readSessionPreview === 'function'
      ? conversationStore.readSessionPreview(id)
      : null;
    const version = preview
      ? `${preview.contentRevision}:${preview.availability}:${preview.excerpt}:${preview.messageId || ''}`
      : null;
    const cached = version ? entries.get(id) : null;
    if (cached && cached.version === version) {
      entries.delete(id);
      entries.set(id, cached);
      return cloneSummary(cached.value);
    }
    let value = null;
    if (preview?.availability === 'ready') value = summaryMessagesFromPreview(preview);
    else if (typeof conversationStore.readConversationWindow === 'function') {
      const page = conversationStore.readConversationWindow(id, { limit: 24 });
      value = page ? projectBotSummaryHistory({ messages: page.window || [] }) : null;
    } else if (preview) value = summaryMessagesFromPreview(preview);
    if (version) {
      entries.set(id, { version, value });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }
    return cloneSummary(value);
  };
}
