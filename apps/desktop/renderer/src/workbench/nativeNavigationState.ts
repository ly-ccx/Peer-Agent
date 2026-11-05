import { normalizeResourceWindowNavigation, type ResourceWindowContext, type ResourceWindowNavigation } from '@peer-agent/protocol';
import type { ResourceWindowApi } from '../preload/contracts/resourceWindowApi';

/** One ordered, bounded checkpoint stream per actual native view. No file/permission state. */
export function createNativeNavigation(context: ResourceWindowContext, api: Pick<ResourceWindowApi, 'bootstrap' | 'navigation'>) {
  const identity = { viewId: context.viewId, windowId: context.windowId, generation: context.generation };
  const matches = (current: ResourceWindowContext) => current.viewId === identity.viewId && current.windowId === identity.windowId
    && current.generation === identity.generation;
  let navigation = context.navigation ?? { top: 0, left: 0 }, revision = 0, accepted = -1, sequence = context.navigationVersion ?? 0;
  let capture: (() => ResourceWindowNavigation | undefined) | null = null, invalid = false, abandoned = false;
  let timer: ReturnType<typeof setTimeout> | null = null, active = true, inFlight: Promise<boolean> | null = null;
  let state: { readonly error: string | null; readonly persisted: boolean; readonly abandoned: boolean } = { error: null, persisted: true, abandoned };
  const listeners = new Set<() => void>();
  const publish = (error: string | null, persisted: boolean) => { state = { error, persisted, abandoned }; listeners.forEach(listener => listener()); };
  const clear = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  function update(raw: ResourceWindowNavigation) {
    if (abandoned) return;
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
        if (abandoned) return true;
        if (!result.ok) { publish(result.status, false); return false; }
        if (!matches(result.context)) { publish('stale_view', false); return false; }
        sequence = result.context.navigationVersion ?? sequence + 1; accepted = sending;
        const ownerReplaced = context.resource.kind === 'interactive' && result.persisted === false && result.checkpointStatus === 'owner_replaced';
        publish(ownerReplaced ? 'owner_replaced' : invalid ? 'invalid_request' : result.persisted === false ? 'storage_unavailable' : null, !invalid && result.persisted !== false);
        return true;
      } catch { if (abandoned) return true; publish('source_unavailable', false); return false; }
      finally { inFlight = null; }
    })();
    return inFlight;
  }
  async function flush() {
    if (!active) return false;
    if (abandoned) return true;
    const latest = capture?.(); if (latest) update(latest); clear();
    const target = revision;
    if (accepted < target && !await send()) return false;
    // A newer capture may have arrived while an older packet was in flight.
    if (accepted < target && !await send()) return false;
    return abandoned || state.persisted;
  }
  async function retry() {
    if (abandoned) return true;
    if (!active) return false;
    clear();
    if (inFlight) await inFlight;
    try {
      const result = await api.bootstrap();
      if (!result.ok || !matches(result.context)) {
        publish('stale_view', false); return false;
      }
      clear();
      if (inFlight) { await inFlight; publish('storage_unavailable', false); return false; }
      sequence = result.context.navigationVersion ?? 0; accepted = -1;
      return await flush();
    } catch { publish('source_unavailable', false); return false; }
  }
  return {
    update, flush, current: () => navigation,
    async abandonAfterReplacement() {
      if (abandoned) return true;
      await retry();
      if (!active || state.error !== 'owner_replaced') return false;
      abandoned = true; clear(); publish(null, false); return true;
    },
    registerCapture(next: () => ResourceWindowNavigation | undefined) { capture = next; return () => { if (capture === next) capture = null; }; },
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { active = true; }, stop() { active = false; clear(); },
    retry,
  };
}
