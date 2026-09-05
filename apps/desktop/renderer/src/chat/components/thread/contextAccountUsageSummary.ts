import type { LlmSubscriptionQuota, LlmSubscriptionQuotaWindow } from '@peer-agent/protocol';
import { usageMoney, usageNumber, usageWindows } from '../../../app/components/accountUsagePresentation.ts';

function remainingValue(window: LlmSubscriptionQuotaWindow, zh: boolean): string | undefined {
  const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
  const count = finite(window.remaining) ? window.remaining
    : finite(window.limit) && finite(window.used) ? window.limit - window.used : undefined;
  if (count !== undefined) {
    const value = usageNumber(Math.max(0, count), zh);
    return finite(window.limit) ? `${value} / ${usageNumber(window.limit, zh)}` : value;
  }
  const percent = finite(window.remainingPercent) ? window.remainingPercent
    : finite(window.usedPercent) ? 100 - window.usedPercent : undefined;
  return percent === undefined ? undefined : `${usageNumber(Math.max(0, Math.min(100, percent)), zh)}%`;
}

/** Quick account glance only. Full accounting and explanations stay in Settings. */
export function contextAccountUsageSummary(quota: LlmSubscriptionQuota | undefined, loading: boolean, zh: boolean): string[] {
  const lines: string[] = [];
  if (!quota) return [loading ? (zh ? '账户用量查询中…' : 'Loading account usage…') : (zh ? '账户用量暂不可用' : 'Account usage unavailable')];
  if (quota.balances?.length) lines.push(`${zh ? '剩余余额' : 'Balance remaining'} ${quota.balances.map(b => usageMoney(b.total, b.currency, zh)).join(' · ')}`);
  else if (Number.isFinite(quota.availableCredits)) lines.push(`${zh ? '剩余额度' : 'Credits remaining'} ${usageNumber(quota.availableCredits, zh)}`);
  const windows = usageWindows(quota);
  const isPeriod = (id: string) => /week|month|周|月/i.test(id);
  const primary = windows.find(w => !isPeriod(`${w.id} ${w.label ?? ''}`));
  if (!lines.length && primary) {
    const remaining = remainingValue(primary, zh);
    if (remaining) lines.push(`${zh ? '剩余可用' : 'Allowance remaining'} ${remaining}`);
  }
  const periods = [
    { match: /week|周/i, label: zh ? '本周剩余可用' : 'Weekly remaining' },
    { match: /month|月/i, label: zh ? '本月剩余可用' : 'Monthly remaining' },
  ];
  for (const period of periods) {
    const window = windows.find(w => period.match.test(`${w.id} ${w.label ?? ''}`));
    if (!window) continue;
    const value = remainingValue(window, zh);
    if (value) lines.push(`${period.label} ${value}`);
  }
  if (!lines.length) lines.push(zh ? '账户额度暂不可用' : 'Account allowance unavailable');
  if (quota.stale || !quota.success) lines[0] += zh ? ' · 数据可能已过期' : ' · May be outdated';
  else if (loading) lines[0] += zh ? ' · 更新中' : ' · Updating';
  return lines;
}
