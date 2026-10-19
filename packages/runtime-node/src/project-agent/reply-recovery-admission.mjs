import { hasUnsettledDispatch, recoveryCheckpointAvailable } from './recovery-policy.mjs';
import { workBudgetCanResume, workBudgetBinding } from './work-budget.mjs';
import { budgetBoundary, budgetReservationBoundary, effectiveWorkLimits, legacyBudgetMigration } from './work-budget-policy.mjs';

/** Shared by the command handler and read-only card projection. */
export function replyRecoveryAdmission(work, checkpoint, { limits, readCheckpoint } = {}) {
  const fail = (code, budget) => ({ ok: false, code, ...(budget ? { budget } : {}) });
  if (!work || ['delivered', 'cancelled', 'waiting_user', 'coalesced'].includes(work.state)) return fail('STALE_TURN');
  if (work.state === 'waiting_children' && !(work.stopScope === 'reply' && checkpoint?.outcome?.stopped === true)) return fail('STALE_TURN');
  if (hasUnsettledDispatch(work) || work.recovery?.failureKind === 'execution_outcome_unknown') return fail('EXECUTION_OUTCOME_UNKNOWN');
  const effective = effectiveWorkLimits(work.budget, limits || work.budget?.limits);
  const boundary = budgetBoundary(work.budget, effective);
  if (boundary) return fail('WORK_BUDGET_EXHAUSTED', boundary);
  if (work.state === 'budget_limited' && !workBudgetCanResume(work, limits)) {
    return fail('WORK_BUDGET_EXHAUSTED', work.budget?.lastBoundary?.reason === 'reservation_pending'
      ? budgetReservationBoundary({ ...work.budget, limits: effective }) : work.budget?.lastBoundary);
  }
  if (!recoveryCheckpointAvailable(work, checkpoint, readCheckpoint)) return fail('RECOVERY_CHECKPOINT_UNAVAILABLE');
  if (checkpoint.job?.workId !== work.workId) return fail('STALE_TURN');
  return { ok: true, ...(work.budget?.lastBoundary?.reason === 'reservation_pending'
    ? { budget: budgetReservationBoundary({ ...work.budget, limits: effective }) } : {}) };
}

/** Lease-guarded append, never a write to historical conversations or counters. */
export function recoverLegacyBudgetWorks({ store, workspaceId, conversationId, rows, now }) {
  const binding = workBudgetBinding(workspaceId);
  if (!binding || binding.store !== store) return;
  for (const work of Object.values(store.read().works)) {
    if (work.state !== 'budget_limited' || work.stopScope === 'work' || work.parentConversationId !== conversationId) continue;
    const budget = legacyBudgetMigration(work, binding.limits, now());
    if (!budget || (typeof rows === 'function' ? rows() : rows).some(row => work.sessionIds?.includes(row.sessionId)
      && (row.needsUser || row.status === 'waiting_user'))) continue;
    let checkpoint;
    try { checkpoint = store.readCheckpoint(work.checkpointRef); } catch { continue; }
    if (!replyRecoveryAdmission(work, checkpoint, { limits: binding.limits, readCheckpoint: store.readCheckpoint }).ok) continue;
    store.saveWork({ ...work, budget, state: 'runnable', end: 'yielded', recovery: undefined }, { returnState: false });
  }
}
