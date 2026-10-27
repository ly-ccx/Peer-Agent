import { RESOURCE_FILE_REPLACE_PROVIDER, resourceEditToken, resourceEditExecutionReceipt } from '@peer-agent/protocol';
const fail = code => ({ ok: false, code });
const key = (workspaceId, requestId) => JSON.stringify([workspaceId, requestId]);
/** Host-only ordering/continuity Module. It has no renderer, filesystem, model, task wake or permission-decision port. */
export function createResourceEditExecutionJournal({ storage, createRuntime, authorizeStart, isScopeCurrent, readCurrent, notify = () => {} } = {}) {
  for (const port of [createRuntime, authorizeStart, isScopeCurrent, readCurrent]) if (typeof port !== 'function') throw TypeError('Resource execution journal requires actual host scope and Runtime ports.');
  const active = new Map(); let disposed = false;
  function operation(workspaceId, requestId) {
    if (!resourceEditToken(workspaceId) || !resourceEditToken(requestId)) return fail('RESOURCE_EDIT_INVALID_REQUEST');
    const saved = storage.inspect(workspaceId); if (!saved.ok) return saved;
    const value = [...saved.manifest.operations, ...saved.manifest.retiredOperations].find(op => op.requestId === requestId);
    return value ? { ok: true, operation: value, hostOwnedHere: saved.hostOwnedHere } : fail('RESOURCE_EDIT_OPERATION_MISSING');
  }
  const current = (binding, op) => { try { return isScopeCurrent(binding, op) === true; } catch { return false; } };
  const canStart = (binding, op) => { try { return authorizeStart(binding, op) === true; } catch { return false; } };
  function changed(op) { try { notify(op.target.recipient.workspaceId, { kind: 'operation', draftId: op.draftId, requestId: op.requestId }); } catch {} }
  function unknown(op) {
    const result = storage.apply(op.target.recipient.workspaceId, { type: 'uncertain', requestId: op.requestId, payloadHash: op.payloadHash });
    if (result.ok) changed(result.operation); return result;
  }
  function settleActual(op) {
    const actual = storage.executionResult(op.target.recipient.workspaceId, op.requestId); if (!actual.ok) return actual;
    const receipt = resourceEditExecutionReceipt(actual.record, op);
    if (!receipt) return unknown(op);
    const result = storage.apply(op.target.recipient.workspaceId, { type: 'settle', requestId: op.requestId, receipt });
    if (result.ok) changed(result.operation); return result;
  }
  function query(workspaceId, requestId) {
      const found = operation(workspaceId, requestId); if (!found.ok) return found;
      const actual = storage.executionResult(workspaceId, requestId), entry = active.get(key(workspaceId, requestId));
      if (!actual.ok && actual.code !== 'RESOURCE_EDIT_EXECUTION_MISSING') return actual;
      return { ok: true, operation: found.operation, live: !!entry, hostOwnedHere: found.hostOwnedHere, hasActualResult: actual.ok,
        governance: actual.ok ? actual.postlude?.status ?? 'pending' : 'unavailable' };
  }
  return {
    start({ workspaceId, requestId, payloadHash }, binding) {
      if (disposed) return fail('RESOURCE_EDIT_SOURCE_UNAVAILABLE');
      const found = operation(workspaceId, requestId); if (!found.ok) return found;
      const op = found.operation;
      if (op.providerId !== RESOURCE_FILE_REPLACE_PROVIDER || op.payloadHash !== payloadHash) return fail('RESOURCE_EDIT_ID_CONFLICT');
      // A duplicate, recovery, missing Promise or observation timeout can never start a second call.
      if (op.phase !== 'prepared') return { ok: true, operation: op, live: active.has(key(workspaceId, requestId)), hostOwnedHere: found.hostOwnedHere, repeated: true };
      if (!canStart(binding, op) || !current(binding, op)) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      if (active.size >= 64) return fail('RESOURCE_EDIT_EXECUTION_LIMIT');
      const body = storage.operationText(workspaceId, requestId); if (!body.ok) return body;
      const started = storage.apply(workspaceId, { type: 'start', requestId, payloadHash });
      if (!started.ok || !started.execute) return started.ok ? { ok: true, operation: started.operation, live: active.has(key(workspaceId, requestId)), repeated: true } : started;
      const id = key(workspaceId, requestId), abort = new AbortController(), entry = { operation: started.operation, abort, promise: null, binding };
      active.set(id, entry);
      entry.promise = Promise.resolve().then(async () => {
        try {
          const runtime = createRuntime(entry.operation, binding, {
            signal: abort.signal,
            isIntentCurrent: () => !disposed && active.get(id) === entry && !abort.signal.aborted && current(binding, entry.operation),
            recordExecution: (_op, record) => {
              if (_op.requestId !== entry.operation.requestId || record.requestId !== entry.operation.requestId || record.payloadHash !== entry.operation.payloadHash) return fail('RESOURCE_EDIT_EXECUTION_MISMATCH');
              const saved = storage.recordExecution(workspaceId, record);
              // File outcome settles as soon as its original fact is durable; a hanging PostToolUse is a separate responsibility.
              if (saved.ok) settleActual(entry.operation);
              return saved;
            },
            recordPostlude: (_op, postlude) => _op.requestId === entry.operation.requestId && postlude.requestId === entry.operation.requestId && postlude.payloadHash === entry.operation.payloadHash ? storage.recordExecutionPostlude(workspaceId, postlude) : fail('RESOURCE_EDIT_EXECUTION_MISMATCH'),
          });
          await runtime.execute({ operation: entry.operation, content: body.text }, { signal: abort.signal });
          if (!settleActual(entry.operation).ok) unknown(entry.operation);
        } catch {
          // Persistence acknowledgements can be lost after commit. Read the actual index before declaring uncertainty.
          if (!settleActual(entry.operation).ok) unknown(entry.operation);
        } finally { if (active.get(id) === entry) active.delete(id); changed(entry.operation); }
      });
      changed(entry.operation);
      return { ok: true, operation: started.operation, live: true, repeated: false };
    },
    query,
    async reconcile({ workspaceId, requestId }, binding) {
      const found = operation(workspaceId, requestId); if (!found.ok) return found;
      if (!current(binding, found.operation)) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      const actual = storage.executionResult(workspaceId, requestId);
      if (actual.ok) { const settled = settleActual(found.operation); if (!settled.ok) return settled; }
      else if (!['RESOURCE_EDIT_EXECUTION_MISSING'].includes(actual.code)) return actual;
      let latest = operation(workspaceId, requestId); if (!latest.ok) return latest;
      const live = active.has(key(workspaceId, requestId));
      if (latest.operation.phase === 'running' && !live && latest.hostOwnedHere) { const marked = unknown(latest.operation); if (!marked.ok) return marked; latest = operation(workspaceId, requestId); if (!latest.ok) return latest; }
      let observation = 'unavailable';
      try {
        const read = await readCurrent(latest.operation, binding);
        if (!current(binding, latest.operation)) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
        if (read?.ok && read.resourceId === latest.operation.target.base.resourceId) observation = read.contentVersion === latest.operation.proposedVersion ? 'matches_proposed'
          : read.contentVersion === latest.operation.target.base.contentVersion ? 'matches_base' : 'changed';
      } catch {}
      // Matching bytes are useful material, never a substitute for an original Tool Result/Evidence.
      return { ...query(workspaceId, requestId), observation };
    },
    cancel({ workspaceId, requestId }, binding) {
      const found = operation(workspaceId, requestId); if (!found.ok) return found;
      if (!current(binding, found.operation)) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      if (found.operation.phase === 'settled') return { ok: true, operation: found.operation, requested: false };
      if (found.operation.phase === 'prepared') { const result = storage.apply(workspaceId, { type: 'withdraw', requestId, payloadHash: found.operation.payloadHash }); if (result.ok) changed(result.operation); return result.ok ? { ok: true, operation: result.operation, requested: true } : result; }
      const entry = active.get(key(workspaceId, requestId)); if (!entry) return fail('RESOURCE_EDIT_NO_LIVE_EXECUTION');
      entry.abort.abort(); return { ok: true, operation: found.operation, requested: true };
    },
    /** Actual Promise identity, for bounded observation/shutdown. Never creates or restarts work. */
    running(workspaceId, requestId) { return active.get(key(workspaceId, requestId))?.promise ?? null; },
    async drain() { await Promise.all([...active.values()].map(entry => entry.promise)); },
    dispose() { disposed = true; },
  };
}
