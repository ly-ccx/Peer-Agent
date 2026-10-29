import { createHash } from 'node:crypto';

export function resultCanBeAccepted(plan) {
  return plan?.status === 'completed' && (!plan.runner?.enabled || plan.runner.status === 'completed');
}

function completionReviewToken(plan, report) {
  return createHash('sha256').update(JSON.stringify([
    plan.planId, plan.successCriteria, plan.criterionResults, plan.tasks, report.summary,
    (plan.manualConfirmations || []).filter(row => row.decision !== 'approve'),
  ])).digest('hex');
}

export function needsCompletionReview(plan) {
  return Boolean(plan?.delegationOrigin && !['paused', 'superseded', 'queued', 'awaiting_approval'].includes(plan.delegationOrigin.phase)
    && plan.runner?.status === 'blocked' && plan.runner.blockedReason === 'manual_dod_confirmation_required'
    && !['failed', 'cancelled'].includes(plan.status));
}

/** Only the existing manual DoD blocker admits a local human completion review. */
export function projectCompletionReview(plan, report) {
  if (!needsCompletionReview(plan) || !report?.summary?.trim()) return null;
  const reviewToken = completionReviewToken(plan, report);
  const manualCriteria = (plan.successCriteria || []).filter(c => c.kind === 'manual');
  const confirmed = manualCriteria.every(c => (plan.manualConfirmations || []).findLast(row => row.criterionIds?.includes(c.id))?.decision === 'approve')
    && (plan.manualConfirmations || []).some(row => row.confirmationId === `completion-review:${reviewToken}` && row.decision === 'approve');
  const criteria = (plan.successCriteria || []).filter(c => c.kind === 'manual' && (confirmed
    || (plan.manualConfirmations || []).findLast(row => row.criterionIds?.includes(c.id))?.decision !== 'approve'))
    .map(({ id, description }) => ({ id, description }));
  if (!criteria.length) return null;
  return { sessionId: plan.delegationOrigin.sessionId, reviewToken, criteria, report: report.summary,
    ...(confirmed ? { confirmed: true } : {}) };
}

export async function confirmCompletionReview({ plan, review, report, reviewToken, store, runner, now }) {
  if (typeof reviewToken !== 'string' || !reviewToken) return { ok: false, error: 'invalid_review' };
  const confirmationId = `completion-review:${reviewToken}`;
  const previous = (plan.manualConfirmations || []).find(row => row.confirmationId === confirmationId);
  if (previous && previous.decision !== 'approve') return { ok: false, error: 'stale_completion_review' };
  if (previous && plan.runner?.status === 'blocked' && plan.runner.blockedReason === 'manual_dod_confirmation_required'
    && (!report || completionReviewToken(plan, report) !== reviewToken)) return { ok: false, error: 'stale_completion_review' };
  if (!previous) {
    if (!review || review.reviewToken !== reviewToken) return { ok: false, error: 'stale_completion_review' };
    if (typeof runner?.resume !== 'function') return { ok: false, error: 'runner_unavailable' };
    store.recordManualConfirmation(plan.planId, { confirmationId, kind: 'manual_dod', decision: 'approve',
      criterionIds: review.criteria.map(c => c.id), decidedBy: 'local_ui', decidedAt: now() });
  }
  const current = store.getPlan(plan.planId);
  if (current.delegationOrigin?.phase === 'running' && !['failed', 'cancelled'].includes(current.status)
    && current.runner?.status === 'blocked' && current.runner.blockedReason === 'manual_dod_confirmation_required') {
    if (typeof runner?.resume !== 'function') return { ok: false, error: 'runner_unavailable' };
    await runner.resume(plan.planId, { intent: 'verify', phase: 'verify', awaitIdle: false });
  }
  return { ok: true, ...(previous ? { alreadyConfirmed: true } : {}) };
}
