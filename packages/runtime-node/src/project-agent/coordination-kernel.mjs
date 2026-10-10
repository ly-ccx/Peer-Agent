import { createHash } from 'node:crypto';

export const COORDINATION_ACTIONS = Object.freeze(['parallel', 'augment', 'revise', 'query', 'answer', 'cancel', 'replace', 'handoff']);
const revisions = new Set(['revise', 'cancel', 'replace', 'handoff']);
const phases = { recorded: ['stopping', 'ready', 'completed', 'blocked'], stopping: ['awaiting_outcome', 'ready', 'completed', 'blocked'],
  awaiting_outcome: ['ready', 'completed', 'blocked'], ready: ['started', 'completed', 'blocked'], started: ['completed', 'blocked'], blocked: ['stopping', 'ready'], completed: [] };
const unique = values => [...new Set(values || [])];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Pure admission/reduction seam. Trusted inputs come from canonical history and the host lease. */
export function admitCoordinationDecision(state, decision, host) {
  const reject = error => ({ ok: false, error });
  if (!decision || !COORDINATION_ACTIONS.includes(decision.action)
    || typeof decision.operationId !== 'string' || !decision.operationId || typeof decision.workId !== 'string' || !decision.workId
    || typeof decision.reason !== 'string' || !decision.reason.trim()
    || !Number.isSafeInteger(decision.expectedRevision) || decision.expectedRevision < 0
    || !Array.isArray(decision.sourceInputIds) || !Array.isArray(decision.sourceEventIds)) return reject('invalid_coordination_decision');
  // Model-controlled fields must not impersonate a host-issued mandate or execution lease.
  if (Object.keys(decision).some(key => !['operationId', 'workId', 'expectedRevision', 'action', 'sourceInputIds', 'sourceEventIds', 'sessionId', 'reason', 'payload'].includes(key))) return reject('untrusted_coordination_authority');
  if (!host?.holdsLease || !host.workspaceId || !host.parentConversationId) return reject('coordination_lease_lost');
  const digest = fingerprint(decision);
  const oldDecision = state.decisions?.[decision.operationId];
  if (oldDecision) return oldDecision.digest === digest ? { ok: true, replayed: true, receipt: oldDecision } : reject('operation_identity_conflict');
  const prior = state.mandates?.[decision.workId];
  if (prior && (prior.workspaceId !== host.workspaceId || prior.parentConversationId !== host.parentConversationId)) return reject('out_of_scope');
  if ((prior?.goalRevision || 0) !== decision.expectedRevision) return reject('goal_revision_conflict');
  const inputs = unique(decision.sourceInputIds), events = unique(decision.sourceEventIds);
  if (inputs.some(id => !host.currentInputIds?.includes(id)) || events.some(id => !host.eventIds?.includes(id))) return reject('source_not_admitted');
  if (!inputs.length && !events.length) return reject('coordination_source_required');
  if (!inputs.length && (!prior || prior.lifecycle !== 'active')) return reject('mandate_inactive');
  if (!prior && (!inputs.length || decision.action !== 'parallel')) return reject('mandate_required');
  if (prior?.lifecycle === 'cancelled' || prior?.lifecycle === 'fulfilled') return reject('mandate_inactive');
  if (decision.sessionId && (!prior?.sessionIds.includes(decision.sessionId)
    || host.scopedSessionIds && !host.scopedSessionIds.includes(decision.sessionId))) return reject('out_of_scope');
  if (!inputs.length && events.some(id => !prior.sessionIds.includes(state.events?.[id]?.event?.sessionId))) return reject('event_out_of_scope');
  if (prior && !prior.allowedActions.includes(decision.action)) return reject('coordination_action_denied');
  // Quote-scoped human corrections cannot bind an unrelated goal merely because it is recent.
  if (host.scopedSessionIds && prior && !prior.sessionIds.some(id => host.scopedSessionIds.includes(id))) return reject('out_of_scope');
  const materialRefs = unique(host.materialRefs);
  if (!inputs.length && materialRefs.some(ref => !prior.materialRefs.includes(ref))) return reject('material_out_of_scope');
  const goalRevision = prior ? prior.goalRevision + (revisions.has(decision.action) ? 1 : 0) : 1;
  const mandate = { schemaVersion: 1, mandateId: prior?.mandateId || `mandate-${fingerprint([host.workspaceId, decision.workId])}`,
    workId: decision.workId, workspaceId: host.workspaceId, parentConversationId: host.parentConversationId,
    rootInputIds: prior?.rootInputIds || inputs, revisionInputIds: unique([...(prior?.revisionInputIds || []), ...inputs]),
    goalRevision, allowedActions: prior?.allowedActions || [...COORDINATION_ACTIONS], sessionIds: prior?.sessionIds || [],
    materialRefs: unique([...(prior?.materialRefs || []), ...materialRefs]), policyRevision: host.policyRevision || 'existing-project-policy',
    lifecycle: decision.action === 'cancel' ? 'cancelled' : 'active' };
  const transition = { schemaVersion: 1, operationId: decision.operationId, workId: decision.workId,
    mandateId: mandate.mandateId, expectedGoalRevision: goalRevision, sourceInputIds: inputs, sourceEventIds: events,
    initiator: 'project_agent', decisionSource: inputs.length ? 'user_revision' : 'execution_repair',
    action: decision.action, reason: decision.reason, ...(decision.sessionId ? { oldSessionId: decision.sessionId } : {}),
    executionEpoch: `execution-${fingerprint([decision.workId, goalRevision, decision.operationId])}`,
    phase: 'recorded', minimumExecutorVersion: 1, updatedAt: host.now };
  const receipt = { ...decision, digest, goalRevision, mandateId: mandate.mandateId };
  return { ok: true, entry: { kind: 'coordination_decision', mandate, receipt, transition }, receipt };
}

