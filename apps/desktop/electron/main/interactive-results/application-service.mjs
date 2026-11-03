import { createInteractivePresentationStore, createInteractiveViewService } from '@peer-agent/runtime-node/interactive-results';
import { interactiveFeedbackFromFollowup, normalizeResourceFeedbackList, normalizeInteractiveOwner, normalizeResourceWindowRequest } from '@peer-agent/protocol';
import { desktopInteractiveRuntime } from './runtime-port.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => ({ ok: false, code });
const code = error => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : 'interactive_storage_unavailable';
const run = operation => { try { return operation(); } catch (error) { return fail(code(error)); } };
const validRequest = (raw, fields) => raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(key => fields.includes(key));

/** Actual app senders/owners bind the shared domain service. No tool or file-execution port. */
export function createDesktopInteractiveApplication({ getRole, getOwner, getNativeBinding, prepareFeedback, readDraft, getRuntime = desktopInteractiveRuntime }) {
  const instances = new Map(), lifetimes = new Map();
  let disposed = false;
  function ownerOf(workspaceId) {
    const profile = getOwner(workspaceId);
    return normalizeInteractiveOwner({ workspaceId, conversationId: profile?.conversationId });
  }
  function attach(sender) {
    if (lifetimes.has(sender)) return lifetimes.get(sender);
    const record = { epoch: 0 };
    const invalidate = () => { record.epoch++; for (const item of instances.values()) item.views.closeSender(sender); };
    const navigation = (_event, _url, inPlace, mainFrame) => { if (!inPlace && mainFrame === true) invalidate(); };
    const destroyed = () => { invalidate(); detach(); };
    const detach = () => {
      sender.removeListener?.('did-start-navigation', navigation); sender.removeListener?.('render-process-gone', invalidate);
      sender.removeListener?.('destroyed', destroyed); lifetimes.delete(sender);
    };
    Object.assign(record, { detach }); lifetimes.set(sender, record);
    sender.on?.('did-start-navigation', navigation); sender.on?.('render-process-gone', invalidate); sender.once?.('destroyed', destroyed);
    return record;
  }
  function instance() {
    const runtime = getRuntime();
    if (disposed || !runtime) throw { code: 'interactive_authority_unavailable' };
    if (instances.has(runtime)) return instances.get(runtime);
    for (const [previous, item] of instances) { item.views.dispose(); instances.delete(previous); }
    const currentOwner = owner => !disposed && getRuntime() === runtime && same(ownerOf(owner.workspaceId), owner);
    const views = createInteractiveViewService({ resultStore: runtime.resultStore, stateStore: runtime.stateStore,
      resolveSource(sender, reference, { signal }) {
        const role = getRole(sender);
        if (!['main', 'resource'].includes(role) || !currentOwner(reference.owner) || signal.aborted || sender.isDestroyed?.() === true) return null;
        const lifetime = attach(sender), epoch = lifetime.epoch;
        const native = role === 'resource' ? getNativeBinding(sender) : null;
        if (role === 'resource' && (!native?.ok || native.context.resource.kind !== 'interactive' || !same(native.context.resource.reference, reference))) return null;
        const isCurrent = () => !signal.aborted && lifetime.epoch === epoch && currentOwner(reference.owner) && getRole(sender) === role
          && sender.isDestroyed?.() !== true && (role !== 'resource' || (() => {
            const fresh = getNativeBinding(sender);
            return fresh?.ok && fresh.context.viewId === native.context.viewId && fresh.context.windowId === native.context.windowId
              && fresh.context.generation === native.context.generation && fresh.context.resource.kind === 'interactive' && same(fresh.context.resource.reference, reference);
          })());
        return { owner: reference.owner, assertCurrent: isCurrent };
      } });
    const presentation = createInteractivePresentationStore({ resultStore: runtime.resultStore, assertOwner: currentOwner });
    const value = { runtime, views, presentation }; instances.set(runtime, value); return value;
  }
  function view(method, sender, request) {
    return run(() => {
      if (disposed || !['main', 'resource'].includes(getRole(sender))) return fail('interactive_scope_denied');
      attach(sender); return instance().views[method](sender, request);
    });
  }
  return {
    open: (sender, request) => view('open', sender, request),
    cancelOpen: (sender, request) => view('cancelOpen', sender, request),
    readState: (sender, request) => view('readState', sender, request),
    acquire: (sender, request) => view('acquire', sender, request),
    save: (sender, request) => view('save', sender, request),
    release: (sender, request) => view('release', sender, request),
    prepareFollowup: (sender, request) => view('prepareFollowup', sender, request),
    async prepareDraft(sender, request) {
      try {
        if (disposed || !['main', 'resource'].includes(getRole(sender))) return fail('interactive_scope_denied');
        if (typeof prepareFeedback !== 'function' || typeof readDraft !== 'function') return fail('interactive_draft_unavailable');
        const selected = instance().views.resolveFollowup(sender, request);
        if (!selected.ok) return selected;
        const feedback = interactiveFeedbackFromFollowup(selected.followup);
        if (!feedback) return fail('interactive_followup_corrupt');
        const role = getRole(sender), native = role === 'resource' ? getNativeBinding(sender) : null;
        const sourceSender = role === 'main' ? sender : native?.sourceSender;
        if (!sourceSender || getRole(sourceSender) !== 'main' || sourceSender.isDestroyed?.() === true) return fail('interactive_draft_source_unavailable');
        const current = () => {
          if (selected.assertCurrent() !== true || getRole(sourceSender) !== 'main' || sourceSender.isDestroyed?.() === true) return false;
          if (role === 'main') return sourceSender === sender;
          const fresh = getNativeBinding(sender);
          return fresh?.ok && fresh.sourceSender === sourceSender && fresh.context.viewId === native.context.viewId
            && fresh.context.windowId === native.context.windowId && fresh.context.generation === native.context.generation;
        };
        const prepared = await prepareFeedback({ sourceSender, identity: selected.identity, feedback, isCurrent: current });
        if (!prepared?.ok) return fail(typeof prepared?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(prepared.code) ? prepared.code.toLowerCase() : 'interactive_draft_unconfirmed');
        if (prepared.id !== feedback.id || !current()) return fail('interactive_draft_unconfirmed');
        // A renderer ack is insufficient: read the actual host-owned draft store.
        const saved = await readDraft({ workspaceId: feedback.recipient.workspaceId, surface: 'desktop' });
        if (!current() || !saved?.ok || !saved.snapshot || !Array.isArray(saved.snapshot.pending)) return fail('interactive_draft_unconfirmed');
        const rows = [saved.snapshot.draft, ...saved.snapshot.pending].flatMap(item => {
          const values = normalizeResourceFeedbackList(item?.resourceFeedback);
          if (!values) throw { code: 'interactive_draft_unconfirmed' };
          return values;
        });
        if (!rows.some(row => row.id === feedback.id && same(row, feedback))) return fail('interactive_draft_unconfirmed');
        return { ok: true, followupId: feedback.id };
      } catch (error) { return fail(code(error)); }
    },
    prepareResource(raw) {
      try {
        const request = normalizeResourceWindowRequest({ resource: raw });
        if (!request || request.resource.kind !== 'interactive' || !same(ownerOf(request.resource.reference.owner.workspaceId), request.resource.reference.owner)) return { ok: false, status: 'scope_denied' };
        const fixed = instance().runtime.resultStore.getVersion(request.resource.reference);
        return { ok: true, owner: fixed.reference.owner, resource: request.resource, title: fixed.content.title };
      } catch (error) {
        const status = ({ interactive_content_cleaned: 'content_cleaned', interactive_storage_incompatible: 'incompatible_result',
          interactive_result_unavailable: 'result_unavailable', interactive_scope_denied: 'scope_denied' })[error?.code] ?? 'storage_unavailable';
        return { ok: false, status };
      }
    },
    listWindows: owner => { try { return instance().presentation.history.list(owner); } catch { return { ok: false, status: 'storage_unavailable', entries: [] }; } },
    findWindow: (id, owner) => { try { return instance().presentation.history.find(id, owner); } catch { return null; } },
    saveWindow: (context, scope, id) => { try { return instance().presentation.history.save(context, scope, id); } catch { return null; } },
    removeWindow: (id, owner) => { try { return instance().presentation.history.remove(id, owner); } catch { return false; } },
    readLayout: (sender, request) => run(() => {
      const owner = normalizeInteractiveOwner(request?.owner);
      if (getRole(sender) !== 'main' || !validRequest(request, ['owner']) || !owner || !same(ownerOf(owner.workspaceId), owner)) return fail('interactive_scope_denied');
      return { ok: true, snapshot: instance().presentation.readLayout(owner) };
    }),
    writeLayout: (sender, request) => run(() => {
      const owner = normalizeInteractiveOwner(request?.owner);
      if (getRole(sender) !== 'main' || !validRequest(request, ['owner', 'expectedRevision', 'order', 'recent', 'interactive']) || !owner || !same(ownerOf(owner.workspaceId), owner)) return fail('interactive_scope_denied');
      return { ok: true, snapshot: instance().presentation.writeLayout(owner, request) };
    }),
    dispose() {
      if (disposed) return; disposed = true;
      for (const item of instances.values()) item.views.dispose(); instances.clear();
      for (const lifetime of [...lifetimes.values()]) lifetime.detach();
    },
  };
}
