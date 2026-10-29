import { visibleResult } from './session-report.mjs';

/** Preserve report selection and provisional-tail exclusion without retaining tool/thinking bodies. */
export function projectSessionConversationFacts(history) {
  const rows = Array.isArray(history?.messages) ? history.messages : [];
  const worker = rows.findLast(row => row?.role === 'assistant' && !row._compaction && visibleResult(row));
  return { createdAt: history?.createdAt || '',
    messages: worker ? [{ id: worker.id, role: 'assistant', content: visibleResult(worker) }] : [],
    interventions: rows.filter(row => typeof row?.answerTo === 'string' && row.answerTo && row.id).map(row => ({ id: row.id })),
  };
}

export function createSessionConversationFacts(conversationStore) {
  if (typeof conversationStore.createHistoryProjection === 'function') return conversationStore.createHistoryProjection(projectSessionConversationFacts, { immutableInput: true });
  return id => projectSessionConversationFacts({ ...conversationStore.getPersistedConversationHistory?.(id),
    createdAt: conversationStore.getConversation?.(id)?.createdAt });
}
