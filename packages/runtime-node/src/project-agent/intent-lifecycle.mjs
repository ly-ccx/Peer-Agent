import { createHash } from 'node:crypto';
import { isCanonicalUserInput } from './user-priority.mjs';
import { validIntentAssessment, INTENT_FORMAT_VERSION } from './intent-coordination-kernel.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stopped = work => work?.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state);
const revisionOf = session => session.observationRevision || session.sourceRevision;

/** Semantic responsibility and closure over existing work, task and verification ports. */
export function createIntentLifecycle({ storeFor, readSession, readMessages, readGoalFacts = () => null, verifyGoal = null,
  holdsLease, canExecute, now = () => new Date().toISOString() }) {
  function scope(context, requestedId) {
    const workspaceId = context.workspaceId, parentConversationId = context.conversationId || context.parentConversationId;
    const store = storeFor(workspaceId), state = store?.readSnapshot?.() || store?.read();
    const workId = requestedId || context.workId, work = state?.works?.[workId];
    if (!store || !holdsLease(workspaceId) || !work || work.workspaceId !== workspaceId || work.parentConversationId !== parentConversationId) return null;
    const messages = readMessages(parentConversationId);
    const current = messages.filter(row => context.currentInputAnchors?.includes(row.id) && isCanonicalUserInput(row));
    // A quoted scope is an execution boundary, including for semantic assessment.
    const mandate = state.mandates?.[workId];
    if (context.scopedSessionIds && !mandate?.sessionIds.some(id => context.scopedSessionIds.includes(id))) return null;
    if (workId !== context.workId && !current.length) return null;
    return { store, state, work, workId, mandate, workspaceId, parentConversationId, current, messages };
  }
  function query(input, context) {
    const s = scope(context, input.workId); if (!s) return { ok: false, error: 'out_of_scope' };
    const intent = s.work.intentCoordination;
    return { ok: true, workId: s.workId, workRevision: intent?.revision || 0, goalRevision: s.mandate?.goalRevision || 0,
      lifecycle: intent?.lifecycle || 'active', intent: intent || null,
      sourceInputIds: s.current.map(row => row.inputId || row.id), sourceEventIds: (context.events || []).map(row => row.eventId),
      sourceDecisionRef: intent?.decision.disposition.kind === 'continue' ? intent.decision.operationId : undefined,
      currentReplyRef: `${context.turnId}-reply-1`,
      operations: Object.values(s.state.transitions || {}).filter(row => row.workId === s.workId).slice(-16)
        .map(row => ({ operationId: row.operationId, phase: row.phase, error: row.error })),
      availableActions: ['assess', 'query'].map(action => ({ action, allowed: !stopped(s.work) })) };
  }
  function dispositionError(assessment, s, context) {
    const d = assessment.disposition, intent = assessment.interpretation || s.work.intentCoordination?.interpretation;
    if (d.kind === 'continue') {
      return d.operationRefs.some(ref => {
        if (ref.startsWith('requirement:')) return !intent?.requirements.some(row => `requirement:${row.requirementId}` === ref
          && assessment.coverage.some(coverage => coverage.requirementId === row.requirementId && coverage.status !== 'covered'));
        return s.state.transitions?.[ref]?.workId !== s.workId;
      }) ? 'continuation_obligation_missing' : null;
    }
    if (d.kind === 'wait') {
      for (const wait of d.waitFor) {
        if (wait.kind === 'session') {
          const session = readSession({ sessionId: wait.id });
          if (!s.mandate?.sessionIds.includes(wait.id) || !session || wait.revision !== revisionOf(session)
            || ['accepted', 'cancelled', 'failed', 'result_ready'].includes(session.status)) return 'wait_source_stale';
        } else if (wait.kind === 'human_request') {
          const request = Object.values(s.state.agentRequests || {}).find(row => row.userRequestRef === wait.id);
          if (!request || request.status !== 'open' || request.responder !== 'user' || String(request.revision) !== wait.revision
            || !s.mandate?.sessionIds.includes(request.sessionId)) return 'human_wait_unproven';
        } else if (wait.kind === 'recovery') {
          if (!s.work.recovery || wait.id !== s.work.recovery.reservationId || String(s.work.revision) !== wait.revision) return 'recovery_wait_unproven';
        } else return 'resource_adapter_unavailable'; // ADR116 is not integrated on this branch.
      }
    }
    if (d.kind === 'return' && d.replyRef !== `${context.turnId}-reply-1`
      && s.state.deliveries?.[d.replyRef]?.message.meta?.workId !== s.workId) return 'reply_reference_out_of_scope';
    if (d.kind === 'withdraw') {
      const control = s.state.transitions?.[d.controlRef], source = s.state.decisions?.[d.controlRef];
      if (!s.current.length || control?.workId !== s.workId || control.action !== 'cancel' || control.phase !== 'completed'
        || !source?.sourceInputIds.some(id => s.current.some(row => (row.inputId || row.id) === id))) return 'withdrawal_unproven';
    }
    if (d.kind === 'blocked_system' && d.recoveryRef !== `work:${s.workId}`
      && !s.state.transitions?.[d.recoveryRef]) return 'recovery_reference_missing';
    return null;
  }
  async function assess(input, context) {
    const s = scope(context, input.assessment?.workId || input.workId); if (!s) return { ok: false, error: 'out_of_scope' };
    if (!canExecute(s.workspaceId)) return { ok: false, error: 'recovery_pending' };
    const assessment = { ...input.assessment, workId: s.workId,
      operationId: context.deliveryKey || `intent-${hash([context.turnId, context.toolCallOrdinal, input])}` };
    if (!validIntentAssessment(assessment)) return { ok: false, error: 'invalid_intent_assessment' };
    const error = dispositionError(assessment, s, context); if (error) return { ok: false, error };
    const admitted = s.store.assessIntent(assessment, { parentConversationId: s.parentConversationId,
      currentInputIds: s.current.map(row => row.inputId || row.id), eventIds: (context.events || []).map(row => row.eventId), turnId: context.turnId });
    if (!admitted.ok) return admitted;
    if (assessment.disposition.kind === 'return') {
      const reviewed = await review(s.store, s.workId);
      return { ...admitted, entry: undefined, review: reviewed, nextAction: reviewed.passed ? 'deliver_referenced_reply' : 'resolve_remaining_goal_obligations' };
    }
    return { ...admitted, entry: undefined };
  }
  function sourcesCurrent(review, state, workId) {
    return review?.passed === true && review.goalRevision === state.mandates?.[workId]?.goalRevision
      && review.sources.every(source => {
        const session = readSession({ sessionId: source.sessionId });
        return session?.sourceRevision === source.sourceRevision;
      });
  }
  async function review(store, workId) {
    const state = store.read(), intent = state.works[workId]?.intentCoordination, mandate = state.mandates?.[workId];
    if (!intent || intent.coverage.some(row => row.status !== 'covered') || intent.interpretation.openQuestions.length) return { passed: false, error: 'goal_coverage_incomplete' };
    if (intent.review?.intentRevision === intent.revision && sourcesCurrent(intent.review, state, workId)) return intent.review;
    const sourceRows = intent.coverage.flatMap(row => row.sources);
    const sessions = [...new Set(sourceRows.map(row => row.sessionId))].map(sessionId => readSession({ sessionId }));
    if (!sessions.length || sessions.some(row => !row || !mandate?.sessionIds.includes(row.sessionId))) return { passed: false, error: 'goal_evidence_missing' };
    const facts = sessions.map(session => readGoalFacts(session.sessionId));
    if (sourceRows.some(source => {
      const i = sessions.findIndex(row => row.sessionId === source.sessionId), allowed = new Set(facts[i]?.evidenceIndex || []);
      return source.sourceRevision !== sessions[i].sourceRevision || !source.evidenceRefs.length || source.evidenceRefs.some(ref => !allowed.has(ref));
    })) return { passed: false, error: 'goal_evidence_stale' };
    const sources = sessions.map(row => ({ sessionId: row.sessionId, sourceRevision: row.sourceRevision, observationRevision: revisionOf(row) }));
    const requirements = intent.interpretation.requirements;
    const inputIds = new Set([...(mandate.rootInputIds || []), ...(mandate.revisionInputIds || [])]);
    const messages = readMessages(mandate.parentConversationId).filter(row => isCanonicalUserInput(row) && inputIds.has(row.inputId || row.id));
    const rootText = messages.map(row => row.content || row.text || '').join('\n').trim();
    const reusable = rootText && intent.interpretation.outcome === rootText && requirements.every(requirement => intent.coverage.find(row => row.requirementId === requirement.requirementId).sources.some(source => {
      const i = sessions.findIndex(row => row.sessionId === source.sessionId), fact = facts[i];
      return fact?.independentVerifier === 'passed' && fact.plan?.goal === rootText
        && fact.plan?.successCriteria?.some(criterion => criterion.description === requirement.text);
    }));
    let result = { passed: reusable, evidenceRefs: [...new Set(sourceRows.flatMap(row => row.evidenceRefs))] };
    if (!reusable) {
      if (!verifyGoal || !facts[0]?.plan) return { passed: false, error: 'goal_verifier_unavailable' };
      const goalReview = { workId, goalRevision: intent.goalRevision, requirements,
        interpretation: intent.interpretation, canonicalInputs: messages.map(row => ({ inputId: row.inputId || row.id, text: row.content || row.text || '' })),
        sources, evidenceRefs: result.evidenceRefs };
      try { result = await verifyGoal({ plan: facts[0].plan, workId, goalReview }); }
      catch (error) { return { passed: false, error: error.code || 'goal_verifier_failed' }; }
      if (!result || result.passed !== true || result.failedCriteria?.length || result.missingEvidence?.length
        || !result.evidenceRefs?.length) return { passed: false, error: 'goal_review_failed' };
    }
    const current = store.read();
    if (current.works[workId]?.intentCoordination?.revision !== intent.revision || current.mandates?.[workId]?.goalRevision !== intent.goalRevision
      || !sourcesCurrent({ passed: true, goalRevision: intent.goalRevision, sources }, current, workId)) return { passed: false, error: 'goal_review_stale' };
    const receipt = { reviewRef: `intent-review:${hash([workId, intent.revision, sources])}`, passed: true,
      goalRevision: intent.goalRevision, intentRevision: intent.revision, coverageDigest: hash(intent.coverage),
      sources, evidenceRefs: [...new Set(result.evidenceRefs)].slice(0, 200), at: now() };
    store.append({ kind: 'intent_reviewed', minimumExecutorVersion: INTENT_FORMAT_VERSION, workId, review: receipt });
    return receipt;
  }
  return { query, assess, sourcesCurrent };
}

