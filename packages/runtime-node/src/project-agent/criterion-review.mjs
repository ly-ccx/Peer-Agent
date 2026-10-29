import { createHash } from 'node:crypto';

/** Excludes transient runner state and reviews themselves, so checking cannot invalidate its own source. */
export function criterionSourceRevision(plan) {
  const tasks = nodes => (nodes || []).map(node => ({ taskId: node.taskId, status: node.status,
    result: node.result, evidenceRefs: node.evidenceRefs, subtasks: tasks(node.subtasks) }));
  return createHash('sha256').update(JSON.stringify([plan?.planId, plan?.goal,
    plan?.successCriteria, tasks(plan?.tasks), plan?.manualConfirmations, plan?.deliveryBinding])).digest('hex');
}

export function currentModelReview(plan, criterionId) {
  const row = plan?.modelReviews?.findLast(item => item.criterionId === criterionId);
  return row?.sourceRevision === criterionSourceRevision(plan) ? row : null;
}

export function semanticGateCanRun(gate) {
  return gate?.passed === true || (gate?.unmet?.length > 0
    && gate.unmet.every(item => item.kind === 'model_review' || item.reason === 'manual_confirmation_required'));
}
