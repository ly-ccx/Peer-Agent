import { hasUnsettledDispatch } from './recovery-policy.mjs';
import { reportedWaitCurrent } from './reported-wait.mjs';
import { workBudgetBinding } from './work-budget.mjs';

/** One automatic observer for each child-result scope. Never transfers execution authority. */
export function reconcileContinuationCustody({ store, conversationId, sessions }) {
  const state = typeof store.readSnapshot === 'function' ? store.readSnapshot() : store.read();
  const groups = new Map();
  let snapshot;
  const roster = () => snapshot ??= typeof sessions === 'function' ? sessions() : sessions;
  const prepared = new Set(Object.values(state.deliveries || {}).filter(row => row.state === 'prepared').map(row => row.message.meta?.workId));
  for (const work of Object.values(state.works)) {
    if (work.parentConversationId !== conversationId || work.anchorInputIds?.length || work.stopScope === 'work'
      || !['runnable', 'waiting_children', 'waiting_user'].includes(work.state) || !work.checkpointRef
      || work.recovery || work.pendingControl || prepared.has(work.workId) || hasUnsettledDispatch(work)
      || Object.keys(work.budget?.attempts || {}).some(id => workBudgetBinding(work.workspaceId)?.activeAttempts?.has(id))
      || Object.values(work.budget?.attempts || {}).some(attempt => attempt.pendingTools?.length)) continue;
    let checkpoint;
    try { checkpoint = store.readContinuationCheckpoint?.(work.checkpointRef) ?? store.readCheckpoint(work.checkpointRef); } catch { continue; }
    const events = checkpoint.job?.events || [];
    if (checkpoint.job?.kind !== 'wake' || checkpoint.job?.userInputs?.length || checkpoint.job?.interactive
      || !events.length || events.some(event => event.kind !== 'report_available' || !event.sessionId)) continue;
    const ids = [...new Set([...(work.sessionIds || []), ...events.map(event => event.sessionId)])].sort();
    if (!ids.length || !ids.every(id => roster().some(row => row.sessionId === id))) continue;
    const key = JSON.stringify(ids);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ work, checkpoint, ids });
  }
  for (const group of groups.values()) {
    group.sort((a, b) => Number(reportedWaitCurrent(b.work.reportedWait, roster())) - Number(reportedWaitCurrent(a.work.reportedWait, roster()))
      || String(b.work.updatedAt).localeCompare(String(a.work.updatedAt)) || a.work.workId.localeCompare(b.work.workId));
    const owner = group[0], duplicates = group.slice(1);
    const owned = new Set(Object.values(state.works).flatMap(work => [...(work.pendingEventIds || []), ...(work.consumedEventIds || [])]));
    const fresh = Object.values(state.events || {}).filter(row => !row.handled && !owned.has(row.event.eventId)
      && row.event.kind === 'report_available' && owner.ids.includes(row.event.sessionId)).map(row => row.event);
    if (!duplicates.length && !fresh.length) continue;
    const checkpoints = group.map(row => store.readCheckpoint(row.work.checkpointRef));
    if (checkpoints.some((checkpoint, index) => {
      const job = checkpoint?.job, events = job?.events || [];
      const ids = [...new Set([...(group[index].work.sessionIds || []), ...events.map(event => event.sessionId)])].sort();
      return job?.kind !== 'wake' || job.userInputs?.length || job.interactive || !events.length
        || events.some(event => event.kind !== 'report_available' || !event.sessionId)
        || JSON.stringify(ids) !== JSON.stringify(owner.ids);
    })) continue;
    const original = checkpoints[0];
    const events = [...new Map([...checkpoints.flatMap(checkpoint => checkpoint.job.events), ...fresh].map(event => [event.eventId, event])).values()];
    const checkpointRef = store.checkpoint(owner.work.workId, { ...original,
      job: { ...original.job, events, continuation: true } });
    const waiting = reportedWaitCurrent(owner.work.reportedWait, roster());
    const next = { ...owner.work, checkpointRef,
      sessionIds: owner.ids, pendingEventIds: events.map(event => event.eventId),
      progressFacts: [...new Set(group.flatMap(row => row.work.progressFacts || []))].slice(-512),
      repeats: Math.max(...group.map(row => row.work.repeats || 0)),
      ...(waiting ? {} : { state: 'runnable', reportedWait: undefined }) };
    store.coalesceWorks(next, duplicates.map(row => row.work));
    if (waiting) store.handled(events.filter(event => !state.events[event.eventId]?.handled).map(event => event.eventId));
  }
}
