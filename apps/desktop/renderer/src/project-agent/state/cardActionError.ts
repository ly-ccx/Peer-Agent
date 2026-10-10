import type { TranslationKey } from '@peer-agent/i18n';

export function cardActionErrorKey(code?: string): TranslationKey {
  if (['session_not_completed', 'stale_completion_review', 'not_confirmable', 'NOT_CONFIRMABLE'].includes(code || '')) return 'projectAgent.chat.resultChanged';
  if (code === 'EXECUTION_OUTCOME_UNKNOWN' || code === 'CHECKPOINT_PERSISTENCE_FAILED') return 'projectAgent.chat.recoveryUnknownOutcome';
  if (code === 'STALE_TURN' || code === 'WORK_NOT_RECOVERABLE' || code === 'RECOVERY_RESERVATION_CHANGED') return 'projectAgent.chat.recoveryStale';
  if (code === 'NO_CONTINUATION_CHECKPOINT' || code === 'RECOVERY_CHECKPOINT_UNAVAILABLE' || code === 'PROVIDER_CHECKPOINT_MISMATCH') return 'projectAgent.chat.recoveryMissingCheckpoint';
  if (code === 'WORK_BUDGET_LIMITED' || code === 'WORK_BUDGET_EXHAUSTED') return 'projectAgent.chat.budgetExhausted';
  return 'projectAgent.chat.actionFailed';
}
