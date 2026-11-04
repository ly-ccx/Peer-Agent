import { createHash } from 'node:crypto';
import { isCanonicalUserInput } from './user-priority.mjs';
import { validIntentAssessment, INTENT_FORMAT_VERSION, intentContentDigest } from './intent-coordination-kernel.mjs';
import { createDecisionFrame, publicEventPayload, publicDecisionText } from './decision-frame.mjs';
import { hasUnsettledDispatch } from './recovery-policy.mjs';
import { historyExecutionHeld } from './history-resumption.mjs';

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
    if (input.expectedRevision !== undefined && input.expectedRevision !== (s.mandate?.goalRevision || 0)) return { ok: false, error: 'frame_revision_changed' };
    if (input.expectedWorkRevision !== undefined && input.expectedWorkRevision !== (intent?.revision || 0)) return { ok: false, error: 'frame_revision_changed' };
    if (input.inputId) {
      const admitted = new Set([...(s.work.anchorInputIds || []), ...(s.mandate?.rootInputIds || []), ...(s.mandate?.revisionInputIds || []), ...Object.keys(intent?.inputs || {})]);
      const message = s.messages.find(row => isCanonicalUserInput(row) && (row.inputId === input.inputId || row.id === input.inputId) && admitted.has(row.inputId || row.id));
      if (!message) return { ok: false, error: 'input_out_of_scope' };
      const body = publicDecisionText(typeof message.content === 'string' ? message.content : message.text, Infinity), offset = input.payloadOffset || 0;
      if (offset > body.length) return { ok: false, error: 'input_offset_out_of_range' };
      return { ok: true, workId: s.workId, inputId: message.inputId || message.id, messageId: message.id, inputText: body.slice(offset, offset + 8000),
        payloadOffset: offset, totalCharacters: body.length, truncated: offset + 8000 < body.length,
        ...(offset + 8000 < body.length ? { nextPayloadOffset: offset + 8000 } : {}) };
    }
    if (input.eventId) {
      const event = s.state.events?.[input.eventId]?.event;
      if (!event || event.workspaceId && event.workspaceId !== s.workspaceId
        || event.sessionId && !s.mandate?.sessionIds.includes(event.sessionId) && !s.work.sessionIds?.includes(event.sessionId)
        || !event.sessionId && ![...(s.work.pendingEventIds || []), ...(s.work.consumedEventIds || []), ...(context.events || []).map(row => row.eventId)].includes(event.eventId)) return { ok: false, error: 'event_out_of_scope' };
      const payload = JSON.stringify(publicEventPayload(event, Infinity)), offset = input.payloadOffset || 0;
      if (offset > payload.length) return { ok: false, error: 'event_offset_out_of_range' };
      return { ok: true, workId: s.workId, goalRevision: s.mandate?.goalRevision || 0, eventId: event.eventId, sessionId: event.sessionId, kind: event.kind,
        payloadJson: payload.slice(offset, offset + 8000), payloadOffset: offset, totalCharacters: payload.length, truncated: offset + 8000 < payload.length,
        ...(offset + 8000 < payload.length ? { nextPayloadOffset: offset + 8000 } : {}) };
    }
    const related = (s.mandate?.sessionIds || []).map(sessionId => readSession({ sessionId })).filter(Boolean);
    if (input.afterSessionId && !related.some(row => row.sessionId === input.afterSessionId)) return { ok: false, error: 'frame_cursor_out_of_scope' };
    const frame = createDecisionFrame({ state: s.state, workspaceId: s.workspaceId, parentConversationId: s.parentConversationId,
      workId: s.workId, sessions: related, currentInputIds: s.current.map(row => row.inputId || row.id),
      originDecisionRef: context.sourceDecisionRef, turnId: context.turnId,
      eventIds: [...new Set([...(context.events || []).map(row => row.eventId), ...(s.work.pendingEventIds || [])])], afterSessionId: input.afterSessionId });
    const inputs = Object.entries(intent?.inputs || {}).sort(([a], [b]) => a.localeCompare(b));
    if (input.afterInputId && !Object.hasOwn(intent?.inputs || {}, input.afterInputId)) return { ok: false, error: 'frame_cursor_out_of_scope' };
    const inputStart = input.afterInputId ? inputs.findIndex(([id]) => id === input.afterInputId) + 1 : 0, inputPage = inputs.slice(inputStart, inputStart + 64);
    return { ok: true, workId: s.workId, workRevision: intent?.revision || 0, goalRevision: s.mandate?.goalRevision || 0,
      decisionFrame: frame,
      lifecycle: intent?.lifecycle || 'active', intent: intent ? { ...intent, inputs: Object.fromEntries(inputPage) } : null,
      inputPage: { total: inputs.length, omitted: Math.max(0, inputs.length - inputStart - inputPage.length),
        ...(inputStart + inputPage.length < inputs.length ? { afterInputId: inputPage.at(-1)[0], expectedWorkRevision: intent.revision } : {}) },
      sourceInputIds: s.current.map(row => row.inputId || row.id), sourceEventIds: (context.events || []).map(row => row.eventId),
      eventInventoryIds: [...new Set([...(context.events || []).map(row => row.eventId), ...(s.work.pendingEventIds || []), ...(s.work.consumedEventIds || [])])].slice(-128),
      sourceDecisionRef: frame?.sourceDecisionRef,
      currentReplyRef: frame.currentReplyRef,
      operations: Object.values(s.state.transitions || {}).filter(row => row.workId === s.workId).slice(-16)
        .map(row => ({ operationId: row.operationId, phase: row.phase, error: row.error })),
      availableActions: frame?.availableActions || [] };
  }
  function dispositionFailure(assessment, s, context) {
    const reject = error => ({ ok: false, error });
    const d = assessment.disposition, intent = assessment.interpretation || s.work.intentCoordination?.interpretation;
    if (d.kind === 'continue') {
      return d.operationRefs.some(ref => {
        if (ref.startsWith('requirement:')) return !intent?.requirements.some(row => `requirement:${row.requirementId}` === ref
          && assessment.coverage.some(coverage => coverage.requirementId === row.requirementId && coverage.status !== 'covered'));
        return s.state.transitions?.[ref]?.workId !== s.workId;
      }) ? reject('continuation_obligation_missing') : null;
    }
    if (d.kind === 'wait') {
      for (const wait of d.waitFor) {
        if (wait.kind === 'session') {
          const session = s.mandate?.sessionIds.includes(wait.id) ? readSession({ sessionId: wait.id }) : null;
          if (!session) return reject('wait_source_stale');
          const settled = ['accepted', 'cancelled', 'failed', 'result_ready'].includes(session.status);
          if (settled || wait.revision !== revisionOf(session)) {
            const error = reject('wait_source_stale');
            if (context.scopedSessionIds && !context.scopedSessionIds.includes(wait.id)) return error;
            return { ...error, sessionStates: [{ sessionId: wait.id, status: session.status,
              sourceRevision: session.sourceRevision, observationRevision: session.observationRevision }],
            message: settled
              ? 'The session has left this wait state. Review the current result or exception instead of retrying this wait.'
              : 'The session changed. Use its current observationRevision for a wait, or sourceRevision only if observationRevision is absent.' };
          }
        } else if (wait.kind === 'human_request') {
          const request = Object.values(s.state.agentRequests || {}).find(row => row.userRequestRef === wait.id);
          if (!request || request.status !== 'open' || request.responder !== 'user' || String(request.revision) !== wait.revision
            || !s.mandate?.sessionIds.includes(request.sessionId)) return reject('human_wait_unproven');
        } else if (wait.kind === 'recovery') {
          if (!s.work.recovery || wait.id !== s.work.recovery.reservationId || String(s.work.revision) !== wait.revision) return reject('recovery_wait_unproven');
        } else return reject('resource_adapter_unavailable'); // ADR116 is not integrated on this branch.
      }
    }
    if (d.kind === 'return' && d.replyRef !== `${context.turnId}-reply-1`
      && !(s.work.intentCoordination?.decision.operationId === assessment.operationId
        && s.work.intentCoordination.decision.disposition.replyRef === d.replyRef)) return reject('reply_reference_out_of_scope');
    if (d.kind === 'withdraw') {
      const control = s.state.transitions?.[d.controlRef], source = s.state.decisions?.[d.controlRef];
      if (!s.current.length || control?.workId !== s.workId || control.action !== 'cancel' || control.phase !== 'completed'
        || !source?.sourceInputIds.some(id => s.current.some(row => (row.inputId || row.id) === id))) return reject('withdrawal_unproven');
      if (s.mandate?.sessionIds.some(id => !['accepted', 'cancelled'].includes(readSession({ sessionId: id })?.status))) return reject('withdrawal_incomplete');
    }
    if (d.kind === 'blocked_system') {
      if (d.recoveryRef === `work:${s.workId}`) {
        if (d.code === 'intent_decision_unresolved') {
          if (s.mandate?.sessionIds.some(id => { const session = readSession({ sessionId: id });
            return ['queued', 'starting', 'running', 'verifying', 'waiting_user'].includes(session?.status)
              || session?.followUp?.owner === 'user' || session?.resultConfirmationRequired === true; })) return reject('existing_work_requires_wait');
        } else if (d.code !== s.work.recovery?.failureKind && d.code !== s.work.recovery?.blockedCode
          && !(d.code === 'execution_outcome_unknown' && hasUnsettledDispatch(s.work))) return reject('failure_reference_unproven');
      } else {
        const failure = s.state.transitions?.[d.recoveryRef];
        if (failure?.workId !== s.workId || !['blocked', 'awaiting_outcome'].includes(failure.phase) || failure.error !== d.code) return reject('failure_reference_unproven');
      }
    }
    return null;
  }
  async function assess(input, context) {
    const s = scope(context, input.assessment?.workId || input.workId); if (!s) return { ok: false, error: 'out_of_scope' };
    if (!canExecute(s.workspaceId)) return { ok: false, error: 'recovery_pending' };
    const assessment = { ...input.assessment, workId: s.workId,
      operationId: context.deliveryKey || `intent-${hash([context.turnId, context.toolCallOrdinal, input])}` };
    if (!validIntentAssessment(assessment)) return { ok: false, error: 'invalid_intent_assessment' };
    if (assessment.disposition.kind === 'return' && assessment.disposition.replyRef === 'current_turn_reply') {
      if (typeof context.turnId !== 'string' || !context.turnId) return { ok: false, error: 'reply_reference_out_of_scope' };
      assessment.disposition = { ...assessment.disposition, replyRef: `${context.turnId}-reply-1` };
    }
    const failure = dispositionFailure(assessment, s, context); if (failure) return failure;
    const sourceInputIds = s.current.map(row => row.inputId || row.id);
    const sourceEventIds = (context.events || []).map(row => row.eventId);
    const admitted = s.store.assessIntent(assessment, { parentConversationId: s.parentConversationId,
      currentInputIds: sourceInputIds, eventIds: sourceEventIds, turnId: context.turnId,
      originDecisionRef: context.sourceDecisionRef });
    if (!admitted.ok) {
      if (['work_revision_conflict', 'goal_revision_conflict'].includes(admitted.error)) {
        const current = scope(context, s.workId);
        if (current) return { ...admitted, workRevision: current.work.intentCoordination?.revision || 0,
          goalRevision: current.mandate?.goalRevision || 0,
          message: 'The work or goal revision changed. Reuse these revisions only after confirming the saved interpretation and current sources still support your assessment.' };
      }
      if (['source_not_admitted', 'input_disposition_required'].includes(admitted.error)) return { ...admitted,
        sourceInputIds, sourceEventIds,
        message: 'Use sources admitted in this turn. Supply one inputs entry for each selected sourceInputIds entry. On an event-only turn, use empty sourceInputIds and inputs arrays. Keep earlier inputs as goal context without repeating their dispositions.' };
      if (admitted.error === 'intent_revision_required') return { ...admitted,
        message: 'The goal interpretation is already recorded. Omit assessment.interpretation and keep its existing requirement IDs when updating coverage or disposition. Changing the goal requires an admitted goal revision.' };
      return admitted;
    }
    if (assessment.disposition.kind === 'withdraw') {
      s.store.closeIntent({ operationId: `close:${assessment.operationId}`, workId: s.workId,
        expectedWorkRevision: admitted.receipt.workRevision, expectedGoalRevision: admitted.receipt.goalRevision, lifecycle: 'cancelled' },
      { parentConversationId: s.parentConversationId, appliedControlRef: assessment.disposition.controlRef, pendingManagedSessions: false });
    }
    if (s.workId !== context.workId && s.current.length && !stopped(s.work) && !historyExecutionHeld(s.work)) {
      const d = assessment.disposition;
      const state = hasUnsettledDispatch(s.work) ? 'blocked_system' : d.kind === 'continue' ? 'runnable'
        : d.kind === 'wait' ? d.waitFor.some(row => row.kind === 'human_request') ? 'waiting_user' : 'waiting_children'
        : d.kind === 'return' ? 'retry_wait' : d.kind === 'withdraw' ? 'cancelled' : 'blocked_system';
      s.store.saveWork({ workId: s.workId, state, ...(d.kind === 'wait' ? { waitFor: d.waitFor } : {}),
        ...(!hasUnsettledDispatch(s.work) ? { recovery: undefined, reportedWait: undefined } : {}) }, { returnState: false });
    }
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
    const sourceIssues = intent.coverage.flatMap(row => row.sources.flatMap((source, sourceIndex) => {
      const i = sessions.findIndex(session => session.sessionId === source.sessionId);
      const session = sessions[i];
      const binding = { requirementId: row.requirementId, sessionId: source.sessionId, sourceRevision: session.sourceRevision };
      if (source.sourceRevision !== session.sourceRevision) return [{ ...binding, reason: 'source_revision_changed' }];
      const allowed = new Set(facts[i]?.evidenceIndex || []);
      const unindexedEvidenceRefIndexes = source.evidenceRefs.flatMap((ref, index) => allowed.has(ref) ? [] : [index]);
      if (source.evidenceRefs.length && !unindexedEvidenceRefIndexes.length) return [];
      return [{ ...binding, reason: 'reference_not_indexed', sourceIndex, unindexedEvidenceRefIndexes }];
    }));
    if (sourceIssues.length) return { passed: false, error: 'goal_evidence_stale', sourceIssues: sourceIssues.slice(0, 16),
      message: 'Use the current session sourceRevision and indexed references from its task report. For reference_not_indexed, sourceIndex and unindexedEvidenceRefIndexes identify the rejected entries in your submitted sources and evidenceRefs arrays, counting from zero. Keep valid task references and correct the flagged entries before resubmitting.' };
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
      const explicitVerifications = sources.flatMap(({ sessionId, sourceRevision }, i) => {
        const fact = facts[i]?.explicitVerification;
        return fact ? [{ sessionId, sourceRevision, verdictRef: fact.verdictRef, outcome: fact.outcome }] : [];
      });
      const goalReview = { workId, goalRevision: intent.goalRevision, requirements,
        interpretation: intent.interpretation, canonicalInputs: messages.map(row => ({ inputId: row.inputId || row.id, text: row.content || row.text || '' })),
        sources, explicitVerifications, evidenceRefs: result.evidenceRefs };
      try { result = await verifyGoal({ plan: facts[0].plan, workId, goalReview }); }
      catch (error) { return { passed: false, error: error.code || 'goal_verifier_failed' }; }
      if (!result || result.passed !== true || result.failedCriteria?.length || result.missingEvidence?.length
        || !result.evidenceRefs?.length) return { passed: false, error: 'goal_review_failed' };
    }
    const current = store.read();
    if (current.works[workId]?.intentCoordination?.revision !== intent.revision || current.mandates?.[workId]?.goalRevision !== intent.goalRevision
      || !sourcesCurrent({ passed: true, goalRevision: intent.goalRevision, sources }, current, workId)) return { passed: false, error: 'goal_review_stale' };
    const receipt = { reviewRef: `intent-review:${hash([workId, intent.revision, sources])}`, passed: true,
      goalRevision: intent.goalRevision, intentRevision: intent.revision, coverageDigest: intentContentDigest(intent.coverage),
      sources, evidenceRefs: [...new Set(result.evidenceRefs)].slice(0, 200), at: now() };
    store.append({ kind: 'intent_reviewed', minimumExecutorVersion: INTENT_FORMAT_VERSION, workId, review: receipt });
    return receipt;
  }
  return { query, assess, sourcesCurrent };
}

