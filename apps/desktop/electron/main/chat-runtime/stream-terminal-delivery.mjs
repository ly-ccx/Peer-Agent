/** Public terminal delivery and turn release follow the same durable commit barrier. */
export function createStreamTerminalDelivery({ record, send, failRuntimeTurn }) {
  const notify = (channel, payload) => {
    try { return send(channel, payload); }
    catch { return false; } // A closing surface cannot prevent a durable turn from releasing.
  };
  return (persistence, channel, payload, onCommitted) => {
    if (record.terminalNotificationRegistered) return record.terminalCommit;
    record.terminalNotificationRegistered = true;
    const committed = () => { onCommitted?.(); return notify(channel, payload); };
    if (!persistence || typeof persistence.then !== 'function') return committed();
    record.terminalCommit = Promise.resolve(persistence).then(committed, error => {
      record.terminalStatus = 'error'; record.interrupted = true;
      record.failureReason = 'conversation_persistence_failed'; record.recoverable = false;
      try { failRuntimeTurn?.('conversation_persistence_failed'); } catch { /* execution may already have stopped */ }
      return notify('chat:stream:error', { streamId: record.streamId, conversationId: record.conversationId,
        error: 'conversation_persistence_failed', persistenceError: error.code || error.message });
    });
    return record.terminalCommit;
  };
}

export function afterTerminalCommit(record, release) {
  if (record.terminalCommit) return record.terminalCommit.then(release);
  return release();
}
