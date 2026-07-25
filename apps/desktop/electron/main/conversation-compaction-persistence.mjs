import { CANONICAL_HISTORY_PROJECTOR_VERSION } from '@peer-agent/runtime-core';

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

  // 历史 compaction 是 UI 时间线事实：右侧轨道需要展示每一次压缩，不能在下一次压缩时删除。
  // 但 keptCount 只按非 compaction 原消息计算，因此先用首条活跃尾消息定位新分界线，再把
  // 新 handoff 插回完整时间线。这样旧 handoff 留在原位，同时不会被误算为活跃 API 消息。
  const firstKeptSource = keptSourceMessages[0];
  const insertionIndex = firstKeptSource
    ? sourceWithoutPending.indexOf(firstKeptSource)
    : sourceWithoutPending.length;
  const safeInsertionIndex = insertionIndex >= 0 ? insertionIndex : compressedSourceMessages.length;
  const persisted = sourceWithoutPending.slice(0, safeInsertionIndex);
  for (const message of compactedMessages) {
    if (!message?._compaction) continue;
    persisted.push({
      id: idFactory(),
      role: message.role,
      content: message.content,
      _compaction: message._compaction,
    });
  }

  persisted.push(...sourceWithoutPending.slice(safeInsertionIndex));
  if (pendingAssistant) persisted.push(pendingAssistant);
  return persisted;
}

/**
 * Persist compacted transcript first, then bind the next-request projection to
 * the content revision created by replaceMessages. Keeping both writes here
 * prevents automatic and manual compaction from drifting into separate paths.
 */
export function persistCompactedConversation({
  store,
  conversationId,
  messages,
  requestProjection = null,
  computedAt = new Date().toISOString(),
}) {
  const replaced = store.replaceMessages(conversationId, messages);
  if (!requestProjection) return replaced;

  const snapshotted = store.updateContextSnapshot(conversationId, {
    nextRequestInputTokens: requestProjection.nextRequestInputTokens,
    contextWindow: requestProjection.contextWindow,
    computedAt,
    projectorVersion: CANONICAL_HISTORY_PROJECTOR_VERSION,
    source: 'desktop',
  });
  if (!snapshotted) {
    throw new Error(`Failed to persist compacted context snapshot for ${conversationId}`);
  }
  return snapshotted;
}
