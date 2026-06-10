export function isPendingAssistantMessage(message) {
  return (
    message?.role === 'assistant' &&
    String(message?.content ?? '') === '' &&
    (!Array.isArray(message?.segments) || message.segments.length === 0)
  );
}

export function isCompactionMessage(message) {
  return Boolean(message?._compaction);
}

export function buildPersistedCompactedMessages({
  compactedMessages,
  sourceMessages,
  keptCount,
  preservePendingAssistant = false,
  idFactory = () => `compaction-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
}) {
  const pendingAssistant = preservePendingAssistant && isPendingAssistantMessage(sourceMessages.at(-1))
    ? sourceMessages.at(-1)
    : null;
  const sourceWithoutPending = pendingAssistant ? sourceMessages.slice(0, -1) : sourceMessages;
  const activeSourceMessages = sourceWithoutPending.filter((message) => !isCompactionMessage(message));

  const persisted = [];
  for (const message of compactedMessages) {
    if (!message?._compaction) continue;
    persisted.push({
      id: idFactory(),
      role: message.role,
      content: message.content,
      _compaction: message._compaction,
    });
  }

  persisted.push(...activeSourceMessages.slice(-keptCount));
  if (pendingAssistant) persisted.push(pendingAssistant);
  return persisted;
}
