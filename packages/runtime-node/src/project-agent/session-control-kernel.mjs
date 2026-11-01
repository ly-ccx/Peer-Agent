import { createHash } from 'node:crypto';

export const SESSION_CONTROL_BUCKETS = ['sessionControls', 'sessionControlHeads'];
const controlPhases = { recorded: ['draining', 'settled'], draining: ['reconciling', 'settled'], reconciling: ['draining', 'settled'], settled: [] };
export const controlDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function executionIdentity(plan) {
  const origin = plan?.delegationOrigin;
  return { planId: plan.planId, sessionId: origin.sessionId,
    executionEpoch: origin.coordinationBinding?.executionEpoch || `legacy:${plan.planId}:${origin.executionGeneration || plan.createdAt || ''}`,
    ...(origin.executionGeneration ? { generation: origin.executionGeneration } : {}),
    ...(Number.isSafeInteger(origin.coordinationBinding?.goalRevision) ? { goalRevision: origin.coordinationBinding.goalRevision } : {}) };
}
export function sameExecution(a, b) {
  return Boolean(a && b && ['planId', 'sessionId', 'executionEpoch'].every(key => a[key] === b[key])
    && (a.goalRevision ?? null) === (b.goalRevision ?? null) && (a.generation ?? null) === (b.generation ?? null));
}
/** A control transaction owns only execution control. Task and permission truth stay elsewhere. */
export function reduceSessionControl(state, entry) {
  if (entry.minimumExecutorVersion !== undefined && ![7, 9].includes(entry.minimumExecutorVersion)) throw new Error('session_control_executor_unsupported');
  const controls = { ...state.sessionControls }, heads = { ...state.sessionControlHeads };
  const operation = structuredClone(entry.operation), old = controls[operation?.operationId];
  if (!operation || !['pause', 'cancel', 'takeover', 'resume'].includes(operation.kind)
    || !['operationId', 'requestDigest', 'workspaceId', 'parentConversationId', 'sessionId', 'planId', 'authorityRef', 'updatedAt']
      .every(key => typeof operation[key] === 'string' && operation[key])
    || !sameExecution(operation.expectedExecution, { ...operation.expectedExecution, planId: operation.planId, sessionId: operation.sessionId })
    || !operation.expectedExecution.executionEpoch || !controlPhases[operation.phase]
    || !Number.isFinite(Date.parse(operation.updatedAt))
    || operation.requestDigest !== controlDigest({ kind: operation.kind, operationId: operation.operationId, authorityRef: operation.authorityRef, execution: operation.expectedExecution })
    || operation.revision !== (old?.revision || 0) + 1 || entry.expectedRevision !== (old?.revision || 0)) throw new Error('session_control_conflict');
  if (old) {
    if (['requestDigest', 'workspaceId', 'parentConversationId', 'sessionId', 'planId', 'kind', 'authorityRef'].some(key => old[key] !== operation[key])
      || !sameExecution(old.expectedExecution, operation.expectedExecution) || old.hostEpoch !== operation.hostEpoch || old.unproven !== operation.unproven
      || old.priorStopReceiptId !== operation.priorStopReceiptId
      || old.phase === 'settled' || operation.phase !== old.phase && !controlPhases[old.phase].includes(operation.phase)) throw new Error('session_control_conflict');
    if (heads[operation.sessionId]?.operationId !== operation.operationId) throw new Error('session_control_superseded');
  } else {
    if (operation.phase !== 'recorded' || (heads[operation.sessionId]?.operationId || null) !== entry.expectedCurrentOperationId) throw new Error('session_control_conflict');
    const previous = controls[heads[operation.sessionId]?.operationId];
    if (previous?.kind === 'cancel' && operation.kind !== 'cancel') throw new Error('work_execution_stopped');
    if (previous && previous.phase !== 'settled') {
      controls[previous.operationId] = { ...previous, phase: 'settled', outcome: 'superseded', supersededBy: operation.operationId,
        revision: previous.revision + 1, updatedAt: operation.updatedAt };
    }
  }
  if (operation.phase === 'settled' && !['applied', 'superseded', 'rejected'].includes(operation.outcome)) throw new Error('session_control_outcome_required');
  if (operation.stopReceipt && (operation.stopReceipt.operationId !== operation.operationId
    || !sameExecution(operation.stopReceipt.execution, operation.expectedExecution)
    || !['admissionClosed', 'runnerIdle', 'schedulerIdle'].every(key => operation.stopReceipt[key] === true)
    || typeof operation.stopReceipt.receiptId !== 'string' || !operation.stopReceipt.receiptId
    || !Number.isFinite(Date.parse(operation.stopReceipt.completedAt))
    || !Array.isArray(operation.stopReceipt.resourceClaims) || operation.stopReceipt.resourceClaims.some(ref => typeof ref.claimId !== 'string' || !ref.claimId || !Number.isSafeInteger(ref.revision) || ref.revision < 1)
    || new Set(operation.stopReceipt.resourceClaims.map(ref => ref.claimId)).size !== operation.stopReceipt.resourceClaims.length
    || operation.stopReceipt.scope !== 'managed_execution' || !Array.isArray(operation.stopReceipt.unknownCalls)
    || operation.stopReceipt.unknownCalls.some(id => typeof id !== 'string' || !id))) throw new Error('session_control_receipt_invalid');
  if (operation.phase === 'settled' && operation.outcome === 'applied' && operation.kind !== 'resume' && !operation.stopReceipt) throw new Error('session_control_receipt_required');
  controls[operation.operationId] = operation;
  heads[operation.sessionId] = { operationId: operation.operationId };
  return { ...state, sessionControls: controls, sessionControlHeads: heads };
}
