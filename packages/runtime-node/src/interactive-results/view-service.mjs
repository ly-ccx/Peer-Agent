import { randomUUID } from 'node:crypto';
import { interactiveToken, normalizeInteractiveOwner, normalizeInteractiveReference, normalizeInteractiveViewHandle,
  normalizeInteractiveWriter } from '@peer-agent/protocol';
import { encode, problem } from './storage.mjs';

const same = (a, b) => encode(a) === encode(b);
const copy = value => structuredClone(value);
const revision = value => Number.isSafeInteger(value) && value >= 0;
function request(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => !allowed.includes(key) || !('value' in descriptor))) throw problem('interactive_request_invalid');
  return value;
}
const failed = error => ({ ok: false, code: typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : 'interactive_storage_unavailable',
  ...(['interactive_writer_stale', 'interactive_state_conflict'].includes(error?.code) && error.saveStatus === 'not_committed' ? { saveStatus: 'not_committed' } : {}) });

/** Human presentation lifetime and state ordering. No permission, execution or model port. */
export function createInteractiveViewService({ resultStore, stateStore, resolveSource, createId = randomUUID, maxViews = 32 }) {
  if (typeof resolveSource !== 'function' || !Number.isSafeInteger(maxViews) || maxViews < 1 || maxViews > 64) throw TypeError('Invalid interactive view ports');
  const views = new Map(), requests = new Map(), pending = new Set(), retired = new Map();
  let disposed = false;
  const requireCurrent = record => {
    if (disposed || views.get(record.handle.viewId) !== record || record.sender.isDestroyed?.() === true || record.assertCurrent() !== true) throw problem('interactive_view_stale');
    return true;
  };
  function locate(sender, raw) {
    const handle = normalizeInteractiveViewHandle(raw), record = handle && views.get(handle.viewId);
    if (!record || record.sender !== sender || !same(record.handle, handle)) throw problem('interactive_view_stale');
    requireCurrent(record); return record;
  }
  function retire(record) {
    if (views.get(record.handle.viewId) !== record) return;
    record.controller.abort();
    if (record.writer) {
      try { stateStore.release({ reference: record.reference, identity: record.handle, writer: record.writer }, () => true); }
      catch { /* A taken-over token cannot release its successor. */ }
    }
    views.delete(record.handle.viewId);
    retired.set(record.handle.viewId, { sender: record.sender, handle: record.handle, writer: record.writer });
    if (retired.size > maxViews * 2) retired.delete(retired.keys().next().value);
    const senderRequests = requests.get(record.sender);
    senderRequests?.delete(record.requestId);
    if (senderRequests?.size === 0) requests.delete(record.sender);
    record.sender.removeListener?.('destroyed', record.onDestroyed);
  }
  const run = operation => { try { return { ok: true, ...operation() }; } catch (error) { return failed(error); } };
  function bound(sender, raw, fields, operation) {
    return run(() => {
      const value = request(raw, ['handle', ...fields]), record = locate(sender, value.handle);
      return operation(record, value, () => requireCurrent(record));
    });
  }
  function openReply(record) {
    requireCurrent(record);
    const fixed = resultStore.getVersion(record.reference);
    const result = { reference: fixed.reference, content: fixed.content, source: fixed.source, provenance: fixed.provenance,
      evidenceRef: fixed.evidenceRef, artifactRef: fixed.artifactRef, dataLevel: fixed.dataLevel, createdAt: fixed.createdAt,
      ...(fixed.predecessor ? { predecessor: fixed.predecessor } : {}) };
    requireCurrent(record);
    let state;
    try { state = stateStore.read(record.reference, () => requireCurrent(record)); }
    catch (error) {
      requireCurrent(record);
      return { ...failed(error), summary: { reference: fixed.reference, title: fixed.content.title, textFallback: fixed.content.textFallback,
        specHash: fixed.content.specHash, libraryVersion: fixed.content.libraryVersion, dataLevel: fixed.dataLevel } };
    }
    return { ok: true, handle: copy(record.handle), result, state };
  }
  async function open(sender, raw) {
    try {
      const value = request(raw, ['reference', 'requestId']), reference = normalizeInteractiveReference(value.reference), requestId = value.requestId;
      if (!reference || !interactiveToken(requestId) || disposed || !sender || typeof sender !== 'object' || sender.isDestroyed?.() === true) throw problem('interactive_request_invalid');
      let senderRequests = requests.get(sender);
      const prior = senderRequests?.get(requestId);
      if (prior) {
        if (!same(prior.reference, reference)) throw problem('interactive_open_parameter_conflict');
        const reply = await prior.promise;
        if (!reply.ok) return reply;
        const record = locate(sender, reply.handle), refreshed = openReply(record);
        if (!refreshed.ok) retire(record);
        return refreshed;
      }
      if (views.size + pending.size >= maxViews) throw problem('interactive_view_limit');
      if (!senderRequests) { senderRequests = new Map(); requests.set(sender, senderRequests); }
      const controller = new AbortController();
      let cancel;
      const cancelled = new Promise((_, reject) => { cancel = () => { controller.abort(); reject(problem('interactive_view_stale')); }; });
      const operation = { sender, requestId, cancel }; pending.add(operation); sender.once?.('destroyed', cancel);
      const promise = (async () => {
        // Resolve from host canonical owner/source facts; never trust the locator alone.
        const source = await Promise.race([Promise.resolve().then(() => resolveSource(sender, copy(reference), { signal: controller.signal })), cancelled]);
        const owner = normalizeInteractiveOwner(source?.owner);
        if (!owner || !same(owner, reference.owner) || typeof source.assertCurrent !== 'function' || source.assertCurrent() !== true
          || disposed || controller.signal.aborted || sender.isDestroyed?.() === true) throw problem('interactive_scope_denied');
        const handle = normalizeInteractiveViewHandle({ viewId: createId(), windowId: createId(), generation: createId() });
        if (!handle || views.has(handle.viewId) || retired.has(handle.viewId)) throw problem('interactive_view_unavailable');
        const record = { sender, reference, handle, requestId, controller, assertCurrent: source.assertCurrent, writer: null };
        record.onDestroyed = () => retire(record);
        views.set(handle.viewId, record); sender.once?.('destroyed', record.onDestroyed);
        try { const reply = openReply(record); if (!reply.ok) retire(record); return reply; } catch (error) { retire(record); throw error; }
      })().catch(failed).finally(() => { pending.delete(operation); sender.removeListener?.('destroyed', cancel); });
      senderRequests.set(requestId, { reference, promise });
      const reply = await promise;
      if (!reply.ok && senderRequests.get(requestId)?.promise === promise) senderRequests.delete(requestId);
      if (senderRequests.size === 0 && requests.get(sender) === senderRequests) requests.delete(sender);
      return reply;
    } catch (error) { return failed(error); }
  }
  function closeSender(sender) {
    [...pending].filter(operation => operation.sender === sender).forEach(operation => operation.cancel());
    [...views.values()].filter(record => record.sender === sender).forEach(retire);
  }
  return {
    open,
    cancelOpen: (sender, raw) => run(() => {
      const value = request(raw, ['requestId']);
      if (!interactiveToken(value.requestId)) throw problem('interactive_request_invalid');
      [...pending].filter(operation => operation.sender === sender && operation.requestId === value.requestId).forEach(operation => operation.cancel());
      [...views.values()].filter(record => record.sender === sender && record.requestId === value.requestId).forEach(retire);
      return {};
    }),
    readState: (sender, raw) => bound(sender, raw, [], (record, _value, current) => ({ state: stateStore.read(record.reference, current) })),
    acquire: (sender, raw) => bound(sender, raw, ['expectedRevision', 'takeover'], (record, value, current) => {
      if (!revision(value.expectedRevision) || value.takeover !== undefined && typeof value.takeover !== 'boolean') throw problem('interactive_request_invalid');
      record.writer = stateStore.acquire({ reference: record.reference, identity: record.handle, expectedRevision: value.expectedRevision,
        ...(value.takeover === true ? { takeover: true } : {}) }, current);
      return { writer: copy(record.writer) };
    }),
    save: (sender, raw) => bound(sender, raw, ['writer', 'expectedRevision', 'requestId', 'values', 'inputDrafts'], (record, value, current) => {
      const writer = normalizeInteractiveWriter(value.writer);
      if (!writer || writer.viewId !== record.handle.viewId || !revision(value.expectedRevision) || !interactiveToken(value.requestId)) throw problem('interactive_writer_stale');
      return stateStore.saveOutcome({ reference: record.reference, identity: record.handle, writer, expectedRevision: value.expectedRevision,
        requestId: value.requestId, values: value.values, inputDrafts: value.inputDrafts }, current);
    }),
    async prepareFollowup(sender, raw) {
      try {
        const value = request(raw, ['handle', 'stateRevision', 'stateDigest', 'fields', 'requestId']), record = locate(sender, value.handle);
        if (!record.writer) throw problem('interactive_writer_required');
        const key = encode([value.requestId, value.stateRevision, value.stateDigest, value.fields]);
        if (record.followupPending && record.followupPending.key !== key) throw problem('interactive_followup_busy');
        if (!record.followupPending) {
          const operation = { key };
          operation.promise = stateStore.prepareFollowup({ reference: record.reference, identity: record.handle, writer: record.writer,
            stateRevision: value.stateRevision, stateDigest: value.stateDigest, fields: value.fields, requestId: value.requestId },
          () => requireCurrent(record), { signal: record.controller.signal }).then(followup => {
            requireCurrent(record); return { ok: true, followup };
          }, failed).finally(() => { if (record.followupPending === operation) record.followupPending = null; });
          record.followupPending = operation;
        }
        return copy(await record.followupPending.promise);
      } catch (error) { return failed(error); }
    },
    // Host-only binding for the existing draft preparation service. The closure
    // and actual sender never cross an IPC result or become a model tool.
    resolveFollowup: (sender, raw) => bound(sender, raw, ['followupId'], (record, value, current) => {
      if (!interactiveToken(value.followupId)) throw problem('interactive_request_invalid');
      const followup = stateStore.readFollowup(record.reference.owner, value.followupId);
      if (!same(followup.result, record.reference)) throw problem('interactive_scope_denied');
      current(); return { followup, identity: copy(record.handle), assertCurrent: current };
    }),
    release: (sender, raw) => run(() => {
      const value = request(raw, ['handle', 'writer']), handle = normalizeInteractiveViewHandle(value.handle);
      const record = handle && (views.get(handle.viewId) ?? retired.get(handle.viewId));
      if (disposed || !record || record.sender !== sender || !same(record.handle, handle)) throw problem('interactive_view_stale');
      if (value.writer !== undefined) {
        const writer = normalizeInteractiveWriter(value.writer);
        if (!writer || !record.writer || !same(writer, record.writer)) throw problem('interactive_writer_stale');
      }
      if (views.has(handle.viewId)) retire(record);
      return {};
    }),
    closeSender,
    dispose() { if (disposed) return; disposed = true; [...pending].forEach(operation => operation.cancel()); [...views.values()].forEach(retire); requests.clear(); retired.clear(); },
  };
}
