/** Recover each persisted step. append must be idempotent by message id. Acceptance remains a host port. */
export function createReplyDelivery({ store, readMessages, appendMessage, accept = null, validate = () => true, onRecovered = null, onInvalidated = null }) {
  async function deliver(message) {
    store.assertOwner();
    const saved = store.read().deliveries[message.id];
    if (saved?.state === 'delivered') return { delivered: true };
    if (saved?.state === 'invalidated') return { invalidated: true };
    if (!validate(message)) throw new Error('reply_source_changed');
    if (!store.read().deliveries[message.id]) store.append({ kind: 'reply_prepared', message });
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
      if (!messages.every(validate)) throw new Error('reply_source_changed');
      for (const message of messages) if (!store.read().deliveries[message.id]) store.append({ kind: 'reply_prepared', message });
    },
    async recover() {
      for (const row of Object.values(store.read().deliveries)) {
        // A crash can occur after delivery but before the work/handled receipts.
        if (row.state === 'delivered') { await onRecovered?.(row.message); continue; }
        if (row.state !== 'prepared') continue;
        if (!validate(row.message)) {
          store.append({ kind: 'reply_invalidated', messageId: row.message.id, reason: 'reply_source_changed' });
          await onInvalidated?.(row.message);
          continue;
        }
        await deliver(row.message);
        await onRecovered?.(row.message);
      }
    },
    pending: () => Object.values(store.read().deliveries).some(row => row.state === 'prepared'),
  };
}
