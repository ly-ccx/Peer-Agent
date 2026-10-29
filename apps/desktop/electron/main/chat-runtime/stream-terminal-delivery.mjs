/** Public terminal delivery and turn release follow the same durable commit barrier. */
export function createStreamTerminalDelivery({ record, send, failRuntimeTurn, onPersistenceFailure }) {
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
      const precedingCode = record.streamFailure?.code || record.failureReason || payload?.error;
      const causeCode = String(error?.code || error?.message || 'PERSISTENCE_ERROR').slice(0, 200);
      record.streamFailure = { code: 'conversation_persistence_failed', causeCode,
        ...(precedingCode ? { precedingCode: String(precedingCode).slice(0, 2000) } : {}) };
      record.terminalStatus = 'error'; record.interrupted = true;
      record.failureReason = `conversation_persistence_failed: ${causeCode}`; record.recoverable = false;
      try { onPersistenceFailure?.(record.streamFailure); } catch { /* Diagnosis cannot turn a failed commit into success. */ }
      try { failRuntimeTurn?.(record.failureReason); } catch { /* execution may already have stopped */ }
      return notify('chat:stream:error', { streamId: record.streamId, conversationId: record.conversationId,
        error: record.failureReason, persistenceError: causeCode, streamFailure: record.streamFailure });
    });
    return record.terminalCommit;
  };
}

export function afterTerminalCommit(record, release) {
  if (record.terminalCommit) return record.terminalCommit.then(release);
  return release();
}
