export interface EditableSnapshot<T> {
  readonly saved: T;
  readonly draft: T;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly saving: boolean;
  readonly dirty: boolean;
  readonly stale: boolean;
  readonly readError: boolean;
  readonly saveError: boolean;
  readonly committed: boolean;
}

/** Presentation drafts only. The write receipt, never a click, establishes saved state. */
export function createEditableResource<T>(initial: T, ports: {
  read: () => Promise<T>;
  write: (draft: T, saved: T) => Promise<T>;
  equal?: (a: T, b: T) => boolean;
}) {
  const equal = ports.equal ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  let state: EditableSnapshot<T> = { saved: initial, draft: initial, loaded: false, loading: false, saving: false, dirty: false, stale: false, readError: false, saveError: false, committed: false };
  let revision = 0, request = 0;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<EditableSnapshot<T>>) => {
    state = { ...state, ...next };
    state = { ...state, dirty: !equal(state.saved, state.draft) };
    listeners.forEach(listener => listener());
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    edit(draft: T) { revision++; publish({ draft, committed: false, saveError: false }); },
    reset() { revision++; publish({ draft: state.saved, stale: false, saveError: false, committed: false }); },
    async load() {
      if (state.saving) return false;
      const ticket = ++request;
      publish({ loading: true, readError: false });
      try {
        const saved = await ports.read();
        if (ticket !== request) return false;
        const retain = state.dirty;
        publish({ saved, draft: retain ? state.draft : saved, loaded: true, saveError: equal(saved, state.draft) ? false : state.saveError, stale: retain && (state.stale || !equal(saved, state.saved)), loading: false });
        return true;
      } catch {
        if (ticket === request) publish({ loading: false, readError: true });
        return false;
      }
    },
    async save() {
      if (!state.loaded || state.saving) return false;
      if (!state.dirty) return true;
      ++request;
      const draft = state.draft, saved = state.saved, editRevision = revision;
      publish({ saving: true, loading: false, saveError: false, committed: false });
      try {
        const receipt = await ports.write(draft, saved);
        publish({ saved: receipt, draft: revision === editRevision ? receipt : state.draft, saving: false, stale: false, committed: true });
        return !state.dirty;
      } catch {
        publish({ saving: false, saveError: true });
        return false;
      }
    },
  };
}
