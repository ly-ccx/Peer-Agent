import { workBudgetBinding } from './work-budget.mjs';
import { sessionExecutionCurrent } from './execution-ownership.mjs';

const failure = (code, message = code) => Object.assign(new Error(message), { code });
const phases = new Set(['ready', 'requesting', 'tools', 'completed']);
export function validateVerificationContinuation(value) {
  if (!value || value.schemaVersion !== 1 || typeof value.planId !== 'string' || !value.planId || typeof value.continuationId !== 'string' || !value.continuationId
    || value.policyVersion !== undefined && value.policyVersion !== 2
    || typeof value.sourceRevision !== 'string' || !value.sourceRevision || typeof value.modelKey !== 'string' || !value.modelKey
    || !phases.has(value.phase) || !Number.isFinite(Date.parse(value.deadlineAt))
    || ![value.modelRequests, value.toolCalls, value.formatAttempt].every(n => Number.isSafeInteger(n) && n >= 0)
    || value.formatAttempt > 1 || value.checkpointRef && !/^[a-f0-9]{64}\.json$/.test(value.checkpointRef)
    || !Array.isArray(value.evidenceRefs) || value.evidenceRefs.some(ref => typeof ref !== 'string')) throw failure('verifier_checkpoint_unavailable', 'Invalid verifier continuation metadata; allowance was not reset');
  return structuredClone(value);
}

/** Uses the registered coordination checkpoint store; never invents a task or mandate for legacy plans. */
export function createVerificationContinuationPort({ plan, goalPlanStore, workId, sourceRevision, readSourceRevision, ownsPlan = () => true }) {
  const origin = plan?.delegationOrigin;
  const store = workBudgetBinding(origin?.workspaceId)?.store;
  if (!store) return null;
  const prior = plan.runner?.verificationContinuation;
  const candidate = prior?.workId || origin.workId || workId;
  const work = candidate && store.read().works[candidate];
  if (candidate && (!work || work.parentConversationId !== origin.parentConversationId || work.workspaceId !== origin.workspaceId)) {
    throw failure('work_execution_stopped', 'Verifier work ownership is unavailable');
  }
  function assertCurrent() {
    store.assertOwner();
    const current = goalPlanStore.getPlan(plan.planId);
    if (!current || !ownsPlan(current) || !sessionExecutionCurrent(current) || current.delegationOrigin?.phase !== 'running'
      || current.delegationOrigin.workspaceId !== origin.workspaceId || current.delegationOrigin.parentConversationId !== origin.parentConversationId
      || current.delegationOrigin.sessionId !== origin.sessionId
      || current.delegationOrigin?.supersededBy || ['cancelled', 'paused'].includes(current.status)
      || ['paused', 'waiting_user'].includes(current.runner?.status) || current.runner?.waitingOnUser) throw failure('work_execution_stopped');
    if (readSourceRevision(current) !== sourceRevision) throw failure('verification_source_changed');
    const receipt = candidate ? store.read().works[candidate] : null;
    if (candidate && (!receipt || receipt.workspaceId !== origin.workspaceId || receipt.parentConversationId !== origin.parentConversationId
      || receipt.stopScope === 'work' && ['cancelled', 'paused', 'blocked_system'].includes(receipt.state)
      || receipt?.state === 'budget_limited')) throw failure('work_execution_stopped');
  }
  return {
    workId: candidate,
    load() { const value = goalPlanStore.getPlan(plan.planId)?.runner?.verificationContinuation;
      if (value && value.planId !== plan.planId) throw failure('verifier_checkpoint_unavailable');
      return value ? validateVerificationContinuation(value) : null; },
    save(value) { assertCurrent(); goalPlanStore.setRunnerState(plan.planId,
      { verificationContinuation: validateVerificationContinuation({ ...value, ...(candidate ? { workId: candidate } : {}) }) }); },
    assertCurrent,
    writeCheckpoint(value) { assertCurrent(); return store.checkpoint(`verifier:${plan.planId}`, value); },
    readCheckpoint(ref) { assertCurrent(); return store.readCheckpoint(ref); },
  };
}
