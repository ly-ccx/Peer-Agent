/** Aggregate retained runtime-turn observations, not the vendor account ledger. */
export function aggregateAccountLocalUsage(provider, providers, rows) {
  const group = provider.groupId || provider.id;
  const index = new Map(providers.map((item) => [item.id, item.groupId || item.id]));
  const count = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
  const result = { source: 'local', scope: 'local_only', requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let cost = 0;
  let priced = 0;
  let matched = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = row.modelProviderId;
    const rowGroup = row.groupId || index.get(id) || (typeof id === 'string' && id.includes('::') ? id.split('::')[0] : id);
    if (rowGroup !== group) continue;
    matched++;
    result.requests += Number.isSafeInteger(row.providerRequestCount) && row.providerRequestCount > 0 ? row.providerRequestCount : 1;
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) result[key] += count(row[key]);
    if (typeof row.estimatedCostUsd === 'number' && Number.isFinite(row.estimatedCostUsd) && row.estimatedCostUsd >= 0) { cost += row.estimatedCostUsd; priced++; }
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
    if (Number.isFinite(at)) { first = Math.min(first, at); last = Math.max(last, at); }
  }
  // A partially priced sum would look deceptively like the full estimated cost.
  if (matched > 0 && priced === matched) result.estimatedCostUsd = cost;
  if (Number.isFinite(first)) result.from = new Date(first).toISOString();
  if (Number.isFinite(last)) result.to = new Date(last).toISOString();
  result.note = `仅统计本次读取的日志中通过 Peer Agent 发出的用量（默认最多最近 5000 条全渠道记录），不代表完整历史或厂商账户总账；渠道换账号前的历史记录仍可能包含在内。${matched === 0 ? '没有匹配记录，不代表账户没有消费。' : priced < matched ? '部分记录缺少价格，未显示费用合计。' : '费用为本地估算。'}`;
  return result;
}

export function attachAccountLocalUsage(snapshot, provider, providers, rows) {
  return { ...snapshot, localUsage: aggregateAccountLocalUsage(provider, providers, rows) };
}
