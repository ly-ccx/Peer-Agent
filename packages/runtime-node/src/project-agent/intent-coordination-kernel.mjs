import { createHash } from 'node:crypto';

export const INTENT_FORMAT_VERSION = 8;
const intentKinds = new Set(['discuss', 'answer', 'delegate', 'augment', 'revise', 'withdraw']);
const intentText = (value, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const intentIds = (values, max = 64) => Array.isArray(values) && values.length <= max
  && values.every(value => intentText(value, 200)) && new Set(values).size === values.length;
const intentStrings = (values, max = 16) => Array.isArray(values) && values.length <= max && values.every(value => intentText(value));
const intentDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const intentReject = error => ({ ok: false, error });
const intentRaise = error => { throw Object.assign(new Error(error), { code: error }); };

export function validIntentInterpretation(value) {
  return value && Object.keys(value).every(key => ['outcome', 'constraints', 'nonGoals', 'openQuestions', 'requirements'].includes(key))
    && intentText(value.outcome, 4000) && intentStrings(value.constraints) && intentStrings(value.nonGoals)
    && intentStrings(value.openQuestions) && Array.isArray(value.requirements) && value.requirements.length > 0 && value.requirements.length <= 32
    && new Set(value.requirements.map(row => row?.requirementId)).size === value.requirements.length
    && value.requirements.every(row => row && Object.keys(row).every(key => ['requirementId', 'text', 'sourceInputIds'].includes(key))
      && intentText(row.requirementId, 200) && intentText(row.text, 1000) && intentIds(row.sourceInputIds) && row.sourceInputIds.length > 0);
}
export function validWorkDisposition(value) {
  if (!value || typeof value !== 'object') return false;
  const allowed = {
    continue: ['kind', 'operationRefs'], wait: ['kind', 'waitFor'], return: ['kind', 'replyRef'],
    blocked_system: ['kind', 'code', 'recoveryRef'], withdraw: ['kind', 'controlRef'],
  }[value.kind];
  if (!allowed || Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (value.kind === 'continue') return intentIds(value.operationRefs) && value.operationRefs.length > 0;
  if (value.kind === 'wait') return Array.isArray(value.waitFor) && value.waitFor.length > 0 && value.waitFor.length <= 32
    && value.waitFor.every(row => row && Object.keys(row).every(key => ['kind', 'id', 'revision'].includes(key))
      && ['session', 'human_request', 'resource', 'recovery'].includes(row.kind) && intentText(row.id, 200) && intentText(row.revision, 200));
  if (value.kind === 'return') return intentText(value.replyRef, 200);
  if (value.kind === 'withdraw') return intentText(value.controlRef, 200);
  return intentText(value.code, 200) && intentText(value.recoveryRef, 200);
}
export function validIntentAssessment(value) {
  const keys = ['operationId', 'workId', 'expectedWorkRevision', 'expectedGoalRevision', 'sourceInputIds', 'sourceEventIds',
    'sourceDecisionRef', 'inputs', 'interpretation', 'coverage', 'disposition', 'reason'];
  return Boolean(value && Object.keys(value).every(key => keys.includes(key)) && intentText(value.operationId, 200)
    && intentText(value.workId, 200) && Number.isSafeInteger(value.expectedWorkRevision) && value.expectedWorkRevision >= 0
    && Number.isSafeInteger(value.expectedGoalRevision) && value.expectedGoalRevision >= 0
    && intentIds(value.sourceInputIds) && intentIds(value.sourceEventIds)
    && (value.sourceDecisionRef === undefined || intentText(value.sourceDecisionRef, 200))
    && Array.isArray(value.inputs) && value.inputs.length <= 64 && new Set(value.inputs.map(row => row?.inputId)).size === value.inputs.length
    && value.inputs.every(row => row && Object.keys(row).every(key => ['inputId', 'kind', 'reason'].includes(key))
      && intentText(row.inputId, 200) && intentKinds.has(row.kind) && intentText(row.reason))
    && (value.interpretation === undefined || validIntentInterpretation(value.interpretation))
    && Array.isArray(value.coverage) && value.coverage.length <= 32
    && new Set(value.coverage.map(row => row?.requirementId)).size === value.coverage.length
    && value.coverage.every(row => row && Object.keys(row).every(key => ['requirementId', 'status', 'explanation', 'sources'].includes(key))
      && intentText(row.requirementId, 200) && ['remaining', 'covered', 'uncertain'].includes(row.status) && intentText(row.explanation, 1000)
      && Array.isArray(row.sources) && row.sources.length <= 32 && row.sources.every(source => source
        && Object.keys(source).every(key => ['sessionId', 'sourceRevision', 'evidenceRefs'].includes(key))
        && intentText(source.sessionId, 200) && intentText(source.sourceRevision, 200) && intentIds(source.evidenceRefs)))
    && validWorkDisposition(value.disposition) && intentText(value.reason, 1000) && JSON.stringify(value).length <= 64_000);
}

/** Host facts are obtained from canonical input, the lease and the current mandate, never tool arguments. */
export function admitIntentAssessment(state, assessment, host) {
  if (!validIntentAssessment(assessment)) return intentReject('invalid_intent_assessment');
  if (!host?.holdsLease || !host.workspaceId || !host.parentConversationId) return intentReject('coordination_lease_lost');
  const work = state.works?.[assessment.workId], mandate = state.mandates?.[assessment.workId];
  if (!work || work.workspaceId !== host.workspaceId || work.parentConversationId !== host.parentConversationId) return intentReject('out_of_scope');
  const old = state.intentDecisions?.[assessment.operationId], digest = intentDigest(assessment);
  if (old) return old.digest === digest && old.workId === work.workId
    ? { ok: true, replayed: true, receipt: old } : intentReject('operation_identity_conflict');
  const prior = work.intentCoordination;
  if (['paused', 'cancelled', 'coalesced'].includes(work.state) || prior && prior.lifecycle !== 'active') return intentReject('work_execution_stopped');
  if ((prior?.revision || 0) !== assessment.expectedWorkRevision) return intentReject('work_revision_conflict');
  const goalRevision = mandate?.goalRevision || 0;
  if (goalRevision !== assessment.expectedGoalRevision) return intentReject('goal_revision_conflict');
  const inputs = assessment.sourceInputIds, events = assessment.sourceEventIds;
  if (inputs.some(id => !host.currentInputIds?.includes(id)) || events.some(id => !host.eventIds?.includes(id))) return intentReject('source_not_admitted');
  const decision = assessment.sourceDecisionRef && state.intentDecisions?.[assessment.sourceDecisionRef];
  if (!inputs.length && (!mandate || mandate.lifecycle !== 'active'
    || !events.length && !(decision?.workId === work.workId && prior?.decision.operationId === decision.operationId
      && prior.goalRevision === goalRevision && prior.decision.disposition.kind === 'continue'))) return intentReject('intent_source_required');
  if (events.some(id => !mandate?.sessionIds.includes(state.events?.[id]?.event?.sessionId)
    || mandate.revokedSessionIds?.includes(state.events[id].event.sessionId))) return intentReject('event_out_of_scope');
  if (assessment.inputs.length !== inputs.length || inputs.some(id => !assessment.inputs.some(row => row.inputId === id))) return intentReject('input_disposition_required');
  const interpretation = assessment.interpretation || prior?.interpretation;
  if (!interpretation) return intentReject('intent_interpretation_required');
  const admittedInputs = new Set([...(mandate?.rootInputIds || []), ...(mandate?.revisionInputIds || []), ...(work.anchorInputIds || []), ...inputs]);
  if (interpretation.requirements.some(row => row.sourceInputIds.some(id => !admittedInputs.has(id)))) return intentReject('intent_source_out_of_scope');
  if (prior && assessment.interpretation && intentDigest(prior.interpretation) !== intentDigest(assessment.interpretation)
    && (!inputs.length || prior.goalRevision === goalRevision)) return intentReject('intent_revision_required');
  const requirements = interpretation.requirements.map(row => row.requirementId);
  if (assessment.coverage.length !== requirements.length || requirements.some(id => !assessment.coverage.some(row => row.requirementId === id))) return intentReject('goal_coverage_incomplete');
  if (assessment.coverage.some(row => row.sources.some(source => !mandate?.sessionIds.includes(source.sessionId)))) return intentReject('coverage_out_of_scope');
  const receipt = { operationId: assessment.operationId, workId: work.workId, digest, workRevision: assessment.expectedWorkRevision + 1,
    goalRevision, at: host.now, ...(host.turnId ? { turnId: host.turnId } : {}) };
  return { ok: true, receipt, entry: { kind: 'intent_assessed', minimumExecutorVersion: INTENT_FORMAT_VERSION, workId: work.workId, assessment: structuredClone(assessment), receipt } };
}

export function reduceIntentCoordination(state, entry) {
  if (entry.minimumExecutorVersion !== INTENT_FORMAT_VERSION) intentRaise('intent_executor_unsupported');
  const work = state.works?.[entry.workId];
  if (!work) intentRaise('intent_work_missing');
  if (entry.kind === 'intent_reviewed') {
    const intent = work.intentCoordination, review = entry.review;
    if (!intent || intent.lifecycle !== 'active' || review?.goalRevision !== intent.goalRevision
      || review.intentRevision !== intent.revision || !intentText(review.reviewRef, 200)
      || review.coverageDigest !== intentDigest(intent.coverage) || typeof review.passed !== 'boolean'
      || !Array.isArray(review.sources) || !intentIds(review.evidenceRefs, 200)
      || !intentText(review.at, 100)) intentRaise('intent_review_conflict');
    return { ...state, works: { ...state.works, [entry.workId]: { ...work, intentCoordination: { ...intent, review: structuredClone(review) } } } };
  }
  if (entry.kind === 'intent_closed') {
    const prior = work.intentCoordination, receipt = entry.receipt;
    if (!prior || prior.lifecycle !== 'active' || receipt?.workId !== work.workId
      || receipt.workRevision !== prior.revision + 1 || receipt.goalRevision !== prior.goalRevision
      || receipt.goalRevision !== (state.mandates?.[work.workId]?.goalRevision || 0)
      || !['fulfilled', 'cancelled'].includes(receipt.lifecycle) || !intentText(receipt.at, 100)
      || !intentText(receipt.operationId, 200) || state.intentDecisions?.[receipt.operationId]) intentRaise('intent_closure_conflict');
    if (receipt.lifecycle === 'fulfilled' && (prior.decision.disposition.kind !== 'return'
      || prior.decision.disposition.replyRef !== receipt.replyRef || state.deliveries?.[receipt.replyRef]?.state !== 'delivered'
      || prior.review?.passed !== true || prior.review.reviewRef !== receipt.reviewRef
      || prior.review.goalRevision !== prior.goalRevision || prior.review.intentRevision !== prior.revision
      || prior.coverage.some(row => row.status !== 'covered') || prior.interpretation.openQuestions.length)) intentRaise('intent_closure_unproven');
    return { ...state, works: { ...state.works, [work.workId]: { ...work, intentCoordination: { ...prior,
      revision: receipt.workRevision, lifecycle: receipt.lifecycle, closure: structuredClone(receipt), updatedAt: receipt.at } } },
    intentDecisions: { ...state.intentDecisions, [receipt.operationId]: structuredClone(receipt) } };
  }
  if (entry.kind !== 'intent_assessed' || !validIntentAssessment(entry.assessment)) intentRaise('intent_event_invalid');
  const assessment = entry.assessment, receipt = entry.receipt, prior = work.intentCoordination;
  if (assessment.workId !== work.workId || receipt?.workId !== work.workId || receipt.operationId !== assessment.operationId
    || receipt.digest !== intentDigest(assessment) || receipt.workRevision !== assessment.expectedWorkRevision + 1
    || receipt.goalRevision !== (state.mandates?.[work.workId]?.goalRevision || 0)
    || (prior?.revision || 0) !== assessment.expectedWorkRevision || state.intentDecisions?.[receipt.operationId]
    || !intentText(receipt.at, 100)) intentRaise('intent_revision_conflict');
  const interpretation = assessment.interpretation || prior?.interpretation;
  if (!validIntentInterpretation(interpretation)) intentRaise('intent_interpretation_required');
  return { ...state, works: { ...state.works, [work.workId]: { ...work, intentCoordination: {
    schemaVersion: 1, revision: receipt.workRevision, goalRevision: receipt.goalRevision, interpretation: structuredClone(interpretation),
    inputs: { ...prior?.inputs, ...Object.fromEntries(assessment.inputs.map(row => [row.inputId, structuredClone(row)])) },
    coverage: structuredClone(assessment.coverage), decision: structuredClone(assessment), lifecycle: 'active', updatedAt: receipt.at,
  } } }, intentDecisions: { ...state.intentDecisions, [receipt.operationId]: structuredClone(receipt) } };
}

/** Only the host can attest delivery, verification and absence of outstanding obligations. */
export function admitIntentClosure(state, request, host) {
  if (!host?.holdsLease) return intentReject('coordination_lease_lost');
  const work = state.works?.[request?.workId], intent = work?.intentCoordination;
  if (!intent || work.workspaceId !== host.workspaceId || work.parentConversationId !== host.parentConversationId) return intentReject('out_of_scope');
  const old = state.intentDecisions?.[request.operationId];
  if (old) return old.workId === work.workId && old.goalRevision === request.expectedGoalRevision
    && old.workRevision === request.expectedWorkRevision + 1 && old.lifecycle === request.lifecycle
    ? { ok: true, replayed: true, receipt: old } : intentReject('operation_identity_conflict');
  if (!intentText(request.operationId, 200) || intent.lifecycle !== 'active'
    || request.expectedWorkRevision !== intent.revision || request.expectedGoalRevision !== intent.goalRevision
    || intent.goalRevision !== (state.mandates?.[work.workId]?.goalRevision || 0)) return intentReject('intent_closure_conflict');
  if (request.lifecycle === 'fulfilled') {
    if (intent.decision.disposition.kind !== 'return' || intent.interpretation.openQuestions.length
      || intent.coverage.some(row => row.status !== 'covered')) return intentReject('goal_coverage_incomplete');
    const delivery = state.deliveries?.[intent.decision.disposition.replyRef];
    if (delivery?.state !== 'delivered' || (delivery.message.meta?.workId || delivery.message.workId) !== work.workId) return intentReject('goal_delivery_pending');
    if (host.pendingObligations !== false || host.verifiedGoalRevision !== intent.goalRevision || !intentText(host.reviewRef, 200)
      || intent.review?.passed !== true || intent.review.reviewRef !== host.reviewRef
      || intent.review.goalRevision !== intent.goalRevision || intent.review.intentRevision !== intent.revision) return intentReject('goal_review_required');
  } else if (request.lifecycle !== 'cancelled' || intent.decision.disposition.kind !== 'withdraw'
    || host.appliedControlRef !== intent.decision.disposition.controlRef) return intentReject('goal_control_required');
  const receipt = { operationId: request.operationId, workId: work.workId, workRevision: intent.revision + 1,
    goalRevision: intent.goalRevision, lifecycle: request.lifecycle, at: host.now,
    ...(request.lifecycle === 'fulfilled' ? { replyRef: intent.decision.disposition.replyRef, reviewRef: host.reviewRef } : { controlRef: host.appliedControlRef }) };
  return { ok: true, receipt, entry: { kind: 'intent_closed', minimumExecutorVersion: INTENT_FORMAT_VERSION, workId: work.workId, receipt } };
}
