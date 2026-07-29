import type { LlmAuthMethod, LlmSubscriptionQuota } from '@peer-agent/protocol';

/** 订阅额度自动刷新间隔：5 分钟。 */
export const SUBSCRIPTION_QUOTA_REFRESH_MS = 5 * 60 * 1000;

const OAUTH_METHODS = new Set<LlmAuthMethod>(['oauth_chatgpt', 'oauth_google', 'oauth_grok']);
const LOCAL_CLI_METHODS = new Set<LlmAuthMethod>(['qoder_local_auth', 'local_cli']);

export function isOAuthMethod(method: LlmAuthMethod | undefined | null): boolean {
  return Boolean(method && OAUTH_METHODS.has(method));
}

export function isLocalCliMethod(method: LlmAuthMethod | undefined | null): boolean {
  return Boolean(method && LOCAL_CLI_METHODS.has(method));
}

/** 支持订阅额度刷新的鉴权方式（OAuth 订阅 + Qoder CLI 本机登录）。 */
export function supportsSubscriptionQuotaMethod(method: LlmAuthMethod | undefined | null): boolean {
  return isOAuthMethod(method) || isLocalCliMethod(method);
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
  const reset = formatResetAt(quota.resetsAt, zh);
  const plan = quota.planLabel ? ` · ${quota.planLabel}` : '';
  const credits = typeof quota.availableCredits === 'number'
    ? (zh ? ` · 可用积分 ${Math.round(quota.availableCredits)}` : ` · ${Math.round(quota.availableCredits)} credits`)
    : '';
  const planCredits = typeof quota.planCreditsUsed === 'number' && typeof quota.planCreditsTotal === 'number'
    ? (zh
      ? ` · 套餐 ${Math.round(quota.planCreditsUsed)}/${Math.round(quota.planCreditsTotal)}`
      : ` · plan ${Math.round(quota.planCreditsUsed)}/${Math.round(quota.planCreditsTotal)}`)
    : '';
  const orgPackage = typeof quota.orgPackageUsed === 'number' && typeof quota.orgPackageCap === 'number'
    ? (zh
      ? ` · 资源包 ${Math.round(quota.orgPackageUsed)}/${Math.round(quota.orgPackageCap)}`
      : ` · package ${Math.round(quota.orgPackageUsed)}/${Math.round(quota.orgPackageCap)}`)
    : '';
  if (remaining == null && !credits && !planCredits && !orgPackage) {
    return zh ? '额度已更新' : 'Quota updated';
  }
  if (remaining == null) {
    const details = `${plan}${credits}${planCredits}${orgPackage}${reset ? ` · ${reset}` : ''}`;
    return zh ? `额度已更新${details}` : `Quota updated${details}`;
  }
  if (zh) return `剩余 ${remaining}%${plan}${credits}${planCredits}${orgPackage}${reset ? ` · ${reset}` : ''}`;
  return `${remaining}% left${plan}${credits}${planCredits}${orgPackage}${reset ? ` · ${reset}` : ''}`;
}

/**
 * 聊天区上下文悬浮层用的额度行。
 * 成功时展示剩余百分比；Qoder 额外附带可用积分 / 套餐 / 资源包。
 * 失败态不进入悬浮层，避免把登录错误塞进用量提示。
 * 例：剩余额度 72% · Teams · 可用积分 26306 · 12h 后重置
 */
export function formatQuotaTooltipLine(quota: LlmSubscriptionQuota | undefined, zh: boolean): string | null {
  if (!quota?.success) return null;
  const remaining = typeof quota.remainingPercent === 'number'
    ? Math.round(quota.remainingPercent)
    : (typeof quota.usedPercent === 'number' ? Math.round(100 - quota.usedPercent) : null);
  const plan = quota.planLabel ? ` · ${quota.planLabel}` : '';
  const credits = typeof quota.availableCredits === 'number'
    ? (zh ? ` · 可用积分 ${Math.round(quota.availableCredits)}` : ` · ${Math.round(quota.availableCredits)} credits`)
    : '';
  const planCredits = typeof quota.planCreditsUsed === 'number' && typeof quota.planCreditsTotal === 'number'
    ? (zh
      ? ` · 套餐 ${Math.round(quota.planCreditsUsed)}/${Math.round(quota.planCreditsTotal)}`
      : ` · plan ${Math.round(quota.planCreditsUsed)}/${Math.round(quota.planCreditsTotal)}`)
    : '';
  const orgPackage = typeof quota.orgPackageUsed === 'number' && typeof quota.orgPackageCap === 'number'
    ? (zh
      ? ` · 资源包 ${Math.round(quota.orgPackageUsed)}/${Math.round(quota.orgPackageCap)}`
      : ` · package ${Math.round(quota.orgPackageUsed)}/${Math.round(quota.orgPackageCap)}`)
    : '';
  const reset = formatResetAt(quota.resetsAt, zh);
  const details = `${plan}${credits}${planCredits}${orgPackage}${reset ? ` · ${reset}` : ''}`;
  if (remaining == null) {
    if (!credits && !planCredits && !orgPackage) return null;
    return zh ? `额度${details}` : `Quota${details}`;
  }
  if (zh) return `剩余额度 ${remaining}%${details}`;
  return `Usage remaining ${remaining}%${details}`;
}
