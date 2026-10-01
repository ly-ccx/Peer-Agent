export const MIN_WORKTREE_FREE_BYTES = 2 * 1024 ** 3;
export const FAILED_WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Facts come from the host's existing Git/worktree adapter. Hints never prove isolation. */
export function decideIsolation(plan, facts = {}, plans = []) {
  const origin = plan.delegationOrigin || {};
  if (origin.readOnly === true) return { isolation: 'none', reason: null };
  if (facts.ok === false) return { isolation: 'wait', reason: 'isolation_failed' };
  if (facts.git !== true) return { isolation: 'none', reason: null };
  const requested = origin.isolation || 'auto';
  const otherWriter = plans.some(other => other.planId !== plan.planId
    && other.delegationOrigin?.workspaceId === origin.workspaceId
    && other.delegationOrigin?.readOnly !== true
    && other.delegationOrigin?.phase === 'running' && !TERMINAL.has(other.status));
  if (requested === 'none') return { isolation: 'none', reason: otherWriter ? 'write_slot' : null };
  if (facts.existingWorktree === true) return { isolation: 'worktree', reason: null };
  if (requested !== 'worktree' && !otherWriter && !facts.dirty) return { isolation: 'none', reason: null };
  if (!Number.isFinite(facts.freeBytes)) return { isolation: 'wait', reason: 'isolation_failed' };
  if (facts.freeBytes < MIN_WORKTREE_FREE_BYTES) return { isolation: 'wait', reason: 'disk_space' };
  return { isolation: 'worktree', reason: null };
}

export function createIsolationPlanner({ readFacts, isolatePlan, recordIsolation, discardLine,
  recordOrigin, now = () => new Date().toISOString() } = {}) {
  const inFlight = new Map();
  async function prepare(plan, plans = []) {
    if (!plan?.delegationOrigin || TERMINAL.has(plan.status)) return { ok: true, plan };
    if (inFlight.has(plan.planId)) return inFlight.get(plan.planId);
    const task = (async () => {
      let facts;
      try { facts = plan.delegationOrigin.readOnly === true ? {} : await readFacts(plan); }
      catch { facts = { ok: false }; }
      const decision = decideIsolation(plan, facts, plans);
      let next = plan;
      let reason = decision.isolation === 'wait' ? decision.reason : null;
      if (!reason && decision.isolation === 'worktree') {
        try {
          const result = await isolatePlan(plan);
          if (result?.ok && result.plan?.deliveryBinding?.executionIsolation === 'worktree'
            && result.plan.deliveryBinding.worktreePath
            && (await readFacts(result.plan))?.existingWorktree === true) next = result.plan;
          else reason = 'isolation_failed';
        } catch { reason = 'isolation_failed'; }
      } else if (!reason && next.deliveryBinding?.executionIsolation === 'worktree'
        && !next.deliveryBinding.worktreePath) {
        next = await recordIsolation(next, { executionIsolation: 'none' }) || next;
      }
      if ((next.delegationOrigin.isolationBlock || null) !== reason) {
        next = await recordOrigin(next, { isolationBlock: reason }) || next;
      }
      return { ok: !reason, reason, plan: next };
    })();
    inFlight.set(plan.planId, task);
    try { return await task; } finally { inFlight.delete(plan.planId); }
  }
  async function cleanup(plan) {
    if (!plan?.deliveryBinding?.worktreePath) return plan;
    if (plan.deliveryHandoff?.status === 'delivered' || plan.status === 'cancelled') {
      const result = await discardLine(plan, { deleteBranch: false });
      return result?.ok ? result.plan : plan;
    }
    if (plan.status !== 'failed' && !(plan.status === 'interrupted' && plan.runner?.status === 'failed')) return plan;
    let next = plan;
    let retainedAt = plan.delegationOrigin?.isolationRetainedAt;
    if (!retainedAt) {
      retainedAt = now();
      next = await recordOrigin(plan, { isolationRetainedAt: retainedAt }) || plan;
    }
    if (Date.parse(now()) - Date.parse(retainedAt) < FAILED_WORKTREE_RETENTION_MS) return next;
    const result = await discardLine(next, { deleteBranch: false });
    return result?.ok ? result.plan : next;
  }
  return Object.freeze({ prepare, cleanup });
}