/** Closing is distinct from assessment and runs after delivery/settlement with fresh host facts. */
export function intentWorkDisposition({ work, state, sessions, store, parentConversationId, sourcesCurrent }) {
  const intent = work.intentCoordination; if (!intent || intent.lifecycle !== 'active') return null;
  const disposition = intent.decision.disposition, mandate = state.mandates?.[work.workId];
  if (intent.goalRevision !== (mandate?.goalRevision || 0)) return { state: 'runnable', end: 'yielded' };
  if (disposition.kind === 'continue') return { state: 'runnable', end: 'yielded' };
  if (disposition.kind === 'wait') return { state: disposition.waitFor.some(row => row.kind === 'human_request') ? 'waiting_user' : 'waiting_children', end: 'awaiting_children', waitFor: disposition.waitFor };
  if (disposition.kind === 'blocked_system') return { state: 'blocked_system', end: 'no_progress', blockedCode: disposition.code };
  if (disposition.kind === 'withdraw') {
    const result = store.closeIntent({ operationId: `close:${intent.decision.operationId}`, workId: work.workId,
      expectedWorkRevision: intent.revision, expectedGoalRevision: intent.goalRevision, lifecycle: 'cancelled' },
    { parentConversationId, appliedControlRef: disposition.controlRef });
    return result.ok ? { state: 'cancelled', end: 'user_stopped' } : { state: 'blocked_system', end: result.error };
  }
  const pending = sessions.some(row => !['accepted', 'cancelled'].includes(row.status) || row.needsUser?.length
      || row.executionOwnership?.active || row.completionReviewRequired)
    || Object.values(state.transitions || {}).some(row => row.workId === work.workId && !['completed', 'blocked'].includes(row.phase))
    || Object.values(state.agentRequests || {}).some(row => mandate?.sessionIds.includes(row.sessionId) && row.status === 'open')
    || Object.values(state.agentCommands || {}).some(row => row.workId === work.workId && ['pending', 'unknown'].includes(row.effect));
  const validReview = sourcesCurrent(intent.review, state, work.workId);
  const closed = store.closeIntent({ operationId: `close:${intent.decision.operationId}`, workId: work.workId,
    expectedWorkRevision: intent.revision, expectedGoalRevision: intent.goalRevision, lifecycle: 'fulfilled' },
  { parentConversationId, pendingObligations: pending, verifiedGoalRevision: validReview ? intent.goalRevision : undefined, reviewRef: validReview ? intent.review.reviewRef : undefined });
  return closed.ok ? { state: 'delivered', end: 'delivered' }
    : { state: pending ? sessions.some(row => row.followUp?.owner === 'user') ? 'waiting_user' : 'waiting_children' : 'blocked_system',
      end: closed.error, blockedCode: closed.error };
}

export const intentReviewCurrent = (review, state, workId, sessions) => Boolean(review?.passed && review.goalRevision === state.mandates?.[workId]?.goalRevision
  && review.sources.every(source => sessions.some(row => row.sessionId === source.sessionId && row.sourceRevision === source.sourceRevision)));
