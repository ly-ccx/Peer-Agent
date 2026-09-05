// Endpoint/field semantics cross-checked against CodexBar (MIT), MoonshotUsageFetcher.swift
// and Resources/Plugins/openrouter.js. This module does not use browser sessions or activity APIs.
const account = { source: 'api_key', scope: 'account' };
const keyScope = { source: 'api_key', scope: 'api_key' };
const missing = (dimension, reason) => ({ dimension, reason });
const invalid = () => ({ success: false, status: 'invalid_response' });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const decimal = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  return typeof value === 'string' && value.length <= 256 && /^-?\d+(?:\.\d+)?$/.test(value) ? value : undefined;
};
const nonnegative = (value) => {
  const text = decimal(value);
  return text !== undefined && Number.isFinite(Number(text)) && Number(text) >= 0 ? text : undefined;
};

// Exact decimal subtraction for monetary strings; avoid 0.3 - 0.2 floating-point artifacts.
export function subtractAccountAmounts(left, right) {
  const parts = [left, right].map((value) => {
    const text = decimal(value);
    if (text === undefined || !/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
    const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
    return { sign: text.startsWith('-') ? -1n : 1n, whole, fraction };
  });
  if (parts.some((part) => !part)) return undefined;
  const scale = Math.max(...parts.map((part) => part.fraction.length));
  const values = parts.map((part) => part.sign * BigInt(part.whole + part.fraction.padEnd(scale, '0')));
  const difference = values[0] - values[1];
  const digits = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, '0');
  const magnitude = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits;
  return `${difference < 0n ? '-' : ''}${magnitude}`;
}

export function parseMoonshotBalance(payload) {
  if (payload?.code !== 0 || payload?.status !== true || !object(payload.data)) return invalid();
  const total = decimal(payload.data.available_balance);
  if (total === undefined) return invalid();
  // The API and reference parser do not carry currency. Never label the CN balance USD
  // merely because the reference app's formatter hard-codes a dollar sign.
  return {
    success: true, status: 'ok', partial: true,
    balances: [{ currency: '未标明币种', total, paid: decimal(payload.data.cash_balance), granted: decimal(payload.data.voucher_balance), ...account }],
    unavailable: [missing('windows', '余额接口不提供用量窗口；金额按账户原始单位显示，接口未返回币种'), missing('spend', '余额接口不提供账户消费明细')],
  };
}

export function parseOpenRouterCredits(payload) {
  const credits = nonnegative(payload?.data?.total_credits);
  const usage = nonnegative(payload?.data?.total_usage);
  if (credits === undefined || usage === undefined) return invalid();
  const total = subtractAccountAmounts(credits, usage);
  if (total === undefined) return invalid();
  return { success: true, status: 'ok', balances: [{ currency: 'USD', total, ...account }], spend: [{ period: 'total', amount: usage, currency: 'USD', ...account }] };
}

export function parseOpenRouterKey(payload) {
  const data = payload?.data;
  if (!object(data)) return invalid();
  const spend = [['usage', 'total'], ['usage_daily', 'today'], ['usage_weekly', 'week'], ['usage_monthly', 'month']].flatMap(([field, period]) => {
    const amount = nonnegative(data[field]);
    return amount === undefined ? [] : [{ period, amount, currency: 'USD', ...keyScope }];
  });
  const windows = [];
  const unavailable = [];
  const limit = nonnegative(data.limit);
  const reset = { daily: ['usage_daily', '日'], weekly: ['usage_weekly', '周'], monthly: ['usage_monthly', '月'] }[data.limit_reset];
  const reportedRemaining = nonnegative(data.limit_remaining);
  const consumed = nonnegative(data[reset?.[0] ?? 'usage']);
  if (limit !== undefined && (reportedRemaining !== undefined || consumed !== undefined)) {
    const remaining = reportedRemaining === undefined ? Math.max(0, Number(limit) - Number(consumed)) : Number(reportedRemaining);
    const used = reportedRemaining === undefined ? Number(consumed) : Math.max(0, Number(limit) - remaining);
    windows.push({ id: 'openrouter-key', label: `Key ${reset?.[1] ?? '累计'}限额（USD）`, limit: Number(limit), used, remaining, unit: 'credits',
      ...(Number(limit) > 0 ? { usedPercent: used / Number(limit) * 100, remainingPercent: Math.max(0, 100 - used / Number(limit) * 100) } : {}), ...keyScope });
  } else {
    unavailable.push(missing('windows', data.limit === null ? '当前 Key 未设置消费限额（不等于账户余额无限）' : 'Key 接口未返回完整限额数据'));
  }
  const success = spend.length > 0 || windows.length > 0 || data.limit === null;
  return { success, status: success ? 'ok' : 'invalid_response', spend, windows, unavailable };
}

export async function queryOpenRouterUsage(query) {
  const results = await Promise.all([
    query('/api/v1/credits').then((result) => ({ ...result, parsed: result.success ? parseOpenRouterCredits(result.data) : result })),
    query('/api/v1/key').then((result) => ({ ...result, parsed: result.success ? parseOpenRouterKey(result.data) : result })),
  ]);
  const [credits, key] = results.map((result) => result.parsed);
  const success = results.some((result) => result.parsed.success);
  if (!success) return { success: false, status: results.find((result) => !result.success)?.status ?? 'invalid_response' };
  const unavailable = [...(key.unavailable ?? [])];
  if (!credits.success) unavailable.push(missing('balance', '账户余额接口不可用；已保留能取得的 Key 数据'));
  if (!key.success) unavailable.push(missing('windows', 'Key 限额接口不可用'), missing('spend', 'Key 消费接口不可用；账户累计消费不代表当前 Key 消费'));
  return {
    success: true, status: 'ok', partial: unavailable.length > 0,
    balances: credits.balances ?? [], windows: key.windows ?? [], spend: [...(credits.spend ?? []), ...(key.spend ?? [])], unavailable,
    // A partial cached result must not look newer than its oldest successful observation.
    fetchedAt: new Date(Math.min(...results.filter((result) => result.parsed.success).map((result) => result.fetchedAt))).toISOString(),
  };
}
