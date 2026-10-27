import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeResourceWindowRequest, normalizeResourceWindowOwner, normalizeResourceWindowNavigation } from '@peer-agent/protocol';
const failure = status => ({ ok: false, status });
const alive = sender => !!sender && typeof sender === 'object' && sender.isDestroyed?.() !== true;
const sameTask = (a, b) => (a?.sessionId ?? '') === (b?.sessionId ?? '') && (a?.planId ?? '') === (b?.planId ?? '');
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const copy = value => structuredClone(value);

/**
 * Transient presentation leases, never grants. Only host adapters call prepare/attach/release.
 * The application reader must inject the captured reference into the existing scoped file/Git service.
 * No BrowserWindow, task, model, filesystem, IPC registration or persistence is owned here.
 *
 * isMainSender/isResourceSender must inspect the trusted registry's real sender object.
 * resolveSource(request, sender, {signal}) must call the existing scoped metadata reader
 * and bind the real Bot conversation/task; return {ok:true, owner, resource} only then.
 * Only the locator path may be canonicalized. An aborted late read never creates a lease.
 * onPrepared(context, resolution) is host-only: retain canonical physical roots outside serialized context.
 * Native factories must release prepared leases on creation failure; IPC adapters must
 * never serialize returnTarget.sourceSender or treat readBinding as read authorization.
 * IPC app-origin/top-frame checks must already have passed before calling these host APIs.
 */
