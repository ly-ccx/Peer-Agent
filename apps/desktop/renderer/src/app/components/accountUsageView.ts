import type { LlmSubscriptionQuota } from '@peer-agent/protocol';
import { formatQuotaLine } from './llmSubscriptionQuota.ts';

export function accountUsageLines(quota: LlmSubscriptionQuota | undefined, zh: boolean): string[] {
  if (!quota) return [];
  const lines: string[] = [];
  if (quota.stale) lines.push(zh ? '数据已过期，请刷新' : 'Stale data — refresh required');
  if (!quota.success) {
    const messages: Record<string, [string, string]> = {
      unsupported: ['当前凭据没有已接通的厂商数据源', 'No vendor data source for this credential'],
      missing_credential: ['缺少查询凭据', 'Missing credential'],
      auth_required: ['认证失败或权限不足', 'Authentication or permission required'],
      endpoint_not_supported: ['自定义端点不允许使用官方账户接口', 'Custom endpoint cannot use the official account API'],
      timeout: ['厂商查询超时', 'Vendor request timed out'],
      invalid_response: ['厂商返回的数据无法解析', 'Invalid vendor response'],
    };
    lines.push(messages[quota.status ?? '']?.[zh ? 0 : 1] ?? (zh ? '厂商数据暂不可用' : 'Vendor data unavailable'));
  }
  for (const b of quota.balances ?? []) {
    lines.push(`${zh ? '余额' : 'Balance'} · ${b.currency} ${b.total} · ${b.scope} / ${b.source}`);
    if (b.paid !== undefined) lines.push(`${zh ? '充值' : 'Paid'}: ${b.currency} ${b.paid}`);
    if (b.granted !== undefined) lines.push(`${zh ? '赠送' : 'Granted'}: ${b.currency} ${b.granted}`);
  }
  for (const w of quota.windows ?? []) {
    const values: string[] = [];
    if (w.used !== undefined && w.limit !== undefined) values.push(`${w.used} / ${w.limit}${w.unit ? ` ${w.unit}` : ''}`);
    if (w.usedPercent !== undefined) values.push(`${w.usedPercent.toFixed(1)}% ${zh ? '已用' : 'used'}`);
    else if (w.remainingPercent !== undefined) values.push(`${w.remainingPercent.toFixed(1)}% ${zh ? '剩余' : 'left'}`);
    if (w.remaining !== undefined) values.push(`${zh ? '剩余' : 'remaining'} ${w.remaining}`);
    if (w.resetsAt) values.push(`${zh ? '重置' : 'resets'} ${w.resetsAt}`);
    lines.push(`${w.label ?? w.id}: ${values.join(' · ') || (zh ? '数值不可用' : 'No value')} · ${w.scope ?? 'subscription'} / ${w.source ?? quota.authMethod ?? '—'}`);
  }
  for (const s of quota.spend ?? []) lines.push(`${s.period}: ${s.currency} ${s.amount} · ${s.scope} / ${s.source}`);
  // Preserve Qoder points and legacy top-level quota values.
  if (quota.success && (quota.availableCredits !== undefined || quota.remainingPercent !== undefined || quota.planCreditsTotal !== undefined || (!(quota.windows?.length) && !quota.balances?.length && !quota.spend?.length))) {
    const legacy = formatQuotaLine(quota, zh);
    if (legacy) lines.push(legacy);
  }
  for (const item of quota.unavailable ?? []) lines.push(`${item.dimension}: ${item.reason}${item.requiredAuth ? ` (${item.requiredAuth})` : ''}`);
  if (quota.fetchedAt) lines.push(`${zh ? '厂商数据更新时间' : 'Vendor data fetched'}: ${quota.fetchedAt}`);
  const local = quota.localUsage;
  if (local) {
    lines.push(zh ? 'Peer Agent 本地统计（非账户总账）' : 'Peer Agent local usage (not account billing)');
    lines.push(`${local.requests} ${zh ? '请求' : 'requests'} · ${local.inputTokens} input / ${local.outputTokens} output tokens · ${local.cacheReadTokens ?? 0} cache read / ${local.cacheWriteTokens ?? 0} cache write`);
    if (local.estimatedCostUsd !== undefined) lines.push(`${zh ? '估算费用' : 'Estimated cost'}: USD ${local.estimatedCostUsd}`);
    if (local.from || local.to) lines.push(`${local.from ?? '—'} → ${local.to ?? '—'}`);
    lines.push(local.note);
  }
  return lines;
}
