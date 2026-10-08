import { workBudgetBinding } from './work-budget.mjs';

/** Scope commands close host admission before touching any associated execution. */
export async function controlProjectWork({ session, action, anchorMessageId, context, sessions, pause, cancel, resume }) {
  if (!['pause', 'cancel', 'resume'].includes(action)) return { error: 'invalid_work_action' };
  const binding = workBudgetBinding(context.workspaceId);
  const store = binding?.store;
  const work = store?.read().works[session?.origin?.workId];
  if (!work || work.parentConversationId !== context.parentConversationId) return { error: 'work_not_found' };
  const receiptKey = `${action}:${anchorMessageId}`;
  if (work.lastControl?.receiptKey === receiptKey) return { ok: true, replayed: true, workId: work.workId, state: work.state };
  const pendingSame = work.pendingControl?.action === action && work.pendingControl?.anchorMessageId === anchorMessageId;
  if (['cancelled', 'delivered'].includes(work.state) && !pendingSame) return { error: 'work_already_ended' };
  if (action === 'resume' && (work.state !== 'paused' || work.stopScope !== 'work')) return { error: 'work_not_paused' };
  const targets = sessions().filter(row => row.origin?.workId === work.workId && !work.pendingControl?.completedSessionIds?.includes(row.sessionId)
    && !['accepted', 'result_ready', 'cancelled', 'failed', 'superseded'].includes(row.status));
  const state = action === 'cancel' ? 'cancelled' : 'paused';
  // A partial failure keeps the gate closed; the same command can finish its remaining targets.
  store.saveWork({ ...work, state, stopScope: 'work', pendingControl: { action, anchorMessageId, completedSessionIds: pendingSame ? work.pendingControl.completedSessionIds || [] : [] } });
  for (const target of targets) {
    const result = await (action === 'pause' ? pause(target.sessionId) : action === 'cancel' ? cancel(target.sessionId) : resume(target.sessionId, anchorMessageId));
    if (result?.error || result?.ok === false) return { error: result.error || 'work_control_failed' };
    const current = store.read().works[work.workId];
    store.saveWork({ ...current, pendingControl: { ...current.pendingControl, completedSessionIds: [...current.pendingControl.completedSessionIds, target.sessionId] } });
  }
  const fresh = store.read().works[work.workId];
  store.saveWork({ ...fresh, state: action === 'resume' ? fresh.pendingControl.completedSessionIds.length ? 'waiting_children' : 'runnable' : state,
    pendingControl: null, lastControl: { receiptKey, action, anchorMessageId } });
  return { ok: true, workId: work.workId, state: store.read().works[work.workId].state };
}
