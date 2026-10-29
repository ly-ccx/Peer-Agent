import { repairOwnership } from './repair-ownership.mjs';
import { hasUnsettledDispatch, recoveryCheckpointAvailable } from './recovery-policy.mjs';
import { historyExecutionHeld } from './history-resumption.mjs';
import { workBudgetBinding } from './work-budget.mjs';

/** Reclaim an existing obligation, never create another observer or replay completed tools. */
export function reconcileRepairCustody({ store, conversationId, sessions }) {
  let snapshot;
  const roster = () => snapshot ??= typeof sessions === 'function' ? sessions() : sessions;
  const state = store.readSnapshot?.() ?? store.read();
  const works = Object.values(state.works);
  const candidates = works.filter(work => work.parentConversationId === conversationId
    && ['delivered','waiting_user'].includes(work.state) && work.checkpointRef
    && work.stopScope !== 'work' && !historyExecutionHeld(work) && !work.pendingControl
    && !work.reportedWait && !work.recovery?.blockedCode && !hasUnsettledDispatch(work)
    && !Object.keys(work.budget?.attempts || {}).some(id => workBudgetBinding(work.workspaceId)?.activeAttempts?.has(id)))
    .sort((a,b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.workId.localeCompare(b.workId));
  const claimed = new Set(works.filter(work => work.parentConversationId === conversationId
    && !historyExecutionHeld(work) && !['delivered','cancelled','coalesced','paused'].includes(work.state))
    .filter(work => !candidates.includes(work)).flatMap(work => work.repairSessionIds?.length ? work.repairSessionIds : work.sessionIds || []));
  for (const work of candidates) {
    const related = (work.sessionIds || []).map(id => roster().find(row => row.sessionId === id));
    if (!related.length || related.some(row => !row)) continue;
    const ownership = repairOwnership(related);
    if (ownership.needsUser || !ownership.repairSessionIds.length || ownership.repairSessionIds.some(id => claimed.has(id))) continue;
    let checkpoint;
    try { checkpoint = store.readCheckpoint(work.checkpointRef); } catch { continue; }
    if (!checkpoint?.outcome || checkpoint.outcome.failed || checkpoint.outcome.stopped || checkpoint.outcome.yielded) continue;
    const next = {...work,repairSessionIds:ownership.repairSessionIds};
    if (!recoveryCheckpointAvailable(next,checkpoint,store.readCheckpoint)) continue;
    store.saveWork({...next,state:'runnable',end:'yielded'}, {returnState:false});
    ownership.repairSessionIds.forEach(id => claimed.add(id));
  }
}
