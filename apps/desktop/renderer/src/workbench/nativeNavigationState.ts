import { normalizeResourceWindowNavigation, type ResourceWindowContext, type ResourceWindowNavigation } from '@peer-agent/protocol';
import type { ResourceWindowApi } from '../preload/contracts/resourceWindowApi';

/** One ordered, bounded checkpoint stream per actual native view. No file/permission state. */
export function createNativeNavigation(context: ResourceWindowContext, api: ResourceWindowApi) {
  const identity = { viewId: context.viewId, windowId: context.windowId, generation: context.generation };
  let navigation = context.navigation ?? { top: 0, left: 0 }, revision = 0, accepted = -1, sequence = context.navigationVersion ?? 0;
  let capture: (() => ResourceWindowNavigation | undefined) | null = null, invalid = false;
  let timer: ReturnType<typeof setTimeout> | null = null, active = true, inFlight: Promise<boolean> | null = null;
  let state: { readonly error: string | null; readonly persisted: boolean } = { error: null, persisted: true };
  const listeners = new Set<() => void>();
  const publish = (error: string | null, persisted: boolean) => { state = { error, persisted }; listeners.forEach(listener => listener()); };
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  function update(raw: ResourceWindowNavigation) {
    const value = normalizeResourceWindowNavigation(raw, context.resource.kind);
    if (!value) { invalid = true; publish('invalid_request', false); return; }
    invalid = false;
    if (JSON.stringify(value) === JSON.stringify(navigation)) return;
    navigation = value; revision++; clear();
    if (active) timer = setTimeout(() => { timer = null; void flush(); }, 250);
  }
  function send() {
    if (inFlight) return inFlight;
    const sending = revision, snapshot = navigation;
    inFlight = (async () => {
      try {
        const result = await Promise.resolve().then(() => api.navigation({ identity, sequence: sequence + 1, navigation: snapshot }));
        if (!result.ok) { publish(result.status, false); return false; }
        sequence = result.context.navigationVersion ?? sequence + 1; accepted = sending;
        publish(invalid ? 'invalid_request' : result.persisted === false ? 'storage_unavailable' : null, !invalid && result.persisted !== false);
        return true;
      } catch { publish('source_unavailable', false); return false; }
      finally { inFlight = null; }
    })();
    return inFlight;
  }
  async function flush() {
    if (!active) return false;
    const latest = capture?.(); if (latest) update(latest); clear();
    const target = revision;
    if (accepted < target && !await send()) return false;
    // A newer capture may have arrived while an older packet was in flight.
    if (accepted < target && !await send()) return false;
    return state.persisted;
  }
  return {
    update, flush, current: () => navigation,
    registerCapture(next: () => ResourceWindowNavigation | undefined) { capture = next; return () => { if (capture === next) capture = null; }; },
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { active = true; }, stop() { active = false; clear(); },
    async retry() {
      try {
        const result = await api.bootstrap();
        if (!result.ok || result.context.viewId !== identity.viewId || result.context.windowId !== identity.windowId || result.context.generation !== identity.generation) return false;
        sequence = result.context.navigationVersion ?? 0; accepted = -1;
        return flush();
      } catch { publish('source_unavailable', false); return false; }
    },
  };
}
