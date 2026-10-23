export interface ResourceSnapshot<T> {
  readonly value: T | null;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: boolean;
}

/** Read receipts only. A failed refresh preserves the last snapshot and never means empty. */
export function createResourceReader<T>(read: () => Promise<T>) {
  let request = 0;
  let state: ResourceSnapshot<T> = { value: null, loaded: false, loading: true, error: false };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<ResourceSnapshot<T>>) => {
    state = { ...state, ...patch }; listeners.forEach(listener => listener());
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancel() { request++; publish({ loading: false }); },
    accept(value: T) { request++; publish({ value, loaded: true, loading: false, error: false }); },
    async reload() {
      const ticket = ++request;
      publish({ loading: true, error: false });
      try {
        const value = await read();
        if (ticket !== request) return false;
        publish({ value, loaded: true, loading: false, error: false });
        return true;
      } catch {
        if (ticket === request) publish({ loading: false, error: true });
        return false;
      }
    },
  };
}

export interface ResourceAction { readonly pending: boolean; readonly confirmed: boolean; readonly error: boolean; readonly cancelled?: boolean; }
export const IDLE_ACTION: ResourceAction = { pending: false, confirmed: false, error: false };

/** Per-object synchronous locks. Refresh is deliberately separate from a write receipt. No automatic replay. */
export function createResourceActions() {
  let state: Readonly<Record<string, ResourceAction>> = {};
  const listeners = new Set<() => void>();
  const publish = (key: string, value: ResourceAction) => {
    state = { ...state, [key]: value }; listeners.forEach(listener => listener());
  };
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async run(key: string, write: () => Promise<unknown>) {
      if (state[key]?.pending) return false;
      publish(key, { pending: true, confirmed: false, error: false });
      try {
        const receipt = await write();
        if (receipt === false) { publish(key, { ...IDLE_ACTION, cancelled: true }); return false; }
        publish(key, { pending: false, confirmed: true, error: false }); return true;
      } catch {
        publish(key, { pending: false, confirmed: false, error: true }); return false;
      }
    },
  };
}
