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

  // ⚠️ slice(-keptCount) 陷阱：JS 中 -0 === 0，slice(-0) ≡ slice(0) = 返回整个数组。
  // 真·全量压缩正常路径 keptCount=0（一条不留），若直接 slice(-0) 会退化为「保留全部旧消息」，
  // 导致压缩落盘后上下文完全没下降。这里用显式守卫：keptCount<=0 时保留 0 条。
  const safeKeptCount = Number.isFinite(keptCount) && keptCount > 0 ? Math.floor(keptCount) : 0;
  if (safeKeptCount > 0) {
    persisted.push(...activeSourceMessages.slice(-safeKeptCount));
  }
  if (pendingAssistant) persisted.push(pendingAssistant);
  return persisted;
}
