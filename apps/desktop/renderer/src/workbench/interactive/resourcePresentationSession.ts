import { interactiveReferenceKey, normalizeInteractiveOwner, normalizeInteractiveReference, normalizeResourceLayout,
  normalizeResourceLayoutSnapshot, normalizeResourceRecentReference, normalizeResourceWindowNavigation,
  type InteractiveOwner, type InteractiveResultReference, type ResourceInteractiveTab, type ResourceLayoutSnapshot,
  type ResourcePresentationApi, type ResourceWindowNavigation } from '@peer-agent/protocol';

export type ResourceLayoutDraft = Pick<ResourceLayoutSnapshot, 'order' | 'recent' | 'interactive'>;
type Operation = { kind: 'open'; tab: ResourceInteractiveTab } | { kind: 'close' | 'activate'; reference: InteractiveResultReference }
  | { kind: 'title'; reference: InteractiveResultReference; title: string }
  | { kind: 'reading'; reference: InteractiveResultReference; point: Pick<ResourceWindowNavigation, 'top' | 'left'> }
  | { kind: 'presentation'; order: readonly string[]; recent: readonly string[]; tabs: readonly ResourceInteractiveTab[] };
type Candidate = { layout: ResourceLayoutDraft; expectedRevision: number };
export interface ResourcePresentationSnapshot {
  readonly layout: ResourceLayoutDraft;
  readonly confirmed: ResourceLayoutSnapshot | null;
  readonly remote: ResourceLayoutSnapshot | null;
  readonly loaded: boolean;
  readonly protected: boolean;
  readonly dirty: boolean;
  readonly phase: 'loading' | 'ready' | 'saving' | 'save_failed' | 'conflict' | 'closed';
  readonly error: string | null;
}
const clone = <T,>(value: T): T => structuredClone(value);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fields = (snapshot: ResourceLayoutDraft): ResourceLayoutDraft => ({ order: snapshot.order, recent: snapshot.recent, interactive: snapshot.interactive });
const empty = (): ResourceLayoutDraft => ({ order: [], recent: [], interactive: { tabs: [], activeTabId: null } });
const problem = (code: string) => Object.assign(Error(code), { code });
const failure = (error: unknown) => typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'resource_layout_unavailable';
const tabKey = (id: string) => `interactive:${id}`;