export function createResourceViewRegistry({ isMainSender, isResourceSender, resolveSource, onPrepared = () => {}, createId = randomUUID, maxViews = 8 }) {
  if (![isMainSender, isResourceSender, resolveSource, onPrepared, createId].every(fn => typeof fn === 'function') || !Number.isSafeInteger(maxViews) || maxViews < 1 || maxViews > 32) throw TypeError('Invalid resource view registry ports');
  const views = new Map(), senders = new Map(), epochs = new WeakMap();
  const pending = new Set(); let generation = 0, disposed = false;
  const epoch = sender => epochs.get(sender) ?? 0;
  const context = record => freeze(copy(record.context));
  const matches = (record, identity) => !!identity && record.context.viewId === identity.viewId && record.context.windowId === identity.windowId && record.context.generation === identity.generation;
  function locate(sender, identity) {
    if (disposed) return failure('disposed');
    const record = senders.get(sender);
    if (!alive(sender) || !isResourceSender(sender) || !record) return failure('scope_denied');
    if (identity !== undefined && !matches(record, identity)) return failure('stale_view');
    return { ok: true, record };
  }
  function remove(record) {
    if (views.get(record.context.viewId) !== record) return false;
    views.delete(record.context.viewId); record.source.removeListener?.('destroyed', record.onSourceDestroyed);
    if (record.sender) {
      if (senders.get(record.sender) === record) senders.delete(record.sender);
      record.sender.removeListener?.('destroyed', record.onDestroyed);
    }
    return true;
  }
  async function prepare(sender, raw, { signal } = {}) {
    if (disposed) return failure('disposed');
    if (!alive(sender) || !isMainSender(sender)) return failure('scope_denied');
    const request = normalizeResourceWindowRequest(raw);
    if (!request) return failure('invalid_request');
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return failure('invalid_request');
    if (signal?.aborted) return failure('cancelled');
    if (views.size + pending.size >= maxViews) return failure('limit_reached');
    const startingEpoch = epoch(sender), controller = new AbortController();
    let cancelWith;
    const cancellation = new Promise(resolve => { cancelWith = status => {
      if (controller.signal.aborted) return;
      pending.delete(operation); sender.removeListener?.('destroyed', cancel); controller.abort(); resolve({ cancelled: true, status });
    }; });
    const cancel = () => cancelWith('source_unavailable'), callerAborted = () => cancelWith('cancelled');
    const operation = { source: sender, cancel }; pending.add(operation);
    try {
      sender.once?.('destroyed', cancel); signal?.addEventListener('abort', callerAborted, { once: true });
      // Capture only protocol values. A caller cannot mutate them while the resolver is pending.
      const result = await Promise.race([
        Promise.resolve().then(() => controller.signal.aborted ? { cancelled: true } : resolveSource(copy(request), sender, { signal: controller.signal })).then(value => ({ value }), () => ({ failed: true })),
        cancellation,
      ]);
      if (result.cancelled || result.failed || controller.signal.aborted) return failure(disposed ? 'disposed' : signal?.aborted ? 'cancelled' : 'source_unavailable');
      const resolved = result.value;
      if (disposed) return failure('disposed');
      if (!alive(sender) || !isMainSender(sender) || startingEpoch !== epoch(sender)) return failure('source_unavailable');
      if (!resolved?.ok) return failure(['scope_denied', 'permission_denied', 'not_found', 'workspace_unavailable', 'revision_unavailable'].includes(resolved?.status) ? resolved.status : 'source_unavailable');
      const owner = normalizeResourceWindowOwner(resolved.owner);
      const canonical = normalizeResourceWindowRequest({ resource: resolved.resource });
      if (!owner || !canonical || canonical.resource.kind !== request.resource.kind || owner.workspaceId !== request.resource.reference.workspaceId
        || canonical.resource.reference.workspaceId !== owner.workspaceId || !sameTask(owner.task, canonical.resource.reference.task)
        || !sameTask(owner.task, request.resource.reference.task)) return failure('scope_denied');
      // The resolver may canonicalize the locator only. It cannot substitute a mode, commit,
      // comparison endpoint, observation or delivery record to make a request succeed.
      const requested = { ...request.resource, reference: { ...request.resource.reference, path: canonical.resource.reference.path } };
      if (!isDeepStrictEqual(requested, canonical.resource)) return failure('source_unavailable');
      const viewId = createId(), windowId = createId();
      if (typeof viewId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(viewId) || typeof windowId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(windowId) || viewId === windowId || views.has(viewId)
        || [...views.values()].some(value => value.context.windowId === windowId)) return failure('source_unavailable');
      if (disposed || !alive(sender) || !isMainSender(sender) || startingEpoch !== epoch(sender)) return failure(disposed ? 'disposed' : 'source_unavailable');
      const initial = freeze({ viewId, windowId, generation: ++generation, owner, resource: canonical.resource, phase: 'prepared', navigationVersion: 0,
        ...(request.sourceTabId ? { sourceTabId: request.sourceTabId } : {}), ...(request.navigation ? { navigation: request.navigation, sourceNavigation: request.navigation } : {}) });
      const record = { context: initial, source: sender, sender: null, onDestroyed: null, onSourceDestroyed: null };
      record.onSourceDestroyed = () => remove(record); sender.once?.('destroyed', record.onSourceDestroyed);
      views.set(viewId, record);
      try { onPrepared(context(record), resolved); } catch { remove(record); return failure('source_unavailable'); }
      return { ok: true, context: context(record) };
    } catch { return failure('source_unavailable'); }
    finally { pending.delete(operation); sender.removeListener?.('destroyed', cancel); signal?.removeEventListener('abort', callerAborted); }
  }
  function attach(identity, sender) {
    if (disposed) return failure('disposed');
    const record = views.get(identity?.viewId);
    if (!record || !matches(record, identity)) return failure('stale_view');
    if (!alive(record.source) || !isMainSender(record.source)) { remove(record); return failure('source_unavailable'); }
    if (record.context.phase !== 'prepared' || !alive(sender) || !isResourceSender(sender) || sender === record.source || senders.has(sender)) return failure('scope_denied');
    record.source.removeListener?.('destroyed', record.onSourceDestroyed);
    record.sender = sender; record.onDestroyed = () => remove(record);
    record.context = freeze({ ...record.context, phase: 'attached' }); senders.set(sender, record); sender.once?.('destroyed', record.onDestroyed);
    return { ok: true, context: context(record) };
  }
  function markReady(sender, identity) {
    const found = locate(sender, identity); if (!found.ok) return found;
    if (identity === undefined) return failure('stale_view');
    found.record.context = freeze({ ...found.record.context, phase: 'ready' }); return { ok: true, context: context(found.record) };
  }
  return {
    prepare, attach, markReady,
    bootstrap(sender) { const found = locate(sender); return found.ok ? { ok: true, context: context(found.record) } : found; },
    readBinding(sender, identity) {
      const found = locate(sender, identity); if (!found.ok) return found;
      if (identity === undefined) return failure('stale_view');
      return found.record.context.phase === 'ready' ? { ok: true, context: context(found.record) } : failure('not_ready');
    },
    updateNavigation(sender, identity, navigation, sequence) {
      const found = locate(sender, identity); if (!found.ok) return found;
      if (identity === undefined) return failure('stale_view');
      const value = normalizeResourceWindowNavigation(navigation, found.record.context.resource.kind);
      if (!value) return failure('invalid_request');
      const next = (found.record.context.navigationVersion ?? 0) + 1;
      if (sequence !== undefined && sequence !== next) return failure('stale_view');
      found.record.context = freeze({ ...found.record.context, navigation: value, navigationVersion: next }); return { ok: true, context: context(found.record) };
    },
    returnTarget(sender, identity) {
      const found = locate(sender, identity); if (!found.ok) return found;
      if (identity === undefined) return failure('stale_view');
      if (!alive(found.record.source) || !isMainSender(found.record.source)) return failure('source_unavailable');
      // Host adapter gets this object directly, never serialized or supplied by a renderer.
      return { ok: true, sourceSender: found.record.source, context: context(found.record) };
    },
    release(identity) { const record = views.get(identity?.viewId); return record && matches(record, identity) ? remove(record) : false; },
    invalidateSource(sender) {
      // Host-only revocation must still work after the trusted role has been removed.
      if (!sender || typeof sender !== 'object') return;
      epochs.set(sender, epoch(sender) + 1);
      [...pending].filter(operation => operation.source === sender).forEach(operation => operation.cancel());
      [...views.values()].filter(record => record.source === sender && record.context.phase === 'prepared').forEach(remove);
    },
    dispose() { if (disposed) return false; disposed = true; [...pending].forEach(operation => operation.cancel()); [...views.values()].forEach(remove); return true; },
    stats: () => ({ active: views.size, pending: pending.size, disposed }),
  };
}
