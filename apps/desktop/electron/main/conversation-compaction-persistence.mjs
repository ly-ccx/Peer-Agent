export function isPendingAssistantMessage(message) {
  return message?.role === 'assistant';
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

  // ⚠️ slice(-keptCount) 陷阱：JS 中 -0 === 0，slice(-0) ≡ slice(0) = 返回整个数组。
  // keptCount 表示 compaction 分界线之后仍作为活跃上下文保留的最近消息数；
  // keptCount<=0 时，所有原始消息都位于分界线之前，仅用于 UI 原文回看。
  const safeKeptCount = Number.isFinite(keptCount) && keptCount > 0 ? Math.floor(keptCount) : 0;
  const compressedSourceMessages = safeKeptCount > 0
    ? activeSourceMessages.slice(0, -safeKeptCount)
    : activeSourceMessages;
  const keptSourceMessages = safeKeptCount > 0
    ? activeSourceMessages.slice(-safeKeptCount)
    : [];

  const persisted = [...compressedSourceMessages];
  for (const message of compactedMessages) {
    if (!message?._compaction) continue;
    persisted.push({
      id: idFactory(),
      role: message.role,
      content: message.content,
      _compaction: message._compaction,
    });
  }

  persisted.push(...keptSourceMessages);
  if (pendingAssistant) persisted.push(pendingAssistant);
  return persisted;
}
