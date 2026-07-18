import type { LlmAuthMethod, LlmSubscriptionQuota } from '@peer-agent/protocol';

/** 订阅额度自动刷新间隔：5 分钟。 */
export const SUBSCRIPTION_QUOTA_REFRESH_MS = 5 * 60 * 1000;

const OAUTH_METHODS = new Set<LlmAuthMethod>(['oauth_chatgpt', 'oauth_google', 'oauth_grok']);

export function isOAuthMethod(method: LlmAuthMethod | undefined | null): boolean {
  return Boolean(method && OAUTH_METHODS.has(method));
}

/** 把 resetsAt 格式化为相对时间（如「12h 后重置」）。与设置页额度文案一致。 */
export function formatResetAt(value: string | undefined, zh: boolean): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const now = Date.now();
  const deltaMs = date.getTime() - now;
  if (deltaMs <= 0) return zh ? '已重置' : 'reset now';
  const hours = Math.round(deltaMs / (60 * 60 * 1000));
  if (hours < 48) return zh ? `${hours}h 后重置` : `resets in ${hours}h`;
  const days = Math.round(hours / 24);
  return zh ? `${days}d 后重置` : `resets in ${days}d`;
}

/**
 * 设置页额度单行文案（含失败态）。
 * 成功时优先 remainingPercent，否则用 100 - usedPercent。
 */
export function formatQuotaLine(quota: LlmSubscriptionQuota | undefined, zh: boolean): string | null {
  if (!quota) return null;
  if (!quota.success) {
    if (quota.status === 'not_logged_in') return zh ? '未登录，无法查询额度' : 'Not logged in';
    if (quota.status === 'session_expired') return zh ? '登录已过期，请重新登录' : 'Session expired — re-login';
    if (quota.status === 'unsupported') return null;
    return zh
      ? (quota.error ? `额度：${quota.error}` : '额度查询失败')
      : (quota.error ? `Quota: ${quota.error}` : 'Quota unavailable');
  }
  const remaining = typeof quota.remainingPercent === 'number'
    ? Math.round(quota.remainingPercent)
    : (typeof quota.usedPercent === 'number' ? Math.round(100 - quota.usedPercent) : null);
  if (remaining == null) return zh ? '额度已更新' : 'Quota updated';
  const reset = formatResetAt(quota.resetsAt, zh);
  const plan = quota.planLabel ? ` · ${quota.planLabel}` : '';
  if (zh) return `剩余 ${remaining}%${plan}${reset ? ` · ${reset}` : ''}`;
  return `${remaining}% left${plan}${reset ? ` · ${reset}` : ''}`;
}

/**
 * 聊天区上下文悬浮层用的额度行。
 * 仅在成功且能算出剩余百分比时展示，避免把失败态塞进用量悬浮层。
 * 例：剩余额度 72% · 12h 后重置
 */
export function formatQuotaTooltipLine(quota: LlmSubscriptionQuota | undefined, zh: boolean): string | null {
  if (!quota?.success) return null;
  const remaining = typeof quota.remainingPercent === 'number'
    ? Math.round(quota.remainingPercent)
    : (typeof quota.usedPercent === 'number' ? Math.round(100 - quota.usedPercent) : null);
  if (remaining == null) return null;
  const reset = formatResetAt(quota.resetsAt, zh);
  if (zh) return `剩余额度 ${remaining}%${reset ? ` · ${reset}` : ''}`;
  return `Usage remaining ${remaining}%${reset ? ` · ${reset}` : ''}`;
}
