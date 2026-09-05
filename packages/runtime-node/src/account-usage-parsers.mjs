const source = { source: 'api_key', scope: 'subscription' };
const number = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim())) && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined;
const decimal = (v) => typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v) ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined;
const date = (v) => typeof v === 'string' && v.trim() && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined;
const unavailable = (dimension, reason, requiredAuth) => ({ dimension, reason, ...(requiredAuth ? { requiredAuth } : {}) });
function finish(data, missing = []) {
  const success = Boolean(data.balances?.length || data.windows?.length || data.spend?.length);
  return { success, status: success ? 'ok' : 'invalid_response', ...data, unavailable: missing, partial: missing.length > 0 };
}

export function parseDeepSeekBalance(payload) {
  const balances = (Array.isArray(payload.balance_infos) ? payload.balance_infos : []).flatMap((item) => {
    const total = decimal(item?.total_balance);
    if (total === undefined || typeof item?.currency !== 'string' || !/^[A-Z]{3}$/.test(item.currency)) return [];
    return [{ currency: item.currency, total, paid: decimal(item.topped_up_balance), granted: decimal(item.granted_balance), source: 'api_key', scope: 'account' }];
  });
  return finish({ balances }, [unavailable('windows', '详细用量需要 DeepSeek Platform 网页会话', 'web_session'), unavailable('spend', '费用明细需要 DeepSeek Platform 网页会话', 'web_session')]);
}

function kimiWindow(detail, id, label) {
  const limit = number(detail?.limit);
  let used = number(detail?.used);
  let remaining = number(detail?.remaining);
  if (limit === undefined || (used === undefined && remaining === undefined)) return undefined;
  if (used === undefined && remaining <= limit) used = limit - remaining;
  if (remaining === undefined && used !== undefined) remaining = Math.max(0, limit - used);
  return { id, label, limit, used, remaining, ...(limit > 0 && used !== undefined ? { usedPercent: used / limit * 100, remainingPercent: Math.max(0, 100 - used / limit * 100) } : {}), resetsAt: date(detail.resetTime ?? detail.resetAt ?? detail.reset_time ?? detail.reset_at), ...source };
}
export function parseKimiUsage(payload) {
  const windows = [kimiWindow(payload.usage, 'plan', '计划额度')];
  for (const [i, item] of (Array.isArray(payload.limits) ? payload.limits : []).entries()) {
    const units = { TIME_UNIT_MINUTE: '分钟', TIME_UNIT_HOUR: '小时', TIME_UNIT_DAY: '天' };
    const duration = number(item?.window?.duration);
    const unit = units[item?.window?.timeUnit];
    windows.push(kimiWindow(item?.detail, `limit-${i}`, duration && unit ? `${duration} ${unit}` : '附加窗口'));
  }
  return finish({ windows: windows.filter(Boolean) }, [unavailable('balance', '会员池需要独立 Kimi 网页会话', 'web_session'), unavailable('spend', 'Coding Plan 接口不提供现金消费')]);
}

export function parseOpenCodeUsage(payload, now = Date.now()) {
  const windows = [];
  for (const [id, label] of [['rolling', '5 小时'], ['weekly', '每周'], ['monthly', '每月']]) {
    const item = payload.usage?.[id];
    const usedPercent = number(item?.usagePercent ?? item?.usedPercent ?? item?.percentUsed ?? item?.percent ?? item?.usage_percent ?? item?.used_percent ?? item?.utilization ?? item?.utilizationPercent ?? item?.utilization_percent ?? item?.usage);
    if (usedPercent === undefined) continue;
    const seconds = number(item.resetInSec ?? item.resetInSeconds ?? item.resetSeconds ?? item.reset_in_sec);
    const reset = date(item.resetAt ?? item.resetsAt ?? item.reset_at ?? item.resets_at);
    const timestamp = seconds === undefined ? NaN : now + seconds * 1000;
    windows.push({ id, label, usedPercent, remainingPercent: Math.max(0, 100 - usedPercent), resetsAt: reset ?? (Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15 ? new Date(timestamp).toISOString() : undefined), ...source });
  }
  return finish({ windows }, [unavailable('balance', 'Zen 按量余额需要独立 OpenCode 网页会话', 'web_session'), unavailable('spend', 'Go 订阅接口不提供现金消费')]);
}
