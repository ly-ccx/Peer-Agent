import { createHash, randomUUID } from 'node:crypto';
import {
  normalizeResourceEditSource, normalizeResourceEditTarget, normalizeResourceEditHandle, normalizeResourceEditWriter,
  resourceEditToken, validResourceEditText,
} from '@peer-agent/protocol';
const fail = code => ({ ok: false, code });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const shape = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const alive = sender => sender && !sender.isDestroyed?.();
const page = request => Number.isSafeInteger(request?.limit ?? 32) && (request.limit ?? 32) > 0 && (request.limit ?? 32) <= 64
  && (request.cursor === undefined || resourceEditToken(request.cursor));
/** Owns local human intent and actual views. No Provider, permission mutation, task wake or execution port. */
export function createResourceEditApplicationService({ storage, getRole, getOwner, readSource, isSourceCurrent, canReadRetained,
  getWindowId, notify = () => {}, createId = randomUUID, schedule = setTimeout, cancel = clearTimeout }) {
  const views = new Map(), senders = new Map(), submissions = new WeakSet(), destroyedSenders = new WeakSet(); let generation = 0, disposed = false;
  function role(sender) { return !disposed && alive(sender) && !destroyedSenders.has(sender) ? getRole(sender) : null; }
  function changed(workspaceId, notice) {
    const recipients = new Set([...views.values()].filter(v => v.target.recipient.workspaceId === workspaceId && role(v.sender) === v.role && currentOwner(v.sender, v.target.recipient)).map(v => v.sender));
    for (const sender of recipients) try { notify(sender, { workspaceId, ...notice }); } catch { /* A presentation notice never retries a mutation. */ }
  }
  function retire(record) {
    if (views.get(record.handle.viewId) !== record) return;
    views.delete(record.handle.viewId); record.closed = true;
    storage.releaseView(record.target.recipient.workspaceId, record.handle);
    if (record.writer) changed(record.target.recipient.workspaceId, { kind: 'writer', draftId: record.handle.draftId });
    record.writer = null;
  }
  function ownerMatches(owner, recipient) { return owner?.conversationId === recipient.conversationId; }
  function currentOwner(sender, recipient) {
    const before = role(sender); if (!['main', 'resource'].includes(before)) return false;
    const owner = getOwner(recipient.workspaceId);
    return role(sender) === before && ownerMatches(owner, recipient);
  }
  function locate(sender, raw) {
    const handle = normalizeResourceEditHandle(raw), record = handle && views.get(handle.viewId);
    return record && !record.closed && record.sender === sender && role(sender) === record.role && equal(record.handle, handle) ? record : null;
  }
  function valid(record) {
    if (locate(record.sender, record.handle) !== record || !currentOwner(record.sender, record.target.recipient)) return false;
    if (record.source && !isSourceCurrent(record.sender, record.source)) return false;
    return locate(record.sender, record.handle) === record && currentOwner(record.sender, record.target.recipient);
  }
  function view(record) {
    const saved = storage.readDraft(record.target.recipient.workspaceId, record.handle.draftId);
    if (!saved.ok) return saved;
    return equal(saved.draft.target, record.target) ? { ok: true, handle: clone(record.handle), draft: saved.draft } : fail('RESOURCE_EDIT_SOURCE_CHANGED');
  }
  function readView(sender, handle) {
    return queued(sender, handle, record => view(record));
  }
  function queued(sender, handle, work) {
    const record = locate(sender, handle); if (!record) return Promise.resolve(fail('RESOURCE_EDIT_VIEW_EXPIRED'));
    const promise = record.queue.then(async () => valid(record) ? work(record) : fail('RESOURCE_EDIT_VIEW_EXPIRED'))
      .catch(() => fail('RESOURCE_EDIT_SOURCE_UNAVAILABLE'));
    record.queue = promise.then(() => undefined, () => undefined); return promise;
  }
  function stateFor(sender) {
    if (!senders.has(sender)) {
      const state = { requests: new Map(), destroyed: () => {
        destroyedSenders.add(sender);
        for (const item of state.requests.values()) { item.reason = 'RESOURCE_EDIT_SOURCE_UNAVAILABLE'; item.abort?.abort(); }
        for (const record of [...views.values()]) if (record.sender === sender) retire(record);
        senders.delete(sender);
      } };
      senders.set(sender, state); sender.once?.('destroyed', state.destroyed);
    }
    return senders.get(sender);
  }
  function attach(sender, draft, source) {
    if (generation >= Number.MAX_SAFE_INTEGER || views.size >= 64 || [...views.values()].filter(v => v.sender === sender).length >= 32) return fail('RESOURCE_EDIT_VIEW_LIMIT');
    const windowId = getWindowId(sender); if (!resourceEditToken(windowId)) return fail('RESOURCE_EDIT_SOURCE_UNAVAILABLE');
    const handle = { viewId: createId(), windowId, generation: ++generation, draftId: draft.id };
    if (views.has(handle.viewId) || !normalizeResourceEditHandle(handle)) return fail('RESOURCE_EDIT_SOURCE_UNAVAILABLE');
    const record = { sender, role: role(sender), source: source ? clone(source) : null, target: clone(draft.target), handle, writer: null, queue: Promise.resolve(), closed: false };
    views.set(handle.viewId, record); return { ok: true, handle: clone(handle), draft: clone(draft) };
  }
  async function begin(sender, requestId, key, work) {
    if (!resourceEditToken(requestId) || !['main', 'resource'].includes(role(sender))) return fail('RESOURCE_EDIT_INVALID_REQUEST');
    const state = stateFor(sender), prior = state.requests.get(requestId);
    if (prior) {
      if (prior.key !== key) return fail('RESOURCE_EDIT_ID_CONFLICT');
      return prior.promise ?? (prior.handle ? readView(sender, prior.handle) : fail('RESOURCE_EDIT_VIEW_EXPIRED'));
    }
    if ([...state.requests.values()].filter(r => r.promise).length >= 16 || [...senders.values()].reduce((n, s) => n + [...s.requests.values()].filter(r => r.promise).length, 0) >= 64) return fail('RESOURCE_EDIT_VIEW_LIMIT');
    const abort = new AbortController(), entry = { key, abort, promise: null, handle: null, reason: 'RESOURCE_EDIT_OPEN_CANCELLED' };
    state.requests.set(requestId, entry);
    const stopped = new Promise(resolve => abort.signal.addEventListener('abort', () => resolve(fail(entry.reason)), { once: true }));
    const timer = schedule(() => { entry.reason = 'RESOURCE_EDIT_OPEN_TIMEOUT'; abort.abort(); }, 30_000);
    entry.promise = Promise.race([Promise.resolve().then(() => work(abort.signal)), stopped])
      .catch(() => fail('RESOURCE_EDIT_SOURCE_UNAVAILABLE')).then(result => {
        cancel(timer); entry.handle = result.ok ? result.handle : null; entry.promise = null;
        while (state.requests.size > 128) {
          const disposable = [...state.requests].find(([, r]) => !r.promise && (!r.handle || !views.has(r.handle.viewId)));
          if (!disposable) break; state.requests.delete(disposable[0]);
        }
        return result;
      });
    return entry.promise;
  }
  async function capture(sender, source, signal) {
    const expectedRole = source.kind === 'native' ? 'resource' : 'main';
    if (role(sender) !== expectedRole || signal.aborted || !isSourceCurrent(sender, source)) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
    const result = await readSource(sender, source, { signal });
    if (!result?.ok) return fail(result?.code || 'RESOURCE_EDIT_SOURCE_UNAVAILABLE');
    const target = normalizeResourceEditTarget(result.target);
    if (!target || !validResourceEditText(result.content)) return fail('RESOURCE_EDIT_UNSUPPORTED_TEXT');
    if (!equal(target.base, source.observed)) return fail('RESOURCE_EDIT_VERSION_CHANGED');
    if (signal.aborted || role(sender) !== expectedRole || !isSourceCurrent(sender, source) || !currentOwner(sender, target.recipient)) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
    return { ok: true, target, content: result.content };
  }
  function scope(sender, request) {
    if (!object(request) || !resourceEditToken(request.workspaceId)) return null;
    const actual = role(sender), hasHandle = request.handle !== undefined, record = hasHandle ? locate(sender, request.handle) : null;
    if (actual !== 'main' && !(actual === 'resource' && record) || hasHandle && !record) return null;
    if (record && (record.target.recipient.workspaceId !== request.workspaceId || !valid(record))) return null;
    const owner = getOwner(request.workspaceId);
    if (!resourceEditToken(owner?.conversationId) || role(sender) !== actual || record && locate(sender, record.handle) !== record) return null;
    return { workspaceId: request.workspaceId, recipient: { workspaceId: request.workspaceId, conversationId: owner.conversationId }, record };
  }
  const belongs = (target, bound) => equal(target.recipient, bound.recipient) && (!bound.record || target.base.resourceId === bound.record.target.base.resourceId);
  async function readable(sender, snapshot, bound) {
    return belongs(snapshot.target, bound) && !!await canReadRetained(sender, snapshot.target, bound.record?.source ?? null);
  }
  const protect = fn => async (...args) => { try { return await fn(...args); } catch { return fail('RESOURCE_EDIT_SOURCE_UNAVAILABLE'); } };
  function submission(record) {
    const binding = { sender: record.sender, role: record.role, source: clone(record.source), target: clone(record.target), handle: clone(record.handle) };
    submissions.add(binding); return binding;
  }
  function boundOperation(record, requestId) {
    const saved = storage.inspect(record.target.recipient.workspaceId); if (!saved.ok) return saved;
    const operation = [...saved.manifest.operations, ...saved.manifest.retiredOperations].find(op => op.requestId === requestId);
    return !operation ? fail('RESOURCE_EDIT_OPERATION_MISSING') : operation.draftId === record.handle.draftId && equal(operation.target, record.target)
      ? { ok: true, operation } : fail('RESOURCE_EDIT_SCOPE_DENIED');
  }
  return {
    /** Host-only synchronous reserve seam. The view queue is released before permission/Runtime waits. */
    withSubmissionView(sender, request, reserve) {
      if (!shape(request, ['handle', 'writer', 'revision', 'requestId']) || !resourceEditToken(request.requestId)
        || !normalizeResourceEditWriter(request.writer) || !Number.isSafeInteger(request.revision) || request.revision < 0 || typeof reserve !== 'function') return Promise.resolve(fail('RESOURCE_EDIT_INVALID_REQUEST'));
      return queued(sender, request.handle, record => {
        const prior = boundOperation(record, request.requestId);
        if (prior.ok) return prior.operation.draftRevision === request.revision ? { ok: true, operation: prior.operation, binding: submission(record), fresh: false } : fail('RESOURCE_EDIT_ID_CONFLICT');
        if (prior.code !== 'RESOURCE_EDIT_OPERATION_MISSING') return prior;
        if (!equal(record.writer, normalizeResourceEditWriter(request.writer))) return fail('RESOURCE_EDIT_STALE_WRITER');
        const saved = view(record); if (!saved.ok) return saved;
        if (saved.draft.revision !== request.revision) return fail('RESOURCE_EDIT_DRAFT_CONFLICT');
        return reserve({ binding: submission(record), draft: saved.draft, writer: clone(record.writer) });
      });
    },
    /** No renderer can supply a binding or callback through IPC. */
    withOperationView(sender, request, work) {
      if (!shape(request, ['handle', 'requestId']) || !resourceEditToken(request.requestId) || typeof work !== 'function') return Promise.resolve(fail('RESOURCE_EDIT_INVALID_REQUEST'));
      return queued(sender, request.handle, record => { const found = boundOperation(record, request.requestId); return found.ok ? work(submission(record), found.operation) : found; });
    },
    isSubmissionCurrent(binding, operation) {
      return submissions.has(binding) && !disposed && alive(binding.sender) && role(binding.sender) === binding.role
        && getWindowId(binding.sender) === binding.handle.windowId && currentOwner(binding.sender, binding.target.recipient)
        && equal(operation.target, binding.target) && operation.draftId === binding.handle.draftId
        && (!binding.source || isSourceCurrent(binding.sender, binding.source));
    },
    notifyOperation(workspaceId, notice) { changed(workspaceId, notice); },
    open: protect(async (sender, request) => {
      if (!shape(request, ['requestId', 'source'])) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const source = normalizeResourceEditSource(request.source); if (!source) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      return begin(sender, request.requestId, JSON.stringify(['open', source]), async signal => {
        const read = await capture(sender, source, signal); if (!read.ok) return read;
        if (signal.aborted || !currentOwner(sender, read.target.recipient) || !isSourceCurrent(sender, source)) return fail('RESOURCE_EDIT_OPEN_CANCELLED');
        const saved = storage.apply(read.target.recipient.workspaceId, { type: 'open', id: createId(), target: read.target, baseText: read.content });
        return saved.ok ? attach(sender, saved.draft, source) : saved;
      });
    }),
    resume: protect(async (sender, request) => {
      if (!shape(request, ['requestId', 'workspaceId', 'draftId', 'source']) || !resourceEditToken(request.workspaceId) || !resourceEditToken(request.draftId)) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const source = request.source === undefined ? null : normalizeResourceEditSource(request.source);
      if (request.source !== undefined && !source || role(sender) === 'resource' && source?.kind !== 'native' || !['main', 'resource'].includes(role(sender))) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      return begin(sender, request.requestId, JSON.stringify(['resume', request.workspaceId, request.draftId, source]), async signal => {
        const owner = getOwner(request.workspaceId); if (signal.aborted || !owner?.conversationId) return fail('RESOURCE_EDIT_SOURCE_UNAVAILABLE');
        const saved = storage.readDraft(request.workspaceId, request.draftId); if (!saved.ok) return saved;
        if (!ownerMatches(owner, saved.draft.target.recipient)) return fail('RESOURCE_EDIT_RECIPIENT_CHANGED');
        if (source) {
          const current = await capture(sender, source, signal); if (!current.ok) return current;
          if (current.target.recipient.workspaceId !== request.workspaceId || current.target.base.resourceId !== saved.draft.target.base.resourceId) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
        }
        if (signal.aborted || !currentOwner(sender, saved.draft.target.recipient) || source && !isSourceCurrent(sender, source)) return fail('RESOURCE_EDIT_OPEN_CANCELLED');
        return attach(sender, saved.draft, source);
      });
    }),
    cancelOpen(sender, requestId) {
      if (!resourceEditToken(requestId) || !['main', 'resource'].includes(role(sender))) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const entry = senders.get(sender)?.requests.get(requestId); if (!entry) return fail('RESOURCE_EDIT_VIEW_EXPIRED');
      entry.abort.abort(); if (entry.handle) { const record = locate(sender, entry.handle); if (record) retire(record); }
      return { ok: true };
    },
    read: protect(readView),
    acquire(sender, request) {
      if (!shape(request, ['handle', 'takeover']) || request.takeover !== undefined && typeof request.takeover !== 'boolean') return Promise.resolve(fail('RESOURCE_EDIT_INVALID_REQUEST'));
      return queued(sender, request.handle, record => {
        const candidate = record.writer ?? { viewId: record.handle.viewId, windowId: record.handle.windowId, generation: record.handle.generation, token: createId() };
        const { lease: _lease, ...identity } = candidate;
        const acquired = storage.apply(record.target.recipient.workspaceId, { type: 'acquire', draftId: record.handle.draftId, writer: identity, takeover: request.takeover });
        if (!acquired.ok) return acquired;
        for (const other of views.values()) if (other !== record && other.target.recipient.workspaceId === record.target.recipient.workspaceId && other.handle.draftId === record.handle.draftId) other.writer = null;
        record.writer = acquired.writer; changed(record.target.recipient.workspaceId, { kind: 'writer', draftId: record.handle.draftId, writerViewId: record.handle.viewId });
        return { ok: true, handle: clone(record.handle), draft: acquired.draft, writer: acquired.writer };
      });
    },
    save(sender, request) {
      if (!shape(request, ['handle', 'writer', 'revision', 'text']) || !Number.isSafeInteger(request.revision) || request.revision < 0 || !validResourceEditText(request.text)) return Promise.resolve(fail('RESOURCE_EDIT_INVALID_REQUEST'));
      return queued(sender, request.handle, record => {
        const writer = normalizeResourceEditWriter(request.writer);
        if (!writer || !equal(record.writer, writer)) return fail('RESOURCE_EDIT_STALE_WRITER');
        const result = storage.apply(record.target.recipient.workspaceId, { type: 'edit', draftId: record.handle.draftId, writer, revision: request.revision, text: request.text });
        if (result.ok) changed(record.target.recipient.workspaceId, { kind: 'saved', draftId: record.handle.draftId, revision: result.draft.revision });
        return result.ok ? { ok: true, saved: { draftId: result.draft.id, revision: result.draft.revision, updatedAt: result.draft.updatedAt, textVersion: `sha256:${createHash('sha256').update(result.draft.text).digest('hex')}` } } : result;
      });
    },
    discard(sender, request) {
      if (!shape(request, ['handle', 'writer', 'revision']) || !Number.isSafeInteger(request.revision) || request.revision < 0) return Promise.resolve(fail('RESOURCE_EDIT_INVALID_REQUEST'));
      return queued(sender, request.handle, record => {
        const writer = normalizeResourceEditWriter(request.writer);
        if (!writer || !equal(record.writer, writer)) return fail('RESOURCE_EDIT_STALE_WRITER');
        const result = storage.apply(record.target.recipient.workspaceId, { type: 'discard', draftId: record.handle.draftId, writer, revision: request.revision });
        if (result.ok) changed(record.target.recipient.workspaceId, { kind: 'discarded', draftId: record.handle.draftId });
        if (result.ok) for (const item of [...views.values()]) if (item.target.recipient.workspaceId === record.target.recipient.workspaceId && item.handle.draftId === record.handle.draftId) retire(item);
        return result.ok ? { ok: true } : result;
      });
    },
    close(sender, handle) { const record = locate(sender, handle); if (!record) return fail('RESOURCE_EDIT_VIEW_EXPIRED'); retire(record); return { ok: true }; },
    list: protect(async (sender, request) => {
      if (!shape(request, ['workspaceId', 'handle', 'cursor', 'limit']) || !page(request)) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const bound = scope(sender, request); if (!bound) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      const saved = storage.inspect(bound.workspaceId); if (!saved.ok) return saved;
      const drafts = saved.manifest.drafts.filter(d => belongs(d.target, bound)).map(d => ({ id: d.id, target: d.target, revision: d.revision, createdAt: d.createdAt, updatedAt: d.updatedAt, hasChanges: d.baseBlob !== d.textBlob }));
      const all = [...saved.manifest.operations, ...saved.manifest.retiredOperations], rows = all.filter(op => belongs(op.target, bound)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.requestId.localeCompare(b.requestId));
      const offset = request.cursor === undefined ? 0 : rows.findIndex(op => op.requestId === request.cursor) + 1;
      if (request.cursor !== undefined && !offset) return fail('RESOURCE_EDIT_CURSOR_EXPIRED');
      const operations = rows.slice(offset, offset + (request.limit ?? 32));
      return { ok: true, drafts: clone(drafts), operations: clone(operations), nextCursor: offset + operations.length < rows.length ? operations.at(-1).requestId : null,
        staleCount: [...saved.manifest.drafts, ...all].filter(item => !equal(item.target.recipient, bound.recipient)).length };
    }),
    history: protect(async (sender, request) => {
      if (!shape(request, ['workspaceId', 'handle', 'cursor', 'limit']) || !page(request)) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const bound = scope(sender, request); if (!bound) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      const saved = storage.listSnapshots(bound.workspaceId, { cursor: request.cursor, limit: request.limit }); if (!saved.ok) return saved;
      const allowed = await Promise.all(saved.items.map(snapshot => readable(sender, snapshot, bound).catch(() => false)));
      const current = scope(sender, request); if (!current || !equal(current.recipient, bound.recipient) || current.record !== bound.record) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      return { ok: true, items: clone(saved.items.filter((_, i) => allowed[i])), nextCursor: saved.nextCursor, unavailableCount: allowed.filter(value => !value).length };
    }),
    readSnapshot: protect(async (sender, request) => {
      if (!shape(request, ['workspaceId', 'handle', 'id']) || !resourceEditToken(request.id)) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const bound = scope(sender, request); if (!bound) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      const info = storage.snapshotInfo(bound.workspaceId, request.id); if (!info.ok) return info;
      if (!await readable(sender, info.snapshot, bound)) return fail('RESOURCE_EDIT_SCOPE_DENIED');
      const current = scope(sender, request); if (!current || !equal(current.recipient, bound.recipient) || current.record !== bound.record) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      return storage.readSnapshot(bound.workspaceId, request.id);
    }),
    cleanup: protect(async (sender, request) => {
      if (!shape(request, ['workspaceId', 'handle', 'requestIds']) || !Array.isArray(request.requestIds) || request.requestIds.length > 64 || request.requestIds.some(id => !resourceEditToken(id))) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const bound = scope(sender, request); if (!bound) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      const saved = storage.inspect(bound.workspaceId); if (!saved.ok) return saved;
      if (request.requestIds.some(id => ![...saved.manifest.operations, ...saved.manifest.retiredOperations].some(op => op.requestId === id && belongs(op.target, bound)))) return fail('RESOURCE_EDIT_SCOPE_DENIED');
      const result = storage.cleanup(bound.workspaceId, request.requestIds);
      if (result.ok) changed(bound.workspaceId, { kind: 'history' }); return result;
    }),
    archive: protect(async (sender, request) => {
      if (!shape(request, ['workspaceId', 'handle', 'requestId']) || !resourceEditToken(request.requestId)) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const bound = scope(sender, request); if (!bound) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      const saved = storage.inspect(bound.workspaceId); if (!saved.ok) return saved;
      if (![...saved.manifest.operations, ...saved.manifest.retiredOperations].some(op => op.requestId === request.requestId && belongs(op.target, bound))) return fail('RESOURCE_EDIT_SCOPE_DENIED');
      const result = storage.apply(bound.workspaceId, { type: 'archive', requestId: request.requestId });
      if (result.ok) changed(bound.workspaceId, { kind: 'history' }); return result.ok ? { ok: true } : result;
    }),
    clearDelivery: protect(async (sender, request) => {
      if (!shape(request, ['workspaceId', 'handle', 'id']) || !resourceEditToken(request.id)) return fail('RESOURCE_EDIT_INVALID_REQUEST');
      const bound = scope(sender, request); if (!bound) return fail('RESOURCE_EDIT_SOURCE_CHANGED');
      const info = storage.snapshotInfo(bound.workspaceId, request.id); if (!info.ok) return info;
      if (info.snapshot.purpose !== 'delivery' || !belongs(info.snapshot.target, bound)) return fail('RESOURCE_EDIT_SCOPE_DENIED');
      const result = storage.clearDelivery(bound.workspaceId, request.id);
      if (result.ok) changed(bound.workspaceId, { kind: 'history' }); return result.ok ? { ok: true, removedBytes: result.removedBytes } : result;
    }),
    dispose() { disposed = true; for (const [sender, state] of senders) { state.destroyed(); sender.removeListener?.('destroyed', state.destroyed); } for (const record of [...views.values()]) retire(record); senders.clear(); },
  };
}
