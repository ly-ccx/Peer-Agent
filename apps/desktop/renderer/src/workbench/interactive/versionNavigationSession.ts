import { normalizeInteractiveReference, type InteractiveResultReference, type InteractiveResultsApi,
  type InteractiveVersionNavigation, type InteractiveViewHandle } from '@peer-agent/protocol';

interface NavigationState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'opening' | 'error';
  readonly versions: InteractiveVersionNavigation | null;
  readonly error: string | null;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Human navigation keeps the current view independent of its related fixed versions. */
export function createVersionNavigationSession({ reference, handle, api, openReference }: {
  readonly reference: InteractiveResultReference; readonly handle: InteractiveViewHandle; readonly api: InteractiveResultsApi;
  readonly openReference?: (reference: InteractiveResultReference) => boolean | Promise<boolean>;
}) {
  let state: NavigationState = { phase: 'idle', versions: null, error: null }, disposed = false, epoch = 0;
  let pending: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  const update = (next: NavigationState) => { if (!disposed) { state = next; for (const listener of listeners) listener(); } };
  const valid = (raw: unknown) => {
    const candidate = normalizeInteractiveReference(raw);
    return candidate && same(candidate.owner, reference.owner) && candidate.resultId === reference.resultId ? candidate : null;
  };
  function check(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (pending) return pending;
    update({ phase: 'loading', versions: null, error: null });
    const generation = epoch, current = () => !disposed && generation === epoch;
    const task = Promise.resolve().then(async () => {
      if (!current()) return false;
      if (!api.readVersions) throw { code: 'interactive_navigation_unavailable' };
      const reply = await api.readVersions({ handle });
      if (!reply.ok) throw { code: reply.code };
      const fixedReference = valid(reply.versions?.reference), head = valid(reply.versions?.head);
      const predecessor = reply.versions?.predecessor === undefined ? undefined : valid(reply.versions.predecessor);
      if (!fixedReference || !same(fixedReference, reference) || !head || predecessor === null || predecessor && same(predecessor, fixedReference)) throw { code: 'interactive_version_receipt_invalid' };
      if (!current()) return false;
      update({ phase: 'ready', versions: { reference: fixedReference, head, ...(predecessor ? { predecessor } : {}) }, error: null }); return true;
    }).catch(error => { if (current()) update({ phase: 'error', versions: null, error: error?.code ?? 'interactive_navigation_unavailable' }); return false; })
      .finally(() => { if (pending === task) pending = null; });
    pending = task; return task;
  }
  function open(relation: 'head' | 'predecessor'): Promise<boolean> {
    const target = state.versions?.[relation];
    if (disposed || pending || state.phase !== 'ready' || !target || same(target, reference)) return Promise.resolve(false);
    update({ ...state, phase: 'opening', error: null });
    const generation = epoch, current = () => !disposed && generation === epoch;
    const task = Promise.resolve().then(async () => {
      if (!current()) return false;
      if (openReference) { if (!await openReference(target)) throw { code: 'interactive_version_open_failed' }; }
      else {
        if (!api.openVersion) throw { code: 'interactive_navigation_unavailable' };
        const reply = await api.openVersion({ handle, relation, expectedReference: target });
        if (!reply.ok) throw { code: reply.code };
        if (!same(valid(reply.reference), target)) throw { code: 'interactive_version_receipt_invalid' };
      }
      if (!current()) return false;
      update({ ...state, phase: 'ready', error: null }); return true;
    }).catch(error => { if (current()) update({ phase: 'error', versions: null, error: error?.code ?? 'interactive_version_open_failed' }); return false; })
      .finally(() => { if (pending === task) pending = null; });
    pending = task; return task;
  }
  return { snapshot: () => state, subscribe: (listener: () => void) => { disposed = false; listeners.add(listener); return () => { listeners.delete(listener); }; },
    check, open, dispose: () => { disposed = true; epoch++; pending = null; listeners.clear(); state = { phase: 'idle', versions: null, error: null }; } };
}
