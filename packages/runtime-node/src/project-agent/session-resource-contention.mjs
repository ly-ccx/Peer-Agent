import { controlDigest } from './session-control-kernel.mjs';

const contention = control => control?.authorityRef?.startsWith('resource-conflict:');
const resuming = control => control?.authorityRef?.startsWith('resource-resume:');

/** A denied expansion yields the old directory before requeueing the complete resource set. */
export function createSessionResourceContention({ goalPlanStore, sessionControl, canManageWorkspace, exclusive, promote }) {
  const pending = new Map();
  async function finish(planId) {
    let plan = goalPlanStore.getPlan(planId), control = sessionControl.read(plan);
    if (!contention(control) && !resuming(control)) return;
    if (contention(control) && control.phase !== 'settled') {
      const receipt = await sessionControl.drain(plan, control);
      await exclusive(() => sessionControl.settle(goalPlanStore.getPlan(planId), control, receipt));
    }
    await exclusive(async () => {
      plan = goalPlanStore.getPlan(planId); control = sessionControl.read(plan);
      if (!canManageWorkspace(plan.delegationOrigin.workspaceId) || plan.delegationOrigin.cancellation
        || plan.delegationOrigin.phase !== 'paused' || control?.phase !== 'settled' || control.outcome !== 'applied') return;
      if (contention(control)) await sessionControl.resume(plan, `resource-resume:${control.operationId}`);
      else if (resuming(control)) await sessionControl.resume(plan, control.authorityRef);
      else return;
      const fresh = goalPlanStore.getPlan(planId);
      goalPlanStore.revisePlan(planId, { status: 'paused', delegationOrigin: { ...fresh.delegationOrigin, phase: 'queued' } },
        { reason: 'requeue complete execution resource set', changedBy: 'session-resource-contention' });
      await promote();
    });
  }
  function schedule(planId) {
    if (pending.has(planId)) return pending.get(planId);
    const done = Promise.resolve().then(() => finish(planId)).catch(() => {
      // The shared barrier retains the structured recovery reason and resource protection.
      // Pulse or a real handle/result change resumes the same operation; no tool is replayed.
    }).finally(() => pending.delete(planId));
    pending.set(planId, done); return done;
  }
  return {
    request(plan, blocker) {
      const fresh = goalPlanStore.getPlan(plan.planId), current = sessionControl.read(fresh);
      if (!canManageWorkspace(fresh.delegationOrigin.workspaceId) || fresh.delegationOrigin.phase !== 'running'
        || ['completed','failed','cancelled'].includes(fresh.status) || fresh.resultAcceptance?.acceptedAt
        || fresh.delegationOrigin.cancellation || current && current.phase !== 'settled') return;
      const operation = sessionControl.begin(fresh, { kind: 'pause', operationId: `resource-conflict:${fresh.planId}:${controlDigest([current?.operationId, blocker])}`,
        authorityRef: `resource-conflict:${blocker?.claimId || blocker?.code || 'unknown'}`, reason: 'execution resource contention' });
      const gated = goalPlanStore.getPlan(fresh.planId);
      goalPlanStore.revisePlan(fresh.planId, { status: 'paused', delegationOrigin: { ...gated.delegationOrigin, phase: 'paused' } },
        { reason: 'yield directory before resource expansion', changedBy: 'session-resource-contention' });
      schedule(operation.planId);
    },
    async reconcile(plans) {
      // Never await a stop while holding the supervisor writer: tool result commits may need it.
      for (const plan of plans) if (canManageWorkspace(plan.delegationOrigin.workspaceId)
        && plan.delegationOrigin.phase === 'paused' && (contention(sessionControl.read(plan)) || resuming(sessionControl.read(plan)))) schedule(plan.planId);
    },
  };
}
