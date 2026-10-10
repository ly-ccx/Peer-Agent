import { createHash } from 'node:crypto';
import { workBudgetBinding } from './work-budget.mjs';
import { isCanonicalUserInput } from './user-priority.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ended = new Set(['accepted', 'result_ready', 'cancelled']);

/** Recoverable coordination effects over the existing task ports, never a second task engine. */
export function createCoordinationLifecycle({ readSession, readMessages, checkTakeover, spawn, requestCancel, send, takeover, holdsLease, isEnabled = () => true }) {
  const drains = new Map();
  const queued = new Set();
  const storeFor = workspaceId => workBudgetBinding(workspaceId)?.store;
  function lifecycleOf(state, mandate) {
    const work=state.works[mandate.workId];
    if (work?.stopScope === 'work' && ['paused','cancelled'].includes(work.state)) return 'cancelled';
    const sessions=mandate.sessionIds.map(sessionId=>readSession({sessionId}));
    const pending=Object.values(state.transitions || {}).some(row=>row.workId===mandate.workId && !['completed','blocked'].includes(row.phase));
    return sessions.length && sessions.every(row=>row && ['accepted','cancelled'].includes(row.status)) && !pending ? 'fulfilled' : mandate.lifecycle;
  }
  function facts(workspaceId, parentConversationId) {
    const state = storeFor(workspaceId)?.read();
    return Object.values(state?.mandates || {}).filter(row => row.parentConversationId === parentConversationId)
      .slice(-24).map(row => ({ workId: row.workId, goalRevision: row.goalRevision, lifecycle: lifecycleOf(state,row),
        sessionIds: row.sessionIds.filter(id => !row.revokedSessionIds?.includes(id)), rootInputIds: row.rootInputIds,
        transitions: Object.values(state.transitions || {}).filter(item => item.workId === row.workId && item.phase !== 'completed')
          .slice(-8).map(item => ({ operationId: item.operationId, action: item.action, phase: item.phase, oldSessionId: item.oldSessionId, replacementSessionId: item.replacementSessionId })) }));
  }
  async function coordinate(input, context) {
    if (!isEnabled()) return {ok:false,error:'autonomous_coordination_disabled'};
    const workspaceId = context.workspaceId, parentConversationId = context.conversationId || context.parentConversationId;
    const store = storeFor(workspaceId);
    if (!store || !holdsLease(workspaceId)) return { ok: false, error: 'coordination_host_unavailable' };
    const operationId = context.deliveryKey || `coordination-${hash([context.turnId, context.toolCallOrdinal, input])}`;
    const state = store.read();
    const current = readMessages(parentConversationId).filter(row => context.currentInputAnchors?.includes(row.id) && isCanonicalUserInput(row));
    const sourceInputIds = current.map(row => row.inputId || row.id);
    const events = context.events || [];
    const previous = state.decisions?.[operationId];
    if (previous) {
      if (previous.payload?.requestIdentity !== hash(input)) return { ok: false, error: 'operation_identity_conflict' };
      const owner = state.mandates[previous.workId];
      if (owner.workspaceId !== workspaceId || owner.parentConversationId !== parentConversationId
        || !previous.sourceInputIds.some(id => sourceInputIds.includes(id)) && !previous.sourceEventIds.some(id => events.some(row => row.eventId === id))) return { ok: false, error: 'out_of_scope' };
      await recover(workspaceId);
      return receipt(store, operationId, true);
    }
    let target = input.sessionId ? readSession({ sessionId: input.sessionId, detail: 'report' }) : null;
    if (input.sessionId && (!target || target.workspaceId !== workspaceId || target.origin?.parentConversationId !== parentConversationId)) return { ok: false, error: 'out_of_scope' };
    // Follow only durable replacement lineage; never pick a task by recency.
    const scopedSessionIds = context.scopedSessionIds ? [...context.scopedSessionIds] : undefined;
    if (scopedSessionIds && input.sessionId && !scopedSessionIds.includes(input.sessionId)) return { ok: false, error: 'out_of_scope' };
    const seen = new Set();
    while (target && !seen.has(target.sessionId)) {
      seen.add(target.sessionId);
      const replacement = Object.values(state.transitions || {}).findLast(row => row.oldSessionId === target.sessionId && row.action === 'replace' && row.replacementSessionId);
      if (!replacement || ['query', 'answer'].includes(input.action)) break;
      const next = readSession({ sessionId: replacement.replacementSessionId, detail: 'report' });
      if (!next || next.workspaceId !== workspaceId || next.origin?.parentConversationId !== parentConversationId) return { ok: false, error: 'out_of_scope' };
      target = next; scopedSessionIds?.push(next.sessionId);
    }
    if (target && ['handoff', 'revise'].includes(input.action)) {
      const blocked = checkTakeover?.(target.sessionId);
      if (blocked) return { ok: false, error: blocked };
    }
    const workId = input.workId || target?.origin?.workId || Object.values(state.mandates || {}).find(row => row.sessionIds.includes(target?.sessionId))?.workId || context.workId;
    const mandate = state.mandates?.[workId];
    if (!current.length && mandate && lifecycleOf(state,mandate) !== 'active') return {ok:false,error:'mandate_inactive'};
    const work = state.works[workId];
    if (!work || work.parentConversationId !== parentConversationId || work.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state)) return { ok: false, error: 'work_execution_stopped' };
    const eventIds = events.filter(row => mandate?.sessionIds.includes(row.sessionId) && state.events[row.eventId] && !state.events[row.eventId].handled).map(row => row.eventId);
    const materialRefs = current.flatMap(row => [...(row.attachmentRefs || []), ...(row.attachments || []).map(item => item.path || item.ref || item.id).filter(Boolean)]);
    const anchors = [...new Set([...current.map(row => row.id), ...readMessages(parentConversationId)
      .filter(row => [...(mandate?.rootInputIds || []), ...(mandate?.revisionInputIds || [])].includes(row.inputId || row.id) && isCanonicalUserInput(row)).map(row => row.id)])];
    if (!anchors.length) return { ok: false, error: 'current_user_required' };
    if (input.task && input.task.anchorMessageIds.some(id => !anchors.includes(id))) return { ok: false, error: 'material_out_of_scope' };
    const decision = { operationId, workId, expectedRevision: input.expectedRevision ?? (input.action === 'parallel' ? mandate?.goalRevision || 0 : -1),
      action: input.action, sourceInputIds, sourceEventIds: sourceInputIds.length ? [] : eventIds,
      ...(target ? { sessionId: target.sessionId } : {}), reason: input.reason,
      payload: { requestIdentity: hash(input), ...(input.task ? { task: input.task } : {}), ...(input.text ? { text: input.text } : {}), ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        context: { workspaceId, parentConversationId, workspacePath: context.workspacePath || '', surface: context.surface,
          anchorMessageIds: anchors, currentInputAnchors: current.map(row => row.id),
          ...(context.manualCriterionAuthorities ? { manualCriterionAuthorities: context.manualCriterionAuthorities } : {}) } } };
    const failures = Object.values(state.decisions || {}).filter(row => row.workId === workId && JSON.stringify(row.sourceInputIds) === JSON.stringify(decision.sourceInputIds)
      && row.action === decision.action && row.sessionId === decision.sessionId && row.reason === decision.reason
      && state.transitions?.[row.operationId]?.phase === 'blocked');
    if (failures.length >= 2) return { ok: false, error: 'coordination_no_progress' };
    const admitted = store.decide(decision, { parentConversationId, currentInputIds: sourceInputIds, eventIds, materialRefs,
      ...(!mandate && current.length && target ? { adoptSessionIds: [target.sessionId] } : {}),
      ...(scopedSessionIds ? { scopedSessionIds } : {}) });
    if (!admitted.ok) return admitted;
    await recover(workspaceId);
    return receipt(store, operationId, admitted.replayed === true);
  }
  function receipt(store, operationId, replayed) {
    const state = store.read(), transition = state.transitions[operationId], decision = state.decisions[operationId];
    return { ok: !transition.error, replayed, workId: decision.workId, goalRevision: decision.goalRevision,
      operationId, phase: transition.phase, sessionId: transition.replacementSessionId || transition.oldSessionId,
      ...(decision.action === 'query' ? { session: readSession({sessionId: transition.oldSessionId, detail: 'report'}) } : {}),
      ...(transition.error ? { error: transition.error } : {}) };
  }
  async function effect(store, transition) {
    // Rollback continues registered cancellation, without dispatching new work.
    if (!isEnabled() && !['cancel','replace'].includes(transition.action)) return;
    const read = () => store.read().transitions[transition.operationId];
    const move = (phase, patch = {}) => { const current = read(); store.advanceTransition(current.operationId, current.phase, { phase, ...patch }); return read(); };
    const state = store.read(), mandate = state.mandates[transition.workId], decision = state.decisions[transition.operationId];
    if (!mandate || mandate.goalRevision !== transition.expectedGoalRevision) {
      if (!['blocked', 'completed'].includes(transition.phase)) move('blocked', { error: 'goal_revision_stale' });
      return;
    }
    const current = () => holdsLease(mandate.workspaceId) && store.read().mandates[mandate.workId]?.goalRevision === transition.expectedGoalRevision;
    const binding = { workId: mandate.workId, goalRevision: mandate.goalRevision, executionEpoch: transition.executionEpoch };
    const payload = decision.payload, context = { ...payload.context, workId: mandate.workId, coordinationBinding: binding, coordinationOperationId: transition.operationId, deliveryKey: transition.operationId };
    const old = transition.oldSessionId ? readSession({ sessionId: transition.oldSessionId, detail: 'report' }) : null;
    if (transition.phase === 'recorded') {
      if (['replace', 'cancel', 'handoff', 'revise'].includes(transition.action) && old && !ended.has(old.status)) {
        move('stopping');
        if (['replace', 'cancel'].includes(transition.action)) {
          const requested = await requestCancel({ sessionId: old.sessionId, reason: transition.reason, operationId: transition.operationId, promote: false });
          if (requested?.error) { move('blocked', { error: requested.error }); return; }
        }
      } else move('ready');
    }
    let phase = read().phase;
    if (phase === 'stopping') {
      if (['handoff', 'revise'].includes(transition.action)) {
        const result = await takeover({ sessionId: old.sessionId, binding, text: payload.text || transition.reason,
          operationId: transition.operationId }, context);
        if (result?.error) { move(result.error === 'execution_outcome_unknown' ? 'awaiting_outcome' : 'blocked', { error: result.error }); return; }
        if (result?.pending) return;
        move('completed'); return;
      }
      const fresh = readSession({ sessionId: old.sessionId, detail: 'report' });
      if (fresh?.origin?.cancellation?.phase === 'awaiting_outcome') { move('awaiting_outcome', { error: 'execution_outcome_unknown' }); return; }
      if (fresh?.status !== 'cancelled' && !ended.has(fresh?.status)) {
        const result = await requestCancel({ sessionId: old.sessionId, reason: transition.reason, operationId: transition.operationId, promote: false });
        if (result?.error) move('blocked', { error: result.error });
        return;
      }
      move('ready', { handoff: { sourceSessionId: old.sessionId, summary: (fresh?.report?.summary || '').slice(0, 4000),
        evidenceRefs: (fresh?.report?.evidenceRefs || []).slice(0, 32) } });
    }
    phase = read().phase;
    if (phase === 'awaiting_outcome' || phase === 'blocked' || phase === 'completed') return;
    if (!current()) { move('blocked', { error: 'goal_revision_stale' }); return; }
    if (phase === 'started') { move('completed'); return; }
    if (phase === 'ready' && ['parallel', 'replace'].includes(transition.action)) {
      if (!isEnabled()) return;
      const handoff = read().handoff;
      const result = await spawn({ ...payload.task, anchorMessageIds: payload.task.anchorMessageIds,
        ...(handoff?.summary ? { brief: `${payload.task.brief}\nRetained work (historical facts, recheck applicability):\n${handoff.summary}`.slice(0, 4000) } : {}) }, context);
      if (!result?.sessionId || result.error) { move('blocked', { error: result?.error || 'spawn_failed' }); return; }
      move('started', { replacementSessionId: result.sessionId });
      move('completed'); return;
    }
    if (phase === 'ready' && ['augment', 'answer'].includes(transition.action)) {
      const result = await send({ sessionId: old.sessionId, text: payload.text, purpose: transition.action === 'answer' ? 'answer' : 'update',
        ...(payload.replyTo ? { replyTo: payload.replyTo } : {}) }, { ...context, role: 'project_agent', conversationId: mandate.parentConversationId });
      if (result?.ok === false || result?.error) { move('blocked', { error: result.error || 'agent_message_failed' }); return; }
    }
    if (read().phase === 'ready') move('completed');
  }
  function recover(workspaceId) {
    if (drains.has(workspaceId)) { queued.add(workspaceId); return drains.get(workspaceId); }
    const store = storeFor(workspaceId);
    if (!store || !holdsLease(workspaceId)) return Promise.resolve();
    const promise = Promise.resolve().then(async () => {
      for (const transition of Object.values(store.read().transitions || {})) {
        if (['completed', 'blocked', 'awaiting_outcome'].includes(transition.phase)) continue;
        try { store.assertOwner(); await effect(store, transition); }
        catch (error) {
          if (!holdsLease(workspaceId)) return;
          const current = store.read().transitions[transition.operationId];
          if (!['completed', 'blocked', 'awaiting_outcome'].includes(current.phase)) store.advanceTransition(current.operationId, current.phase,
            { phase: 'blocked', error: error?.message || 'coordination_failed' });
        }
      }
    }).finally(() => { drains.delete(workspaceId); if (queued.delete(workspaceId)) void recover(workspaceId); });
    drains.set(workspaceId, promise); return promise;
  }
  function forSession(workspaceId, sessionId) {
    const state=storeFor(workspaceId)?.read();
    const related=Object.values(state?.transitions || {}).filter(row=>row.action!=='query' && (row.oldSessionId===sessionId || row.replacementSessionId===sessionId));
    const transition=related.at(-1);
    if (!transition) return undefined;
    const lineage=related.findLast(row=>row.action==='replace' && row.replacementSessionId) || transition;
    return {operationId:transition.operationId,action:transition.action,phase:transition.phase,reason:transition.reason,
      goalRevision:transition.expectedGoalRevision, ...(lineage.action === 'replace' ? {
        priorSessionId:lineage.oldSessionId, replacementSessionId:lineage.replacementSessionId,
        replacementTitle:state.decisions[lineage.operationId].payload?.task?.title} : {})};
  }
  return { coordinate, recover, facts, forSession };
}
