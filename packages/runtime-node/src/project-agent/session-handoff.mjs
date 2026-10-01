import { randomUUID } from 'node:crypto';
import { handoffQuestionId, isHandoffConflict } from './acceptance.mjs';

/** User merge decisions and execution stay on host facts and existing handoff ports. */
export function createSessionHandoff({ findBySession, goalPlanStore, goalRunner, canManageWorkspace, conversationStore, promote, now }) {
  async function handoffAccepted(plan) {
    if (!plan?.resultAcceptance?.acceptedAt || !plan.delegationOrigin?.handoffAuthorizedAt
      || !plan.deliveryBinding?.worktreePath) return plan;
    if (typeof goalRunner?.handoffDelegatedPlan !== 'function') return plan;
    try { return await goalRunner.handoffDelegatedPlan(plan); }
    catch (error) {
      return goalPlanStore.recordDeliveryHandoff?.(plan.planId, { status: 'stopped', stoppedReason: 'handoff_failed',
        updatedAt: now(), detail: error?.message || 'handoff failed' }) || plan;
    }
  }

  async function handoffAnswerLocked(input) {
    const plan = findBySession(String(input.sessionId || '').trim());
    if (!plan || input.workspaceId !== plan.delegationOrigin.workspaceId
      || canManageWorkspace(input.workspaceId) !== true) return { handled: false };
    const questionId = handoffQuestionId(plan.deliveryHandoff, plan.resultAcceptance?.acceptedAt);
    const conflict = isHandoffConflict(plan.deliveryHandoff);
    if (input.answerTo !== `card:question:${input.sessionId}:${questionId}` || !plan.resultAcceptance?.acceptedAt
      || plan.status !== 'completed' || !plan.deliveryBinding?.worktreePath) return { handled: false };
    if (!conflict && input.text === '合回改动') {
      const saved = goalPlanStore.revisePlan(plan.planId,
        { delegationOrigin: { ...plan.delegationOrigin, handoffAuthorizedAt: now(), handoffDeferredAt: null } },
        { reason: 'user confirmed merge back', changedBy: 'user' });
      return { handled: true, plan: await handoffAccepted(saved) };
    }
    if (conflict && input.text === '让任务自己解决') {
      const instruction = `用户要求解决合回问题：${plan.deliveryHandoff?.stoppedReason || 'merge_conflict'}。在自己的 worktree 中整合目标分支 ${plan.deliveryBinding.targetBranch}，解决冲突并重新验证，再交回结果。`;
      conversationStore.appendMessage(plan.conversationId, { id: randomUUID(), role: 'user', kind: 'user_input', content: instruction });
      goalPlanStore.revisePlan(plan.planId, {
        status: 'executing', resultAcceptance: null, qualityReview: null,
        tasks: [...(plan.tasks || []), { taskId: randomUUID(), title: instruction, status: 'pending' }],
        delegationOrigin: { ...plan.delegationOrigin, phase: 'queued', handoffAuthorizedAt: now(), handoffDeferredAt: null },
      }, { reason: 'user requested handoff repair', changedBy: 'user' });
      goalPlanStore.setRunnerState(plan.planId, { status: 'paused', phase: 'orient', intent: 'execute', turnCount: 0 });
      await promote();
      return { handled: true, repairing: true };
    }
    if (conflict && input.text === '我来处理' || !conflict && input.text === '暂不合回') {
      goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...plan.delegationOrigin,
        handoffDeferredAt: plan.deliveryHandoff?.updatedAt || now() } }, { reason: 'user deferred merge back', changedBy: 'user' });
      return { handled: true, deferred: true };
    }
    if (conflict && input.text === '放弃这次改动' && typeof goalRunner?.discardDelegatedLine === 'function') {
      const discarded = await goalRunner.discardDelegatedLine(plan);
      if (!discarded?.ok) return { handled: true, error: discarded?.reason || 'cleanup_failed' };
      goalPlanStore.setPlanStatus(plan.planId, 'cancelled');
      return { handled: true, discarded: true };
    }
    return { handled: false };
  }

  function facts(sessionId) {
    const plan = findBySession(String(sessionId || '').trim());
    return plan ? { sessionId, planId: plan.planId, title: plan.title, status: plan.status,
      accepted: Boolean(plan.resultAcceptance?.acceptedAt), worktreePath: plan.deliveryBinding?.worktreePath,
      handoff: plan.deliveryHandoff, conflict: isHandoffConflict(plan.deliveryHandoff),
      authorized: Boolean(plan.delegationOrigin.handoffAuthorizedAt),
      deferred: Boolean(plan.delegationOrigin.handoffDeferredAt)
        && (!plan.deliveryHandoff?.updatedAt || plan.delegationOrigin.handoffDeferredAt === plan.deliveryHandoff.updatedAt),
      questionId: handoffQuestionId(plan.deliveryHandoff, plan.resultAcceptance?.acceptedAt) } : null;
  }
  return { afterAcceptance: handoffAccepted, answer: handoffAnswerLocked, facts };
}
