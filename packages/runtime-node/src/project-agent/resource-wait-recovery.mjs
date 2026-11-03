import { runtimeSessionFacts, runtimeSessionOwnership } from '@peer-agent/protocol';
import { coordinationWorkId } from './work-coordination.mjs';
import { hasUnsettledDispatch } from './recovery-policy.mjs';
import { decideRuntimeDisposition, runtimeWorkHeld } from './runtime-disposition.ts';
import { resourceWaitScope } from './resource-wait.ts';

/** Reconcile only an admitted resource wait. No dispatch, resource release or model call. */
export function reconcileResourceWait({ work, state, sessions, port, store, now }) {
  const refs = (work.waitFor || []).filter(wait => wait.kind === 'resource');
  if (!refs.length || !['waiting_children', 'blocked_system'].includes(work.state)) return false;
  // Other failures retain their original recovery owner even if old wait refs remain.
  if (runtimeWorkHeld(work) || hasUnsettledDispatch(work) || work.recovery
    || work.state === 'blocked_system' && work.end !== 'awaiting_children') return true;
  const scope = resourceWaitScope(work, state);
  const related = (typeof sessions === 'function' ? sessions() : sessions).filter(row => scope.sessionIds.includes(row.sessionId));
  const observations = refs.map(wait => port.inspect(scope, wait));
  if (observations.some(row => row.state === 'stale' || row.state === 'unavailable')) {
    if (work.state !== 'blocked_system') store.saveWork({ ...work, state: 'blocked_system', end: 'awaiting_children' }, { returnState: false });
    return true;
  }
  if (!observations.every(row => row.state === 'ready')) {
    if (work.state === 'blocked_system') store.saveWork({ ...work, state: 'waiting_children', end: 'awaiting_children' }, { returnState: false });
    return true;
  }
  if (runtimeSessionOwnership(related).needsUser) return true;
  if (observations.some(row => !related.some(session => session.sessionId === row.sessionId && runtimeSessionFacts(session).valid))) return true;
  // Mixed waits keep their own obligations; resource readiness cannot answer a request or finish a live child.
  if ((work.waitFor || []).some(wait => wait.kind !== 'resource' && (wait.kind !== 'session'
    || !related.some(row => row.sessionId === wait.id && !runtimeSessionFacts(row).pendingManaged)))) return true;
  const events = refs.map((wait, index) => ({ workspaceId: work.workspaceId, sessionId: observations[index].sessionId,
    eventId: `resource-ready:${coordinationWorkId(work.workId,
      [work.intentCoordination?.decision.operationId || work.attemptId || '', wait.id, wait.revision])}`,
    kind: 'report_available', at: now(), payload: { reason: 'resource_available', workId: work.workId } }));
  const disposition = decideRuntimeDisposition({ previous: work, sessions: related, unseenEvents: true });
  if (disposition.state !== 'runnable') return true;
  // Transfer first: a crash before the work write reuses the same factual event on recovery.
  store.transfer(events);
  store.saveWork({ ...work, state: disposition.state, end: disposition.end,
    pendingEventIds: [...new Set([...(work.pendingEventIds || []), ...events.map(event => event.eventId)])] }, { returnState: false });
  return true;
}