/** Late observations stay in task history, but cannot advance a new execution's coordination state. */
export function executionBindingCurrent(mandate, transition, binding) {
  return Boolean(mandate && transition && binding && mandate.lifecycle === 'active'
    && binding.workId === mandate.workId && binding.goalRevision === mandate.goalRevision
    && transition.expectedGoalRevision === mandate.goalRevision && transition.executionEpoch === binding.executionEpoch
    && !['stopping', 'awaiting_outcome', 'blocked'].includes(transition.phase));
}

export function reduceCoordinationDecision(state, entry) {
  const next = { ...state, mandates: { ...state.mandates }, decisions: { ...state.decisions }, transitions: { ...state.transitions }, inputBindings: { ...state.inputBindings } };
  if (entry.kind === 'coordination_decision') {
    const old = next.mandates[entry.mandate.workId];
    const decision = entry.receipt;
    if ((old?.goalRevision || 0) !== decision.expectedRevision || next.decisions[decision.operationId]) throw new Error('goal_revision_conflict');
    next.mandates[entry.mandate.workId] = structuredClone(entry.mandate);
    next.decisions[decision.operationId] = structuredClone(decision);
    next.transitions[decision.operationId] = structuredClone(entry.transition);
    for (const id of decision.sourceInputIds) next.inputBindings[id] = unique([...(next.inputBindings[id] || []), decision.operationId]);
  } else if (entry.kind === 'coordination_binding') {
    const mandate = next.mandates[entry.workId];
    if (!mandate || mandate.goalRevision !== entry.goalRevision || mandate.lifecycle !== 'active') throw new Error('goal_revision_conflict');
    next.mandates[entry.workId] = { ...mandate, sessionIds: unique([...mandate.sessionIds, entry.sessionId]) };
  } else {
    const transition = next.transitions[entry.operationId];
    if (!transition || transition.phase !== entry.expectedPhase) throw new Error('transition_phase_conflict');
    if (!phases[transition.phase]?.includes(entry.patch.phase)) throw new Error('invalid_transition_phase');
    next.transitions[entry.operationId] = { ...transition, ...entry.patch };
  }
  return next;
}
