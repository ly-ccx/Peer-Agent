import type { GoalPlan } from '@peer-agent/protocol';

/** Presentation only: never infer progress from elapsed time or batch.done. */
export function goalInvestigation(plan: GoalPlan) {
  const runs = plan.runner?.explorers ?? [];
  const batchId = plan.runner?.explorerBatch?.batchId ?? runs.at(-1)?.batchId;
  const current = runs.filter(run => run.batchId === batchId);
  const paused = [plan.status, plan.runner?.status].some(status =>
    status === 'paused' || status === 'waiting_user' || status === 'blocked');
  const items = current.map(run => ({
    id: run.explorerId,
    question: run.request.question,
    detail: run.failureReason || run.request.reason,
    status: paused && (run.status === 'queued' || run.status === 'running')
      ? 'paused' as const : run.status,
  }));
  // Attention states must remain visible even when more than two investigations exist.
  const priority = { failed: 0, paused: 1, cancelled: 2, running: 3, queued: 4, completed: 5 };
  items.sort((a, b) => priority[a.status] - priority[b.status]);
  return {
    key: JSON.stringify([plan.planId, batchId ?? current.map(run => run.explorerId).sort()]),
    items,
    successful: items.length > 0 && items.every(item => item.status === 'completed')
      && (!plan.runner?.explorerBatch || current.length === plan.runner?.explorerBatch.total),
  };
}

/** A new identity starts visible; only successful batches may be dismissed. */
export function investigationHidden(key: string, successful: boolean, dismissedKey: string | null) {
  return successful && key === dismissedKey;
}
