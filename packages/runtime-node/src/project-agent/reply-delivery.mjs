import { historyExecutionHeld } from './history-resumption.mjs';
/** Recover each persisted step. append must be idempotent by message id. Acceptance remains a host port. */
export function createReplyDelivery({ store, readMessages, appendMessage, accept = null, validate = () => true, onRecovered = null, onInvalidated = null }) {
  const readSnapshot = () => typeof store.readSnapshot === 'function' ? store.readSnapshot() : store.read();
  const held = (message, state = readSnapshot()) => historyExecutionHeld(state.works[message.meta?.workId])
    || state.lastRecovery?.quarantinedDeliveryIds?.includes(message.id);
  async function deliver(message) {
    store.assertOwner();
    const saved = readSnapshot().deliveries[message.id];
    if (held(message)) return { held: true };
    if (saved?.state === 'delivered') return { delivered: true };
    if (saved?.state === 'invalidated') return { invalidated: true };
    if (!validate(message)) throw new Error('reply_source_changed');
    if (!readSnapshot().deliveries[message.id]) store.append({ kind: 'reply_prepared', message });
    if (!readMessages().some(row => row.id === message.id)) {
      store.assertOwner(); appendMessage(message);
    }
    if (accept) { store.assertOwner(); if (!validate(message)) throw new Error('reply_source_changed'); await accept(message); }
    store.append({ kind: 'reply_delivered', messageId: message.id });
    return { delivered: true };
  }
  return {
    deliver,
    prepare(messages) {
      store.assertOwner();
      const snapshot = readSnapshot();
      if (messages.some(message => held(message, snapshot))) throw new Error('coordination_reconciliation_required');
      if (!messages.every(validate)) throw new Error('reply_source_changed');
      for (const message of messages) if (!readSnapshot().deliveries[message.id]) store.append({ kind: 'reply_prepared', message });
    },
    async recover() {
      const snapshot = readSnapshot();
      for (const row of Object.values(snapshot.deliveries)) {
        const message = structuredClone(row.message);
        if (held(message, snapshot)) continue;
        // A crash can occur after delivery but before the work/handled receipts.
        if (row.state === 'delivered') { await onRecovered?.(message); continue; }
        if (row.state !== 'prepared') continue;
        if (!validate(message)) {
          store.append({ kind: 'reply_invalidated', messageId: message.id, reason: 'reply_source_changed' });
          await onInvalidated?.(message);
          continue;
        }
        await deliver(message);
        await onRecovered?.(message);
      }
    },
    pending: () => { const snapshot = readSnapshot(); return Object.values(snapshot.deliveries).some(row => row.state === 'prepared' && !held(row.message, snapshot)); },
  };
}
