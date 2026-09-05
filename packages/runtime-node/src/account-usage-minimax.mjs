// Field semantics checked against CodexBar's MiniMaxModelRemains / API-token parser (MIT).
const source = { source: 'api_key', scope: 'subscription' };
const number = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined;
const field = (row, name) => row?.[name] ?? row?.[name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())];
const epoch = (value) => {
  const raw = number(value);
  const ms = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : undefined;
  return ms !== undefined && ms <= 8.64e15 ? new Date(ms).toISOString() : undefined;
};
const label = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : '';

export function parseMiniMaxUsage(payload, now = Date.now()) {
  const data = payload?.data ?? payload;
  for (const row of [payload, data]) {
    const base = field(row, 'base_resp');
    if (base && number(field(base, 'status_code')) !== 0) return { success: false, status: 'auth_required' };
  }
  const windows = [];
  const unavailable = [
    { dimension: 'balance', reason: 'Token/Coding Plan 接口不提供现金余额' },
    { dimension: 'spend', reason: 'Token/Coding Plan 接口不提供现金消费' },
  ];
  let observedUnlimited = false;
  const models = field(data, 'model_remains');
  for (const [index, row] of (Array.isArray(models) ? models : []).entries()) {
    const service = label(field(row, 'model_name')) || `服务 ${index + 1}`;
    for (const weekly of [false, true]) {
      const prefix = weekly ? 'current_weekly' : 'current_interval';
      const total = number(field(row, `${prefix}_total_count`));
      // Despite the name, the API's usage_count represents remaining allowance.
      const remaining = number(field(row, `${prefix}_usage_count`));
      const percent = number(field(row, `${prefix}_remaining_percent`));
      const status = number(field(row, `${prefix}_status`));
      if (status === 3 && weekly && ['text generation', 'general'].includes(service.toLowerCase()) && percent >= 100) {
        observedUnlimited = true;
        unavailable.push({ dimension: 'windows', reason: `${service} 周额度不限量；不构造虚假的 0/0 限额` });
        continue;
      }
      if (status === 3 && (total ?? 0) <= 0 && (remaining ?? 0) <= 0 && percent >= 100) continue;
      const end = epoch(field(row, weekly ? 'weekly_end_time' : 'end_time'));
      const remainsMs = number(field(row, weekly ? 'weekly_remains_time' : 'remains_time'));
      const relativeReset = remainsMs > 0 && now + remainsMs <= 8.64e15 ? new Date(now + remainsMs).toISOString() : undefined;
      const window = { id: `minimax-${index}-${weekly ? 'week' : 'interval'}`, label: `${service} · ${weekly ? '周' : '当前窗口'}`, resetsAt: end ?? relativeReset, ...source };
      if (percent !== undefined && percent <= 100) {
        // Percent-only Token Plan observations are not synthetic request counts.
        windows.push({ ...window, usedPercent: 100 - percent, remainingPercent: percent });
      } else if (total > 0 && remaining !== undefined) {
        const used = Math.max(0, total - remaining);
        windows.push({ ...window, limit: total, remaining, used, usedPercent: used / total * 100, remainingPercent: Math.min(100, remaining / total * 100) });
      }
    }
  }
  if (!windows.length && !observedUnlimited && Array.isArray(data?.services)) {
    for (const [index, row] of data.services.entries()) {
      const used = number(field(row, 'usage'));
      const limit = number(field(row, 'limit'));
      if (used === undefined || !(limit > 0)) continue;
      windows.push({ id: `minimax-service-${index}`, label: `${label(field(row, 'service_type')) || '服务'} · ${label(field(row, 'window_type')) || '当前窗口'}`, used, limit, remaining: Math.max(0, limit - used), usedPercent: used / limit * 100, ...source });
    }
  }
  const success = windows.length > 0 || observedUnlimited;
  if (!success) unavailable.push({ dimension: 'windows', reason: '当前凭据未返回可用计划额度；普通推理 Key 不保证支持', requiredAuth: 'coding_plan_key' });
  return { success, status: success ? 'ok' : 'invalid_response', windows, unavailable, partial: true };
}

export async function queryMiniMaxUsage(query) {
  let result;
  for (const path of ['/v1/token_plan/remains', '/v1/api/openplatform/coding_plan/remains']) {
    const response = await query(path);
    result = response.success ? { ...parseMiniMaxUsage(response.data, response.fetchedAt), fetchedAt: new Date(response.fetchedAt).toISOString() } : response;
    if (result.success || !['auth_required', 'invalid_response', 'fetch_failed'].includes(result.status)) return result;
  }
  return { ...result, unavailable: result.unavailable ?? [{ dimension: 'windows', reason: '当前 Key 无法读取计划额度；请确认是本区域 Token/Coding Plan Key', requiredAuth: 'coding_plan_key' }] };
}
