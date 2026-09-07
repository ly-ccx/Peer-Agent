/** GLM personal Coding Plan quota; region routing belongs to the adapter registry. */
export function parseGlmUsage(payload, now = Date.now()) {
  const windows = [];
  if (payload?.success === true && payload.code === 200 && Array.isArray(payload.data?.limits)) {
    for (const [index, item] of payload.data.limits.entries()) {
      if (!item || !['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(item.type)
        || !Number.isInteger(item.percentage)) continue;
      const count = (v) => Number.isSafeInteger(v) && v >= 0 ? v : undefined;
      const limit = count(item.usage);
      const current = count(item.currentValue);
      const remaining = count(item.remaining);
      const used = limit !== undefined && remaining !== undefined
        ? Math.max(0, limit - remaining, current ?? 0) : current;
      const usedPercent = Math.max(0, Math.min(100, limit > 0 && used !== undefined ? used / limit * 100 : item.percentage));
      const units = { 1: ['天', 1440], 3: ['小时', 60], 5: ['分钟', 1], 6: ['周', 10080] };
      const duration = count(item.number);
      const unit = units[item.unit];
      const minutes = duration && unit ? duration * unit[1] : undefined;
      const isMcp = item.type === 'TIME_LIMIT';
      const reset = count(item.nextResetTime);
      const plausible = reset !== undefined && reset <= 8.64e15 && (isMcp || minutes !== 300 || reset <= now + 18_060_000);
      windows.push({ id: `glm-${index}`, label: isMcp ? 'MCP 额度' : duration && unit ? `${duration} ${unit[0]}` : '计划额度',
        usedPercent, remainingPercent: 100 - usedPercent, limit, used, remaining,
        resetsAt: plausible ? new Date(reset).toISOString() : undefined,
        source: 'api_key', scope: 'subscription' });
    }
  }
  return { success: windows.length > 0, status: windows.length ? 'ok' : 'invalid_response', windows, partial: true,
    unavailable: [{ dimension: 'balance', reason: 'Coding Plan 额度不是现金余额' }, { dimension: 'spend', reason: '当前查询不包含费用明细' }] };
}
