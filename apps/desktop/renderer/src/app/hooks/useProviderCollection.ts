import { useCallback, useEffect, useRef, useState } from 'react';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { createProviderRefreshOrder } from './providerRefreshOrder';

/** A catalogue read failure preserves the last real list; it never becomes an empty success. */
export function useProviderCollection(onLoaded: (providers: readonly LlmProviderConfigView[]) => void) {
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const latest = useRef(onLoaded), rows = useRef(providers), order = useRef(createProviderRefreshOrder());
  latest.current = onLoaded; rows.current = providers;
  const refresh = useCallback(async () => {
    const ticket = order.current.begin();
    if (order.current.isAlive()) { setLoading(true); setError(false); }
    try {
      const list = await clientApi.llmListProviderGroups();
      if (order.current.canApply(ticket)) { setProviders(list); latest.current(list); }
      return list;
    } catch { if (order.current.isLatest(ticket)) setError(true); return rows.current; }
    finally { if (order.current.isLatest(ticket)) setLoading(false); }
  }, []);
  useEffect(() => {
    const tracker = order.current;
    tracker.mount();
    void refresh();
    return () => { tracker.unmount(); };
  }, [refresh]);
  return { providers, setProviders, loading, error, refresh };
}
