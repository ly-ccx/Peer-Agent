import { resourceEditRegistry } from './editing/resourceEditRegistry';
import { interactiveSessionRegistry } from './interactive/interactiveSessionRegistry';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { ResourceWindowContext } from '@peer-agent/protocol';
import { createNativeNavigation } from './nativeNavigationState';
const Context = createContext<ReturnType<typeof createNativeNavigation> | null>(null);
export const useNativeNavigation = () => useContext(Context);
export function NativeNavigationProvider({ context, children }: { readonly context: ResourceWindowContext; readonly children: ReactNode }) {
  const store = useMemo(() => createNativeNavigation(context, window.peerResource!), [context.viewId, context.windowId, context.generation]);
  useEffect(() => {
    store.start();
    void store.flush();
    const api = window.peerResource!;
    const unsubscribe = api.onCheckpointRequest(request => {
      if (request.identity.viewId !== context.viewId || request.identity.windowId !== context.windowId || request.identity.generation !== context.generation) return;
      const registry = resourceEditRegistry();
      const interactive = interactiveSessionRegistry();
      void Promise.all([store.flush(), registry?.flushAll() ?? Promise.resolve(true), interactive?.flushAll() ?? Promise.resolve(true)])
        .then(([navigation, drafts, conditions]) => api.acknowledgeCheckpoint({ ...request, status: navigation && drafts && conditions && !registry?.hasUnsafe() && !interactive?.hasUnsafe() ? 'confirmed' : 'blocked' }))
        .catch(() => { void api.acknowledgeCheckpoint({ ...request, status: 'blocked' }).catch(() => {}); });
    });
    const pagehide = () => { void store.flush(); void interactiveSessionRegistry()?.flushAll(); };
    window.addEventListener('pagehide', pagehide);
    return () => { unsubscribe(); window.removeEventListener('pagehide', pagehide); store.stop(); };
  }, [store, context.viewId, context.windowId, context.generation]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
