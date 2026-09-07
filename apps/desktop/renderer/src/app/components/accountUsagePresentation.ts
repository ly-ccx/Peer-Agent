import type { LlmSubscriptionQuota, LlmSubscriptionQuotaWindow } from '@peer-agent/protocol';

const locale = (zh: boolean) => zh ? 'zh-CN' : 'en-US';
export function usageNumber(value: number | undefined, zh: boolean, compact = false): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(locale(zh), compact ? { notation: 'compact', maximumFractionDigits: 2 } : { maximumFractionDigits: 2 }).format(value);
}

/** Vendor decimal strings stay exact; only locally estimated prices are rounded. */
export function usageMoney(value: string | number, currency: string, zh: boolean): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (value > 0 && value < 0.01) return `${currency} <0.01`;
    return `${currency} ${new Intl.NumberFormat(locale(zh), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return `${currency} ${value}`;
  const [whole, fraction = ''] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${grouped}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

export function usageTime(value: string | undefined, zh: boolean, full = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat(locale(zh), {
    ...(full ? { year: 'numeric', timeZoneName: 'short' } as const : {}),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

const scopes: Record<string, [string, string]> = {
  account: ['账户', 'Account'], subscription: ['订阅', 'Subscription'], organization: ['组织', 'Organization'], api_key: ['当前密钥', 'Current key'], local_only: ['本地统计', 'Local usage'],
};
const sources: Record<string, [string, string]> = {
  api_key: ['API 查询', 'API'], oauth: ['订阅授权', 'OAuth'], cli: ['本机 CLI', 'Local CLI'], local: ['本地记录', 'Local records'],
};
export function usageScope(scope: string | undefined, zh: boolean) { return scopes[scope ?? '']?.[zh ? 0 : 1] ?? (zh ? '厂商数据' : 'Vendor data'); }
export function usageSource(source: string | undefined, zh: boolean) { return sources[source ?? '']?.[zh ? 0 : 1] ?? (zh ? '厂商查询' : 'Vendor query'); }
export function usageDimension(dimension: string, zh: boolean) {
  return ({ balance: ['余额', 'Balance'], windows: ['用量额度', 'Allowance'], spend: ['消费', 'Spend'] } as Record<string, string[]>)[dimension]?.[zh ? 0 : 1] ?? (zh ? '数据' : 'Data');
}
export function usageAuth(auth: string, zh: boolean) {
  return ({ admin_key: ['需要管理密钥', 'Admin key required'], web_session: ['需要网页登录', 'Web login required'], cli_login: ['需要 CLI 登录', 'CLI login required'], oauth: ['需要订阅授权', 'OAuth required'], coding_plan_key: ['需要计划专用密钥', 'Plan key required'] } as Record<string, string[]>)[auth]?.[zh ? 0 : 1] ?? '';
}
export function usagePeriod(period: string, zh: boolean) {
  return ({ today: ['今日', 'Today'], week: ['本周', 'This week'], month: ['本月', 'This month'], total: ['累计', 'Total'] } as Record<string, string[]>)[period]?.[zh ? 0 : 1] ?? '';
}
export function usageFailure(status: string | undefined, zh: boolean) {
  const messages: Record<string, [string, string]> = {
    unsupported: ['当前凭据无法查询厂商账户数据', 'No vendor account data for this credential'],
    missing_credential: ['请先配置查询凭据', 'Configure a credential to query'],
    auth_required: ['认证失败或权限不足，请检查登录状态', 'Check your login or account permissions'],
    not_logged_in: ['请先登录订阅账户', 'Sign in to your subscription first'],
    endpoint_not_supported: ['自定义端点不支持官方账户查询', 'Custom endpoints cannot use the official account API'],
    timeout: ['查询超时，请稍后重试', 'Request timed out. Try again'],
    invalid_response: ['厂商数据暂时无法解析，请稍后重试', 'Vendor response could not be read. Try again'],
    account_changed: ['账户已变更，请重新查询', 'Account changed. Query again'],
  };
  return messages[status ?? '']?.[zh ? 0 : 1] ?? (zh ? '厂商数据暂不可用，请稍后重试' : 'Vendor data unavailable. Try again');
}

export function usageWindow(window: LlmSubscriptionQuotaWindow, zh: boolean) {
  const finite = (n: number | undefined) => n !== undefined && Number.isFinite(n) ? n : undefined;
  const used = finite(window.usedPercent) ?? (finite(window.remainingPercent) !== undefined ? 100 - window.remainingPercent! : undefined)
    ?? (window.limit && window.limit > 0 && finite(window.used) !== undefined ? window.used! / window.limit * 100 : undefined);
  const units: Record<string, [string, string]> = { requests: ['次', 'requests'], tokens: ['tokens', 'tokens'], credits: ['点', 'credits'], currency: ['金额单位', 'currency units'] };
  const unit = units[window.unit ?? '']?.[zh ? 0 : 1] ?? '';
  return {
    percent: used === undefined ? undefined : Math.min(100, Math.max(0, used)),
    text: used === undefined ? (zh ? '暂无比例' : 'No percentage') : `${usageNumber(used, zh)}%`,
    tone: used !== undefined && used >= 90 ? 'high' : 'normal',
    counts: window.used !== undefined && window.limit !== undefined ? `${usageNumber(window.used, zh)} / ${usageNumber(window.limit, zh)} ${unit}`.trim() : undefined,
    remaining: window.remaining !== undefined ? `${zh ? '剩余' : 'Remaining'} ${usageNumber(window.remaining, zh)} ${unit}`.trim() : undefined,
  };
}

/** Preserve old OAuth/CLI observations without duplicating the same top-level percent. */
export function usageWindows(quota: LlmSubscriptionQuota | undefined): readonly LlmSubscriptionQuotaWindow[] {
  if (!quota) return [];
  const windows = [...(quota.windows ?? [])];
  if (!windows.length && (quota.usedPercent !== undefined || quota.remainingPercent !== undefined)) windows.push({ id: 'subscription', label: quota.planLabel, usedPercent: quota.usedPercent, remainingPercent: quota.remainingPercent, resetsAt: quota.resetsAt, scope: 'subscription' });
  return windows;
}
export function usageLegacyMetrics(quota: LlmSubscriptionQuota | undefined, zh: boolean) {
  if (!quota) return [];
  const metrics: { label: string; value: string }[] = [];
  if (quota.availableCredits !== undefined) metrics.push({ label: zh ? '可用积分' : 'Available credits', value: usageNumber(quota.availableCredits, zh) });
  if (quota.planCreditsUsed !== undefined || quota.planCreditsTotal !== undefined) metrics.push({ label: zh ? '套餐积分' : 'Plan credits', value: `${usageNumber(quota.planCreditsUsed, zh)} / ${usageNumber(quota.planCreditsTotal, zh)}` });
  if (quota.orgPackageUsed !== undefined || quota.orgPackageCap !== undefined) metrics.push({ label: zh ? '资源包' : 'Resource package', value: `${usageNumber(quota.orgPackageUsed, zh)} / ${usageNumber(quota.orgPackageCap, zh)}` });
  return metrics;
}
