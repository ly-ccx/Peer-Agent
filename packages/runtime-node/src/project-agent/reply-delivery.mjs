import { historyExecutionHeld } from './history-resumption.mjs';
import { isHostCoordinationFailure } from './failure-scope.mjs';
import { INTENT_FORMAT_VERSION } from './intent-coordination-kernel.mjs';

const RETRY_DELAYS = [2000, 5000, 15000, 60000];
/** Canonical append and idempotent settlement have independent receipts; neither replays worker execution. */
export function createReplyDelivery({ store, readMessages, appendMessage, accept = null, validate = () => true,
  admitMessage = () => true, onRecovered = null, onInvalidated = null, onDeferred = null, onChanged = null, now = () => new Date().toISOString() }) {
  const readSnapshot = () => typeof store.readSnapshot === 'function' ? store.readSnapshot() : store.read();
  const split = () => store.supportsSplitDelivery?.() === true;
  const held = (message, state = readSnapshot()) => !admitMessage(message, state) || historyExecutionHeld(state.works?.[message.meta?.workId])
    || state.lastRecovery?.quarantinedDeliveryIds?.includes(message.id);
  const inflight = new Map();
  const dispatched = new Map();
  const deferred = new Map();
  const owner = message => message.meta?.workId || `message:${message.id}`;
  const owners = message => [owner(message), ...(message.meta?.intentBindings || []).map(row => row.workId)];
  const pendingRows = (state = readSnapshot()) => Object.values(state.deliveries || {}).filter(row => row.state === 'prepared' && !held(row.message, state));
  function prepare(messages) {
    store.assertOwner(); const snapshot = readSnapshot();
    if (messages.some(message => held(message, snapshot))) throw new Error('coordination_reconciliation_required');
    if (!messages.every(validate)) throw new Error('reply_source_changed');
    if (messages.length && split()) store.enableSupervision(INTENT_FORMAT_VERSION);
    for (const message of messages) if (!readSnapshot().deliveries[message.id]) store.append({ kind: 'reply_prepared', message });
  }
  function aggregateReceipts(message) {
    if (!message.meta?.digestReplyIds?.length) return;
    const aggregate = readSnapshot().deliveries[message.id];
    for (const messageId of message.meta?.digestReplyIds || []) {
      if (readSnapshot().deliveries[messageId]?.state !== 'deferred') continue;
      if (aggregate?.state === 'delivered') store.recordDelivery({ kind: 'reply_aggregated', messageId, aggregateId: message.id });
      else if (aggregate?.state === 'invalidated') store.append({ kind: 'reply_invalidated', messageId, reason: 'aggregate_source_changed' });
    }
  }
  async function defer(message) {
    if (deferred.has(message.id)) return deferred.get(message.id);
    const task = Promise.resolve().then(async () => {
      store.assertOwner();
      if (typeof onDeferred !== 'function') throw new Error('digest_unavailable');
      const saved = readSnapshot().deliveries[message.id];
      if (saved && (saved.heldAt || ['aggregated', 'invalidated'].includes(saved.state))) return { deferred: true };
      if (saved && saved.state !== 'deferred') return { pending: true };
      if (split() && !saved) store.recordDelivery({ kind: 'reply_deferred', message });
      await onDeferred(message); store.assertOwner();
      if (split()) store.recordDelivery({ kind: 'reply_held', messageId: message.id });
      return { deferred: true };
    }).finally(() => deferred.delete(message.id));
    deferred.set(message.id, task); return task;
  }
  async function prepareAggregate(message) {
    if (held(message)) return { held: true, reason: 'reply_scope_unavailable' };
    const existing = readSnapshot().deliveries[message.id];
    if (existing?.state === 'delivered') return { delivered: true };
    if (validate(message)) { prepare([message]); return { prepared: true }; }
    store.assertOwner();
    if (!existing) store.append({ kind: 'reply_prepared', message });
    if (existing?.state !== 'invalidated') {
      store.append({ kind: 'reply_invalidated', messageId: message.id, reason: 'reply_source_changed' });
      aggregateReceipts(message); await onInvalidated?.(message);
    }
    return { invalidated: true };
  }
  async function perform(message) {
    store.assertOwner(); let saved = readSnapshot().deliveries[message.id];
    if (held(message)) return { held: true };
    if (saved?.state === 'delivered') return { delivered: true };
    if (saved?.state === 'invalidated') return { invalidated: true };
    if (['deferred', 'aggregated'].includes(saved?.state)) return { held: true };
    if (split()) store.enableSupervision(INTENT_FORMAT_VERSION);
    const earlier = pendingRows().find(row => owners(row.message).some(id => owners(message).includes(id)) && row.message.id !== message.id);
    if (earlier && (!saved || Object.keys(readSnapshot().deliveries).indexOf(earlier.message.id) < Object.keys(readSnapshot().deliveries).indexOf(message.id))) {
      prepare([message]); return { pending: true, reason: 'earlier_work_delivery' };
    }
    if (!validate(message)) throw new Error('reply_source_changed');
    if (!saved) { prepare([message]); saved = readSnapshot().deliveries[message.id]; }
    let attempt = saved.settlement?.attempts || 0;
    try {
      if (!readMessages().some(row => row.id === message.id)) { store.assertOwner(); await appendMessage(message); }
      if (split() && !saved.canonicalCommittedAt) store.recordDelivery({ kind: 'reply_committed', messageId: message.id });
      saved = readSnapshot().deliveries[message.id];
      if (saved.settlement?.status !== 'applied') {
        if (split()) { attempt++; store.recordDelivery({ kind: 'reply_settlement_started', messageId: message.id, attempt }); }
        if (accept) {
          store.assertOwner(); if (!validate(message)) throw new Error('reply_source_changed');
          // The existing host callback reads acceptance/memory/handoff facts before settling by stable message id.
          const result = await accept(message, { operationId: `settlement:${message.id}`, attempt });
          store.assertOwner();
          if (result?.ok === false) throw Object.assign(new Error(result.error || 'reply_settlement_failed'), { code: result.error });
          if (!validate(message)) throw Object.assign(new Error('reply_source_changed'), { code: 'reply_source_changed' });
        }
        if (split()) store.recordDelivery({ kind: 'reply_settled', messageId: message.id, attempt });
      }
      store.append({ kind: 'reply_delivered', messageId: message.id });
      aggregateReceipts(message);
      return { delivered: true };
    } catch (error) {
      if (isHostCoordinationFailure(error)) throw error;
      if (split()) {
        const row = readSnapshot().deliveries[message.id];
        store.recordDelivery({ kind: 'reply_settlement_failed', messageId: message.id, attempt: row.settlement?.attempts || 0,
          phase: row.canonicalCommittedAt ? 'settlement' : 'commit', error: String(error.code || 'reply_delivery_failed').slice(0, 200),
          retryAt: new Date(Date.parse(now()) + RETRY_DELAYS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS.length - 1)]).toISOString() });
      }
      throw error;
    }
  }
  function deliver(message) {
    if (inflight.has(message.id)) return inflight.get(message.id);
    const promise = perform(message).finally(() => inflight.delete(message.id)); inflight.set(message.id, promise); return promise;
  }
  function dispatchTask(message, operation) {
    if (!split()) return operation();
    if (dispatched.has(message.id)) return dispatched.get(message.id);
    const task = operation().then(async result => {
      if (result.delivered) await onRecovered?.(message); return result;
    }).catch(error => {
      if (isHostCoordinationFailure(error)) return { pending: true, hostError: error };
      return { pending: true, error: error.code || 'reply_delivery_failed' };
    }).then(result => { dispatched.delete(message.id); onChanged?.(result.hostError); return result; });
    const result = Promise.race([task, new Promise(resolve => setImmediate(() => resolve({ pending: true, reason: 'settlement_in_flight' })))])
      .then(value => { if (value.hostError) throw value.hostError; return value; });
    dispatched.set(message.id, result); return result;
  }
  const dispatch = message => dispatchTask(message, () => deliver(message));
  return {
    deliver, dispatch, prepare, prepareAggregate, defer: message => dispatchTask(message, () => defer(message)),
    async recover() {
      const snapshot = readSnapshot(), blocked = new Set(), failures = [];
      for (const row of Object.values(snapshot.deliveries)) {
        const message = structuredClone(row.message), keys = owners(message), block = () => keys.forEach(key => blocked.add(key));
        if (held(message, snapshot)) continue;
        if (row.state === 'deferred') { if (!row.heldAt) await dispatchTask(message, () => defer(message)); continue; }
        if (row.state === 'delivered') { aggregateReceipts(message); await onRecovered?.(message); continue; }
        if (row.state !== 'prepared' || keys.some(key => blocked.has(key))) continue;
        if (inflight.has(message.id)) { block(); continue; }
        if (row.settlement?.retryAt && Date.parse(row.settlement.retryAt) > Date.parse(now())) { block(); continue; }
        if (!validate(message)) {
          store.append({ kind: 'reply_invalidated', messageId: message.id, reason: 'reply_source_changed' }); aggregateReceipts(message); await onInvalidated?.(message); continue;
        }
        try {
          const result = await (split() ? dispatch(message) : deliver(message));
          if (result.delivered) { if (!split()) await onRecovered?.(message); } else block();
          if (result.error) failures.push({ messageId: message.id, workId: message.meta?.workId, error: result.error });
        } catch (error) {
          if (isHostCoordinationFailure(error)) throw error;
          failures.push({ messageId: message.id, workId: message.meta?.workId, error: error.code || 'reply_delivery_failed' }); block();
        }
      }
      return { failures };
    },
    pending: (snapshot = readSnapshot(), workId) => pendingRows(snapshot).some(row => !workId || owners(row.message).includes(workId))
      || Object.values(snapshot.deliveries || {}).some(row => row.state === 'deferred' && !row.heldAt && !held(row.message, snapshot) && (!workId || owners(row.message).includes(workId))),
    committed: messageId => { const row = readSnapshot().deliveries[messageId]; return Boolean(row?.canonicalCommittedAt || row?.state === 'delivered'); },
    nextRetryAt: () => pendingRows().map(row => row.settlement?.retryAt).filter(at => Number.isFinite(Date.parse(at))).sort()[0] || null,
  };
}
