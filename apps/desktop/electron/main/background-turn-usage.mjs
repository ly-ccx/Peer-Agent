/**
 * 没有会话 id 的临时回合仍写入请求级用量。
 * 不记进某一条对话的 lifetime，花费上限和用量页读的是同一份请求日志。
 */
export function recordDetachedTurnUsage({ streamRecord, usage, usageRequestLog } = {}) {
  if (!streamRecord || typeof usageRequestLog?.append !== 'function') return null;
  const tokens = Number(usage?.inputTokens || 0)
    + Number(usage?.outputTokens || 0)
    + Number(usage?.cacheReadTokens || 0)
    + Number(usage?.cacheWriteTokens || 0);
  if (!(tokens > 0)) return null;
  const role = streamRecord?.turnProfile?.role;
  const workspaceId = streamRecord?.turnProfile?.workspaceId;
  return usageRequestLog.append({
    id: streamRecord.streamId || undefined,
    conversationId: null,
    streamId: streamRecord.streamId || null,
    modelProviderId: streamRecord.actualModelProviderId || streamRecord.modelProviderId || null,
    model: streamRecord.actualModel || null,
    providerName: streamRecord.actualProviderName || null,
    usage,
    providerRequestCount: usage?.providerRequestCount,
    pricing: streamRecord.actualPricing || {},
    pricingSource: streamRecord.actualPricingSource || null,
    ...(typeof role === 'string' && role.trim() ? { role: role.trim() } : {}),
    ...(typeof workspaceId === 'string' && workspaceId.trim() ? { workspaceId: workspaceId.trim() } : {}),
  });
}
