/** Explicit host facts for renderer acceptance. No model or user settings are changed. */
export function seedWorkBudgetMessages(messages, workspaceId) {
  const cases = [
    { index: 9997, key: 'exhausted', action: { canContinue: false, blockedReason: 'WORK_BUDGET_EXHAUSTED',
      budget: { metric: 'modelRequests', used: 256, limit: 256, source: 'settings:execution-budget', reason: 'limit_reached' } } },
    { index: 9960, key: 'unknown', action: { canContinue: false, blockedReason: 'WORK_BUDGET_EXHAUSTED',
      budget: { metric: 'costUsd', used: null, limit: 10, source: 'settings:execution-budget', reason: 'usage_unknown' } } },
    { index: 9961, key: 'ready', action: { canContinue: true } },
    { index: 9962, key: 'migrating', phase: 'retrying', action: { canContinue: true } },
    { index: 9958, key: 'reserved', action: { canContinue: false, blockedReason: 'WORK_BUDGET_EXHAUSTED',
      budget: { metric: 'costUsd', used: 3, limit: 10, source: 'settings:execution-budget', reason: 'reservation_pending' } } },
    { index: 9959, key: 'available', action: { canContinue: true,
      budget: { metric: 'costUsd', used: 3, limit: 10, source: 'settings:execution-budget', reason: 'reservation_pending' } } },
  ];
  for (const item of cases) {
    const turnId = `rc-budget-${item.key}`, content = '代理暂时不可用：work_budget_limited';
    // Like the other presentation fixtures, these carry supplied host facts rather
    // than asking the live projector to resolve a nonexistent coordination work.
    messages[item.index] = { ...messages[item.index], role: 'assistant', kind: 'system_card', turnId, content,
      cards: [{ cardId: `rc-recovery-budget-${item.key}`, kind: 'agent_unavailable', content, recoveryAction: item.action,
        failureStatus: { phase: item.phase || 'current', turnKind: 'wake', activeSessionIds: [] },
        recoveryWorkState: item.phase ? 'runnable' : 'budget_limited',
        recovery: { failureKind: 'budget_exhausted', retryable: false, autoAttempts: 0, failedTurnId: turnId },
        actions: [{ id: 'retry', channel: 'project-agent:retry', payload: { workspaceId, turnId } }] }] };
  }
}

export const BUDGET_RECOVERY_CASES = [
  ['budget-unknown', 9960, '暂时无法确认能否在配置的预算内继续，已有进展已保留。', false],
  ['budget-ready', 9961, '预算限制已调整，可以接着已有进展继续。', true],
  ['budget-migrating', 9962, '已安排继续主 Bot 的回复。', false],
  ['budget-reserved', 9958, '预算暂由另一项执行占用，已有进展已保留。', false],
  ['budget-available', 9959, '预算占用已释放，可以接着已有进展继续。', true],
];
