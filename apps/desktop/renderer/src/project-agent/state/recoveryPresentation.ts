import type { TranslationKey } from '@peer-agent/i18n';
import { classifyProjectAgentFailure, type ProjectRecoveryFailureKind } from '@peer-agent/protocol';
import type { BotChatCard } from './botConversationState';

/** Only explicit host retirement removes action feedback; pending work stays actionable. */
export function isRetiredRecovery(cards: readonly BotChatCard[]): boolean {
  return cards.length > 0 && cards.every(card => card.kind === 'agent_unavailable' && card.resolvedState === 'resolved'
    && (!card.failureStatus || ['superseded', 'recovered'].includes(card.failureStatus.phase)));
}

/** Current host projection, never a local retry scheduler or a promise inferred from prose. */
export function agentFailurePresentation(card: BotChatCard): { messageKey: TranslationKey; recovering: boolean; retryAllowed: boolean } {
  const failure = classifyProjectAgentFailure(card.content, card.recovery ? { kind: card.recovery.failureKind, retryable: card.recovery.retryable } : undefined);
  const phaseKeys = { recovered: 'projectAgent.chat.recoveryEnded', superseded: 'projectAgent.chat.recoveryEarlierReply',
    cancelled: 'projectAgent.chat.recoveryCancelled', paused: 'projectAgent.chat.recoveryPaused', retrying: 'projectAgent.chat.recoveryContinuing' } as const;
  const phase = card.failureStatus?.phase;
  if (phase && phase !== 'current') return { messageKey: phaseKeys[phase], recovering: phase === 'retrying', retryAllowed: false };
  if (!phase && card.resolvedState === 'resolved') return { messageKey: 'projectAgent.chat.recoveryEarlierReply', recovering: false, retryAllowed: false };
  if (card.recovery?.blockedCode === 'RECOVERY_CHECKPOINT_UNAVAILABLE') {
    return { messageKey: 'projectAgent.chat.recoveryMissingCheckpoint', recovering: false, retryAllowed: false };
  }
  const continuing = Boolean(card.recovery) && card.recoveryWorkState === 'runnable'
    && failure.kind !== 'execution_outcome_unknown' && failure.kind !== 'cancelled';
  if (continuing) return { messageKey: 'projectAgent.chat.recoveryContinuing', recovering: true, retryAllowed: false };
  const recovering = failure.retryable && card.recoveryWorkState === 'retry_wait'
    && Boolean(card.recovery?.reservationId && card.recovery.retryAt);
  if (recovering) return { messageKey: 'projectAgent.chat.recoveryScheduled', recovering: true, retryAllowed: false };
  if (failure.kind === 'fatal' && /\bcontinuity_model_changed\b/.test(card.content)) return { messageKey: 'projectAgent.chat.recoveryModelChanged', recovering: false, retryAllowed: false };
  if (failure.kind === 'fatal' && /\bempty_model_response\b/.test(card.content)) return { messageKey: 'projectAgent.chat.recoveryEmptyResponse', recovering: false, retryAllowed: card.recoveryAction?.canContinue !== false };
  if (failure.kind === 'fatal' && /^代理暂时不可用：\s*agent_no_progress$/.test(card.content)) {
    return { messageKey: 'projectAgent.chat.noProgress', recovering: false, retryAllowed: card.recoveryAction?.canContinue !== false };
  }
  const keys: Partial<Record<ProjectRecoveryFailureKind, TranslationKey>> = {
    response_headers_timeout: 'projectAgent.chat.recoveryExhausted',
    network: 'projectAgent.chat.recoveryExhausted',
    stream_interrupted: 'projectAgent.chat.recoveryExhausted',
    provider_transient: 'projectAgent.chat.recoveryExhausted',
    rate_limited: 'projectAgent.chat.recoveryExhausted',
    authentication: 'projectAgent.chat.recoveryAuthentication',
    configuration: 'projectAgent.chat.recoveryConfiguration',
    invalid_request: 'projectAgent.chat.recoveryInvalidRequest',
    permission: 'projectAgent.chat.recoveryPermission',
    budget_exhausted: card.recoveryAction?.budget?.reason === 'reservation_pending'
      ? card.recoveryAction.canContinue ? 'projectAgent.chat.budgetAvailable' : 'projectAgent.chat.budgetReserved'
      : card.recoveryAction?.canContinue ? 'projectAgent.chat.budgetReady'
      : card.recoveryAction?.budget?.reason === 'usage_unknown' ? 'projectAgent.chat.budgetUnconfirmed'
      : card.recoveryAction?.budget ? 'projectAgent.chat.budgetExhausted' : 'projectAgent.chat.recoveryLegacyLimit',
    execution_outcome_unknown: 'projectAgent.chat.recoveryUnknownOutcome',
    cancelled: 'projectAgent.chat.stopped',
  };
  return { messageKey: keys[failure.kind] ?? 'projectAgent.chat.unavailable',
    recovering: false, retryAllowed: card.recoveryAction?.canContinue !== false
      && (failure.kind !== 'budget_exhausted' || card.recoveryAction?.canContinue === true)
      && failure.kind !== 'execution_outcome_unknown' && failure.kind !== 'cancelled' };
}
