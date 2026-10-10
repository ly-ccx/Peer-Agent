import { randomUUID } from 'node:crypto';
import { classifyProjectAgentFailure } from '@peer-agent/protocol';
import { workBudgetBinding } from './work-budget.mjs';

export const WORK_RECOVERY_DELAYS_MS = Object.freeze([2000, 5000]);
export const WORK_RECOVERY_PERIOD_MS = 5 * 60_000;

export function hasUnsettledDispatch(work) {
  const active = workBudgetBinding(work?.workspaceId)?.activeAttempts;
  return Boolean(work?.budget?.uncertainDispatches?.length || Object.entries(work?.budget?.attempts || {})
    .some(([id, attempt]) => attempt.pendingTools?.length && !active?.has(id)));
}

export function recoveryForFailure(work, outcome, at) {
  const classified = hasUnsettledDispatch(work) ? { kind: 'execution_outcome_unknown', retryable: false }
    : classifyProjectAgentFailure(outcome.reason, outcome.failure);
  const previous = work?.recovery;
  const now = Date.parse(at);
  const autoAttempts = Number.isSafeInteger(previous?.autoAttempts) && previous.autoAttempts >= 0 ? previous.autoAttempts : 0;
  const deadlineAt = Number.isFinite(Date.parse(previous?.deadlineAt)) ? previous.deadlineAt : new Date(now + WORK_RECOVERY_PERIOD_MS).toISOString();
  const recovery = { failureKind: classified.kind, retryable: classified.retryable && outcome.failure?.replaySafe !== false, autoAttempts,
    failedTurnId: outcome.turnId, deadlineAt,
    ...(outcome.reason === 'continuity_checkpoint_missing' ? { blockedCode: 'RECOVERY_CHECKPOINT_UNAVAILABLE' } : {}) };
  const delay = WORK_RECOVERY_DELAYS_MS[autoAttempts];
  if (recovery.retryable && delay !== undefined && now + delay < Date.parse(deadlineAt)) {
    recovery.retryAt = new Date(now + delay).toISOString();
    recovery.reservationId = `retry-${randomUUID()}`;
  }
  return recovery;
}

export function recoveryReservationDue(work, at) {
  const recovery = work?.recovery;
  return Boolean(work?.state === 'retry_wait' && recovery?.retryable && recovery.reservationId
    && work.waitFor?.some(wait => wait.kind === 'retry_timer' && wait.id === recovery.reservationId)
    && Number.isFinite(Date.parse(recovery.retryAt)) && Date.parse(recovery.retryAt) <= Date.parse(at)
    && Number.isFinite(Date.parse(recovery.deadlineAt)) && Date.parse(at) < Date.parse(recovery.deadlineAt)
    && recovery.autoAttempts < WORK_RECOVERY_DELAYS_MS.length && !hasUnsettledDispatch(work));
}

export function recoveryCheckpointAvailable(work, checkpoint, readCheckpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return false;
  const rounds = checkpoint?.outcome?.rounds || [];
  const executed = rounds.some(round => round.toolCalls?.length);
  if (work.nativeCheckpointRef && readCheckpoint) {
    try { const native = readCheckpoint(work.nativeCheckpointRef); return Boolean(native && typeof native === 'object'); }
    catch { return false; }
  }
  return !executed || Boolean(work.nativeCheckpointRef || checkpoint?.outcome?.providerCheckpoint);
}

export function manualRecovery(previous, at) {
  return previous ? { ...previous, autoAttempts: 0, retryAt: undefined, reservationId: undefined, blockedCode: undefined,
    deadlineAt: new Date(Date.parse(at) + WORK_RECOVERY_PERIOD_MS).toISOString() } : undefined;
}
