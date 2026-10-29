import type { ProjectReplyRecoveryAction } from '@peer-agent/protocol';
import type { TranslationKey } from '@peer-agent/i18n';

export function readReplyRecoveryAction(value: unknown): ProjectReplyRecoveryAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.canContinue !== 'boolean') return undefined;
  let budget: ProjectReplyRecoveryAction['budget'];
  if (row.budget && typeof row.budget === 'object') {
    const item = row.budget as Record<string, unknown>;
    if (['modelRequests', 'toolCalls', 'tokens', 'costUsd'].includes(String(item.metric))
      && (item.used === null || typeof item.used === 'number' && Number.isFinite(item.used) && item.used >= 0)
      && typeof item.limit === 'number' && Number.isFinite(item.limit) && item.limit >= 0
      && typeof item.source === 'string' && item.source.length < 200
      && ['limit_reached', 'usage_unknown', 'reservation_pending'].includes(String(item.reason))) {
      budget = item as unknown as ProjectReplyRecoveryAction['budget'];
    }
  }
  return { canContinue: row.canContinue,
    ...(typeof row.blockedReason === 'string' ? { blockedReason: row.blockedReason.slice(0, 200) } : {}),
    ...(budget ? { budget } : {}) };
}

export function budgetFailureDetail(action?: ProjectReplyRecoveryAction): { key: TranslationKey; sourceKey: TranslationKey; params?: Record<string, string | number> } | null {
  const budget = action?.budget;
  if (!budget) return null;
  const sourceKey = budget.source === 'settings:execution-budget' ? 'projectAgent.chat.budgetSourceSettings' : 'projectAgent.chat.budgetSourceStored';
  if (budget.reason === 'usage_unknown') return { key: budget.metric === 'costUsd' ? 'projectAgent.chat.budgetCostUnknown'
    : budget.metric === 'tokens' ? 'projectAgent.chat.budgetTokensUnknown' : 'projectAgent.chat.budgetUsageUnknown',
    sourceKey, params: { limit: budget.limit } };
  const metricKeys = { modelRequests: 'projectAgent.chat.budgetRequests', toolCalls: 'projectAgent.chat.budgetTools',
    tokens: 'projectAgent.chat.budgetTokens', costUsd: 'projectAgent.chat.budgetCost' } as const;
  return { key: metricKeys[budget.metric], sourceKey, params: { used: budget.used ?? '—', limit: budget.limit } };
}
