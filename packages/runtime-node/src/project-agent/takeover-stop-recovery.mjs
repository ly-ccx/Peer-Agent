import { controlDigest, executionIdentity, sameExecution } from './session-control-kernel.mjs';
import { isCanonicalUserInput } from './user-priority.mjs';

const recoveryAuthority = operationId => `coordination-recovery:${operationId}`;

/** One current stop proof, shared by transition recovery and the takeover adapter. */
export function takeoverStopReceipt(plan, control, operationId) {
  if (typeof operationId !== 'string' || !operationId || !plan?.delegationOrigin) return null;
  const origin = plan.delegationOrigin, receipt = control?.stopReceipt;
  const ownsProposal = control?.kind === 'takeover' && control.operationId === operationId
    || control?.kind === 'pause' && control.authorityRef === recoveryAuthority(operationId);
  return ownsProposal && control.phase === 'settled' && control.outcome === 'applied'
    && control.workspaceId === origin.workspaceId && control.parentConversationId === origin.parentConversationId
    && receipt?.operationId === control.operationId && receipt.scope === 'managed_execution'
    && receipt.admissionClosed === true && receipt.runnerIdle === true && receipt.schedulerIdle === true
    && Array.isArray(receipt.unknownCalls) && receipt.unknownCalls.length === 0 && receipt.receiptId
    && Number.isFinite(Date.parse(receipt.completedAt)) && sameExecution(receipt.execution, control.expectedExecution)
    && sameExecution(control.expectedExecution, executionIdentity(plan)) ? receipt : null;
}

/** Recover only RC35's never-admitted generation, not an arbitrary idle-looking execution. */
export function fencedResumeStop(plan, state, messages, facts) {
  const origin = plan?.delegationOrigin, takeover = origin?.takeover;
  if (!origin || takeover?.phase !== 'stopping' || !takeover.operationId || origin.phase !== 'queued'
    || plan.status !== 'paused' || plan.resultAcceptance?.acceptedAt || origin.cancellation
    || plan.runner?.status !== 'paused' || plan.runner.turnCount !== 0 || plan.runner.toolCallCount !== 0
    || facts?.live !== false || facts.handles !== false || !Array.isArray(facts.unknownCalls) || facts.unknownCalls.length
    || !Array.isArray(facts.claims) || facts.claims.some(row => !['draining', 'reconciling'].includes(row.state)
      || row.evidenceCalls?.length || Object.values(row.handles || {}).some(handle => handle.state !== 'ended'))
    || plan.runTrace?.events?.some(row => row.type === 'action_started' || row.type === 'step_started' && row.payload?.summaryCode === 'turn_started')) return null;
  const work = state.works?.[origin.workId], mandate = state.mandates?.[origin.workId];
  const transition = state.transitions?.[takeover.operationId];
  const competing = Object.values(state.transitions || {}).some(row => row.oldSessionId === origin.sessionId
    && row.operationId !== takeover.operationId && !['completed', 'blocked'].includes(row.phase));
  if (!work || work.workspaceId !== origin.workspaceId || work.parentConversationId !== origin.parentConversationId
    || work.stopScope === 'work' && ['paused', 'cancelled', 'coalesced', 'budget_limited'].includes(work.state)
    || ['coalesced', 'budget_limited'].includes(work.state)
    || mandate?.lifecycle !== 'active' || mandate.workspaceId !== origin.workspaceId || mandate.parentConversationId !== origin.parentConversationId
    || !mandate.sessionIds?.includes(origin.sessionId) || !mandate.revokedSessionIds?.includes(origin.sessionId)
    || mandate.executionBindings?.[origin.sessionId] || competing
    || !transition || transition.operationId !== takeover.operationId || transition.oldSessionId !== origin.sessionId
    || !['handoff', 'revise', 'resume'].includes(transition.action)
    || !['stopping', 'awaiting_outcome'].includes(transition.phase) || ['applied', 'unknown', 'rejected'].includes(transition.executionEffect)
    || transition.workId !== origin.workId || transition.expectedGoalRevision !== mandate.goalRevision
    || takeover.binding?.workId !== origin.workId || takeover.binding?.executionEpoch !== transition.executionEpoch
    || takeover.binding?.goalRevision !== mandate.goalRevision) return null;
  const resumed = state.sessionControls?.[origin.executionGeneration], stopped = state.sessionControls?.[takeover.operationId];
  const anchor = messages.find(row => isCanonicalUserInput(row) && row.id === origin.lastResumeAnchorMessageId);
  if (!anchor || !transition.sourceInputIds?.includes(anchor.inputId || anchor.id)
    || resumed?.kind !== 'resume' || resumed.phase !== 'settled' || resumed.outcome !== 'applied'
    || resumed.operationId !== `resume:${anchor.id}` || resumed.authorityRef !== anchor.id
    || stopped?.kind !== 'takeover' || stopped.operationId !== takeover.operationId
    || stopped.authorityRef !== `coordination:${takeover.operationId}`
    || stopped.phase !== 'settled' || stopped.outcome !== 'applied' || !stopped.stopReceipt
    || resumed.priorStopReceiptId !== stopped.stopReceipt.receiptId
    || stopped.stopReceipt.operationId !== stopped.operationId || resumed.expectedExecution?.goalRevision !== mandate.goalRevision
    || !sameExecution(resumed.expectedExecution, stopped.expectedExecution)
    || !sameExecution(stopped.expectedExecution, stopped.stopReceipt.execution)
    || stopped.stopReceipt.unknownCalls?.length !== 0 || stopped.stopReceipt.admissionClosed !== true
    || stopped.stopReceipt.runnerIdle !== true || stopped.stopReceipt.schedulerIdle !== true
    || stopped.stopReceipt.scope !== 'managed_execution'
    || !Number.isFinite(Date.parse(stopped.stopReceipt.completedAt)) || !Number.isFinite(Date.parse(resumed.updatedAt))
    || Date.parse(stopped.stopReceipt.completedAt) > Date.parse(resumed.updatedAt)
    || [resumed, stopped].some(row => row.workspaceId !== origin.workspaceId || row.parentConversationId !== origin.parentConversationId
      || row.sessionId !== origin.sessionId || row.planId !== plan.planId)
    || origin.coordinationBinding?.executionEpoch !== resumed.expectedExecution.executionEpoch
    || origin.coordinationBinding?.goalRevision !== mandate.goalRevision) return null;
  const execution = executionIdentity(plan), authorityRef = recoveryAuthority(takeover.operationId);
  const operationId = `recover-takeover-resume:${controlDigest([takeover.operationId, resumed.operationId, execution])}`;
  const head = state.sessionControlHeads?.[origin.sessionId]?.operationId;
  if (head !== resumed.operationId && head !== operationId) return null;
  return { kind: 'pause', operationId, authorityRef, reason: 'settle fenced native resume before retained takeover', execution };
}