/** Ordered presentation intents and real CAS receipts. No SDK, DOM, model, Tool or permission port. */
export function createResourcePresentationSession({ owner: rawOwner, api, legacy, legacyValid = true, createId = () => crypto.randomUUID(), timeoutMs = 5000 }: {
  readonly owner: InteractiveOwner; readonly api: ResourcePresentationApi; readonly legacy: { readonly order: readonly string[]; readonly recent: readonly string[] };
  readonly legacyValid?: boolean;
  readonly createId?: () => string; readonly timeoutMs?: number;
}) {
  const normalizedOwner = normalizeInteractiveOwner(rawOwner); if (!normalizedOwner || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw problem('resource_layout_invalid');
  const owner: InteractiveOwner = normalizedOwner;
  const seeded = normalizeResourceLayout({ ...legacy, interactive: { tabs: [], activeTabId: null } });
  let validSeed = legacyValid && !!seeded, pending: Candidate | null = null, loadPromise: Promise<boolean> | null = null, tail: Promise<unknown> = Promise.resolve();
  const intents: Operation[] = [], listeners = new Set<() => void>(), lifetime = new AbortController();
  let state: ResourcePresentationSnapshot = { layout: seeded ?? empty(), confirmed: null, remote: null, loaded: false,
    protected: false, dirty: false, phase: 'loading', error: null };
  const changed = (patch: Partial<ResourcePresentationSnapshot>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const own = (reference: InteractiveResultReference) => reference.owner.workspaceId === owner.workspaceId && reference.owner.conversationId === owner.conversationId;
  function checked(raw: unknown) {
    const snapshot = normalizeResourceLayoutSnapshot(raw);
    if (!snapshot) throw problem('resource_layout_incompatible');
    if (snapshot.interactive.tabs.some(tab => !own(tab.reference)) || snapshot.recent.some(raw => {
      try { const item = normalizeResourceRecentReference(JSON.parse(raw)); return item?.kind === 'interactive' && !own(item.reference); } catch { return false; }
    })) throw problem('interactive_scope_denied');
    return snapshot;
  }
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (lifetime.signal.aborted) throw problem('resource_layout_closed');
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(problem('resource_layout_closed'));
      lifetime.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(problem('resource_layout_timeout')), timeoutMs);
    });
    try { return await Promise.race([Promise.resolve().then(() => {
      if (lifetime.signal.aborted) throw problem('resource_layout_closed'); return operation();
    }), interrupted]); }
    finally { if (timer !== undefined) clearTimeout(timer); if (abort) lifetime.signal.removeEventListener('abort', abort); }
  }
  async function readRemote() {
    const reply = await bounded(() => api.readLayout({ owner: clone(owner) }));
    if (lifetime.signal.aborted) throw problem('resource_layout_closed');
    if (!reply.ok) throw problem(reply.code);
    return reply.snapshot === null ? null : checked(reply.snapshot);
  }
  function apply(layout: ResourceLayoutDraft, operation: Operation, rebasing = false): ResourceLayoutDraft {
    let { order, recent } = layout;
    let tabs = [...layout.interactive.tabs], activeTabId = layout.interactive.activeTabId;
    if (operation.kind === 'presentation') {
      const requested = rebasing ? operation.order.flatMap(key => {
        if (!key.startsWith('interactive:')) return [key];
        const reference = operation.tabs.find(tab => tabKey(tab.id) === key)?.reference;
        const matched = reference && tabs.find(tab => interactiveReferenceKey(tab.reference) === interactiveReferenceKey(reference));
        return matched ? [tabKey(matched.id)] : [];
      }) : operation.order;
      order = rebasing ? [...new Set([...order, ...requested])] : requested;
      recent = rebasing ? [...new Set([...operation.recent, ...recent])].slice(0, 16) : operation.recent;
    } else {
      const reference = operation.kind === 'open' ? operation.tab.reference : operation.reference;
      const key = interactiveReferenceKey(reference), index = tabs.findIndex(tab => interactiveReferenceKey(tab.reference) === key);
      if (operation.kind === 'open') {
        if (index < 0) {
          if (tabs.length >= 32) { const parked = tabs.findIndex(tab => !order.includes(tabKey(tab.id))); if (parked < 0) throw problem('resource_layout_limit'); tabs.splice(parked, 1); }
          tabs.push(clone(operation.tab));
        }
        else if (!tabs[index].title && operation.tab.title) tabs[index] = { ...tabs[index], title: operation.tab.title };
        const tab = tabs[index < 0 ? tabs.length - 1 : index]; activeTabId = tab.id;
        if (!order.includes(tabKey(tab.id))) order = [...order, tabKey(tab.id)];
        const descriptor = JSON.stringify({ kind: 'interactive', reference, ...(tab.title ? { title: tab.title } : {}) });
        recent = [descriptor, ...recent.filter(item => {
          try { const value = normalizeResourceRecentReference(JSON.parse(item)); return value?.kind !== 'interactive' || interactiveReferenceKey(value.reference) !== key; } catch { return true; }
        })].slice(0, 16);
      } else if (index >= 0) {
        const tab = tabs[index];
        if (operation.kind === 'activate') { if (!order.includes(tabKey(tab.id))) throw problem('resource_tab_closed'); activeTabId = tab.id; }
        if (operation.kind === 'reading') tabs[index] = { ...tab, navigation: clone(operation.point) };
        if (operation.kind === 'title') tabs[index] = { ...tab, title: operation.title };
        if (operation.kind === 'close') {
          order = order.filter(key => key !== tabKey(tab.id));
          const remaining = tabs.filter(item => order.includes(tabKey(item.id)));
          if (activeTabId === tab.id) activeTabId = remaining.at(-1)?.id ?? null;
        }
      }
    }
    const next = normalizeResourceLayout({ order, recent, interactive: { tabs, activeTabId } });
    if (!next) throw problem('resource_layout_limit');
    return next;
  }
  function change(operation: Operation) {
    if (lifetime.signal.aborted) return false;
    try {
      const next = apply(state.layout, operation);
      if (equal(next, state.layout)) return true;
      if (!state.loaded && intents.length >= 256) throw problem('resource_layout_intent_limit');
      if (!state.loaded) intents.push(clone(operation));
      changed({ layout: next, protected: state.protected || next.interactive.tabs.length > 0,
        dirty: state.confirmed ? !equal(next, fields(state.confirmed)) : state.protected || next.interactive.tabs.length > 0,
        ...(state.phase === 'ready' ? { error: null } : {}) }); return true;
    } catch (error) { changed({ error: failure(error) }); return false; }
  }
  function load() {
    if (lifetime.signal.aborted) return Promise.resolve(false);
    if (state.loaded) return Promise.resolve(true);
    if (loadPromise) return loadPromise;
    changed({ phase: 'loading', error: null });
    loadPromise = (async () => {
      try {
        const remote = await readRemote();
        if (lifetime.signal.aborted) return false;
        let layout = remote ? fields(remote) : seeded ?? empty();
        for (const operation of intents) layout = apply(layout, operation, true);
        intents.length = 0;
        const protectedLayout = !!remote || state.protected || layout.interactive.tabs.length > 0;
        changed({ layout, confirmed: remote, remote: null, loaded: true, protected: protectedLayout,
          dirty: protectedLayout && (!remote || !equal(layout, fields(remote))),
          phase: !remote && !validSeed ? 'save_failed' : 'ready', error: !remote && !validSeed ? 'resource_legacy_layout_incompatible' : null }); return true;
      } catch (error) { if (!lifetime.signal.aborted) changed({ phase: 'save_failed', error: failure(error) }); return false; }
      finally { loadPromise = null; }
    })(); return loadPromise;
  }
  function enqueue<T>(operation: () => Promise<T>) { const work = tail.then(operation, operation); tail = work.catch(() => {}); return work; }
  function accept(snapshot: ResourceLayoutSnapshot) {
    if (lifetime.signal.aborted) throw problem('resource_layout_closed');
    pending = null;
    changed({ confirmed: snapshot, remote: null, dirty: !equal(state.layout, fields(snapshot)), phase: 'ready', error: null, protected: true });
  }
  async function reconcile(selected: Candidate) {
    const remote = await readRemote();
    if (remote && remote.revision >= selected.expectedRevision + 1 && equal(fields(remote), selected.layout)) { accept(remote); return true; }
    if ((remote?.revision ?? 0) === selected.expectedRevision && (state.confirmed === null ? remote === null : !!remote && equal(remote, state.confirmed))) return null;
    changed({ remote, phase: 'conflict', error: remote ? 'interactive_layout_conflict' : 'resource_layout_missing' }); return false;
  }
  async function afterConflict(attempted: Candidate, selected: Candidate): Promise<boolean> {
    const found = await reconcile(attempted);
    if (found === true) return save(selected);
    if (found === null) changed({ phase: 'save_failed', error: 'interactive_layout_conflict' });
    return false;
  }
  async function save(selected: Candidate): Promise<boolean> {
    if (lifetime.signal.aborted || !state.loaded || state.phase === 'conflict' || !validSeed && !state.confirmed) return false;
    try {
      if (pending) { const found = await reconcile(pending); if (found === false) return false;
        if (found === null) {
          const previous = pending;
          changed({ phase: 'saving', error: null });
          const reply = await bounded(() => api.writeLayout({ owner: clone(owner), expectedRevision: previous.expectedRevision, ...clone(previous.layout) }));
          if (!reply.ok) { if (reply.code === 'interactive_layout_conflict') return await afterConflict(previous, selected); throw problem(reply.code); }
          const snapshot = checked(reply.snapshot);
          if (snapshot.revision !== previous.expectedRevision + 1 || !equal(fields(snapshot), previous.layout)) throw problem('resource_layout_receipt_invalid');
          accept(snapshot);
        }
      }
      if (state.confirmed && equal(selected.layout, fields(state.confirmed))) return true;
      pending = { ...selected, expectedRevision: state.confirmed?.revision ?? 0 };
      const sending = pending;
      changed({ phase: 'saving', error: null });
      const reply = await bounded(() => api.writeLayout({ owner: clone(owner), expectedRevision: sending.expectedRevision, ...clone(sending.layout) }));
      if (!reply.ok) { if (reply.code === 'interactive_layout_conflict') return await afterConflict(sending, selected); throw problem(reply.code); }
      const snapshot = checked(reply.snapshot);
      if (snapshot.revision !== sending.expectedRevision + 1 || !equal(fields(snapshot), sending.layout)) throw problem('resource_layout_receipt_invalid');
      accept(snapshot); return true;
    } catch (error) { if (!lifetime.signal.aborted) changed({ phase: 'save_failed', error: failure(error) }); return false; }
  }
  const selected = (): Candidate => ({ layout: clone(state.layout), expectedRevision: state.confirmed?.revision ?? 0 });
  const ownedReference = (raw: InteractiveResultReference) => { const reference = normalizeInteractiveReference(raw); return reference && own(reference) ? reference : undefined; };
  return {
    owner,
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load,
    open(raw: InteractiveResultReference, title?: string) {
      const reference = normalizeInteractiveReference(raw);
      if (!reference || !own(reference)) return false;
      return change({ kind: 'open', tab: { id: createId(), reference, ...(title ? { title } : {}) } });
    },
    activate(raw: InteractiveResultReference) { const reference = ownedReference(raw); return !!reference && change({ kind: 'activate', reference }); },
    close(raw: InteractiveResultReference) { const reference = ownedReference(raw); return !!reference && change({ kind: 'close', reference }); },
    title(raw: InteractiveResultReference, title: string) { const reference = ownedReference(raw); return !!reference && change({ kind: 'title', reference, title }); },
    remember(rawReference: InteractiveResultReference, raw: Pick<ResourceWindowNavigation, 'top' | 'left'>) {
      const reference = ownedReference(rawReference);
      const point = normalizeResourceWindowNavigation(raw, 'interactive');
      return !!point && !!reference && change({ kind: 'reading', reference, point });
    },
    presentation(order: readonly string[], recent: readonly string[]) { return change({ kind: 'presentation', order, recent, tabs: state.layout.interactive.tabs }); },
    async flush() {
      if (!await load() || !state.protected) return !state.protected && !lifetime.signal.aborted;
      const candidate = selected(); return enqueue(() => save(candidate));
    },
    keepLocal() {
      return enqueue(async () => {
        try {
          if (loadPromise) await loadPromise;
          const remote = await readRemote();
          if (!remote && state.confirmed) throw problem('resource_layout_missing');
          validSeed = true; pending = null; intents.length = 0;
          changed({ confirmed: remote, remote: null, loaded: true, phase: 'ready', error: null, protected: true, dirty: true });
          return save(selected());
        } catch (error) { if (!lifetime.signal.aborted) changed({ phase: 'save_failed', error: failure(error) }); return false; }
      });
    },
    /** Caller must confirm domain edits before replacing local tab presentation. */
    useRemote() {
      return enqueue(async () => {
        try {
          if (loadPromise) await loadPromise;
          const remote = await readRemote();
          if (!remote && state.confirmed) throw problem('resource_layout_missing');
          if (!remote && (!seeded || !validSeed)) throw problem('resource_legacy_layout_incompatible');
          pending = null; intents.length = 0; validSeed = true;
          changed({ layout: remote ? fields(remote) : seeded!, confirmed: remote, remote: null, loaded: true,
            protected: !!remote, dirty: false, phase: 'ready', error: null }); return true;
        } catch (error) { if (!lifetime.signal.aborted) changed({ phase: 'save_failed', error: failure(error) }); return false; }
      });
    },
    dispose() { if (lifetime.signal.aborted) return; lifetime.abort(); changed({ phase: 'closed' }); listeners.clear(); },
  };
}
export type ResourcePresentationSession = ReturnType<typeof createResourcePresentationSession>;
