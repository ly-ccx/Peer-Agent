/** Persist and publish the same accepted snapshot. Storage may advance the
 * content revision; forwarding only the input leaves live consumers behind
 * consumers which reloaded the conversation. Called for immediate and deferred
 * writes, not per chunk, so the existing disk-write throttle remains intact.
 */
export function persistContextAccounting({ store, conversationId, streamId, snapshot, emit }) {
  const saved = store.updateContextSnapshot(conversationId, snapshot);
  const accepted = saved?.contextSnapshot;
  if (accepted?.version === 1 && typeof emit === 'function') {
    emit({
      type: 'context.accounting',
      sessionId: conversationId,
      conversationId,
      streamId,
      snapshot: accepted,
    });
  }
  return accepted ?? null;
}
