const conversations = new Map();
const observers = new Map();

export function observeExecutionHandles(conversationId, observer) {
  observers.set(conversationId, observer);
  return () => { if (observers.get(conversationId) === observer) observers.delete(conversationId); };
}
/** Provider-owned handles only. Tool text and a persisted running flag cannot register a live process. */
export function trackExecutionHandle({ conversationId, handleId, toolCallId, completion, stop, query = null }) {
  if (!conversationId) return;
  if (!handleId || !toolCallId || !completion || typeof stop !== 'function') throw new Error('execution_handle_invalid');
  const active = conversations.get(conversationId) || new Map();
  if (active.has(handleId)) throw new Error('execution_handle_conflict');
  const handle = { handleId, toolCallId, stop, query, state: 'active' };
  active.set(handleId, handle); conversations.set(conversationId, active);
  handle.completion = Promise.resolve(completion).then(output => {
    observers.get(conversationId)?.({ handleId, toolCallId, state: 'ended', completedAt: output?.completedAt || new Date().toISOString() });
    active.delete(handleId);
    if (!active.size && conversations.get(conversationId) === active) conversations.delete(conversationId);
    return output;
  }).catch(error => {
    handle.state = 'unknown';
    observers.get(conversationId)?.({ handleId, toolCallId, state: 'unknown' });
    throw error;
  });
  // Retain the rejected handle for explicit reconciliation without an unhandled rejection.
  void handle.completion.catch(() => {});
  try { observers.get(conversationId)?.({ handleId, toolCallId, state: 'active' }); }
  catch (error) { void Promise.resolve().then(stop).catch(() => {}); throw error; }
}
export function executionHandlesLive(conversationId) { return Boolean(conversations.get(conversationId)?.size); }
export async function stopExecutionHandles(conversationId) {
  const handles = [...(conversations.get(conversationId)?.values() || [])];
  const outcomes = await Promise.allSettled(handles.map(async handle => {
    try { await handle.stop(); await handle.completion; }
    catch (error) {
      const actual = await handle.query?.();
      if (actual?.taskId !== handle.handleId || !['completed', 'failed', 'cancelled', 'timeout'].includes(actual.status)
        || !Number.isFinite(Date.parse(actual.completedAt))) throw error;
      observers.get(conversationId)?.({ handleId: handle.handleId, toolCallId: handle.toolCallId, state: 'ended', completedAt: actual.completedAt });
      const active = conversations.get(conversationId); active?.delete(handle.handleId);
      if (!active?.size) conversations.delete(conversationId);
    }
  }));
  if (outcomes.some(row => row.status === 'rejected') || executionHandlesLive(conversationId)) throw new Error('execution_stop_unconfirmed');
}
