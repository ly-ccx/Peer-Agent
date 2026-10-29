import { hasUnsettledDispatch } from './recovery-policy.mjs';
import { takeoverBlocker } from './session-repair.mjs';

/** A reconciled host dispatch can release a transition; a model assertion cannot. */
export function transitionReconciliation(transition, work, session) {
  if (transition.phase !== 'awaiting_outcome' || !session || hasUnsettledDispatch(work)) return null;
  const proof = work?.budget?.reconciledDispatches?.find(row => row.planId === session.planId
    && row.toolCallId && row.attemptId && row.outcome === 'verification_interrupted' && Number.isFinite(Date.parse(row.at))
    && Date.parse(row.at) >= Date.parse(transition.updatedAt));
  if (!proof) return null;
  if (['cancel','replace','handoff','revise','resume'].includes(transition.action)) {
    return {phase:'stopping',error:undefined,reconciliationRef:`${proof.attemptId}:${proof.toolCallId}`};
  }
  return null;
}

/** Read-only next steps are derived from existing gates; they never authorize an action. */
export function supervisionRecovery({plan,session,work,mandate,transitions = [],receipts = [],requests = [],relatedWorks = []}) {
  const pending = transitions.filter(row => row.oldSessionId === session.sessionId && ['blocked','awaiting_outcome','stopping'].includes(row.phase));
  const unknown = [...(work?.budget?.uncertainDispatches || []), ...Object.values(work?.budget?.attempts || {}).flatMap(row => row.pendingTools || [])];
  const unknownCommands = receipts.filter(row => row.effect === 'unknown');
  const blockers = [...new Set([...pending.map(row => row.error || row.phase),
    ...unknown.map(row => row.toolCallId || 'dispatch_identity_unknown'),...unknownCommands.map(row => row.operationId)])].slice(0,24);
  const request = requests.find(row => row.status === 'open');
  if (session.followUp?.owner === 'user' || request?.responder === 'user') return {state:'waiting_user',blockers,nextAction:'native_user_decision'};
  if (hasUnsettledDispatch(work) || unknownCommands.length || pending.some(row => row.phase === 'awaiting_outcome')) {
    return {state:'reconciliation_required',blockers,nextAction:'inspect_original_results',replayAllowed:false};
  }
  if (work?.stopScope === 'work' && ['paused','cancelled'].includes(work.state)) {
    return {state:'user_stopped',blockers,nextAction:'current_user_required'};
  }
  if (request || plan.delegationOrigin.agentWaitMessageId) return {state:'waiting_agent',blockers,nextAction:'answer_agent_request',
    requestId:request?.requestId || plan.delegationOrigin.agentWaitMessageId,...(request ? {expectedRequestRevision:request.revision} : {})};
  if (session.followUp?.owner === 'none') return {state:'settled',blockers:[],nextAction:'none'};
  if (['running','starting','queued','verifying','stopping'].includes(session.status)
    || receipts.some(row => row.effect === 'pending')) return {state:'observing',blockers,nextAction:'observe_current_attempt'};
  if (!mandate || !plan.delegationOrigin.coordinationBinding) {
    return {state:'legacy_unbound',blockers,nextAction:'adopt_with_current_user',expectedRevision:mandate?.goalRevision ?? 0};
  }
  const blocked = relatedWorks.find(row => row.state === 'blocked_system' || row.end === 'no_progress')
    || (work?.state === 'blocked_system' || work?.end === 'no_progress' ? work : null);
  if (blocked) {
    return {state:'blocked',blockers:[...blockers,`work:${blocked.workId || 'current'}:${blocked.recovery?.blockedCode || blocked.recovery?.failureKind || blocked.end || 'blocked_system'}`],
      nextAction:'inspect_blocker_and_change_method',expectedRevision:mandate.goalRevision};
  }
  const blocker = takeoverBlocker(plan,'resume',session.resultConfirmationRequired === true);
  if (blocker) return {state:'blocked',blockers:[...blockers,blocker],nextAction:'inspect_current_facts',expectedRevision:mandate.goalRevision};
  return {state:'repairable',blockers,nextAction:'coordinate_resume',expectedRevision:mandate.goalRevision};
}
