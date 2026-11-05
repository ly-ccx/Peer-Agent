import { workBudgetBinding } from './work-budget.mjs';
import { sessionNeedsCancellation } from './session-cancellation.mjs';

const workControlQueues = new WeakMap();

/** Scope commands close host admission before touching any associated execution. */
export async function controlProjectWork(command) {
  const { session, action, context } = command;
  if (!['pause', 'cancel', 'resume'].includes(action)) return { error: 'invalid_work_action' };
  const store = workBudgetBinding(context.workspaceId)?.store;
  const workId = session?.origin?.workId;
  if (!store || !workId) return { error: 'work_not_found' };

  let queue = workControlQueues.get(store);
  if (!queue) workControlQueues.set(store, queue = new Map());
  const result = (queue.get(workId) || Promise.resolve()).then(() => applyWorkControl(store, workId, command));
  const tail = result.catch(() => {});
  queue.set(workId, tail);
  try { return await result; }
  finally { if (queue.get(workId) === tail) queue.delete(workId); }
}

async function applyWorkControl(store, workId, { action, anchorMessageId, context, sessions, pause, cancel, resume }) {
  const work = store.read().works[workId];
  if (!work || work.parentConversationId !== context.parentConversationId) return { error: 'work_not_found' };
  const receiptKey = `${action}:${anchorMessageId}`;
  const replayed = work.lastControl?.receiptKey === receiptKey;
  if (replayed && action !== 'cancel') return { ok: true, replayed: true, workId: work.workId, state: work.state };
  const pendingSame = work.pendingControl?.action === action && work.pendingControl?.anchorMessageId === anchorMessageId;
  const ended = ['cancelled', 'delivered', 'coalesced'].includes(work.state);
  if (ended && !pendingSame && (action !== 'cancel' || work.state === 'coalesced')) return { error: 'work_already_ended' };
  if (action === 'resume') {
    if (work.pendingControl && !pendingSame) return { error: 'work_control_pending' };
    if (work.state !== 'paused' || work.stopScope !== 'work') return { error: 'work_not_paused' };
  }
  const completedSessionIds = pendingSame ? work.pendingControl.completedSessionIds || [] : [];
  const targets = sessions().filter(row => row.origin?.workId === work.workId && !completedSessionIds.includes(row.sessionId)
    && (action === 'cancel' ? sessionNeedsCancellation(row) : !['accepted', 'result_ready', 'cancelled', 'failed', 'superseded'].includes(row.status)));
  if (replayed && !pendingSame && !targets.length) return { ok: true, replayed: true, workId: work.workId, state: work.state };
  if (action === 'cancel' && ended && !pendingSame && !targets.length) return { ok: true, alreadySettled: true, workId: work.workId, state: work.state };
  const state = action === 'cancel' ? 'cancelled' : 'paused';
  // A partial failure keeps the gate closed; the same command can finish its remaining targets.
  store.saveWork({ ...work, state, stopScope: 'work', pendingControl: { action, anchorMessageId, completedSessionIds } }, { returnState: false });
  for (const target of targets) {
    const result = await (action === 'pause' ? pause(target.sessionId) : action === 'cancel' ? cancel(target.sessionId) : resume(target.sessionId, anchorMessageId));
    if (result?.error || result?.ok === false) return { error: result.error || 'work_control_failed' };
    const current = store.read().works[work.workId];
    store.saveWork({ ...current, pendingControl: { ...current.pendingControl, completedSessionIds: [...current.pendingControl.completedSessionIds, target.sessionId] } }, { returnState: false });
  }
  const fresh = store.read().works[work.workId];
  store.saveWork({ ...fresh, state: action === 'resume' ? fresh.pendingControl.completedSessionIds.length ? 'waiting_children' : 'runnable' : state,
    stopScope: action === 'resume' ? 'reply' : 'work',
    end: action === 'resume' ? fresh.pendingControl.completedSessionIds.length ? 'awaiting_children' : 'yielded' : 'user_stopped',
    pendingControl: null, lastControl: { receiptKey, action, anchorMessageId } }, { returnState: false });
  return { ok: true, workId: work.workId, state: store.read().works[work.workId].state };
}