/** Closing is distinct from assessment and runs after delivery/settlement with fresh host facts. */
export function intentWorkDisposition({ work, state, sessions, store, parentConversationId, sourcesCurrent }) {
  const intent = work.intentCoordination; if (!intent) return null;
  if (intent.lifecycle !== 'active') return intent.lifecycle === 'cancelled' ? { state: 'cancelled', end: 'user_stopped' } : { state: 'delivered', end: 'delivered' };
  const disposition = intent.decision.disposition, mandate = state.mandates?.[work.workId];
  if (intent.goalRevision !== (mandate?.goalRevision || 0)) return { state: 'runnable', end: 'yielded' };
  if (disposition.kind === 'continue') return { state: 'runnable', end: 'yielded' };
  if (disposition.kind === 'wait') return { state: disposition.waitFor.some(row => row.kind === 'human_request'
    || row.kind === 'session' && sessions.some(session => session.sessionId === row.id && session.followUp?.owner === 'user')) ? 'waiting_user' : 'waiting_children', end: 'awaiting_children', waitFor: disposition.waitFor };
  if (disposition.kind === 'blocked_system') return { state: 'blocked_system', end: 'no_progress', blockedCode: disposition.code };
  if (disposition.kind === 'withdraw') {
    const result = store.closeIntent({ operationId: `close:${intent.decision.operationId}`, workId: work.workId,
      expectedWorkRevision: intent.revision, expectedGoalRevision: intent.goalRevision, lifecycle: 'cancelled' },
    { parentConversationId, appliedControlRef: disposition.controlRef, pendingManagedSessions: sessions.some(row => !['accepted', 'cancelled'].includes(row.status)) });
    return result.ok ? { state: 'cancelled', end: 'user_stopped' } : { state: 'blocked_system', end: result.error };
  }
  const pending = hasUnsettledDispatch(work) || sessions.some(row => !['accepted', 'cancelled'].includes(row.status) || row.needsUser?.length
      || row.executionOwnership?.active || row.completionReviewRequired)
    || Object.values(state.transitions || {}).some(row => row.workId === work.workId && !['completed', 'blocked'].includes(row.phase))
    || Object.values(state.agentRequests || {}).some(row => mandate?.sessionIds.includes(row.sessionId) && row.status === 'open')
    || Object.values(state.agentCommands || {}).some(row => (row.workId === work.workId || mandate?.sessionIds.includes(row.sessionId)) && ['pending', 'unknown'].includes(row.effect));
  const validReview = sourcesCurrent(intent.review, state, work.workId);
  const closed = store.closeIntent({ operationId: `close:${intent.decision.operationId}`, workId: work.workId,
    expectedWorkRevision: intent.revision, expectedGoalRevision: intent.goalRevision, lifecycle: 'fulfilled' },
  { parentConversationId, pendingObligations: pending, verifiedGoalRevision: validReview ? intent.goalRevision : undefined, reviewRef: validReview ? intent.review.reviewRef : undefined });
  return closed.ok ? { state: 'delivered', end: 'delivered' }
    : { state: pending ? sessions.some(row => row.followUp?.owner === 'user') ? 'waiting_user' : 'waiting_children' : 'blocked_system',
      end: closed.error, blockedCode: closed.error };
}
